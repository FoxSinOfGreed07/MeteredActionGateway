import { sql } from 'kysely';
import type { ActionRow, LaneRow } from '../../db/schema.js';
import type { GatewayContext } from '../context.js';
import { cooldownState } from '../dispatch/cooldown.js';
import * as rateLimiter from '../dispatch/rate-limiter.js';
import { connectorForLane } from '../erp/index.js';
import { reportStaleEvidence } from './lane-health.js';

export type WitnessVerdict = 'fresh' | 'stale' | 'none' | 'unavailable';

const verdicts = new WeakMap<object, Map<string, { verdict: WitnessVerdict; at: number }>>();

/**
 * D2 rule (c). A witness is one of OUR payments, confirmed by a synchronous 2xx, that was dispatched after
 * the uncertain action could still have been committing (dispatched_at > unknown_since + request_timeout).
 * Its commit is therefore later than any commit of the uncertain one. Replicas apply commits in order (S4),
 * so a read view that shows the witness would also show the uncertain payment if it existed.
 *   found → 'fresh' (the view is new enough: "not found" is meaningful)
 *   missing → 'stale' (the view is older than a commit we KNOW happened: lane flagged, don't trust)
 *   no witness → 'none' (fall back to the time rule + lane health)
 */
export async function checkWitness(
  ctx: GatewayContext,
  action: Pick<ActionRow, 'id' | 'trust_not_found_after'>,
  lane: LaneRow,
): Promise<WitnessVerdict> {
  if (!action.trust_not_found_after) return 'none';
  const threshold = new Date(new Date(action.trust_not_found_after).getTime() - lane.max_read_lag_ms);
  const w = await sql<{ id: string; cc: string }>`
    SELECT a.id, t.erp_company_code AS cc
      FROM actions a JOIN tenants t ON t.id = a.tenant_id
     WHERE a.lane_id = ${lane.id} AND a.state = 'SUCCEEDED' AND a.confirmed_via = 'response'
       AND a.dispatched_at > ${threshold}
     ORDER BY a.dispatched_at ASC
     LIMIT 1`.execute(ctx.db);
  const witness = w.rows[0];
  if (!witness) return 'none';

  let cache = verdicts.get(ctx.db);
  if (!cache) {
    cache = new Map();
    verdicts.set(ctx.db, cache);
  }
  const hit = cache.get(witness.id);
  if (hit && Date.now() - hit.at < ctx.config.reconciler.confirmGapMs) return hit.verdict;

  if ((await cooldownState(ctx, lane.id)).active || !(await rateLimiter.acquire(ctx, lane, 2000)))
    return 'unavailable';
  let verdict: WitnessVerdict;
  try {
    const found = await connectorForLane(lane).findPaymentsByReference(witness.cc, witness.id);
    verdict = found.length > 0 ? 'fresh' : 'stale';
  } catch {
    return 'unavailable';
  }
  cache.set(witness.id, { verdict, at: Date.now() });
  if (verdict === 'stale') {
    await reportStaleEvidence(
      ctx.db,
      lane.id,
      { kind: 'witness_missing', witness_action_id: witness.id, for_action_id: action.id },
      ctx.config.reconciler.staleQuarantineMs,
    );
    ctx.log.warn(
      { lane_id: lane.id, witness: witness.id, action_id: action.id },
      'reconcile.stale_read_detected',
    );
  }
  return verdict;
}
