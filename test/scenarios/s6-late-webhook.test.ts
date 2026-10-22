/**
 * Scenario 6 — Analyst
 * Situation: the vendor master changes in SAP via another channel; the webhook arrives 40 s late.
 * Expected:  the cached read is invalidated by sequence number; once the webhook is processed no read older
 *            than it can be observed (no rollback by duplicates, out-of-order events or stale ERP replicas);
 *            before that, staleness stays within the vendor budget (60 s).
 * Doc numbers: 40 s webhook delay, 60 s vendor budget · scaled by SCENARIO_TIME_SCALE.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearLaneHealth, staleSuspectedUntil } from '../../src/gateway/reconcile/lane-health.js';
import { hmacSha256Hex } from '../../src/shared/hash.js';
import { assertInvariants } from '../kit/invariants.js';
import { tenantWithInvoices } from '../kit/scenario.js';
import { type Stack, startStack, TEST_WEBHOOK_SECRET } from '../kit/stack.js';
import { T } from '../kit/time.js';
import { sleep, waitFor } from '../kit/wait.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    worker: true,
  });
});
afterEach(async () => {
  await stack.mockErp!.admin.clearFaults();
  await stack.mockErp!.admin.putConfig({ webhooks_enabled: true });
  await clearLaneHealth(stack.db, 'sap-main');
  await assertInvariants(stack);
});
afterAll(async () => stack?.stop());

describe('S6: late webhook', () => {
  it('invalidated by seq when the webhook lands; never rolls back afterwards', async () => {
    const t = await tenantWithInvoices(stack, { credits: 0, invoices: 0 });
    const admin = stack.mockErp!.admin;
    const budget = stack.ctx.config.cache.budgets.vendorMs;

    const first = await t.api.vendor('V-0001');
    expect(first.body.meta).toMatchObject({ seq: 1, source: 'erp' });
    expect((await t.api.vendor('V-0001')).body.meta.source).toBe('cache');

    // Changed "via another channel"; the webhook will arrive 40 s (scaled) later.
    await admin.patchVendor(t.companyCode, 'V-0001', { name: 'Changed In SAP' }, T(40_000));

    // Before the webhook: we may serve seq 1, but only within the declared budget.
    const until = Date.now() + T(30_000);
    while (Date.now() < until) {
      const r = await t.api.vendor('V-0001');
      expect(r.status).toBe(200);
      expect(r.body.meta.age_ms).toBeLessThanOrEqual(budget);
      await sleep(T(2000));
    }

    // The webhook lands (seq 2) …
    await waitFor(
      async () =>
        (
          await stack.db
            .selectFrom('erp_events')
            .select('seq')
            .where('object_id', '=', 'V-0001')
            .where('company_code', '=', t.companyCode)
            .execute()
        ).some((e) => e.seq === 2),
      { timeoutMs: T(40_000) + 10_000 },
    );
    // … from now on a read older than it is impossible to observe.
    for (let i = 0; i < 50; i++) {
      const r = await t.api.vendor('V-0001');
      expect(r.body.meta.seq).toBe(2);
      expect(r.body.data.name).toBe('Changed In SAP');
    }

    // An out-of-order / duplicate older event cannot roll the cache back.
    const raw = JSON.stringify({
      event_id: `old-${Date.now()}`,
      company_code: t.companyCode,
      object_type: 'vendor',
      object_id: 'V-0001',
      seq: 1,
      occurred_at: new Date().toISOString(),
    });
    const wh = await stack.api.request('/v1/webhooks/erp/sap-main', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-erp-signature': `sha256=${hmacSha256Hex(TEST_WEBHOOK_SECRET, raw)}`,
      },
      body: raw,
    });
    expect(wh.status).toBe(204);
    expect((await t.api.vendor('V-0001')).body.meta.seq).toBe(2);

    // A stale ERP replica after the webhook: the fill is rejected and the old version is NEVER served.
    const { id: staleId } = await admin.addFault({
      mode: 'stale_reads',
      lag_ms: T(600_000),
      match: { method: 'GET' },
    });
    await stack.redis.del(stack.ctx.keys.cacheEntry('sap-main', t.companyCode, 'vendor', 'V-0001')); // force a miss
    const stale = await t.api.vendor('V-0001');
    expect(stale.status).toBe(503);
    expect(stale.body.error.code).toBe('upstream_stale');
    expect(await staleSuspectedUntil(stack.db, 'sap-main')).not.toBeNull(); // evidence for the reconciler (D2)
    await admin.removeFault(staleId);
    expect((await t.api.vendor('V-0001')).body.meta.seq).toBe(2);
  });

  it('TTL backstop: with the webhook lost, the change is visible within the vendor budget (I10)', async () => {
    const t = await tenantWithInvoices(stack, { credits: 0, invoices: 0 });
    const admin = stack.mockErp!.admin;
    const budget = stack.ctx.config.cache.budgets.vendorMs;
    await admin.putConfig({ webhooks_enabled: false });
    expect((await t.api.vendor('V-0002')).body.meta.seq).toBe(1);

    const tWrite = Date.now();
    await admin.patchVendor(t.companyCode, 'V-0002', { name: 'Webhook Lost' });
    const seen = await waitFor(
      async () => {
        const r = await t.api.vendor('V-0002');
        return r.body.meta.seq === 2 ? Date.now() : undefined;
      },
      { timeoutMs: budget + 5000, intervalMs: T(1000) },
    );
    expect(seen - tWrite).toBeLessThanOrEqual(budget);
  });
});
