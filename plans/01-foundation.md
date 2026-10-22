# Step 01: Foundation (scaffold, infra, database, test kit)

- **Goal:** a repo that type-checks, lints, starts with one command (`docker compose up --build`), has the full schema migrated and seeded, and has a test kit every later step builds on.
- **Depends on:** nothing.
- **Decisions applied:** A1 (stack), A2 (Kysely + SQL migrations), A3 (process split), A15 (time scaling), D8 (Redis without persistence).
- **Estimate:** ~2.5 h.
- **Read first:** `00-architecture.md` §2, §3, §4, §5, §12, §14.

## Deliverables
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- `Dockerfile`, `docker-compose.yml`
- `migrations/0001_init.sql`: **exactly** the DDL in `00-architecture.md` §5
- `src/shared/{config,logger,canonical-json,hash,sleep,errors,backoff,ids}.ts`
- `src/db/{kysely,schema,migrate,tx}.ts`
- `src/redis/{client,keys,scripts}.ts` and the `src/redis/lua/` directory (scripts get filled in by later steps)
- `src/gateway/api-main.ts` (only `/healthz` for now), `src/gateway/worker-main.ts` (logs `worker.started` and idles)
- `src/mock-erp/main.ts` (stub: `/health` only; step 02 replaces it)
- `scripts/migrate.ts`, `scripts/seed.ts`
- `test/kit/{global-setup,db,redis,stack,clients,time,wait,fixtures}.ts`
- `test/integration/foundation.test.ts`
- `git init` and a first commit

## Tasks

### 1. Repo and tooling
1. `git init`. Add `.gitignore` with `node_modules/`, `dist/`, `.env`, `coverage/` and `*.log`.
2. Create `package.json`:
   - `"type": "module"`, `"engines": { "node": ">=24" }`, and a `packageManager` pinned to the installed pnpm.
   - Runtime deps: `hono @hono/node-server zod @hono/zod-validator kysely pg ioredis pino`.
   - Dev deps: `typescript tsx vitest @types/node @types/pg @biomejs/biome pino-pretty undici`.
   - Use current stable versions. `@anthropic-ai/sdk` is added in step 09.
3. Scripts:
   ```json
   {
     "dev:api": "tsx watch src/gateway/api-main.ts",
     "dev:worker": "tsx watch src/gateway/worker-main.ts",
     "dev:mock-erp": "tsx watch src/mock-erp/main.ts",
     "migrate": "tsx scripts/migrate.ts",
     "seed": "tsx scripts/seed.ts",
     "typecheck": "tsc --noEmit",
     "lint": "biome check .",
     "format": "biome format --write .",
     "test": "vitest run",
     "test:unit": "vitest run --project unit",
     "test:integration": "vitest run --project integration",
     "test:scenarios": "vitest run --project scenarios",
     "test:realtime": "SCENARIO_TIME_SCALE=1 vitest run --project scenarios",
     "fault": "tsx scripts/inject-fault.ts",
     "reconcile": "tsx scripts/reconcile.ts",
     "demo:timeout": "tsx scripts/demo-timeout.ts",
     "bench:pg": "tsx scripts/bench-pg-queue.ts"
   }
   ```
   Scripts for files that don't exist yet are fine; later steps create them.
4. `tsconfig.json` compiler options: `target ES2023`, `module NodeNext`, `moduleResolution NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes: false`, `skipLibCheck`, `resolveJsonModule`, `types: ["node"]`. Include `src`, `scripts` and `test`.
5. `biome.json`: recommended rules, 2-space indent, line width 110, single quotes.

### 2. Docker
- **`Dockerfile`:** `FROM node:24-slim`, `WORKDIR /app`, `corepack enable`, copy the manifests, `pnpm install --frozen-lockfile`, copy the source. No build step: services run with `pnpm exec tsx …`.
- **`docker-compose.yml`:** the services exactly as in `00-architecture.md` §2:
  - `postgres`: healthcheck `pg_isready -U gateway`.
  - `redis`: `command: ["redis-server", "--save", "", "--appendonly", "no"]`, healthcheck `redis-cli ping`. Add a comment explaining persistence is off on purpose (D8 principle).
  - `migrate`: `command: sh -c "pnpm exec tsx scripts/migrate.ts && pnpm exec tsx scripts/seed.ts"`, `depends_on: postgres: service_healthy`, `MOCK_ERP_URL=http://mock-erp:4000`, `restart: "no"`.
  - `mock-erp`: env `MOCK_ERP_WEBHOOK_URL=http://api:3000/v1/webhooks/erp/sap-main`, port `4000:4000`.
  - `api`: `depends_on: migrate: service_completed_successfully, redis: service_healthy`, port `3000:3000`.
  - `worker`: same dependencies as `api`.
  - Put shared env in an `x-gateway-env` anchor.

