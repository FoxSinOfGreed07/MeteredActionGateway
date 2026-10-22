import { sql } from 'kysely';
import { createDb } from '../src/db/kysely.js';
import { loadEnv } from '../src/shared/config.js';
import { sha256Hex } from '../src/shared/hash.js';

/** Seed data (plans/00-architecture.md §14). Idempotent: safe to run on every `docker compose up`. */
const env = loadEnv();
const db = createDb(env.DATABASE_URL, { max: 2 });

const LANES = [
  {
    id: 'sap-main',
    kind: 'erp' as const,
    base_url: env.MOCK_ERP_URL,
    rate_per_sec: 50,
    burst: 50,
    max_in_flight: 16,
    request_timeout_ms: 5000,
    lease_ms: 20000,
    max_read_lag_ms: 5000,
    webhook_secret: env.WEBHOOK_SECRET,
  },
  {
    id: 'llm',
    kind: 'llm' as const,
    base_url: null,
    rate_per_sec: 20,
    burst: 20,
    max_in_flight: 8,
    request_timeout_ms: 20000,
    lease_ms: 60000,
    max_read_lag_ms: 0,
    webhook_secret: null,
  },
];
const PRICES = [
  { action_type: 'pay_invoice', hold_amount: 300, capture_amount: 300, cache_hit_capture_amount: null },
  { action_type: 'classify_invoice_line', hold_amount: 20, capture_amount: 20, cache_hit_capture_amount: 2 },
];
const TENANTS = [
  { id: 'acme', name: 'Acme Corp', company: 'C100', credits: 1_000_000, apiKey: 'acme-dev-key' },
  { id: 'globex', name: 'Globex', company: 'C200', credits: 500, apiKey: 'globex-dev-key' },
  { id: 'initech', name: 'Initech', company: 'C300', credits: 100_000, apiKey: 'initech-dev-key' },
];

for (const lane of LANES) {
  await db
    .insertInto('lanes')
    .values(lane)
    .onConflict((oc) =>
      oc.column('id').doUpdateSet((eb) => ({
        base_url: eb.ref('excluded.base_url'),
        rate_per_sec: eb.ref('excluded.rate_per_sec'),
        burst: eb.ref('excluded.burst'),
        max_in_flight: eb.ref('excluded.max_in_flight'),
        request_timeout_ms: eb.ref('excluded.request_timeout_ms'),
        lease_ms: eb.ref('excluded.lease_ms'),
        max_read_lag_ms: eb.ref('excluded.max_read_lag_ms'),
        webhook_secret: eb.ref('excluded.webhook_secret'),
      })),
    )
    .execute();
}
for (const price of PRICES) {
  await db
    .insertInto('price_list')
    .values(price)
    .onConflict((oc) =>
      oc.column('action_type').doUpdateSet((eb) => ({
        hold_amount: eb.ref('excluded.hold_amount'),
        capture_amount: eb.ref('excluded.capture_amount'),
        cache_hit_capture_amount: eb.ref('excluded.cache_hit_capture_amount'),
      })),
    )
    .execute();
}
for (const t of TENANTS) {
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('tenants')
      .values({
        id: t.id,
        name: t.name,
        api_key_hash: sha256Hex(t.apiKey),
        erp_lane_id: 'sap-main',
        erp_company_code: t.company,
      })
      .onConflict((oc) => oc.column('id').doUpdateSet({ api_key_hash: sha256Hex(t.apiKey) }))
      .execute();
    await tx
      .insertInto('wallets')
      .values({ tenant_id: t.id })
      .onConflict((oc) => oc.column('tenant_id').doNothing())
      .execute();
    const granted = await tx
      .selectFrom('ledger_entries')
      .select('id')
      .where('tenant_id', '=', t.id)
      .where('kind', '=', 'GRANT')
      .limit(1)
      .executeTakeFirst();
    if (!granted) {
      // Step 03 replaces this inline block with ledger.grant().
      await tx
        .insertInto('ledger_entries')
        .values({
          tenant_id: t.id,
          kind: 'GRANT',
          amount: t.credits,
          available_delta: t.credits,
          held_delta: 0,
          reason: 'grant:seed',
        })
        .execute();
      await tx
        .updateTable('wallets')
        .set({ available: sql`available + ${t.credits}`, updated_at: sql`now()` })
        .where('tenant_id', '=', t.id)
        .execute();
    }
  });
}

const rows = await db
  .selectFrom('tenants')
  .innerJoin('wallets', 'wallets.tenant_id', 'tenants.id')
  .select(['tenants.id', 'tenants.erp_company_code', 'wallets.available', 'wallets.held'])
  .orderBy('tenants.id')
  .execute();
console.log('seeded tenants:');
console.table(rows.map((r) => ({ ...r, api_key: TENANTS.find((t) => t.id === r.id)?.apiKey })));
await db.destroy();
