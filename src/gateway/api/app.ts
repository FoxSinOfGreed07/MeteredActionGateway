import { Hono } from 'hono';
import { sql } from 'kysely';
import type { GatewayContext } from '../context.js';
import { opsAuth, tenantAuth } from './middleware/auth.js';
import { notFound, onError } from './middleware/error.js';
import { requestId } from './middleware/request-id.js';
import { actionRoutes } from './routes/actions.js';
import { opsRoutes } from './routes/ops.js';
import { walletRoutes } from './routes/wallet.js';
import type { AppEnv } from './types.js';

export function createApp(ctx: GatewayContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requestId(ctx));
  app.onError(onError);
  app.notFound(notFound);

  app.get('/healthz', async (c) => {
    const [db, redis] = await Promise.all([
      sql`SELECT 1`.execute(ctx.db).then(
        () => true,
        () => false,
      ),
      ctx.redis.ping().then(
        (r) => r === 'PONG',
        () => false,
      ),
    ]);
    return c.json({ ok: db && redis, db, redis }, db && redis ? 200 : 503);
  });

  const auth = tenantAuth(ctx);
  app.use('/v1/actions/*', auth);
  app.use('/v1/actions', auth);
  app.use('/v1/wallet/*', auth);
  app.use('/v1/wallet', auth);
  app.use('/v1/ops/*', opsAuth(ctx));

  app.route('/v1/actions', actionRoutes(ctx));
  app.route('/v1/wallet', walletRoutes(ctx));
  app.route('/v1/ops', opsRoutes(ctx));
  return app;
}
