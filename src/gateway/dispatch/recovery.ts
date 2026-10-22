import { sql } from 'kysely';
import type { GatewayContext } from '../context.js';

/**
 * Constraint 4: crash recovery. Runs at worker start and every `recovery.intervalMs`.
 * ERP lanes: an expired DISPATCHING lease means a call MAY have gone out → UNKNOWN (never resend blindly).
 *   unknown_since = lease_until is conservative: a send could have started any time up to lease_until, so
 *   "not found" is trusted only after lease_until + request_timeout + max_read_lag (D2 rule a).
 * LLM lane: no external side effect → back to QUEUED.
 */
export async function recoverExpiredLeases(
  ctx: GatewayContext,
): Promise<{ unknown: string[]; requeued: string[] }> {
  const erp = await sql<{ id: string }>`
    WITH expired AS (
      UPDATE actions a
         SET state = 'UNKNOWN',
             unknown_since = a.lease_until,
             trust_not_found_after = a.lease_until + (l.request_timeout_ms + l.max_read_lag_ms) * interval '1 millisecond',
             next_reconcile_at = now(),
             ambiguous_count = a.ambiguous_count + 1,
             not_found_count = 0,
             lease_owner = NULL, lease_until = NULL, updated_at = now()
        FROM lanes l
       WHERE a.lane_id = l.id AND l.kind = 'erp' AND a.state = 'DISPATCHING' AND a.lease_until < now()
      RETURNING a.id
    ), ev AS (
      INSERT INTO action_events (action_id, from_state, to_state, reason)
      SELECT id, 'DISPATCHING', 'UNKNOWN', 'lease_expired' FROM expired
    )
    SELECT id FROM expired`.execute(ctx.db);

  const llm = await sql<{ id: string }>`
    WITH expired AS (
      UPDATE actions a
         SET state = 'QUEUED', next_attempt_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now()
        FROM lanes l
       WHERE a.lane_id = l.id AND l.kind = 'llm' AND a.state = 'DISPATCHING' AND a.lease_until < now()
      RETURNING a.id
    ), ev AS (
      INSERT INTO action_events (action_id, from_state, to_state, reason)
      SELECT id, 'DISPATCHING', 'QUEUED', 'lease_expired_requeue' FROM expired
    )
    SELECT id FROM expired`.execute(ctx.db);

  const result = { unknown: erp.rows.map((r) => r.id), requeued: llm.rows.map((r) => r.id) };
  if (result.unknown.length || result.requeued.length) ctx.log.warn(result, 'recovery.expired_leases');
  return result;
}
