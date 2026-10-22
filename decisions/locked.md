# Decisions: locked (discussion tracker)

> **What this file is.** Only the decisions we have actually discussed and agreed, in the challenge's format.
> Everything else is `TBD`, with a pointer to the recommendation in [`recommended.md`](recommended.md) and the
> questions still open. Use this file to pick up the one-decision-at-a-time discussion where it stopped.
>
> **Status tags**
> - `LOCKED`: agreed. Code may depend on it.
> - `DISCUSSING`: options laid out, no agreement yet.
> - `TBD`: not started. The recommendation in `recommended.md` is what the plans currently build on.
>
> **When a decision gets locked:** copy the agreed text here. If it differs from `recommended.md`, update
> `recommended.md` too, and add an entry to `../plans/PROGRESS.md` → *Decision changes*. A change-plan agent
> then writes `plans/changes/NN-<decision>.md` (see `../plans/README.md` → Change process).

Last updated: 2026-10-22

---

## Where we stopped

Discussion order (each decision narrows the next ones):

1. ~~D1: exactly-once ownership~~ → **LOCKED**
2. **D8: queue** → `DISCUSSING` (pros and cons presented; waiting on your reply)
3. DB access layer (A2) → `DISCUSSING` (you want Prisma and Drizzle argued properly)
4. D2: unknown outcome and reconciler → `TBD` (stale "not found" introduced while discussing D1)
5. D3 + D7: debit placement and wallet concurrency → `TBD`
6. Action state machine → `TBD` (`DISPATCHING` introduced and accepted as part of D1)
7. Intake semantics (A7, A9) → `TBD` (partly covered by D1)
8. Rate limiter and fairness (A4, A5, A6) → `TBD`
9. D4 / D5 / D6 and the staleness budget numbers → `TBD`
10. LLM step (A13, A14), test harness and time control (A15) → `TBD`

---

## Foundations

### F1: Language, framework, datastores · `LOCKED` (partially)
- **Locked:** Node.js + TypeScript + Hono. Postgres is the system of record (needed for the ledger). Redis is available for caching.
- **Still open:** whether Redis does anything beyond caching. This depends on D8: BullMQ would make Redis critical to correctness; a Postgres queue would keep it to cache, rate limiting and coalescing.
- **Recommendation:** `recommended.md` → A1.

### A2: Database access layer · `DISCUSSING`
- **Options:** raw SQL (`postgres.js`), Kysely, Prisma, Drizzle.
- **Where we are:** you're open to Postgres with raw SQL or Kysely, but want Prisma and Drizzle argued properly first, because this will be questioned in the review.
- **Recommendation:** Kysely; rejected Prisma (`recommended.md` → A2).
- **Open questions for the discussion:**
  - How much of the critical SQL would end up raw in Prisma: the `SKIP LOCKED` fair claim, the partial unique index, the triggers, and the conditional update with `RETURNING`?
  - Drizzle vs Kysely for review readability.
  - Typed queries vs maximum SQL visibility for an implementer working autonomously.

---

## D1: How to guarantee the ERP write happens once · `LOCKED`

- **Chosen:** our own dedupe table, in two layers.
  1. **Requests:** `UNIQUE (tenant_id, idempotency_key)` on `actions`.
  2. **Sends:** a compare-and-set `QUEUED → DISPATCHING` with a lease, committed before the ERP call, so exactly one worker sends. Our action id is stamped on the ERP document as its `reference`, and any later doubt is settled by looking it up (D2), never by a blind resend.
