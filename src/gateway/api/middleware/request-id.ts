import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { GatewayContext } from '../../context.js';
import type { AppEnv } from '../types.js';

export function requestId(ctx: GatewayContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = c.req.header('x-request-id') ?? randomUUID();
    c.set('requestId', id);
    c.set('log', ctx.log.child({ request_id: id }));
    c.header('X-Request-Id', id);
    await next();
  };
}
