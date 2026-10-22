import type { ActionRow, LaneRow, TenantRow } from '../../db/schema.js';
import { sleep } from '../../shared/sleep.js';
import type { GatewayContext } from '../context.js';
import { claimNext } from './claim.js';
import * as cooldown from './cooldown.js';
import { getExecutor } from './executors/index.js';
import * as rateLimiter from './rate-limiter.js';
import { markFailed } from './settle.js';

/**
 * One dispatcher per lane (D8 + A4–A6). Loop:
 *   cooldown active → wait │ probe mode → only the probe-lock holder sends, one request at a time
 *   in-flight cap per lane → rate-limit token → fair claim (commits DISPATCHING) → execute (not awaited)
 * stop(): stop claiming, wait (≤10s) for in-flight runs. Never settle on shutdown: anything still
 * DISPATCHING is left for recovery (lease expiry → UNKNOWN → reconcile).
 */
export class LaneDispatcher {
  private inFlight = 0;
  private stopped = false;
  private abandoned = false;
  private readonly abort = new AbortController();
  private readonly running = new Set<Promise<void>>();
  private waiters: (() => void)[] = [];
  private loop?: Promise<void>;
  private readonly tenants = new Map<string, TenantRow>();

  constructor(
    private readonly ctx: GatewayContext,
    readonly lane: LaneRow,
    private readonly owner: string,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  async stop(opts: { abandon?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.abandoned = opts.abandon === true;
    this.abort.abort();
    this.wake();
    await this.loop;
    if (!this.abandoned) {
      await Promise.race([Promise.allSettled([...this.running]), sleep(10_000)]);
    }
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private async waitForSlot(cap: number): Promise<void> {
    while (!this.stopped && this.inFlight >= cap) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private async run(): Promise<void> {
    const { ctx, lane, owner } = this;
    const signal = this.abort.signal;
    while (!this.stopped) {
      let probing = false;
      try {
        const cd = await cooldown.cooldownState(ctx, lane.id);
        if (cd.active) {
          await sleep(Math.min(cd.remainingMs, 1000), signal);
          continue;
        }
        if (cd.probeMode) {
          await this.waitForSlot(1); // the probe goes out alone
          if (this.stopped) break;
          if (!(await cooldown.acquireProbe(ctx, lane.id, owner, lane.request_timeout_ms * 2))) {
            await sleep(100, signal);
            continue;
          }
          probing = true;
        } else {
          await this.waitForSlot(lane.max_in_flight);
          if (this.stopped) break;
        }
        if (!(await rateLimiter.acquire(ctx, lane, ctx.config.dispatcher.tokenWaitMaxMs, signal))) {
          if (probing) await cooldown.releaseProbe(ctx, lane.id, owner);
          continue;
        }
        const action = await claimNext(ctx, lane, owner);
        if (!action) {
          if (probing) await cooldown.releaseProbe(ctx, lane.id, owner);
          await sleep(ctx.config.dispatcher.idlePollMs, signal);
          continue;
        }
        this.inFlight += 1;
        const wasProbe = probing;
        const p = this.execute(action).finally(async () => {
          this.inFlight -= 1;
          if (wasProbe) await cooldown.releaseProbe(ctx, lane.id, owner).catch(() => {});
          this.wake();
        });
        this.running.add(p);
        void p.finally(() => this.running.delete(p));
      } catch (err) {
        if (probing) await cooldown.releaseProbe(ctx, lane.id, owner).catch(() => {});
        if (this.stopped) break;
        ctx.log.error({ err: String(err), lane_id: lane.id }, 'dispatcher.loop_error');
        await sleep(500, signal);
      }
    }
  }

  private async tenant(id: string): Promise<TenantRow> {
    let t = this.tenants.get(id);
    if (!t) {
      t = await this.ctx.db.selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      this.tenants.set(id, t);
    }
    return t;
  }

  private async execute(action: ActionRow): Promise<void> {
    const { ctx, lane, owner } = this;
    const log = ctx.log.child({ action_id: action.id, lane_id: lane.id });
    try {
      const executor = getExecutor(action.action_type);
      if (!executor) {
        await markFailed(ctx, action, {
          code: 'no_executor',
          message: `no executor registered for ${action.action_type}`,
          reason: 'no_executor',
          leaseOwner: owner,
        });
        return;
      }
      await executor({
        ctx,
        action,
        tenant: await this.tenant(action.tenant_id),
        lane,
        owner,
        isAbandoned: () => this.abandoned,
      });
    } catch (err) {
      // A bug, not an outcome. Do NOT settle: lease expiry → UNKNOWN → reconcile is the safe path.
      log.error({ err: err instanceof Error ? err.stack : String(err) }, 'executor.threw');
    }
  }
}
