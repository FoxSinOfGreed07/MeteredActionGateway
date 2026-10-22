# Step 03: Ledger and wallet

- **Goal:** money that can't go wrong. An append-only ledger, a wallet projection that changes only through it, hold/capture/release with an atomic conditional update, pricing, and verification that proves the projection and the settlements are consistent.
- **Depends on:** 01. Independent of 02, so the two can be built in parallel.
- **Decisions applied:** D3 (hold/capture), D7 (conditional update on a projection; the ledger is the truth), A11 (prices), A12 (holds never auto-expire; that rule is enforced in step 06).
- **Estimate:** ~2 h.
- **Contract:** `00-architecture.md` §5 (`wallets`, `ledger_entries`, `price_list`) and §7 (rules).

## Deliverables
- `src/gateway/wallet/ledger.ts`: the only module that writes `ledger_entries` or `wallets`
- `src/gateway/wallet/wallet.ts`: read models
- `src/gateway/wallet/pricing.ts`
- `src/gateway/wallet/verify.ts`
- `scripts/seed.ts`: switched to `grant()`
- `test/integration/ledger.test.ts`, `test/integration/wallet-concurrency.test.ts`

## API (`ledger.ts`)
Every function takes a **transaction** (`Tx`) and never opens its own, so the caller decides atomicity: the same
transaction as the action insert or the state transition.

```ts
type HoldResult = { ok: true; available: number; held: number } | { ok: false; available: number };

grant(tx, { tenantId, amount, reason }): Promise<void>
placeHold(tx, { tenantId, actionId, amount, actionType }): Promise<HoldResult>
capture(tx, { tenantId, actionId, amount, actionType }): Promise<void>
release(tx, { tenantId, actionId, amount, reasonCode, message }): Promise<void>

// convenience used by settle.ts (step 06)
settleSuccess(tx, action: ActionRow, captureAmount: number): Promise<void>
  // capture(captureAmount); if captureAmount < action.hold_amount → release(rest, 'unused_hold')
settleFailure(tx, action: ActionRow, reasonCode: string, message: string): Promise<void>
  // release(action.hold_amount, reasonCode, message)
```

### SQL, exactly (D7)
**placeHold:**
```sql
UPDATE wallets
   SET available = available - $amount, held = held + $amount, updated_at = now()
 WHERE tenant_id = $tenantId AND available >= $amount
RETURNING available, held;
```
- **0 rows:** read `available` (a plain `SELECT`; no lock is needed for the error message) and return `{ok:false, available}`. Do **not** insert a ledger row.
- **1 row:** insert `ledger_entries (kind 'HOLD', amount, available_delta -amount, held_delta +amount, reason 'hold:<action_type>', action_id)` and return `{ok:true,…}`.

**capture:** `UPDATE wallets SET held = held - $a … WHERE tenant_id = $t AND held >= $a`. Zero rows means an
invariant violation: throw `GatewayError('ledger_invariant', 500)`. Otherwise insert `CAPTURE` (`0`, `-a`).

**release:** `UPDATE wallets SET held = held - $a, available = available + $a … WHERE held >= $a`. Zero rows → throw.
Otherwise insert `RELEASE` (`+a`, `-a`), reason `release:<reasonCode>: <message>`, truncated to 500 characters.

**grant:** `INSERT INTO wallets … ON CONFLICT (tenant_id) DO UPDATE SET available = wallets.available + excluded.available`,
plus a `GRANT` row with a NULL `action_id`.

The unique index `ledger_one_kind_per_action` makes double capture or double release impossible. Let the
`23505` propagate: it signals a bug, and the caller's transaction rolls back.

## `pricing.ts`
- `getPrice(db, actionType) → { hold, capture, cacheHitCapture | null }`, cached in memory for 60 s (the price list is small and static).
- A missing price throws `GatewayError('unknown_action_type', 400)`.

## `wallet.ts`
- `getWallet(db, tenantId)` → `{ available, held }` (the projection).
- `deriveWallet(db, tenantId)` → `SELECT COALESCE(SUM(available_delta),0), COALESCE(SUM(held_delta),0) FROM ledger_entries WHERE tenant_id = $1`.
- `walletView(db, tenantId)` → `{ tenant_id, available, held, derived, consistent }` (used by `GET /v1/wallet` in step 04).
- `listLedger(db, tenantId, limit)`.

