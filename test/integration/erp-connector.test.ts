import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpErpConnector } from '../../src/gateway/erp/http-erp-connector.js';
import { ErpReadError, type PostPaymentRequest } from '../../src/gateway/erp/index.js';
import type { Invoice } from '../../src/mock-erp/types.js';
import { type Stack, startStack } from '../kit/stack.js';
import { waitFor } from '../kit/wait.js';

let stack: Stack;
let erp: HttpErpConnector;
beforeAll(async () => {
  stack = await startStack({
    timeScale: 1,
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    lanes: [{ id: 'sap-main', kind: 'erp', request_timeout_ms: 300, lease_ms: 1000 }],
  });
  erp = new HttpErpConnector({ id: 'sap-main', base_url: stack.mockErp!.url, request_timeout_ms: 300 });
});
afterEach(async () => {
  await stack.mockErp!.admin.reset();
  await stack.mockErp!.admin.putConfig({ rate_limit_rps: 10_000, rate_limit_burst: 10_000 });
});
afterAll(async () => {
  await stack?.stop();
});

const admin = () => stack.mockErp!.admin;
async function openInvoice(): Promise<Invoice> {
  return (await admin().invoices('C100', { status: 'OPEN', limit: 1 })).invoices[0]!;
}
const req = (inv: Invoice, reference: string, amount = inv.open_amount_minor): PostPaymentRequest => ({
  companyCode: 'C100',
  invoiceId: inv.invoice_id,
  amountMinor: amount,
  currency: 'INR',
  reference,
});
const paymentsFor = (reference: string) => admin().primaryPayments('C100', { reference });

/** A port that was just free: bind, read the port, close. (Port 9 etc. are fetch "bad ports", not closed.) */
async function closedPort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('ERP connector outcomes against the mock (A8)', () => {
  it('no fault → committed, invoice seq increased', async () => {
    const inv = await openInvoice();
    const o = await erp.postPayment(req(inv, 'ok-1'));
    expect(o.kind).toBe('committed');
    if (o.kind === 'committed') expect(o.value.invoice?.seq).toBe(inv.seq + 1);
    expect(await paymentsFor('ok-1')).toHaveLength(1);
  });

  it.each([
    [
      'status_429',
      { retry_after_s: 2 },
      { kind: 'retryable', reason: 'rate_limited', retryAfterMs: 2000 },
      0,
    ],
    ['status_503', {}, { kind: 'retryable', reason: 'unavailable' }, 0],
    ['timeout_after_commit', { hang_ms: 2000 }, { kind: 'ambiguous', reason: 'timeout' }, 1],
    ['drop_after_commit', {}, { kind: 'ambiguous', reason: 'connection_reset' }, 1],
    ['error_500_after_commit', {}, { kind: 'ambiguous', reason: 'http_5xx' }, 1],
    ['drop_before_commit', {}, { kind: 'ambiguous', reason: 'connection_reset' }, 0],
  ] as const)('%s → %j (primary payments: %i)', async (mode, extra, expected, committed) => {
    const inv = await openInvoice();
    await admin().addFault({ mode, match: { method: 'POST' }, ...extra });
    const ref = `f-${mode}`;
    expect(await erp.postPayment(req(inv, ref))).toMatchObject(expected);
    expect(await paymentsFor(ref)).toHaveLength(committed);
  });

  it('latency beyond the timeout → ambiguous/timeout, then a LATE commit appears', async () => {
    const inv = await openInvoice();
    await admin().addFault({ mode: 'latency', latency_ms: 1000, match: { method: 'POST' } });
    expect(await erp.postPayment(req(inv, 'late'))).toMatchObject({ kind: 'ambiguous', reason: 'timeout' });
    expect(await paymentsFor('late')).toHaveLength(0);
    await waitFor(async () => (await paymentsFor('late')).length === 1, { timeoutMs: 3000 });
  });

  it('amount mismatch → permanent AMOUNT_MISMATCH; nothing created', async () => {
    const inv = await openInvoice();
    expect(await erp.postPayment(req(inv, 'mm', inv.open_amount_minor + 1))).toMatchObject({
      kind: 'permanent',
      code: 'AMOUNT_MISMATCH',
      httpStatus: 422,
    });
    expect(await paymentsFor('mm')).toHaveLength(0);
  });

  it('already paid → permanent INVOICE_ALREADY_PAID with details.invoice.status = PAID', async () => {
    const inv = await openInvoice();
    await erp.postPayment(req(inv, 'p1'));
    const o = await erp.postPayment(req(inv, 'p2'));
    expect(o).toMatchObject({
      kind: 'permanent',
      code: 'INVOICE_ALREADY_PAID',
      details: { invoice: { status: 'PAID' } },
    });
  });

  it('ERP down (closed port) → retryable/unreachable', async () => {
    const port = await closedPort();
    const dead = new HttpErpConnector({
      id: 'x',
      base_url: `http://127.0.0.1:${port}`,
      request_timeout_ms: 300,
    });
    const inv = await openInvoice();
    expect(await dead.postPayment(req(inv, 'dead'))).toEqual({ kind: 'retryable', reason: 'unreachable' });
  });

  it('reads: vendor ok / not_found; 429 throws ErpReadError(rate_limited); lookup returns 0, 1 or 2', async () => {
    expect(await erp.getVendor('C100', 'V-0001')).toMatchObject({ status: 'ok', seq: 1 });
    expect(await erp.getVendor('C100', 'V-9999')).toEqual({ status: 'not_found' });
    await admin().addFault({ mode: 'status_429', count: 1, match: { method: 'GET' } });
    await expect(erp.getVendor('C100', 'V-0001')).rejects.toMatchObject({
      name: 'ErpReadError',
      kind: 'rate_limited',
    });
    expect(await erp.findPaymentsByReference('C100', 'twice')).toHaveLength(0);
    const { invoices } = await admin().invoices('C100', { status: 'OPEN', limit: 2 });
    await erp.postPayment(req(invoices[0]!, 'twice'));
    expect(await erp.findPaymentsByReference('C100', 'twice')).toHaveLength(1);
    await erp.postPayment(req(invoices[1]!, 'twice'));
    expect(await erp.findPaymentsByReference('C100', 'twice')).toHaveLength(2);
    expect(ErpReadError).toBeDefined();
  });
});
