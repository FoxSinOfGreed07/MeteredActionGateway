import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { GatewayError } from '../../../shared/errors.js';
import type { AppEnv } from '../types.js';

/** Error body: `{ "error": { "code", "message", "details"? } }` (plans/00-architecture.md §8). */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof GatewayError) {
    if (err.retryAfterS !== undefined) c.header('Retry-After', String(err.retryAfterS));
    return c.json(err.toBody(), err.httpStatus as ContentfulStatusCode);
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'request failed validation',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
      400,
    );
  }
  (c.get('log') ?? console).error(
    { err: err instanceof Error ? err.stack : String(err) },
    'api.unhandled_error',
  );
  return c.json({ error: { code: 'internal_error', message: 'internal error' } }, 500);
};

export const notFound: NotFoundHandler<AppEnv> = (c) =>
  c.json({ error: { code: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` } }, 404);
