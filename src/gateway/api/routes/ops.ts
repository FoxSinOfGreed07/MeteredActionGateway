import { Hono } from 'hono';
import { z } from 'zod';
import { GatewayError } from '../../../shared/errors.js';
import type { GatewayContext } from '../../context.js';
import { grant } from '../../wallet/ledger.js';
import { walletView } from '../../wallet/wallet.js';
import type { AppEnv } from '../types.js';

const GrantBody = z.object({ amount: z.number().int().positive(), reason: z.string().min(1).max(200) });

export function opsRoutes(ctx: GatewayContext) {
  const r = new Hono<AppEnv>();

  r.post('/tenants/:id/grant', async (c) => {
    const tenantId = c.req.param('id');
    const body = GrantBody.parse(await c.req.json().catch(() => ({})));
    const tenant = await ctx.db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!tenant) throw new GatewayError('not_found', 404, `tenant ${tenantId} not found`);
    await ctx.db
      .transaction()
      .execute((tx) => grant(tx, { tenantId, amount: body.amount, reason: body.reason }));
    return c.json(await walletView(ctx.db, tenantId));
  });

  return r;
}
