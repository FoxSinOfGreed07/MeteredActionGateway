import { z } from 'zod';
import type { LaneRow } from '../../db/schema.js';
import { runScript } from '../../redis/scripts.js';
import { GatewayError } from '../../shared/errors.js';
import { hmacSha256Hex, safeEqual } from '../../shared/hash.js';
import type { GatewayContext } from '../context.js';

export const WebhookEvent = z.object({
  event_id: z.string().min(1).max(200),
  company_code: z.string().min(1).max(64),
  object_type: z.enum(['vendor', 'invoice', 'payment']),
  object_id: z.string().min(1).max(128),
  seq: z.number().int().positive(),
  occurred_at: z.string(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/** A17: HMAC-SHA256 of the RAW body. A forged huge seq would otherwise turn every read into a 503 (DoS). */
export function verifySignature(
  lane: Pick<LaneRow, 'webhook_secret'>,
  rawBody: string,
  header: string | undefined,
): void {
  if (!lane.webhook_secret) return;
  const expected = `sha256=${hmacSha256Hex(lane.webhook_secret, rawBody)}`;
  if (!header || !safeEqual(header, expected))
    throw new GatewayError('unauthorized', 401, 'bad webhook signature');
}

/**
 * D5 webhook ingest: durable log first (Postgres, deduped by event id), then invalidate in Redis. The
 * invalidation is idempotent (duplicates and out-of-order events are no-ops). If Redis is down we still
 * accept: the TTL backstop bounds staleness.
 */
export async function ingestWebhook(
  ctx: GatewayContext,
  lane: LaneRow,
  event: WebhookEvent,
): Promise<{ duplicate: boolean }> {
  const inserted = await ctx.db
    .insertInto('erp_events')
    .values({
      lane_id: lane.id,
      event_id: event.event_id,
      company_code: event.company_code,
      object_type: event.object_type,
      object_id: event.object_id,
      seq: event.seq,
      occurred_at: event.occurred_at,
    })
    .onConflict((oc) => oc.columns(['lane_id', 'event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (event.object_type === 'vendor' || event.object_type === 'invoice') {
    try {
      const k = ctx.keys;
      await runScript(
        ctx.redis,
        'cache_invalidate',
        [
          k.cacheEntry(lane.id, event.company_code, event.object_type, event.object_id),
          k.hwm(lane.id, event.company_code, event.object_type, event.object_id),
        ],
        [event.seq, ctx.config.cache.hwmTtlMs],
      );
    } catch (err) {
      ctx.log.warn({ err: String(err), event_id: event.event_id }, 'webhook.invalidate_failed');
    }
  }
  return { duplicate: !inserted };
}
