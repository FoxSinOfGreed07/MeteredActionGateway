/**
 * "When should this gateway use a single Postgres table and no Redis?" — measure instead of guessing.
 *   1. Queue: claim + settle (DISPATCHING→SUCCEEDED + CAPTURE) throughput with N concurrent claimers.
 *   2. Admission: the full submit transaction (record + HOLD + event) — 1 tenant vs 5 tenants.
 *   3. Cached reads: Postgres UNLOGGED table primary-key reads vs Redis HMGET.
 * Runs against the local docker Postgres/Redis (`docker compose up -d postgres redis`) in throwaway DBs.
 */
import { cpus, totalmem } from 'node:os';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { createDb } from '../src/db/kysely.js';
import { submitAction } from '../src/gateway/actions/submit.js';
import { claimNext } from '../src/gateway/dispatch/claim.js';
import { markSucceeded } from '../src/gateway/dispatch/settle.js';
import { TEST_REDIS_URL } from '../test/kit/env.js';
import { createTenant } from '../test/kit/fixtures.js';
import setup from '../test/kit/global-setup.js';
import { startStack } from '../test/kit/stack.js';

process.env.VITEST ??= '1'; // silence logs
await setup();
const rows: [string, string][] = [];
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

// ---------- 1. queue claim + settle ----------
const stack = await startStack({ worker: false, timeScale: 1 });
for (const n of [1, 4, 16]) {
  const lane = `bench${n}`;
  await stack.db
    .insertInto('lanes')
    .values({
      id: lane,
      kind: 'erp',
      base_url: 'http://x',
      rate_per_sec: 1e6,
      burst: 1e6,
      max_in_flight: 1000,
      request_timeout_ms: 5000,
      lease_ms: 60_000,
    })
    .execute();
  const tenants = await Promise.all(
    [0, 1, 2].map(() => createTenant(stack.db, { credits: 1_000_000, lane })),
  );
  const N = 6000;
  await sql`
    INSERT INTO actions (id, tenant_id, lane_id, action_type, idempotency_key, payload, payload_hash, state, hold_amount, response_status, response_body)
    SELECT gen_random_uuid(), (ARRAY[${tenants[0]!.id}, ${tenants[1]!.id}, ${tenants[2]!.id}])[1 + g % 3], ${lane}, 'pay_invoice',
           ${lane} || '-' || g, '{}', 'h', 'QUEUED', 1, 202, '{}'
      FROM generate_series(1, ${N}) g`.execute(stack.db);
  await sql`INSERT INTO ledger_entries (tenant_id, action_id, kind, amount, available_delta, held_delta, reason)
            SELECT tenant_id, id, 'HOLD', 1, -1, 1, 'hold:bench' FROM actions WHERE lane_id = ${lane}`.execute(
    stack.db,
  );
  await sql`UPDATE wallets w SET available = w.available - c.n, held = w.held + c.n
              FROM (SELECT tenant_id, count(*)::int n FROM actions WHERE lane_id = ${lane} GROUP BY 1) c WHERE w.tenant_id = c.tenant_id`.execute(
    stack.db,
  );
  const laneRow = { id: lane, lease_ms: 60_000 };
  const t0 = performance.now();
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      for (;;) {
        const a = await claimNext(stack.ctx, laneRow, `bench-${i}`);
        if (!a) return;
        await markSucceeded(stack.ctx, a, {
          result: {},
          via: 'response',
          reason: 'bench',
          leaseOwner: `bench-${i}`,
          capture: 1,
        });
        done++;
      }
    }),
  );
  const secs = (performance.now() - t0) / 1000;
  rows.push([
    `Queue claim+settle, ${n} claimer(s) (${N} actions, 3 tenants)`,
    `${fmt(done / secs)} actions/s`,
  ]);
}

// ---------- 2. admission ----------
for (const tenantsN of [1, 5]) {
  const ts = await Promise.all(
    Array.from({ length: tenantsN }, () => createTenant(stack.db, { credits: 100_000_000 })),
  );
  const tenantRows = await stack.db
    .selectFrom('tenants')
    .selectAll()
    .where(
      'id',
      'in',
      ts.map((t) => t.id),
    )
    .execute();
  let i = 0;
  let ok = 0;
  const until = Date.now() + 8000;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 50 }, async () => {
      while (Date.now() < until) {
        const k = i++;
        const r = await submitAction(stack.ctx, {
          tenant: tenantRows[k % tenantRows.length]!,
          actionType: 'pay_invoice',
          payload: { invoice_id: `INV-${k}`, amount_minor: 1, currency: 'INR' },
          idempotencyKey: `adm-${tenantsN}-${k}`,
        });
        if (r.status === 202) ok++;
      }
    }),
  );
  rows.push([
    `Admission (record + HOLD + event, 1 tx), ${tenantsN} tenant(s), 50 concurrent`,
    `${fmt(ok / ((performance.now() - t0) / 1000))} submits/s`,
  ]);
}

// ---------- 3. cached reads: Postgres vs Redis ----------
const pgReads = createDb(stack.ctx.config.databaseUrl, { max: 64 });
await sql`CREATE UNLOGGED TABLE cache_bench (key text PRIMARY KEY, v jsonb NOT NULL, seq bigint NOT NULL)`.execute(
  pgReads,
);
await sql`INSERT INTO cache_bench SELECT 'k' || g, jsonb_build_object('vendor_id', 'V-' || g, 'name', repeat('x', 200)), 1 FROM generate_series(1, 1000) g`.execute(
  pgReads,
);
const redis = new Redis(TEST_REDIS_URL);
const rp = `bench_${Date.now()}:`;
for (let g = 1; g <= 1000; g++)
  await redis.hset(`${rp}k${g}`, {
    v: JSON.stringify({ vendor_id: `V-${g}`, name: 'x'.repeat(200) }),
    seq: '1',
  });
async function readBench(label: string, fn: () => Promise<unknown>) {
  let n = 0;
  const until = Date.now() + 5000;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 64 }, async () => {
      while (Date.now() < until) {
        await fn();
        n++;
      }
    }),
  );
  rows.push([label, `${fmt(n / ((performance.now() - t0) / 1000))} reads/s`]);
}
const rnd = () => `k${1 + Math.floor(Math.random() * 1000)}`;
await readBench('Cached read: Postgres UNLOGGED PK lookup, 64 concurrent', () =>
  sql`SELECT v, seq FROM cache_bench WHERE key = ${rnd()}`.execute(pgReads),
);
await readBench('Cached read: Redis HMGET, 64 concurrent', () => redis.hmget(`${rp}${rnd()}`, 'v', 'seq'));
const keys = await redis.keys(`${rp}*`);
if (keys.length) await redis.del(...keys);
redis.disconnect();
await pgReads.destroy();
await stack.stop();

const cpu = cpus();
console.log(
  `\n### PG-only benchmark — ${cpu.length}× ${cpu[0]?.model.trim()} · ${Math.round(totalmem() / 2 ** 30)} GiB · ${new Date().toISOString().slice(0, 10)}\n`,
);
console.log('| Measurement | Result |\n|---|---|');
for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
