import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';
import type { FaultStore } from '../faults.js';
import type { TokenBucket } from '../rate-limit.js';
import type { MockState } from '../state.js';
import { createStats, type Stats } from '../stats.js';
import { FAULT_MODES, type FaultRule, type MockErpConfig } from '../types.js';
import type { WebhookSender } from '../webhooks.js';

export interface AdminDeps {
  state: MockState;
  faults: FaultStore;
  stats: Stats;
  bucket: TokenBucket;
  config: MockErpConfig;
  webhooks: WebhookSender;
}

/** /__admin/*: never subject to faults or rate limits; always reads the primary (non-stale) state. */
export function mountAdminRoutes(app: Hono<{ Bindings: HttpBindings }>, d: AdminDeps): void {
  app.post('/__admin/reset', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { seed?: number };
    d.webhooks.cancelAll();
    d.faults.clear();
    d.state.reset(body.seed);
    Object.assign(d.stats, createStats());
    return c.json({ ok: true });
  });

  app.get('/__admin/stats', (c) => c.json(d.stats));
  app.post('/__admin/stats/reset', (c) => {
    const pending = d.stats.webhooks.pending;
    Object.assign(d.stats, createStats());
    d.stats.webhooks.pending = pending;
    return c.json({ ok: true });
  });

  app.post('/__admin/faults', async (c) => {
    const rule = (await c.req.json().catch(() => null)) as FaultRule | null;
    if (!rule || !FAULT_MODES.includes(rule.mode)) {
      return c.json(
        { code: 'VALIDATION_ERROR', message: `mode must be one of ${FAULT_MODES.join(', ')}` },
        400,
      );
    }
    const stored = d.faults.add(rule);
    return c.json({ id: stored.id });
  });
  app.get('/__admin/faults', (c) => c.json({ faults: d.faults.list() }));
  app.delete('/__admin/faults', (c) => {
    d.faults.clear();
    return c.json({ ok: true });
  });
  app.delete('/__admin/faults/:id', (c) => c.json({ removed: d.faults.remove(c.req.param('id')) }));

  app.patch('/__admin/companies/:cc/vendors/:id', async (c) => {
    const { cc, id } = c.req.param();
    const patch = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const delayQ = c.req.query('webhook_delay_ms');
    const v = d.state.patchVendor(cc, id, patch, delayQ === undefined ? undefined : Number(delayQ));
    if (!v) return c.json({ code: 'VENDOR_NOT_FOUND', message: `vendor ${id} not found` }, 404);
    return c.json(v);
  });

  app.post('/__admin/companies/:cc/invoices', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      count?: number;
      amount_minor?: number;
      vendor_id?: string;
    };
    const count = Math.max(0, Math.min(100_000, Number(body.count ?? 1)));
    const ids = d.state.createInvoices(c.req.param('cc'), {
      count,
      ...(body.amount_minor === undefined ? {} : { amount_minor: body.amount_minor }),
      ...(body.vendor_id === undefined ? {} : { vendor_id: body.vendor_id }),
    });
    return c.json({ invoice_ids: ids });
  });

  app.get('/__admin/companies/:cc/invoices', (c) => {
    const status = c.req.query('status');
    const limit = c.req.query('limit');
    return c.json({
      invoices: d.state.listInvoices(c.req.param('cc'), {
        ...(status ? { status } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
    });
  });

  app.get('/__admin/companies/:cc/invoices/:id', (c) => {
    const inv = d.state.getInvoice(c.req.param('cc'), c.req.param('id'));
    return inv ? c.json(inv) : c.json({ code: 'INVOICE_NOT_FOUND', message: 'not found' }, 404);
  });

  app.get('/__admin/companies/:cc/payments', (c) => {
    const reference = c.req.query('reference');
    const invoiceId = c.req.query('invoice_id');
    return c.json({
      payments: d.state.listPayments(c.req.param('cc'), {
        ...(reference ? { reference } : {}),
        ...(invoiceId ? { invoice_id: invoiceId } : {}),
      }),
    });
  });

  app.get('/__admin/config', (c) => c.json(d.config));
  app.put('/__admin/config', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<MockErpConfig>;
    for (const k of Object.keys(d.config) as (keyof MockErpConfig)[]) {
      if (body[k] !== undefined) (d.config as unknown as Record<string, unknown>)[k] = body[k];
    }
    d.bucket.configure(d.config.rate_limit_rps, d.config.rate_limit_burst);
    return c.json(d.config);
  });
}
