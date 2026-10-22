# Progress

Update after every step: tick the boxes, add notes, commit. `git log` should show one commit per step.

## Steps
- [x] **01 Foundation**: compose up works; migration and seed; test kit; typecheck, lint and test green
- [x] **02 Mock ERP**: routes; faults (429, 503, latency, drop before/after commit, timeout after commit, 500 after commit, stale reads); webhooks; stats; tests
- [x] **03 Ledger and wallet**: grant/hold/capture/release; append-only; verify; S4 at domain level
- [x] **04 Actions and intake**: state machine and trigger; registry; admission transaction; API; S1/S3/S4 at submit level
- [x] **05 ERP connector**: taxonomy unit tests; integration tests per fault
- [x] **06 Dispatcher**: fair claim; token bucket; cooldown and probe; settle with fencing; recovery; expiry; ops queue; **S1, S3, S5, S8**
- [ ] **07 Reconciler**: resolver; trust rule; witness; lane health; scripts (fault, reconcile, demo); **S2**, crash, abandoned commit, stale window
- [ ] **08 Read cache**: Lua scripts; read-through; webhooks; coalescing; **S6, S7**
- [ ] **09 LLM classifier**: fake; cache key; partial capture; (optional Claude adapter)
- [ ] **10 Scenario suite**: S4 end to end; invariants afterEach; 5× stable; realtime once; fresh clone
- [ ] **11 Docs and review prep**: README; DECISIONS.md; bench numbers; REVIEW-PREP.md

## Scenario status
| # | Test file | Status |
|---|---|---|
| 1 | `test/scenarios/s1-duplicate-submit.test.ts` | ✅ (06) |
| 2 | `test/scenarios/s2-timeout-after-commit.test.ts` | ☐ |
| 3 | `test/scenarios/s3-concurrent-invoice.test.ts` | ✅ (06) |
| 4 | `test/scenarios/s4-wallet-race.test.ts` | ☐ |
| 5 | `test/scenarios/s5-rate-limit-storm.test.ts` | ✅ (06) |
| 6 | `test/scenarios/s6-late-webhook.test.ts` | ☐ |
| 7 | `test/scenarios/s7-stampede.test.ts` | ☐ |
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
- 06: dispatcher integration (6) and S1/S3(+S3b)/S5/S8 green. **Measured: per-tenant admission is serialized on the wallet row (D7 trade-off): ~255/s → ~326/s after making the hold one CTE statement and writing the event before it (the lock now spans one statement + COMMIT fsync); 5 tenants ≈ 1,250/s.** Because admission time doesn't scale with `SCENARIO_TIME_SCALE`, S5's outage runs until max(start + T(90 s), end of burst + T(10 s)), which is exactly 90 s in realtime mode. Cooldown script is `cooldown_trip` (one trip per window, so a burst of 429s doesn't escalate the exponent). Executors check `isAbandoned()` before settling (for crash simulation in 07). A missing executor fails the action with `no_executor` (classify gets one in 09).
- 05: outcome unit tests + connector integration tests against every mock fault. `PostPaymentResult.payment/invoice` are nullable: a 2xx with an unreadable body is still `committed` (trust the status), so the executor must tolerate missing data. Note: fetch's "bad ports" (e.g. 9) fail as `bad port` → unclassified/ambiguous; tests use a genuinely closed port for `unreachable`.
- 04: state machine (6) and intake (11) tests green. Replies always echo the stored jsonb `response_body` (the first caller gets the value RETURNED by the insert), so the first response and replays serialize identically. `transition()` uses a row lock (`SELECT … FOR UPDATE`) + UPDATE: same CAS semantics as the single-statement form, and gives the exact `from_state` for the event.
- 03: ledger (8 tests) and wallet concurrency (3 tests: S4 domain level, 50-way stress, interleaving) green. Seed and test fixtures use `grant()`; no writes to ledger/wallets outside `src/gateway/wallet/`.
- 02: 18 mock tests (the 16 planned + companies-on-demand + seed determinism). Added admin `GET …/invoices` (list/get) for the demo and tests; recorded in 00-architecture §9.
- 01: `docker compose up --build` → migrate exits 0 with the tenant table; `/healthz` 200; `down -v` + up works; re-running the seed doesn't double-grant.
