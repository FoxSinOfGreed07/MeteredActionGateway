import type { ActionRow, LaneRow } from '../../db/schema.js';
import type { GatewayContext } from '../context.js';
import { staleSuspectedUntil } from './lane-health.js';
import { checkWitness } from './witness.js';

export interface TrustVerdict {
  trusted: boolean;
  why: 'trusted' | 'too_early' | 'lane_stale_suspected' | 'witness_not_visible' | 'witness_unavailable';
  retryAt?: Date;
}

/**
 * D2 — when may "not found" be believed? "Found" is strong evidence (a lagging view can miss a write, never
 * invent one); "not found" is weak. In order:
 *   (a) time: now ≥ trust_not_found_after (= unknown_since + request_timeout + max_read_lag)
 *   (b) lane health: no stale-read evidence on the lane within the quarantine
 *   (c) witness: a later committed payment of ours must be visible in the same view
 *   (d) two consecutive trusted not-founds (checked by the caller)
 */
export async function canTrustNotFound(
  ctx: GatewayContext,
  action: Pick<ActionRow, 'id' | 'trust_not_found_after'>,
  lane: LaneRow,
): Promise<TrustVerdict> {
  const after = action.trust_not_found_after ? new Date(action.trust_not_found_after) : null;
  if (!after || Date.now() < after.getTime()) {
    return { trusted: false, why: 'too_early', ...(after ? { retryAt: after } : {}) };
  }
  const stale = await staleSuspectedUntil(ctx.db, lane.id);
  if (stale) {
    const cap = new Date(Date.now() + ctx.config.reconciler.backoffMaxMs);
    return { trusted: false, why: 'lane_stale_suspected', retryAt: stale < cap ? stale : cap };
  }
  const witness = await checkWitness(ctx, action, lane);
  if (witness === 'stale') return { trusted: false, why: 'witness_not_visible' };
  if (witness === 'unavailable') return { trusted: false, why: 'witness_unavailable' };
  return { trusted: true, why: 'trusted' };
}
