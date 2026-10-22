/**
 * Scenario 8 — Tenant
 * Situation: the action fails permanently (validation error) after the wallet hold was placed.
 * Expected:  hold released; the ledger shows hold, release and reason; no net charge.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { assertInvariants } from '../kit/invariants.js';
import { eventsOf, ledgerOf, newKey, payPayload, tenantWithInvoices, waitForState } from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    worker: true,
  });
});
afterEach(async () => assertInvariants(stack));
afterAll(async () => stack?.stop());

it('S8: amount mismatch → FAILED; ledger [HOLD 300, RELEASE 300 with reason]; wallet unchanged; no retry', async () => {
  const t = await tenantWithInvoices(stack, { credits: 1000, invoices: 1 });
  const admin = stack.mockErp!.admin;
  await admin.resetStats();
  const before = (await t.api.wallet()).body;

  const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor + 1), newKey());
  expect(res.status).toBe(202); // the hold was placed
  const a = await waitForState(stack, res.body.id, 'FAILED');

  expect(a.failure_code).toBe('AMOUNT_MISMATCH');
  const ledger = await ledgerOf(stack, a.id);
  expect(ledger.map((l) => [l.kind, l.amount])).toEqual([
    ['HOLD', 300],
    ['RELEASE', 300],
  ]);
  expect(ledger[1]!.reason).toContain('AMOUNT_MISMATCH');
  expect((await t.api.wallet()).body).toMatchObject({ available: before.available, held: before.held });
  expect((await eventsOf(stack, a.id)).map((e) => e.reason)).toEqual([
    'submitted',
    'claimed',
    'erp_rejected:AMOUNT_MISMATCH',
  ]);

  const stats = await admin.stats();
  expect(stats.payment_posts_received).toBe(1); // permanent → never retried
  expect(stats.payments_created).toBe(0);
});