- **Rejected:** an idempotency key at the ERP.
- **Failure prevented:** a double payment when the ERP has no dedupe, or its dedupe window has expired.
- **Why we own it** (your argument, which you'll lead with):
  - Tenants can be on different ERPs or switch between them, and not every ERP supports idempotency keys. Any ERP without them would force architecture changes on our side anyway, so we build it on our side for all of them from day one.
  - Even with ERP keys we'd still need our own table: an ERP key can't stop a duplicate submit from placing a second wallet hold (Scenario 1), and it can't cover a crash between our record and the call (Constraint 4).
  - ERP keys expire after a retention window.
- **Why the others lose:**
  - *Optimistic lock* guards concurrent *different* writes, not a repeat of the same write.
  - *Check-then-write* without ownership is a time-of-check/time-of-use race (example below).
- **Pushbacks rehearsed:**
  - *"Your table can't see what SAP did after a timeout."* → It doesn't need to. The stamped reference lets us ask SAP (D2).
  - *"You rejected check-then-write, but your reconciler checks and then writes."* → Our reconciler only checks while it owns the action's lease, so there is never a second writer in the gap. The remaining risk is a *stale* check, which belongs to D2.
  - *"Why not check before every first send?"* → A brand-new reference can't already exist. A check would cost an ERP rate-limit token per action. Payments made through other channels are caught by the ERP's "already paid" rule.
- **The check-then-write race, for reference:**
  ```
  t0  Worker A:  GET  /payments?ref=act_1   → not found
  t1  Worker B:  GET  /payments?ref=act_1   → not found
  t2  Worker A:  POST /payments ref=act_1   → created
  t3  Worker B:  POST /payments ref=act_1   → created   ← paid twice
  ```

### Sub-decisions locked together with D1

| Item | Locked decision |
|---|---|
| Who generates the idempotency key | **The client**: one UUID per intended action, reused on every retry of that intent. A server-generated key can't help a client that never received the response. |
| Key scope and lifetime | Unique per `(tenant_id, key)`, with the tenant taken from the API credential, never the body. Keys are kept forever. |
| Body hash | `payload_hash` is stored next to the key. It's a *check*, not the key: same key with a different body returns **422**. (A body hash as the key would wrongly merge separate intents and miss retries whose body changed slightly.) |
| Concurrent same-key submits | The second `INSERT` waits on the unique index, then **replays the first response**. There is no "in progress" error. |
| Security framing | The idempotency key is not a security control. It protects a client from its *own* accidental duplicates. A new key means a new intent. The security property is *scope*: tenant B can't use tenant A's keys. |
| `DISPATCHING` state | Accepted: a compare-and-set with a lease, committed before the ERP call. If a lease expires (a crash), the action goes to `UNKNOWN` and is looked up, never resent. ERP HTTP timeout < lease. |
| Same invoice, different keys (Scenario 3) | A per-action-type **conflict key** (`pay_invoice` → invoice id). A partial unique index over `QUEUED`/`DISPATCHING`/`UNKNOWN` (**UNKNOWN included**) returns 409 with the current state. The ERP's "already paid" check is the backstop once the first payment has finished. |
| Partial payments | **Not supported** (your decision): it adds complexity that isn't the point of the challenge. `pay_invoice` pays the full open amount. |
| Amount in the payload | The agent sends the `amount` it believes is open. The mock ERP rejects a mismatch with a permanent validation error, which also gives Scenario 8 a natural failure. |

---

## D2: What to do when the ERP outcome is unknown after a timeout · `TBD` (partly introduced)
- **Recommendation:** mark UNKNOWN and reconcile asynchronously, with a trust rule for "not found". Rejected: "query the ERP first" (`recommended.md` → D2).
- **Already covered:** why a stale "not found" is dangerous (resend → double payment; refund → free action), and that "found" is strong evidence while "not found" is weak.
- **Open questions:**
  - When does "not found" become trustworthy? Options: (a) ERP-reported freshness, (b) a declared maximum lag, (c) a consistent-read path, (d) witness evidence from our own committed payments plus lane stale-suspicion. The recommendation is (b)+(d) plus a two-observation confirmation.
  - What happens after N ambiguous cycles: fail and release, or wait for an operator?
  - The maximum age of an UNKNOWN before alerting.

## D3: Where the wallet debit lives relative to the action · `TBD`
- **Recommendation:** two-phase hold and capture. Rejected: debit first, then act (`recommended.md` → D3).
- **Open questions:** whether you're happy with capture ≤ hold (partial capture plus release of the remainder) being used for the LLM cache-hit discount.

## D4: Cache for ERP reads · `TBD`
- **Recommendation:** read-through. Rejected: cache-aside (`recommended.md` → D4).

## D5: How cached invoice data is invalidated · `TBD`
- **Recommendation:** webhook plus per-object sequence high-water mark, own-write seq bumps, and TTL = budget − max lag. Rejected: TTL only (`recommended.md` → D5).
- **Open questions:** the budget numbers (vendor 60 s, invoice 15 s, payment lookup never cached, classification unbounded).

## D6: Protection against cache stampede on a hot vendor · `TBD`
- **Recommendation:** request coalescing (in-process plus a Redis lease). Rejected: stale-while-revalidate (`recommended.md` → D6).

## D7: Concurrency control on a tenant's wallet · `TBD`
- **Recommendation:** an atomic conditional update on a wallet projection row, with the ledger as the source of truth. Rejected: `SELECT … FOR UPDATE` (`recommended.md` → D7).
- **Open question:** how to explain the "balances are derived" tension (the projection row vs a pure SUM).

## D8: Queue choice for action execution · `DISCUSSING`
- **Options presented:** a Postgres-backed queue (the actions table *is* the queue) vs BullMQ with a transactional outbox. Kafka and SQS were discussed and set aside.
- **Your prior lean:** BullMQ, since Redis exists anyway for caching.
- **Recommendation:** the Postgres-backed queue. Rejected: BullMQ (`recommended.md` → D8). The core argument: the record, the hold and the enqueue must commit together; BullMQ needs an outbox to achieve that; per-tenant fairness is a BullMQ Pro feature; and Redis should hold nothing whose loss could lose an action or money.
- **Waiting on:** your reply. Do you accept the "Redis holds nothing critical" principle, and how much does BullMQ familiarity weigh?

---

## Additional decisions · all `TBD`
Each has a recommendation in `recommended.md`.

| ID | Topic | Recommendation (short) |
|---|---|---|
| A3 | Process topology | separate `api`, `worker` and `mock-erp` processes |
| A4 | ERP topology and limits | limits per lane (ERP endpoint); tenants can share a lane |
| A5 | Fairness | round-robin by least-recently-dispatched tenant within a lane |
| A6 | Rate limiting | Redis token bucket, plus a 429 cooldown and a single probe |
| A7 | Backpressure | cap on pending actions per tenant → 429, not persisted |
| A8 | Outcome taxonomy | conservative: only provably pre-commit failures are retryable |
| A9 | Stored rejections | 402/409 stored and replayed; 400/422/429 not stored |
| A10 | Conflicts (Scenario 3) | the conflict key from D1 sub-decisions (locked there) |
| A11 | Metering and prices | actions only; pay 300; classify 20, or 2 on a cache hit |
| A12 | Hold lifetime | no auto-expiry while an action may have executed; QUEUED expires after 24 h |
| A13 | LLM cache key | includes tenant, model and prompt version; stored in Postgres |
| A14 | LLM provider | fake by default; Claude adapter when an API key is set |
| A15 | Test time control | scale durations, no fake timers |
| A16 | State-machine enforcement | `transition()` compare-and-set, an event log and a database trigger |
| A17 | Webhook HMAC | stretch goal; cut first |
