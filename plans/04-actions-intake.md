# Step 04: Actions, state machine, intake API

- **Goal:** the front door. Agents submit actions. The gateway validates and prices them, dedupes on the idempotency key, enforces one active action per target, places the hold, and writes the durable record (which is also the "enqueue", D8), all in **one transaction**. It then returns a response that replays identically forever. This step also adds the guarded state machine every later step uses, plus the read and ops endpoints that don't need the worker.
- **Depends on:** 01, 03.
- **Decisions applied:** D1 (dedupe table, client keys, payload hash), D3 (hold at admission), D7 (via `placeHold`), D8 (enqueue = insert), A7 (backpressure), A9 (stored rejections), A10 (conflict key), A16 (transition guard and event log).
- **Estimate:** ~3 h.
- **Contract:** `00-architecture.md` §5 (`actions`, `action_events`, triggers), §6 (state machine), §8 (API, action types).

## Deliverables
- `src/gateway/actions/state-machine.ts`: `ACTION_STATES`, `FINAL_STATES`, `ALLOWED` (the same pairs as the trigger), `transition()`
- `src/gateway/actions/registry.ts` + `types/pay-invoice.ts` + `types/classify-invoice-line.ts`
- `src/gateway/actions/repo.ts`: `getAction`, `getActionForTenant`, `listActions`, `getEvents`, `countPending`
- `src/gateway/actions/view.ts`: `toActionView(row)`, `toActionDetail(row, events, ledger)`
- `src/gateway/actions/submit.ts`: `submitAction()`
- `src/gateway/api/app.ts`: `createApp(ctx)`, which mounts every route and the error middleware
- `src/gateway/api/middleware/{auth,error,request-id}.ts`
- `src/gateway/api/routes/{actions,wallet,ops}.ts` (ops: only `grant` here; `queue` comes in step 06, `reconcile` in step 07)
- Tests: `test/integration/state-machine.test.ts`, `test/integration/intake.test.ts`, plus submit-level coverage of Scenarios 1, 3 and 4 (see below)

## Registry (`registry.ts`)
```ts
interface ActionTypeDef<P> {
  type: string;
  laneKind: 'erp' | 'llm';
  payloadSchema: z.ZodType<P>;          // .strict()
  conflictKey(payload: P): string | null;
}
resolveLane(tenant, def) => def.laneKind === 'erp' ? tenant.erp_lane_id : 'llm'
```
- **`pay_invoice`:** schema `{ invoice_id: z.string().min(1).max(64), amount_minor: z.number().int().positive(), currency: z.literal('INR') }.strict()`; conflict key `invoice:${invoice_id}`.
- **`classify_invoice_line`:** schema per §8; conflict key `null`.

Executors are **not** part of the registry. They live in `dispatch/executors/*` (steps 06 and 09), keyed by `type`.

## State machine (`state-machine.ts`)
`transition()` exactly as specified in `00-architecture.md` §6. Implementation notes:
- Build the `UPDATE … WHERE id = $id AND state = ANY($from::action_state[]) [AND lease_owner = $owner] RETURNING *`.
- When `to` is a final state, also set `completed_at = now()`, `lease_owner = NULL`, `lease_until = NULL`.
- Insert into `action_events (action_id, from_state, to_state, reason, details)`, using the `from_state` the row was actually in. Capture it with a CTE:
  ```sql
  WITH prev AS (SELECT state FROM actions WHERE id = $id FOR UPDATE)
  UPDATE … RETURNING …, (SELECT state FROM prev) AS prev_state
  ```
  The simpler alternative is to pass the expected `from` when it's a single state.
- Log `action.transition`.
- Also export `recordInsertEvent(tx, row, reason)` for the inserts (`∅ → QUEUED` / `∅ → REJECTED`).

## Submit (`submit.ts`): the admission transaction

```ts
submitAction(ctx, { tenant, actionType, payload, idempotencyKey }):
  Promise<{ status: number; body: unknown; replayed: boolean }>
```

