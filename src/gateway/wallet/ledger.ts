import { sql } from 'kysely';
import type { ActionRow, LedgerKind } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { GatewayError } from '../../shared/errors.js';

/**
 * The ONLY module that writes `ledger_entries` or `wallets` (plans/00-architecture.md §7).
 * Every function takes a transaction and never opens its own: the caller decides atomicity (same tx as the
 * action insert / the state transition). The wallet row is a projection of the ledger (D7); both change in
 * the same transaction, so `wallets == SUM(ledger deltas)` always holds (I2).
 */

const DELTAS: Record<LedgerKind, (a: number) => { available_delta: number; held_delta: number }> = {
  GRANT: (a) => ({ available_delta: a, held_delta: 0 }),
  HOLD: (a) => ({ available_delta: -a, held_delta: a }),
  CAPTURE: (a) => ({ available_delta: 0, held_delta: -a }),
  RELEASE: (a) => ({ available_delta: a, held_delta: -a }),
  REFUND: (a) => ({ available_delta: a, held_delta: 0 }),
};

async function appendEntry(
  tx: Tx,
  e: { tenantId: string; actionId: string | null; kind: LedgerKind; amount: number; reason: string },
): Promise<void> {
  await tx
    .insertInto('ledger_entries')
    .values({
      tenant_id: e.tenantId,
      action_id: e.actionId,
      kind: e.kind,
      amount: e.amount,
      ...DELTAS[e.kind](e.amount),
      reason: e.reason.slice(0, 500),
    })
    .execute();
}

function assertPositiveInt(amount: number, what: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new GatewayError('ledger_invariant', 500, `${what} must be a positive integer, got ${amount}`);
}

export async function grant(tx: Tx, o: { tenantId: string; amount: number; reason: string }): Promise<void> {
  assertPositiveInt(o.amount, 'grant amount');
  await tx
    .insertInto('wallets')
    .values({ tenant_id: o.tenantId, available: o.amount, held: 0 })
    .onConflict((oc) =>
      oc
        .column('tenant_id')
        .doUpdateSet({ available: sql`wallets.available + excluded.available`, updated_at: sql`now()` }),
    )
    .execute();
  await appendEntry(tx, {
    tenantId: o.tenantId,
    actionId: null,
    kind: 'GRANT',
    amount: o.amount,
    reason: `grant:${o.reason}`,
  });
}

export type HoldResult = { ok: true; available: number; held: number } | { ok: false; available: number };

/**
 * D7 — atomic conditional update. The balance check and the write are ONE statement, so no code path can
 * read the balance and forget to lock: two 300-credit holds on a 500 wallet can never both succeed (S4).
 * `CHECK (available >= 0)` on the table is the database-level backstop (I1).
 */
export async function placeHold(
  tx: Tx,
  o: { tenantId: string; actionId: string; amount: number; actionType: string },
): Promise<HoldResult> {
  assertPositiveInt(o.amount, 'hold amount');
  // One round trip: the conditional UPDATE and the HOLD row in a single statement. The wallet row lock is
  // held from here to COMMIT, so keeping this to one statement keeps per-tenant admission throughput up.
  const r = await sql<{ available: number; held: number }>`
    WITH w AS (
      UPDATE wallets
         SET available = available - ${o.amount}, held = held + ${o.amount}, updated_at = now()
       WHERE tenant_id = ${o.tenantId} AND available >= ${o.amount}
      RETURNING available, held
    ), l AS (
      INSERT INTO ledger_entries (tenant_id, action_id, kind, amount, available_delta, held_delta, reason)
      SELECT ${o.tenantId}, ${o.actionId}::uuid, 'HOLD', ${o.amount}, ${-o.amount}, ${o.amount}, ${`hold:${o.actionType}`} FROM w
    )
    SELECT available, held FROM w`.execute(tx);
  const row = r.rows[0];
  if (!row) {
    const w = await tx
      .selectFrom('wallets')
      .select('available')
      .where('tenant_id', '=', o.tenantId)
      .executeTakeFirst();
    return { ok: false, available: w?.available ?? 0 };
  }
  return { ok: true, available: Number(row.available), held: Number(row.held) };
}

export async function capture(
  tx: Tx,
  o: { tenantId: string; actionId: string; amount: number; actionType: string },
): Promise<void> {
  assertPositiveInt(o.amount, 'capture amount');
  const row = await tx
    .updateTable('wallets')
    .set((eb) => ({ held: eb('held', '-', o.amount), updated_at: sql`now()` }))
    .where('tenant_id', '=', o.tenantId)
    .where('held', '>=', o.amount)
    .returning('held')
    .executeTakeFirst();
  if (!row)
    throw new GatewayError(
      'ledger_invariant',
      500,
      `capture ${o.amount} exceeds held credits (action ${o.actionId})`,
    );
  await appendEntry(tx, {
    tenantId: o.tenantId,
    actionId: o.actionId,
    kind: 'CAPTURE',
    amount: o.amount,
    reason: `capture:${o.actionType}`,
  });
}

export async function release(
  tx: Tx,
  o: { tenantId: string; actionId: string; amount: number; reasonCode: string; message: string },
): Promise<void> {
  assertPositiveInt(o.amount, 'release amount');
  const row = await tx
    .updateTable('wallets')
    .set((eb) => ({
      held: eb('held', '-', o.amount),
      available: eb('available', '+', o.amount),
      updated_at: sql`now()`,
    }))
    .where('tenant_id', '=', o.tenantId)
    .where('held', '>=', o.amount)
    .returning('held')
    .executeTakeFirst();
  if (!row)
    throw new GatewayError(
      'ledger_invariant',
      500,
      `release ${o.amount} exceeds held credits (action ${o.actionId})`,
    );
  await appendEntry(tx, {
    tenantId: o.tenantId,
    actionId: o.actionId,
    kind: 'RELEASE',
    amount: o.amount,
    reason: `release:${o.reasonCode}: ${o.message}`,
  });
}

type SettleAction = Pick<ActionRow, 'id' | 'tenant_id' | 'hold_amount' | 'action_type'>;

/** Confirmed success: CAPTURE c (≤ hold) and RELEASE the rest (D3; e.g. classification cache hit 2 of 20). */
export async function settleSuccess(tx: Tx, action: SettleAction, captureAmount: number): Promise<void> {
  if (captureAmount > action.hold_amount) {
    throw new GatewayError(
      'ledger_invariant',
      500,
      `capture ${captureAmount} > hold ${action.hold_amount} (action ${action.id})`,
    );
  }
  await capture(tx, {
    tenantId: action.tenant_id,
    actionId: action.id,
    amount: captureAmount,
    actionType: action.action_type,
  });
  const rest = action.hold_amount - captureAmount;
  if (rest > 0) {
    await release(tx, {
      tenantId: action.tenant_id,
      actionId: action.id,
      amount: rest,
      reasonCode: 'unused_hold',
      message: `captured ${captureAmount} of ${action.hold_amount}`,
    });
  }
}

/** Confirmed non-execution: RELEASE the whole hold with a reason (S8: hold, release, reason; no net charge). */
export async function settleFailure(
  tx: Tx,
  action: SettleAction,
  reasonCode: string,
  message: string,
): Promise<void> {
  await release(tx, {
    tenantId: action.tenant_id,
    actionId: action.id,
    amount: action.hold_amount,
    reasonCode,
    message,
  });
}
