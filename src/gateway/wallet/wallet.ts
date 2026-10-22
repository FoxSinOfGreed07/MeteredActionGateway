import type { DbOrTx } from '../../db/tx.js';

export interface Balance {
  available: number;
  held: number;
}

/** The projection (O(1) — what admission checks against). */
export async function getWallet(db: DbOrTx, tenantId: string): Promise<Balance> {
  const w = await db
    .selectFrom('wallets')
    .select(['available', 'held'])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return { available: w?.available ?? 0, held: w?.held ?? 0 };
}

/** The truth: replaying the append-only ledger. */
export async function deriveWallet(db: DbOrTx, tenantId: string): Promise<Balance> {
  const r = await db
    .selectFrom('ledger_entries')
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>('available_delta'), eb.lit(0)).as('available'),
      eb.fn.coalesce(eb.fn.sum<number>('held_delta'), eb.lit(0)).as('held'),
    ])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirstOrThrow();
  return { available: Number(r.available), held: Number(r.held) };
}

export async function walletView(db: DbOrTx, tenantId: string) {
  const [projection, derived] = await Promise.all([getWallet(db, tenantId), deriveWallet(db, tenantId)]);
  return {
    tenant_id: tenantId,
    available: projection.available,
    held: projection.held,
    derived,
    consistent: projection.available === derived.available && projection.held === derived.held,
  };
}

export async function listLedger(db: DbOrTx, tenantId: string, limit = 100) {
  return db
    .selectFrom('ledger_entries')
    .select(['id', 'kind', 'amount', 'available_delta', 'held_delta', 'action_id', 'reason', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .orderBy('id', 'desc')
    .limit(Math.min(Math.max(1, limit), 1000))
    .execute();
}
