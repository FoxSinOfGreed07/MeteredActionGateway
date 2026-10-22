import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScript } from '../../src/redis/scripts.js';
import { createTestRedis, type TestRedis } from '../kit/redis.js';

let r: TestRedis;
beforeAll(() => {
  r = createTestRedis();
});
afterAll(async () => r?.cleanup());

let n = 0;
const keysFor = () => {
  n += 1;
  return [`${r.prefix}c:obj${n}`, `${r.prefix}hwm:obj${n}`];
};
const fill = (k: string[], seq: number, v = `v${seq}`, ttl = 60_000) =>
  runScript<number>(r.redis, 'cache_fill', k, [JSON.stringify(v), seq, Date.now(), ttl]);
const get = (k: string[]) => runScript<[string, string, string] | null>(r.redis, 'cache_get', k);
const invalidate = (k: string[], seq: number) =>
  runScript<number>(r.redis, 'cache_invalidate', k, [seq, 60_000]);

describe('cache Lua scripts (D5 / I9)', () => {
  it('fill seq 1 → hit', async () => {
    const k = keysFor();
    expect(await fill(k, 1)).toBe(1);
    expect((await get(k))?.[1]).toBe('1');
  });

  it('invalidate seq 2 → entry deleted, HWM 2; fill seq 1 rejected (-1, stale); fill seq 2 stored', async () => {
    const k = keysFor();
    await fill(k, 1);
    expect(await invalidate(k, 2)).toBe(1);
    expect(await get(k)).toBeNull();
    expect(await r.redis.get(k[1]!)).toBe('2');
    expect(await fill(k, 1)).toBe(-1);
    expect(await fill(k, 2)).toBe(1);
  });

  it('never rolls back: fill seq 3 then seq 2 → -2, entry stays at 3', async () => {
    const k = keysFor();
    await fill(k, 3);
    expect(await fill(k, 2)).toBe(-2);
    expect((await get(k))?.[1]).toBe('3');
  });

  it('older / duplicate invalidation is a no-op (HWM stays, newer entry survives)', async () => {
    const k = keysFor();
    await invalidate(k, 2);
    await fill(k, 2);
    expect(await invalidate(k, 1)).toBe(0);
    expect(await invalidate(k, 2)).toBe(0);
    expect(await r.redis.get(k[1]!)).toBe('2');
    expect((await get(k))?.[1]).toBe('2');
  });

  it('an entry below the HWM is never served (and is deleted)', async () => {
    const k = keysFor();
    await r.redis.hset(k[0]!, { v: '"old"', seq: '1', fetched_at_ms: String(Date.now()) });
    await r.redis.set(k[1]!, '2');
    expect(await get(k)).toBeNull();
    expect(await r.redis.exists(k[0]!)).toBe(0);
  });

  it('the in-flight fill race (D4): a load that read seq 1 lands AFTER an invalidation to seq 2 → rejected', async () => {
    const k = keysFor();
    await fill(k, 1);
    const inFlightRead = 1; // a reader fetched seq 1 from the ERP …
    await invalidate(k, 2); // … the webhook for seq 2 is processed …
    expect(await fill(k, inFlightRead)).toBe(-1); // … and the old value can never be written back
    expect(await get(k)).toBeNull();
  });

  it('ttl <= 0 → accepted but not stored (0)', async () => {
    const k = keysFor();
    expect(await fill(k, 1, 'x', 0)).toBe(0);
    expect(await get(k)).toBeNull();
  });
});
