# Step 11: Deliverable docs, benchmark, review preparation

- **Goal:** produce the written deliverables (the one-page `README.md` and the final `DECISIONS.md` at the repo root). Measure the number for the "Postgres-only" question. Write the review rehearsal pack.
- **Depends on:** 10.
- **Estimate:** ~3 h. **Do not cut this step.** The written decisions are half the grade.

## Deliverables
- `README.md` (repo root): **one page**
- `DECISIONS.md` (repo root): produced from `decisions/recommended.md`, reflecting whatever was actually built
- `scripts/bench-pg-queue.ts` and its output pasted into `plans/REVIEW-PREP.md`
- `plans/REVIEW-PREP.md`: the rehearsal pack (not a deliverable; for the user)

## 1. README.md (one page; keep it tight)
Sections, in order:
1. **What this is** (2 lines).
2. **Run it:** `docker compose up --build`, then the tenant keys table. One curl to submit and one to `GET`. `pnpm demo:timeout` for the forced-timeout walkthrough.
3. **Failure injection and reconciliation:** the `pnpm fault …` commands (the main five) and `pnpm reconcile`.
4. **Action state machine:** the ASCII diagram from `00-architecture.md` §6 plus a compact transitions table (from → to, trigger, wallet effect).
5. **Scenarios:** an 8-row table (number, expected behaviour in one line, test file) and how to run them (`docker compose up -d postgres redis && pnpm test:scenarios`).
6. **Staleness budgets:** the table from D5.
7. **What we cut** (honest, specific). Fill this from what was actually built. Candidates:
   - auth is static API keys
   - one ERP dialect (SAP-style); the connector interface is ready for Tally
   - partial payments (by decision)
   - webhook HMAC (if skipped)
   - Prometheus metrics (a JSON ops endpoint instead)
   - AIMD rate adaptation (fixed rate plus cooldown)
   - cross-process coalescing test (if skipped)
   - ERP-side full reconciliation (payments in the ERP with no action)
   - REFUND flows
   - hold-expiry tuning
   - Redis HA; multi-region
   - rebuilding the HWM after a Redis loss (the TTL bound applies instead)
   - SAP's 16-character `XBLNR` reference limit: we send a 36-character UUID; a real connector would map it to a 16-character derived reference with a collision check
8. **Layout:** one line per top-level directory.

## 2. DECISIONS.md (repo root)
- Start from `decisions/recommended.md` and **reconcile it with the code**. Every "Implemented in" pointer must name real files. If anything changed during implementation, the code wins, so update the text and also `decisions/recommended.md`.
- **Keep:** assumptions S1–S8; D1–D8 with **Chosen / Rejected / Failure prevented** (required), and one short line each for "Why the other options lose" and "Trade-off accepted"; A1–A17, compressed to three lines each; the staleness-budget table.
- **Drop:** the "Pushback → answer" lines. Those move to `REVIEW-PREP.md`.
- Target length: about 2–3 pages. Reviewers have 45 minutes.

## 3. Benchmark: "when is one Postgres table and no Redis enough?" (answer with a number)
`scripts/bench-pg-queue.ts` runs against local Docker Postgres and Redis and prints a table. It measures:
1. **Queue throughput.**
   - Insert 20,000 `QUEUED` actions on a `bench` lane (3 tenants, synthetic `response_body`).
   - Run N in-process claimers (N = 1, 4, 16), each using the **real** `claimNext` and an immediate no-op settle (a `DISPATCHING → SUCCEEDED` transition with a ledger CAPTURE, so the measurement includes ledger writes).
   - Report claims/s and settles/s, and p50/p99 claim latency.
2. **Admission throughput.** `submitAction` at a concurrency of 50 for 20 s → submits/s (record + hold + event in one transaction).
3. **Read throughput, cache in Postgres vs Redis.**
   - Postgres: an `UNLOGGED` table `cache_bench(key text primary key, v jsonb, seq bigint)` holding 1,000 keys; random primary-key reads at a concurrency of 64 for 10 s → reads/s.
   - Redis: the same with `HMGET` → reads/s.
4. **Output:** a markdown table with the machine (CPU and RAM from `os`).

