import type { ActionRow, ActionState } from '../../db/schema.js';
import type { DbOrTx } from '../../db/tx.js';
import { NON_FINAL_STATES } from './state-machine.js';

export function getAction(db: DbOrTx, id: string): Promise<ActionRow | undefined> {
  return db.selectFrom('actions').selectAll().where('id', '=', id).executeTakeFirst();
}

export function getActionForTenant(db: DbOrTx, tenantId: string, id: string): Promise<ActionRow | undefined> {
  return db
    .selectFrom('actions')
    .selectAll()
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
}

export function findByIdempotencyKey(
  db: DbOrTx,
  tenantId: string,
  key: string,
): Promise<ActionRow | undefined> {
  return db
    .selectFrom('actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
}

export function listActions(
  db: DbOrTx,
  tenantId: string,
  opts: { state?: ActionState; limit?: number } = {},
) {
  let q = db.selectFrom('actions').selectAll().where('tenant_id', '=', tenantId);
  if (opts.state) q = q.where('state', '=', opts.state);
  return q
    .orderBy('created_at', 'desc')
    .limit(Math.min(Math.max(1, opts.limit ?? 50), 200))
    .execute();
}

export function getEvents(db: DbOrTx, actionId: string) {
  return db.selectFrom('action_events').selectAll().where('action_id', '=', actionId).orderBy('id').execute();
}

export function getActionLedger(db: DbOrTx, actionId: string) {
  return db
    .selectFrom('ledger_entries')
    .select(['kind', 'amount', 'reason', 'created_at'])
    .where('action_id', '=', actionId)
    .orderBy('id')
    .execute();
}

/** A7: pending = QUEUED + DISPATCHING + UNKNOWN (partial index actions_pending_idx). */
export async function countPending(db: DbOrTx, tenantId: string): Promise<number> {
  const r = await db
    .selectFrom('actions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('state', 'in', NON_FINAL_STATES)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

export function findActiveByConflictKey(db: DbOrTx, tenantId: string, conflictKey: string) {
  return db
    .selectFrom('actions')
    .select(['id', 'state', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('conflict_key', '=', conflictKey)
    .where('state', 'in', NON_FINAL_STATES)
    .executeTakeFirst();
}