**Before the transaction:**
1. `def = registry[actionType]`, else `400 unknown_action_type`.
2. `parsed = def.payloadSchema.safeParse(payload)`, else `400 invalid_request` with the zod issues. This isn't stored (A9).
3. `payloadHash = sha256Hex(canonicalJson({ action_type, payload: parsed.data }))`.
4. `price = getPrice(actionType)`, `laneId = resolveLane(tenant, def)`, `conflictKey = def.conflictKey(parsed.data)`.
5. **Fast replay path:** `SELECT … FROM actions WHERE tenant_id=$t AND idempotency_key=$k`. If found → `replayOrMismatch(row)` (below). This is an optimization only; the transaction handles the race.
6. **Backpressure (A7):** `countPending(tenant)` (`state IN ('QUEUED','DISPATCHING','UNKNOWN')`). If `≥ tenant.max_pending`, throw `429 tenant_backpressure` with `Retry-After: config.backpressure.retryAfterS`. **Not stored.**
7. `id = newActionId()`, `now = new Date()`. Build the accepted snapshot: `acceptedBody = toActionView({...row as it will be inserted, state:'QUEUED'})`.

**Transaction:**
```
BEGIN
  SAVEPOINT admit
  -- (a) claim the idempotency key and the conflict key, in one insert
  INSERT INTO actions (id, tenant_id, lane_id, action_type, idempotency_key, payload, payload_hash,
                       conflict_key, state, hold_amount, response_status, response_body, created_at, updated_at)
  VALUES (…, 'QUEUED', price.hold, 202, acceptedBody, now, now)
  ON CONFLICT ON CONSTRAINT actions_idempotency DO NOTHING
  RETURNING id;
     • 0 rows   → another request owns this key (possibly still in flight: the INSERT *waited* for it to commit).
                  ROLLBACK the transaction; SELECT the row; return replayOrMismatch(row).
     • 23505 on actions_one_active_per_target → ROLLBACK TO SAVEPOINT admit; goto REJECT(conflict)
  -- (b) hold (D7)
  hold = placeHold(tx, { tenantId, actionId: id, amount: price.hold, actionType })
     • !hold.ok → ROLLBACK TO SAVEPOINT admit; goto REJECT(insufficient_credits, {required, available})
  recordInsertEvent(tx, row, 'submitted')
COMMIT → return { status: 202, body: acceptedBody, replayed: false }

REJECT(code, details):
  -- still inside the same transaction, after rolling back to the savepoint
  rejectedBody = { error: { code, message, details }, action: toActionView({... state:'REJECTED'}) }
  INSERT INTO actions (... state 'REJECTED', conflict_key, hold_amount = price.hold?, response_status 402|409,
                       response_body rejectedBody, completed_at now)
  ON CONFLICT ON CONSTRAINT actions_idempotency DO NOTHING RETURNING id
     • 0 rows → a concurrent same-key request won: ROLLBACK; SELECT; replayOrMismatch(row)
  recordInsertEvent(tx, row, 'rejected:<code>')
COMMIT → return { status, body: rejectedBody }
```

- **Hold amount on REJECTED rows:** set `hold_amount = 0`, because nothing was held. `verifySettlements` expects `hold = 0` for REJECTED.
- **Conflict details (A10):** before inserting the REJECTED row, read the active action:
  `SELECT id, state, created_at FROM actions WHERE tenant_id=$t AND conflict_key=$c AND state IN ('QUEUED','DISPATCHING','UNKNOWN')`.
  Then `details = { conflict_key, active_action: {id, state, created_at} }`. If it finished in the meantime (a tiny race), still reject with what was read, or `active_action: null`. Don't retry the admission: one key gets one decision.
- **`replayOrMismatch(row)`:**
  - If `row.payload_hash !== payloadHash` → `422 idempotency_key_reused` with `details: { action_id: row.id }`. Not stored.
  - Otherwise return `{ status: row.response_status, body: row.response_body, replayed: true }`.
- **Error detection:** use `isPgUniqueViolation(err, 'actions_one_active_per_target')`. Kysely surfaces the pg error; check `err.code === '23505' && err.constraint === …`.

**Why this is correct under concurrency** (put this as a comment block in the code):
- **Same key, concurrent:** the second `INSERT … ON CONFLICT DO NOTHING` *blocks* on the unique index until the first commits, then gets 0 rows and replays the first's stored response. So there's one action, one hold and identical responses (Scenario 1, I7).
- **Same target, different keys:** the partial unique index admits one; the other hits 23505 and is stored as REJECTED 409 (Scenario 3, I6).
- **Same wallet:** `placeHold` is a single conditional statement (Scenario 4, I1).
- **Atomicity:** the record, the hold and the enqueue are one transaction, so a crash leaves either all of them or none (D8).

