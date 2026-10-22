# 00: Architecture reference (single source of truth)

Every step plan refers back here for **names, schemas and contracts**. If a step needs something that isn't
here, add it here first and then use it, so table, column, state, endpoint and environment-variable names
never drift. The decisions behind every choice are in `../decisions/recommended.md` (D1–D8, A1–A17).

Contents:
1. System overview
2. Processes, ports, one-command startup
3. Repository layout
4. Conventions (units, ids, naming)
5. Postgres schema (migration `0001_init.sql`)
6. Action state machine
7. Wallet and ledger rules
8. Gateway HTTP API
9. Mock ERP contract
10. ERP outcome taxonomy
11. Redis key schema and Lua scripts
12. Configuration (environment and runtime)
13. Invariants (what must always hold, where it's enforced, where it's tested)
14. Seed data

---

## 1. System overview

```
                 ┌──────────────────────────────── gateway ─────────────────────────────────┐
  agents ──HTTP──▶ api process (Hono)                                                       │
  (tenants)      │  POST /v1/actions ── submit tx: action row + HOLD + "enqueue" (same tx)  │
                 │  GET  /v1/actions/:id, /v1/wallet, /v1/erp/vendors|invoices/:id (cache)   │
                 │  POST /v1/webhooks/erp/:lane  ◀─────────── webhooks (delayed, seq) ──┐    │
                 │  GET  /v1/ops/queue, POST /v1/ops/reconcile                          │    │
                 │                                                                      │    │
                 │ worker process                                                       │    │
                 │  dispatcher per lane ── fair SKIP LOCKED claim ── token bucket ──┐   │    │
                 │  recovery loop (expired DISPATCHING leases → UNKNOWN)            │   │    │
                 │  reconciler (UNKNOWN → lookup by reference → settle)             │   │    │
                 └──────────────────────────────────────────────────────────────────┼───┼────┘
                        │                         │                                 │   │
                  Postgres 17               Redis 7 (no persistence)          HTTP  ▼   │
                  actions (= queue)         token buckets, cooldowns,        ┌──────────┴──┐
                  action_events             cache entries + HWM,             │  mock-erp   │
                  ledger_entries, wallets   coalescing leases                │ (SAP-style) │
                  lanes, lane_health, ...                                    │ faults, 429 │
                                                                             │ stale reads │
                                                                             └─────────────┘
```

**The principle that settles where state lives:** Redis holds nothing whose loss could lose an action or
money. Anything that protects money lives in Postgres: actions, the ledger, wallets, events, and the
lane-health stale flag.

## 2. Processes, ports, one-command startup

| Service (compose) | Entry point | Port | Notes |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | 5432 | user/pass/db = `gateway`/`gateway`/`gateway` |
| `redis` | `redis:7-alpine`, `--save "" --appendonly no` | 6379 | persistence deliberately off |
| `migrate` | `scripts/migrate.ts`, then `scripts/seed.ts` | — | one-shot, exits 0; api and worker wait for it |
| `mock-erp` | `src/mock-erp/main.ts` | 4000 | separate service; sends webhooks to `api` |
| `api` | `src/gateway/api-main.ts` | 3000 | Hono HTTP |
| `worker` | `src/gateway/worker-main.ts` | — | dispatchers, recovery, reconciler |

**One command:** `docker compose up --build`. The services start in dependency order: postgres and redis
become healthy, migrate and seed run and complete, then mock-erp, api and worker start.

In **tests**, the mock ERP, the api app and the worker loops all run **inside the test process**
(see `01-foundation.md` → test kit). Only Postgres and Redis come from compose:
`docker compose up -d postgres redis`.

## 3. Repository layout

```
/
├─ package.json  pnpm-lock.yaml  tsconfig.json  biome.json  vitest.config.ts
├─ Dockerfile  docker-compose.yml  .env.example  .gitignore
├─ README.md  DECISIONS.md            ← final deliverables (step 11)
├─ decisions/ recommended.md locked.md
├─ plans/     (this directory)
├─ migrations/ 0001_init.sql
├─ scripts/   migrate.ts seed.ts inject-fault.ts reconcile.ts demo-timeout.ts bench-pg-queue.ts
├─ src/
│  ├─ shared/      config.ts logger.ts canonical-json.ts hash.ts sleep.ts errors.ts backoff.ts ids.ts
│  ├─ db/          kysely.ts schema.ts migrate.ts tx.ts
│  ├─ redis/       client.ts keys.ts scripts.ts  lua/{token_bucket,cooldown_extend,cache_get,cache_fill,cache_invalidate}.lua
│  ├─ mock-erp/    main.ts app.ts state.ts seed.ts prng.ts faults.ts rate-limit.ts webhooks.ts stats.ts types.ts
│  │               admin-client.ts (typed client for /__admin, used by tests AND scripts)
│  │               routes/erp.ts routes/admin.ts
│  └─ gateway/
│     ├─ api-main.ts  worker-main.ts  context.ts
│     ├─ api/        app.ts middleware/{auth,error,request-id}.ts
│     │              routes/{actions,wallet,erp-reads,webhooks,ops}.ts
│     ├─ actions/    registry.ts state-machine.ts repo.ts submit.ts view.ts
│     │              types/{pay-invoice,classify-invoice-line}.ts
│     ├─ wallet/     ledger.ts wallet.ts pricing.ts verify.ts
│     ├─ erp/        connector.ts http-erp-connector.ts outcome.ts
│     ├─ dispatch/   lanes.ts rate-limiter.ts cooldown.ts claim.ts dispatcher.ts settle.ts recovery.ts
│     │              expiry.ts executors/{index,pay-invoice,classify-invoice-line}.ts
│     ├─ reconcile/  resolver.ts trust.ts witness.ts lane-health.ts invariants.ts run-once.ts
│     ├─ cache/      budgets.ts keys.ts cached-reader.ts singleflight.ts coalesce-lease.ts
│     │              webhook-ingest.ts hooks.ts
│     └─ llm/        taxonomy.ts normalize.ts classifier.ts fake-classifier.ts anthropic-classifier.ts
│                    classification-cache.ts
└─ test/
   ├─ kit/         global-setup.ts db.ts redis.ts stack.ts clients.ts time.ts wait.ts fixtures.ts invariants.ts
   ├─ unit/        (no infra)
   ├─ integration/ (Postgres + Redis)
   └─ scenarios/   s1-…s8-…test.ts  x-crash-recovery.test.ts  x-stale-window.test.ts  x-abandoned-commit.test.ts
```

