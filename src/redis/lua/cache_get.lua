--! keys=2
-- D5 read. KEYS = entry (hash {v, seq, fetched_at_ms}), hwm. Returns {v, seq, fetched_at_ms} or nil.
-- Never serves a value older than the highest seq we know exists (I9): such an entry is deleted.
local seq = redis.call('HGET', KEYS[1], 'seq')
if not seq then return nil end
local hwm = tonumber(redis.call('GET', KEYS[2]) or '0')
if tonumber(seq) < hwm then
  redis.call('DEL', KEYS[1])
  return nil
end
return redis.call('HMGET', KEYS[1], 'v', 'seq', 'fetched_at_ms')
