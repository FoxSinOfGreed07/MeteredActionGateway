import { sql } from 'kysely';
import type { ActionRow, LaneRow } from '../../db/schema.js';
import { transition } from '../actions/state-machine.js';
import type { GatewayContext } from '../context.js';

/**
 * D8 + A5 — the Postgres queue's fair claim. One transaction:
 *   1. the least-recently-dispatched tenant with ready work on this lane (round-robin; lock-free query —
 *      DISTINCT can't be combined with FOR UPDATE SKIP LOCKED),
 *   2. that tenant's oldest ready action, skipping rows other workers hold (FOR UPDATE SKIP LOCKED),
 *   3. QUEUED → DISPATCHING with a lease (via transition(): event row + trigger),
 *   4. advance the fairness cursor.
 * The COMMITTED DISPATCHING row is the durable "about to call the ERP" record (Constraint 4). The HTTP
 * call happens only after this returns.
 */
export async function claimNext(
  ctx: GatewayContext,
  lane: Pick<LaneRow, 'id' | 'lease_ms'>,
  owner: string,
): Promise<ActionRow | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await ctx.db.transaction().execute(async (tx) => {
      const t = await sql<{ tenant_id: string }>`
        SELECT t.tenant_id
          FROM (SELECT DISTINCT tenant_id FROM actions
                 WHERE lane_id = ${lane.id} AND state = 'QUEUED' AND next_attempt_at <= now()) t
          LEFT JOIN lane_tenant_cursor c ON c.lane_id = ${lane.id} AND c.tenant_id = t.tenant_id
         ORDER BY c.last_dispatched_at ASC NULLS FIRST, t.tenant_id
         LIMIT 1`.execute(tx);
      const tenantId = t.rows[0]?.tenant_id;
      if (!tenantId) return 'empty' as const;

      const picked = await sql<{ id: string }>`
        SELECT id FROM actions
         WHERE lane_id = ${lane.id} AND tenant_id = ${tenantId} AND state = 'QUEUED' AND next_attempt_at <= now()
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`.execute(tx);
      const id = picked.rows[0]?.id;
      if (!id) return 'raced' as const;

      const row = await transition(tx, {
        actionId: id,
        from: ['QUEUED'],
        to: 'DISPATCHING',
        reason: 'claimed',
        patch: {
          lease_owner: owner,
          lease_until: sql`now() + make_interval(secs => ${lane.lease_ms / 1000}::double precision)`,
          dispatched_at: sql`now()`,
          dispatch_count: sql`dispatch_count + 1`,
        },
      });
      await sql`
        INSERT INTO lane_tenant_cursor (lane_id, tenant_id, last_dispatched_at) VALUES (${lane.id}, ${tenantId}, now())
        ON CONFLICT (lane_id, tenant_id) DO UPDATE SET last_dispatched_at = EXCLUDED.last_dispatched_at`.execute(
        tx,
      );
      return row ?? ('raced' as const);
    });
    if (res === 'empty') return null;
    if (res === 'raced') continue;
    return res;
  }
  return null;
}
