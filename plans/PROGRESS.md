# Progress

Update after every step: tick the boxes, add notes, commit. `git log` should show one commit per step.

## Current status — paused 2026-10-22 (resume here)

**Committed:** steps 01–09 (one commit each) + a README commit. Everything up to step 09 is green
(135 tests: unit + integration + scenarios at `SCENARIO_TIME_SCALE=0.1`), and the compose stack works end to
end (`pnpm demo:timeout` shows QUEUED → DISPATCHING → UNKNOWN → SUCCEEDED, HOLD → CAPTURE, 1 ERP POST).

**Step 10 (scenario suite): in progress, NOT ticked.**
- [x] `test/scenarios/s4-wallet-race.test.ts` added (end to end: 500 credits / two 300 → 202 + 402; 50-way stress → exactly 10 accepted). Passes.
- [x] `afterEach(assertInvariants)` in every scenario file; header block (who / situation / expected) in all 11 files.
- [x] Stability: `pnpm test:scenarios` 5× in a row — **5/5 green** (11 files, 22 tests, ~93 s per run).
- [x] S5 now prints its measurements (`--silent=false`): scaled run → 15.3 s outage, 24 × 429, B/C last completions #1,500 / #1,499 of 5,000; realtime → 90 s outage, 16 × 429, B/C #1,499 / #1,498.
- [ ] **Realtime mode (`SCENARIO_TIME_SCALE=1`): 20/22 passed, 2 FAILED — both in `x-stale-window.test.ts`.** Cause is test timing, not a correctness bug: while a lane is stale-quarantined the reconciler reschedules UNKNOWN lookups up to `reconciler.backoffMaxMs` (60 s real, 6 s scaled), so after the test clears the quarantine the action isn't looked at again within the test's 30 s wait.
  - A fix is in the working tree and committed with this update **but UNVERIFIED (neither scaled nor realtime has been run since)**: after clearing `lane_health`, both tests call `POST /v1/ops/reconcile {force:true}` (what an operator would do: `pnpm reconcile`). Alternative if preferred: keep the tests passive and raise their final `waitForState` timeout to `backoffMaxMs + 30 s`.
  - Next: run `pnpm vitest run test/scenarios/x-stale-window.test.ts` (scaled) and `SCENARIO_TIME_SCALE=1 pnpm vitest run test/scenarios/x-stale-window.test.ts` (realtime); then the full realtime suite once more.
- [ ] **Fresh-clone check: NOT done.** `git clone . /tmp/mag-check && cd /tmp/mag-check && docker compose down -v; docker compose up --build -d`, then `/healthz`, a curl submit, and `pnpm install && pnpm demo:timeout`. (Must not run while tests are using the shared Postgres.)
- [ ] Then tick step 10 and commit `step 10: scenario suite`.

**Step 11 (docs + review prep): drafted, NOT finished.**
- [~] `DECISIONS.md` (repo root): drafted from `decisions/recommended.md`, reconciled with the code (real file paths, as-built notes, measured S5 numbers, measured admission throughput). Needs a final read-through.
- [~] `plans/REVIEW-PREP.md`: drafted (walkthrough table for `pnpm demo:timeout`, rival arguments for D1/D2/D3/D7/D8, the 10-minute stale-read answer, follow-ups). Still contains `BENCH_TABLE_PLACEHOLDER` and `X/Q/R` placeholders for the benchmark numbers.
- [~] `scripts/bench-pg-queue.ts` (`pnpm bench:pg`): written and type-checks; **never run**. Must run when no tests are using Postgres, then paste its table into REVIEW-PREP Part 4 and fill in Q/R.
- [~] Final one-page README: drafted at `plans/drafts/README.final.md` (run, failure injection, state machine, scenarios table with measured S5 numbers, budgets, what we cut, layout). Not yet swapped in; the current root `README.md` is the in-progress version (status line says steps 01–09).
- [x] `decisions/recommended.md`: as-built notes added (D7 hold is one CTE statement + measured throughput; A6 one cooldown trip per window).
- [ ] Then: swap in the README, remove `plans/drafts/`, final read of DECISIONS.md, commit `step 11: docs + review prep`.

