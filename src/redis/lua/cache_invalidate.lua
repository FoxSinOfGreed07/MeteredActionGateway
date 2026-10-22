--! keys=2
-- D5 invalidation from a webhook or our own write. KEYS = entry, hwm. ARGV = seq, hwm_ttl_ms.
-- Raises the high-water mark if seq is higher; deletes the entry if it is older than seq.
-- Duplicate or out-of-order (older) events are no-ops: the cache can never roll backwards.
local seq = tonumber(ARGV[1])
local hwm = tonumber(redis.call('GET', KEYS[2]) or '0')
if seq > hwm then
  redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
else
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
end
local cur = redis.call('HGET', KEYS[1], 'seq')
if cur and tonumber(cur) < seq then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
