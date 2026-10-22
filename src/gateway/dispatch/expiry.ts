import { sql } from 'kysely';
import type { GatewayContext } from '../context.js';
import { markFailed } from './settle.js';

/**
 * A12: QUEUED actions never sent for `queuedMaxAgeMs` → FAILED + RELEASE. Safe because QUEUED means "never
 * sent" (or "confirmed not found, then requeued"). Holds on DISPATCHING/UNKNOWN never auto-expire.
 */
export async function expireQueued(ctx: GatewayContext): Promise<number> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM actions
     WHERE state = 'QUEUED' AND created_at < now() - make_interval(secs => ${ctx.config.expiry.queuedMaxAgeMs / 1000}::double precision)
     LIMIT 500`.execute(ctx.db);
  let n = 0;
  for (const { id } of rows.rows) {
    const row = await markFailed(
      ctx,
      { id },
      {
        code: 'expired_unsent',
        message: 'never sent within the queue age limit',
        reason: 'expired_unsent',
        from: ['QUEUED'],
      },
    );
    if (row) n += 1;
  }
  return n;
}
