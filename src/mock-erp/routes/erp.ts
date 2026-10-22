import type { HttpBindings } from '@hono/node-server';
import type { Context, Hono } from 'hono';
import { sleep } from '../../shared/sleep.js';
import type { FaultStore } from '../faults.js';
import type { TokenBucket } from '../rate-limit.js';
import type { MockState } from '../state.js';
import { bump, type Stats } from '../stats.js';

export interface ErpDeps {
  state: MockState;
  faults: FaultStore;
  stats: Stats;
  bucket: TokenBucket;
}

type Env = { Bindings: HttpBindings };

const PAYMENTS = /^\/companies\/[^/]+\/payments$/;

function routeKey(method: string, path: string): string {
  if (/^\/companies\/[^/]+\/vendors\/[^/]+$/.test(path)) return `${method} /companies/:cc/vendors/:id`;
  if (/^\/companies\/[^/]+\/invoices\/[^/]+$/.test(path)) return `${method} /companies/:cc/invoices/:id`;
  if (PAYMENTS.test(path)) return `${method} /companies/:cc/payments`;
  return `${method} ${path}`;
}

/** Kill the TCP connection without a response (only possible over real HTTP, not app.request()). */
function destroySocket(c: Context<Env>): Response {
  try {
    c.env.incoming.socket.destroy();
  } catch {
    /* not a node socket (in-process app.request): nothing to destroy */
  }
  return new Response(null, { status: 204 });
}

export function mountErpRoutes(app: Hono<Env>, d: ErpDeps): void {
  // Request pipeline (plans/00-architecture.md §9 "Evaluation order"); admin + health routes are not under /companies.
  app.use('/companies/*', async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    bump(d.stats.requests_by_route, routeKey(method, path));
    if (method === 'POST' && PAYMENTS.test(path)) d.stats.payment_posts_received += 1;

    const forced = d.faults.match(['status_429', 'status_503'], method, path);
    if (forced) {
      bump(d.stats.faults_applied, forced.mode);
      const status = forced.mode === 'status_429' ? 429 : 503;
      if (status === 429) d.stats.rate_limited_429 += 1;
      bump(d.stats.responses_by_status, String(status));
      c.header('Retry-After', String(forced.retry_after_s ?? 1));
      return c.json(
        { code: status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE', message: 'injected fault' },
        status,
      );
    }
    if (!d.bucket.tryTake()) {
      d.stats.rate_limited_429 += 1;
      bump(d.stats.responses_by_status, '429');
      c.header('Retry-After', '1');
      return c.json({ code: 'RATE_LIMITED', message: 'rate limit exceeded' }, 429);
    }
    const latency = d.faults.match(['latency'], method, path);
    if (latency) {
      bump(d.stats.faults_applied, 'latency');
      // The handler still runs afterwards: if the client already timed out, this is a LATE COMMIT (D2).
      await sleep(latency.latency_ms ?? 1000);
    }
    const drop = d.faults.match(['drop_before_commit'], method, path);
    if (drop) {
      bump(d.stats.faults_applied, 'drop_before_commit');
      return destroySocket(c);
    }
    await next();
    bump(d.stats.responses_by_status, String(c.res.status));
  });

  /** Reads honour `stale_reads`: served from the snapshot as of now − lag_ms (assumption S3). */
  const asOf = (c: Context<Env>): number => {
    const stale = d.faults.match(['stale_reads'], 'GET', c.req.path);
    if (!stale) return Date.now();
    bump(d.stats.faults_applied, 'stale_reads');
    return Date.now() - (stale.lag_ms ?? 60_000);
  };

  app.get('/companies/:cc/vendors/:id', (c) => {
    const { cc, id } = c.req.param();
    bump(d.stats.reads.vendor, `${cc}/${id}`);
    const v = d.state.getVendor(cc, id, asOf(c));
    if (!v) return c.json({ code: 'VENDOR_NOT_FOUND', message: `vendor ${id} not found` }, 404);
    c.header('ETag', `"${v.seq}"`);
    return c.json(v);
  });

  app.get('/companies/:cc/invoices/:id', (c) => {
    const { cc, id } = c.req.param();
    bump(d.stats.reads.invoice, `${cc}/${id}`);
    const inv = d.state.getInvoice(cc, id, asOf(c));
    if (!inv) return c.json({ code: 'INVOICE_NOT_FOUND', message: `invoice ${id} not found` }, 404);
    c.header('ETag', `"${inv.seq}"`);
    return c.json(inv);
  });

  app.get('/companies/:cc/payments', (c) => {
    const cc = c.req.param('cc');
    const reference = c.req.query('reference');
    d.stats.reads.payment_lookup += 1;
    if (!reference) return c.json({ code: 'VALIDATION_ERROR', message: 'reference is required' }, 400);
    return c.json({ payments: d.state.findPayments(cc, reference, asOf(c)) });
  });

  app.post('/companies/:cc/payments', async (c) => {
    const cc = c.req.param('cc');
    const body = await c.req.json().catch(() => ({}));
    // Synchronous validate + commit: no await between the check and the write.
    const res = d.state.payInvoice(cc, body as Record<string, unknown>);
    if (res.status !== 201) return c.json(res.body, res.status);
    d.stats.payments_created += 1;

    const post = d.faults.match(
      ['timeout_after_commit', 'drop_after_commit', 'error_500_after_commit'],
      'POST',
      c.req.path,
    );
    if (post) {
      bump(d.stats.faults_applied, post.mode);
      if (post.mode === 'error_500_after_commit') {
        return c.json({ code: 'INTERNAL_ERROR', message: 'injected: committed, then failed' }, 500);
      }
      if (post.mode === 'timeout_after_commit') await sleep(post.hang_ms ?? 30_000);
      return destroySocket(c);
    }
    return c.json(res.body, 201);
  });
}
