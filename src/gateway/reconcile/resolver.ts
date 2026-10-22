import { sql } from 'kysely';
import type { ActionRow, LaneRow } from '../../db/schema.js';
import { expBackoff, fullJitter } from '../../shared/backoff.js';
import { transition } from '../actions/state-machine.js';
import type { PayInvoicePayload } from '../actions/types/pay-invoice.js';
import type { GatewayContext } from '../context.js';
import * as cooldown from '../dispatch/cooldown.js';
import { getLane } from '../dispatch/lanes.js';
import * as rateLimiter from '../dispatch/rate-limiter.js';
import { markFailed, markSucceeded } from '../dispatch/settle.js';
import { connectorForLane, ErpReadError } from '../erp/index.js';
import { canTrustNotFound } from './trust.js';

export type Resolution =
  | { action_id: string; from: 'UNKNOWN'; to: 'SUCCEEDED' | 'QUEUED' | 'FAILED'; why: string }
  | { action_id: string; still: 'UNKNOWN'; why: string };

/**
 * Claim due UNKNOWN actions with a lease WITHOUT changing their state. The lease makes this resolver the
 * sole owner of the check-then-act (D1: we only ever check under ownership — no second writer can race us
 * between the lookup and the re-dispatch). `force` ignores next_reconcile_at but NEVER the trust rule.
 */
export async function claimUnknown(
  ctx: GatewayContext,
  owner: string,
  opts: { batch: number; force?: boolean },
): Promise<ActionRow[]> {
  const leaseSecs = ctx.config.reconciler.leaseMs / 1000;
  const r = await sql<ActionRow>`
    WITH due AS (
      SELECT id FROM actions
       WHERE state = 'UNKNOWN'
         AND (${opts.force === true} OR next_reconcile_at <= now())
         AND (lease_until IS NULL OR lease_until < now())
       ORDER BY next_reconcile_at
       FOR UPDATE SKIP LOCKED
       LIMIT ${opts.batch})
    UPDATE actions a
       SET lease_owner = ${owner},
           lease_until = now() + make_interval(secs => ${leaseSecs}::double precision),
           reconcile_attempts = a.reconcile_attempts + 1, updated_at = now()
      FROM due WHERE a.id = due.id
    RETURNING a.*`.execute(ctx.db);
  return r.rows;
}

/** Non-transition bookkeeping on an UNKNOWN row we hold the lease on: reschedule + release the lease. */
async function reschedule(
  ctx: GatewayContext,
  action: ActionRow,
  owner: string,
  o: { at?: Date; delayMs?: number; notFoundCount?: number },
): Promise<void> {
  const at = o.at ?? new Date(Date.now() + (o.delayMs ?? ctx.config.reconciler.confirmGapMs));
  await ctx.db
    .updateTable('actions')
    .set({
      next_reconcile_at: at,
      lease_owner: null,
      lease_until: null,
      updated_at: sql`now()`,
      ...(o.notFoundCount === undefined ? {} : { not_found_count: o.notFoundCount }),
    })
    .where('id', '=', action.id)
    .where('state', '=', 'UNKNOWN')
    .where('lease_owner', '=', owner)
    .execute();
}

/**
 * D2 — resolve one UNKNOWN action. The resolver NEVER calls postPayment: re-sending only happens by moving
 * the action back to QUEUED, so the normal claim path (CAS, lease, rate limit, same reference) applies.
 */
