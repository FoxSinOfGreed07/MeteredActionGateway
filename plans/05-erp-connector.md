# Step 05: ERP connector and outcome taxonomy

- **Goal:** one adapter that talks to the ERP and classifies **every** response or error into `committed`, `retryable`, `permanent` or `ambiguous`. Every component downstream acts on this classification, so a wrong mapping causes damage everywhere. This is the most under-rated piece of the system.
- **Depends on:** 01, 02.
- **Decisions applied:** A8 (conservative taxonomy: when in doubt → ambiguous → UNKNOWN), D1 (reference = action id).
- **Estimate:** ~1.5 h.
- **Contract:** `00-architecture.md` §9 (ERP routes), §10 (taxonomy).

## Deliverables
- `src/gateway/erp/connector.ts`: interfaces and types
- `src/gateway/erp/outcome.ts`: **pure** classification functions
- `src/gateway/erp/http-erp-connector.ts`: the fetch-based implementation
- `src/gateway/erp/index.ts`: `connectorForLane(lane): ErpConnector`, memoized per lane id
- `test/unit/outcome.test.ts`, `test/integration/erp-connector.test.ts`

## Interfaces
```ts
type SendOutcome<T> =
  | { kind: 'committed'; value: T }
  | { kind: 'retryable'; reason: 'rate_limited' | 'unavailable' | 'unreachable'; retryAfterMs?: number }
  | { kind: 'permanent'; code: string; message: string; details?: unknown; httpStatus: number }
  | { kind: 'ambiguous'; reason: 'timeout' | 'connection_reset' | 'http_5xx' | 'unclassified'; detail?: string };

interface PostPaymentRequest { companyCode: string; invoiceId: string; amountMinor: number; currency: 'INR'; reference: string }
interface PostPaymentResult  { payment: ErpPayment; invoice: ErpInvoice }      // invoice carries the new seq (D5)

type ReadResult<T> = { status: 'ok'; data: T; seq: number } | { status: 'not_found' };
class ErpReadError extends Error {
  kind: 'rate_limited' | 'unavailable' | 'timeout' | 'error'; retryAfterMs?: number; httpStatus?: number
}

interface ErpConnector {
  readonly laneId: string;
  postPayment(req: PostPaymentRequest): Promise<SendOutcome<PostPaymentResult>>;   // never throws
  findPaymentsByReference(companyCode: string, reference: string): Promise<ErpPayment[]>; // throws ErpReadError
  getVendor(companyCode: string, vendorId: string): Promise<ReadResult<ErpVendor>>;      // throws ErpReadError
  getInvoice(companyCode: string, invoiceId: string): Promise<ReadResult<ErpInvoice>>;   // throws ErpReadError
}
```
The ERP types mirror §9. Validate response bodies with zod. An unexpected body on a `2xx` write is still
`committed`, but log a warning. (A 2xx means the ERP says it committed; trust the status, not our parser.)

## Classification (`outcome.ts`, pure, fully unit-tested)
```ts
classifySendResponse(status: number, headers: Headers, body: unknown): SendOutcome<unknown>
classifySendError(err: unknown): SendOutcome<never>
parseRetryAfter(headerValue: string | null): number | undefined   // seconds or an HTTP date → ms
```
- **Response mapping:** exactly the table in §10. For `permanent`: `code = body.code ?? 'HTTP_<status>'`, `message = body.message ?? statusText`, and `details = body` (so `details.invoice` comes through for 409/422).
- **Error mapping:** walk `err` and `err.cause` (undici nests errors).
  - `err.name === 'TimeoutError'` (from `AbortSignal.timeout`) → `ambiguous/timeout`.
  - `cause.code` in `ECONNREFUSED | ENOTFOUND | EAI_AGAIN | UND_ERR_CONNECT_TIMEOUT` → `retryable/unreachable`.
  - `cause.code` in `ECONNRESET | UND_ERR_SOCKET | EPIPE`, or a message matching `/other side closed|socket hang up/i` → `ambiguous/connection_reset`.
  - Anything else → `ambiguous/unclassified`, with `detail = String(err)`.
