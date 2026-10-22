# Step 06: Dispatcher, rate limiter, settlement, recovery (the Postgres queue)

- **Goal:** execute QUEUED actions exactly once against the ERP:
  - claim fairly across tenants (`SKIP LOCKED` + lease)
  - respect the per-lane rate limit
  - back off on 429 with a single probe
  - settle the wallet in the same transaction as each state transition, fenced by lease ownership
  - turn expired leases into UNKNOWN on restart
  - expose queue depth

  Ships the `worker` process and Scenarios 1, 3, 5 and 8 end to end.
- **Depends on:** 03, 04, 05.
- **Decisions applied:** D8 (Postgres queue), D1 (CAS to DISPATCHING; fencing), D3 (settlement), A4 (lane-scoped limits), A5 (round-robin fairness), A6 (token bucket + cooldown + probe), A8 (acting on outcome kinds), A12 (expiry of never-sent QUEUED actions).
- **Estimate:** ~4 h.
- **Contract:** `00-architecture.md` §5, §6, §10, §11 (`rl`, `cool`, `cool429`, `probe`), §12 (config).

## Deliverables
- `src/gateway/dispatch/lanes.ts`: `loadLanes(db)`, `getLane(id)` (cached; reloaded every 30 s)
- `src/redis/lua/token_bucket.lua`, `src/redis/lua/cooldown_extend.lua`
- `src/gateway/dispatch/rate-limiter.ts`: `acquire(lane, maxWaitMs) → boolean`, `tryAcquire(lane) → waitMs`
- `src/gateway/dispatch/cooldown.ts`: `state(lane)`, `trip(lane, retryAfterMs?)`, `onSuccess(lane)`, `acquireProbe(lane, owner)`, `releaseProbe(lane)`
- `src/gateway/dispatch/claim.ts`: `claimNext(ctx, lane, owner) → ActionRow | null`
- `src/gateway/dispatch/settle.ts`: `markSucceeded`, `markFailed`, `requeueRetryable`, `markUnknown`, all single-transaction and all fenced
- `src/gateway/dispatch/executors/index.ts` (`executors[type]`) and `executors/pay-invoice.ts`
- `src/gateway/dispatch/dispatcher.ts`: one `LaneDispatcher` per lane
- `src/gateway/dispatch/recovery.ts`: the expired-lease sweep
- `src/gateway/dispatch/expiry.ts`: QUEUED older than `queuedMaxAgeMs` → FAILED
- `src/gateway/cache/hooks.ts`: `CacheHooks { onInvoiceChanged(laneId, cc, invoiceId, seq|null) }` with a **no-op** default (step 08 implements it)
- `src/gateway/worker-main.ts`: real worker (`startWorker(ctx) → { stop() }`, exported for tests)
- `src/gateway/api/routes/ops.ts`: `GET /v1/ops/queue`
- `test/kit/stack.ts`: `worker: true` option wired to `startWorker`
- Scenario tests `test/scenarios/s1-duplicate-submit.test.ts`, `s3-concurrent-invoice.test.ts`, `s5-rate-limit-storm.test.ts`, `s8-permanent-failure.test.ts`; integration tests listed below

## Algorithms

### Rate limiter (A6)
- **`token_bucket.lua`** (KEYS[1] = bucket; ARGV = rate_per_sec, burst):
  ```lua
  local rate = tonumber(ARGV[1]); local burst = tonumber(ARGV[2])
  local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
  local tokens = tonumber(b[1]); local ts = tonumber(b[2])
  if tokens == nil then tokens = burst; ts = now end
  tokens = math.min(burst, tokens + (now - ts) * rate / 1000)
  local wait = 0
  if tokens >= 1 then tokens = tokens - 1 else wait = math.ceil((1 - tokens) * 1000 / rate) end
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', KEYS[1], 60000)
  return wait
  ```
- **`acquire(lane, maxWaitMs)`:** loop `tryAcquire`. If wait is 0, return true. If the accumulated wait would exceed `maxWaitMs`, return false. Otherwise sleep for the returned wait.
- **Redis down:** fail *closed* for sends (return false and log). Losing Redis makes the system slower, never wrong.

### Cooldown and probe (A6)
- **`trip(lane, retryAfterMs?)`:**
  1. `n = INCR cool429` (`EXPIRE 300`).
  2. `delay = retryAfterMs ?? fullJitter(expBackoff(n, cooldown.baseMs, cooldown.maxMs))`.
  3. `cooldown_extend(cool, now + delay)`, which only ever extends.