## 4. Conventions

- **Units.** Durations are integer milliseconds, and every duration name ends in `_ms` (SQL/JSON) or `Ms` (TS).
  Credits are integer `bigint` in SQL, parsed to `number` with a safe-integer check. Money is integer minor
  units (`amount_minor`, paise), currency `INR`.
- **Naming.** SQL and JSON API fields use `snake_case`, and Kysely rows keep `snake_case` (no camelCase plugin).
  TypeScript variables and functions use `camelCase`.
- **Ids.**
  - Action id: UUID v4, generated in the app with `crypto.randomUUID()` *before* insert, so the response
    snapshot can include it. **The action id is the ERP `reference`.**
  - Tenant ids: short slugs (`acme`).
  - Lane ids: slugs (`sap-main`, `llm`).
  - ERP ids: `V-0001` (vendor), `INV-C100-00001` (invoice), `PAY-000001` (payment).
- **Time source.** Lease, next-attempt and trust timestamps are computed in SQL with `now()`, which is the
  database clock. Redis scripts use `redis.call('TIME')`. Node time is used only for logs and for durations
  passed into SQL as parameters.
- **Imports.** ESM with NodeNext resolution, so relative imports end in `.js`.
- **Errors.** Domain errors are `GatewayError(code, httpStatus, message, details?)`. They're rendered as
  `{ "error": { "code", "message", "details" } }`.
- **Logging.** pino JSON. Always include `tenant_id`, `action_id` and `lane_id` when known. Every transition
  logs at info level as `action.transition` with `{from, to, reason}`.

## 5. Postgres schema: `migrations/0001_init.sql`

Write this file exactly; later changes go in new migrations. Column comments explain intent.

