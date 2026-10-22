/**
 * Scenario 4 — Tenant
 * Situation: the wallet holds 500 credits; an action costs 300; a second 300-credit action arrives in parallel.
 * Expected:  the second action is rejected at hold time; the wallet is never driven negative.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { assertInvariants } from '../kit/invariants.js';
import { ledgerOf, mapLimit, newKey, payPayload, tenantWithInvoices, waitForState } from '../kit/scenario.js';
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

it('S4: 500 credits, two 300-credit actions in parallel → one runs, the other is rejected at hold time; never negative', async () => {
  const t = await tenantWithInvoices(stack, { credits: 500, invoices: 2 });
  const res = await Promise.all(
    t.invoiceIds.map((inv) => t.api.submit('pay_invoice', payPayload(inv, t.amountMinor), newKey())),
  );
  expect(res.map((r) => r.status).sort()).toEqual([202, 402]);

  const rejected = res.find((r) => r.status === 402)!;
  expect(rejected.body.error).toMatchObject({
    code: 'insufficient_credits',
    details: { required: 300, available: 200 },
  });
  expect(rejected.body.action.state).toBe('REJECTED');
  expect(await ledgerOf(stack, rejected.body.action.id)).toEqual([]); // rejected at hold time: nothing held

  const winner = await waitForState(stack, res.find((r) => r.status === 202)!.body.id, 'SUCCEEDED');
  expect((await ledgerOf(stack, winner.id)).map((l) => [l.kind, l.amount])).toEqual([
    ['HOLD', 300],
    ['CAPTURE', 300],
  ]);
  expect((await t.api.wallet()).body).toMatchObject({ available: 200, held: 0, consistent: true });
  // The rejected invoice was never sent to the ERP.
  expect(await stack.mockErp!.admin.primaryPayments(t.companyCode)).toHaveLength(1);
});

it('S4 stress: 3,000 credits, 50 parallel 300-credit submits → exactly 10 accepted, 40 rejected, never negative', async () => {
  const t = await tenantWithInvoices(stack, { credits: 3000, invoices: 50 });
  const statuses = await mapLimit(
    t.invoiceIds,
    50,
    async (inv) => (await t.api.submit('pay_invoice', payPayload(inv, t.amountMinor), newKey())).status,
  );
  expect(statuses.filter((s) => s === 202)).toHaveLength(10);
  expect(statuses.filter((s) => s === 402)).toHaveLength(40);
  const w = (await t.api.wallet()).body;
  expect(w.available).toBe(0);
  expect(w.available + w.held).toBeLessThanOrEqual(3000);
  const neg = await stack.db.selectFrom('wallets').select('available').where('available', '<', 0).execute();
  expect(neg).toHaveLength(0);
});
