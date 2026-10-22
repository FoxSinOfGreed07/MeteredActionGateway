import { createDb, type Db } from '../db/kysely.js';
import { createRedis, type Redis } from '../redis/client.js';
import { type Keys, keys } from '../redis/keys.js';
import type { GatewayConfig } from '../shared/config.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { type CacheHooks, createCacheHooks } from './cache/hooks.js';

/**
 * Everything a module needs, injected (no module-level singletons) so tests can run several stacks in one
 * process. Later steps hang their services off this object.
 */
export interface GatewayContext {
  db: Db;
  redis: Redis;
  keys: Keys;
  config: GatewayConfig;
  log: Logger;
  /** Own-write notifications to the read cache (step 08 replaces the no-op). */
  cacheHooks: CacheHooks;
}

export function createContext(
  config: GatewayConfig,
  opts: { db?: Db; redis?: Redis; log?: Logger; cacheHooks?: CacheHooks } = {},
): GatewayContext {
  const redis = opts.redis ?? createRedis(config.redisUrl);
  const k = keys(config.redisPrefix);
  return {
    config,
    db: opts.db ?? createDb(config.databaseUrl),
    redis,
    keys: k,
    log: opts.log ?? createLogger('gateway'),
    cacheHooks: opts.cacheHooks ?? createCacheHooks({ redis, keys: k, config }),
  };
}

export async function closeContext(ctx: GatewayContext): Promise<void> {
  await Promise.allSettled([ctx.db.destroy(), ctx.redis.quit()]);
}
