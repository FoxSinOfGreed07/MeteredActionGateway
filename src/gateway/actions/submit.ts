import { sql } from 'kysely';
import { json } from '../../db/kysely.js';
import type { ActionRow, TenantRow } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { canonicalJson } from '../../shared/canonical-json.js';
import { GatewayError, isPgUniqueViolation } from '../../shared/errors.js';
import { sha256Hex } from '../../shared/hash.js';
import { newActionId } from '../../shared/ids.js';
import type { GatewayContext } from '../context.js';
import { placeHold } from '../wallet/ledger.js';
import { getPrice } from '../wallet/pricing.js';
import { getActionType, resolveLane } from './registry.js';
import { countPending, findActiveByConflictKey, findByIdempotencyKey } from './repo.js';
import { recordInsertEvent } from './state-machine.js';
import { toActionView } from './view.js';

export interface SubmitResult {
  status: number;
  body: unknown;
  replayed: boolean;
}

export interface SubmitInput {
  tenant: TenantRow;
  actionType: string;
  payload: unknown;
  idempotencyKey: string;
}

/*
 * The admission transaction (plans/04-actions-intake.md). Why it is correct under concurrency:
 *
 * - Same key, concurrent (S1, I7): the second `INSERT … ON CONFLICT ON CONSTRAINT actions_idempotency DO
 *   NOTHING` BLOCKS on the unique index until the first commits, then gets 0 rows and replays the first's
 *   stored response. One action, one hold, identical responses. No locks of our own.
 * - Same target, different keys (S3, I6): the partial unique index `actions_one_active_per_target` admits
 *   one; the other hits 23505 and is stored as REJECTED 409 (A9, A10).
 * - Same wallet (S4, I1): `placeHold` is a single conditional UPDATE (D7).
 * - Atomicity (D8): the record, the hold and the "enqueue" (the QUEUED row IS the queue entry) are one
 *   transaction — a crash leaves all of them or none.
 *
 * Responses are stored in `response_body` and the first caller receives the value RETURNED from the insert,
 * so every reply for a key (first or replay) serializes the same stored jsonb.
 */