**How to answer in the review** (fill in the measured numbers):
> "Redis is never needed for correctness here. It holds only cache entries, rate-limit tokens and coalescing leases. Postgres alone is enough while:
> - **sustained actions stay below ~X/s** (our measured claim+settle ceiling, with 2× headroom), and
> - **cached reads stay below ~Y/s** (Postgres primary-key reads at 50% of the measured ceiling, leaving room for the write path), and
> - a single dispatcher per lane is acceptable, so the token bucket can live in-process or in a Postgres row.
>
> Our ERP lanes are limited to 50 req/s each, so with fewer than ~X/50 saturated ERP lanes the ERP, not our infrastructure, is the bottleneck. Above Y cached reads/s, or with many API processes needing a shared rate limiter, Redis earns its place."

Pre-measurement intuition, *to be replaced by the measured numbers*: a Postgres `SKIP LOCKED` queue on a laptop typically does low thousands of claim+settle cycles per second, and a Postgres primary serves on the order of 10k+ simple primary-key reads per second. The bench script exists so you never quote those from memory.

## 4. `plans/REVIEW-PREP.md` (the rehearsal pack)
Write these sections:

1. **Walkthrough script** (review part 1).
   - The exact commands: `docker compose up`, `pnpm demo:timeout`.
   - For each printed transition, what to say:
     - **QUEUED:** the record, hold and enqueue in one transaction.
     - **DISPATCHING:** CAS plus lease, committed before the call (Constraint 4).
     - **UNKNOWN:** the conservative taxonomy, the hold kept, no retry, no refund.
     - **reconciled:found:** look up by reference; "found" is strong evidence; CAPTURE.
   - What you'd show if they ask for the not-committed path (`pnpm fault drop-before-commit`), and the crash path (`docker compose kill worker` mid-call, then `docker compose start worker`).
2. **Defending decisions** (review part 2): for each of D1, D2, D3, D7 and D8 (they pick two):
   - our choice in one sentence
   - the **rejected option's best three arguments**, as they'd make them
   - our answer to each
   - the condition under which we'd switch (shows judgement: "BullMQ becomes right when…")

   Source material: the pushback lines in `decisions/recommended.md` and `decisions/locked.md`.
3. **The live change: "the ERP returns stale reads for 10 minutes"** (review part 3). Prepare this answer and rehearse it with `pnpm fault stale-reads --lag 10m --duration 10m` running:
   - **Cache:**
     - Fills whose `seq < HWM` are rejected (no rollback) and reported as stale evidence.
     - Objects we hold an HWM for return `503 upstream_stale` rather than old data.
     - Objects with no known HWM *can* be refilled from a stale view, so their effective staleness becomes lag + TTL, which **breaks the declared budget**. Say that plainly.
     - Mitigation: while the lane is stale-suspected, set TTL to 0 or bypass the cache for that lane (a small change in `ttlFor`), and surface `stale_suspected_until` on `/v1/ops/queue`.
   - **Wallet:**
     - Nothing is refunded and nothing is double-charged.
     - Holds on UNKNOWN actions stay held for longer, so tenants see a reduced `available` balance.
     - New submits are still admitted (writes go to the primary; the ERP still validates "already paid" on the primary).
   - **Reconciliation:**
     - "Not found" becomes untrusted: a witness isn't visible, so the lane is quarantined for 15 minutes.
     - UNKNOWNs wait. Alerts fire after 15 minutes.
     - "Found" results still resolve immediately.
     - Once a witness is visible and the quarantine expires, normal resolution resumes.
     - Point to the `x-stale-window` test as proof.
4. **The number** (review part 4): the benchmark table and the answer template above.
5. **Likely follow-ups, with one-line answers:**
   - Why not Kafka?
   - What if Redis dies?
   - What if Postgres fails over mid-transaction?
   - How do you scale to 10 ERP lanes or 1,000 tenants?
   - What if the agent never retries?
   - What if the webhook is lost forever?
   - What does "exactly once" really mean here? (Effectively once: at-least-once attempts plus dedupe and reconciliation. True exactly-once delivery over a network is impossible.)
   - Why is 503 retryable but 504 ambiguous?
   - Why store 402s?
   - Partial payments?
   - The SAP reference-length limit?

## Done when
- [ ] README fits on one screen-page (roughly ≤ 120 lines) and every command in it works on the compose stack.
- [ ] DECISIONS.md at the root: D1–D8 complete in the required format; each "Implemented in" path exists.
- [ ] The bench has run and its numbers are pasted into REVIEW-PREP.
- [ ] REVIEW-PREP.md exists and has been rehearsed once out loud (by you).
- [ ] Commit `step 11: docs + review prep`.
