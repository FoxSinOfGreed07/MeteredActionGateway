import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from '../../src/db/tx.js';
import { capture, placeHold, release, settleSuccess } from '../../src/gateway/wallet/ledger.js';
import { verifySettlements, verifyWallets } from '../../src/gateway/wallet/verify.js';
import { deriveWallet, getWallet } from '../../src/gateway/wallet/wallet.js';
import { createTenant, insertBareAction } from '../kit/fixtures.js';
import { type Stack, startStack } from '../kit/stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

const tx = <T>(fn: (t: Tx) => Promise<T>) => stack.db.transaction().execute(fn);

async function entries(actionId: string) {
  return stack.db
    .selectFrom('ledger_entries')
    .select(['kind', 'amount', 'reason'])
    .where('action_id', '=', actionId)
    .orderBy('id')
    .execute();
}

describe('ledger (D3/D7)', () => {
  it('grant 1000 → hold 300 → capture 300', async () => {
    const t = await createTenant(stack.db, { credits: 1000 });
    const id = await insertBareAction(stack.db, { tenantId: t.id, holdAmount: 300 });
    const hold = await tx((x) =>
      placeHold(x, { tenantId: t.id, actionId: id, amount: 300, actionType: 'pay_invoice' }),
    );
    expect(hold).toEqual({ ok: true, available: 700, held: 300 });
    await tx((x) => capture(x, { tenantId: t.id, actionId: id, amount: 300, actionType: 'pay_invoice' }));
    expect(await getWallet(stack.db, t.id)).toEqual({ available: 700, held: 0 });
    expect(await deriveWallet(stack.db, t.id)).toEqual({ available: 700, held: 0 });
  });

  it('hold → release returns the credits; the release reason carries the reason code', async () => {
    const t = await createTenant(stack.db, { credits: 1000 });
    const id = await insertBareAction(stack.db, { tenantId: t.id, holdAmount: 300 });
    await tx((x) => placeHold(x, { tenantId: t.id, actionId: id, amount: 300, actionType: 'pay_invoice' }));
    await tx((x) =>
      release(x, {
        tenantId: t.id,
        actionId: id,
        amount: 300,
        reasonCode: 'AMOUNT_MISMATCH',
        message: 'nope',
      }),
    );
    expect(await getWallet(stack.db, t.id)).toEqual({ available: 1000, held: 0 });
    const e = await entries(id);
    expect(e.map((x) => x.kind)).toEqual(['HOLD', 'RELEASE']);
    expect(e[1]!.reason).toContain('AMOUNT_MISMATCH');
  });

  it('partial settlement: hold 20 → capture 2 + release 18 (unused_hold)', async () => {
    const t = await createTenant(stack.db, { credits: 100 });
    const id = await insertBareAction(stack.db, {
      tenantId: t.id,
      holdAmount: 20,
      actionType: 'classify_invoice_line',
    });
    await tx((x) =>
      placeHold(x, { tenantId: t.id, actionId: id, amount: 20, actionType: 'classify_invoice_line' }),
    );
    await tx((x) =>
      settleSuccess(x, { id, tenant_id: t.id, hold_amount: 20, action_type: 'classify_invoice_line' }, 2),
    );
    const e = await entries(id);
    expect(e.map((x) => [x.kind, x.amount])).toEqual([
      ['HOLD', 20],
      ['CAPTURE', 2],
      ['RELEASE', 18],
    ]);
    expect(e[2]!.reason).toMatch(/^release:unused_hold/);
    expect(await getWallet(stack.db, t.id)).toEqual({ available: 98, held: 0 });
  });

  it('double capture on one action is rejected (unique index) and rolls back', async () => {
    const t = await createTenant(stack.db, { credits: 1000 });
    const id = await insertBareAction(stack.db, { tenantId: t.id, holdAmount: 300 });
    await tx((x) => placeHold(x, { tenantId: t.id, actionId: id, amount: 300, actionType: 'pay_invoice' }));
    await tx((x) => capture(x, { tenantId: t.id, actionId: id, amount: 100, actionType: 'pay_invoice' }));
    await expect(
      tx((x) => capture(x, { tenantId: t.id, actionId: id, amount: 100, actionType: 'pay_invoice' })),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await getWallet(stack.db, t.id)).toEqual({ available: 700, held: 200 });
  });

  it('ledger rows cannot be updated or deleted', async () => {
    const t = await createTenant(stack.db, { credits: 10 });
    await expect(
      stack.db.updateTable('ledger_entries').set({ amount: 99 }).where('tenant_id', '=', t.id).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      stack.db.deleteFrom('ledger_entries').where('tenant_id', '=', t.id).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('mismatched deltas violate the per-kind CHECK', async () => {
    const t = await createTenant(stack.db, { credits: 10 });
    const id = await insertBareAction(stack.db, { tenantId: t.id, holdAmount: 5 });
    await expect(
      stack.db
        .insertInto('ledger_entries')
        .values({
          tenant_id: t.id,
          action_id: id,
          kind: 'HOLD',
          amount: 5,
          available_delta: 5,
          held_delta: 5,
          reason: 'x',
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('verifyWallets detects a tampered projection', async () => {
    const t = await createTenant(stack.db, { credits: 50 });
    expect((await verifyWallets(stack.db)).find((d) => d.tenant_id === t.id)).toBeUndefined();
    await stack.db
      .updateTable('wallets')
      .set((eb) => ({ available: eb('available', '+', 1) }))
      .where('tenant_id', '=', t.id)
      .execute();
    const drift = (await verifyWallets(stack.db)).find((d) => d.tenant_id === t.id);
    expect(drift).toEqual({
      tenant_id: t.id,
      projection: { available: 51, held: 0 },
      ledger: { available: 50, held: 0 },
    });
    await stack.db
      .updateTable('wallets')
      .set((eb) => ({ available: eb('available', '-', 1) }))
      .where('tenant_id', '=', t.id)
      .execute();
  });

  it('verifySettlements flags a SUCCEEDED action with only a HOLD', async () => {
    const t = await createTenant(stack.db, { credits: 1000 });
    const id = await insertBareAction(stack.db, { tenantId: t.id, holdAmount: 300 });
    await tx((x) => placeHold(x, { tenantId: t.id, actionId: id, amount: 300, actionType: 'pay_invoice' }));
    expect((await verifySettlements(stack.db)).find((v) => v.action_id === id)).toBeUndefined();
    // Force an inconsistent state through the legal path QUEUED→DISPATCHING→SUCCEEDED without capturing.
    await stack.db.updateTable('actions').set({ state: 'DISPATCHING' }).where('id', '=', id).execute();
    await stack.db.updateTable('actions').set({ state: 'SUCCEEDED' }).where('id', '=', id).execute();
    expect((await verifySettlements(stack.db)).find((v) => v.action_id === id)).toMatchObject({
      state: 'SUCCEEDED',
      hold: 300,
      capture: 0,
    });
  });
});
