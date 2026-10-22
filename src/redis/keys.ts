/**
 * Every Redis key is built here (plans/00-architecture.md §11). The prefix is explicit — we deliberately
 * don't use ioredis `keyPrefix`, so keys inside Lua scripts and tests are unambiguous.
 */
export type CacheObjectType = 'vendor' | 'invoice';

export function keys(prefix: string) {
  const obj = (lane: string, cc: string, type: string, id: string) => `${lane}:${cc}:${type}:${id}`;
  return {
    prefix,
    rateLimit: (lane: string) => `${prefix}rl:${lane}`,
    cooldown: (lane: string) => `${prefix}cool:${lane}`,
    cool429: (lane: string) => `${prefix}cool429:${lane}`,
    probe: (lane: string) => `${prefix}probe:${lane}`,
    cacheEntry: (lane: string, cc: string, type: CacheObjectType, id: string) =>
      `${prefix}c:${obj(lane, cc, type, id)}`,
    hwm: (lane: string, cc: string, type: CacheObjectType, id: string) =>
      `${prefix}hwm:${obj(lane, cc, type, id)}`,
    coalesceLease: (lane: string, cc: string, type: CacheObjectType, id: string) =>
      `${prefix}lk:${obj(lane, cc, type, id)}`,
  };
}

export type Keys = ReturnType<typeof keys>;
