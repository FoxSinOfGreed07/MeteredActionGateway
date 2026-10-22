--! keys=2
-- D4/D5 guarded fill. KEYS = entry, hwm. ARGV = value_json, seq, fetched_at_ms, ttl_ms.
-- Returns 1 stored · 0 accepted but not stored (ttl <= 0) · -1 STALE READ (seq < hwm) · -2 newer already cached.
-- Every fill goes through here, so a slow reader can never write an old value back after an invalidation.
local seq = tonumber(ARGV[2])
local hwm = tonumber(redis.call('GET', KEYS[2]) or '0')
if seq < hwm then return -1 end
local cur = redis.call('HGET', KEYS[1], 'seq')
if cur and tonumber(cur) > seq then return -2 end
local ttl = tonumber(ARGV[4])
if ttl <= 0 then return 0 end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'seq', ARGV[2], 'fetched_at_ms', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ttl)
return 1
