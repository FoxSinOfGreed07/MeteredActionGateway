import { Hono } from 'hono';
import type { CacheObjectType } from '../../../redis/keys.js';
import { GatewayError } from '../../../shared/errors.js';
import { budgetFor } from '../../cache/budgets.js';
import { CachedReader } from '../../cache/cached-reader.js';
import type { GatewayContext } from '../../context.js';
import { getLane } from '../../dispatch/lanes.js';
import type { AppEnv } from '../types.js';

/** Agents' ERP lookups through the read-through cache (D4). Reads are not metered (A11). */
export function erpReadRoutes(ctx: GatewayContext) {
  const reader = new CachedReader(ctx);
  const r = new Hono<AppEnv>();

  const read = (type: CacheObjectType) =>
    r.get(`/${type}s/:id`, async (c) => {
      const tenant = c.get('tenant');
      const lane = await getLane(ctx.db, tenant.erp_lane_id);
      const out = await reader.get(lane, tenant.erp_company_code, type, c.req.param('id'));
      if ('notFound' in out) throw new GatewayError('not_found', 404, `${type} not found`);
      return c.json({
        data: out.data,
        meta: {
          seq: out.seq,
          source: out.source,
          fetched_at: new Date(out.fetchedAtMs).toISOString(),
          age_ms: Math.max(0, Date.now() - out.fetchedAtMs),
          budget_ms: budgetFor(type, ctx.config),
        },
      });
    });
  read('vendor');
  read('invoice');
  return r;
}