export async function resolveUnknown(
  ctx: GatewayContext,
  action: ActionRow,
  owner: string,
): Promise<Resolution> {
  const lane: LaneRow = await getLane(ctx.db, action.lane_id);
  const log = ctx.log.child({ action_id: action.id, lane_id: lane.id });
  const backoff = () =>
    fullJitter(
      expBackoff(
        action.reconcile_attempts,
        ctx.config.reconciler.backoffBaseMs,
        ctx.config.reconciler.backoffMaxMs,
      ),
    );

  if (lane.kind !== 'erp') {
    // LLM actions never enter UNKNOWN (no external side effect). If one does, it's a bug: requeue it.
    log.error('reconcile.unexpected_unknown_on_llm_lane');
    await ctx.db.transaction().execute((tx) =>
      transition(tx, {
        actionId: action.id,
        from: ['UNKNOWN'],
        to: 'QUEUED',
        reason: 'reconciled:llm_requeue',
        leaseOwner: owner,
        patch: { next_attempt_at: sql`now()`, lease_owner: null, lease_until: null },
      }),
    );
    return { action_id: action.id, from: 'UNKNOWN', to: 'QUEUED', why: 'llm_requeue' };
  }

  const tenant = await ctx.db
    .selectFrom('tenants')
    .select('erp_company_code')
    .where('id', '=', action.tenant_id)
    .executeTakeFirstOrThrow();
  const payload = action.payload as PayInvoicePayload;

  // 1. A token from the lane's shared budget (lookups compete with payments for the ERP's rate limit).
  if ((await cooldown.cooldownState(ctx, lane.id)).active || !(await rateLimiter.acquire(ctx, lane, 2000))) {
    await reschedule(ctx, action, owner, { delayMs: backoff() });
    return { action_id: action.id, still: 'UNKNOWN', why: 'rate_limited' };
  }

  // 2. Look up by reference (our action id).
  let payments: Awaited<ReturnType<ReturnType<typeof connectorForLane>['findPaymentsByReference']>>;
  try {
    payments = await connectorForLane(lane).findPaymentsByReference(tenant.erp_company_code, action.id);
  } catch (err) {
    if (err instanceof ErpReadError && err.kind === 'rate_limited')
      await cooldown.trip(ctx, lane.id, err.retryAfterMs).catch(() => {});
    await reschedule(ctx, action, owner, { delayMs: backoff() });
    log.warn({ err: String(err) }, 'reconcile.lookup_error');
    return { action_id: action.id, still: 'UNKNOWN', why: 'lookup_error' };
  }

  // 3. Found: strong evidence. Capture.
  if (payments.length >= 1) {
    if (payments.length > 1) {
      // Must never happen. If it does, surface it loudly rather than hide it.
      log.error({ references: payments.map((p) => p.payment_id) }, 'erp.duplicate_payment_detected');
    }
    const row = await markSucceeded(ctx, action, {
      result: { payment: payments[0], ...(payments.length > 1 ? { duplicate_payments: payments } : {}) },
      via: 'reconcile',
      reason: 'reconciled:found',
      from: ['UNKNOWN'],
      leaseOwner: owner,
    });
    if (!row) return { action_id: action.id, still: 'UNKNOWN', why: 'cas_lost' };
    await ctx.cacheHooks
      .onInvoiceChanged(lane.id, tenant.erp_company_code, payload.invoice_id, null)
      .catch(() => {});
    return { action_id: action.id, from: 'UNKNOWN', to: 'SUCCEEDED', why: 'found' };
  }

  // 4. Not found: weak evidence. Only believe it when the read view is provably fresh enough.
  const trust = await canTrustNotFound(ctx, action, lane);
  if (!trust.trusted) {
    await reschedule(ctx, action, owner, {
      ...(trust.retryAt ? { at: trust.retryAt } : { delayMs: ctx.config.reconciler.confirmGapMs }),
      notFoundCount: 0,
    });
    log.info({ why: trust.why }, 'reconcile.not_found_untrusted');
    return { action_id: action.id, still: 'UNKNOWN', why: trust.why };
  }
  const notFound = action.not_found_count + 1;
  if (notFound < 2) {
    await reschedule(ctx, action, owner, {
      delayMs: ctx.config.reconciler.confirmGapMs,
      notFoundCount: notFound,
    });
    return { action_id: action.id, still: 'UNKNOWN', why: 'confirming_not_found' };
  }

  // Trusted, confirmed: it never committed.
  if (action.ambiguous_count >= ctx.config.reconciler.maxAmbiguous) {
    const row = await markFailed(ctx, action, {
      code: 'erp_outcome_not_found',
      message: `not found after ${action.ambiguous_count} ambiguous attempts`,
      reason: 'reconciled:not_found_give_up',
      from: ['UNKNOWN'],
      leaseOwner: owner,
    });
    return row
      ? { action_id: action.id, from: 'UNKNOWN', to: 'FAILED', why: 'not_found_give_up' }
      : { action_id: action.id, still: 'UNKNOWN', why: 'cas_lost' };
  }
  const row = await ctx.db.transaction().execute((tx) =>
    transition(tx, {
      actionId: action.id,
      from: ['UNKNOWN'],
      to: 'QUEUED',
      reason: 'reconciled:not_found_redispatch',
      leaseOwner: owner,
      patch: { next_attempt_at: sql`now()`, not_found_count: 0, lease_owner: null, lease_until: null },
    }),
  );
  return row
    ? { action_id: action.id, from: 'UNKNOWN', to: 'QUEUED', why: 'not_found_redispatch' }
    : { action_id: action.id, still: 'UNKNOWN', why: 'cas_lost' };
}

/** One pass: claim due UNKNOWNs and resolve them (sequentially: lookups share the lane's rate budget). */
export async function reconcilePass(
  ctx: GatewayContext,
  owner: string,
  opts: { force?: boolean; maxBatches?: number } = {},
): Promise<Resolution[]> {
  const out: Resolution[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < (opts.maxBatches ?? 1); i++) {
    const batch = (
      await claimUnknown(ctx, owner, { batch: ctx.config.reconciler.batchSize, force: opts.force === true })
    ).filter((a) => !seen.has(a.id));
    if (batch.length === 0) break;
    for (const a of batch) {
      seen.add(a.id);
      try {
        out.push(await resolveUnknown(ctx, a, owner));
      } catch (err) {
        ctx.log.error({ err: String(err), action_id: a.id }, 'reconcile.error');
        await reschedule(ctx, a, owner, { delayMs: ctx.config.reconciler.backoffBaseMs }).catch(() => {});
        out.push({ action_id: a.id, still: 'UNKNOWN', why: 'error' });
      }
    }
  }
  return out;
}
