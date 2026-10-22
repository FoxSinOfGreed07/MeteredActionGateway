import { Hono } from 'hono';
import type { GatewayContext } from '../../context.js';
import { listLedger, walletView } from '../../wallet/wallet.js';
import type { AppEnv } from '../types.js';

export function walletRoutes(ctx: GatewayContext) {
  const r = new Hono<AppEnv>();
  r.get('/', async (c) => c.json(await walletView(ctx.db, c.get('tenant').id)));
  r.get('/ledger', async (c) => {
    const limit = Number(c.req.query('limit') ?? 100);
    const entries = await listLedger(ctx.db, c.get('tenant').id, Number.isFinite(limit) ? limit : 100);
    return c.json({ entries });
  });
  return r;
}
