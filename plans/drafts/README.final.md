# Metered Action Gateway

A gateway between AI agents and customers' ERPs (a SAP-style mock here). Every action is **metered** against a
credit wallet (append-only ledger), reaches the ERP **effectively once** (even when the ERP times out *after*
committing), respects each ERP's **rate limit** fairly across tenants, and serves ERP reads from a cache with
declared staleness budgets. Design decisions, each with the rejected option and the failure it prevents, are
in [`DECISIONS.md`](DECISIONS.md).

## Run it

```bash
docker compose up --build    # postgres, redis, migrate+seed, mock-erp :4000, api :3000, worker
```

| Tenant | Company | Credits | API key |
|---|---|---|---|
| acme | C100 | 1,000,000 | `acme-dev-key` |
| globex | C200 | 500 | `globex-dev-key` (two 300-credit payments: the second gets a 402) |
| initech | C300 | 100,000 | `initech-dev-key` |

```bash
curl -s 'localhost:4000/__admin/companies/C100/invoices?status=OPEN&limit=1'      # pick an invoice + its open amount
curl -s -X POST localhost:3000/v1/actions -H 'Authorization: Bearer acme-dev-key' -H 'Idempotency-Key: k1' \
  -H 'content-type: application/json' \
  -d '{"action_type":"pay_invoice","payload":{"invoice_id":"INV-C100-00002","amount_minor":<open_amount_minor>,"currency":"INR"}}'
curl -s localhost:3000/v1/actions/<id> -H 'Authorization: Bearer acme-dev-key'      # state, events, ledger entries
curl -s localhost:3000/v1/wallet -H 'Authorization: Bearer acme-dev-key'            # available / held, checked against the ledger
curl -s localhost:3000/v1/erp/vendors/V-0001 -H 'Authorization: Bearer acme-dev-key'  # cached read: meta.source, seq, age
curl -s localhost:3000/v1/ops/queue -H 'Authorization: Bearer ops-dev-key'           # queue depth, cooldown, stale suspicion
```

`classify_invoice_line` (`{"description":"AWS hosting - Sept"}`) runs the LLM step. Results are cached by
content hash, so a repeat costs 2 credits instead of 20. It uses a deterministic fake by default; set
`ANTHROPIC_API_KEY` to use Claude.

## Failure injection, reconciliation, demo

```bash
pnpm install
pnpm demo:timeout                      # one action end-to-end with a forced timeout AFTER commit
pnpm fault timeout-after-commit        # | drop-after-commit | 500-after-commit | drop-before-commit
pnpm fault 429 --duration 90s          # | 503 | latency --ms 2000
pnpm fault stale-reads --lag 10m --duration 10m
pnpm fault vendor-change C100 V-0001 --name "X" --webhook-delay 40s
pnpm fault list | clear
pnpm reconcile                         # resolve UNKNOWN actions now + verify ledger invariants (exit 1 on drift)
```

## Action state machine

```
submit ─▶ QUEUED ──claim (CAS + lease, committed before the call)──▶ DISPATCHING ─┬─ 2xx ──────────────▶ SUCCEEDED ■
  │        ▲  ▲                                                                    ├─ 429/503/unreach ─▶ QUEUED (backoff)
  │        │  └──────────── trusted "not found": re-send, same reference ──┐       ├─ other 4xx ───────▶ FAILED ■
  └─▶ REJECTED ■ (402 credits / 409 conflict)                               │       └─ timeout/reset/5xx ▶ UNKNOWN
                                                                            └── UNKNOWN ─ found ─▶ SUCCEEDED ■
           crash: expired DISPATCHING lease ─▶ UNKNOWN (never a blind resend)   UNKNOWN ─ not found ×3 ─▶ FAILED ■
```

| Transition | Wallet |
|---|---|
| submit → QUEUED | `HOLD` (same transaction as the record and the enqueue) |
| DISPATCHING / UNKNOWN → SUCCEEDED | `CAPTURE` (+ `RELEASE` of any unused hold) |
| → FAILED | `RELEASE` with the reason |
| → UNKNOWN, → QUEUED | none: the hold is kept |