```sql
-- ===== enums =====
CREATE TYPE action_state AS ENUM ('QUEUED','DISPATCHING','UNKNOWN','SUCCEEDED','FAILED','REJECTED');
CREATE TYPE ledger_kind  AS ENUM ('GRANT','HOLD','CAPTURE','RELEASE','REFUND');

-- ===== lanes: one outbound dependency (an ERP endpoint, or the LLM provider) =====
CREATE TABLE lanes (
  id                 text PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN ('erp','llm')),
  base_url           text,                                   -- erp lanes only
  rate_per_sec       integer NOT NULL CHECK (rate_per_sec > 0),
  burst              integer NOT NULL CHECK (burst > 0),
  max_in_flight      integer NOT NULL CHECK (max_in_flight > 0),
  request_timeout_ms integer NOT NULL CHECK (request_timeout_ms > 0),
  lease_ms           integer NOT NULL,
  max_read_lag_ms    integer NOT NULL DEFAULT 0 CHECK (max_read_lag_ms >= 0),
  webhook_secret     text,                                   -- HMAC secret (A17); NULL = not verified
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (lease_ms > request_timeout_ms)
);

-- stale-read suspicion protects money (D2), so it lives in Postgres, not Redis
CREATE TABLE lane_health (
  lane_id               text PRIMARY KEY REFERENCES lanes(id),
  stale_suspected_until timestamptz,
  last_evidence         jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  api_key_hash     text NOT NULL UNIQUE,                     -- sha256 hex of the bearer key
  erp_lane_id      text NOT NULL REFERENCES lanes(id),
  erp_company_code text NOT NULL,
  max_pending      integer NOT NULL DEFAULT 10000,           -- backpressure cap (A7)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (erp_lane_id, erp_company_code)
);

CREATE TABLE price_list (
  action_type              text PRIMARY KEY,
  hold_amount              bigint NOT NULL CHECK (hold_amount > 0),
  capture_amount           bigint NOT NULL CHECK (capture_amount > 0 AND capture_amount <= hold_amount),
  cache_hit_capture_amount bigint CHECK (cache_hit_capture_amount > 0 AND cache_hit_capture_amount <= hold_amount)
);

-- projection of the ledger (D7); the ledger is the truth
CREATE TABLE wallets (
  tenant_id  text PRIMARY KEY REFERENCES tenants(id),
  available  bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  held       bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== actions: durable record AND the queue (D8) =====
CREATE TABLE actions (
  id                    uuid PRIMARY KEY,                    -- also the ERP reference
  tenant_id             text NOT NULL REFERENCES tenants(id),
  lane_id               text NOT NULL REFERENCES lanes(id),
  action_type           text NOT NULL,
  idempotency_key       text NOT NULL,
  payload               jsonb NOT NULL,
  payload_hash          text NOT NULL,                       -- sha256(canonical_json({action_type,payload}))
  conflict_key          text,                                -- e.g. 'invoice:INV-C100-00001' (A10)
  state                 action_state NOT NULL,
  hold_amount           bigint NOT NULL DEFAULT 0,
  captured_amount       bigint,
  dispatch_count        integer NOT NULL DEFAULT 0,          -- claims into DISPATCHING (sends attempted)
  retry_count           integer NOT NULL DEFAULT 0,          -- not-committed retries (429/503/unreachable)
  ambiguous_count       integer NOT NULL DEFAULT 0,          -- times entered UNKNOWN
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  lease_owner           text,
  lease_until           timestamptz,
  dispatched_at         timestamptz,                         -- last claim time
  unknown_since         timestamptz,
  trust_not_found_after timestamptz,                         -- D2 rule (a)
  not_found_count       integer NOT NULL DEFAULT 0,          -- consecutive trusted not-founds, D2 rule (d)
  next_reconcile_at     timestamptz,
  reconcile_attempts    integer NOT NULL DEFAULT 0,
  result                jsonb,                               -- ERP payment / classification result
  failure_code          text,
  failure_message       text,
  confirmed_via         text CHECK (confirmed_via IN ('response','reconcile')),
  response_status       integer NOT NULL,                    -- stored submit response (immutable, A9)
  response_body         jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  CONSTRAINT actions_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX actions_one_active_per_target ON actions (tenant_id, conflict_key)
  WHERE conflict_key IS NOT NULL AND state IN ('QUEUED','DISPATCHING','UNKNOWN');
CREATE INDEX actions_ready_idx      ON actions (lane_id, tenant_id, next_attempt_at) WHERE state = 'QUEUED';
CREATE INDEX actions_lease_idx      ON actions (lease_until)       WHERE state = 'DISPATCHING';
CREATE INDEX actions_unknown_idx    ON actions (next_reconcile_at) WHERE state = 'UNKNOWN';
CREATE INDEX actions_pending_idx    ON actions (tenant_id)         WHERE state IN ('QUEUED','DISPATCHING','UNKNOWN');
CREATE INDEX actions_witness_idx    ON actions (lane_id, dispatched_at)
  WHERE state = 'SUCCEEDED' AND confirmed_via = 'response';

CREATE TABLE action_events (
  id         bigserial PRIMARY KEY,
  action_id  uuid NOT NULL REFERENCES actions(id),
  from_state action_state,                                   -- NULL on insert
  to_state   action_state NOT NULL,
  reason     text NOT NULL,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_events_action_idx ON action_events (action_id, id);

-- ===== ledger: append-only, with signed deltas per bucket =====
CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(id),
  action_id       uuid REFERENCES actions(id),
  kind            ledger_kind NOT NULL,
  amount          bigint NOT NULL CHECK (amount > 0),
  available_delta bigint NOT NULL,
  held_delta      bigint NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'GRANT'   AND available_delta =  amount AND held_delta = 0) OR
    (kind = 'HOLD'    AND available_delta = -amount AND held_delta = amount) OR
    (kind = 'CAPTURE' AND available_delta = 0       AND held_delta = -amount) OR
    (kind = 'RELEASE' AND available_delta =  amount AND held_delta = -amount) OR
    (kind = 'REFUND'  AND available_delta =  amount AND held_delta = 0)
  ),
  CHECK (kind IN ('GRANT','REFUND') OR action_id IS NOT NULL)
);
CREATE UNIQUE INDEX ledger_one_kind_per_action ON ledger_entries (action_id, kind) WHERE action_id IS NOT NULL;
CREATE INDEX ledger_tenant_idx ON ledger_entries (tenant_id, id);

-- ===== fairness cursor (A5) =====
CREATE TABLE lane_tenant_cursor (
  lane_id            text NOT NULL REFERENCES lanes(id),
  tenant_id          text NOT NULL REFERENCES tenants(id),
  last_dispatched_at timestamptz NOT NULL,
  PRIMARY KEY (lane_id, tenant_id)
);

-- ===== webhook log (D5): durable, deduped =====
CREATE TABLE erp_events (
  id           bigserial PRIMARY KEY,
  lane_id      text NOT NULL REFERENCES lanes(id),
  event_id     text NOT NULL,
  company_code text NOT NULL,
  object_type  text NOT NULL CHECK (object_type IN ('vendor','invoice','payment')),
  object_id    text NOT NULL,
  seq          bigint NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lane_id, event_id)
);

-- ===== LLM classification cache (A13): immutable =====
CREATE TABLE classification_cache (
  cache_key        text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants(id),
  input            jsonb NOT NULL,
  result           jsonb NOT NULL,
  model            text NOT NULL,
  prompt_version   text NOT NULL,
  source_action_id uuid REFERENCES actions(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ===== guards =====
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON action_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON action_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER classification_immutable BEFORE UPDATE OR DELETE ON classification_cache
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION guard_action_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY[
    'QUEUED>DISPATCHING', 'QUEUED>FAILED',
    'DISPATCHING>SUCCEEDED', 'DISPATCHING>FAILED', 'DISPATCHING>QUEUED', 'DISPATCHING>UNKNOWN',
    'UNKNOWN>SUCCEEDED', 'UNKNOWN>QUEUED', 'UNKNOWN>FAILED'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('QUEUED','REJECTED') THEN
      RAISE EXCEPTION 'actions must be inserted as QUEUED or REJECTED, got %', NEW.state;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.lane_id <> OLD.lane_id
     OR NEW.action_type <> OLD.action_type OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.payload <> OLD.payload OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.conflict_key IS DISTINCT FROM OLD.conflict_key OR NEW.hold_amount <> OLD.hold_amount
     OR NEW.response_status <> OLD.response_status OR NEW.response_body <> OLD.response_body
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable action column changed (action %)', OLD.id;
  END IF;
  IF NEW.state <> OLD.state AND NOT ((OLD.state::text || '>' || NEW.state::text) = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal transition % -> % (action %)', OLD.state, NEW.state, OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER actions_guard BEFORE INSERT OR UPDATE ON actions
  FOR EACH ROW EXECUTE FUNCTION guard_action_row();
CREATE TRIGGER actions_no_delete BEFORE DELETE ON actions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
```

