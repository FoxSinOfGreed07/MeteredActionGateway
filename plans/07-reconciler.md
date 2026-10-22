# Step 07: Reconciler, failure injection, demo (the UNKNOWN path)

- **Goal:** settle every UNKNOWN action without ever paying twice or refunding something that happened.
  - Look the payment up by reference. A "found" is trusted at once.
  - A "not found" is trusted only when the ERP's read view is proven fresh enough. A stale view is detected using our own committed payments as **witnesses**.
  - Prove the wallet and the settlements are consistent.
  - Ship the failure-injection script, the reconciliation run and the end-to-end demo the review walks through.
- **Depends on:** 06.
- **Decisions applied:** D2 (UNKNOWN + async reconcile + trust rule), D1 (check only under ownership), A12 (UNKNOWN never auto-releases), I8.
- **Estimate:** ~3 h.
- **Contract:** `00-architecture.md` §5 (`lane_health`, the UNKNOWN columns), §6, §12 (`reconciler.*`).

## Deliverables
- `src/gateway/reconcile/lane-health.ts`: `isStaleSuspected(db, lane)`, `reportStaleEvidence(db, lane, evidence)` (throttled)
- `src/gateway/reconcile/witness.ts`: `checkWitness(ctx, action, lane) → 'fresh' | 'stale' | 'none'`
- `src/gateway/reconcile/trust.ts`: `canTrustNotFound(ctx, action, lane) → { trusted: boolean; why: string; retryAt?: Date }`
- `src/gateway/reconcile/resolver.ts`: `resolveUnknown(ctx, action)` plus the `Reconciler` loop (claim UNKNOWNs with a lease)
- `src/gateway/reconcile/invariants.ts`: wraps `verifyWallets` + `verifySettlements` and adds `checkErpDuplicates` (stretch)
- `src/gateway/reconcile/run-once.ts`: `reconcileOnce(ctx, { force }) → ReconcileReport`
- `POST /v1/ops/reconcile`; `GET /v1/ops/queue` now fills `stale_suspected_until`
- `scripts/inject-fault.ts`, `scripts/reconcile.ts`, `scripts/demo-timeout.ts`
- The worker starts the reconciler loop
- Scenario tests: `s2-timeout-after-commit.test.ts`, `x-crash-recovery.test.ts`, `x-abandoned-commit.test.ts`, `x-stale-window.test.ts`

## Algorithm

### Claiming UNKNOWN actions (a lease, without changing state)
```sql
WITH due AS (
  SELECT id FROM actions
   WHERE state = 'UNKNOWN' AND next_reconcile_at <= now()
     AND (lease_until IS NULL OR lease_until < now())
   ORDER BY next_reconcile_at
   FOR UPDATE SKIP LOCKED
   LIMIT $batch)
UPDATE actions a SET lease_owner = $owner, lease_until = now() + interval '30 seconds',
                     reconcile_attempts = reconcile_attempts + 1, updated_at = now()
  FROM due WHERE a.id = due.id RETURNING a.*;
```
The `UNKNOWN → *` transitions are fenced with `leaseOwner`, which makes this resolver the sole owner of the
check-then-act (D1: "check only under ownership"). `force: true` (used by the script and the ops endpoint)
ignores `next_reconcile_at` but **never** ignores the trust rule.

### `resolveUnknown(ctx, action)` for ERP lanes
1. **Get a token.** `rateLimiter.acquire(lane, 2000)` and check the cooldown. If either says no, reschedule (`next_reconcile_at = now() + backoff`), release the lease and return.
2. **Look up.** `payments = connector.findPaymentsByReference(cc, action.id)`.
   - **On `ErpReadError`:** reschedule with `fullJitter(expBackoff(reconcile_attempts, backoffBaseMs, backoffMaxMs))`. For `rate_limited`, also call `cooldown.trip`.
