import { randomBytes } from 'node:crypto';
import { createRedis, type Redis } from '../../src/redis/client.js';
import { TEST_REDIS_URL } from './env.js';

export interface TestRedis {
  redis: Redis;
  prefix: string;
  cleanup(): Promise<void>;
}

/** A Redis client plus a random key prefix, so test files never see each other's keys. */
export function createTestRedis(): TestRedis {
  const redis = createRedis(TEST_REDIS_URL);
  const prefix = `t_${randomBytes(4).toString('hex')}:`;
  return {
    redis,
    prefix,
    async cleanup() {
      let cursor = '0';
      do {
        const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
        cursor = next;
        if (found.length) await redis.del(...found);
      } while (cursor !== '0');
      await redis.quit().catch(() => {});
    },
  };
}
