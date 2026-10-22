# Plans: Metered Action Gateway

This directory is an **ordered, executable implementation plan**. Run the steps in order and each one finds its
prerequisites already built. The plans are written so a fresh agent with no other context can implement them
in the background.

## Read first (in this order)
1. `../Priyanshu_Verma_Metered_Action_Gateway_Challenge.docx`: the brief. (`../LLM_CHAT.txt` has a problem breakdown.)
2. `../decisions/recommended.md`: **the decisions this plan builds on** (D1–D8, A1–A17, assumptions S1–S8).
3. `../decisions/locked.md`: which decisions the user has actually locked so far, and what's still under discussion.
4. `00-architecture.md`: **the single source of truth** for names, schema, state machine, API, mock ERP contract, Redis keys, config and invariants.
5. The current step file.

## Steps

| Step | File | Builds | Scenarios / proofs | Est. |
|---|---|---|---|---|
| 01 | `01-foundation.md` | scaffold, compose, migration, seed, test kit | foundation tests | 2.5 h |
| 02 | `02-mock-erp.md` | mock SAP-style ERP: faults, webhooks, stats | mock tests | 3 h |
| 03 | `03-ledger-wallet.md` | append-only ledger, wallet projection, D7 hold | S4 (domain level) | 2 h |
| 04 | `04-actions-intake.md` | state machine, registry, admission transaction, API | S1/S3/S4 (submit level) | 3 h |
| 05 | `05-erp-connector.md` | connector plus outcome taxonomy | taxonomy tests | 1.5 h |
| 06 | `06-dispatcher.md` | Postgres queue, fair claim, rate limit, cooldown, settle, recovery, ops | **S1, S3, S5, S8** | 4 h |
| 07 | `07-reconciler.md` | UNKNOWN resolver, trust rule, witness, scripts, demo | **S2**, crash, abandoned commit, stale window | 3 h |
| 08 | `08-read-cache.md` | read-through cache, seq HWM, webhooks, coalescing | **S6, S7** | 4 h |
| 09 | `09-llm-classifier.md` | content-hash classification, fake/Claude | constraint 3 | 1.5 h |
| 10 | `10-scenario-suite.md` | consolidated suite, S4 end to end, fresh-clone check | **S4**, all 8 green | 2 h |
| 11 | `11-docs-review-prep.md` | README, DECISIONS.md, bench, review pack | — | 3 h |
| | | | **Total** | **~29.5 h** |

### Dependency graph
```
01 ─┬─ 02 ───────┐
    └─ 03 ── 04 ─┴─ 05 ── 06 ── 07 ── 08 ── 09 ── 10 ── 11
```
- **Can run in parallel:** 02 ∥ 03 (no shared files). Everything from 04 onward is sequential.
- 08 needs 07 only for `lane-health.ts`. If you're under time pressure, 08 can start right after 06 with a stub `reportStaleEvidence`, wired up once 07 lands.

### 48-hour tiers (what to cut, and in what order)
- **Never cut:** the ledger (03), the admission transaction (04), the UNKNOWN path (06 + 07), S1/S2/S3/S4/S8, the failure-injection script, the demo, README, DECISIONS.md. *"Cut features before you cut the ledger."*
- **Must exist, can be simpler:** S5 (fairness assertion), S6, S7. Keep the tests; simplify the internals if needed.
- **Cut first, in this order:**
  1. A17 webhook HMAC
  2. the 09 Claude adapter (keep the fake)
  3. the cross-process coalescing test
  4. the witness check (keep lane-health + time rule; *say so* in REVIEW-PREP)
  5. QUEUED expiry (A12, the 24 h job)
  6. the bench (fall back to the stated intuition, clearly labelled as unmeasured)
  7. 09 entirely

  Every cut goes into the README's "What we cut", with the risk it leaves.

## Execution protocol (for the implementing agent)
1. **Before step 01:** read the four files under "Read first". Don't start coding until `00-architecture.md` is fully read.
2. **One step at a time, in order.** For each step:
   1. Read the step file completely. Check its "Depends on" steps are ticked in `PROGRESS.md`.
   2. Implement the deliverables. Follow `00-architecture.md` names **exactly**.
   3. Run `pnpm typecheck && pnpm lint && pnpm test`. Postgres and Redis must be up: `docker compose up -d postgres redis`. **All** tests must be green, including those from earlier steps.
   4. Tick the step's checklist in `PROGRESS.md` and record anything notable under *Notes*. Keep the root `README.md` status line and scenario table current (step 11 turns it into the final one-page README).
   5. Commit with the message `step NN: <title>`, ending with the attribution trailer your harness requires.
3. **Never weaken an invariant** (§13) or a test assertion to get green. If a test is flaky, fix the cause.
4. **Decisions are fixed for the implementer.**
   - If a decision is blocking or looks wrong, don't silently change it. Write the issue under *Blockers / deviations* in `PROGRESS.md`, take the smallest deviation that keeps the invariants, and mark it `DEVIATION` in a code comment.
   - If `00-architecture.md` is missing something, add it there first (in a separate commit) and then use it.
