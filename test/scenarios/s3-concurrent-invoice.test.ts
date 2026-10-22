/**
 * Scenario 3 — Tenant admin
 * Situation: two agents try to pay the same invoice concurrently (different idempotency keys).
 * Expected:  exactly one succeeds; the other receives a conflict with the current state.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { assertInvariants } from '../kit/invariants.js';
import { ledgerOf, newKey, payPayload, tenantWithInvoices, waitForState } from '../kit/scenario.js';
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

it('S3: two agents, same invoice, concurrently → one SUCCEEDED, one 409 naming the active action', async () => {
  const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
  const body = payPayload(t.invoiceIds[0]!, t.amountMinor);
  const res = await Promise.all([
    t.api.submit('pay_invoice', body, newKey()),
    t.api.submit('pay_invoice', body, newKey()),
  ]);
  expect(res.map((r) => r.status).sort()).toEqual([202, 409]);
  const winner = res.find((r) => r.status === 202)!;
  const loser = res.find((r) => r.status === 409)!;

  expect(loser.body.error.code).toBe('conflict_active_action');
  expect(loser.body.error.details.active_action.id).toBe(winner.body.id);
  expect(loser.body.action.state).toBe('REJECTED');
  expect(await ledgerOf(stack, loser.body.action.id)).toEqual([]); // nothing held for the loser

  await waitForState(stack, winner.body.id, 'SUCCEEDED');
  expect(
    await stack.mockErp!.admin.primaryPayments(t.companyCode, { invoice_id: t.invoiceIds[0]! }),
  ).toHaveLength(1);
});

it('S3b: a third agent after the payment completed → ERP says INVOICE_ALREADY_PAID; FAILED with the current state; net zero', async () => {
  const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
  const body = payPayload(t.invoiceIds[0]!, t.amountMinor);
  const first = await t.api.submit('pay_invoice', body, newKey());
  await waitForState(stack, first.body.id, 'SUCCEEDED');

  const late = await t.api.submit('pay_invoice', body, newKey());
  expect(late.status).toBe(202); // the gateway index no longer covers it — the ERP is the backstop
  const failed = await waitForState(stack, late.body.id, 'FAILED');
  expect(failed.failure_code).toBe('INVOICE_ALREADY_PAID');
  expect(failed.result).toMatchObject({ current_state: { status: 'PAID', invoice_id: t.invoiceIds[0] } });
  expect((await ledgerOf(stack, failed.id)).map((l) => [l.kind, l.amount])).toEqual([
    ['HOLD', 300],
    ['RELEASE', 300],
  ]);
  expect(
    await stack.mockErp!.admin.primaryPayments(t.companyCode, { invoice_id: t.invoiceIds[0]! }),
  ).toHaveLength(1);
  const detail = await t.api.getAction(late.body.id);
  expect(detail.body.failure).toMatchObject({ code: 'INVOICE_ALREADY_PAID' });
});
