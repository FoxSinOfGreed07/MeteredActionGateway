/**
 * Extra (D2 trust window): an abandoned request commits AFTER our timeout.
 * Expected: the early "not found" is NOT trusted (too early); the later lookup finds it; one payment — a
 *           reconciler that trusted the early answer would have re-sent and paid twice.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { assertInvariants } from '../kit/invariants.js';
import { eventsOf, newKey, payPayload, tenantWithInvoices, waitForState } from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';
import { T } from '../kit/time.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    worker: true,
  });
});
afterEach(async () => assertInvariants(stack));
afterAll(async () => stack?.stop());

it('late commit: early not-found is too early; the payment is found later; exactly one payment', async () => {
  const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
  const admin = stack.mockErp!.admin;
  await admin.resetStats();
  // Client times out at T(5s); the ERP keeps going and commits at T(10s) (trust window: timeout + lag = T(10s)).
  await admin.addFault({
    mode: 'latency',
    latency_ms: T(10_000),
    count: 1,
    match: { method: 'POST', path: '/companies/*/payments' },
  });

  const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
  const unknown = await waitForState(stack, res.body.id, 'UNKNOWN');
  expect(await admin.primaryPayments(t.companyCode, { reference: unknown.id })).toHaveLength(0); // not yet

  const done = await waitForState(stack, unknown.id, 'SUCCEEDED', 30_000);
  expect(done.confirmed_via).toBe('reconcile');
  expect(done.reconcile_attempts).toBeGreaterThanOrEqual(2); // at least one untrusted early lookup
  expect((await admin.stats()).payment_posts_received).toBe(1);
  expect(await admin.primaryPayments(t.companyCode, { invoice_id: t.invoiceIds[0]! })).toHaveLength(1);
  expect((await eventsOf(stack, done.id)).map((e) => e.reason)).toEqual([
    'submitted',
    'claimed',
    'ambiguous:timeout',
    'reconciled:found',
  ]);
});
