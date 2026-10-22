# Step 08: Read cache, webhooks, stampede protection

- **Goal:** serve agents' ERP lookups (vendors and invoices) from a read-through cache that:
  - never serves a value we know is outdated (sequence high-water mark)
  - never outlives a write by more than the declared budget (TTL = budget − max lag)
  - turns 1,000 simultaneous misses into one ERP read (coalescing)
  - reports stale ERP reads as evidence for the reconciler

  Ships Scenarios 6 and 7.
- **Depends on:** 05, 06 (rate limiter, cooldown, cache-hooks interface), 07 (lane health).
- **Decisions applied:** D4 (read-through), D5 (webhook + sequence HWM, own-write bump, TTL backstop), D6 (coalescing), A11 (reads not metered), A17 (HMAC, stretch), I9 and I10.
- **Estimate:** ~4 h.
- **Contract:** `00-architecture.md` §8 (read and webhook endpoints), §9 (webhook shape), §11 (cache keys and Lua), §12 (`cache.*`), plus the budgets table in `decisions/recommended.md` → D5.

## Deliverables
- `src/redis/lua/{cache_get,cache_fill,cache_invalidate}.lua`, registered in `scripts.ts`
- `src/gateway/cache/budgets.ts`: `budgetFor(type) → ms`, `ttlFor(type, lane) → ms` (≤ 0 means don't cache)
- `src/gateway/cache/keys.ts`: object-key helpers built on `src/redis/keys.ts`
- `src/gateway/cache/singleflight.ts`: an in-process `Map<string, Promise<T>>`
- `src/gateway/cache/coalesce-lease.ts`: the cross-process Redis lease plus waiting
- `src/gateway/cache/cached-reader.ts`: `CachedReader.get(lane, cc, type, id)`
- `src/gateway/cache/webhook-ingest.ts`
- `src/gateway/cache/hooks.ts`: the real implementation of `onInvoiceChanged`, replacing step 06's no-op
- `src/gateway/api/routes/erp-reads.ts` (`GET /v1/erp/vendors/:id`, `GET /v1/erp/invoices/:id`) and `routes/webhooks.ts`
- `test/unit/cache-lua.test.ts` (against real Redis), `test/integration/cache.test.ts`, `test/scenarios/s6-late-webhook.test.ts`, `test/scenarios/s7-stampede.test.ts`

## Lua scripts (atomic; this is where I9 lives)
Entry = hash `{ v: <json>, seq: <int>, fetched_at_ms: <int> }`; HWM = an integer string.

**`cache_get.lua`** (KEYS: entry, hwm)
```lua
local seq = redis.call('HGET', KEYS[1], 'seq')
if not seq then return nil end
local hwm = tonumber(redis.call('GET', KEYS[2]) or '0')
if tonumber(seq) < hwm then redis.call('DEL', KEYS[1]); return nil end
return redis.call('HMGET', KEYS[1], 'v', 'seq', 'fetched_at_ms')
```

**`cache_fill.lua`** (KEYS: entry, hwm; ARGV: value_json, seq, fetched_at_ms, ttl_ms)
```lua
local seq = tonumber(ARGV[2])
local hwm = tonumber(redis.call('GET', KEYS[2]) or '0')
if seq < hwm then return -1 end                                   -- stale read (evidence for D2)
local cur = redis.call('HGET', KEYS[1], 'seq')
if cur and tonumber(cur) > seq then return -2 end                 -- never roll back
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'seq', ARGV[2], 'fetched_at_ms', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
```

**`cache_invalidate.lua`** (KEYS: entry, hwm; ARGV: seq, hwm_ttl_ms)
```lua
local seq = tonumber(ARGV[1])
local hwm = tonumber(redis.call('GET', KEYS[2]) or '0')
if seq > hwm then redis.call('SET', KEYS[2], seq, 'PX', ARGV[2]) else redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
local cur = redis.call('HGET', KEYS[1], 'seq')
if cur and tonumber(cur) < seq then redis.call('DEL', KEYS[1]); return 1 end
return 0
```
Own writes with no known seq (the reconciler's `found` path) just `DEL` the entry.

## CachedReader (`cached-reader.ts`)
```ts
type CacheType = 'vendor' | 'invoice';
interface CachedRead<T> { data: T; seq: number; source: 'cache' | 'erp' | 'coalesced'; fetchedAtMs: number }

async get(laneId, cc, type, id): Promise<CachedRead<T> | { notFound: true }>
```
1. **Hit:** `cache_get` → if there's an entry, return `{source:'cache'}`.
2. **Miss:** `singleflight.do(key, () => loadCoalesced(...))`. The caller that started the flight gets the load's own source (`'erp'` or, if it waited on another process, `'coalesced'`). Every *other* in-process caller gets `'coalesced'`.
3. **`loadCoalesced`:**
   1. **We hold the lease** (`SET lk owner NX PX leaseMs`): `try { return await loadAndFill() } finally { DEL lk only if the value is still ours }`. Do the compare-and-delete in a tiny Lua script, or use `GETDEL` and compare.
   2. **Someone else holds it:** poll `cache_get` every `pollMs` for up to `waitMs`.
      - A hit → `'coalesced'`.
      - The lease disappears with no hit (the holder failed) → try to take the lease **once** more, then load.
      - Deadline reached → throw `upstream_unavailable` with `Retry-After: 1`.
4. **`loadAndFill`:**
   1. **Check the lane.** If the cooldown is active → `upstream_unavailable` with `Retry-After` = remaining. If `!rateLimiter.acquire(lane, readTokenWaitMs)` → `upstream_unavailable`.
   2. **Read.** `res = connector.getVendor/getInvoice(cc, id)`.
      - `ErpReadError rate_limited` → `cooldown.trip`, then `upstream_unavailable`.
      - Other errors → `upstream_unavailable`.
      - `not_found` → return `{notFound:true}`. Negative results are **not** cached.
   3. **Fill.** `r = cache_fill(entry, hwm, json, res.seq, now, ttlFor(type, lane))`. If `ttl ≤ 0`, skip storing, but still compare against the HWM.
      - `r === -1` (**stale read**): `laneHealth.reportStaleEvidence(lane, {kind:'cache_fill_below_hwm', type, id, seq, hwm})`. Retry the read once after 200 ms. If it's still stale, throw `upstream_stale` (503). **Never return the stale value** (I9).
      - `r === -2`: a newer value is already cached. Re-read it with `cache_get` and return that.
      - `r === 1`: return `{source:'erp'}`.
5. **Response mapping** (`routes/erp-reads.ts`):
   - Look up `lane`/`cc` from the tenant.
   - `{notFound:true}` → `404 not_found`.
   - Otherwise `200 { data, meta: { seq, source, fetched_at, age_ms: now − fetchedAtMs, budget_ms } }`.

**Budgets** (`budgets.ts`):
- `vendor` → `config.cache.budgets.vendorMs` (60,000); `invoice` → `invoiceMs` (15,000).
- `ttlFor = budget − lane.max_read_lag_ms`.
- Put the budgets table from D5 in a comment at the top of the file.

## Webhooks (`webhook-ingest.ts`, `routes/webhooks.ts`)
`POST /v1/webhooks/erp/:laneId`:
1. Load the lane (404 if it's unknown). If `lane.webhook_secret` is set, verify `X-Erp-Signature` against the **raw** body (`await c.req.text()` before JSON parsing) using `timingSafeEqual`. A mismatch → `401`.
2. zod-parse the WebhookEvent (§9) → `400` on failure.
3. `INSERT INTO erp_events (...) ON CONFLICT (lane_id, event_id) DO NOTHING` (durable log and dedupe).
4. For `object_type` `vendor` or `invoice`, run `cache_invalidate(entry, hwm, seq, hwmTtlMs)`. This is idempotent, so it's safe for duplicates and out-of-order events. `payment` events: log only.
5. Return `204`.

The Postgres insert happens before the Redis invalidation, so the event is durable even if Redis is down. If Redis fails, still return `204`: the TTL backstop bounds staleness. Log it.

**Own writes** (`hooks.ts`, the real `onInvoiceChanged`): `seq != null` → `cache_invalidate(invoiceEntry, hwm, seq)`; `seq == null` → `DEL` the entry.

## Tests

**`test/unit/cache-lua.test.ts`** (real Redis, random prefix)
- Fill seq 1, then get → hit.
- Invalidate seq 2 → entry deleted, HWM 2. Fill seq 1 → `-1`. Fill seq 2 → `1`.
- Fill seq 3, then fill seq 2 → `-2`, and the entry stays at seq 3.
- Invalidate seq 1 after the HWM is already 2 → no-op, the HWM stays 2, and a seq-2 entry survives.
- Manually create entry seq 1 with HWM 2 (simulating a race), then `cache_get` → nil, and the entry is deleted.
- **The in-flight fill race (D4/D5):** begin a "load" that read seq 1, invalidate seq 2 *before* the fill, then fill seq 1 → `-1`. The old value is never reinstated.

**`test/integration/cache.test.ts`**
- Miss → `source:'erp'` → second read `source:'cache'` → mock vendor reads = 1.
- A pay_invoice SUCCEEDED → the invoice entry is invalidated with the new seq. The next read shows `status: PAID` and a seq ≥ the payment response's invoice seq.
- Duplicate webhook (same `event_id`) → one `erp_events` row, and both requests get 204.
- A bad HMAC → 401.
- Read during an active cooldown → 503 `upstream_unavailable` with `Retry-After`. Mock reads don't increase.

**S6: `s6-late-webhook.test.ts`**
> *Analyst: the vendor master changes in SAP via another channel, and the webhook arrives 40 s late → the cached read is invalidated by sequence number, and once the webhook is processed no read older than it can be observed. Before that, staleness stays within the vendor budget (60 s).*
- **Config:** `vendorMs = T(60000)`, lane `max_read_lag_ms = T(5000)`, so TTL = `T(55000)`.
- **Steps:**
  1. Read `V-0001` → seq 1, source `erp`. Read again → seq 1, source `cache`.
  2. `PATCH /__admin/companies/C100/vendors/V-0001?webhook_delay_ms=${T(40000)}` with a new name. The mock is now at seq 2.
  3. **Before the webhook:** reads may return seq 1. Assert every response satisfies `age_ms ≤ budget_ms` (within budget, not a violation).
  4. `waitFor` an `erp_events` row with `seq = 2` (it arrives at about `T(40000)`).
  5. **After the webhook:** 50 reads in a row all return seq 2 with the new name. A stale read after the write is now impossible to observe.
  6. **Out-of-order or duplicate:** POST a hand-built, correctly signed webhook with seq 1 and a fresh `event_id` → 204. A read still returns seq 2.
  7. **Stale ERP replica after the webhook:**
     - Add fault `stale_reads` (`lag_ms: T(600000)`, GET only).
     - Delete the cache entry by hand to force a miss.
     - Read → `503 upstream_stale`. It is **never** seq 1.
     - `lane_health.stale_suspected_until` is set (evidence reported).
     - Clear the fault → the read returns seq 2.
- **TTL backstop (separate test in the same file):**
  1. `webhooks_enabled: false`.
  2. Read V-0002 (seq 1 cached).
  3. Patch it to seq 2, and record `t_write`.
  4. Poll reads every `T(1000)` until seq 2 appears.
  5. Assert `observed_at − t_write ≤ budget (T(60000))` (I10).

**S7: `s7-stampede.test.ts`**
> *Platform: 1,000 agents request the same vendor record at the moment its cache expires → one upstream read; everyone else is served the coalesced result.*
- **Setup:**
  1. Read V-0003 once (cached).
  2. Expire it: delete the entry with the test Redis client. This is the same as TTL expiry and avoids waiting.
  3. Fault `latency` 300 ms on `GET */vendors/*`, so all requests arrive while the single read is in flight.
  4. `POST /__admin/stats/reset`.
- **Fire:** 1,000 concurrent `stack.api.app.request('/v1/erp/vendors/V-0003', …)` calls (in-process; no sockets).
- **Assert:**
  - mock `reads.vendor['C100/V-0003'] === 1`
  - all 1,000 responses are 200 with the same seq
  - exactly 1 has `meta.source === 'erp'`, and the other 999 are `'coalesced'` (some may be `'cache'` if they arrived after the fill; assert `erp === 1` and `erp + coalesced + cache === 1000`)
- **Real-HTTP variant:** 200 concurrent requests over HTTP with an undici `Agent({ connections: 256 })`. Same "1 upstream read" assertion.
- **Cross-process variant (stretch):** two API app instances in the same test, sharing one Redis prefix, each firing 500 requests → still 1 upstream read (the Redis lease).
- **Failure variant:** fault `status_429` on the vendor GET → all 1,000 get `503 upstream_unavailable`, and the mock serves **1** request, not 1,000.

## Done when
- [ ] S6 and S7 plus the cache tests green, and every earlier scenario still green.
- [ ] `docker compose up`, then `pnpm fault vendor-change C100 V-0001 --name X --webhook-delay 40s`, followed by curl reads, shows the change once the webhook lands.
- [ ] Commit `step 08: read cache + webhooks`.

## Pitfalls
- Read the raw body for the HMAC *before* calling `c.req.json()`, then parse the same text with `JSON.parse`.
- Don't let a singleflight entry outlive its promise: delete it in `finally`, or failures get cached for good.
- **File descriptors.** 1,000 concurrent *HTTP* requests to an in-process server use about 2,000 file descriptors. WSL's default `ulimit -n` (often 1024) can't handle that, which is why S7's main assertion uses `app.request`. Note this in the test.
- `budget − max_read_lag` must stay positive for vendors and invoices under the scaled config. Assert it at startup.
