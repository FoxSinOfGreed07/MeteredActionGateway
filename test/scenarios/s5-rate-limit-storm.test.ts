/**
 * Scenario 5 — Ops
 * Situation: SAP returns 429 for 90 s during a burst of 5,000 actions.
 * Expected:  the rate limiter backs off; queue depth is visible; no action is lost; fairness across
 *            tenants is preserved.
 * Doc numbers: 90 s / 5,000 actions · the 90 s is scaled by SCENARIO_TIME_SCALE (default 0.1 → 9 s).
 * Admission time does NOT scale (one tenant's submits serialize on its wallet row, D7: ~300/s here), so the
 * outage lasts until max(start + T(90 s), end of burst + T(10 s)): the whole burst always lands inside the
 * outage. In realtime mode that is exactly the doc's 90 s.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { opsClient } from '../kit/clients.js';
import { assertInvariants } from '../kit/invariants.js';
import { mapLimit, newKey, payPayload, type ScenarioTenant, tenantWithInvoices } from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';
import { T } from '../kit/time.js';
import { sleep, waitFor } from '../kit/wait.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 2000, rate_limit_burst: 2000 } },
    lanes: [
      { id: 'sap-main', kind: 'erp', rate_per_sec: 200, burst: 50, max_in_flight: 32 },
      { id: 'llm', kind: 'llm' },
    ],
    worker: true,
  });
});
afterEach(async () => assertInvariants(stack));
afterAll(async () => stack?.stop());

it('S5: 429 for 90 s during 5,000 actions → backs off, depth visible, nothing lost, fair', async () => {
  const admin = stack.mockErp!.admin;
  const A = await tenantWithInvoices(stack, { credits: 4000 * 300, invoices: 4000, id: 'tenant_a' });
  const B = await tenantWithInvoices(stack, { credits: 500 * 300, invoices: 500, id: 'tenant_b' });
  const C = await tenantWithInvoices(stack, { credits: 500 * 300, invoices: 500, id: 'tenant_c' });

  await admin.resetStats();
  const outageStart = Date.now();
  const { id: faultId } = await admin.addFault({
    mode: 'status_429',
    retry_after_s: 0, // no hint from SAP: our own backoff must kick in
    match: { method: 'POST', path: '/companies/*/payments' },
  });

  // Worst case for FIFO: all of A first, then B, then C.
  const jobs = [A, B, C].flatMap((t: ScenarioTenant) => t.invoiceIds.map((inv) => ({ t, inv })));
  const statuses = await mapLimit(
    jobs,
    50,
    async ({ t, inv }) =>
      (await t.api.submit('pay_invoice', payPayload(inv, t.amountMinor), newKey())).status,
  );
  expect(statuses.every((s) => s === 202)).toBe(true);
  const burstEnd = Date.now();

  // Queue depth is visible while SAP is still answering 429.
  const report = (await opsClient(stack).queue()).body;
  const lane = report.lanes.find((l: { lane_id: string }) => l.lane_id === 'sap-main');
  expect(lane.depth.QUEUED + lane.depth.DISPATCHING).toBeGreaterThanOrEqual(4800);
  expect(lane.cooldown.active || lane.cooldown.probe_mode).toBe(true);
  expect(lane.by_tenant.map((t: { tenant_id: string }) => t.tenant_id).sort()).toEqual([
    'tenant_a',
    'tenant_b',
    'tenant_c',
  ]);

  // End the outage.
  const outageEnd = Math.max(outageStart + T(90_000), burstEnd + T(10_000));
  await sleep(outageEnd - Date.now());
  await admin.removeFault(faultId);
  const OUTAGE = outageEnd - outageStart;

  // No action lost: all 5,000 succeed exactly once.
  await waitFor(
    async () => {
      const r = await stack.db
        .selectFrom('actions')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('state', '=', 'SUCCEEDED')
        .executeTakeFirstOrThrow();
      return Number(r.n) === 5000;
    },
    { timeoutMs: 120_000, intervalMs: 500, message: 'all 5,000 SUCCEEDED' },
  );
  const stats = await admin.stats();
  expect(stats.payments_created).toBe(5000);
  for (const t of [A, B, C]) {
    const payments = await admin.primaryPayments(t.companyCode);
    expect(payments).toHaveLength(t.invoiceIds.length);
    expect(new Set(payments.map((p) => p.invoice_id)).size).toBe(t.invoiceIds.length); // no invoice paid twice
  }
  const kinds = await stack.db
    .selectFrom('ledger_entries')
    .select(['kind', (eb) => eb.fn.countAll<number>().as('n')])
    .where('action_id', 'is not', null)
    .groupBy('kind')
    .execute();
  expect(Object.fromEntries(kinds.map((k) => [k.kind, Number(k.n)]))).toEqual({ HOLD: 5000, CAPTURE: 5000 });

  // Backs off: a client that kept hammering would have collected thousands of 429s. Bound: one burst of
  // in-flight requests + one probe per cooldown window (base T(1s) doubling to T(30s)).
  expect(stats.rate_limited_429).toBeLessThanOrEqual(32 + Math.ceil(OUTAGE / T(1000)) + 10);
  expect(stats.rate_limited_429).toBeLessThanOrEqual(150);

  // Fairness: round-robin over 3 tenants finishes B and C after ~1,500 completions; FIFO would put them
  // after 4,000.
  const order = await stack.db
    .selectFrom('actions')
    .select('tenant_id')
    .where('state', '=', 'SUCCEEDED')
    .orderBy('completed_at')
    .execute();
  const lastRank = (tenant: string) => order.map((r) => r.tenant_id).lastIndexOf(tenant) + 1;
  expect(lastRank('tenant_b')).toBeLessThanOrEqual(1800);
  expect(lastRank('tenant_c')).toBeLessThanOrEqual(1800);
});
