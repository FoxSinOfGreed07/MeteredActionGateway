# Review prep (45 minutes)

Rehearsal notes for you, not a deliverable. The four parts of the review, in order, with what to run and what
to say. Rehearse out loud at least once with the stack running.

```bash
docker compose down -v && docker compose up --build -d   # fresh stack: seeded tenants, mock ERP, api, worker
pnpm install                                             # for the host-side scripts
```

---

## Part 1: walk one action end-to-end with a forced timeout after commit

**Run:** `pnpm demo:timeout`. It arms `timeout_after_commit`, pays an OPEN invoice as acme, and prints each
transition as it happens.

| Printed line | What to say |
|---|---|
| `∅ → QUEUED (submitted)` | One transaction wrote three things: the durable action record, the `HOLD` ledger row (with the wallet projection's conditional update, D7), and the "enqueue". The QUEUED row *is* the queue entry (D8). A crash leaves all three or none. The idempotency key is unique per tenant, so a retry of this request would replay this exact response. |
| `QUEUED → DISPATCHING (claimed)` | A worker won a compare-and-set under `FOR UPDATE SKIP LOCKED`, picking the least-recently-served tenant first, and **committed** a lease *before* calling SAP. That committed row is Constraint 4's "durable record before the ERP call". |
| `DISPATCHING → UNKNOWN (ambiguous:timeout)` | SAP didn't answer within 5 s. A timeout can't tell "never received" from "committed, then the connection died", so the taxonomy (A8) calls it ambiguous. We keep the hold, **don't retry** (that could double-pay) and **don't refund** (that could hand out a free action). |
| `SAP primary has 1 payment … it DID commit` / `ledger now: HOLD 300` | This is the scenario: SAP has the money movement, we have only a hold. Nothing is wrong yet, because nothing irreversible has happened on our side. |
| `UNKNOWN → SUCCEEDED (reconciled:found)` | The reconciler holds the action's lease (so no other actor can race it), looks the payment up **by reference** (our action id, stamped on the SAP document), finds it, and captures. "Found" is strong evidence: a lagging view can miss a write but can't invent one. |
| `HOLD 300 → CAPTURE 300`, `ERP POSTs: 1` | Effectively once: the attempt happened once and the effect landed once. The ledger proves the settlement: `wallets == SUM(ledger)`, and every action is HOLD → CAPTURE or RELEASE. |

**If they ask for the not-committed path:** `pnpm fault drop-before-commit`, then submit with curl (or run the demo with that fault).
- The action goes UNKNOWN, and early lookups say "not found" but are *too early* to trust.
- After `timeout + max lag` (10 s) and two confirmations, with no stale evidence and a visible witness, it's re-sent with the **same reference**.
- Result: 2 POSTs, 1 payment.

**If they ask about a crash:** `docker compose kill worker` mid-call, then `docker compose start worker`.
- Recovery moves the expired DISPATCHING lease to UNKNOWN (never a blind resend), then reconciliation resolves it.
- The `x-crash-recovery` test proves both orders: crash before the call, and crash after SAP committed.

---

## Part 2: defend two decisions (they'll argue for the rejected option)

For each decision: our choice in one sentence, the rival's three best arguments with answers, and when we'd switch.

### D8: Postgres queue (rejected: BullMQ)
**Ours:** the actions table is the queue, so record + hold + enqueue are one transaction.
1. *"You hand-rolled a queue; BullMQ is battle-tested."* The "queue" is a state column we write on every transition anyway, and a claim is one indexed `SKIP LOCKED` statement. The genuinely hard part, what a job that crashed mid-call means, BullMQ doesn't solve: its stalled-job re-run would double-pay unless the handler checks Postgres. We'd write that logic either way.
2. *"You already run Redis, so BullMQ is free."* Running it is free; trusting it with money isn't. With BullMQ, Redis becomes correctness-critical (AOF fsync, failover), and you need an outbox plus a relay to close the dual-write gap. Here, losing Redis only makes us slower.
3. *"Postgres doesn't scale as a queue."* Throughput is capped by ERP rate limits (tens to hundreds per second per lane). Measured: claim+settle runs at **X/s** on a laptop (see Part 4). Fairness is an `ORDER BY`; in BullMQ it's a paid Pro feature.

**We'd switch** for jobs with no money attached and no transactional record (notifications, webhook fan-out), or at throughput far beyond what any ERP accepts.

### D2: mark UNKNOWN and reconcile (rejected: query the ERP first)
**Ours:** park in UNKNOWN, keep the hold, look up asynchronously, and trust "not found" only with proof of freshness.
1. *"Querying immediately is faster."* We do query early, and an early "found" resolves at once. Only "not found" waits, because only "not found" can be wrong: the abandoned request may still commit (the `x-abandoned-commit` test), or the replica may lag.
2. *"Your time window is a guess."* Yes, which is why time is only rule (a). Rules (b) and (c) **detect** staleness instead of assuming the lag bound: stale evidence from the cache's sequence guard, and a witness payment we know committed that must be visible.
3. *"Holds sit for a while."* That's the trade-off we accept: credits stay reserved while the outcome is unknown. They're visible on the wallet as `held`, and alerts fire after 15 minutes. The alternatives are a double payment or a free action.

**We'd switch** if the ERP offered real idempotency keys with a long retention window, or a consistent-read endpoint (then rules (b) and (c) collapse into one strong read).

### D7: conditional update (rejected: SELECT … FOR UPDATE)
1. *"FOR UPDATE is explicit."* It's a read-check-write across round trips while holding the row lock, so correctness depends on every code path remembering it. Ours is one statement (the conditional `UPDATE` and the `HOLD` insert in a single CTE), and `CHECK (available >= 0)` backs it at the database level.
2. *"But balances should be derived."* They are: the row is a projection maintained in the same transaction, `verifyWallets()` proves it equals `SUM(ledger)`, and if they ever disagree the ledger wins (`rebuildWalletProjection`).
3. *"Hot row."* Measured at ~330 submits/s for one tenant, ~1,250/s across tenants, bound by the commit fsync under the row lock. That's far above what one tenant's ERP lane accepts (50/s).

### D1: own dedupe (rejected: idempotency key at the ERP)
1. *"The ERP key sees what SAP did after a timeout."* Our table never decides after a timeout; the stamped reference lets us ask SAP.
2. *"Less code."* We'd need our table anyway, for duplicate submits (one hold, identical responses) and for crashes between our record and the call. Tally has no keys, and ERP keys expire.
3. *"Check-then-write is what your reconciler does."* Only while holding the lease, so there's no second writer in the gap. The remaining risk, a *stale* check, is D2's job.

### D3: hold and capture (rejected: debit first, refund on failure)
1. *"Simpler."* Simpler until a crash lands between failure and refund: then an overcharge exists that nothing can detect. Holds make "unresolved" its own visible state, and the ledger proves every action settled exactly once.
2. *"Refunds are rare."* They happen precisely on the failure paths (timeouts, crashes) where steps get lost.
3. Hold-and-capture also allows charging less than we held: a classification cache hit captures 2 of the 20 held.

---

## Part 3: "the ERP returns stale reads for 10 minutes" (said live)

**Run:** `pnpm fault stale-reads --lag 10m --duration 10m`.

- **Cache:**
  - Every ERP object carries a sequence number, and we keep a high-water mark per object from webhooks and our own writes. A fill older than the HWM is **rejected** (Lua), so the cache never rolls back, and the read returns `503 upstream_stale` rather than old data.
  - Each rejection is recorded as stale-read evidence on the lane (Postgres `lane_health`).
  - **What breaks:** an object we hold *no* HWM for can be refilled from the stale view, so its effective staleness is lag + TTL, which exceeds the declared budget. Say that plainly.
  - **Mitigation (a one-line change in `ttlFor`):** while the lane is stale-suspected, set TTL to 0 or bypass the cache. `/v1/ops/queue` shows `stale_suspected_until`.
- **Wallet:** no refunds and no double charges.
  - Holds on UNKNOWN actions stay held for longer, so tenants see reduced `available`.
  - New submissions still work: writes go to SAP's primary, and SAP's "already paid" check runs there, so a stale "OPEN" read can't cause a double payment either. The conflict index blocks a second in-flight payment, UNKNOWN included.
- **Reconciliation:**
  - "Not found" becomes **untrusted**. The witness check fails (a payment we know committed is invisible in the view), so the lane is quarantined for 15 minutes, and so are cache rejections.
  - UNKNOWN actions wait; "found" still resolves immediately. Alerts fire on UNKNOWN older than 15 minutes.
  - When the window ends and the quarantine expires, the next lookups find the payments.
  - Proof: `test/scenarios/x-stale-window.test.ts`.
- **What I'd add next:** adaptive `max_read_lag` per lane, learned from witness and HWM evidence instead of declared.

---

## Part 4: "when should this gateway be a single Postgres table and no Redis?" (answer with a number)

**Run:** `pnpm bench:pg` (with the local docker Postgres and Redis up). The measured table:

BENCH_TABLE_PLACEHOLDER

**Answer template:**
- Redis is never needed for **correctness** here. It holds cache entries, rate-limit tokens and coalescing leases, nothing whose loss loses money.
- Postgres alone is enough while all of these hold:
  - **sustained actions < ~Q/s**: half the measured claim+settle ceiling
  - **cached reads < ~R/s**: half the measured Postgres primary-key read rate, leaving room for the write path
  - a **single dispatcher per lane** is acceptable, so the token bucket can live in-process or in a Postgres row
- Each ERP lane accepts 50 req/s, so below ~Q/50 saturated lanes the ERP, not our infrastructure, is the bottleneck.
- Above that, or with many API processes needing a shared limiter and sub-millisecond reads, Redis earns its place.

---

## Likely follow-ups (one line each)

- **Why not Kafka?** Per-partition ordering we don't need; a 429 blocks the whole partition; no per-message delay; replaying *commands* (payments) is dangerous.
- **Redis dies?** Cache misses and limiter fail-closed: slower, never wrong. Holds, actions and stale evidence are all in Postgres. After a Redis restart HWMs are gone, so for a while the budget relies on TTL alone (a documented cut).
- **Postgres fails over mid-transaction?** The transaction aborts: either the admission happened or it didn't. A DISPATCHING lease on the old primary is recovered as UNKNOWN, then reconciled.
- **10 ERP lanes / 1,000 tenants?** One dispatcher per lane, so lanes are isolated. The fairness query is a `DISTINCT` over the ready-index; at 1,000 tenants, move to a per-tenant queued-count table.
- **The agent never retries?** It doesn't need to: an accepted action is durable and will reach a final state. It polls `GET /v1/actions/:id`.
- **Webhook lost forever?** The TTL backstop keeps staleness within budget (S6 test).
- **"Exactly once"?** Effectively once: attempts may repeat, but the effect lands once (dedupe + single-sender CAS + lookup-before-resend). True exactly-once delivery over a network is impossible.
- **503 retryable, 504 ambiguous?** A 503 is a refusal before processing. A 504 is a gateway that gave up while the upstream may still be committing.
- **Why store 402s?** One key, one outcome. Otherwise the same key returns 402 now and 202 after a top-up, and an agent can't tell which happened.
- **Partial payments?** Out of scope by decision. The payload carries the amount the agent believes is open, and SAP rejects a mismatch.
- **SAP's reference field is 16 characters (XBLNR)?** We send a 36-character UUID. A real connector would map it to a 16-character derived reference with a collision check.
