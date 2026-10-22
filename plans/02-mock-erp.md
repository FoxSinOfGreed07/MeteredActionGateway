# Step 02: Mock ERP (SAP-style service with realistic failure modes)

- **Goal:** a separate Hono service that behaves like an ERP the gateway doesn't control. It has to reproduce every failure the scenarios and the review need: timeout after commit, 429, 503, stale reads, delayed webhooks and validation errors. It must also expose inspection endpoints so tests can count what really happened.
- **Depends on:** 01.
- **Decisions applied:** assumptions S2–S6 (no idempotency keys, non-unique references, lagging reads, 503 means not processed), D5 (per-object `seq` plus webhooks), A17 (HMAC on webhooks).
- **Estimate:** ~3 h.
- **Contract:** `00-architecture.md` §9. Every route, shape and fault mode is defined there. This file explains how to build them.

> **Realism rule.** The mock must not offer anything a real SAP or Tally wouldn't. It has **no** idempotency keys,
> **no** unique constraint on `reference`, and **no** "freshness" header on reads. Reviewers will ask about any
> capability the mock has that real ERPs lack.

## Deliverables
- `src/mock-erp/types.ts`: `Vendor`, `Invoice`, `Payment`, `WebhookEvent`, `FaultRule`, `MockErpOptions`, `MockErpConfig`
- `src/mock-erp/prng.ts`: a seeded PRNG (mulberry32) with helpers `int(min,max)`, `pick(arr)`, `digits(n)`
- `src/mock-erp/seed.ts`: `buildSeedState(seed)` → companies C100, C200, C300 (§14)
- `src/mock-erp/state.ts`: an in-memory store with version history
- `src/mock-erp/rate-limit.ts`: an in-process token bucket (the mock is a single process)
- `src/mock-erp/faults.ts`: rule storage and matching
- `src/mock-erp/webhooks.ts`: a delayed, HMAC-signed sender with retries
- `src/mock-erp/stats.ts`: counters
- `src/mock-erp/routes/erp.ts` and `src/mock-erp/routes/admin.ts`
- `src/mock-erp/app.ts`: `createMockErp(options) → MockErpInstance { app, state, faults, stats, config, start(port) → {url, close} }`
- `src/mock-erp/main.ts`: reads the `MOCK_ERP_*` env vars, calls `createMockErp`, then `start`
- `src/mock-erp/admin-client.ts`: `MockAdminClient` (typed wrapper over the `/__admin` routes: `reset`, `stats`, `resetStats`, `addFault`, `listFaults`, `clearFaults`, `patchVendor`, `createInvoices`, `primaryPayments`, `getConfig`, `putConfig`), used by `test/kit/stack.ts` **and** by `scripts/*`
- `test/integration/mock-erp.test.ts`

## Design

### State with version history (this powers stale reads)
```ts
interface Versioned<T> { current: T; history: Array<{ seq: number; atMs: number; data: T }> }
interface CompanyState {
  vendors: Map<string, Versioned<Vendor>>;
  invoices: Map<string, Versioned<Invoice>>;
  payments: Payment[];                        // append-only
  paymentsByRef: Map<string, Payment[]>;      // NOT unique; a list per reference
  paymentSeq: number;                         // for PAY-000001 ids
}
```
- `write(obj, mutate)` deep-copies `current`, applies `mutate`, sets `seq = old.seq + 1` and `updated_at = now`, pushes the new version onto `history`, then enqueues a webhook.
- `readAsOf(versioned, asOfMs)` returns the newest history entry with `atMs ≤ asOfMs`. If there is none, the object didn't exist yet, so return a 404.
- Seeding writes version 1 with `atMs = startup time − 1 day`, so stale reads of seeded objects still find a version.
- Keep at most 50 versions per object.