3. **`payments.length ≥ 1` (found).**
   - `markSucceeded(action, { from: ['UNKNOWN'], via: 'reconcile', reason: 'reconciled:found', result: { payment: payments[0] }, leaseOwner })`.
   - `cacheHooks.onInvoiceChanged(lane, cc, invoiceId, null)`.
   - If `length > 1`, log at error level `erp.duplicate_payment_detected` with the references and put them in the result. This must never happen. If it does, surface it rather than hide it.
4. **`payments.length === 0` (not found).** Call `t = canTrustNotFound(…)`.
   - **Not trusted:** update `not_found_count = 0`, `next_reconcile_at = t.retryAt ?? now() + confirmGapMs`, release the lease and log `reconcile.not_found_untrusted {why}`.
   - **Trusted:** set `not_found_count += 1`.
     - If `not_found_count < 2`: `next_reconcile_at = now() + confirmGapMs` (second confirmation, rule d).
     - Otherwise, if `ambiguous_count >= maxAmbiguous`: `markFailed(action, from ['UNKNOWN'], code 'erp_outcome_not_found', message 'not found after N ambiguous attempts')`, which releases the hold.
     - Otherwise: `transition(UNKNOWN → QUEUED, reason 'reconciled:not_found_redispatch', patch { next_attempt_at: now(), not_found_count: 0, lease cleared })`. The dispatcher re-sends with the **same reference**.

LLM-lane actions never enter UNKNOWN (step 09). If one does (a bug), log an error and requeue it.

### Trust rule: `canTrustNotFound`, in this order (D2)
| Rule | Check | If it fails |
|---|---|---|
| (a) time | `now() ≥ action.trust_not_found_after` | `{trusted:false, why:'too_early', retryAt: trust_not_found_after}` |
| (b) lane health | `lane_health.stale_suspected_until` is null or in the past | `{trusted:false, why:'lane_stale_suspected', retryAt: min(stale_suspected_until, now()+backoffMaxMs)}` |
| (c) witness | `checkWitness()` returns `'fresh'` or `'none'` | `'stale'` → `reportStaleEvidence(lane, {kind:'witness_missing', witness_action_id, reference})` → `{trusted:false, why:'witness_not_visible'}` |
| (d) confirmation | handled by the caller (`not_found_count ≥ 2`) | — |

**Witness (`witness.ts`).** A *witness* is one of our own payments, confirmed by a synchronous 2xx, that was
dispatched **after** the uncertain action could still have been committing. Its commit is therefore later than
any commit of the uncertain one. Because replicas apply commits in order (S4), a read view that shows the
witness would also show the uncertain payment, if it existed.

```sql
SELECT a.id, t.erp_company_code AS cc FROM actions a JOIN tenants t ON t.id = a.tenant_id
 WHERE a.lane_id = $lane AND a.state = 'SUCCEEDED' AND a.confirmed_via = 'response'
   AND a.dispatched_at > $action.trust_not_found_after - ($lane.max_read_lag_ms || ' ms')::interval
                       -- i.e. > unknown_since + request_timeout: after the uncertain request's latest commit
 ORDER BY a.dispatched_at ASC
 LIMIT 1;
```
- **No row:** `'none'`. Fall back to rules (a), (b) and (d).
- **A row:** `findPaymentsByReference(cc, witness.id)`, which costs one token. Found → `'fresh'`. Not found → `'stale'`.
- Cache the result per lane for `confirmGapMs`, so a batch of UNKNOWNs doesn't spend one lookup each.

**Lane health (`lane-health.ts`).** `reportStaleEvidence` upserts
`lane_health SET stale_suspected_until = now() + staleQuarantineMs, last_evidence = $json`. Skip the write if the
current `stale_suspected_until` is already more than `staleQuarantineMs / 2` in the future, so hot evidence
sources don't hammer the database. Step 08's cache adds a second evidence source: fills rejected because
`seq < HWM`.