## Steps
- [x] **01 Foundation**: compose up works; migration and seed; test kit; typecheck, lint and test green
- [x] **02 Mock ERP**: routes; faults (429, 503, latency, drop before/after commit, timeout after commit, 500 after commit, stale reads); webhooks; stats; tests
- [x] **03 Ledger and wallet**: grant/hold/capture/release; append-only; verify; S4 at domain level
- [x] **04 Actions and intake**: state machine and trigger; registry; admission transaction; API; S1/S3/S4 at submit level
- [x] **05 ERP connector**: taxonomy unit tests; integration tests per fault
- [x] **06 Dispatcher**: fair claim; token bucket; cooldown and probe; settle with fencing; recovery; expiry; ops queue; **S1, S3, S5, S8**
- [x] **07 Reconciler**: resolver; trust rule; witness; lane health; scripts (fault, reconcile, demo); **S2**, crash, abandoned commit, stale window
- [x] **08 Read cache**: Lua scripts; read-through; webhooks; coalescing; **S6, S7**
- [x] **09 LLM classifier**: fake; cache key; partial capture; (optional Claude adapter)
- [ ] **10 Scenario suite**: S4 end to end; invariants afterEach; 5× stable; realtime once; fresh clone
- [ ] **11 Docs and review prep**: README; DECISIONS.md; bench numbers; REVIEW-PREP.md

## Scenario status
| # | Test file | Status |
|---|---|---|
| 1 | `test/scenarios/s1-duplicate-submit.test.ts` | ✅ (06) |
| 2 | `test/scenarios/s2-timeout-after-commit.test.ts` | ✅ (07) |
| 3 | `test/scenarios/s3-concurrent-invoice.test.ts` | ✅ (06) |
| 4 | `test/scenarios/s4-wallet-race.test.ts` | ✅ (10) |
| 5 | `test/scenarios/s5-rate-limit-storm.test.ts` | ✅ (06) |
| 6 | `test/scenarios/s6-late-webhook.test.ts` | ✅ (08) |
| 7 | `test/scenarios/s7-stampede.test.ts` | ✅ (08) |
| 8 | `test/scenarios/s8-permanent-failure.test.ts` | ✅ (06) |

## Decision changes
<!-- YYYY-MM-DD · decision · old → new · change plan file · status -->
_none yet_

## Blockers / deviations
<!-- what, why, the smallest deviation taken, the DEVIATION comment location -->
- **Node 22 locally** (v22.21.1): `engines` is `>=22`; the Docker image stays on `node:24-slim`. No Node-24-only APIs.
- **Toolchain majors installed:** TypeScript 7, vitest 5 (`test.projects`), zod 4, ioredis 6, kysely 0.29, @hono/node-server 2, Biome 2.6. `packageManager` is pinned to `pnpm@10.28.0` (corepack in the image otherwise pulls a newer pnpm that rejects ignored build scripts); esbuild is allow-listed via `pnpm.onlyBuiltDependencies`.
- **`schema_migrations`:** created `IF NOT EXISTS` in 0001 (the runner bootstraps it too). The architecture doc was updated to match.
- **numeric → number parser:** registered OID 1700 → number (SUM over bigint returns numeric), in addition to int8 → number.
- **Test tenants:** the fixture defaults to a fresh company code (`X…`) because `tenants` is unique per (lane, company). The **mock ERP must create companies on demand** (handled in step 02).

