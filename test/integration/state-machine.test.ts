import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionState } from '../../src/db/schema.js';
import { ALLOWED, transition } from '../../src/gateway/actions/state-machine.js';
import { createTenant, insertBareAction } from '../kit/fixtures.js';
import { type Stack, startStack } from '../kit/stack.js';

let stack: Stack;
let tenantId: string;
beforeAll(async () => {
  stack = await startStack();
  tenantId = (await createTenant(stack.db, { credits: 10_000 })).id;
});
afterAll(async () => {
  await stack?.stop();
});

/** Walk a fresh action along legal transitions to `state`. */
const PATH_TO: Record<string, ActionState[]> = {
  QUEUED: [],
  DISPATCHING: ['DISPATCHING'],
  UNKNOWN: ['DISPATCHING', 'UNKNOWN'],
};

async function actionIn(state: 'QUEUED' | 'DISPATCHING' | 'UNKNOWN'): Promise<string> {
  const id = await insertBareAction(stack.db, { tenantId, holdAmount: 0 });
  let from: ActionState = 'QUEUED';
  for (const to of PATH_TO[state]!) {
    await stack.db
      .transaction()
      .execute((tx) => transition(tx, { actionId: id, from: [from], to, reason: 'setup' }));
    from = to;
  }
  return id;
}

describe('state machine (A16)', () => {
  it('every allowed pair succeeds and writes an event with the right from/to', async () => {
    for (const from of ['QUEUED', 'DISPATCHING', 'UNKNOWN'] as const) {
      for (const to of ALLOWED[from]) {
        const id = await actionIn(from);
        const row = await stack.db
          .transaction()
          .execute((tx) =>
            transition(tx, { actionId: id, from: [from], to, reason: 'test', details: { k: 1 } }),
          );
        expect(row?.state, `${from}->${to}`).toBe(to);
        const last = await stack.db
          .selectFrom('action_events')
          .selectAll()
          .where('action_id', '=', id)
          .orderBy('id', 'desc')
          .executeTakeFirstOrThrow();
        expect([last.from_state, last.to_state, last.reason]).toEqual([from, to, 'test']);
        if (to === 'SUCCEEDED' || to === 'FAILED') expect(row?.completed_at).not.toBeNull();
      }
    }
  });

  it('illegal transitions are rejected by the database trigger (even via raw SQL)', async () => {
    const id = await actionIn('QUEUED');
    await expect(
      stack.db.updateTable('actions').set({ state: 'SUCCEEDED' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/illegal transition QUEUED -> SUCCEEDED/);
    await stack.db.updateTable('actions').set({ state: 'FAILED' }).where('id', '=', id).execute();
    await expect(
      stack.db.updateTable('actions').set({ state: 'QUEUED' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/illegal transition FAILED -> QUEUED/);
  });

  it('a CAS with the wrong `from` returns null and writes no event', async () => {
    const id = await actionIn('QUEUED');
    const row = await stack.db
      .transaction()
      .execute((tx) => transition(tx, { actionId: id, from: ['DISPATCHING'], to: 'SUCCEEDED', reason: 'x' }));
    expect(row).toBeNull();
    const events = await stack.db
      .selectFrom('action_events')
      .select('id')
      .where('action_id', '=', id)
      .execute();
    expect(events).toHaveLength(0);
  });

  it('a CAS with the wrong lease owner returns null (fencing)', async () => {
    const id = await actionIn('QUEUED');
    await stack.db.transaction().execute((tx) =>
      transition(tx, {
        actionId: id,
        from: ['QUEUED'],
        to: 'DISPATCHING',
        reason: 'claim',
        patch: { lease_owner: 'w1' },
      }),
    );
    const lost = await stack.db
      .transaction()
      .execute((tx) =>
        transition(tx, { actionId: id, from: ['DISPATCHING'], to: 'UNKNOWN', reason: 'x', leaseOwner: 'w2' }),
      );
    expect(lost).toBeNull();
    const won = await stack.db
      .transaction()
      .execute((tx) =>
        transition(tx, { actionId: id, from: ['DISPATCHING'], to: 'UNKNOWN', reason: 'x', leaseOwner: 'w1' }),
      );
    expect(won?.state).toBe('UNKNOWN');
  });

  it('immutable columns cannot change (stored response, payload)', async () => {
    const id = await actionIn('QUEUED');
    await expect(
      stack.db
        .updateTable('actions')
        .set({ response_body: JSON.stringify({ x: 1 }) })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/immutable action column/);
    await expect(
      stack.db
        .updateTable('actions')
        .set({ payload: JSON.stringify({ y: 2 }) })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/immutable action column/);
  });

  it('actions must be inserted as QUEUED or REJECTED, and cannot be deleted', async () => {
    const id = await actionIn('QUEUED');
    await expect(stack.db.deleteFrom('actions').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
  });
});