### Invariants and report (`run-once.ts`)
`reconcileOnce(ctx, {force})`:
1. Run one resolver pass over every due UNKNOWN action (or all of them with `force`).
2. Run `verifyWallets` and `verifySettlements`.
3. List UNKNOWNs older than `unknownAlertAfterMs`.

It returns:
```json
{ "resolved": [ { "action_id", "from": "UNKNOWN", "to": "SUCCEEDED|QUEUED|FAILED", "why" } ],
  "still_unknown": [ { "action_id", "why": "too_early|lane_stale_suspected|witness_not_visible|lookup_error" } ],
  "wallet_drift": [], "settlement_violations": [], "unknown_alerts": [] }
```
`POST /v1/ops/reconcile` returns this report. `scripts/reconcile.ts` prints it as tables and exits non-zero
if there is drift or a violation.

## Scripts

**`scripts/inject-fault.ts`** (uses `MOCK_ERP_URL` and `src/mock-erp/admin-client.ts`)
```
pnpm fault timeout-after-commit [--count 1] [--hang 30s]
pnpm fault drop-after-commit    [--count 1]
pnpm fault 500-after-commit     [--count 1]
pnpm fault drop-before-commit   [--count 1]
pnpm fault 429  --duration 90s [--retry-after 0]
pnpm fault 503  [--prob 0.3] [--duration 60s]
pnpm fault latency --ms 2000 [--count N]
pnpm fault stale-reads --lag 10m --duration 10m
pnpm fault list | clear
pnpm fault vendor-change C100 V-0001 --name "New Name" [--webhook-delay 40s]
```
Durations accept `ms`, `s` and `m`. The script prints the created rule and the current fault list.

**`scripts/demo-timeout.ts`** is the review walkthrough. It runs against the compose stack, using `GATEWAY_URL` and `MOCK_ERP_URL`:
1. Print acme's wallet.
2. `fault timeout-after-commit --count 1 --hang 30s`.
3. Pick an OPEN invoice from the mock (admin) and submit `pay_invoice` (print the 202 body).
4. Poll `GET /v1/actions/:id` every 250 ms and print each **new** event as it appears: `QUEUED → DISPATCHING → UNKNOWN (ambiguous:timeout)`.
5. Show the mock's primary payments for the reference: **1 payment exists**, so the ERP did commit. Show the ledger: only `HOLD 300`, no refund and no retry.
6. Wait for the reconciler (or call `POST /v1/ops/reconcile` with `force` after `trust_not_found_after`) and print `UNKNOWN → SUCCEEDED (reconciled:found)` plus the ledger `HOLD 300, CAPTURE 300`.
7. Print the mock's `payment_posts_received` delta: **1**.
8. Print the final wallet and `verifySettlements = []`.

Use colour if stdout is a TTY. The full run should take under 20 s with default timings.

## Tests (`test/scenarios/`)

**S2: `s2-timeout-after-commit.test.ts`**
> *Finance user: SAP commits the payment, then the connection drops before the response → the action is marked UNKNOWN; the gateway queries SAP by reference before any refund or retry; no double payment.*
- **Main case:** fault `timeout_after_commit` (`count: 1`, `hang_ms: T(30000)`), lane timeout `T(5000)`.
  - It reaches UNKNOWN with reason `ambiguous:timeout`.
  - At that moment: posts = 1, primary payments = 1, ledger = `[HOLD]` only, no RELEASE.
  - Then SUCCEEDED via `reconciled:found`, ledger `[HOLD, CAPTURE]`, and posts **still 1**.
  - The event sequence is exactly `submitted, claimed, ambiguous:timeout, reconciled:found`.
- **Variants:** `drop_after_commit` and `error_500_after_commit`, with the same assertions (reasons `ambiguous:connection_reset` and `ambiguous:http_5xx`).
- **Not committed:** `drop_before_commit` (`count: 1`).
  - UNKNOWN, then early lookups return not-found but `too_early`.
  - After the trust window and two confirmations: `UNKNOWN → QUEUED (reconciled:not_found_redispatch)` → SUCCEEDED.
  - Posts = 2, primary payments = 1, ledger `[HOLD, CAPTURE]`.

