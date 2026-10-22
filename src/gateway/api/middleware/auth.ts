import type { MiddlewareHandler } from 'hono';
import type { TenantRow } from '../../../db/schema.js';
import { GatewayError } from '../../../shared/errors.js';
import { safeEqual, sha256Hex } from '../../../shared/hash.js';
import type { GatewayContext } from '../../context.js';
import type { AppEnv } from '../types.js';

const CACHE_TTL_MS = 30_000;

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m?.[1]?.trim();
}

/** Tenant auth: `Authorization: Bearer <key>` → sha256 → tenants.api_key_hash. The tenant NEVER comes from the body. */
export function tenantAuth(ctx: GatewayContext): MiddlewareHandler<AppEnv> {
  const cache = new Map<string, { tenant: TenantRow; at: number }>();
  return async (c, next) => {
    const key = bearer(c.req.header('authorization'));
    if (!key) throw new GatewayError('unauthorized', 401, 'missing bearer API key');
    const hash = sha256Hex(key);
    let hit = cache.get(hash);
    if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
      const tenant = await ctx.db
        .selectFrom('tenants')
        .selectAll()
        .where('api_key_hash', '=', hash)
        .executeTakeFirst();
      if (!tenant) throw new GatewayError('unauthorized', 401, 'invalid API key');
      hit = { tenant, at: Date.now() };
      cache.set(hash, hit);
    }
    c.set('tenant', hit.tenant);
    c.set('log', c.get('log').child({ tenant_id: hit.tenant.id }));
    await next();
  };
}

export function opsAuth(ctx: GatewayContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = bearer(c.req.header('authorization'));
    if (!key || !safeEqual(key, ctx.config.ops.apiKey))
      throw new GatewayError('unauthorized', 401, 'ops API key required');
    await next();
  };
}
