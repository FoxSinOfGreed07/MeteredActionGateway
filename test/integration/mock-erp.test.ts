import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockAdminClient } from '../../src/mock-erp/admin-client.js';
import { createMockErp, type RunningMockErp } from '../../src/mock-erp/app.js';
import type { Invoice } from '../../src/mock-erp/types.js';
import { hmacSha256Hex } from '../../src/shared/hash.js';
import { sleep, waitFor } from '../kit/wait.js';

const SECRET = 'mock-test-secret';
const received: { body: string; signature: string | null; atMs: number }[] = [];
let receiverClose: () => void;
let mock: ReturnType<typeof createMockErp>;
let running: RunningMockErp;
let admin: MockAdminClient;
let base: string;

beforeAll(async () => {
  const recv = new Hono();
  recv.post('/hook', async (c) => {
    received.push({
      body: await c.req.text(),
      signature: c.req.header('x-erp-signature') ?? null,
      atMs: Date.now(),
    });
    return c.body(null, 204);
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: recv.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  receiverClose = () => server.close();

  mock = createMockErp({
    config: {
      webhook_url: `http://127.0.0.1:${port}/hook`,
      webhook_secret: SECRET,
      rate_limit_rps: 10_000,
      rate_limit_burst: 10_000,
    },
  });
  running = await mock.start(0, '127.0.0.1');
  base = running.url;
  admin = new MockAdminClient(base);
});

afterAll(async () => {
  await running?.close();
  receiverClose?.();
});

afterEach(async () => {
  await admin.reset();
  await admin.putConfig({
    rate_limit_rps: 10_000,
    rate_limit_burst: 10_000,
    webhooks_enabled: true,
    webhook_delay_ms: 500,
  });
  received.length = 0;
});

async function openInvoice(cc = 'C100'): Promise<Invoice> {
  const { invoices } = await admin.invoices(cc, { status: 'OPEN', limit: 1 });
  return invoices[0]!;
}

function pay(cc: string, body: object, signal?: AbortSignal) {
  return fetch(`${base}/companies/${cc}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

const payBody = (inv: Invoice, reference: string) => ({
  invoice_id: inv.invoice_id,
  amount_minor: inv.open_amount_minor,
  currency: 'INR',
  reference,
});

describe('mock ERP', () => {
  it('1. pays an OPEN invoice: invoice PAID, seq+1, payment carries the reference', async () => {
    const inv = await openInvoice();
    const res = await pay('C100', payBody(inv, 'ref-1'));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payment: { reference: string }; invoice: Invoice };
    expect(body.payment.reference).toBe('ref-1');
    expect(body.invoice.status).toBe('PAID');
    expect(body.invoice.open_amount_minor).toBe(0);
    expect(body.invoice.seq).toBe(inv.seq + 1);
    expect((await admin.stats()).payments_created).toBe(1);
  });

  it('2. paying the same invoice again → 409 INVOICE_ALREADY_PAID with the invoice', async () => {
    const inv = await openInvoice();
    expect((await pay('C100', payBody(inv, 'a'))).status).toBe(201);
    const res = await pay('C100', payBody(inv, 'b'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; invoice: Invoice };
    expect(body.code).toBe('INVOICE_ALREADY_PAID');
    expect(body.invoice.status).toBe('PAID');
  });

  it('3. wrong amount → 422 AMOUNT_MISMATCH; nothing created', async () => {
    const inv = await openInvoice();
    const res = await pay('C100', { ...payBody(inv, 'x'), amount_minor: inv.open_amount_minor + 1 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('AMOUNT_MISMATCH');
    expect(await admin.primaryPayments('C100')).toHaveLength(0);
  });

  it('4. unknown invoice → 404', async () => {
    const res = await pay('C100', {
      invoice_id: 'INV-NOPE',
      amount_minor: 1,
      currency: 'INR',
      reference: 'r',
    });
    expect(res.status).toBe(404);
  });

  it('5. the same reference on two invoices creates TWO payments (mock is not idempotent, S2)', async () => {
    const { invoices } = await admin.invoices('C100', { status: 'OPEN', limit: 2 });
    for (const inv of invoices) expect((await pay('C100', payBody(inv, 'dup-ref'))).status).toBe(201);
    const res = await fetch(`${base}/companies/C100/payments?reference=dup-ref`);
    expect(((await res.json()) as { payments: unknown[] }).payments).toHaveLength(2);
  });

  it('6. two concurrent posts for the same invoice → exactly one 201 and one 409', async () => {
    const inv = await openInvoice();
    const statuses = (
      await Promise.all([pay('C100', payBody(inv, 'c1')), pay('C100', payBody(inv, 'c2'))])
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual([201, 409]);
  });

  it('7. stale_reads: old vendor version and invisible new payment; primary listing shows it', async () => {
    const inv = await openInvoice();
    const before = (await (await fetch(`${base}/companies/C100/vendors/V-0001`)).json()) as { seq: number };
    await admin.patchVendor('C100', 'V-0001', { name: 'Renamed Vendor' });
    expect((await pay('C100', payBody(inv, 'stale-ref'))).status).toBe(201);
    await admin.addFault({ mode: 'stale_reads', lag_ms: 60_000, match: { method: 'GET' } });
    const v = (await (await fetch(`${base}/companies/C100/vendors/V-0001`)).json()) as {
      seq: number;
      name: string;
    };
    expect(v.seq).toBe(before.seq);
    expect(v.name).not.toBe('Renamed Vendor');
    const lookup = (await (await fetch(`${base}/companies/C100/payments?reference=stale-ref`)).json()) as {
      payments: unknown[];
    };
    expect(lookup.payments).toHaveLength(0);
    expect(await admin.primaryPayments('C100', { reference: 'stale-ref' })).toHaveLength(1);
  });

  it('8. timeout_after_commit: client times out, payment IS committed', async () => {
    const inv = await openInvoice();
    await admin.addFault({ mode: 'timeout_after_commit', hang_ms: 2000, match: { method: 'POST' } });
    await expect(pay('C100', payBody(inv, 't1'), AbortSignal.timeout(300))).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(await admin.primaryPayments('C100', { reference: 't1' })).toHaveLength(1);
  });

  it('9. drop_after_commit: fetch rejects, payment IS committed', async () => {
    const inv = await openInvoice();
    await admin.addFault({ mode: 'drop_after_commit', match: { method: 'POST' } });
    await expect(pay('C100', payBody(inv, 'd1'))).rejects.toThrow();
    expect(await admin.primaryPayments('C100', { reference: 'd1' })).toHaveLength(1);
  });

  it('10. drop_before_commit: fetch rejects, NO payment', async () => {
    const inv = await openInvoice();
    await admin.addFault({ mode: 'drop_before_commit', match: { method: 'POST' } });
    await expect(pay('C100', payBody(inv, 'd0'))).rejects.toThrow();
    expect(await admin.primaryPayments('C100', { reference: 'd0' })).toHaveLength(0);
  });

  it('11. latency longer than the client timeout → late commit', async () => {
    const inv = await openInvoice();
    await admin.addFault({ mode: 'latency', latency_ms: 1000, match: { method: 'POST' } });
    await expect(pay('C100', payBody(inv, 'late'), AbortSignal.timeout(300))).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(await admin.primaryPayments('C100', { reference: 'late' })).toHaveLength(0);
    await waitFor(async () => (await admin.primaryPayments('C100', { reference: 'late' })).length === 1, {
      timeoutMs: 3000,
    });
  });

  it('12. status_429 window with Retry-After, success after it', async () => {
    await admin.addFault({ mode: 'status_429', duration_ms: 500, retry_after_s: 2 });
    const r1 = await fetch(`${base}/companies/C100/vendors/V-0001`);
    expect(r1.status).toBe(429);
    expect(r1.headers.get('retry-after')).toBe('2');
    await sleep(600);
    expect((await fetch(`${base}/companies/C100/vendors/V-0001`)).status).toBe(200);
    expect((await admin.stats()).rate_limited_429).toBe(1);
  });

  it('13. token bucket: rapid GETs beyond the burst get 429 + Retry-After: 1', async () => {
    await admin.putConfig({ rate_limit_rps: 5, rate_limit_burst: 5 });
    const res = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${base}/companies/C100/vendors/V-0001`)),
    );
    const limited = res.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]!.headers.get('retry-after')).toBe('1');
  });

  it('14. vendor patch emits a delayed, HMAC-signed webhook with the new seq', async () => {
    await admin.putConfig({ webhook_delay_ms: 200 });
    const t0 = Date.now();
    const v = await admin.patchVendor('C100', 'V-0002', { name: 'Webhook Co' });
    const got = await waitFor(() => received.find((r) => JSON.parse(r.body).object_id === 'V-0002'), {
      timeoutMs: 3000,
    });
    expect(got.atMs - t0).toBeGreaterThanOrEqual(190);
    expect(got.signature).toBe(`sha256=${hmacSha256Hex(SECRET, got.body)}`);
    const event = JSON.parse(got.body);
    expect(event).toMatchObject({
      company_code: 'C100',
      object_type: 'vendor',
      object_id: 'V-0002',
      seq: v.seq,
    });
  });

  it('15. a count:1 fault applies exactly once', async () => {
    await admin.addFault({ mode: 'status_503', count: 1 });
    expect((await fetch(`${base}/companies/C100/vendors/V-0001`)).status).toBe(503);
    expect((await fetch(`${base}/companies/C100/vendors/V-0001`)).status).toBe(200);
  });

  it('16. reset restores seed state and clears faults and stats', async () => {
    const inv = await openInvoice();
    await pay('C100', payBody(inv, 'r'));
    await admin.addFault({ mode: 'status_503' });
    await admin.reset();
    expect((await admin.invoice('C100', inv.invoice_id)).status).toBe('OPEN');
    expect((await admin.listFaults()).faults).toHaveLength(0);
    expect((await admin.stats()).payments_created).toBe(0);
  });

  it('companies are created on demand (fresh test tenants)', async () => {
    const { invoice_ids } = await admin.createInvoices('XNEW1', { count: 3, amount_minor: 100_000 });
    expect(invoice_ids).toEqual(['INV-XNEW1-00001', 'INV-XNEW1-00002', 'INV-XNEW1-00003']);
    expect((await fetch(`${base}/companies/XNEW1/vendors/V-0001`)).status).toBe(200);
  });

  it('seed data is deterministic (seed 42)', () => {
    const other = createMockErp();
    expect(other.state.getVendor('C100', 'V-0001')?.gstin).toBe(
      mock.state.getVendor('C100', 'V-0001')?.gstin,
    );
  });
});
