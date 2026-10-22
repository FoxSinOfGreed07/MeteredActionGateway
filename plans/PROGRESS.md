# Progress

Update after every step: tick the boxes, add notes, commit. `git log` should show one commit per step.

## Steps
- [x] **01 Foundation**: compose up works; migration and seed; test kit; typecheck, lint and test green
- [x] **02 Mock ERP**: routes; faults (429, 503, latency, drop before/after commit, timeout after commit, 500 after commit, stale reads); webhooks; stats; tests
- [ ] **03 Ledger and wallet**: grant/hold/capture/release; append-only; verify; S4 at domain level
- [ ] **04 Actions and intake**: state machine and trigger; registry; admission transaction; API; S1/S3/S4 at submit level
- [ ] **05 ERP connector**: taxonomy unit tests; integration tests per fault
- [ ] **06 Dispatcher**: fair claim; token bucket; cooldown and probe; settle with fencing; recovery; expiry; ops queue; **S1, S3, S5, S8**
- [ ] **07 Reconciler**: resolver; trust rule; witness; lane health; scripts (fault, reconcile, demo); **S2**, crash, abandoned commit, stale window
- [ ] **08 Read cache**: Lua scripts; read-through; webhooks; coalescing; **S6, S7**
- [ ] **09 LLM classifier**: fake; cache key; partial capture; (optional Claude adapter)
- [ ] **10 Scenario suite**: S4 end to end; invariants afterEach; 5× stable; realtime once; fresh clone
- [ ] **11 Docs and review prep**: README; DECISIONS.md; bench numbers; REVIEW-PREP.md

## Scenario status
| # | Test file | Status |
|---|---|---|
| 1 | `test/scenarios/s1-duplicate-submit.test.ts` | ☐ |
| 2 | `test/scenarios/s2-timeout-after-commit.test.ts` | ☐ |
| 3 | `test/scenarios/s3-concurrent-invoice.test.ts` | ☐ |
| 4 | `test/scenarios/s4-wallet-race.test.ts` | ☐ |
| 5 | `test/scenarios/s5-rate-limit-storm.test.ts` | ☐ |
| 6 | `test/scenarios/s6-late-webhook.test.ts` | ☐ |
| 7 | `test/scenarios/s7-stampede.test.ts` | ☐ |
| 8 | `test/scenarios/s8-permanent-failure.test.ts` | ☐ |

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
- 02: 18 mock tests (the 16 planned + companies-on-demand + seed determinism). Added admin `GET …/invoices` (list/get) for the demo and tests; recorded in 00-architecture §9.
- 01: `docker compose up --build` → migrate exits 0 with the tenant table; `/healthz` 200; `down -v` + up works; re-running the seed doesn't double-grant.
