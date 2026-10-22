import { sql } from 'kysely';
import type { DbOrTx } from '../../db/tx.js';

export interface WalletDrift {
  tenant_id: string;
  projection: { available: number; held: number };
  ledger: { available: number; held: number };
}

/** I2: the projection must equal the replayed ledger for every tenant. Returns mismatches only. */
export async function verifyWallets(db: DbOrTx): Promise<WalletDrift[]> {
  const r = await sql<{
    tenant_id: string;
    available: number;
    held: number;
    l_available: number;
    l_held: number;
  }>`
    SELECT w.tenant_id, w.available, w.held,
           COALESCE(SUM(l.available_delta), 0) AS l_available, COALESCE(SUM(l.held_delta), 0) AS l_held
      FROM wallets w LEFT JOIN ledger_entries l USING (tenant_id)
     GROUP BY w.tenant_id, w.available, w.held
    HAVING w.available <> COALESCE(SUM(l.available_delta), 0) OR w.held <> COALESCE(SUM(l.held_delta), 0)`.execute(
    db,
  );
  return r.rows.map((x) => ({
    tenant_id: x.tenant_id,
    projection: { available: Number(x.available), held: Number(x.held) },
    ledger: { available: Number(x.l_available), held: Number(x.l_held) },
  }));
}

export interface SettlementViolation {
  action_id: string;
  state: string;
  hold_amount: number;
  hold: number;
  capture: number;
  release: number;
}

/** I4: every action's ledger entries must match its state (HOLD → CAPTURE | RELEASE exactly once). */
export async function verifySettlements(db: DbOrTx): Promise<SettlementViolation[]> {
  const r = await sql<SettlementViolation>`
    WITH per_action AS (
      SELECT a.id AS action_id, a.state::text AS state, a.hold_amount,
             COALESCE(SUM(l.amount) FILTER (WHERE l.kind = 'HOLD'), 0)    AS hold,
             COALESCE(SUM(l.amount) FILTER (WHERE l.kind = 'CAPTURE'), 0) AS capture,
             COALESCE(SUM(l.amount) FILTER (WHERE l.kind = 'RELEASE'), 0) AS release
        FROM actions a LEFT JOIN ledger_entries l ON l.action_id = a.id
       GROUP BY a.id)
    SELECT * FROM per_action WHERE NOT (
         (state = 'REJECTED' AND hold = 0 AND capture = 0 AND release = 0)
      OR (state IN ('QUEUED','DISPATCHING','UNKNOWN') AND hold = hold_amount AND capture = 0 AND release = 0)
      OR (state = 'SUCCEEDED' AND hold = hold_amount AND capture > 0 AND capture + release = hold)
      OR (state = 'FAILED' AND hold = hold_amount AND capture = 0 AND release = hold))`.execute(db);
  return r.rows.map((x) => ({
    ...x,
    hold_amount: Number(x.hold_amount),
    hold: Number(x.hold),
    capture: Number(x.capture),
    release: Number(x.release),
  }));
}

/** "The ledger wins": rebuild a tenant's projection from the ledger (ops tool; never needed in normal operation). */
export async function rebuildWalletProjection(db: DbOrTx, tenantId: string): Promise<void> {
  await sql`
    UPDATE wallets w SET
      available = COALESCE((SELECT SUM(available_delta) FROM ledger_entries WHERE tenant_id = ${tenantId}), 0),
      held      = COALESCE((SELECT SUM(held_delta)      FROM ledger_entries WHERE tenant_id = ${tenantId}), 0),
      updated_at = now()
    WHERE w.tenant_id = ${tenantId}`.execute(db);
}