5. **External APIs:** load the `claude-api` skill before writing `src/gateway/llm/anthropic-classifier.ts`.
6. **Stop and report**, rather than push on, if `docker compose up` can't work in the environment (no Docker), or if the time budget for a step is exceeded by more than 2×.

## Conventions (short; full list in `00-architecture.md` §4)
- TypeScript strict, ESM (NodeNext), `.js` relative imports. Biome for lint and format.
- Context injection everywhere (`GatewayContext`), with no module singletons. Every money or state write takes a `Tx`.
- SQL and JSON use `snake_case`; TypeScript uses `camelCase`. Durations are in ms (`*_ms` / `*Ms`); credits are integers; money is integer paise.
- Use `transition()` for every state change. `ledger.ts` is the only writer of `ledger_entries` and `wallets`.
- Tests: `test/unit` (no infra), `test/integration` and `test/scenarios` (Postgres + Redis from compose; everything else in-process via `startStack`).
- Logs: pino JSON with `tenant_id`, `action_id` and `lane_id`.

## Decision → code map (used by change plans)
| Decision | Main code | Tests |
|---|---|---|
| D1 dedupe + CAS | `actions/submit.ts`, `dispatch/claim.ts`, `actions/state-machine.ts`, migration `actions_idempotency` | s1, intake, dispatcher multi-worker |
| D2 UNKNOWN + reconcile | `dispatch/settle.ts` (`markUnknown`), `dispatch/recovery.ts`, `reconcile/*` | s2, x-* |
| D3 hold/capture | `wallet/ledger.ts`, `dispatch/settle.ts`, `actions/submit.ts` | ledger, s8, s4 |
| D4 read-through | `cache/cached-reader.ts`, `api/routes/erp-reads.ts` | cache, s6, s7 |
| D5 webhook + seq HWM | `redis/lua/cache_*.lua`, `cache/webhook-ingest.ts`, `cache/hooks.ts`, `cache/budgets.ts` | cache-lua, s6 |
| D6 coalescing | `cache/singleflight.ts`, `cache/coalesce-lease.ts` | s7 |
| D7 conditional update | `wallet/ledger.ts` (`placeHold`), the `wallets` CHECK in the migration | wallet-concurrency, s4 |
| D8 Postgres queue | `dispatch/claim.ts`, `dispatch/dispatcher.ts`, `dispatch/recovery.ts`, migration indexes | dispatcher, s5 |
| A2 Kysely | `db/*`, everywhere | foundation (schema drift) |
| A4–A6 lanes, fairness, limiter | `dispatch/lanes.ts`, `claim.ts`, `rate-limiter.ts`, `cooldown.ts`, `redis/lua/token_bucket.lua` | s5, dispatcher |
| A7 backpressure | `actions/submit.ts` | intake |
| A8 taxonomy | `erp/outcome.ts` | outcome unit tests, erp-connector |
| A9 stored rejections | `actions/submit.ts`, the immutable-column trigger | intake, s4 |
| A10 conflict key | `actions/registry.ts`, migration `actions_one_active_per_target` | s3 |
| A11/A13/A14 LLM | `llm/*`, `dispatch/executors/classify-invoice-line.ts` | classification |
| A12 hold lifetime | `dispatch/expiry.ts`, `reconcile/*` (no auto-release) | dispatcher |
| A15 time scale | `test/kit/time.ts`, `shared/config.ts` (`scaleDurations`) | all scenarios |
| A16 transition guard | `actions/state-machine.ts`, the `guard_action_row` trigger | state-machine |
| A17 HMAC | `cache/webhook-ingest.ts`, `mock-erp/webhooks.ts` | cache |

## Change process
Decisions are still being discussed one at a time (`../decisions/locked.md`). When a locked decision differs from
`../decisions/recommended.md`:
1. **The user, or the discussion session,** updates `decisions/locked.md` (the new text) and `decisions/recommended.md` (so it stays the complete, consistent set), and adds a line under *Decision changes* in `PROGRESS.md`: `YYYY-MM-DD · D8 · Postgres queue → BullMQ + outbox · pending change plan`.
2. **A change-plan agent** reads both decision files, `PROGRESS.md`, `git log`, this map and the affected step files, then writes `plans/changes/NN-<decision>-<slug>.md` containing:
   - **Delta:** old vs new decision, in the challenge format
   - **Impact:** the affected files (from the map), schema migrations needed (new `migrations/000N_*.sql`, never edit 0001 once committed), and the tests to change or add
   - **Ordering:** whether it can be applied now, or must wait for or replace a not-yet-built step. If the step isn't built yet, **edit that step's plan file instead** and note the change.
   - **Steps:** ordered, each with a "done when"
   - **Risk:** which invariants (§13) the change touches, and how the tests prove they still hold
3. **The user runs the change plan** like any step: implement, keep all tests green, tick it in `PROGRESS.md`, commit as `change NN: <title>`.

If a change affects a step that hasn't been implemented yet, the cheapest path is to edit that step's plan file directly (and `00-architecture.md` if names change). Code-level change plans are only needed for steps that are already built.