"Not found" is trusted only after `request_timeout + max_read_lag`, with no stale-read evidence on the lane,
with one of our own later payments visible in the same read view, and on two consecutive observations.

## Scenarios

`docker compose up -d postgres redis && pnpm install && pnpm test:scenarios` (time scaled ×0.1;
`pnpm test:realtime` uses the doc's real durations).

| # | Expected behaviour | Test |
|---|---|---|
| 1 | Same key twice, 200 ms apart → one ERP write, one debit, identical responses | `s1-duplicate-submit` |
| 2 | Commit, then connection drop → UNKNOWN; lookup by reference before any refund/retry; one payment | `s2-timeout-after-commit` |
| 3 | Two agents, same invoice → one succeeds, the other gets a 409 with the current state | `s3-concurrent-invoice` |
| 4 | 500 credits, two 300-credit actions in parallel → second rejected at hold time; never negative | `s4-wallet-race` |
| 5 | 429 for 90 s during 5,000 actions → backs off (24 × 429), depth visible, none lost, fair (B/C done by #1,500) | `s5-rate-limit-storm` |
| 6 | Vendor changed in SAP, webhook 40 s late → invalidated by seq; nothing older observable after it; within budget before | `s6-late-webhook` |
| 7 | 1,000 requests at expiry → one upstream read (also across two API instances) | `s7-stampede` |
| 8 | Validation failure after the hold → HOLD + RELEASE with reason; no net charge | `s8-permanent-failure` |
| + | Late commit after our timeout; crash before/after the ERP commit; 10-minute stale reads | `x-abandoned-commit`, `x-crash-recovery`, `x-stale-window` |

## Staleness budgets

| Object | Budget | Notes |
|---|---|---|
| Vendor master | 60 s | webhook seq invalidation; TTL 55 s backstop |
| Invoice | 15 s | own payment response + webhook seq; TTL 10 s |
| Payment lookup | never cached | reconciliation must see the ERP |
| Classification | unbounded | immutable; key includes model + prompt version |

## What we cut

- **Auth:** static per-tenant API keys (stored as sha256). No rotation or scopes.
- **ERPs:** one ERP dialect (the SAP-style mock). The connector interface is ready for Tally.
- **Partial payments:** not supported, by decision.
- **Metrics:** `/v1/ops/queue` plus structured logs instead of Prometheus.
- **Rate limits:** a fixed rate per lane plus 429 cooldown/probe, not adaptive (AIMD).
- **ERP-side reconciliation:** no sweep for ERP payments that have no action. Per-action lookups do flag duplicates.
- **Refunds:** the `REFUND` ledger kind exists, but no code path uses it.
- **Redis restart:** high-water marks aren't rebuilt; the TTL bound applies until webhooks refill them.
- **Stale windows:** no automatic cache bypass while a lane is stale-suspected (the fix is described in the review notes).
- **References:** SAP's 16-character reference field isn't mapped; we send the 36-character action id.
- **Infrastructure:** no Redis HA, multi-region, or failover testing.
- **Claude adapter:** implemented but not exercised in tests (they use the deterministic fake).

## Layout

| Path | Contents |
|---|---|
| `src/gateway/` | `api/`, `actions/` (intake + state machine), `wallet/` (ledger), `erp/`, `dispatch/` (queue, limiter), `reconcile/`, `cache/`, `llm/`, worker |
| `src/mock-erp/` | Mock SAP-style ERP: faults, stale reads, delayed webhooks, admin API |
| `migrations/` | Schema: append-only ledger, guarded state machine (triggers) |
| `test/` | `unit/`, `integration/`, `scenarios/`, in-process stack in `kit/` |
| `scripts/` | `migrate`, `seed`, `inject-fault`, `reconcile`, `demo-timeout`, `bench-pg-queue` |
| `decisions/`, `plans/` | Full decision rationale; the implementation plan and progress log |