## `verify.ts`
- **`verifyWallets(db)`** → `Array<{ tenant_id, projection: {available, held}, ledger: {available, held} }>`, containing only mismatches:
  ```sql
  SELECT w.tenant_id, w.available, w.held,
         COALESCE(SUM(l.available_delta),0) AS l_available, COALESCE(SUM(l.held_delta),0) AS l_held
    FROM wallets w LEFT JOIN ledger_entries l USING (tenant_id)
   GROUP BY w.tenant_id, w.available, w.held
  HAVING w.available <> COALESCE(SUM(l.available_delta),0) OR w.held <> COALESCE(SUM(l.held_delta),0);
  ```
- **`verifySettlements(db)`** → `Array<{ action_id, state, hold_amount, hold, capture, release, problem }>`:
  ```sql
  WITH per_action AS (
    SELECT a.id, a.state, a.hold_amount,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='HOLD'),0)    AS hold,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='CAPTURE'),0) AS capture,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='RELEASE'),0) AS release
      FROM actions a LEFT JOIN ledger_entries l ON l.action_id = a.id
     GROUP BY a.id)
  SELECT * FROM per_action WHERE NOT (
       (state = 'REJECTED' AND hold = 0 AND capture = 0 AND release = 0)
    OR (state IN ('QUEUED','DISPATCHING','UNKNOWN') AND hold = hold_amount AND capture = 0 AND release = 0)
    OR (state = 'SUCCEEDED' AND hold = hold_amount AND capture > 0 AND capture + release = hold)
    OR (state = 'FAILED' AND hold = hold_amount AND capture = 0 AND release = hold));
  ```
- **`rebuildWalletProjection(db, tenantId)`** (stretch, used by an ops script): `UPDATE wallets SET available = derived, held = derived`. It's never needed in normal operation; it exists to show that "the ledger wins".

> Step 03 runs before the `actions` code exists. The ledger tests insert minimal `actions` rows through a test
> helper `insertBareAction(db, {tenantId, holdAmount, state:'QUEUED'})`, which fills the NOT NULL columns
> with dummy values and a dummy `response_body`. Put it in `test/kit/fixtures.ts`.

## Tests

**`ledger.test.ts`**
- Grant 1000 → hold 300 → capture 300: wallet `{700, 0}`, and the derived wallet matches.
- Hold 300 → release: wallet back to `{1000, 0}`. The ledger shows HOLD and RELEASE, and the release reason contains the reason code.
- Partial settlement: hold 20 → `settleSuccess(…, 2)` → CAPTURE 2 + RELEASE 18 (reason `release:unused_hold`).
- Double capture on the same action throws `23505`, and the wallet is unchanged because the transaction rolled back.
- `UPDATE ledger_entries` and `DELETE` both throw (append-only).
- Insert with mismatched deltas (`HOLD` with `available_delta = +5`): the CHECK violation throws.
- Tamper: `UPDATE wallets SET available = available + 1` directly → `verifyWallets` reports that tenant. (Do this inside a test database of its own; it's throwaway.)
- `verifySettlements` flags a `SUCCEEDED` action that has only a HOLD.

**`wallet-concurrency.test.ts` (Scenario 4, domain level)**
- **Scenario 4 at the domain level:** wallet 500; two transactions in parallel (separate pool connections, `Promise.all`), each inserting a bare action and calling `placeHold(300)`. Assert exactly one `ok: true`, one `ok: false` with `available = 200`, final wallet `{200, 300}`, exactly one HOLD row, and `verifyWallets` = [].
- **Stress:** wallet 3,000, then 50 parallel holds of 300. Assert exactly 10 succeed, `available = 0`, and that `available` was never negative: the CHECK constraint would have thrown, so assert no transaction failed with a check violation and that `ok:false` results are exactly 40.
- **Interleaving with releases:** wallet 600; 10 parallel tasks, each doing hold 300 → release 300 → hold 300. No errors, and the final state is consistent (`verifyWallets` = []).

## Done when
- [ ] Tests green, and `scripts/seed.ts` uses `grant()` (re-running the seed doesn't double-grant).
- [ ] No other module issues `INSERT`/`UPDATE` against `ledger_entries` or `wallets`. Check with `grep -rn "ledger_entries\|wallets" src | grep -v wallet/`; only reads in `verify`/`wallet.ts` are allowed.
- [ ] Commit `step 03: ledger and wallet`.

## Pitfalls
- Run each parallel hold on its **own** transaction and connection. `Promise.all` over a single transaction serializes everything and proves nothing.
- Don't "optimise" `placeHold` into SELECT-then-UPDATE. The whole point of D7 is that the check and the write are a single statement.