### 3. Shared modules
- **`config.ts`:**
  - A zod schema for the environment (§12).
  - `loadConfig(overrides?: DeepPartial<GatewayConfig>): GatewayConfig` that merges the defaults from §12 with any overrides.
  - `scaleDurations(cfg, scale)`, which multiplies every `*Ms` key (used by tests).
- **`logger.ts`:** `createLogger(component)` returning a pino instance. Pretty output only when `NODE_ENV !== 'production'` and stdout is a TTY.
- **`canonical-json.ts`:** `canonicalJson(value)`. Sort object keys recursively; arrays keep their order; no whitespace; reject `undefined`, functions and NaN.
- **`hash.ts`:** `sha256Hex(string | Buffer)` and `hmacSha256Hex(secret, body)`.
- **`backoff.ts`:**
  - `expBackoff(attempt, baseMs, maxMs)` = `min(maxMs, baseMs * 2^(attempt-1))`.
  - `fullJitter(ms)` = random value in `[ms/2, ms]`.
- **`errors.ts`:** `GatewayError` (see §4) and `isPgUniqueViolation(err, constraintName?)` (SQLSTATE `23505`, checking `err.constraint`).
- **`ids.ts`:** `newActionId()` (`crypto.randomUUID()`) and `workerId()`.

### 4. Database
- **`kysely.ts`:**
  - `createDb(url)`: a `pg.Pool` (max 20) with `PostgresDialect`.
  - Register `pg.types.setTypeParser(20, v => toSafeNumber(v))` for int8, throwing if the value is above `Number.MAX_SAFE_INTEGER`.
  - Leave `numeric` as a string (unused).
- **`schema.ts`:** the `Database` interface mirroring §5 one-to-one. Name each table interface by its table (`ActionsTable`, …), and export the `Selectable` row types (`ActionRow`, `LedgerEntryRow`, …) plus `ActionState`.
- **`migrate.ts`:** `migrate(db)`.
  1. Take `pg_advisory_lock(727272)`.
  2. Create `schema_migrations` if it's missing (bootstrap).
  3. Read `migrations/*.sql` in sorted order and apply the files not yet recorded, each in its own transaction, recording the version.
  4. Release the lock.
  `scripts/migrate.ts` calls it, logs the result and exits.
- **`tx.ts`:** a thin helper, `withTx(db, fn)` → `db.transaction().execute(fn)`, plus a `Tx` type alias.

### 5. Redis
- **`client.ts`:** `createRedis(url)` → an ioredis instance with `maxRetriesPerRequest: 2` and `enableAutoPipelining: true`.
- **`keys.ts`:** a `keys(prefix)` factory returning functions for every key in §11 (`rateLimit(lane)`, `cooldown(lane)`, `cool429(lane)`, `probe(lane)`, `cacheEntry(lane,cc,type,id)`, `hwm(…)`, `coalesceLease(…)`).
- **`scripts.ts`:** `registerScripts(redis)`, which reads `src/redis/lua/*.lua` and calls `redis.defineCommand(name, {numberOfKeys, lua})`. Each later step adds its own script here.

### 6. Seed (`scripts/seed.ts`)
Implement exactly the seed in §14, idempotent:
- Lanes and price list: `INSERT … ON CONFLICT DO UPDATE`.
- Tenants: upsert, with the key hash = `sha256Hex(key)`.
- Wallets:
  1. Create the wallet row with zeros (`ON CONFLICT DO NOTHING`).
  2. If the tenant has no `GRANT` entry yet, insert `GRANT` (reason `grant:seed`) and `UPDATE wallets SET available = available + amount`.
  Steps 1 and 2 run in one transaction. Step 03 provides `grant()`; for now write it inline and replace it in step 03.
- Print a table of tenants, API keys and credits at the end.

### 7. Entry points (stubs)
- **`api-main.ts`:** `createApp(ctx)` with `GET /healthz` (`SELECT 1`, Redis `PING`), served with `@hono/node-server`. Handle SIGTERM gracefully.
- **`worker-main.ts`:** connect to the database and Redis, log `worker.started`, and wait until SIGTERM.
- **`context.ts`:** the `GatewayContext` type `{ db, redis, keys, config, log }` and a `createContext(env, overrides)` factory. Every module takes a context instead of importing singletons, which is what lets tests run several stacks in one process.

### 8. Test kit (`test/kit`)
- **`vitest.config.ts`** declares `test.projects` (or `workspace`, depending on the vitest version):
  - `unit`: `test/unit/**/*.test.ts`, no setup.
  - `integration`: `test/integration/**/*.test.ts`, `globalSetup: test/kit/global-setup.ts`, `testTimeout: 30000`.
  - `scenarios`: `test/scenarios/**/*.test.ts`, the same globalSetup, `testTimeout: 300000`, `fileParallelism: false`.
