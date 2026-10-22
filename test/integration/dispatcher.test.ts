import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimNext } from '../../src/gateway/dispatch/claim.js';
import { cooldownState } from '../../src/gateway/dispatch/cooldown.js';
import { recoverExpiredLeases } from '../../src/gateway/dispatch/recovery.js';
import { markSucceeded } from '../../src/gateway/dispatch/settle.js';
import { startWorker } from '../../src/gateway/worker.js';
import { assertInvariants } from '../kit/invariants.js';
import {
  eventsOf,
  ledgerOf,
  mapLimit,
  newKey,
  payPayload,
  tenantWithInvoices,
  waitForState,
} from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';
import { sleep, waitFor } from '../kit/wait.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    lanes: [
      { id: 'sap-main', kind: 'erp', rate_per_sec: 1000, burst: 200, max_in_flight: 16 },
      { id: 'llm', kind: 'llm' },
    ],
    worker: true,
  });
});
afterAll(async () => {
  await assertInvariants(stack);
  await stack?.stop();
});

const admin = () => stack.mockErp!.admin;

describe('dispatcher (D8, A5, A6)', () => {
  it('happy path: submitted → claimed → erp_committed; HOLD + CAPTURE', async () => {
    const t = await tenantWithInvoices(stack, { credits: 1000, invoices: 1 });
    const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
    const a = await waitForState(stack, res.body.id, 'SUCCEEDED');
    expect(a.confirmed_via).toBe('response');
    expect((await eventsOf(stack, a.id)).map((e) => e.reason)).toEqual([
      'submitted',
      'claimed',
      'erp_committed',
    ]);
    expect((await ledgerOf(stack, a.id)).map((l) => [l.kind, l.amount])).toEqual([
      ['HOLD', 300],
      ['CAPTURE', 300],
    ]);
    expect(a.result).toMatchObject({ payment: { reference: a.id }, invoice: { status: 'PAID' } });
  });

  it('503 twice then OK → SUCCEEDED, retry_count 2, 3 posts, 1 payment', async () => {
    const t = await tenantWithInvoices(stack, { credits: 1000, invoices: 1 });
    await admin().resetStats();
    await admin().addFault({ mode: 'status_503', count: 2, match: { method: 'POST' } });
    const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
    const a = await waitForState(stack, res.body.id, 'SUCCEEDED');
    expect(a.retry_count).toBe(2);
    expect((await admin().stats()).payment_posts_received).toBe(3);
    expect(await admin().primaryPayments(t.companyCode, { reference: a.id })).toHaveLength(1);
  });

  it('fencing: a stale lease owner cannot settle; the late committed response settles UNKNOWN → SUCCEEDED once', async () => {
    const t = await tenantWithInvoices(stack, { credits: 1000, invoices: 1 });
    await stack.worker.stop();
    try {
      const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
      const claimed = await claimNext(stack.ctx, { id: 'sap-main', lease_ms: 60_000 }, 'w-stale');
      expect(claimed?.id).toBe(res.body.id);
      // Lease expires → recovery moves it to UNKNOWN.
      await sql`UPDATE actions SET lease_until = now() - interval '1 second' WHERE id = ${res.body.id}`.execute(
        stack.db,
      );
      await recoverExpiredLeases(stack.ctx);
      expect((await waitForState(stack, res.body.id, 'UNKNOWN')).lease_owner).toBeNull();
      // The stale worker's settle loses the CAS…
      const lost = await markSucceeded(stack.ctx, claimed!, {
        result: {},
        via: 'response',
        reason: 'erp_committed',
        leaseOwner: 'w-stale',
      });
      expect(lost).toBeNull();
      // …and the strong-evidence path settles exactly once.
      const won = await markSucceeded(stack.ctx, claimed!, {
        result: {},
        via: 'response',
        reason: 'late_response:committed',
        from: ['UNKNOWN'],
      });
      expect(won?.state).toBe('SUCCEEDED');
      expect((await ledgerOf(stack, res.body.id)).map((l) => l.kind)).toEqual(['HOLD', 'CAPTURE']);
    } finally {
      await stack.worker.start();
    }
  });

  it('two workers, 300 actions → every action SUCCEEDED, every reference paid exactly once', async () => {
    const t = await tenantWithInvoices(stack, { credits: 300 * 300, invoices: 300 });
    const second = await startWorker({
      ...stack.ctx,
      config: { ...stack.ctx.config, workerId: 'second-worker' },
    });
    try {
      const ids = await mapLimit(t.invoiceIds, 25, async (inv) => {
        const r = await t.api.submit('pay_invoice', payPayload(inv, t.amountMinor), newKey());
        expect(r.status).toBe(202);
        return r.body.id as string;
      });
      await waitFor(
        async () => {
          const r = await stack.db
            .selectFrom('actions')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('tenant_id', '=', t.id)
            .where('state', '=', 'SUCCEEDED')
            .executeTakeFirstOrThrow();
          return Number(r.n) === 300;
        },
        { timeoutMs: 30_000 },
      );
      const payments = await admin().primaryPayments(t.companyCode);
      expect(payments).toHaveLength(300);
      expect(new Set(payments.map((p) => p.reference))).toEqual(new Set(ids));
      const owners = await stack.db
        .selectFrom('action_events')
        .select('reason')
        .where('action_id', 'in', ids)
        .where('reason', '=', 'claimed')
        .execute();
      expect(owners).toHaveLength(300); // claimed exactly once each
    } finally {
      await second.stop();
    }
  });

  it('recovery: an expired DISPATCHING lease becomes UNKNOWN (lease_expired), never resent', async () => {
    const t = await tenantWithInvoices(stack, { credits: 1000, invoices: 1 });
    await stack.worker.stop();
    try {
      const res = await t.api.submit('pay_invoice', payPayload(t.invoiceIds[0]!, t.amountMinor), newKey());
      const claimed = await claimNext(stack.ctx, { id: 'sap-main', lease_ms: 50 }, 'crashed-worker');
      expect(claimed?.id).toBe(res.body.id);
      await sleep(80);
      const { unknown } = await recoverExpiredLeases(stack.ctx);
      expect(unknown).toContain(res.body.id);
      const a = await waitForState(stack, res.body.id, 'UNKNOWN');
      expect(a.unknown_since?.getTime()).toBe(claimed!.lease_until?.getTime());
      expect((await eventsOf(stack, a.id)).at(-1)).toMatchObject({
        from_state: 'DISPATCHING',
        to_state: 'UNKNOWN',
        reason: 'lease_expired',
      });
      expect(await admin().primaryPayments(t.companyCode, { reference: a.id })).toHaveLength(0);
      // Leave it UNKNOWN with its hold: step 07's reconciler resolves it. Settle it here so invariants stay clean.
      const row = await stack.db.transaction().execute(async (tx) => {
        const { transition } = await import('../../src/gateway/actions/state-machine.js');
        const { settleFailure } = await import('../../src/gateway/wallet/ledger.js');
        const r = await transition(tx, {
          actionId: a.id,
          from: ['UNKNOWN'],
          to: 'FAILED',
          reason: 'test_cleanup',
          patch: { failure_code: 'test' },
        });
        await settleFailure(tx, r!, 'test', 'cleanup');
        return r;
      });
      expect(row?.state).toBe('FAILED');
    } finally {
      await stack.worker.start();
    }
  });

  it('429 window: cooldown activates, no claims while active, then a single probe resumes traffic', async () => {
    const t = await tenantWithInvoices(stack, { credits: 20 * 300, invoices: 20 });
    await admin().resetStats();
    await admin().addFault({
      mode: 'status_429',
      duration_ms: 1000,
      retry_after_s: 0,
      match: { method: 'POST' },
    });
    const ids = await mapLimit(
      t.invoiceIds,
      10,
      async (inv) =>
        (await t.api.submit('pay_invoice', payPayload(inv, t.amountMinor), newKey())).body.id as string,
    );
    await waitFor(async () => (await cooldownState(stack.ctx, 'sap-main')).active, { timeoutMs: 5000 });
    for (const id of ids) await waitForState(stack, id, 'SUCCEEDED', 30_000);
    const stats = await admin().stats();
    expect(stats.payments_created).toBe(20);
    // Without backoff a 1s window with 16 in flight would produce hundreds of 429s.
    expect(stats.rate_limited_429).toBeLessThan(40);
    expect((await cooldownState(stack.ctx, 'sap-main')).consecutive429).toBe(0);
  });
});
