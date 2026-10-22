--! keys=2
-- A6 429 cooldown. KEYS[1] = {p}cool:{lane}, KEYS[2] = {p}cool429:{lane}
-- ARGV = retry_after_ms (<= 0: none), base_ms, max_ms, rand (0..1, from the caller: Lua scripts can't
-- produce real randomness).
-- One trip per cooldown window: while a cooldown is active, more 429s (e.g. the other in-flight requests of
-- the same burst) do NOT escalate the backoff exponent. Returns {consecutive_429, cooldown_ms}.
local active = redis.call('PTTL', KEYS[1])
if active > 0 then
  return { tonumber(redis.call('GET', KEYS[2]) or '0'), active }
end
local n = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 300)
local retryAfter = tonumber(ARGV[1])
local base = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local rand = tonumber(ARGV[4])
local delay
if retryAfter > 0 then
  delay = retryAfter
else
  local exp = math.min(n - 1, 30)
  delay = math.min(max, base * (2 ^ exp))
  delay = delay / 2 + rand * delay / 2 -- full jitter in [d/2, d]
end
delay = math.max(50, math.floor(delay))
redis.call('SET', KEYS[1], tostring(delay), 'PX', delay)
return { n, delay }
