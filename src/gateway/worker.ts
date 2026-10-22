import { sleep } from '../shared/sleep.js';
import type { GatewayContext } from './context.js';
import { LaneDispatcher } from './dispatch/dispatcher.js';
import { expireQueued } from './dispatch/expiry.js';
import { loadLanes } from './dispatch/lanes.js';
import { recoverExpiredLeases } from './dispatch/recovery.js';

export interface Worker {
  dispatchers: LaneDispatcher[];
  /** `abandon`: simulate a crash — stop immediately and DROP in-flight results (no settlement). */
  stop(opts?: { abandon?: boolean }): Promise<void>;
}

/** Background loops with a stop signal; errors are logged, never fatal. */
function every(
  ctx: GatewayContext,
  name: string,
  intervalMs: number,
  fn: () => Promise<unknown>,
  signal: AbortSignal,
) {
  return (async () => {
    while (!signal.aborted) {
      try {
        await fn();
      } catch (err) {
        ctx.log.error({ err: String(err) }, `${name}.error`);
      }
      await sleep(intervalMs, signal);
    }
  })();
}

export async function startWorker(
  ctx: GatewayContext,
  opts: { logDepthEveryMs?: number } = {},
): Promise<Worker> {
  const owner = ctx.config.workerId;
  // Recover before dispatching anything (Constraint 4).
  await recoverExpiredLeases(ctx);
  const lanes = await loadLanes(ctx.db);
  const dispatchers = lanes.map((lane) => new LaneDispatcher(ctx, lane, owner));
  for (const d of dispatchers) d.start();

  const stop = new AbortController();
  const loops = [
    every(ctx, 'recovery', ctx.config.recovery.intervalMs, () => recoverExpiredLeases(ctx), stop.signal),
    every(ctx, 'expiry', ctx.config.expiry.intervalMs, () => expireQueued(ctx), stop.signal),
  ];
  if (opts.logDepthEveryMs) {
    loops.push(
      every(
        ctx,
        'queue_depth',
        opts.logDepthEveryMs,
        async () => {
          const rows = await ctx.db
            .selectFrom('actions')
            .select(['lane_id', 'state', (eb) => eb.fn.countAll<number>().as('n')])
            .where('state', 'in', ['QUEUED', 'DISPATCHING', 'UNKNOWN'])
            .groupBy(['lane_id', 'state'])
            .execute();
          if (rows.length) ctx.log.info({ depth: rows }, 'queue.depth');
        },
        stop.signal,
      ),
    );
  }
  ctx.log.info({ worker_id: owner, lanes: lanes.map((l) => l.id) }, 'worker.started');

  return {
    dispatchers,
    async stop(o = {}) {
      stop.abort();
      await Promise.all(dispatchers.map((d) => d.stop(o)));
      await Promise.allSettled(loops);
    },
  };
}