### Payment processing (the critical section)
`POST /companies/:cc/payments` validates **and** commits inside one synchronous block, with **no `await` between
validation and commit**. That's what serializes two concurrent posts for the same invoice, so the second sees
`PAID` and gets a `409`. Order of checks:
1. Body schema: `invoice_id` string, `amount_minor` positive int, `currency` string, `reference` string (1–64). Otherwise `400 VALIDATION_ERROR`.
2. Invoice exists in that company, otherwise `404 INVOICE_NOT_FOUND`.
3. `status === 'OPEN'`, otherwise `409 INVOICE_ALREADY_PAID` with `{invoice: current}`.
4. `currency === invoice.currency`, otherwise `422 CURRENCY_MISMATCH`.
5. `amount_minor === invoice.open_amount_minor`, otherwise `422 AMOUNT_MISMATCH` with `{invoice}`. No partial payments (S5).
6. Commit:
   - Create the `Payment` (`PAY-000123`, `seq: 1`, `created_at: now`) and append it to `payments` and `paymentsByRef`.
   - Write the invoice: `status: 'PAID'`, `open_amount_minor: 0`, seq + 1.
   - Enqueue webhooks for the payment and the invoice.
   - Increment `payments_created`.

   Then return `201 {payment, invoice}`. The returned invoice carries its **new seq**; the gateway uses it as an own-write HWM bump (D5).

