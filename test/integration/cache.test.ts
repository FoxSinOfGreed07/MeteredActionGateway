import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../../src/shared/hash.js';
import { assertInvariants } from '../kit/invariants.js';
import { newKey, payPayload, tenantWithInvoices, waitForState } from '../kit/scenario.js';
import { type Stack, startStack, TEST_WEBHOOK_SECRET } from '../kit/stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000, webhook_delay_ms: 50 } },
    worker: true,
  });
});
afterEach(async () => {
  await stack.mockErp!.admin.clearFaults();
  await assertInvariants(stack);
});
afterAll(async () => stack?.stop());

function signedWebhook(body: object, secret = TEST_WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  return stack.api.request('/v1/webhooks/erp/sap-main', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-erp-signature': `sha256=${hmacSha256Hex(secret, raw)}`,
    },
    body: raw,
  });
}

describe('read cache (D4/D5/D6)', () => {
  it('miss → erp; then cache; one ERP read', async () => {
    const t = await tenantWithInvoices(stack, { credits: 0, invoices: 0 });
    await stack.mockErp!.admin.resetStats();
    const a = await t.api.vendor('V-0001');
    expect(a.status).toBe(200);
    expect(a.body.meta).toMatchObject({ seq: 1, source: 'erp' });
    const b = await t.api.vendor('V-0001');
    expect(b.body.meta.source).toBe('cache');
    expect((await stack.mockErp!.admin.stats()).reads.vendor[`${t.companyCode}/V-0001`]).toBe(1);
    expect((await t.api.vendor('V-9999')).status).toBe(404);
  });

  it('own write: paying an invoice invalidates its cached entry with the new seq', async () => {
    const t = await tenantWithInvoices(stack, { credits: 1000, invoices: 1 });
    const inv = t.invoiceIds[0]!;
    const before = await t.api.invoice(inv);
    expect(before.body.data.status).toBe('OPEN');
    const res = await t.api.submit('pay_invoice', payPayload(inv, t.amountMinor), newKey());
    await waitForState(stack, res.body.id, 'SUCCEEDED');
    const after = await t.api.invoice(inv);
    expect(after.body.data.status).toBe('PAID');
    expect(after.body.meta.seq).toBeGreaterThan(before.body.meta.seq);
  });

  it('duplicate webhook (same event_id) → one erp_events row, both 204', async () => {
    const event = {
      event_id: 'evt-dup-1',
      company_code: 'C100',
      object_type: 'vendor',
      object_id: 'V-0005',
      seq: 7,
      occurred_at: new Date().toISOString(),
    };
    expect((await signedWebhook(event)).status).toBe(204);
    expect((await signedWebhook(event)).status).toBe(204);
    const rows = await stack.db
      .selectFrom('erp_events')
      .select('id')
      .where('event_id', '=', 'evt-dup-1')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('bad HMAC → 401; unknown lane → 404; bad body → 400', async () => {
    const event = {
      event_id: 'evt-bad',
      company_code: 'C100',
      object_type: 'vendor',
      object_id: 'V-0005',
      seq: 8,
      occurred_at: new Date().toISOString(),
    };
    expect((await signedWebhook(event, 'wrong-secret')).status).toBe(401);
    expect((await stack.api.request('/v1/webhooks/erp/nope', { method: 'POST', body: '{}' })).status).toBe(
      404,
    );
    expect((await signedWebhook({ nope: true })).status).toBe(400);
  });

  it('read during a lane cooldown → 503 upstream_unavailable with Retry-After; no ERP read', async () => {
    const t = await tenantWithInvoices(stack, { credits: 0, invoices: 0 });
    await stack.mockErp!.admin.resetStats();
    await stack.redis.set(stack.ctx.keys.cooldown('sap-main'), '1', 'PX', 2000);
    try {
      const r = await t.api.vendor('V-0002');
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('upstream_unavailable');
      expect(r.headers.get('retry-after')).not.toBeNull();
      expect((await stack.mockErp!.admin.stats()).reads.vendor[`${t.companyCode}/V-0002`]).toBeUndefined();
    } finally {
      await stack.redis.del(stack.ctx.keys.cooldown('sap-main'));
    }
  });
});