## HTTP layer
- **`auth.ts`:**
  - Tenant: `Authorization: Bearer <key>` → `sha256Hex(key)` → `tenants` lookup (cached in memory for 30 s) → `c.set('tenant', row)`. Otherwise `401 unauthorized`.
  - `opsAuth`: compares against `config.ops.apiKey` with `timingSafeEqual`.
- **`error.ts`:** maps `GatewayError` → JSON with its status (plus `Retry-After` when present); `ZodError` → `400 invalid_request`; anything else → `500 internal_error` (logged with the stack).
- **`request-id.ts`:** sets `X-Request-Id` and attaches it to the child logger.
- **`routes/actions.ts`:**
  - `POST /v1/actions`:
    - Require the `Idempotency-Key` header (1–255 chars) → `400 missing_idempotency_key`.
    - Body `{action_type, payload}` (zod).
    - Call `submitAction`.
    - Respond with `c.json(body, status)`. When `replayed`, add the `Idempotent-Replayed: true` header. When `402`/`409`, the body is already the stored rejection.
    - **Don't** re-serialize anything differently on replay: return the stored `response_body` as is.
  - `GET /v1/actions/:id`: `getActionForTenant` (404 when the action belongs to another tenant) → `toActionDetail`, including events and ledger entries.
  - `GET /v1/actions?state=&limit=`
- **`routes/wallet.ts`:** `GET /v1/wallet` (`walletView`), `GET /v1/wallet/ledger`.
- **`routes/ops.ts`:** `POST /v1/ops/tenants/:id/grant`.

## Tests

**`state-machine.test.ts`**
- Every pair in `ALLOWED` succeeds, and a representative illegal pair (`QUEUED → SUCCEEDED`, `FAILED → QUEUED`) raises the trigger error, even through raw SQL.
- A CAS with the wrong `from` returns `null`, and no event row is written.
- A CAS with the wrong `leaseOwner` returns `null`.
- Updating `response_body` or `payload` raises "immutable action column changed".
- `action_events` rows are written with the correct `from_state` and `to_state`.

**`intake.test.ts`** (through `stack.api.request`, no worker running)

| Test | Assert |
|---|---|
| Happy path | `202`; body `state: QUEUED`; row in the DB; HOLD 300; wallet `available −300`, `held +300`; one event `submitted` |
| **S1 (submit layer): same key, concurrent** | `Promise.all` of two identical submits → both `202`, **deep-equal bodies**, exactly one with `Idempotent-Replayed: true`; one action row; one HOLD |
| **S1: same key, 200 ms apart** | the second (sent 200 ms later) gets an identical body and the replay header |
| Same key, different payload | `422 idempotency_key_reused`; no new row; the first action is unchanged |
| **S4 (API level)** | tenant with 500 credits; two parallel submits on *different* invoices → one `202`, one `402` with `details.available = 200`; replaying the `402` key returns an identical `402`; `verifyWallets` = [] |
| **S3 (submit layer)** | two keys, same invoice, `Promise.all` → one `202` and one `409` whose `details.active_action.id` is the winner; the loser row is `REJECTED` with no ledger rows |
| Conflict clears after a final state | move the winner to `FAILED` via `transition` (QUEUED → FAILED is allowed) plus `settleFailure`; a new key for the same invoice → `202` |
| Backpressure | tenant `max_pending = 2` → two `202`s, the third `429 tenant_backpressure` with `Retry-After`; nothing stored for the third |
| Validation | unknown `action_type` → 400; extra payload field → 400 (strict); missing header → 400 |
| Auth and isolation | no key → 401; tenant B can't `GET` tenant A's action (404) |
| `verifySettlements` | `[]` after the whole file |

## Done when
- [ ] All of the above green, plus earlier steps still green.
- [ ] `curl` against compose: `POST /v1/actions` with `acme-dev-key` → 202; `GET` shows `QUEUED`, the events and the HOLD.
- [ ] Commit `step 04: actions + intake`.

## Pitfalls
- The idempotency INSERT must use `ON CONFLICT ON CONSTRAINT actions_idempotency`. A bare `ON CONFLICT DO NOTHING` would also swallow the conflict-key violation, and you'd lose the 409.
- A unique violation aborts the transaction, so you must `ROLLBACK TO SAVEPOINT` before continuing. Kysely supports savepoints in a transaction (`trx.savepoint('admit')` in recent versions); otherwise run `sql\`SAVEPOINT admit\``.
- Build `acceptedBody` *before* the insert, so the stored snapshot equals what the first caller receives, byte for byte.
- Never compute anything at replay time; replays echo stored data only.
