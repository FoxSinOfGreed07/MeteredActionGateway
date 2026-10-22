/**
 * Extra (review twist): the ERP serves stale reads for a 10-minute window while an UNKNOWN is pending.
 * Expected: no refund and no retry until the read view is provably fresh — a stale "not found" never
 *           causes a double payment or a free action.
 * Doc numbers: 10 minutes (scaled).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  clearLaneHealth,
  reportStaleEvidence,
  staleSuspectedUntil,
} from '../../src/gateway/reconcile/lane-health.js';
import { opsClient } from '../kit/clients.js';
import { assertInvariants } from '../kit/invariants.js';
import {
  getAction,
  ledgerOf,
  newKey,
  payPayload,
  tenantWithInvoices,
  waitForState,
} from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';
import { T } from '../kit/time.js';
import { sleep, waitFor } from '../kit/wait.js';

const POST_PAYMENTS = { method: 'POST' as const, path: '/companies/*/payments' };

describe('stale reads for 10 minutes with an UNKNOWN pending (witness available)', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({
      mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
      worker: true,
    });
  });
  afterEach(async () => assertInvariants(stack));
  afterAll(async () => stack?.stop());

  it('stays UNKNOWN (no retry, no refund) while stale; resolves to SUCCEEDED once fresh', async () => {
    const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 4 });
    const admin = stack.mockErp!.admin;
    const { id: staleId } = await admin.addFault({
      mode: 'stale_reads',
      lag_ms: T(600_000),
      duration_ms: T(600_000),
      match: { method: 'GET' },
    });
    await admin.addFault({
      mode: 'timeout_after_commit',
      hang_ms: T(30_000),
      count: 1,
      match: POST_PAYMENTS,
    });

    const p = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
    const unknown = await waitForState(stack, p.body.id, 'UNKNOWN');
    const lane = await stack.db
      .selectFrom('lanes')
      .selectAll()
      .where('id', '=', 'sap-main')
      .executeTakeFirstOrThrow();

    // Witnesses must be dispatched after P's latest possible commit (unknown_since + request_timeout).
    await sleep(
      Math.max(0, new Date(unknown.unknown_since!).getTime() + lane.request_timeout_ms - Date.now()) + 50,
    );
    for (const inv of t.invoiceIds.slice(1)) {
      const w = await t.api.submit('pay_invoice', payPayload(inv, t.amountMinor), newKey());
      await waitForState(stack, w.body.id, 'SUCCEEDED');
    }

    // Past the time window the reconciler checks a witness: invisible in the stale view → lane quarantined.
    await waitFor(async () => (await staleSuspectedUntil(stack.db, 'sap-main')) !== null, {
      timeoutMs: 15_000,
    });
    await sleep(T(5000));
    const still = await getAction(stack, unknown.id);
    expect(still?.state).toBe('UNKNOWN');
    expect((await ledgerOf(stack, unknown.id)).map((l) => l.kind)).toEqual(['HOLD']); // no refund
    expect(await admin.primaryPayments(t.companyCode, { reference: unknown.id })).toHaveLength(1); // never re-sent
    const report = (await opsClient(stack).queue()).body;
    expect(
      report.lanes.find((l: { lane_id: string }) => l.lane_id === 'sap-main').stale_suspected_until,
    ).not.toBeNull();

    // The window ends. In production the quarantine expires on its own and the next scheduled lookup (≤
    // backoffMax away) resolves it; an operator can end it early and run `pnpm reconcile` — as here.
    await admin.removeFault(staleId);
    await clearLaneHealth(stack.db, 'sap-main');
    expect((await opsClient(stack).reconcile(true)).status).toBe(200);
    const done = await waitForState(stack, unknown.id, 'SUCCEEDED', 30_000);
    expect(done.confirmed_via).toBe('reconcile');
    expect(await admin.primaryPayments(t.companyCode, { invoice_id: t.invoiceIds[0]! })).toHaveLength(1);
  });
});

describe('stale-suspected lane, no witness available', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({
      mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
      worker: true,
    });
  });
  afterEach(async () => assertInvariants(stack));
  afterAll(async () => stack?.stop());

  it('lane health alone blocks trusting "not found" even after the time window', async () => {
    const t = await tenantWithInvoices(stack, { credits: 10_000, invoices: 1 });
    const admin = stack.mockErp!.admin;
    await reportStaleEvidence(stack.db, 'sap-main', { kind: 'test' }, 600_000);
    await admin.addFault({ mode: 'drop_before_commit', count: 1, match: POST_PAYMENTS }); // truly NOT committed

    const p = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
    const unknown = await waitForState(stack, p.body.id, 'UNKNOWN');
    await sleep(Math.max(0, new Date(unknown.trust_not_found_after!).getTime() - Date.now()) + T(5000));
    expect((await getAction(stack, unknown.id))?.state).toBe('UNKNOWN'); // waits, holds kept
    expect((await ledgerOf(stack, unknown.id)).map((l) => l.kind)).toEqual(['HOLD']);

    await clearLaneHealth(stack.db, 'sap-main');
    expect((await opsClient(stack).reconcile(true)).status).toBe(200); // operator: `pnpm reconcile`
    const done = await waitForState(stack, unknown.id, 'SUCCEEDED', 30_000);
    expect(done.confirmed_via).toBe('response'); // re-dispatched after a trusted not-found
    expect(await admin.primaryPayments(t.companyCode, { invoice_id: t.invoiceIds[0]! })).toHaveLength(1);
  });
});