**`x-abandoned-commit.test.ts`**
> *An abandoned request commits after our timeout. Trusting an early "not found" would double-pay.*
- Fault `latency` `T(8000)` (`count: 1`) on POST, lane timeout `T(5000)`, `max_read_lag_ms` `T(5000)`.
- The client times out at 5 s → UNKNOWN, with `trust_not_found_after` ≈ +10 s.
- The mock commits at 8 s.
- The reconciler's first lookup (at about 6 s) sees not-found → `too_early`.
- The lookup at or after 10 s finds it → SUCCEEDED.
- Assert posts = 1 and primary payments = 1.

**`x-crash-recovery.test.ts`** (Constraint 4)
- **(a) Crash between record and call:**
  1. Submit with the worker stopped.
  2. Call `claimNext` by hand with lease `T(1000)` and don't send (simulating a crash right after the durable DISPATCHING commit).
  3. Start the worker.
  Expected: the recovery tick → UNKNOWN (`lease_expired`) → not-found trusted after the window and two confirmations → QUEUED → SUCCEEDED. Posts = 1, payments = 1.
- **(b) Crash after the ERP committed:**
  1. Fault `timeout_after_commit` with a long hang.
  2. Stop the worker abruptly while the call is in flight (`worker.stop({ abandon: true })` skips waiting for in-flight runs and drops their results).
  3. Restart the worker.
  Expected: recovery → UNKNOWN → found → SUCCEEDED. Posts = 1.
- Both cases end with `verifySettlements` = [].

**`x-stale-window.test.ts`** (the review twist)
> *The ERP serves stale reads for a 10-minute window while an UNKNOWN is pending: no refund, no retry, until the view is provably fresh.*
1. Fault `stale_reads` with `lag_ms: T(600000)` and `duration_ms: T(600000)`, matching `GET` only. Writes still hit the primary.
2. Fault `timeout_after_commit` (`count: 1`). Submit payment P, which goes UNKNOWN.
3. Wait until `now > P.unknown_since + request_timeout` (a witness must be dispatched *after* P's latest possible commit), then submit 3 more payments on other invoices. They succeed via response, so they become witnesses.
4. Wait past `trust_not_found_after` and run the reconciler. P's lookup is not-found (stale view), and the witness lookup is not-found too:
   - `witness_not_visible`
   - `lane_health.stale_suspected_until` is set
   - P is still UNKNOWN, with posts = 1 for P and no RELEASE rows
5. `GET /v1/ops/queue` shows `stale_suspected_until`.
6. Remove the stale fault, then clear `lane_health` through a test helper (in the real system the quarantine expires on its own). The reconciler then finds P → SUCCEEDED.
7. Assert primary payments for P's invoice = 1.
- **Sub-case without a witness:** set `lane_health` stale by hand and leave no SUCCEEDED actions on the lane. Even after the time window, P stays UNKNOWN (`lane_stale_suspected`).

## Done when
- [ ] All the scenario tests above green, with S1, S3, S5 and S8 still green.
- [ ] `docker compose up`, then `pnpm demo:timeout`, prints the full walkthrough ending in `SUCCEEDED`, `HOLD 300 → CAPTURE 300` and 1 ERP post.
- [ ] `pnpm reconcile` prints a clean report (exit 0) on a healthy stack.
- [ ] Commit `step 07: reconciler + failure injection`.

## Pitfalls
- The resolver must never call `postPayment`. Re-sending only happens by moving the action back to `QUEUED`, so the normal claim path (CAS, lease, rate limit) applies.
- Release the reconciler's lease on every path that doesn't transition (use `finally`). Otherwise an UNKNOWN action stays invisible for 30 s.
- Witness lookups spend rate-limit tokens. Cache the per-lane verdict briefly, as specified.