- **`global-setup.ts`:**
  1. Connect to `TEST_DATABASE_ADMIN_URL`.
  2. `DROP DATABASE IF EXISTS mag_template`, then `CREATE DATABASE mag_template`.
  3. Run `migrate()` on it, then close every connection to it (a template can't have connections).
  4. Fail fast with a helpful message ("run `docker compose up -d postgres redis`") if Postgres or Redis can't be reached.
- **`db.ts`:** `createTestDatabase()`.
  1. `CREATE DATABASE mag_t_<rand> TEMPLATE mag_template`.
  2. Return `{ url, db, drop() }`, where `drop()` destroys the pool and then runs `DROP DATABASE … WITH (FORCE)`.
  Each test file uses its own database. Never use TRUNCATE (the ledger triggers forbid it).
- **`redis.ts`:** `createTestRedis()` → `{ redis, prefix: 't_<rand>:', cleanup() }`. Cleanup does a SCAN with `MATCH prefix*`, then DEL.
- **`time.ts`:** `export const SCALE = Number(process.env.SCENARIO_TIME_SCALE ?? '0.1')` and `export const T = (ms: number) => Math.max(1, Math.round(ms * SCALE))`.
- **`wait.ts`:** `waitFor(predicate, { timeoutMs, intervalMs = 50, message })`, which throws with the last observed value on timeout. Also `sleep`.
- **`fixtures.ts`:** `createLane(db, overrides)` and `createTenant(db, { id?, lane, companyCode, credits, maxPending?, apiKey? })`. The tenant helper uses the GRANT path and returns `{ id, apiKey }`. Plus `seedPriceList(db)`.
- **`stack.ts`:** `startStack(opts)`, the single entry point every integration and scenario test uses. Step 01 implements only what exists so far:
  ```ts
  interface StackOptions {
    timeScale?: number;               // default SCALE
    config?: DeepPartial<GatewayConfig>;
    mockErp?: false | MockErpOptions; // step 02
    worker?: boolean;                 // step 06+ (start dispatcher/recovery/reconciler loops in-process)
    lanes?: Partial<LaneRow>[];       // default: sap-main + llm with scaled timeouts
  }
  interface Stack {
    ctx: GatewayContext; db: Kysely<Database>; redis: Redis;
    api: { url: string; app: Hono; request: (path, init) => Promise<Response> };  // real HTTP server on port 0 + app.request
    mockErp?: { url: string; admin: MockAdminClient; instance: MockErpInstance };   // step 02
    worker?: { stop(): Promise<void>; start(): Promise<void> };                      // step 06
    stop(): Promise<void>;
  }
  ```
  Order:
  1. Create the test database and Redis prefix.
  2. Start the mock ERP if requested (port 0).
  3. Create lanes with `base_url` = the mock URL.
  4. Start the API server (port 0).
  5. Point the mock ERP's `webhook_url` at `${api.url}/v1/webhooks/erp/<lane>`.
  6. Start the worker loops if requested.
  `stop()` tears everything down in reverse order.
- **`clients.ts`:** `tenantClient(stack, apiKey)`, with `submit(type, payload, key, {viaHttp?})`, `getAction(id)`, `wallet()`, `ledger()`, `vendor(id)`, `invoice(id)`, and `opsClient(stack)`. Each returns `{ status, headers, body }`.

### 9. Foundation tests (`test/integration/foundation.test.ts`)
- The migration created every table, enum and trigger: query `information_schema` for the table names in §5.
- `schema.ts` matches the database: for every table, the columns in `information_schema.columns` equal the keys declared in a `SCHEMA_COLUMNS` const kept next to the interface. This catches drift (A2 trade-off).
- The ledger is append-only: insert a GRANT, then `UPDATE` and `DELETE` both raise `restrict_violation`.
- `canonicalJson` is stable regardless of key order (a unit test in `test/unit/canonical-json.test.ts`).
- `/healthz` returns 200 through `startStack()`.

## Done when
- [ ] `docker compose up --build`: postgres and redis are healthy, `migrate` exits 0 having printed the tenant table, `api` answers `/healthz` 200, `worker` logs `worker.started`, `mock-erp` answers `/health`.
- [ ] `docker compose down -v && docker compose up --build` works again from scratch.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass, with Postgres and Redis running.
- [ ] Commit `step 01: foundation`.

## Pitfalls
- `CREATE DATABASE … TEMPLATE` fails if *any* session is connected to the template. Close the migration pool before the first test clones it.
- `pg` returns `bigint` as a string unless the type parser is registered **before** the pool is created.
- With ESM and NodeNext, relative imports need `.js` extensions.
- Keep every module context-injected (no module-level db, redis or config singletons), otherwise tests can't run several stacks.
