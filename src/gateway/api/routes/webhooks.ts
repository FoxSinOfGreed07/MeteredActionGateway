import { Hono } from 'hono';
import { GatewayError } from '../../../shared/errors.js';
import { ingestWebhook, verifySignature, WebhookEvent } from '../../cache/webhook-ingest.js';
import type { GatewayContext } from '../../context.js';
import { getLane } from '../../dispatch/lanes.js';
import type { AppEnv } from '../types.js';

export function webhookRoutes(ctx: GatewayContext) {
  const r = new Hono<AppEnv>();
  r.post('/erp/:laneId', async (c) => {
    const lane = await getLane(ctx.db, c.req.param('laneId')).catch(() => {
      throw new GatewayError('not_found', 404, 'unknown lane');
    });
    const raw = await c.req.text(); // the HMAC covers the raw bytes: read them before parsing
    verifySignature(lane, raw, c.req.header('x-erp-signature'));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new GatewayError('invalid_request', 400, 'body must be JSON');
    }
    const event = WebhookEvent.parse(parsed);
    await ingestWebhook(ctx, lane, event);
    return c.body(null, 204);
  });
  return r;
}