export async function submitAction(ctx: GatewayContext, input: SubmitInput): Promise<SubmitResult> {
  const { tenant, actionType, idempotencyKey } = input;
  const def = getActionType(actionType);
  if (!def) throw new GatewayError('unknown_action_type', 400, `unknown action_type "${actionType}"`);

  const parsed = def.payloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw new GatewayError(
      'invalid_request',
      400,
      'payload failed validation',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const payload = parsed.data;
  const payloadHash = sha256Hex(canonicalJson({ action_type: actionType, payload }));
  const price = await getPrice(ctx.db, actionType);
  const laneId = resolveLane(tenant, def);
  const conflictKey = def.conflictKey(payload);

  // Fast replay path (an optimization only: the transaction below handles the race).
  const existing = await findByIdempotencyKey(ctx.db, tenant.id, idempotencyKey);
  if (existing) return replayOrMismatch(existing, payloadHash);

  // A7 backpressure: a soft cap, NOT stored (a refused action was never accepted, so nothing is lost).
  const pending = await countPending(ctx.db, tenant.id);
  if (pending >= tenant.max_pending) {
    throw new GatewayError(
      'tenant_backpressure',
      429,
      `tenant has ${pending} pending actions (max ${tenant.max_pending}); retry later`,
      { pending, max_pending: tenant.max_pending },
      ctx.config.backpressure.retryAfterS,
    );
  }

  const id = newActionId();
  const now = new Date();
  const base = {
    id,
    tenant_id: tenant.id,
    action_type: actionType,
    idempotency_key: idempotencyKey,
    lane_id: laneId,
    payload,
    captured_amount: null,
    result: null,
    failure_code: null,
    failure_message: null,
    created_at: now,
    updated_at: now,
  };
  const acceptedBody = toActionView({
    ...base,
    state: 'QUEUED',
    hold_amount: price.hold,
    completed_at: null,
  });

  return ctx.db.transaction().execute(async (tx) => {
    await sql`SAVEPOINT admit`.execute(tx);
    let inserted: Pick<ActionRow, 'id' | 'state' | 'response_status' | 'response_body'> | undefined;
    try {
      inserted = await tx
        .insertInto('actions')
        .values({
          id,
          tenant_id: tenant.id,
          lane_id: laneId,
          action_type: actionType,
          idempotency_key: idempotencyKey,
          payload: json(payload),
          payload_hash: payloadHash,
          conflict_key: conflictKey,
          state: 'QUEUED',
          hold_amount: price.hold,
          response_status: 202,
          response_body: json(acceptedBody),
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.constraint('actions_idempotency').doNothing())
        .returning(['id', 'state', 'response_status', 'response_body'])
        .executeTakeFirst();
    } catch (err) {
      if (!isPgUniqueViolation(err, 'actions_one_active_per_target') || conflictKey === null) throw err;
      await sql`ROLLBACK TO SAVEPOINT admit`.execute(tx);
      const active = await findActiveByConflictKey(tx, tenant.id, conflictKey);
      return reject(
        tx,
        409,
        'conflict_active_action',
        `another action is already in flight for ${conflictKey}`,
        {
          conflict_key: conflictKey,
          active_action: active
            ? { id: active.id, state: active.state, created_at: new Date(active.created_at).toISOString() }
            : null,
        },
      );
    }

    if (!inserted) {
      // A concurrent request with this key committed first (our INSERT waited for it): replay its response.
      const row = await findByIdempotencyKey(tx, tenant.id, idempotencyKey);
      if (!row) throw new Error(`idempotency conflict but no row for key ${idempotencyKey}`);
      return replayOrMismatch(row, payloadHash);
    }

    // Event first, hold LAST: the tenant's wallet row lock is then held only for one statement + COMMIT.
    await recordInsertEvent(tx, inserted, 'submitted');
    const hold = await placeHold(tx, { tenantId: tenant.id, actionId: id, amount: price.hold, actionType });
    if (!hold.ok) {
      await sql`ROLLBACK TO SAVEPOINT admit`.execute(tx);
      return reject(
        tx,
        402,
        'insufficient_credits',
        `action costs ${price.hold} credits; ${hold.available} available`,
        {
          required: price.hold,
          available: hold.available,
        },
      );
    }
    return { status: inserted.response_status, body: inserted.response_body, replayed: false };
  });

  /** A9: business rejections are stored as REJECTED actions so the same key always replays the same answer. */
  async function reject(
    tx: Tx,
    status: 402 | 409,
    code: string,
    message: string,
    details: unknown,
  ): Promise<SubmitResult> {
    const view = toActionView({ ...base, state: 'REJECTED', hold_amount: 0, completed_at: now });
    const body = { error: { code, message, details }, action: view };
    const row = await tx
      .insertInto('actions')
      .values({
        id,
        tenant_id: tenant.id,
        lane_id: laneId,
        action_type: actionType,
        idempotency_key: idempotencyKey,
        payload: json(payload),
        payload_hash: payloadHash,
        conflict_key: conflictKey,
        state: 'REJECTED',
        hold_amount: 0,
        response_status: status,
        response_body: json(body),
        created_at: now,
        updated_at: now,
        completed_at: now,
      })
      .onConflict((oc) => oc.constraint('actions_idempotency').doNothing())
      .returning(['id', 'state', 'response_status', 'response_body'])
      .executeTakeFirst();
    if (!row) {
      const winner = await findByIdempotencyKey(tx, tenant.id, idempotencyKey);
      if (!winner) throw new Error(`idempotency conflict but no row for key ${idempotencyKey}`);
      return replayOrMismatch(winner, payloadHash);
    }
    await recordInsertEvent(tx, row, `rejected:${code}`, details);
    return { status: row.response_status, body: row.response_body, replayed: false };
  }
}

/** Same key: replay the stored response byte-for-byte — or 422 if the body differs (key misuse; not stored). */
function replayOrMismatch(row: ActionRow, payloadHash: string): SubmitResult {
  if (row.payload_hash !== payloadHash) {
    throw new GatewayError(
      'idempotency_key_reused',
      422,
      'this Idempotency-Key was already used with a different request body',
      { action_id: row.id },
    );
  }
  return { status: row.response_status, body: row.response_body, replayed: true };
}