- Document every row's reasoning in a comment. The review will ask "why is 503 retryable but 504 ambiguous?"
  - **503:** the service refused before processing (S6).
  - **504:** a gateway gave up waiting on an upstream that may still be processing.

## HTTP implementation
- Use `fetch(url, { method, headers: {'content-type':'application/json'}, body, signal: AbortSignal.timeout(lane.request_timeout_ms) })`.
- **Writes:** `postPayment` posts `{invoice_id, amount_minor, currency, reference}` to `${base}/companies/${cc}/payments`, then `classifySendResponse` or `classifySendError`. It **never throws**.
- **Reads:**
  - `404` → `not_found`; `200` → `ok`, with `seq` from the body.
  - `429` → throw `ErpReadError('rate_limited', retryAfterMs)`; `503` → `'unavailable'`.
  - A timeout → `'timeout'`; anything else → `'error'`.
  - Reads are safe to repeat, so there is no ambiguity class for them.
- `findPaymentsByReference` → `GET ${base}/companies/${cc}/payments?reference=${encodeURIComponent(ref)}` → `payments[]`.
- The connector does **not** rate-limit itself. Callers acquire a token first (step 06 for sends and reconciler lookups, step 08 for cache misses). Put this rule in a top-of-file comment.

## Tests
**`test/unit/outcome.test.ts`:** a table-driven test covering every row of §10, including:
- 201 → committed; 429 with `Retry-After: 3` → retryable, 3000 ms; 503 → retryable/unavailable.
- 409 with `{code:'INVOICE_ALREADY_PAID', invoice}` → permanent with `details.invoice`; 422 `AMOUNT_MISMATCH` → permanent.
- 500/502/504 → ambiguous/http_5xx.
- A synthetic `TimeoutError` → ambiguous/timeout; a `TypeError` with cause code `ECONNREFUSED` → retryable/unreachable; cause `UND_ERR_SOCKET` → ambiguous/connection_reset; `new Error('weird')` → ambiguous/unclassified.
- `parseRetryAfter('2')` = 2000, an HTTP-date value parses, garbage → undefined.

**`test/integration/erp-connector.test.ts`:** against the in-process mock (`startStack({ mockErp: {} })`), with lane `request_timeout_ms: 300`.

| Fault | Expected `postPayment` outcome | Mock primary state |
|---|---|---|
| none | committed (invoice seq increased) | 1 payment |
| `status_429` `retry_after_s: 2` | retryable/rate_limited, 2000 ms | 0 |
| `status_503` | retryable/unavailable | 0 |
| `timeout_after_commit` `hang_ms: 2000` | ambiguous/timeout | **1** |
| `drop_after_commit` | ambiguous/connection_reset | **1** |
| `error_500_after_commit` | ambiguous/http_5xx | **1** |
| `drop_before_commit` | ambiguous/connection_reset | **0** (ambiguity is correct: we can't tell) |
| `latency` 1000 ms | ambiguous/timeout | 0 at return, **1 about 1 s later** (late commit) |
| amount mismatch | permanent AMOUNT_MISMATCH | 0 |
| paid invoice | permanent INVOICE_ALREADY_PAID with `details.invoice.status = 'PAID'` | unchanged |
| mock stopped (closed port) | retryable/unreachable | — |

Reads: `getVendor` ok/not_found; a `status_429` on GET throws `ErpReadError('rate_limited')`; `findPaymentsByReference` returns 0, 1 or 2 payments (the test posts the same reference twice on two invoices).

## Done when
- [ ] Unit and integration tests green.
- [ ] Commit `step 05: ERP connector`.

## Pitfalls
- `AbortSignal.timeout` throws a `DOMException` named `TimeoutError`, not an `AbortError`. Check `name`.
- Don't add retries inside the connector. Retry policy belongs to the dispatcher and reconciler, which know the action's state.
