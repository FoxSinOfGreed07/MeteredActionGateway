import { sql } from 'kysely';
import type { GatewayContext } from '../context.js';
import { verifySettlements, verifyWallets } from '../wallet/verify.js';
import { type Resolution, reconcilePass } from './resolver.js';

export interface ReconcileReport {
  resolved: Extract<Resolution, { to: string }>[];
  still_unknown: Extract<Resolution, { still: string }>[];
  wallet_drift: Awaited<ReturnType<typeof verifyWallets>>;
  settlement_violations: Awaited<ReturnType<typeof verifySettlements>>;
  unknown_alerts: { action_id: string; tenant_id: string; age_ms: number }[];
  ok: boolean;
}

/**
 * The on-demand reconciliation run (deliverable: "a reconciliation run that resolves the UNKNOWN actions"):
 * one resolver pass over every UNKNOWN (force) or every due one, then the ledger invariants (I2, I4).
 */
export async function reconcileOnce(
  ctx: GatewayContext,
  opts: { force?: boolean } = {},
): Promise<ReconcileReport> {
  const results = await reconcilePass(ctx, `${ctx.config.workerId}-reconcile-once`, {
    force: opts.force === true,
    maxBatches: 50,
  });
  const [wallet_drift, settlement_violations, alerts] = await Promise.all([
    verifyWallets(ctx.db),
    verifySettlements(ctx.db),
    sql<{ action_id: string; tenant_id: string; age_ms: number }>`
      SELECT id AS action_id, tenant_id, (EXTRACT(EPOCH FROM now() - unknown_since) * 1000)::bigint AS age_ms
        FROM actions WHERE state = 'UNKNOWN'
         AND unknown_since < now() - make_interval(secs => ${ctx.config.reconciler.unknownAlertAfterMs / 1000}::double precision)`.execute(
      ctx.db,
    ),
  ]);
  const resolved = results.filter((r): r is Extract<Resolution, { to: string }> => 'to' in r);
  const still_unknown = results.filter((r): r is Extract<Resolution, { still: string }> => 'still' in r);
  return {
    resolved,
    still_unknown,
    wallet_drift,
    settlement_violations,
    unknown_alerts: alerts.rows.map((a) => ({ ...a, age_ms: Number(a.age_ms) })),
    ok: wallet_drift.length === 0 && settlement_violations.length === 0,
  };
}
