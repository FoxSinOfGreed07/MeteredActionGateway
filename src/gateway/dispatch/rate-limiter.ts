import type { LaneRow } from '../../db/schema.js';
import { runScript } from '../../redis/scripts.js';
import { sleep } from '../../shared/sleep.js';
import type { GatewayContext } from '../context.js';

/**
 * A6: one Redis token bucket per lane, shared by every process (an in-process limiter in N workers would
 * send N× the ERP's quota). Sends, reconciler lookups and cache misses all draw from the same bucket.
 */
export async function tryAcquire(
  ctx: GatewayContext,
  lane: Pick<LaneRow, 'id' | 'rate_per_sec' | 'burst'>,
): Promise<number> {
  return runScript<number>(
    ctx.redis,
    'token_bucket',
    [ctx.keys.rateLimit(lane.id)],
    [lane.rate_per_sec, lane.burst],
  );
}

/**
 * Wait (up to maxWaitMs) for a token. Redis down → false: fail CLOSED for sends — losing Redis makes the
 * system slower, never wrong (D8 principle).
 */
export async function acquire(
  ctx: GatewayContext,
  lane: Pick<LaneRow, 'id' | 'rate_per_sec' | 'burst'>,
  maxWaitMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let waited = 0;
  for (;;) {
    if (signal?.aborted) return false;
    let wait: number;
    try {
      wait = await tryAcquire(ctx, lane);
    } catch (err) {
      ctx.log.warn({ err: String(err), lane_id: lane.id }, 'rate_limiter.redis_error');
      return false;
    }
    if (wait === 0) return true;
    if (waited + wait > maxWaitMs) return false;
    await sleep(wait, signal);
    waited += wait;
  }
}
