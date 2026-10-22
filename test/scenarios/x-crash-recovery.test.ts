/**
 * Extra (Constraint 4): no action executes without a durable record written before the ERP call, and a crash
 * between the record and the call is recoverable on restart.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { claimNext } from '../../src/gateway/dispatch/claim.js';
import { assertInvariants } from '../kit/invariants.js';
import { eventsOf, newKey, payPayload, tenantWithInvoices, waitForState } from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';
import { T } from '../kit/time.js';
import { waitFor } from '../kit/wait.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    lanes: [
      { id: 'sap-main', kind: 'erp', request_timeout_ms: 5000, lease_ms: 8000 },
      { id: 'llm', kind: 'llm' },
    ],
    worker: true,
  });
});
afterEach(async () => {
  await stack.mockErp!.admin.clearFaults();
  if (!stack.worker.running) await stack.worker.start();
  await assertInvariants(stack);
});
afterAll(async () => stack?.stop());

describe('crash recovery', () => {
  it('(a) crash between the durable DISPATCHING record and the ERP call → recovered: UNKNOWN → not found → re-sent once', async () => {
    const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
    await stack.worker.stop();
    const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
    // The worker claims (commits DISPATCHING + lease) … and "crashes" before sending.
    const claimed = await claimNext(stack.ctx, { id: 'sap-main', lease_ms: T(1000) }, 'crashed-worker');
    expect(claimed?.id).toBe(res.body.id);
    await stack.mockErp!.admin.resetStats();

    await stack.worker.start(); // the process comes back
    const done = await waitForState(stack, res.body.id, 'SUCCEEDED', 30_000);
    const reasons = (await eventsOf(stack, done.id)).map((e) => e.reason);
    expect(reasons).toEqual([
      'submitted',
      'claimed',
      'lease_expired',
      'reconciled:not_found_redispatch',
      'claimed',
      'erp_committed',
    ]);
    expect((await stack.mockErp!.admin.stats()).payment_posts_received).toBe(1);
    expect(
      await stack.mockErp!.admin.primaryPayments(t.companyCode, { invoice_id: t.invoiceIds[0]! }),
    ).toHaveLength(1);
  });

  it('(b) crash after the ERP committed but before we settled → recovered: UNKNOWN → found → SUCCEEDED, never re-sent', async () => {
    const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
    const admin = stack.mockErp!.admin;
    await admin.resetStats();
    await admin.addFault({
      mode: 'timeout_after_commit',
      hang_ms: T(60_000),
      count: 1,
      match: { method: 'POST', path: '/companies/*/payments' },
    });

    const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
    // Wait until SAP has committed (the response is still hanging), then kill the worker.
    await waitFor(
      async () => (await admin.primaryPayments(t.companyCode, { reference: res.body.id })).length === 1,
      { timeoutMs: 10_000 },
    );
    await stack.worker.stop({ abandon: true });
    expect((await waitForState(stack, res.body.id, 'DISPATCHING')).state).toBe('DISPATCHING');

    await stack.worker.start(); // recovery runs on start and every interval
    const done = await waitForState(stack, res.body.id, 'SUCCEEDED', 30_000);
    expect(done.confirmed_via).toBe('reconcile');
    expect((await eventsOf(stack, done.id)).map((e) => e.reason)).toEqual([
      'submitted',
      'claimed',
      'lease_expired',
      'reconciled:found',
    ]);
    expect((await admin.stats()).payment_posts_received).toBe(1);
  });
});
