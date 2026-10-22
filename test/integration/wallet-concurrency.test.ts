import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeHold, release } from '../../src/gateway/wallet/ledger.js';
import { verifyWallets } from '../../src/gateway/wallet/verify.js';
import { getWallet } from '../../src/gateway/wallet/wallet.js';
import { createTenant, insertBareAction } from '../kit/fixtures.js';
import { type Stack, startStack } from '../kit/stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

/** Each hold runs on its OWN transaction/connection — Promise.all over one transaction would prove nothing. */
async function parallelHolds(tenantId: string, n: number, amount: number) {
  const ids = await Promise.all(
    Array.from({ length: n }, () => insertBareAction(stack.db, { tenantId, holdAmount: amount })),
  );
  return Promise.all(
    ids.map((actionId) =>
      stack.db
        .transaction()
        .execute((tx) => placeHold(tx, { tenantId, actionId, amount, actionType: 'pay_invoice' })),
    ),
  );
}

describe('wallet concurrency (D7, Scenario 4 at the domain level)', () => {
  it('500 credits, two parallel 300 holds → exactly one succeeds; never negative', async () => {
    const t = await createTenant(stack.db, { credits: 500 });
    const results = await parallelHolds(t.id, 2, 300);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, available: 200 });
    expect(await getWallet(stack.db, t.id)).toEqual({ available: 200, held: 300 });
    const holds = await stack.db
      .selectFrom('ledger_entries')
      .select('id')
      .where('tenant_id', '=', t.id)
      .where('kind', '=', 'HOLD')
      .execute();
    expect(holds).toHaveLength(1);
    expect(await verifyWallets(stack.db)).toEqual([]);
  });

  it('stress: 3,000 credits, 50 parallel holds of 300 → exactly 10 succeed, available 0', async () => {
    const t = await createTenant(stack.db, { credits: 3000 });
    const results = await parallelHolds(t.id, 50, 300);
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok)).toHaveLength(40);
    expect(await getWallet(stack.db, t.id)).toEqual({ available: 0, held: 3000 });
    expect(await verifyWallets(stack.db)).toEqual([]);
  });

  it('interleaved hold → release → hold across 10 tasks stays consistent', async () => {
    const t = await createTenant(stack.db, { credits: 600 });
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const a = await insertBareAction(stack.db, { tenantId: t.id, holdAmount: 300 });
        const h = await stack.db
          .transaction()
          .execute((tx) =>
            placeHold(tx, { tenantId: t.id, actionId: a, amount: 300, actionType: 'pay_invoice' }),
          );
        if (h.ok) {
          await stack.db
            .transaction()
            .execute((tx) =>
              release(tx, { tenantId: t.id, actionId: a, amount: 300, reasonCode: 'test', message: 'cycle' }),
            );
        }
        const b = await insertBareAction(stack.db, { tenantId: t.id, holdAmount: 300 });
        await stack.db
          .transaction()
          .execute((tx) =>
            placeHold(tx, { tenantId: t.id, actionId: b, amount: 300, actionType: 'pay_invoice' }),
          );
      }),
    );
    const w = await getWallet(stack.db, t.id);
    expect(w.available + w.held).toBe(600);
    expect(w.available).toBeGreaterThanOrEqual(0);
    expect(await verifyWallets(stack.db)).toEqual([]);
  });
});
