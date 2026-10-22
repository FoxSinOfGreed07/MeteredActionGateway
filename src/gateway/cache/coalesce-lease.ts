import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { runScript } from '../../redis/scripts.js';

/** Cross-process half of D6: only the holder of a short Redis lease loads from the ERP. */
export async function acquireLease(redis: Redis, key: string, ttlMs: number): Promise<string | null> {
  const owner = randomUUID();
  return (await redis.set(key, owner, 'PX', Math.max(100, ttlMs), 'NX')) === 'OK' ? owner : null;
}

export async function releaseLease(redis: Redis, key: string, owner: string): Promise<void> {
  await runScript(redis, 'lease_release', [key], [owner]);
}