`src/db/schema.ts` holds the hand-written Kysely `Database` interface, mirroring this DDL column for column.
Use `Generated<>` for defaulted columns and `ColumnType<Date, Date | string, Date | string>` for timestamps.

## 6. Action state machine

```
              submit (hold placed)                       submit refused (402 credits / 409 conflict)
   (none) ───────────────────────────▶ QUEUED           (none) ───────────────────────────▶ REJECTED ■
                                         │  ▲  ▲
                    claim (CAS + lease)  │  │  │ not committed (429/503/unreachable) → next_attempt_at
                                         ▼  │  │
                                     DISPATCHING ────────── ERP committed ───────────▶ SUCCEEDED ■  (CAPTURE [+RELEASE rest])
                                         │  │
                     permanent 4xx       │  └── ambiguous (timeout / reset / 5xx≠503) or lease expired
                                         ▼                         ▼
                                      FAILED ■ (RELEASE)        UNKNOWN ── lookup: found ─────────▶ SUCCEEDED ■
                                         ▲                         │  ── trusted not-found ───────▶ QUEUED (same reference)
                                         └── trusted not-found ────┘     (after ambiguous_count ≥ 3 → FAILED + RELEASE)
   QUEUED ── never sent for 24 h (expiry) ──▶ FAILED (RELEASE)                         ■ = final state
```

| From → To | Trigger | Wallet effect | `action_events.reason` |
|---|---|---|---|
| ∅ → QUEUED | submit accepted | `HOLD hold_amount` | `submitted` |
| ∅ → REJECTED | submit refused: credits or conflict | none | `rejected:insufficient_credits` / `rejected:conflict` |
| QUEUED → DISPATCHING | dispatcher claim (CAS + lease) | none | `claimed` |
| QUEUED → FAILED | expiry: never sent for `queued_max_age_ms` | `RELEASE` | `expired_unsent` |
| DISPATCHING → SUCCEEDED | ERP 2xx (fenced by lease owner) | `CAPTURE` (+ `RELEASE` remainder) | `erp_committed` |
| DISPATCHING → QUEUED | retryable, not committed | none | `retry:rate_limited` / `retry:unavailable` / `retry:unreachable` (LLM: `retry:llm_error`) |
| DISPATCHING → FAILED | permanent error | `RELEASE` | `erp_rejected:<CODE>` / `llm_failed:<code>` |
| DISPATCHING → UNKNOWN | ambiguous outcome | none (hold kept) | `ambiguous:timeout` / `ambiguous:connection_reset` / `ambiguous:http_5xx` / `ambiguous:unclassified` |
| DISPATCHING → UNKNOWN | lease expired (crash; recovery loop) | none | `lease_expired` |
| DISPATCHING → QUEUED | lease expired, LLM lane (no external side effect) | none | `lease_expired_requeue` |
| UNKNOWN → SUCCEEDED | lookup found it (or a late worker reports a committed response) | `CAPTURE` | `reconciled:found` / `late_response:committed` |
| UNKNOWN → QUEUED | trusted not-found, `ambiguous_count < 3` | none | `reconciled:not_found_redispatch` |
| UNKNOWN → FAILED | trusted not-found, `ambiguous_count ≥ 3` | `RELEASE` | `reconciled:not_found_give_up` |

**Every** transition goes through `transition()` (`src/gateway/actions/state-machine.ts`). It does the following:

```ts
transition(tx, {
  actionId, from: ActionState[], to: ActionState,
  patch?: Partial<ActionRow>,         // extra columns to set
  leaseOwner?: string,                // fencing: also require lease_owner = $leaseOwner
  reason: string, details?: unknown,
}): Promise<ActionRow | null>         // null = CAS lost (state or owner changed): caller must not settle
```
It runs `UPDATE actions SET state=$to, updated_at=now(), …patch WHERE id=$id AND state = ANY($from)
[AND lease_owner=$owner] RETURNING *`, and on success inserts the matching `action_events` row in the same
transaction. Ledger effects are written by the caller **in the same transaction**, through `settle.ts`.

**Final states** are `SUCCEEDED`, `FAILED` and `REJECTED`. On entering one, set `completed_at = now()` and
clear `lease_owner`/`lease_until`.

## 7. Wallet and ledger rules

- Each tenant has two buckets: `available` and `held`. Total = available + held. A `CAPTURE` removes credits from held for good.
- Every movement is a `ledger_entries` row. `wallets` is updated **in the same transaction** by the same function (`src/gateway/wallet/ledger.ts`):

| Op | Ledger row | Wallet statement (must affect exactly 1 row, otherwise roll back) |
|---|---|---|
| grant | `GRANT +a` | `UPDATE wallets SET available = available + $a` (`INSERT … ON CONFLICT` for a new tenant) |
| hold | `HOLD a` | `UPDATE wallets SET available = available - $a, held = held + $a WHERE tenant_id = $t AND available >= $a RETURNING available, held`; **0 rows ⇒ insufficient credits** (D7) |
| capture | `CAPTURE a` | `UPDATE wallets SET held = held - $a WHERE tenant_id = $t AND held >= $a`; 0 rows ⇒ invariant violation (throw) |
| release | `RELEASE a` | `UPDATE wallets SET held = held - $a, available = available + $a WHERE tenant_id = $t AND held >= $a`; 0 rows ⇒ invariant violation (throw) |

- Per action, `HOLD`, `CAPTURE` and `RELEASE` each appear **at most once** (enforced by a unique index). Settlement rules:
  - `SUCCEEDED`: `CAPTURE c` where `c ≤ hold`, plus `RELEASE (hold − c)` when `c < hold`.
  - `FAILED`: `RELEASE hold`.
  - Non-final: `HOLD` only.
  - `REJECTED`: no entries.
