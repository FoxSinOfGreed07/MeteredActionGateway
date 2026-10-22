import { sql } from 'kysely';
import type { GatewayContext } from '../context.js';
import { cooldownState } from '../dispatch/cooldown.js';
import { loadLanes } from '../dispatch/lanes.js';

/** QueueReport (plans/00-architecture.md §8): "queue depth visible" for Scenario 5. */
export async function queueReport(ctx: GatewayContext) {
  const [lanes, byTenant, ready, health, alerts] = await Promise.all([
    loadLanes(ctx.db),
    sql<{ lane_id: string; tenant_id: string; state: string; n: number }>`
      SELECT lane_id, tenant_id, state::text AS state, count(*)::int AS n FROM actions
       WHERE state IN ('QUEUED','DISPATCHING','UNKNOWN') GROUP BY 1, 2, 3`.execute(ctx.db),
    sql<{ lane_id: string; ready: number; oldest_ms: number | null }>`
      SELECT lane_id, count(*) FILTER (WHERE next_attempt_at <= now())::int AS ready,
             (EXTRACT(EPOCH FROM now() - min(created_at)) * 1000)::bigint AS oldest_ms
        FROM actions WHERE state = 'QUEUED' GROUP BY lane_id`.execute(ctx.db),
    ctx.db.selectFrom('lane_health').select(['lane_id', 'stale_suspected_until']).execute(),
    sql<{ action_id: string; tenant_id: string; age_ms: number }>`
      SELECT id AS action_id, tenant_id, (EXTRACT(EPOCH FROM now() - unknown_since) * 1000)::bigint AS age_ms
        FROM actions
       WHERE state = 'UNKNOWN'
         AND unknown_since < now() - make_interval(secs => ${ctx.config.reconciler.unknownAlertAfterMs / 1000}::double precision)
       ORDER BY unknown_since LIMIT 100`.execute(ctx.db),
  ]);

  const out = [];
  for (const lane of lanes) {
    const rows = byTenant.rows.filter((r) => r.lane_id === lane.id);
    const depth: Record<string, number> = { QUEUED: 0, DISPATCHING: 0, UNKNOWN: 0 };
    const tenants = new Map<string, Record<string, number>>();
    for (const r of rows) {
      depth[r.state] = (depth[r.state] ?? 0) + r.n;
      const t = tenants.get(r.tenant_id) ?? { QUEUED: 0, DISPATCHING: 0, UNKNOWN: 0 };
      t[r.state] = (t[r.state] ?? 0) + r.n;
      tenants.set(r.tenant_id, t);
    }
    const r = ready.rows.find((x) => x.lane_id === lane.id);
    const cd = await cooldownState(ctx, lane.id).catch(() => null);
    const h = health.find((x) => x.lane_id === lane.id);
    out.push({
      lane_id: lane.id,
      depth,
      ready: r?.ready ?? 0,
      oldest_queued_age_ms: r?.oldest_ms == null ? null : Number(r.oldest_ms),
      by_tenant: [...tenants.entries()].map(([tenant_id, s]) => ({ tenant_id, ...s })),
      cooldown: cd
        ? {
            active: cd.active,
            remaining_ms: cd.remainingMs,
            consecutive_429: cd.consecutive429,
            probe_mode: cd.probeMode,
          }
        : null,
      stale_suspected_until:
        h?.stale_suspected_until && new Date(h.stale_suspected_until) > new Date()
          ? new Date(h.stale_suspected_until).toISOString()
          : null,
    });
  }
  return {
    generated_at: new Date().toISOString(),
    lanes: out,
    unknown_alerts: alerts.rows.map((a) => ({ ...a, age_ms: Number(a.age_ms) })),
  };
}