### Request pipeline (Hono middleware, in this order)
1. **Exempt routes:** `/health` and `/__admin/*` skip everything below.
2. **Stats:** increment `requests_by_route` (use the route pattern, not the raw path) and `payment_posts_received` for `POST …/payments`.
3. **Forced status faults:** for the first active `status_429` or `status_503` rule that matches, return the status with `Retry-After: retry_after_s` and body `{code:'RATE_LIMITED'|'SERVICE_UNAVAILABLE'}`. Count it in `faults_applied`, and for 429s also in `rate_limited_429`.
4. **Token bucket** (`rate_limit_rps` / `rate_limit_burst`): when exhausted, return `429` with `Retry-After: 1` and increment `rate_limited_429`.
5. **`latency`:** `await sleep(latency_ms)`. The handler still runs afterwards, so if the client has already timed out, this produces a **late commit**. That's deliberate: it's the "abandoned request commits later" case D2 guards against.
6. **`drop_before_commit`:** `c.env.incoming.socket.destroy()`, then return a dummy `Response` (it's never written). Nothing commits.
7. **Handler.** For GETs, compute `asOfMs` = `now − lag_ms` if a `stale_reads` rule matches, otherwise `now`, and read with `readAsOf`. Payment lookup by reference filters on `created_at_ms ≤ asOfMs`.
8. **Post-commit faults** (only for a successful `POST …/payments`, i.e. after a commit):
   - `timeout_after_commit`: `await sleep(hang_ms)`, then `socket.destroy()`. The client's timeout fires first.
   - `drop_after_commit`: `socket.destroy()` immediately.
   - `error_500_after_commit`: return `500 {code:'INTERNAL_ERROR'}`.

Use `HttpBindings` from `@hono/node-server` (`new Hono<{ Bindings: HttpBindings }>()`) to reach `c.env.incoming.socket`.
Every response from a read route sets `ETag: "<seq>"`.

### Fault matching (`faults.ts`)
- A rule is **active** when all of these hold:
  - `now < createdAt + duration_ms` (or there's no `duration_ms`)
  - `remaining !== 0`, when `count` is set
  - the method matches
  - the path matches the glob (`*` matches one path segment)
  - `Math.random() < probability`
- Applying a counted rule decrements `remaining`.
- Expired or exhausted rules are pruned lazily.
- `GET /__admin/faults` returns each rule with `remaining` and `expires_in_ms`.

### Webhooks (`webhooks.ts`)
- **Enqueuing:** `enqueue(event, delayOverrideMs?)` uses `setTimeout(delay)`, then POSTs JSON to `config.webhook_url`:
  - Header `X-Erp-Signature: sha256=` + `hmacSha256Hex(secret, rawBody)`.
  - On a non-2xx response or a network error, retry up to 5 times, 1 s apart.
  - Count `sent`, `failed` and `pending`.
- **Ordering:** events are sent in delay order, **not** guaranteed in seq order, which is realistic. Tests that need out-of-order or duplicate delivery POST directly to the gateway.
- **Switches:** `webhooks_enabled: false` drops events (and counts them as `failed: 0, dropped: n`), which tests the TTL backstop. `reset` clears pending timers.
- **Event ids:** `event_id = crypto.randomUUID()`.

### Admin
Implement every route in §9:
- `PATCH /__admin/companies/:cc/vendors/:id` merges allowed fields (`name`, `bank_account`, `payment_terms_days`, `blocked`) into a new version and enqueues a webhook, honouring `?webhook_delay_ms=`.
- `POST /__admin/companies/:cc/invoices` bulk-creates OPEN invoices with sequential ids, continuing after the highest existing one.
- `GET /__admin/companies/:cc/payments` reads the primary (no stale view) and filters by `reference` and `invoice_id`.

## Tests (`test/integration/mock-erp.test.ts`)
Start the mock in-process on port 0 with webhooks pointed at a small test receiver: a Hono app on port 0 that records the bodies and headers it receives.

| # | Test | Assert |
|---|---|---|
| 1 | Pay an OPEN invoice | 201; invoice PAID, open 0, seq + 1; payment has the reference; `payments_created` = 1 |
| 2 | Pay the same invoice again | 409 `INVOICE_ALREADY_PAID` with the invoice in the body |
| 3 | Wrong amount | 422 `AMOUNT_MISMATCH`; nothing created |
| 4 | Unknown invoice | 404 |
| 5 | **Same reference posted twice, on two different invoices** | both 201; lookup by reference returns 2 payments (proves the mock is not idempotent, assumption S2) |
| 6 | Two concurrent posts for the same invoice (`Promise.all`) | exactly one 201 and one 409 |
| 7 | `stale_reads` with `lag_ms: 60000` | a vendor patched just now reads with the old seq; a payment created just now is invisible to the lookup; the admin primary listing shows it |
| 8 | `timeout_after_commit` (`hang_ms: 2000`), client `AbortSignal.timeout(300)` | the client gets a `TimeoutError`; the admin listing shows the payment committed |
| 9 | `drop_after_commit` | fetch rejects (socket error); the payment is committed |
| 10 | `drop_before_commit` | fetch rejects; **no** payment |
| 11 | `latency` 1000 ms, client timeout 300 ms | the client times out; the payment appears ~1 s later (late commit) |
| 12 | `status_429` with `duration_ms: 500`, `retry_after_s: 2` | 429 + `Retry-After: 2` during the window, success after it; `rate_limited_429` counted |
| 13 | Token bucket (rps 5, burst 5), 20 rapid GETs | some 429s with `Retry-After: 1` |
| 14 | Webhook after a vendor patch, `webhook_delay_ms: 200` | the receiver gets the event in ≥ 200 ms; the HMAC verifies; the seq matches |
| 15 | `count: 1` fault | applies exactly once |
| 16 | Reset | state back to seed; faults and stats cleared |

## Done when
- [ ] All tests pass, and `docker compose up` serves `GET http://localhost:4000/companies/C100/vendors/V-0001`.
- [ ] `test/kit/stack.ts` can start the mock (`mockErp: {}` option) and exposes `stack.mockErp.admin`.
- [ ] Commit `step 02: mock ERP`.

## Pitfalls
- Destroying the socket from inside a Hono handler: return a `Response` anyway (it won't be written), otherwise Hono logs an error. Wrap the destroy in try/catch.
- Keep-alive: `undici` may reuse a socket the mock destroyed, and a *new* request on it can fail with "other side closed" before anything is sent. The gateway classifies that as ambiguous (conservative and harmless). Don't "fix" it in the mock.
- `timeout_after_commit` with the default `hang_ms` of 30 s keeps sockets open, so `close()` must call `server.closeAllConnections()`.
- Never put an `await` inside the payment critical section (validation → commit).