- **`state(lane)`** → `{ active: PTTL(cool) > 0, remainingMs, consecutive429: GET cool429, probeMode: !active && consecutive429 > 0 }`.
- **`acquireProbe(lane, owner)`** = `SET probe owner NX PX 2*request_timeout`. **`releaseProbe(lane)`** = `DEL probe`.
- **`onSuccess(lane)`** = `DEL cool429 probe`. It runs after any committed or permanent response, because the ERP answered.
- **The dispatcher's job:** while cooldown is active, don't claim. In probe mode, only the holder of the probe lock may send, and everyone else waits.

### Fair claim (D8 + A5): `claim.ts`
In one transaction:
```sql
-- 1) the least-recently-dispatched tenant that has ready work on this lane
SELECT t.tenant_id
  FROM (SELECT DISTINCT tenant_id FROM actions
         WHERE lane_id = $lane AND state = 'QUEUED' AND next_attempt_at <= now()) t
  LEFT JOIN lane_tenant_cursor c ON c.lane_id = $lane AND c.tenant_id = t.tenant_id
 ORDER BY c.last_dispatched_at ASC NULLS FIRST, t.tenant_id
 LIMIT 1;

-- 2) that tenant's oldest ready action; skip rows other workers hold
WITH picked AS (
  SELECT id FROM actions
   WHERE lane_id = $lane AND tenant_id = $tenant AND state = 'QUEUED' AND next_attempt_at <= now()
   ORDER BY next_attempt_at, created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1)
UPDATE actions a
   SET state = 'DISPATCHING', lease_owner = $owner,
       lease_until = now() + ($leaseMs || ' milliseconds')::interval,
       dispatched_at = now(), dispatch_count = dispatch_count + 1, updated_at = now()
  FROM picked WHERE a.id = picked.id
RETURNING a.*;

-- 3) advance the fairness cursor
INSERT INTO lane_tenant_cursor (lane_id, tenant_id, last_dispatched_at) VALUES ($lane, $tenant, now())
ON CONFLICT (lane_id, tenant_id) DO UPDATE SET last_dispatched_at = EXCLUDED.last_dispatched_at;

-- 4) action_events: QUEUED -> DISPATCHING 'claimed'
```
- If step 2 returns no row (another worker took the tenant's last ready action), retry from step 1 up to 3 times, then return `null`.
- This must go through the same guarded path as `transition()`. Either add a `claim` variant in `state-machine.ts` that takes the SQL above, or express it as `transition()` with `from: ['QUEUED']` after selecting with `FOR UPDATE SKIP LOCKED` inside the same transaction. Either way, the event row gets written.
- **This committed row is the durable "about to call the ERP" record (Constraint 4).** The HTTP call happens only after the commit.

### LaneDispatcher loop (`dispatcher.ts`)
```
inFlight = 0; sem = maxInFlight
loop until stopped:
  cd = cooldown.state(lane)
  if cd.active: sleep(min(cd.remainingMs, 1000)); continue
  probing = false
  if cd.probeMode:
     if !(await cooldown.acquireProbe(lane, owner)): sleep(100); continue
     probing = true
  await sem.acquire()                               // in-flight cap per lane
  if !(await rateLimiter.acquire(lane, tokenWaitMaxMs)): sem.release(); if probing releaseProbe; continue
  action = await claimNext(ctx, lane, owner)
  if !action: sem.release(); if probing releaseProbe; sleep(idlePollMs); continue
  run(action).finally(() => { sem.release(); if probing releaseProbe })   // NOT awaited (concurrency)
                                                    // probe mode: sem effectively 1, because the others wait on the probe lock
```
- `stop()` sets `stopped`, waits up to 10 s for in-flight runs, then returns. Anything still DISPATCHING is left for recovery (lease expiry). **Never** settle on shutdown.
- A worker runs one `LaneDispatcher` per lane in `loadLanes()`, plus the recovery and expiry loops. The step 07 reconciler loop is added later.

### Executor: `pay_invoice` (`executors/pay-invoice.ts`)
```
outcome = connector.postPayment({ companyCode: tenant.erp_company_code, invoiceId, amountMinor, currency,
                                   reference: action.id })
switch outcome.kind:
  committed  → settle.markSucceeded(action, { result: outcome.value, via: 'response', leaseOwner: owner })
                 if CAS lost (lease expired and recovery moved it to UNKNOWN):
                   settle.markSucceeded(action, { from: ['UNKNOWN'], reason: 'late_response:committed', no leaseOwner })
                   (strong evidence; if that CAS also loses, the action is already settled → log only)
               cooldown.onSuccess(lane)
               cacheHooks.onInvoiceChanged(lane, cc, invoiceId, outcome.value.invoice.seq)  // after commit, best-effort
  retryable  → settle.requeueRetryable(action, outcome, leaseOwner)
               if reason === 'rate_limited': cooldown.trip(lane, outcome.retryAfterMs)
  permanent  → settle.markFailed(action, { code: outcome.code, message, details }, leaseOwner)
               cooldown.onSuccess(lane)
               // Scenario 3b: details.invoice (status PAID) → stored in action.result as `current_state`
  ambiguous  → settle.markUnknown(action, outcome.reason, leaseOwner)
```
Executors receive `{ ctx, action, tenant, lane, owner, connector }` and return nothing. Throwing is a bug:
catch it at the dispatcher, log it, and **do not settle**. The lease expires, the action goes to UNKNOWN, and
reconciliation resolves it. That's the safe default.

### Settlement (`settle.ts`): one transaction each, using `transition()` + `ledger.ts`
One signature set, used by steps 06, 07 and 09:
```ts
markSucceeded(ctx, action, o: { result: unknown; via: 'response' | 'reconcile'; reason: string;
                                capture?: number;            // default: price.capture_amount
                                from?: ActionState[];        // default ['DISPATCHING']
                                leaseOwner?: string }): Promise<ActionRow | null>
markFailed(ctx, action, o: { code: string; message: string; details?: unknown; reason: string;
                             from?: ActionState[]; leaseOwner?: string }): Promise<ActionRow | null>
requeueRetryable(ctx, action, o: { reason: string; delayMs: number; leaseOwner?: string;
                                   from?: ActionState[] /* default ['DISPATCHING'] */;
                                   countRetry?: boolean /* default true */ }): Promise<ActionRow | null>
markUnknown(ctx, action, o: { reason: string; leaseOwner: string }): Promise<ActionRow | null>
// each returns null when the CAS is lost: nothing was written, the caller logs settle.cas_lost
```
| Function | Transition | Patch | Ledger |
|---|---|---|---|
| `markSucceeded` | `DISPATCHING → SUCCEEDED` (fenced) or `UNKNOWN → SUCCEEDED` | `result`, `captured_amount`, `confirmed_via` | `settleSuccess(action, capture)`: capture = price `capture_amount` (or the cache-hit amount in step 09) |
| `markFailed` | `DISPATCHING → FAILED` (fenced), `QUEUED → FAILED` (expiry) or `UNKNOWN → FAILED` (step 07) | `failure_code`, `failure_message`, `result: { current_state: details?.invoice ?? null }` | `settleFailure(action, code, message)` |
| `requeueRetryable` | `DISPATCHING → QUEUED` (fenced) | `retry_count + 1`, `next_attempt_at = now() + delay`, `lease_owner/lease_until = NULL` | none |
| `markUnknown` | `DISPATCHING → UNKNOWN` (fenced) | `ambiguous_count + 1`, `unknown_since = now()`, `trust_not_found_after = now() + (request_timeout_ms + max_read_lag_ms)`, `next_reconcile_at = now() + firstLookupDelayMs`, `not_found_count = 0`, lease cleared | none (the hold is kept) |

- **Requeue delay:** for `rate_limited`, `max(retryAfterMs ?? 0, cooldown remaining)`. For `unavailable`/`unreachable`, `fullJitter(expBackoff(retry_count+1, retry.baseMs, retry.maxMs))`.
- **No attempt cap:** not-committed retries never fail an action (no action lost). Only expiry (24 h) does, via `expiry.ts`.
- **Fencing:** if the transition returns `null`, roll back and write no ledger rows. The caller logs `settle.cas_lost` with the action id. A lost CAS means someone else (recovery or the reconciler) now owns the outcome.

### Recovery (`recovery.ts`): runs at worker start and every `recovery.intervalMs`
```sql
-- ERP lanes: an expired lease means a call MAY have gone out → UNKNOWN (never resend)
UPDATE actions a
   SET state = 'UNKNOWN', unknown_since = a.lease_until,
       trust_not_found_after = a.lease_until + ((l.request_timeout_ms + l.max_read_lag_ms) || ' milliseconds')::interval,
       next_reconcile_at = now(), ambiguous_count = a.ambiguous_count + 1, not_found_count = 0,
       lease_owner = NULL, lease_until = NULL, updated_at = now()
  FROM lanes l
 WHERE a.lane_id = l.id AND l.kind = 'erp' AND a.state = 'DISPATCHING' AND a.lease_until < now()
RETURNING a.id;
-- + action_events rows ('lease_expired'), in the same statement via a CTE, or a follow-up INSERT … SELECT in the same tx
-- LLM lane: DISPATCHING with an expired lease → QUEUED ('lease_expired_requeue'): no external side effect
```
`unknown_since = lease_until` is conservative. A send could have started at any moment up to `lease_until`,
so the trust window counts from there (D2 rule (a)).

### Expiry (`expiry.ts`), every 60 s
QUEUED actions whose `created_at < now() − queuedMaxAgeMs` → `markFailed` (`QUEUED → FAILED`,
code `expired_unsent`). This is safe: QUEUED means never sent, or confirmed not-found then requeued.

### Ops endpoint: `GET /v1/ops/queue`
Build the QueueReport from §8:
- Depth by state per lane, and by tenant: `GROUP BY lane_id, tenant_id, state WHERE state IN (…non-final…)`.
- `ready` = QUEUED with `next_attempt_at <= now()`.
- `oldest_queued_age_ms`.
- Cooldown state per lane, from `cooldown.state`.
- `stale_suspected_until` from `lane_health` (null until step 07).
- `unknown_alerts` = UNKNOWN with `unknown_since < now() − unknownAlertAfterMs`.

The worker also logs a one-line `queue.depth` summary every 5 s, which is handy in the demo.

## Tests

### Integration (`test/integration/dispatcher.test.ts`)
- **Happy path:** submit → SUCCEEDED; events `submitted → claimed → erp_committed`; HOLD + CAPTURE; `verifySettlements` = [].
- **503 twice, then OK** (`status_503`, `count: 2`): SUCCEEDED, `retry_count = 2`, mock payments for the reference = 1, `payment_posts_received = 3`.
- **Fencing:** latency fault 1,500 ms on POST, lease 1,000 ms, timeout 2,000 ms. *For this test only, make `lease_ms < request_timeout_ms` by creating the lane with raw SQL and dropping the CHECK in this test database, or (simpler) unit-test `markSucceeded` directly:* set the row to UNKNOWN by hand mid-flight, then call `markSucceeded` with the stale owner. Expect null, then the `UNKNOWN → SUCCEEDED` path, and a single CAPTURE.
- **Multi-worker, no double send:** two `startWorker` instances on the same stack, 300 submits → all SUCCEEDED, `payments_created = 300`, every reference exactly once.
- **Recovery:** claim an action manually (`claimNext` with a 50 ms lease) and never send. After the recovery tick, it's UNKNOWN with `unknown_since = lease_until` and event `lease_expired`. Step 07 tests the resolution.
- **Cooldown:** `status_429` for 1 s → `cooldown.state.active` becomes true; no claims happen during it (`dispatch_count` stays flat); once it expires, exactly one probe goes out before others.

### Scenario tests (`test/scenarios/`, one file each, header comment = the one-line statement)
Use `startStack({ mockErp: {}, worker: true, lanes: [...] })` with durations scaled by `T()`.

**S1: `s1-duplicate-submit.test.ts`**
> *Tenant admin: the same action submitted twice with the same key, 200 ms apart → one ERP write, one debit, identical responses.*
- Mock `latency` 500 ms on `POST */payments`, so the first is still in flight when the second arrives.
- Submit, wait 200 ms, submit again with the same key and body.
- Assert:
  - both `202`, with deep-equal bodies
  - the second has `Idempotent-Replayed: true`
  - the action reaches SUCCEEDED
  - mock `payment_posts_received = 1` and primary payments for the reference = 1
  - ledger for the action is exactly `[HOLD 300, CAPTURE 300]`
  - wallet down by exactly 300

**S3: `s3-concurrent-invoice.test.ts`**
> *Tenant admin: two agents pay the same invoice concurrently → exactly one succeeds; the other receives a conflict with the current state.*
- Two keys, the same invoice, `Promise.all`. Assert:
  - one `202` → SUCCEEDED
  - one `409 conflict_active_action` with `details.active_action.id` = the winner, and state `REJECTED` with no ledger rows
  - mock payments for the invoice = 1
- **Variant (after completion):** a third agent submits after the winner is SUCCEEDED. It's accepted (`202`), then the ERP answers `409 INVOICE_ALREADY_PAID`. Assert:
  - FAILED, with `failure.code = 'INVOICE_ALREADY_PAID'` and `result.current_state.status = 'PAID'`
  - HOLD + RELEASE, net zero
  - still 1 payment

**S8: `s8-permanent-failure.test.ts`**
> *Tenant: the action fails permanently (validation error) after the hold was placed → hold released; ledger shows hold, release and reason; no net charge.*
- Submit `pay_invoice` with `amount_minor` = open + 1. Assert:
  - FAILED, `failure.code = 'AMOUNT_MISMATCH'`
  - ledger `[HOLD 300, RELEASE 300]`, with the RELEASE reason containing `AMOUNT_MISMATCH`
  - wallet equal to its pre-submit value
  - `payment_posts_received = 1` (no retry) and `payments_created = 0`

**S5: `s5-rate-limit-storm.test.ts`**
> *Ops: SAP returns 429 for 90 s during a burst of 5,000 actions → the rate limiter backs off, queue depth is visible, no action is lost, and fairness across tenants holds.*
- **Setup:**
  - Lane: `rate_per_sec: 200`, `burst: 50`, `max_in_flight: 32`; cooldown base `T(1000)`, max `T(30000)`.
  - Mock: `rate_limit_rps: 2000` (not the bottleneck).
  - Tenants A (C100, 4,000 invoices), B (C200, 500), C (C300, 500), each with enough credits (`count × 300`). Create the invoices with the admin bulk endpoint, amount 100000.
  - Fault `status_429` on `POST */payments` with `duration_ms: T(90000)` and `retry_after_s: 0` (forces our own backoff), created **before** submitting.
- **Submit:** all of A's 4,000 first, then B's 500, then C's 500 (the worst case for FIFO), via `stack.api.request` with 50 concurrent submitters. All must return `202`.
- **During the outage** (poll `GET /v1/ops/queue` at T(45 s)):
  - `lanes[0].depth.QUEUED ≥ 4,800`
  - `cooldown.active || cooldown.probe_mode` is true
- **After it:** wait for all 5,000 to reach SUCCEEDED (timeout = `T(90000)` + 60 s).
- **No action lost:**
  - mock `payments_created = 5,000`
  - every action's reference appears exactly once (`GET /__admin/companies/:cc/payments` and count by reference)
  - no invoice has 2 payments
  - 5,000 HOLD and 5,000 CAPTURE rows, no RELEASE
- **Backs off:** mock `rate_limited_429 ≤ 150`. A client that didn't back off would produce thousands.
- **Fairness:** rank all 5,000 by `completed_at`; B's and C's maximum rank must be `≤ 1,800`. Round-robin over three tenants finishes B and C after about 1,500 dispatches; FIFO would put them after 4,000.
- **Ledger:** `verifyWallets` = [] and `verifySettlements` = [].

## Done when
- [ ] Integration tests and S1, S3, S5 and S8 green at `SCENARIO_TIME_SCALE=0.1`.
- [ ] `docker compose up`: submitting via curl leads to SUCCEEDED within about 1 s, `GET /v1/ops/queue` works, and the worker logs `queue.depth`.
- [ ] Commit `step 06: dispatcher`.

## Pitfalls
- `now()` inside a transaction is the transaction start time. That's fine for claims, but don't hold claim transactions open across the HTTP call. Claim, **commit**, then call.
- `FOR UPDATE SKIP LOCKED` together with `DISTINCT` in the same query is invalid. That's why the tenant pick (step 1) is a separate, lock-free query.
- `fullJitter` must not produce 0 ms (busy loop). Clamp it to at least 50 ms.
- The S5 submission of 5,000 requests has to be throttled (50 concurrent), or the test runner exhausts its file descriptors (see 08's note on `ulimit`).
- Probe-mode deadlock: always release the probe lock in `finally`, and give it a PX TTL so a crashed prober can't block the lane.
