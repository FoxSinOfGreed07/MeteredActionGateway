/**
 * Scenario 1 — Tenant admin
 * Situation: the same action is submitted twice with the same key, 200 ms apart.
 * Expected:  one ERP write, one debit, identical responses.
 * Doc numbers: 200 ms gap (used literally; the ERP is slowed to 500 ms so the first is still in flight).
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { assertInvariants } from '../kit/invariants.js';
import { ledgerOf, newKey, payPayload, tenantWithInvoices, waitForState } from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';
import { sleep } from '../kit/wait.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    // lane timeout (scaled) must exceed the injected 500 ms ERP latency
    lanes: [
      { id: 'sap-main', kind: 'erp', request_timeout_ms: 20_000, lease_ms: 60_000 },
      { id: 'llm', kind: 'llm' },
    ],
    worker: true,
  });
});
afterEach(async () => assertInvariants(stack));
afterAll(async () => stack?.stop());

it('S1: same key twice, 200 ms apart → one ERP write, one debit, identical responses', async () => {
  const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
  const admin = stack.mockErp!.admin;
  await admin.resetStats();
  await admin.addFault({
    mode: 'latency',
    latency_ms: 500,
    match: { method: 'POST', path: '/companies/*/payments' },
  });

  const key = newKey();
  const body = payPayload(t.invoiceIds[0]!, t.amountMinor);
  const first = await t.api.submit('pay_invoice', body, key, { viaHttp: true });
  await sleep(200);
  const second = await t.api.submit('pay_invoice', body, key, { viaHttp: true });

  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(second.body).toEqual(first.body); // identical responses
  expect(first.headers.get('idempotent-replayed')).toBeNull();
  expect(second.headers.get('idempotent-replayed')).toBe('true');

  const action = await waitForState(stack, first.body.id, 'SUCCEEDED');
  expect((await admin.stats()).payment_posts_received).toBe(1); // one ERP write
  expect(await admin.primaryPayments(t.companyCode, { reference: action.id })).toHaveLength(1);
  expect((await ledgerOf(stack, action.id)).map((l) => [l.kind, l.amount])).toEqual([
    ['HOLD', 300],
    ['CAPTURE', 300],
  ]); // one debit
  expect((await t.api.wallet()).body).toMatchObject({ available: 10_000 - 300, held: 0 });
});
