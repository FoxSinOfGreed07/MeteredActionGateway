# Decisions: recommended set (complete)

> **What this file is.** The full, consistent set of decisions the implementation plans are built on.
> Discussion status (what you've actually locked) lives in [`locked.md`](locked.md).
> If a locked decision ends up different from this file, don't edit code by hand. Write a change plan
> (see [`../plans/README.md` → Change process](../plans/README.md#change-process)).
>
> **Format.** As the challenge requires, each entry gives the **chosen** option, the **rejected** option and the
> **specific failure prevented**. The rejected option is always the *strongest rival*, never a strawman,
> because the reviewers will argue for it. Each entry also says why the remaining options lose, which
> trade-off we accept, the pushback we expect, and which plan step implements it.
>
> The final `DECISIONS.md` deliverable at the repo root is produced from this file in step 11
> (`plans/11-docs-review-prep.md`). It keeps the required fields and drops the rehearsal notes.

---

## Assumptions every decision rests on

| # | Assumption | Why it matters |
|---|---|---|
| S1 | An **ERP lane** is one ERP endpoint with its own rate limit. Each tenant maps to one lane plus a company code, and several tenants can share a lane (in the seed, three tenants share `sap-main`). | It defines what "per-ERP rate limit" and "fairness" mean (A4, A5). |
| S2 | The ERP has **no idempotency keys**. It stores a free-text `reference` on each payment and can look payments up by it, but it does **not** enforce that references are unique. | It decides which D1 options exist at all. It's realistic for SAP posting paths and Tally. |
| S3 | ERP reads can **lag** behind ERP writes (replica or index lag). Normal maximum lag is declared per lane (`max_read_lag_ms`, default 5 s). The review's "stale reads for 10 minutes" breaks this assumption, so the design must *detect* the break rather than assume it never happens. | D2, D5 |
| S4 | A lagging read view is a consistent snapshot as of some past moment: replicas apply commits in order. | The witness check in D2 |
| S5 | `pay_invoice` pays the **full open amount**; there are no partial payments. The agent sends the amount it believes is open, and a mismatch is a permanent validation error. | Scenarios 3 and 8 |
| S6 | ERP `503` means "not processed" (load-balancer or maintenance style). `500`/`502`/`504` mean "may have been processed". | A8 |
| S7 | Any number of `api` and `worker` processes may run, with all coordination in Postgres or Redis. The default compose file runs one of each. | D6, D7, D8 |
| S8 | Credits are integers. Money is integer minor units (paise), INR only. | Wallet maths with no floats |

---

## D1: How to guarantee the ERP write happens once

- **Chosen: our own dedupe table** (deduplication happens on our side, in two layers).
  1. **Requests.** `UNIQUE (tenant_id, idempotency_key)` on `actions`.
     - The client generates the key, one per intended action, and reuses it on every retry of that intent.
     - The tenant comes from the API credential, never from the request body.
     - Keys are kept forever.
     - A hash of the request body is stored next to the key, so the same key with a different body returns `422`.
  2. **Sends.** A compare-and-set `QUEUED → DISPATCHING` with a lease, committed *before* the HTTP call, so exactly one worker ever sends an action. Every ERP document carries our action id as its `reference`. Any later doubt is settled by looking up that reference (D2), never by resending blind.
- **Rejected: an idempotency key at the ERP.**
- **Failure prevented:** a double payment when the ERP has no dedupe (Tally, most SAP posting paths), or when its dedupe window has expired by the time we retry.
- **Why the other options lose:**
  - *Optimistic lock*: guards concurrent *different* writes to one object, not a repeat of the *same* write after a timeout. The object's version may not even look changed if the ERP's read is stale. (We do guard objects, but for Scenario 3; see A10.)
  - *Check then write* without ownership: a time-of-check/time-of-use race. Two actors both see "not found" and both write. We only ever check while holding the action's lease.
- **Trade-off accepted:** exactly-once logic lives with us (state machine plus reconciler) instead of being handed to the ERP, and every ambiguous outcome costs one extra lookup.
- **Pushback → answer:** *"Your table can't see what SAP did after a timeout; an ERP key can."*
  - Right, so the table never decides on its own after a timeout. The reference we stamp lets us ask SAP (D2).
  - We'd need our own table even if the ERP had keys: an ERP key can't stop a second wallet hold on a duplicate submit (Scenario 1), and it can't cover a crash between our record and the call (Constraint 4).
- **Implemented in:** step 04 (keys), step 06 (compare-and-set and lease), step 07 (lookup).

## D2: What to do when the ERP outcome is unknown after a timeout

- **Chosen: mark UNKNOWN and reconcile asynchronously.**
  - **What counts as ambiguous:** a timeout after sending, a connection reset, a 5xx other than 503, or a lease that expired after a crash.
  - **What happens:** the action moves to `UNKNOWN` and keeps its hold. A reconciler looks the payment up by reference.
    - **"Found" is trusted straight away** → `SUCCEEDED` and the hold is captured. A lagging view can be missing a write, but it can't invent one.
    - **"Not found" is trusted only when all four of these hold:**
      - (a) **Time:** `now ≥ unknown_since + request_timeout + max_read_lag`, so any abandoned request has had time to commit and to become visible.
      - (b) **Lane health:** no stale-read evidence on the lane in the last 15 minutes. This evidence lives in Postgres (`lane_health`), not Redis, because it protects money.
      - (c) **Witness:** if one of *our* payments that we know committed *after* the uncertain request could have committed exists, that payment must be visible in the same read view. If it isn't, the view is stale: we flag the lane and don't trust the "not found".
      - (d) **Confirmation:** two "not found" results, spaced apart.
    - **Only then** is the action re-dispatched with the **same reference**. After 3 ambiguous cycles it is failed and the hold released instead.
- **Rejected: query the ERP first** (inline, straight after the timeout, acting on whatever comes back).
- **Failure prevented:** a double payment, or a wrongful refund, caused by trusting a "not found" read too early: before an abandoned request finished committing, or from a lagging replica (the review's 10-minute stale-read window).
- **Why the other options lose:**
  - *Retry*: double-pays whenever the first attempt committed, which is exactly Scenario 2.
  - *Assume failure and refund*: gives the tenant a free action whenever the ERP did commit, and our ledger then disagrees with SAP.
- **Trade-off accepted:**
  - Credits stay held while an action is UNKNOWN, so the tenant sees a reduced `available` balance.
  - A "not found" takes at least ~10 s to resolve normally, and longer while the ERP is degraded. Slow and right beats fast and wrong.
- **Pushback → answer:** *"Querying immediately is faster."* We do query early, and an early "found" resolves at once. Only "not found" waits, because only "not found" can be wrong.
- **Implemented in:** step 06 (classifying an outcome into UNKNOWN), step 07 (resolver, trust rule, witness, lane health).

## D3: Where the wallet debit lives relative to the action

- **Chosen: two-phase hold and capture.**
  - Admission places a `HOLD` in the same transaction as the durable action record.
  - Confirmed success `CAPTURE`s an amount up to the hold, and any remainder is `RELEASE`d.
  - Confirmed non-execution `RELEASE`s the hold, with a reason.
  - `UNKNOWN` keeps the hold.
- **Rejected: debit first, then act** (refund on failure).
- **Failure prevented:** a ledger that can't tell resolved work from unresolved work.
  - With debit-first, an action stuck between "charged" and "refunded" looks identical to a finished one. A crash between the failure and the refund leaves a permanent overcharge that nothing can detect.
  - An UNKNOWN action also forces a charge-or-refund decision before anyone knows the outcome.
  - With holds, "reserved but unresolved" is its own state in the ledger. Reconciliation can then prove that every action settled exactly once: `HOLD → CAPTURE | RELEASE`.
- **Why the other options lose:**
  - *Act then debit*: the action runs before the money is checked. Two parallel 300-credit actions on a 500-credit wallet both execute, and the second debit either drives the balance negative or gets forgiven. This fails Scenario 4.
  - *Saga with compensation*: the compensating step for a posted SAP payment is a *reversal document*, which is a real accounting event, not an undo. Our wallet step is local anyway, so a saga adds orchestration without adding safety.
- **Trade-off accepted:** three entry kinds instead of one, and while actions are in flight the tenant sees `available` and `held` as separate figures.
- **Pushback → answer:** *"Debit-first is simpler, and refunds are rare."* Refunds happen on exactly the failure paths (timeouts, crashes) where steps get lost. Hold-and-capture also lets us charge less than we held: a classification cache hit captures 2 of the 20 credits held (A11).
- **Implemented in:** step 03 (ledger operations), steps 04, 06 and 07 (where settlement happens).

## D4: Cache for ERP reads

- **Chosen: read-through.** One `CachedReader` owns loading on a miss. No caller touches the ERP or Redis directly for reads. That gives one place to enforce the per-type staleness budget, coalescing (D6) and the sequence guard (D5).
- **Rejected: cache-aside.**
- **Failure prevented:** the "set after invalidate" race. A reader fetches the old vendor, the webhook deletes the cache entry, and then the reader writes the old value back. With cache-aside, every call site runs its own get/load/set and has to remember the guard. With read-through, every fill goes through one atomic, sequence-guarded script.
- **Why the other options lose:**
  - *Write-through*: only sees writes that pass through us. Scenario 6's change happens directly in SAP. Also, the ERP computes fields (status, open amount), so the value we'd write isn't the value SAP holds.
  - *No cache plus a short-lived coalescer*: only protects requests that arrive at the same moment, not repeated ones. Every read spends an ERP rate-limit token that payments need, because reads and writes share the same SAP limit.
- **Trade-off accepted:** call sites get less flexibility, and a bug in the cache layer affects every read.
- **Pushback → answer:** *"Cache-aside is the industry default."* It is, where staleness doesn't matter. Here staleness is a stated contract, and a contract belongs in one place.
- **Implemented in:** step 08.

## D5: How cached invoice data is invalidated

- **Chosen: webhook-driven invalidation with sequence numbers.**
  - Every ERP object carries a per-object `seq` that only ever increases.
  - The gateway keeps a **high-water mark (HWM)** for each object: the highest `seq` it knows exists. It learns this from webhooks and from our own write responses. (A payment response returns the invoice's new `seq`, so "delete on write" becomes simply "raise the HWM".)
  - A cached value is served only if its `seq ≥ HWM`.
  - A fill is stored only if its `seq ≥ HWM` and `≥` the stored `seq`.
  - For webhooks that never arrive, a TTL of `budget − max_read_lag` is the backstop.
- **Rejected: TTL only.**
- **Failure prevented:**
  1. **Serving data we've been told is wrong.** With TTL only, the old vendor keeps being served after the late webhook arrives, until the TTL expires.
  2. **Cache rollback.** A duplicate or out-of-order webhook, or a fill that started before the change, writes an older version over a newer one.
  3. **Caching a stale ERP read** (`seq < HWM`) during a lag window. Each such rejection is also recorded as stale-read evidence for D2.
- **Why the other options lose:**
  - *Delete on write*: can't see changes made in SAP through other channels, and still loses the race against a fill already in flight.
  - *Versioned keys*: you need the current version to build the key, which means a lookup on every read (and the HWM *is* that lookup). Old versions also pile up as garbage, and it doesn't stop a stale fill.
- **Trade-off accepted:** this relies on the ERP emitting per-object sequence numbers (SAP: change pointers or ETags; Tally: alter IDs). Any object type an ERP can't sequence falls back to TTL only, with a correspondingly short budget.
- **Pushback → answer:** *"Webhooks get lost, so you need TTL anyway."* Yes, which is why TTL is derived from the budget. Webhooks let us invalidate sooner than the budget requires; TTL turns the budget into a guarantee.
- **Implemented in:** step 08 (and step 06 for own-write HWM bumps).

### Staleness budgets (declared)

The **budget** is the longest any value may be served after the ERP write that made it wrong. TTL = budget − `max_read_lag` (5 s), because a fill can already be up to `max_read_lag` old when it lands.

| Object type | Budget | Cache TTL | Invalidated by | Why this number |
|---|---|---|---|---|
| Vendor master | **60 s** | 55 s | webhook seq; TTL backstop | Changes rarely. Scenario 6's 40 s-late webhook fits inside the budget. Payments never rely on cached vendor data, because the ERP validates them. |
| Invoice | **15 s** | 10 s | our own payment response seq + webhook seq; TTL backstop | Status flips when the invoice is paid, and agents decide based on it. Double payment is prevented by the conflict index and the ERP, not by the cache. |
| Payment lookup by reference | **0, never cached** | — | — | Reconciliation must see the ERP itself. |
| Classification result | **Unbounded** | none | n/a: immutable, and the key includes model and prompt version | Content-addressed. A new prompt version means a new key. |

## D6: Protection against cache stampede on a hot vendor

- **Chosen: request coalescing (single-flight).**
  - Inside each process, a map of loads in flight, one per key.
  - Across processes, a short Redis lease (`SET NX PX`), so only one process loads.
  - Everyone else waits up to 3 s for the fill, then reads from the cache.
- **Rejected: stale-while-revalidate.**
- **Failure prevented:** 1,000 simultaneous misses at expiry turning into 1,000 ERP reads. That burns the lane's rate budget and triggers 429s, which stall the payments queued behind them. The cache exists to protect write capacity.
- **Why the other options lose:**
  - *A bare lock per key*: waiters get no hand-off of the result, so they poll, spin or fail. A crashed lock holder blocks everyone until the lock expires. Coalescing is a per-key lock *plus* result sharing.
  - *Probabilistic early refresh*: lowers the odds of a herd but doesn't guarantee one upstream read. At 1,000 concurrent requests, several will still refresh together. It also needs an estimate of how long a refresh takes.
- **Trade-off accepted:** at expiry, waiters wait for one ERP read. If that read fails, every waiter gets a `503`, because we don't serve a value beyond its budget.
- **Pushback → answer:** *"SWR gives better latency."*
  - SWR serves values past their TTL. To keep the budget promise, the TTL would have to shrink by the revalidation window.
  - The revalidation itself still needs coalescing, so SWR is an add-on to coalescing, not a replacement.
  - It could be added later as long as it stays within budget.
- **Implemented in:** step 08.

## D7: Concurrency control on a tenant's wallet

- **Chosen: an atomic conditional update on a wallet projection row.**
  - The statement: `UPDATE wallets SET available = available - $c, held = held + $c WHERE tenant_id = $t AND available >= $c RETURNING …`.
  - It runs in the same transaction as the `HOLD` ledger row and the action record.
  - `CHECK (available >= 0)` backs it up at the database level.
- **Rejected: `SELECT … FOR UPDATE`.**
- **Failure prevented:** the Scenario 4 race. With 500 credits, two 300-credit holds both read 500 and the wallet ends at −100. With a conditional update, the check and the write are one statement, so no code path can read the balance and forget to lock.
- **Why the other options lose:**
  - *Redis lock*: the lock can expire during a garbage-collection pause or network stall while the holder is still writing, leaving two holders. The lock also isn't part of the Postgres transaction: you can release the lock and then fail the commit, or the other way round.
  - *Single-writer queue per tenant*: makes admission asynchronous, but Scenario 4 needs the rejection at hold time, in the submit response. It also lines up all of a tenant's submits behind one consumer.
- **The "derived balance" tension:**
  - The `wallets` row is a *projection*: the sum of ledger deltas, stored for O(1) checks and as the one row everyone serializes on.
  - It's updated in the same transaction as every ledger row.
  - Reconciliation proves `projection == SUM(ledger)`. If the two ever disagree, the ledger wins and the projection is rebuilt.
- **Trade-off accepted:** one hot row per tenant. Each hold holds that row only for a single statement, which is fine at throughput bounded by the ERP.
- **Pushback → answer:** *"FOR UPDATE is explicit and flexible."* It holds the row lock across round trips to the application. With 4,000 submits from one tenant, those round trips queue up one after another. Its correctness also depends on every code path remembering `FOR UPDATE`.
- **Implemented in:** step 03.

## D8: Queue choice for action execution

- **Chosen: a Postgres-backed queue, where the `actions` table *is* the queue.**
  - Enqueuing is the insert inside the admission transaction (the same transaction as the record and the hold).
  - Workers claim with `FOR UPDATE SKIP LOCKED` plus a lease, picking tenants round-robin within each lane.
- **Rejected: BullMQ.**
- **Failure prevented:**
  - **The dual-write gap.** With BullMQ, the record and the hold commit in Postgres but the job is added to Redis separately. A crash in between leaves either credits held for an action nothing will ever run, or a job with no durable record.
  - **Unfairness.** Open-source BullMQ is first-in-first-out per queue (round-robin across groups is a paid BullMQ Pro feature), so tenant A's 4,900 jobs would run before tenant B's 100.
- **Why the other options lose:**
  - *Kafka*: its strength, ordering within a partition, is something we don't need. Its weaknesses hurt us: a message retrying on 429 blocks its whole partition, there's no per-message delay, and it's heavy to run on a laptop. Replaying *commands* (payments) is dangerous anyway.
  - *SQS*: doesn't run locally without an emulator, can't replay after a message is deleted, and its visibility timeout plays the role of our lease without access to our transaction.
- **The doc's three criteria:**
  - **Ordering:** not needed. Actions are independent, and the only case where order matters (two payments on one invoice) is ruled out by the conflict index (A10).
  - **Retry:** `next_attempt_at` plus a per-lane cooldown. There is **no attempt cap** for outcomes that were definitely not committed, so no action is ever lost.
  - **Replay:** the `actions` and `action_events` tables are the history. Re-driving an action means moving it back to `QUEUED`, only from states where that's safe.
- **Trade-off accepted:** about 200 lines of claim/lease/backoff code that we own; polling (200 ms when idle) instead of push; and queue churn on Postgres.
- **Principle:** *Redis holds nothing whose loss could lose an action or money.* Losing Redis loses cache entries, rate-limit tokens and coalescing leases. The system gets slower, never wrong. (This is also why compose runs Redis with persistence turned off.)
- **Pushback → answer:**
  - *"You hand-rolled a queue."* The queue is the state column we write on every transition anyway, and claiming is one indexed statement. The hard part, deciding what a job that crashed mid-call means, isn't something BullMQ solves either.
  - *"Postgres doesn't scale as a queue."* Throughput is capped by ERP rate limits (tens to hundreds per second per lane), far below what Postgres `SKIP LOCKED` can do. Step 11 measures the actual number.
- **Implemented in:** step 06.

---

## Additional decisions (not named in the doc, but required)

Same format. A1–A3 are foundations. A4–A8 are execution. A9–A12 are admission and money. A13–A17 are the remaining pieces.

### A1: Language, framework and datastores
- **Chosen:** Node 24 LTS, TypeScript (strict), Hono with `@hono/node-server`, and zod for validation. Postgres 17 is the system of record; Redis 7 holds ephemeral coordination and the cache.
- **Rejected:** NestJS or Express on the same runtime.
- **Failure prevented:** spending hours of a 48-hour budget on framework ceremony (NestJS modules and decorators) instead of correctness. Express lacks a typed, fetch-standard request model that Hono gives for free (Hono's `app.request()` also makes in-process tests trivial).
- **Trade-off accepted:** Hono's ecosystem is smaller than Express's.

### A2: Database access layer
- **Chosen:** **Kysely** (a typed SQL query builder) over `pg`, with migrations as plain `.sql` files run by a small migration runner. Database tables and columns use snake_case and are mapped 1:1 (no camelCase plugin), so the TypeScript reads like the SQL.
- **Rejected:** **Prisma.**
- **Failure prevented:**
  - The SQL that makes this system correct (the conditional wallet update, the fair `SKIP LOCKED` claim, the partial unique conflict index, the append-only and transition triggers) ending up either hidden behind ORM abstractions or in untyped raw-SQL escape hatches.
  - ORM-style read-modify-write (`find` then `update`) quietly reintroducing the wallet race.
- **Why the other options lose:**
  - *Drizzle* is a close second: typed, and supports `.for('update', { skipLocked: true })` and partial indexes. It loses because its schema-first migrations push triggers into custom SQL anyway, and Kysely's builder maps to SQL more directly for a reviewer.
  - *Raw `postgres.js`*: the SQL is maximally visible, but there's no compile-time column checking, and an implementer working autonomously benefits from types.
- **Trade-off accepted:** a hand-maintained `Database` TypeScript interface that must match the migrations. A test checks the two agree.

### A3: Process topology
- **Chosen:** one codebase producing three processes: `api` (HTTP intake, reads, webhooks, ops), `worker` (dispatchers, recovery, reconciler) and `mock-erp` (a separate service). In tests, all three run inside the test process.
- **Rejected:** a single process doing everything.
- **Failure prevented:** a dispatch backlog or a crash in the dispatcher taking the submit API down with it. The crash-recovery demo also needs to kill the worker without killing the API.
- **Trade-off accepted:** one more container, and shared code needs clean module boundaries.

### A4: ERP topology and where limits live
- **Chosen:** rate limit, in-flight cap, cooldown and health all belong to the **lane** (one ERP endpoint). Tenants map to lanes, and several tenants can share one. Lanes are isolated from each other.
- **Rejected:** one global limiter for all outbound calls.
- **Failure prevented:** one ERP's 429 storm stopping traffic to every other ERP. (The other extreme, a limiter per tenant only, would let tenants sharing an ERP quota collectively exceed it.)
- **Trade-off accepted:** lanes are configuration data (the `lanes` table) that someone has to maintain.

### A5: Fairness across tenants
- **Chosen:** **round-robin** among tenants with ready work in a lane. Each claim picks the tenant dispatched least recently (`lane_tenant_cursor`), then that tenant's oldest ready action.
- **Rejected:** first-in-first-out.
- **Failure prevented:** tenant B's 100 actions waiting behind tenant A's 4,900 (Scenario 5).
- **Why the other options lose:**
  - *Weighted fair queuing by plan tier*: there are no tiers to weight by.
  - *A per-tenant concurrency cap*: wastes capacity when only one tenant is active.
- **Trade-off accepted:** one extra `DISTINCT` per claim, and fairness is per claim, not weighted by cost.

### A6: Rate-limiting algorithm and 429 behaviour
- **Chosen:**
  - A Redis **token bucket** per lane (a Lua script using Redis's own clock), set to the lane's configured rate and burst.
  - On a `429`: a lane **cooldown** that honours `Retry-After`, otherwise exponential backoff from 1 s up to 30 s with jitter.
  - Then a single **probe** request (half-open) before full traffic resumes.
- **Rejected:** an in-process limiter in each worker.
- **Failure prevented:** N worker processes each sending at the full limit (N× the ERP's quota), and, during a 429 window, every worker hammering the ERP. Scenario 5's "backs off" is checked by counting the 429s the mock actually served.
- **Why the other options lose:**
  - *Fixed-window counters*: allow bursts at window edges, which trigger 429s.
  - *Only reacting to 429s*: means a steady stream of 429s.
- **Trade-off accepted:** a Redis round trip per send. If Redis is lost, the bucket simply refills, which is safe.

### A7: Backpressure at admission
- **Chosen:** a per-tenant cap on pending actions (`QUEUED + DISPATCHING + UNKNOWN`, default 10,000). Above the cap, submit returns `429` with `Retry-After`, and the request is **not** persisted.
- **Rejected:** an unbounded queue.
- **Failure prevented:** one tenant's runaway agent filling the database and locking all its credits into an endless backlog. "No action lost" still holds, because a refused action was never accepted.
- **Trade-off accepted:** it's a soft cap. Two concurrent submits can overshoot it by a handful.

### A8: ERP outcome taxonomy
- **Chosen: a conservative taxonomy.**
  - **Retryable:** only failures that provably happened *before* commit: `429`, `503`, and connection-phase errors (connection refused, DNS failure, connect timeout).
  - **Permanent:** every other `4xx`.
  - **Ambiguous → UNKNOWN:** everything else, i.e. read timeouts, socket resets, `500`/`502`/`504` and any unclassified error.
- **Rejected:** treating timeouts and `5xx` as retryable.
- **Failure prevented:** a double payment from retrying a request that had already committed.
- **Trade-off accepted:** some actions that were never committed still go through an UNKNOWN round trip, costing one lookup.

### A9: Which submit outcomes are stored for replay
- **Chosen:**
  - **Stored as `REJECTED` and replayed byte-for-byte:** business rejections, i.e. `402 insufficient_credits` and `409 conflict_active_action`.
  - **Not stored:** malformed requests (`400`), key misuse (`422`) and backpressure (`429`).
  - **Replays:** use the stored status and body, plus an `Idempotent-Replayed: true` header. A database trigger makes the stored response immutable.
- **Rejected:** never storing rejections.
- **Failure prevented:** the same key producing two different outcomes (`402` now, `202` after a top-up). An agent that saw the first response couldn't tell which one happened, so "identical responses" would be false.
- **Trade-off accepted:** after a `402`, an agent has to use a new key to try again.

### A10: Same-object conflicts (Scenario 3)
- **Chosen:**
  - Each action type declares a **conflict key** taken from its payload (`pay_invoice` → `invoice:<id>`).
  - A **partial unique index** over the non-final states (`QUEUED`, `DISPATCHING`, `UNKNOWN`) allows only one active action per key. The second submit gets `409` with the current state of the active action.
  - **UNKNOWN is deliberately included:** if the first payment *might* have gone through, a second one can't start.
  - Once the first finishes, the ERP's own "already paid" check is the backstop. The action goes to FAILED, the hold is released and the current invoice state is returned.
- **Rejected:** relying on the ERP's check alone.
- **Failure prevented:** two payments in flight for one invoice when the ERP's own check races or reads stale data. With UNKNOWN included, the "maybe paid" window is covered.
- **Trade-off accepted:** a second agent is refused even if the first payment later fails. It has to resubmit.

### A11: What is metered and at what price
- **Chosen:**
  - Only **actions** are metered; reads are free.
  - `pay_invoice`: hold 300, capture 300.
  - `classify_invoice_line`: hold 20, capture 20 on a cache miss or **2 on a cache hit** (the remaining 18 is released).
- **Rejected:** metering reads.
- **Failure prevented:** write amplification on the ledger (Scenario 7 alone would write 1,000 ledger rows), and charging tenants for refreshes the gateway does for its own reasons.
- **Trade-off accepted:** reads cost us ERP budget that we don't bill for.

### A12: Hold lifetime
- **Chosen:**
  - Holds **never** expire on their own while the action might have executed (`DISPATCHING` or `UNKNOWN`).
  - `QUEUED` actions that were never sent expire after 24 h → `FAILED`, with the hold released.
  - An `UNKNOWN` older than 15 min raises an alert in the logs and on `/v1/ops/queue`.
- **Rejected:** a TTL on every hold that releases it automatically.
- **Failure prevented:** a free action when an UNKNOWN payment had in fact committed. The ledger and SAP would then disagree, and nothing would flag it.
- **Trade-off accepted:** credits can stay held for a long time during an ERP outage. That's visible and alerted, never silent.

### A13: LLM classification cache key
- **Chosen:**
  - The key is `sha256(canonical_json({tenant_id, task, schema_version, normalized_input, model, prompt_version}))`.
  - Results are stored in Postgres (`classification_cache`). The first writer wins, and a result never changes once written.
  - Normalization means: trim, collapse whitespace, Unicode NFC. Case is preserved.
- **Rejected:** keying on content only and recording model and prompt version alongside the result.
- **Failure prevented:** a prompt or model upgrade silently never taking effect for content already seen, or (if the cache were cleared) the same line switching category with no record of why.
- **Why it's scoped per tenant:** a cache shared across tenants leaks information (a hit tells you another tenant classified the same text), and tenants may use different taxonomies.
- **Trade-off accepted:** a lower hit rate, and every version bump starts cold.

### A14: Which LLM backs the classifier
- **Chosen:** a **deterministic fake classifier** (keyword rules, model id `fake-keyword-v1`) by default and in all tests. A **Claude adapter** switches on when `ANTHROPIC_API_KEY` is set.
  - It uses `LLM_MODEL`, default `claude-opus-5`, at `effort: low`, with zod structured output, and the SDK's own retries switched off so the lane owns retries.
  - There's no `temperature` knob on current models, so determinism comes from the cache, not the sampler.
  - Picking a cheaper model is a cost/quality call left to you, via one env var.
- **Rejected:** requiring a real LLM.
- **Failure prevented:** tests that are non-deterministic, cost money and depend on the network. The challenge's constraint is about the *boundary* (cache key and version recording), and that boundary is identical for both providers.
- **Trade-off accepted:** the default demo shows rule-based categories, not model output.

### A15: Controlling time in tests
- **Chosen:** every duration is a config value. Scenario tests scale the doc's numbers by `SCENARIO_TIME_SCALE` (default `0.1`: 90 s becomes 9 s, 40 s becomes 4 s). `pnpm test:realtime` runs the exact numbers.
- **Rejected:** fake timers (`vi.useFakeTimers`).
- **Failure prevented:** tests that pass on a fake Node clock while Postgres `now()`, Redis `TIME` and the mock ERP keep real time. Leases, TTLs and backoffs would then disagree with each other, giving false greens or deadlocks.
- **Trade-off accepted:** scenario tests take real seconds (about 2–3 minutes in total at the default scale).

### A16: State machine enforcement and audit
- **Chosen:**
  - Every state change goes through `transition()`, which does a compare-and-set on the current state and writes an `action_events` row in the same transaction.
  - A database trigger rejects illegal transitions and changes to immutable columns.
  - `action_events` is append-only.
- **Rejected:** a bare `state` column updated freely.
- **Failure prevented:** an illegal transition (for example `FAILED → SUCCEEDED` after a release) slipping through some code path. The event log also lets us show exactly how an action reached its state, which the review walkthrough needs.
- **Trade-off accepted:** one extra insert per transition.

### A17: Webhook authenticity (stretch)
- **Chosen:** HMAC-SHA256 of the raw body with a secret per lane, sent in `X-Erp-Signature: sha256=<hex>`. Verified when the lane has a secret configured.
- **Rejected:** unauthenticated webhooks.
- **Failure prevented:** a forged webhook with a huge `seq` raising the high-water mark so that every later fill looks stale. That would turn all reads into `503`s, a denial of service.
- **Trade-off accepted:** secrets have to be managed. This is the first thing to cut if time runs short; the README will state the risk.
