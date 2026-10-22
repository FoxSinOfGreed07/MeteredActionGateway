/**
 * Scenario 2 — Finance user
 * Situation: SAP commits the payment, then the connection drops before the response.
 * Expected:  action marked UNKNOWN; the gateway queries SAP by reference before any refund or retry; no
 *            double payment.
 * Doc numbers: none (timings scaled by SCENARIO_TIME_SCALE).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FaultRule } from '../../src/mock-erp/types.js';
import { assertInvariants } from '../kit/invariants.js';
import { eventsOf, ledgerOf, newKey, payPayload, tenantWithInvoices, waitForState } from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';
import { T } from '../kit/time.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    // first lookup a little later than the default so the test can observe the UNKNOWN state with HOLD only
    config: { reconciler: { firstLookupDelayMs: 5000 } },
    worker: true,
  });
});
afterEach(async () => {
  await stack.mockErp!.admin.clearFaults();
  await assertInvariants(stack);
});
afterAll(async () => stack?.stop());

const POST_PAYMENTS = { method: 'POST' as const, path: '/companies/*/payments' };

async function runCommittedCase(fault: FaultRule, expectedReason: string) {
  const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
  const admin = stack.mockErp!.admin;
  await admin.resetStats();
  await admin.addFault({ ...fault, count: 1, match: POST_PAYMENTS });

  const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
  const unknown = await waitForState(stack, res.body.id, 'UNKNOWN');

  // At this point SAP HAS the payment, but we don't know it. No retry, no refund: just the hold.
  expect(await admin.primaryPayments(t.companyCode, { reference: unknown.id })).toHaveLength(1);
  expect((await admin.stats()).payment_posts_received).toBe(1);
  expect((await ledgerOf(stack, unknown.id)).map((l) => l.kind)).toEqual(['HOLD']);

  // The reconciler queries SAP by reference and finds it → SUCCEEDED + CAPTURE.
  const done = await waitForState(stack, unknown.id, 'SUCCEEDED');
  expect(done.confirmed_via).toBe('reconcile');
  expect((await ledgerOf(stack, done.id)).map((l) => [l.kind, l.amount])).toEqual([
    ['HOLD', 300],
    ['CAPTURE', 300],
  ]);
  expect((await admin.stats()).payment_posts_received).toBe(1); // never resent
  expect(await admin.primaryPayments(t.companyCode, { invoice_id: t.invoiceIds[0]! })).toHaveLength(1);
  expect((await eventsOf(stack, done.id)).map((e) => e.reason)).toEqual([
    'submitted',
    'claimed',
    expectedReason,
    'reconciled:found',
  ]);
}

describe('S2: committed, then the connection drops', () => {
  it('timeout after commit → UNKNOWN → lookup by reference → SUCCEEDED; one payment', async () => {
    await runCommittedCase({ mode: 'timeout_after_commit', hang_ms: T(30_000) }, 'ambiguous:timeout');
  });

  it('connection reset after commit → same outcome', async () => {
    await runCommittedCase({ mode: 'drop_after_commit' }, 'ambiguous:connection_reset');
  });

  it('HTTP 500 after commit → same outcome', async () => {
    await runCommittedCase({ mode: 'error_500_after_commit' }, 'ambiguous:http_5xx');
  });

  it('NOT committed (dropped before commit) → trusted not-found after the window → re-sent with the same reference → one payment', async () => {
    const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
    const admin = stack.mockErp!.admin;
    await admin.resetStats();
    await admin.addFault({ mode: 'drop_before_commit', count: 1, match: POST_PAYMENTS });

    const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
    await waitForState(stack, res.body.id, 'UNKNOWN');
    expect(await admin.primaryPayments(t.companyCode, { reference: res.body.id })).toHaveLength(0);

    const done = await waitForState(stack, res.body.id, 'SUCCEEDED', 30_000);
    expect(done.confirmed_via).toBe('response');
    expect((await admin.stats()).payment_posts_received).toBe(2);
    expect(await admin.primaryPayments(t.companyCode, { invoice_id: t.invoiceIds[0]! })).toHaveLength(1);
    expect((await eventsOf(stack, done.id)).map((e) => e.reason)).toEqual([
      'submitted',
      'claimed',
      'ambiguous:connection_reset',
      'reconciled:not_found_redispatch',
      'claimed',
      'erp_committed',
    ]);
    expect((await ledgerOf(stack, done.id)).map((l) => l.kind)).toEqual(['HOLD', 'CAPTURE']);
  });
});
