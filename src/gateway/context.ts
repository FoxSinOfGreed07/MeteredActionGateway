import { createDb, type Db } from '../db/kysely.js';
import { createRedis, type Redis } from '../redis/client.js';
import { type Keys, keys } from '../redis/keys.js';
import type { GatewayConfig } from '../shared/config.js';
import { createLogger, type Logger } from '../shared/logger.js';

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
}

export function createContext(
  config: GatewayConfig,
  opts: { db?: Db; redis?: Redis; log?: Logger } = {},
): GatewayContext {
  return {
    config,
    db: opts.db ?? createDb(config.databaseUrl),
    redis: opts.redis ?? createRedis(config.redisUrl),
    keys: keys(config.redisPrefix),
    log: opts.log ?? createLogger('gateway'),
  };
}

export async function closeContext(ctx: GatewayContext): Promise<void> {
  await Promise.allSettled([ctx.db.destroy(), ctx.redis.quit()]);
}
