import { sql } from 'kysely';
import { json } from '../../db/kysely.js';
import type { DbOrTx } from '../../db/tx.js';

/**
 * Stale-read suspicion per lane. It protects money (it stops the reconciler trusting "not found"), so it
 * lives in Postgres, not Redis (D2). Evidence sources: a witness payment missing from a lookup (step 07) and
 * a cache fill below the high-water mark (step 08).
 */
export async function staleSuspectedUntil(db: DbOrTx, laneId: string): Promise<Date | null> {
  const row = await db
    .selectFrom('lane_health')
    .select('stale_suspected_until')
    .where('lane_id', '=', laneId)
    .executeTakeFirst();
  const until = row?.stale_suspected_until ? new Date(row.stale_suspected_until) : null;
  return until && until > new Date() ? until : null;
}

/** Throttled: skips the write if the quarantine already extends more than half a window into the future. */
export async function reportStaleEvidence(
  db: DbOrTx,
  laneId: string,
  evidence: Record<string, unknown>,
  quarantineMs: number,
): Promise<void> {
  const q = quarantineMs / 1000;
  await sql`
    INSERT INTO lane_health (lane_id, stale_suspected_until, last_evidence, updated_at)
    VALUES (${laneId}, now() + make_interval(secs => ${q}::double precision), ${json({ ...evidence, at: new Date().toISOString() })}::jsonb, now())
    ON CONFLICT (lane_id) DO UPDATE
       SET stale_suspected_until = EXCLUDED.stale_suspected_until,
           last_evidence = EXCLUDED.last_evidence,
           updated_at = now()
     WHERE lane_health.stale_suspected_until IS NULL
        OR lane_health.stale_suspected_until < now() + make_interval(secs => ${q / 2}::double precision)`.execute(
    db,
  );
}

/** Ops/test helper: end a quarantine early (in production it simply expires). */
export async function clearLaneHealth(db: DbOrTx, laneId: string): Promise<void> {
  await db
    .updateTable('lane_health')
    .set({ stale_suspected_until: null })
    .where('lane_id', '=', laneId)
    .execute();
}
