import { sql } from 'kysely';
import { json } from '../../db/kysely.js';
import type { ActionRow, ActionState, LaneRow } from '../../db/schema.js';
import { transition } from '../actions/state-machine.js';
import type { GatewayContext } from '../context.js';
import { settleFailure, settleSuccess } from '../wallet/ledger.js';
import { getPrice } from '../wallet/pricing.js';

/**
 * Settlement: ONE transaction per outcome — the state transition (CAS, fenced by lease owner where given)
 * and its ledger effect (D3) commit together. Each returns null when the CAS is lost: nothing was written,
 * someone else (recovery / reconciler) owns the outcome now; the caller logs `settle.cas_lost`.
 */

export async function markSucceeded(
  ctx: GatewayContext,
  action: Pick<ActionRow, 'id' | 'action_type'>,
  o: {
    result: unknown;
    via: 'response' | 'reconcile';
    reason: string;
    capture?: number;
    from?: ActionState[];
    leaseOwner?: string;
  },
): Promise<ActionRow | null> {
  const capture = o.capture ?? (await getPrice(ctx.db, action.action_type)).capture;
  return ctx.db.transaction().execute(async (tx) => {
    const row = await transition(tx, {
      actionId: action.id,
      from: o.from ?? ['DISPATCHING'],
      to: 'SUCCEEDED',
      reason: o.reason,
      ...(o.leaseOwner === undefined ? {} : { leaseOwner: o.leaseOwner }),
      patch: { result: json(o.result), captured_amount: capture, confirmed_via: o.via },
    });
    if (!row) return null;
    await settleSuccess(tx, row, capture);
    return row;
  });
}

export async function markFailed(
  ctx: GatewayContext,
  action: Pick<ActionRow, 'id'>,
  o: {
    code: string;
    message: string;
    reason: string;
    /** Stored as result.current_state (e.g. the ERP's current invoice on INVOICE_ALREADY_PAID). */
    currentState?: unknown;
    details?: unknown;
    from?: ActionState[];
    leaseOwner?: string;
  },
): Promise<ActionRow | null> {
  return ctx.db.transaction().execute(async (tx) => {
    const row = await transition(tx, {
      actionId: action.id,
      from: o.from ?? ['DISPATCHING'],
      to: 'FAILED',
      reason: o.reason,
      ...(o.details === undefined ? {} : { details: o.details }),
      ...(o.leaseOwner === undefined ? {} : { leaseOwner: o.leaseOwner }),
      patch: {
        failure_code: o.code,
        failure_message: o.message.slice(0, 1000),
        result: json({ current_state: o.currentState ?? null }),
      },
    });
    if (!row) return null;
    await settleFailure(tx, row, o.code, o.message);
    return row;
  });
}

/** Not committed (429/503/unreachable or a retryable LLM error): back to QUEUED with a delay. No attempt cap. */
export async function requeueRetryable(
  ctx: GatewayContext,
  action: Pick<ActionRow, 'id'>,
  o: {
    reason: string;
    delayMs: number;
    leaseOwner?: string;
    from?: ActionState[];
    countRetry?: boolean;
    details?: unknown;
  },
): Promise<ActionRow | null> {
  return ctx.db.transaction().execute((tx) =>
    transition(tx, {
      actionId: action.id,
      from: o.from ?? ['DISPATCHING'],
      to: 'QUEUED',
      reason: o.reason,
      ...(o.details === undefined ? {} : { details: o.details }),
      ...(o.leaseOwner === undefined ? {} : { leaseOwner: o.leaseOwner }),
      patch: {
        retry_count: o.countRetry === false ? sql`retry_count` : sql`retry_count + 1`,
        next_attempt_at: sql`now() + make_interval(secs => ${Math.max(0, o.delayMs) / 1000}::double precision)`,
        lease_owner: null,
        lease_until: null,
      },
    }),
  );
}

/**
 * D2: ambiguous outcome → UNKNOWN. The hold is KEPT. "Not found" may only be trusted after
 * request_timeout + max_read_lag (an abandoned request may still commit, and then must become visible).
 * The first lookup is scheduled early anyway: a "found" is trusted immediately.
 */
export async function markUnknown(
  ctx: GatewayContext,
  action: Pick<ActionRow, 'id'>,
  o: {
    reason: string;
    leaseOwner: string;
    lane: Pick<LaneRow, 'request_timeout_ms' | 'max_read_lag_ms'>;
    details?: unknown;
  },
): Promise<ActionRow | null> {
  const trustAfterMs = o.lane.request_timeout_ms + o.lane.max_read_lag_ms;
  return ctx.db.transaction().execute((tx) =>
    transition(tx, {
      actionId: action.id,
      from: ['DISPATCHING'],
      to: 'UNKNOWN',
      reason: o.reason,
      leaseOwner: o.leaseOwner,
      ...(o.details === undefined ? {} : { details: o.details }),
      patch: {
        ambiguous_count: sql`ambiguous_count + 1`,
        unknown_since: sql`now()`,
        trust_not_found_after: sql`now() + make_interval(secs => ${trustAfterMs / 1000}::double precision)`,
        next_reconcile_at: sql`now() + make_interval(secs => ${ctx.config.reconciler.firstLookupDelayMs / 1000}::double precision)`,
        not_found_count: 0,
        lease_owner: null,
        lease_until: null,
      },
    }),
  );
}
