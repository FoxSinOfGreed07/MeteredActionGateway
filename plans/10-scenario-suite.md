# Step 10: Scenario suite hardening and the one-command run

- **Goal:** turn the scenario tests written in steps 06–08 into one clean, documented suite. Prove the deliverable "runnable repo with one command" on a fresh clone. Make the suite boring to run: deterministic, reasonably fast, with clear failure messages.
- **Depends on:** 06, 07, 08 (and 09 if it was built).
- **Decisions applied:** A15 (time scaling); every invariant in `00-architecture.md` §13.
- **Estimate:** ~2 h.

## Deliverables
- `test/scenarios/` containing exactly these files, each beginning with a header block:
  ```ts
  /**
   * Scenario N: <who is affected>
   * Situation: <the doc's wording>
   * Expected:  <one-line statement of expected behaviour>
   * Doc numbers: <e.g. 90 s / 5,000 actions> · Scaled by SCENARIO_TIME_SCALE (default 0.1)
   */
  ```
  | File | Scenario | Built in |
  |---|---|---|
  | `s1-duplicate-submit.test.ts` | 1 | 06 |
  | `s2-timeout-after-commit.test.ts` | 2 | 07 |
  | `s3-concurrent-invoice.test.ts` | 3 | 06 |
  | `s4-wallet-race.test.ts` | 4 (end to end: two parallel 300-credit submits on a 500 wallet; also runs the 50-way stress at the API level) | **here** (domain-level and API-level parts exist in 03/04; consolidate them into one end-to-end file with the worker running) |
  | `s5-rate-limit-storm.test.ts` | 5 | 06 |
  | `s6-late-webhook.test.ts` | 6 | 08 |
  | `s7-stampede.test.ts` | 7 | 08 |
  | `s8-permanent-failure.test.ts` | 8 | 06 |
  | `x-crash-recovery.test.ts` | Constraint 4 | 07 |
  | `x-abandoned-commit.test.ts` | D2 trust window | 07 |
  | `x-stale-window.test.ts` | review: 10-minute stale reads | 07 |
- `test/kit/invariants.ts`: `assertInvariants(stack)`, which runs `verifyWallets`, `verifySettlements` and a "no reference has more than 1 primary payment in the mock" check. **Call it in an `afterEach` in every scenario file.**
- `test/kit/report.ts` (optional): prints a one-line summary per scenario (duration, ERP posts, 429s served, final states), which is handy to paste into the README.
- `README` scenarios table (the draft goes into step 11): one row per scenario with the expected behaviour line and the test file.

## Tasks
1. **Consolidate S4** into `s4-wallet-race.test.ts` (end to end, with the worker running):
   - wallet 500, two parallel 300 submits → one 202 then SUCCEEDED, one 402
   - the wallet is never negative
   - the final ledger is `[GRANT 500, HOLD 300, CAPTURE 300]` for the winner only
   - plus the 50-way API-level stress (3,000 credits → exactly 10 accepted)
2. **Add the `afterEach(assertInvariants)` harness** to every scenario. If an invariant fails, print the offending rows.
3. **Stability pass.** Run `pnpm test:scenarios` 5 times in a row (`for i in 1 2 3 4 5; do pnpm test:scenarios || break; done`). Fix any flake at its root:
   - widen `waitFor` timeouts, never tighten assertions
   - replace sleeps with `waitFor`
   - make sure every fault is cleared and every timer stopped in `stop()`
4. **Realtime mode.** `pnpm test:realtime` (`SCENARIO_TIME_SCALE=1`) must also pass. It's slow (S5 alone is about 2.5 min); run it at least once and note the timings.
5. **Fresh-clone check** (the deliverable):
   ```bash
   rm -rf /tmp/mag-check && git clone . /tmp/mag-check && cd /tmp/mag-check
   docker compose down -v; docker compose up --build -d
   # wait for api /healthz, then:
   curl -s localhost:3000/healthz
   curl -s -X POST localhost:3000/v1/actions -H 'Authorization: Bearer acme-dev-key' \
        -H 'Idempotency-Key: demo-1' -H 'content-type: application/json' \
        -d '{"action_type":"pay_invoice","payload":{"invoice_id":"INV-C100-00001","amount_minor":<open amount>,"currency":"INR"}}'
   pnpm install && pnpm demo:timeout        # runs against the compose stack
   docker compose down -v
   ```
   The demo has to discover the open amount itself (it reads the invoice through the mock admin API). Document the curl variant in the README with a note on how to look up an amount (`GET /v1/erp/invoices/INV-C100-00001`).
6. **Timing budget.** The whole `pnpm test` should run in **under 5 minutes** at scale 0.1. If S5 dominates, reduce its post-outage rate assumptions (raise `rate_per_sec` to 400) rather than shrinking the 5,000 count.

## Done when
- [ ] 8 scenario files and 3 extra files, all green 5 runs in a row; realtime mode green once.
- [ ] The fresh-clone check passes end to end.
- [ ] Commit `step 10: scenario suite`.
