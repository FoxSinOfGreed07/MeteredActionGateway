# Metered Action Gateway

A gateway that sits between AI agents and customers' ERPs (a SAP-style mock here). Every action is **metered**
against a credit wallet, **reaches the ERP effectively once**, respects the ERP's **rate limit** fairly across
tenants, and reports exactly what happened, even when the ERP times out *after* committing.

> **Status: in progress.** Steps 01–06 of [`plans/`](plans/README.md) are built: foundation, mock ERP, ledger
> and wallet, intake API, ERP connector, dispatcher. Next are the reconciler for `UNKNOWN` actions (07), the
> read cache and webhooks (08), LLM classification (09), and the final docs (10–11). Progress is tracked in
> [`plans/PROGRESS.md`](plans/PROGRESS.md).

## Run it

```bash
docker compose up --build        # postgres, redis, migrate+seed, mock-erp :4000, api :3000, worker
```

Seeded tenants (all on the `sap-main` ERP lane):

| Tenant | Company | Credits | API key |
|---|---|---|---|
| acme | C100 | 1,000,000 | `acme-dev-key` |
| globex | C200 | 500 | `globex-dev-key` (try two 300-credit actions) |
| initech | C300 | 100,000 | `initech-dev-key` |

Pay an invoice (the amount must equal the invoice's open amount: full payments only):

```bash
# find an open invoice and its amount (mock ERP admin API)
curl -s 'localhost:4000/__admin/companies/C100/invoices?status=OPEN&limit=1'

curl -s -X POST localhost:3000/v1/actions \
  -H 'Authorization: Bearer acme-dev-key' -H 'Idempotency-Key: demo-1' -H 'content-type: application/json' \
  -d '{"action_type":"pay_invoice","payload":{"invoice_id":"INV-C100-00002","amount_minor":<open_amount_minor>,"currency":"INR"}}'

curl -s localhost:3000/v1/actions/<id> -H 'Authorization: Bearer acme-dev-key'   # state, events, ledger
curl -s localhost:3000/v1/wallet       -H 'Authorization: Bearer acme-dev-key'   # available / held, derived from the ledger
curl -s localhost:3000/v1/ops/queue    -H 'Authorization: Bearer ops-dev-key'    # queue depth, cooldown per lane
```

Resubmitting with the same `Idempotency-Key` returns the identical stored response (with
`Idempotent-Replayed: true`). The same key with a different body gets a `422`.

## How an action flows

```
submit ──▶ QUEUED (hold placed, same transaction as the record) ──claim (CAS + lease)──▶ DISPATCHING
  │                                                                                   │
  └─▶ REJECTED (402 no credits / 409 another action active on the same invoice)       ├─ ERP 2xx ─────────▶ SUCCEEDED (capture)
                                                                                      ├─ 429/503 ─────────▶ QUEUED (backoff, cooldown)
                                                                                      ├─ 4xx ─────────────▶ FAILED (release + reason)
                                                                                      └─ timeout/reset/5xx ▶ UNKNOWN (hold kept; never resent blindly)
```

`UNKNOWN` actions are resolved by looking up the payment by reference (the action id). That's step 07; until
it lands, they stay `UNKNOWN` with their hold intact.

## Tests

```bash
docker compose up -d postgres redis
pnpm install
pnpm test                 # unit + integration + scenarios (scenario time scaled ×0.1)
pnpm test:scenarios       # just the challenge scenarios
pnpm test:realtime        # scenarios with the doc's real durations (slow)
```

| Scenario | Expected behaviour | Test |
|---|---|---|
| 1 | Same key twice, 200 ms apart → one ERP write, one debit, identical responses | `test/scenarios/s1-duplicate-submit.test.ts` |
| 3 | Two agents pay the same invoice → exactly one succeeds; the other gets a conflict with the current state | `test/scenarios/s3-concurrent-invoice.test.ts` |
| 4 | 500 credits, two 300-credit actions in parallel → second rejected at hold time, never negative | `test/integration/intake.test.ts`, `wallet-concurrency.test.ts` (end-to-end file in step 10) |
| 5 | 429s for 90 s during 5,000 actions → backs off, depth visible, nothing lost, fair across tenants | `test/scenarios/s5-rate-limit-storm.test.ts` |
| 8 | Permanent validation failure after the hold → hold released with reason; no net charge | `test/scenarios/s8-permanent-failure.test.ts` |
| 2, 6, 7 | Timeout after commit; late webhook; cache stampede | steps 07–08 |

## Repository layout

| Path | What's there |
|---|---|
| `src/gateway/` | API (`api/`), intake + state machine (`actions/`), ledger (`wallet/`), ERP connector (`erp/`), dispatcher (`dispatch/`), worker |
| `src/mock-erp/` | The mock SAP-style ERP: faults, stale reads, webhooks, admin API |
| `migrations/` | Postgres schema (append-only ledger, guarded state machine) |
| `test/` | `unit/`, `integration/`, `scenarios/`, and the in-process test stack in `kit/` |
| `decisions/` | `recommended.md`: every design decision (D1–D8 and more) with the rejected option and the failure it prevents. `locked.md`: what's been agreed so far |
| `plans/` | The ordered implementation plan, architecture reference and progress log |

**Stack:** Node.js + TypeScript, Hono, Postgres (system of record *and* the job queue), Redis (rate limiting
and caching only: it holds nothing whose loss could lose an action or money).
