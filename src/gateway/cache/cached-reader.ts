import type { LaneRow } from '../../db/schema.js';
import type { CacheObjectType } from '../../redis/keys.js';
import { runScript } from '../../redis/scripts.js';
import { GatewayError } from '../../shared/errors.js';
import { sleep } from '../../shared/sleep.js';
import type { GatewayContext } from '../context.js';
import * as cooldown from '../dispatch/cooldown.js';
import * as rateLimiter from '../dispatch/rate-limiter.js';
import { connectorForLane, ErpReadError, type ReadResult } from '../erp/index.js';
import { reportStaleEvidence } from '../reconcile/lane-health.js';
import { ttlFor } from './budgets.js';
import { acquireLease, releaseLease } from './coalesce-lease.js';
import { SingleFlight } from './singleflight.js';

export interface CachedRead {
  data: unknown;
  seq: number;
  source: 'cache' | 'erp' | 'coalesced';
  fetchedAtMs: number;
}
export type ReadOutcome = CachedRead | { notFound: true };

const unavailable = (msg: string, retryAfterS = 1) =>
  new GatewayError('upstream_unavailable', 503, msg, undefined, retryAfterS);

/**
 * D4 read-through: the ONLY path to ERP vendor/invoice reads. One place enforces the staleness budget (TTL),
 * the sequence guard (D5, Lua: never serve/store seq < HWM) and stampede protection (D6: in-process
 * single-flight + a cross-process Redis lease; everyone else waits for the fill).
 */
export class CachedReader {
  private readonly flights = new SingleFlight<ReadOutcome>();

  constructor(private readonly ctx: GatewayContext) {}

  private keysFor(lane: string, cc: string, type: CacheObjectType, id: string) {
    const k = this.ctx.keys;
    return {
      entry: k.cacheEntry(lane, cc, type, id),
      hwm: k.hwm(lane, cc, type, id),
      lease: k.coalesceLease(lane, cc, type, id),
    };
  }

  private async cacheGet(entry: string, hwm: string): Promise<Omit<CachedRead, 'source'> | null> {
    const r = await runScript<[string | null, string | null, string | null] | null>(
      this.ctx.redis,
      'cache_get',
      [entry, hwm],
    );
    if (!r || r[0] === null || r[1] === null) return null;
    return { data: JSON.parse(r[0]), seq: Number(r[1]), fetchedAtMs: Number(r[2]) };
  }

  async get(lane: LaneRow, cc: string, type: CacheObjectType, id: string): Promise<ReadOutcome> {
    const k = this.keysFor(lane.id, cc, type, id);
    const hit = await this.cacheGet(k.entry, k.hwm);
    if (hit) return { ...hit, source: 'cache' };
    const [p, leader] = this.flights.do(`${lane.id}|${cc}|${type}|${id}`, () =>
      this.loadCoalesced(lane, cc, type, id),
    );
    const r = await p;
    if ('notFound' in r || leader) return r;
    return { ...r, source: 'coalesced' };
  }

  /** Cross-process coalescing: lease holder loads; others poll the cache until filled (≤ waitMs). */
  private async loadCoalesced(
    lane: LaneRow,
    cc: string,
    type: CacheObjectType,
    id: string,
  ): Promise<ReadOutcome> {
    const k = this.keysFor(lane.id, cc, type, id);
    const { leaseMs, waitMs, pollMs } = this.ctx.config.cache.coalesce;
    const lead = async (owner: string) => {
      try {
        return await this.loadAndFill(lane, cc, type, id);
      } finally {
        await releaseLease(this.ctx.redis, k.lease, owner).catch(() => {});
      }
    };
    const owner = await acquireLease(this.ctx.redis, k.lease, leaseMs);
    if (owner) return lead(owner);

    const deadline = Date.now() + waitMs;
    let retried = false;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const hit = await this.cacheGet(k.entry, k.hwm);
      if (hit) return { ...hit, source: 'coalesced' };
      if (!retried && !(await this.ctx.redis.exists(k.lease))) {
        retried = true; // the holder finished without a fill (failed / not found / stale): try to lead once
        const o = await acquireLease(this.ctx.redis, k.lease, leaseMs);
        if (o) return lead(o);
      }
    }
    throw unavailable('timed out waiting for a coalesced ERP read');
  }

  private async loadAndFill(
    lane: LaneRow,
    cc: string,
    type: CacheObjectType,
    id: string,
    attempt = 1,
  ): Promise<ReadOutcome> {
    const { ctx } = this;
    const k = this.keysFor(lane.id, cc, type, id);
    // Reads spend the same ERP rate budget as payments (that's why the cache exists).
    const cd = await cooldown.cooldownState(ctx, lane.id);
    if (cd.active) throw unavailable('ERP lane is cooling down after 429s', Math.ceil(cd.remainingMs / 1000));
    if (!(await rateLimiter.acquire(ctx, lane, ctx.config.cache.readTokenWaitMs)))
      throw unavailable('ERP read budget exhausted');

    let res: ReadResult<unknown>;
    try {
      const erp = connectorForLane(lane);
      res = type === 'vendor' ? await erp.getVendor(cc, id) : await erp.getInvoice(cc, id);
    } catch (err) {
      if (err instanceof ErpReadError && err.kind === 'rate_limited') {
        await cooldown.trip(ctx, lane.id, err.retryAfterMs).catch(() => {});
        throw unavailable(
          'ERP rate-limited the read',
          Math.max(1, Math.ceil((err.retryAfterMs ?? 1000) / 1000)),
        );
      }
      throw unavailable(`ERP read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 'not_found') return { notFound: true };

    const fetchedAtMs = Date.now();
    const r = await runScript<number>(
      ctx.redis,
      'cache_fill',
      [k.entry, k.hwm],
      [JSON.stringify(res.data), res.seq, fetchedAtMs, ttlFor(type, lane, ctx.config)],
    );
    if (r === -1) {
      // The ERP served a version older than one we KNOW exists: a stale read. Evidence for the reconciler (D2).
      const hwm = Number(await ctx.redis.get(k.hwm));
      await reportStaleEvidence(
        ctx.db,
        lane.id,
        { kind: 'cache_fill_below_hwm', type, id, company: cc, seq: res.seq, hwm },
        ctx.config.reconciler.staleQuarantineMs,
      ).catch(() => {});
      ctx.log.warn({ lane_id: lane.id, type, id, seq: res.seq, hwm }, 'cache.stale_read_rejected');
      if (attempt === 1) {
        await sleep(200);
        return this.loadAndFill(lane, cc, type, id, 2);
      }
      throw new GatewayError(
        'upstream_stale',
        503,
        'the ERP keeps returning data older than a change we already know about',
        { seq: res.seq, hwm },
        1,
      );
    }
    if (r === -2) {
      const newer = await this.cacheGet(k.entry, k.hwm);
      if (newer) return { ...newer, source: 'cache' };
    }
    return { data: res.data, seq: res.seq, fetchedAtMs, source: 'erp' };
  }
}
