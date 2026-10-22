import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Db } from '../../src/db/kysely.js';
import { createApp } from '../../src/gateway/api/app.js';
import { createContext, type GatewayContext } from '../../src/gateway/context.js';
import type { Redis } from '../../src/redis/client.js';
import { type DeepPartial, type GatewayConfig, loadConfig, scaleDurations } from '../../src/shared/config.js';
import { createLogger } from '../../src/shared/logger.js';
import { createTestDatabase } from './db.js';
import { createLane, type LaneInput, seedPriceList } from './fixtures.js';
import { createTestRedis } from './redis.js';
import { SCALE } from './time.js';

export interface StackOptions {
  /** Scales every *Ms config value and lane durations. Default: SCENARIO_TIME_SCALE (0.1). */
  timeScale?: number;
  /** Overrides in *real* (unscaled) ms; scaled together with the defaults. */
  config?: DeepPartial<GatewayConfig>;
  /** Lane rows (unscaled ms). Default: sap-main + llm. base_url defaults to the mock ERP (when started). */
  lanes?: LaneInput[];
  seedPrices?: boolean;
}

export interface Stack {
  ctx: GatewayContext;
  db: Db;
  redis: Redis;
  prefix: string;
  scale: number;
  api: { url: string; app: Hono; request: (path: string, init?: RequestInit) => Promise<Response> };
  stop(): Promise<void>;
}

const LANE_DURATION_KEYS = ['request_timeout_ms', 'lease_ms', 'max_read_lag_ms'] as const;

export function defaultLanes(): LaneInput[] {
  return [
    { id: 'sap-main', kind: 'erp' },
    { id: 'llm', kind: 'llm' },
  ];
}

function scaleLane(lane: LaneInput, scale: number): LaneInput {
  const out: LaneInput = { ...lane };
  for (const k of LANE_DURATION_KEYS) {
    const v = lane[k];
    if (typeof v === 'number') out[k] = Math.max(1, Math.round(v * scale));
  }
  return out;
}

const LANE_DEFAULT_DURATIONS = {
  erp: { request_timeout_ms: 5000, lease_ms: 20_000, max_read_lag_ms: 5000 },
  llm: { request_timeout_ms: 20_000, lease_ms: 60_000, max_read_lag_ms: 0 },
};

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const scale = opts.timeScale ?? SCALE;
  const tdb = await createTestDatabase();
  const tr = createTestRedis();
  const config = scaleDurations(loadConfig(opts.config), scale);
  config.databaseUrl = tdb.url;
  config.redisPrefix = tr.prefix;
  const ctx = createContext(config, { db: tdb.db, redis: tr.redis, log: createLogger('test') });

  if (opts.seedPrices !== false) await seedPriceList(tdb.db);
  for (const lane of opts.lanes ?? defaultLanes()) {
    const kind = lane.kind ?? (lane.id === 'llm' ? 'llm' : 'erp');
    const withDefaults: LaneInput = { ...LANE_DEFAULT_DURATIONS[kind], ...lane, kind };
    await createLane(tdb.db, {
      ...scaleLane(withDefaults, scale),
      base_url: lane.base_url ?? (kind === 'erp' ? 'http://127.0.0.1:9' : null),
    });
  }

  const app = createApp(ctx);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    ctx,
    db: tdb.db,
    redis: tr.redis,
    prefix: tr.prefix,
    scale,
    api: { url, app, request: (path, init) => Promise.resolve(app.request(path, init)) },
    async stop() {
      await new Promise<void>((resolve) => {
        const s = server as unknown as { close(cb: () => void): void; closeAllConnections?: () => void };
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
      await tr.cleanup(); // also quits the redis client
      await tdb.drop(); // destroys the pool, drops the database
    },
  };
}