- Ledger `reason` strings: `hold:<action_type>`, `capture:<action_type>`, `release:<failure_code or 'unused_hold'>: <message>`, `grant:<free text>`.
- **Derived balance** = `SUM(available_delta)` and `SUM(held_delta)` per tenant. `verifyWallets()` compares these with `wallets` (step 03).

## 8. Gateway HTTP API (port 3000)

**Auth:** tenant routes require `Authorization: Bearer <tenant_api_key>`. The key is matched by sha256 against
`tenants.api_key_hash`. Ops routes require `Authorization: Bearer <OPS_API_KEY>`. Webhooks are authenticated by HMAC (A17).

**Error body:** `{ "error": { "code": string, "message": string, "details"?: object } }`.

| Code | HTTP | When |
|---|---|---|
| `unauthorized` | 401 | missing or bad key |
| `invalid_request` | 400 | malformed body or headers; zod issues in `details` |
| `unknown_action_type` | 400 | `action_type` not in the registry |
| `missing_idempotency_key` | 400 | no `Idempotency-Key` header (1–255 chars) |
| `idempotency_key_reused` | 422 | same key, different `payload_hash` (not stored) |
| `insufficient_credits` | 402 | hold failed (stored as REJECTED) |
| `conflict_active_action` | 409 | conflict key already active (stored as REJECTED) |
| `tenant_backpressure` | 429 | pending ≥ `max_pending` (not stored); `Retry-After` header |
| `not_found` | 404 | unknown action id (or one belonging to another tenant), or unknown ERP object |
| `upstream_unavailable` | 503 | ERP read impossible right now (cooldown, rate limited, timeout); `Retry-After` |
| `upstream_stale` | 503 | ERP keeps returning data older than our high-water mark (D5) |

### ActionView (the shape used in submit responses and GET)
```json
{
  "id": "4f1c…", "tenant_id": "acme", "action_type": "pay_invoice",
  "idempotency_key": "agent-42-7f…", "lane_id": "sap-main", "state": "QUEUED",
  "payload": { "invoice_id": "INV-C100-00001", "amount_minor": 1250000, "currency": "INR" },
  "pricing": { "hold": 300, "captured": null },
  "result": null,
  "failure": null,
  "created_at": "2026-10-22T10:00:00.000Z", "updated_at": "…", "completed_at": null
}
```
`failure` is `{ "code": "...", "message": "..." }` or `null`.

### Endpoints

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `POST /v1/actions` | tenant | header `Idempotency-Key`; body `{ "action_type": string, "payload": object }` | `202` ActionView (state `QUEUED`). Replays return the **stored** status and body byte-for-byte, plus header `Idempotent-Replayed: true`. Rejections: `402`/`409` body `{ error, action: ActionView(REJECTED) }` |
| `GET /v1/actions/:id` | tenant | — | `200` ActionView plus `events[]` (`{from,to,reason,details,at}`), `ledger[]` (`{kind,amount,reason,at}`), `attempts` (`{dispatch_count,retry_count,ambiguous_count,reconcile_attempts}`), `unknown` (`{since,trust_not_found_after,next_reconcile_at}` or null) |
| `GET /v1/actions?state=&limit=` | tenant | — | `200 { "actions": ActionView[] }` (newest first; limit ≤ 200) |
| `GET /v1/wallet` | tenant | — | `200 { "tenant_id", "available", "held", "derived": {"available","held"}, "consistent": bool }` |
| `GET /v1/wallet/ledger?limit=` | tenant | — | `200 { "entries": [{id,kind,amount,available_delta,held_delta,action_id,reason,created_at}] }` |
| `GET /v1/erp/vendors/:vendorId` | tenant | — | `200 { "data": Vendor, "meta": { "seq", "source": "cache"\|"erp"\|"coalesced", "fetched_at", "age_ms", "budget_ms" } }` |
| `GET /v1/erp/invoices/:invoiceId` | tenant | — | same shape with an Invoice |
| `POST /v1/webhooks/erp/:laneId` | HMAC | body: WebhookEvent (§9) | `204` (duplicates also 204); `401` bad signature; `400` bad body |
| `GET /v1/ops/queue` | ops | — | QueueReport (below) |
| `POST /v1/ops/reconcile` | ops | `{ "force"?: bool }` | ReconcileReport (step 07) |
| `POST /v1/ops/tenants/:id/grant` | ops | `{ "amount": int>0, "reason": string }` | `200` wallet |
| `GET /healthz` | none | — | `200 { "ok": true, "db": true, "redis": true }` |

**QueueReport**
```json
{ "generated_at": "…",
  "lanes": [ { "lane_id": "sap-main",
     "depth": { "QUEUED": 4200, "DISPATCHING": 16, "UNKNOWN": 0 },
     "ready": 4100, "oldest_queued_age_ms": 53000,
     "by_tenant": [ { "tenant_id": "acme", "QUEUED": 3800, "DISPATCHING": 6, "UNKNOWN": 0 } ],
     "cooldown": { "active": true, "remaining_ms": 4200, "consecutive_429": 6, "probe_mode": true },
     "stale_suspected_until": null } ],
  "unknown_alerts": [ { "action_id": "…", "tenant_id": "…", "age_ms": 960000 } ] }
```

### Action types (registry)

| `action_type` | Lane | Payload schema (zod) | Conflict key | Price (hold / capture / hit) |
|---|---|---|---|---|
| `pay_invoice` | tenant's `erp_lane_id` | `{ invoice_id: string(1..64), amount_minor: int>0, currency: 'INR' }` (strict) | `invoice:${invoice_id}` | 300 / 300 / — |
| `classify_invoice_line` | `llm` | `{ description: string(1..500), amount_minor?: int≥0, currency?: 'INR', vendor_id?: string(1..64) }` (strict) | none | 20 / 20 / 2 |

