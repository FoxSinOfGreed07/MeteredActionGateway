import { sql, type UpdateObject } from 'kysely';
import { json } from '../../db/kysely.js';
import type { ActionRow, ActionState, Database } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { createLogger } from '../../shared/logger.js';

/**
 * The action state machine (plans/00-architecture.md §6, A16). EVERY state change goes through
 * `transition()`: a compare-and-set on the current state (and optionally the lease owner — fencing) under a
 * row lock, plus an `action_events` row in the same transaction. The `guard_action_row` trigger enforces the
 * same transition table in the database, so a code path that bypasses this module still can't go illegal.
 */

export const ACTION_STATES: readonly ActionState[] = [
  'QUEUED',
  'DISPATCHING',
  'UNKNOWN',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
];
export const FINAL_STATES: ReadonlySet<ActionState> = new Set(['SUCCEEDED', 'FAILED', 'REJECTED']);
export const NON_FINAL_STATES: readonly ActionState[] = ['QUEUED', 'DISPATCHING', 'UNKNOWN'];

/** Same pairs as the DB trigger. */
export const ALLOWED: Readonly<Record<ActionState, readonly ActionState[]>> = {
  QUEUED: ['DISPATCHING', 'FAILED'],
  DISPATCHING: ['SUCCEEDED', 'FAILED', 'QUEUED', 'UNKNOWN'],
  UNKNOWN: ['SUCCEEDED', 'QUEUED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  REJECTED: [],
};

export type ActionPatch = Omit<UpdateObject<Database, 'actions'>, 'state'>;

export interface TransitionArgs {
  actionId: string;
  from: readonly ActionState[];
  to: ActionState;
  patch?: ActionPatch;
  /** Fencing: also require `lease_owner = leaseOwner`. */
  leaseOwner?: string;
  reason: string;
  details?: unknown;
}

const log = createLogger('state-machine');

/** Returns the updated row, or `null` when the CAS is lost (state/owner changed): the caller must not settle. */
export async function transition(tx: Tx, a: TransitionArgs): Promise<ActionRow | null> {
  const cur = await tx
    .selectFrom('actions')
    .select(['state', 'lease_owner', 'tenant_id', 'lane_id'])
    .where('id', '=', a.actionId)
    .forUpdate()
    .executeTakeFirst();
  if (!cur || !a.from.includes(cur.state)) return null;
  if (a.leaseOwner !== undefined && cur.lease_owner !== a.leaseOwner) return null;
  if (!ALLOWED[cur.state].includes(a.to)) {
    throw new Error(`illegal transition ${cur.state} -> ${a.to} (action ${a.actionId})`);
  }
  const final = FINAL_STATES.has(a.to);
  const row = await tx
    .updateTable('actions')
    .set({
      ...a.patch,
      state: a.to,
      updated_at: sql`now()`,
      ...(final ? { completed_at: sql`now()`, lease_owner: null, lease_until: null } : {}),
    })
    .where('id', '=', a.actionId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await tx
    .insertInto('action_events')
    .values({
      action_id: a.actionId,
      from_state: cur.state,
      to_state: a.to,
      reason: a.reason,
      details: a.details === undefined ? null : json(a.details),
    })
    .execute();
  log.info(
    {
      action_id: a.actionId,
      tenant_id: cur.tenant_id,
      lane_id: cur.lane_id,
      from: cur.state,
      to: a.to,
      reason: a.reason,
    },
    'action.transition',
  );
  return row;
}

/** The `∅ → QUEUED` / `∅ → REJECTED` event for a freshly inserted action. */
export async function recordInsertEvent(
  tx: Tx,
  row: Pick<ActionRow, 'id' | 'state'>,
  reason: string,
  details?: unknown,
): Promise<void> {
  await tx
    .insertInto('action_events')
    .values({
      action_id: row.id,
      from_state: null,
      to_state: row.state,
      reason,
      details: details === undefined ? null : json(details),
    })
    .execute();
}
