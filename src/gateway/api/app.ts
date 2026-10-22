import { Hono } from 'hono';
import { sql } from 'kysely';
import type { GatewayContext } from '../context.js';

export function createApp(ctx: GatewayContext): Hono {
  const app = new Hono();

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

  return app;
}
