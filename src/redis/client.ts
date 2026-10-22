import { Redis } from 'ioredis';
import { registerScripts } from './scripts.js';

export type { Redis };

export function createRedis(url: string): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: true, lazyConnect: false });
  registerScripts(redis);
  return redis;
}