## Notes
<!-- timings, flaky tests fixed, anything the next session should know -->
- 10 (partial): vitest 5 hides console output of passing tests; use `--silent=false` to see S5's `[S5] …` measurement line. Realtime suite takes ~7 min (422 s).
- 09: classification (8 integration) + prompt-version snapshot green. Claude adapter implemented and type-checked against `@anthropic-ai/sdk` 1.1 (`beta.messages.parse` + `betaZodOutputFormat`, `effort: 'low'`, `fallbacks: 'default'`, `maxRetries: 0`); NOT exercised in tests (no API key; tests force the fake). Classifier lives on the context (`ctx.classifier`). "Hit" = this action didn't cause an LLM call (in-process single-flight followers are hits). Compose: miss → CAPTURE 20; repeat → CAPTURE 2 + RELEASE 18.
- 08: cache Lua (7), cache integration (5), S6 (late webhook + TTL backstop) and S7 (1,000 in-process, 200 real sockets, two API instances via the Redis lease, 429 failure → 1 ERP request) green. Lua scripts moved to integration tests (they need Redis). Cache-fill rejections below the HWM are reported as stale-read evidence to `lane_health`. Note: coalescing waits are scaled like everything else; S7 overrides them so they outlast the injected 300 ms ERP latency. Undici's `Agent` must be used with undici's own `fetch` (Node's built-in fetch bundles a different undici). Compose check: vendor change with a 4 s webhook delay → cache serves seq 1 within budget, then seq 2 after the HMAC-verified webhook.
- 07: S2 (4 cases: timeout / reset / 500 after commit + not-committed re-send), x-abandoned-commit, x-crash-recovery (a: crash before the call, b: crash after the ERP committed), x-stale-window (witness-based quarantine + lane-health-only case) all green. `pnpm demo:timeout` against compose: QUEUED→DISPATCHING→UNKNOWN (+5.4s)→SUCCEEDED (+6.7s), HOLD→CAPTURE, 1 ERP POST. Scripts run through the API (`/v1/ops/reconcile`) so they work from the host (lane base_url is compose-internal). Biome now excludes `*.md`.
- 06: dispatcher integration (6) and S1/S3(+S3b)/S5/S8 green. **Measured: per-tenant admission is serialized on the wallet row (D7 trade-off): ~255/s → ~326/s after making the hold one CTE statement and writing the event before it (the lock now spans one statement + COMMIT fsync); 5 tenants ≈ 1,250/s.** Because admission time doesn't scale with `SCENARIO_TIME_SCALE`, S5's outage runs until max(start + T(90 s), end of burst + T(10 s)), which is exactly 90 s in realtime mode. Cooldown script is `cooldown_trip` (one trip per window, so a burst of 429s doesn't escalate the exponent). Executors check `isAbandoned()` before settling (for crash simulation in 07). A missing executor fails the action with `no_executor` (classify gets one in 09).
- 05: outcome unit tests + connector integration tests against every mock fault. `PostPaymentResult.payment/invoice` are nullable: a 2xx with an unreadable body is still `committed` (trust the status), so the executor must tolerate missing data. Note: fetch's "bad ports" (e.g. 9) fail as `bad port` → unclassified/ambiguous; tests use a genuinely closed port for `unreachable`.
- 04: state machine (6) and intake (11) tests green. Replies always echo the stored jsonb `response_body` (the first caller gets the value RETURNED by the insert), so the first response and replays serialize identically. `transition()` uses a row lock (`SELECT … FOR UPDATE`) + UPDATE: same CAS semantics as the single-statement form, and gives the exact `from_state` for the event.
- 03: ledger (8 tests) and wallet concurrency (3 tests: S4 domain level, 50-way stress, interleaving) green. Seed and test fixtures use `grant()`; no writes to ledger/wallets outside `src/gateway/wallet/`.
- 02: 18 mock tests (the 16 planned + companies-on-demand + seed determinism). Added admin `GET …/invoices` (list/get) for the demo and tests; recorded in 00-architecture §9.
- 01: `docker compose up --build` → migrate exits 0 with the tenant table; `/healthz` 200; `down -v` + up works; re-running the seed doesn't double-grant.
