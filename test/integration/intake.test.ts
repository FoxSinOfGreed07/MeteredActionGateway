import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transition } from '../../src/gateway/actions/state-machine.js';
import { settleFailure } from '../../src/gateway/wallet/ledger.js';
import { verifySettlements, verifyWallets } from '../../src/gateway/wallet/verify.js';
import { tenantClient } from '../kit/clients.js';
import { createTenant } from '../kit/fixtures.js';
import { type Stack, startStack } from '../kit/stack.js';
import { sleep } from '../kit/wait.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack(); // no worker: actions stay QUEUED
});
afterAll(async () => {
  expect(await verifySettlements(stack.db)).toEqual([]);
  expect(await verifyWallets(stack.db)).toEqual([]);
  await stack?.stop();
});

const pay = (invoice: string, amount = 100_000) => ({
  invoice_id: invoice,
  amount_minor: amount,
  currency: 'INR',
});
let n = 0;
const key = () => `key-${Date.now()}-${++n}`;

async function newClient(credits = 10_000, maxPending?: number) {
  const t = await createTenant(stack.db, { credits, ...(maxPending === undefined ? {} : { maxPending }) });
  return { t, api: tenantClient(stack, t.apiKey) };
}

describe('intake: the admission transaction', () => {
  it('happy path: 202 QUEUED, HOLD 300, wallet moved, one "submitted" event', async () => {
    const { t, api } = await newClient(1000);
    const res = await api.submit('pay_invoice', pay('INV-1'), key());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      state: 'QUEUED',
      tenant_id: t.id,
      pricing: { hold: 300, captured: null },
    });
    const detail = await api.getAction(res.body.id);
    expect(detail.body.events).toEqual([
      expect.objectContaining({ from: null, to: 'QUEUED', reason: 'submitted' }),
    ]);
    expect(detail.body.ledger).toEqual([expect.objectContaining({ kind: 'HOLD', amount: 300 })]);
    expect((await api.wallet()).body).toMatchObject({ available: 700, held: 300, consistent: true });
  });

  it('S1 (submit layer): same key concurrently → identical bodies, one action, one HOLD', async () => {
    const { t, api } = await newClient();
    const k = key();
    const [a, b] = await Promise.all([
      api.submit('pay_invoice', pay('INV-S1'), k),
      api.submit('pay_invoice', pay('INV-S1'), k),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body).toEqual(b.body);
    const replayed = [a, b].filter((r) => r.headers.get('idempotent-replayed') === 'true');
    expect(replayed).toHaveLength(1);
    const rows = await stack.db.selectFrom('actions').select('id').where('tenant_id', '=', t.id).execute();
    expect(rows).toHaveLength(1);
    const holds = await stack.db
      .selectFrom('ledger_entries')
      .select('id')
      .where('tenant_id', '=', t.id)
      .where('kind', '=', 'HOLD')
      .execute();
    expect(holds).toHaveLength(1);
  });

  it('S1 (submit layer): same key 200ms apart → identical body + Idempotent-Replayed', async () => {
    const { api } = await newClient();
    const k = key();
    const a = await api.submit('pay_invoice', pay('INV-S1b'), k, { viaHttp: true });
    await sleep(200);
    const b = await api.submit('pay_invoice', pay('INV-S1b'), k, { viaHttp: true });
    expect(b.status).toBe(202);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(b.body).toEqual(a.body);
  });

  it('same key, different payload → 422 idempotency_key_reused; nothing new stored', async () => {
    const { t, api } = await newClient();
    const k = key();
    const a = await api.submit('pay_invoice', pay('INV-A'), k);
    const b = await api.submit('pay_invoice', pay('INV-B'), k);
    expect(b.status).toBe(422);
    expect(b.body.error).toMatchObject({ code: 'idempotency_key_reused', details: { action_id: a.body.id } });
    const rows = await stack.db.selectFrom('actions').select('id').where('tenant_id', '=', t.id).execute();
    expect(rows).toHaveLength(1);
  });

  it('S4 (API level): 500 credits, two parallel 300 submits → one 202, one 402; the 402 replays identically', async () => {
    const { api } = await newClient(500);
    const k1 = key();
    const k2 = key();
    const res = await Promise.all([
      api.submit('pay_invoice', pay('INV-W1'), k1),
      api.submit('pay_invoice', pay('INV-W2'), k2),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([202, 402]);
    const rejected = res.find((r) => r.status === 402)!;
    expect(rejected.body.error).toMatchObject({
      code: 'insufficient_credits',
      details: { required: 300, available: 200 },
    });
    expect(rejected.body.action.state).toBe('REJECTED');
    const rejectedKey = res[0]!.status === 402 ? k1 : k2;
    const replay = await api.submit(
      'pay_invoice',
      pay(res[0]!.status === 402 ? 'INV-W1' : 'INV-W2'),
      rejectedKey,
    );
    expect(replay.status).toBe(402);
    expect(replay.body).toEqual(rejected.body);
    expect((await api.wallet()).body).toMatchObject({ available: 200, held: 300 });
  });

  it('S3 (submit layer): two keys, same invoice, concurrently → one 202, one 409 naming the winner', async () => {
    const { api } = await newClient();
    const res = await Promise.all([
      api.submit('pay_invoice', pay('INV-S3'), key()),
      api.submit('pay_invoice', pay('INV-S3'), key()),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([202, 409]);
    const winner = res.find((r) => r.status === 202)!;
    const loser = res.find((r) => r.status === 409)!;
    expect(loser.body.error.code).toBe('conflict_active_action');
    expect(loser.body.error.details).toMatchObject({
      conflict_key: 'invoice:INV-S3',
      active_action: { id: winner.body.id, state: 'QUEUED' },
    });
    expect(loser.body.action.state).toBe('REJECTED');
    const ledger = await stack.db
      .selectFrom('ledger_entries')
      .select('id')
      .where('action_id', '=', loser.body.action.id)
      .execute();
    expect(ledger).toHaveLength(0);
  });

  it('the conflict clears once the active action is final', async () => {
    const { api } = await newClient();
    const first = await api.submit('pay_invoice', pay('INV-C'), key());
    expect((await api.submit('pay_invoice', pay('INV-C'), key())).status).toBe(409);
    await stack.db.transaction().execute(async (tx) => {
      const row = await transition(tx, {
        actionId: first.body.id,
        from: ['QUEUED'],
        to: 'FAILED',
        reason: 'test',
        patch: { failure_code: 'test' },
      });
      await settleFailure(tx, row!, 'test', 'cleared');
    });
    expect((await api.submit('pay_invoice', pay('INV-C'), key())).status).toBe(202);
  });

  it('backpressure: max_pending 2 → third submit 429 with Retry-After; not stored', async () => {
    const { t, api } = await newClient(10_000, 2);
    expect((await api.submit('pay_invoice', pay('INV-BP1'), key())).status).toBe(202);
    expect((await api.submit('pay_invoice', pay('INV-BP2'), key())).status).toBe(202);
    const third = await api.submit('pay_invoice', pay('INV-BP3'), key());
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('tenant_backpressure');
    expect(third.headers.get('retry-after')).toBe(String(stack.ctx.config.backpressure.retryAfterS));
    const rows = await stack.db.selectFrom('actions').select('id').where('tenant_id', '=', t.id).execute();
    expect(rows).toHaveLength(2);
  });

  it('validation: unknown type, extra payload field, missing header → 400', async () => {
    const { api } = await newClient();
    expect((await api.submit('teleport', {}, key())).body.error.code).toBe('unknown_action_type');
    const extra = await api.submit('pay_invoice', { ...pay('INV-X'), extra: 1 }, key());
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe('invalid_request');
    const noKey = await api.raw('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action_type: 'pay_invoice', payload: pay('INV-Y') }),
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('missing_idempotency_key');
  });

  it('auth and isolation: no key → 401; tenant B cannot read tenant A’s action', async () => {
    const { api: a } = await newClient();
    const { api: b } = await newClient();
    const res = await a.submit('pay_invoice', pay('INV-ISO'), key());
    expect((await b.getAction(res.body.id)).status).toBe(404);
    const anon = await stack.api.request(`/v1/actions/${res.body.id}`);
    expect(anon.status).toBe(401);
  });

  it('ops grant adds credits through the ledger', async () => {
    const { t, api } = await newClient(0);
    const res = await stack.api.request(`/v1/ops/tenants/${t.id}/grant`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stack.ctx.config.ops.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 250, reason: 'top-up' }),
    });
    expect(res.status).toBe(200);
    expect((await api.wallet()).body).toMatchObject({ available: 250, held: 0, consistent: true });
  });
});
