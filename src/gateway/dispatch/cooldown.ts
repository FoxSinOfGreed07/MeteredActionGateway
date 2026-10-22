import { runScript } from '../../redis/scripts.js';
import type { GatewayContext } from '../context.js';

/**
 * A6: per-lane 429 cooldown + single half-open probe.
 * - trip(): after a 429 the lane stops sending for Retry-After (or exponential backoff with jitter).
 * - after the cooldown, while consecutive429 > 0 the lane is in PROBE mode: exactly one request (holder of
 *   the probe lock) may go out; success resets everything, another 429 trips a longer cooldown.
 */
export interface CooldownState {
  active: boolean;
  remainingMs: number;
  consecutive429: number;
  probeMode: boolean;
}

export async function cooldownState(ctx: GatewayContext, laneId: string): Promise<CooldownState> {
  const [pttl, n] = await Promise.all([
    ctx.redis.pttl(ctx.keys.cooldown(laneId)),
    ctx.redis.get(ctx.keys.cool429(laneId)),
  ]);
  const remainingMs = Math.max(0, pttl);
  const consecutive429 = Number(n ?? 0);
  return {
    active: remainingMs > 0,
    remainingMs,
    consecutive429,
    probeMode: remainingMs <= 0 && consecutive429 > 0,
  };
}

/** Returns the cooldown duration now in force (ms). */
export async function trip(ctx: GatewayContext, laneId: string, retryAfterMs?: number): Promise<number> {
  const { baseMs, maxMs } = ctx.config.cooldown;
  const [n, delay] = await runScript<[number, number]>(
    ctx.redis,
    'cooldown_trip',
    [ctx.keys.cooldown(laneId), ctx.keys.cool429(laneId)],
    [retryAfterMs ?? -1, baseMs, maxMs, Math.random()],
  );
  ctx.log.info({ lane_id: laneId, consecutive_429: n, cooldown_ms: delay }, 'cooldown.trip');
  return delay;
}

/** The ERP answered (committed or a business rejection): the lane is healthy again. */
export async function onSuccess(ctx: GatewayContext, laneId: string): Promise<void> {
  await ctx.redis.del(ctx.keys.cool429(laneId), ctx.keys.probe(laneId));
}

export async function acquireProbe(
  ctx: GatewayContext,
  laneId: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  return (await ctx.redis.set(ctx.keys.probe(laneId), owner, 'PX', Math.max(100, ttlMs), 'NX')) === 'OK';
}

export async function releaseProbe(ctx: GatewayContext, laneId: string, owner: string): Promise<void> {
  const key = ctx.keys.probe(laneId);
  if ((await ctx.redis.get(key)) === owner) await ctx.redis.del(key);
}