## 9. Mock ERP contract (port 4000)

**State:** in memory, seeded deterministically (PRNG seed `42`), and reset with `POST /__admin/reset`.
Every object has a per-object `seq` (starts at 1 and goes up by 1 on every change) plus a **version history**
(`[{seq, at_ms, data}]`), which is used to serve stale reads.

**Shapes**
```ts
Vendor  = { vendor_id, company_code, name, gstin, bank_account: { account_number, ifsc },
            payment_terms_days, blocked: boolean, seq, updated_at }
Invoice = { invoice_id, company_code, vendor_id, amount_minor, currency: 'INR',
            status: 'OPEN' | 'PAID', open_amount_minor, due_date, seq, updated_at }
Payment = { payment_id, company_code, invoice_id, amount_minor, currency, reference, created_at, seq }
WebhookEvent = { event_id, company_code, object_type: 'vendor'|'invoice'|'payment', object_id, seq, occurred_at }
```

**ERP routes.** These are subject to the rate limit and faults. Responses are JSON, and reads carry `ETag: "<seq>"`.

| Route | Behaviour |
|---|---|
| `GET /companies/:cc/vendors/:id` | `200 Vendor` / `404 {code:'VENDOR_NOT_FOUND'}` |
| `GET /companies/:cc/invoices/:id` | `200 Invoice` / `404 {code:'INVOICE_NOT_FOUND'}` |
| `POST /companies/:cc/payments` body `{invoice_id, amount_minor, currency, reference}` | **Validate and commit synchronously, with no `await` between the check and the commit.** Outcomes: `201 {payment, invoice}` (invoice → PAID, open 0, invoice seq+1); `404 INVOICE_NOT_FOUND`; `409 {code:'INVOICE_ALREADY_PAID', invoice}`; `422 {code:'AMOUNT_MISMATCH'\|'CURRENCY_MISMATCH', invoice}`; `400 {code:'VALIDATION_ERROR'}`. **References are not unique**: the same reference posted twice creates two payments, as a real ERP would. |
| `GET /companies/:cc/payments?reference=…` | `200 { payments: Payment[] }` (possibly empty). Subject to stale reads. |
| `GET /health` | `200`; no faults or rate limit |

**Admin routes (`/__admin/*`).** These are never subject to faults or rate limiting, and always read *current* (primary) state.

| Route | Purpose |
|---|---|
| `POST /__admin/reset` `{seed?}` | Re-seed state; clear faults, stats and pending webhooks |
| `GET /__admin/stats` | `{ requests_by_route, reads: { vendor: {"C100/V-0001": n}, invoice: {...}, payment_lookup: n }, payment_posts_received, payments_created, responses_by_status, rate_limited_429, faults_applied: {mode: n}, webhooks: {sent, failed, pending, dropped} }` |
| `POST /__admin/stats/reset` | Zero the counters only |
| `POST /__admin/faults` FaultRule | Add a rule → `{id}` |
| `GET /__admin/faults` / `DELETE /__admin/faults` / `DELETE /__admin/faults/:id` | List / clear all / remove one |
| `PATCH /__admin/companies/:cc/vendors/:id?webhook_delay_ms=` | A change "via another channel": merge fields, seq+1, schedule a webhook (with an optional per-event delay) |
| `POST /__admin/companies/:cc/invoices` `{count, amount_minor?, vendor_id?}` | Bulk-create OPEN invoices → `{invoice_ids}` |
| `GET /__admin/companies/:cc/payments?reference=&invoice_id=` | **Primary** (non-stale) payment listing, used by test assertions |
| `GET /__admin/companies/:cc/invoices?status=&limit=` / `GET /__admin/companies/:cc/invoices/:id` | Primary invoice listing / read (the demo and tests use it to find an OPEN invoice and its open amount) |
| (companies) | Unknown company codes are **created on demand** (25 vendors, 0 invoices), so tests can use fresh tenants |
| `GET /__admin/config` / `PUT /__admin/config` | `{ webhook_url, webhook_secret, webhook_delay_ms, webhooks_enabled, rate_limit_rps, rate_limit_burst }` |

**FaultRule**
```ts
{
  id?: string,
  mode: 'status_429' | 'status_503'                         // answer before processing: not committed
      | 'latency'                                           // delay, then process normally (a late commit if the client gave up)
      | 'drop_before_commit'                                // destroy the socket without processing
      | 'timeout_after_commit' | 'drop_after_commit' | 'error_500_after_commit'   // commit, then fail the response
      | 'stale_reads',                                      // GETs served from the snapshot at now - lag_ms
  match?: { method?: 'GET'|'POST'|'PATCH', path?: string }, // glob on the path, e.g. '/companies/*/payments'
  probability?: number,   // default 1
  count?: number,         // apply to at most N matching requests
  duration_ms?: number,   // active window starting at creation (default: until removed)
  retry_after_s?: number, // 429/503 Retry-After (default 1)
  latency_ms?: number,    // latency
  hang_ms?: number,       // timeout_after_commit: hold the socket this long, then destroy it (default 30000)
  lag_ms?: number         // stale_reads
}
```
**Evaluation order for one request:**
1. Admin and health routes are exempt.
2. `status_429` / `status_503` rules.
3. The global token bucket (`rate_limit_rps`, `rate_limit_burst`) → `429` with `Retry-After: 1`.
4. `latency`.
5. `drop_before_commit`.
6. The handler, with `stale_reads` applied to GETs.
7. Post-commit rules (`*_after_commit`, POST payments only).

**Webhooks.** Every change (vendor patch, invoice paid, payment created) enqueues a WebhookEvent. The event
is POSTed to `webhook_url` after `webhook_delay_ms` (default 500) with
`X-Erp-Signature: sha256=<hex HMAC of raw body with webhook_secret>`. Failed sends retry up to 5 times, 1 s apart.

## 10. ERP outcome taxonomy (A8)

`postPayment` returns a `SendOutcome`:

| Observation | `kind` | Detail |
|---|---|---|
| `2xx` | `committed` | `{ payment, invoice }` |
| `429` | `retryable` | `reason: 'rate_limited'`, `retryAfterMs` from `Retry-After` |
| `503` | `retryable` | `reason: 'unavailable'`, `retryAfterMs` |
| connect-phase error: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT` | `retryable` | `reason: 'unreachable'` |
| `400`, `404`, `409`, `422`, any other `4xx` (incl. 401/403 as `ERP_AUTH`) | `permanent` | `{ code, message, details }`, where `details.invoice` is passed through when present |
| `500`, `502`, `504`, other `5xx` | `ambiguous` | `reason: 'http_5xx'` |
| request timeout (`AbortSignal.timeout` → `TimeoutError`) | `ambiguous` | `reason: 'timeout'` |
| socket reset / `UND_ERR_SOCKET` / `ECONNRESET` / "other side closed" | `ambiguous` | `reason: 'connection_reset'` |
| anything else | `ambiguous` | `reason: 'unclassified'` (**when in doubt → UNKNOWN**) |

Reads (`getVendor`, `getInvoice`, `findPaymentsByReference`) return data or `not_found`. Otherwise they
throw `ErpReadError { kind: 'rate_limited'|'unavailable'|'timeout'|'error', retryAfterMs? }`.

## 11. Redis key schema and Lua scripts

Every key is prefixed with `REDIS_PREFIX` (default `mag:`; tests use a random prefix per test file). Keys
are built **only** in `src/redis/keys.ts`. Don't use ioredis `keyPrefix`.

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `{p}rl:{lane}` | hash `{tokens, ts_ms}` | token bucket (A6) | 60 s idle |
| `{p}cool:{lane}` | string `until_ms` | cooldown active while the key exists | PX = remaining |
| `{p}cool429:{lane}` | int | consecutive 429s (backoff exponent; >0 ⇒ probe mode after cooldown) | 300 s |
| `{p}probe:{lane}` | string owner | single half-open probe | PX = 2 × request_timeout |
| `{p}c:{lane}:{cc}:{type}:{id}` | hash `{v: json, seq, fetched_at_ms}` | cache entry | PX = budget − max_read_lag |
| `{p}hwm:{lane}:{cc}:{type}:{id}` | int | highest known seq | 24 h, refreshed on raise |
| `{p}lk:{lane}:{cc}:{type}:{id}` | string owner | cross-process coalescing lease | PX = 5000 |

**Lua scripts** (`src/redis/lua/*.lua`, loaded with `defineCommand`):
- `token_bucket(KEYS[1]=rl, ARGV=[rate_per_sec, burst])` → `0` if a token was granted, otherwise the milliseconds to wait. Uses `redis.call('TIME')`.
- `cooldown_extend(KEYS[1]=cool, ARGV=[until_ms])` → sets `until_ms` with the matching PX, **only if it's later** than the current value.
- `cache_get(KEYS=[entry,hwm])` → the entry if `entry.seq ≥ hwm`; otherwise deletes the entry and returns nil.
- `cache_fill(KEYS=[entry,hwm], ARGV=[value_json, seq, fetched_at_ms, ttl_ms])` → `1` stored, `-1` rejected (`seq < hwm`: **stale read**), `-2` rejected (an existing entry has a higher seq).
- `cache_invalidate(KEYS=[entry,hwm], ARGV=[seq, hwm_ttl_ms])` → raises the HWM if `seq` is higher, and deletes the entry if `entry.seq < seq`. Returns `1` if the entry was deleted. A duplicate or older seq is a no-op.

## 12. Configuration

### Environment

| Var | Used by | Default (dev) |
|---|---|---|
| `DATABASE_URL` | api, worker, scripts | `postgres://gateway:gateway@localhost:5432/gateway` |
| `REDIS_URL` | api, worker | `redis://localhost:6379` |
| `REDIS_PREFIX` | api, worker | `mag:` |
| `PORT` | api | `3000` |
| `LOG_LEVEL` | all | `info` |
| `OPS_API_KEY` | api | `ops-dev-key` |
| `WORKER_ID` | worker | `${hostname}-${pid}-${rand4}` |
| `MOCK_ERP_URL` | seed (lane base_url), scripts | `http://localhost:4000` (compose: `http://mock-erp:4000`) |
| `GATEWAY_URL` | scripts | `http://localhost:3000` |
| `WEBHOOK_SECRET` | seed (lane secret) | `dev-webhook-secret` |
| `LLM_PROVIDER` | worker | `fake`; or `anthropic` (if unset: `anthropic` when `ANTHROPIC_API_KEY` is set, else `fake`) |
| `ANTHROPIC_API_KEY`, `LLM_MODEL` | worker | unset / `claude-opus-5` (a cheaper model is your call; see step 09) |
| `MOCK_ERP_PORT` | mock-erp | `4000` |
| `MOCK_ERP_WEBHOOK_URL` | mock-erp | `http://localhost:3000/v1/webhooks/erp/sap-main` (compose: `http://api:3000/…`) |
| `MOCK_ERP_WEBHOOK_SECRET` | mock-erp | `dev-webhook-secret` |
| `MOCK_ERP_WEBHOOK_DELAY_MS` | mock-erp | `500` |
| `MOCK_ERP_RATE_LIMIT_RPS` / `_BURST` | mock-erp | `100` / `100` |
| `MOCK_ERP_SEED` | mock-erp | `42` |
| `TEST_DATABASE_ADMIN_URL` | tests | `postgres://gateway:gateway@localhost:5432/postgres` |
| `TEST_REDIS_URL` | tests | `redis://localhost:6379` |
| `SCENARIO_TIME_SCALE` | scenario tests | `0.1` |

### Runtime config (`src/shared/config.ts`, `GatewayConfig`; tests pass scaled overrides)

| Key | Default | Meaning |
|---|---|---|
| `dispatcher.idlePollMs` | 200 | sleep when no ready work |
| `dispatcher.tokenWaitMaxMs` | 1000 | maximum single wait for a rate-limit token |
| `cooldown.baseMs` / `cooldown.maxMs` | 1000 / 30000 | 429 backoff when there's no `Retry-After`; full jitter on the computed values |
| `retry.baseMs` / `retry.maxMs` | 500 / 30000 | per-action backoff for 503/unreachable |
| `recovery.intervalMs` | 1000 | expired-lease sweep |
| `expiry.queuedMaxAgeMs` | 86_400_000 | QUEUED never sent → FAILED (A12) |
| `reconciler.intervalMs` | 2000 | UNKNOWN sweep |
| `reconciler.firstLookupDelayMs` | 1000 | first lookup after entering UNKNOWN (an early "found" resolves quickly) |
| `reconciler.confirmGapMs` | 2000 | spacing between the two trusted not-founds |
| `reconciler.maxAmbiguous` | 3 | after this many ambiguous cycles, a trusted not-found → FAILED |
| `reconciler.backoffBaseMs` / `backoffMaxMs` | 1000 / 60000 | reschedule after a lookup error |
| `reconciler.staleQuarantineMs` | 900_000 | lane stays stale-suspected this long after the last evidence |
| `reconciler.unknownAlertAfterMs` | 900_000 | UNKNOWN age that triggers an alert |
| `cache.budgets.vendorMs` / `invoiceMs` | 60000 / 15000 | staleness budgets (D5) |
| `cache.coalesce.leaseMs` / `waitMs` / `pollMs` | 5000 / 3000 / 25 | D6 |
| `cache.hwmTtlMs` | 86_400_000 | HWM retention |
| `cache.readTokenWaitMs` | 500 | how long a cache miss waits for a token before returning 503 |
| `backpressure.retryAfterS` | 5 | `Retry-After` on `tenant_backpressure` |
| `llm.maxRetries` | 5 | LLM-lane retries before FAILED |
| `ops.apiKey` | env `OPS_API_KEY` | |

## 13. Invariants

| # | Invariant | Enforced by | Proven by (test) |
|---|---|---|---|
| I1 | `available ≥ 0` and `held ≥ 0` at all times | conditional UPDATE + `CHECK` | s4, wallet stress test |
| I2 | `wallets` = `SUM(ledger deltas)` per tenant | same-transaction writes in `ledger.ts` | `verifyWallets()` after every scenario |
| I3 | ledger and `action_events` are append-only | triggers | ledger tests |
| I4 | per action: ≤1 HOLD, ≤1 CAPTURE, ≤1 RELEASE; settlement matches state (§7) | unique index + `settle.ts` | `verifySettlements()` after every scenario |
| I5 | no ERP call without a committed `DISPATCHING` row whose live lease is held by the caller | `claim.ts` + executor structure | s1, multi-worker test |
| I6 | at most one non-final action per `(tenant, conflict_key)` | partial unique index | s3 |
| I7 | one `(tenant, idempotency_key)` → one action; its stored response never changes | unique constraint + immutable-column trigger | s1, A9 test |
| I8 | an ambiguous outcome is never resent without a *trusted* not-found | executor + resolver + trust rule | s2, x-abandoned-commit, x-stale-window |
| I9 | the cache never serves or stores `seq < HWM` | Lua `cache_get` / `cache_fill` | s6, Lua unit tests |
| I10 | no cached value is served more than its budget after the ERP write that made it wrong | TTL = budget − max lag; webhooks earlier | s6 TTL-backstop test |
| I11 | losing Redis loses no action and no credit movement | Redis holds only the §11 keys | review argument; `redis FLUSHALL` mid-test (stretch) |
| I12 | a classification result never changes once written | PK + immutable trigger | step 09 tests |

## 14. Seed data (`scripts/seed.ts`; idempotent, using upserts)

- **Lanes**

  | id | kind | base_url | rate/s | burst | in-flight | timeout | lease | max lag | webhook secret |
  |---|---|---|---|---|---|---|---|---|---|
  | `sap-main` | erp | `${MOCK_ERP_URL}` | 50 | 50 | 16 | 5000 | 20000 | 5000 | `${WEBHOOK_SECRET}` |
  | `llm` | llm | — | 20 | 20 | 8 | 20000 | 60000 | 0 | — |

- **Tenants** (all on `sap-main`)

  | id | company | credits (GRANT) | API key |
  |---|---|---|---|
  | `acme` | `C100` | 1,000,000 | `acme-dev-key` |
  | `globex` | `C200` | 500 | `globex-dev-key` (try Scenario 4 by hand) |
  | `initech` | `C300` | 100,000 | `initech-dev-key` |

  Credits are created with `GRANT` ledger entries, **never** by writing `wallets` directly, and `GRANT` is
  skipped if the tenant already has one.

- **Price list:** `pay_invoice` 300/300/NULL; `classify_invoice_line` 20/20/2.

- **Mock ERP seed** (inside the mock, PRNG seed 42):
  - Companies C100, C200, C300, each with 25 vendors (`V-0001`…) and 500 OPEN invoices (`INV-C100-00001`…).
  - Invoice amounts are random from ₹1,000.00 to ₹5,00,000.00 in paise.
  - Due dates fall within the next 60 days.
  - Each vendor gets a GSTIN-like string and a bank account with an IFSC.
