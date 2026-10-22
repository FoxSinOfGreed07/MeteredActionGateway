import type { AddressInfo } from 'node:net';
import { type HttpBindings, type ServerType, serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createLogger } from '../shared/logger.js';
import { FaultStore } from './faults.js';
import { TokenBucket } from './rate-limit.js';
import { mountAdminRoutes } from './routes/admin.js';
import { mountErpRoutes } from './routes/erp.js';
import { MockState } from './state.js';
import { createStats } from './stats.js';
import type { MockErpConfig, MockErpOptions } from './types.js';
import { WebhookSender } from './webhooks.js';

export interface RunningMockErp {
  url: string;
  port: number;
  close(): Promise<void>;
}

export type MockErpInstance = ReturnType<typeof createMockErp>;

/** A SAP-style ERP the gateway doesn't control, with realistic failure modes (plans/02-mock-erp.md). */
export function createMockErp(options: MockErpOptions = {}) {
  const log = createLogger('mock-erp');
  const config: MockErpConfig = {
    webhook_url: null,
    webhook_secret: 'dev-webhook-secret',
    webhook_delay_ms: 500,
    webhooks_enabled: true,
    rate_limit_rps: 100,
    rate_limit_burst: 100,
    ...options.config,
  };
  const stats = createStats();
  const faults = new FaultStore();
  const bucket = new TokenBucket(config.rate_limit_rps, config.rate_limit_burst);
  const webhooks = new WebhookSender(config, stats, log);
  const state = new MockState(
    options.seed ?? 42,
    {
      companies: options.companies ?? ['C100', 'C200', 'C300'],
      vendorsPerCompany: options.vendorsPerCompany ?? 25,
      invoicesPerCompany: options.invoicesPerCompany ?? 500,
    },
    (event, delay) => webhooks.enqueue(event, delay),
  );

  const app = new Hono<{ Bindings: HttpBindings }>();
  app.get('/health', (c) => c.json({ ok: true }));
  mountAdminRoutes(app, { state, faults, stats, bucket, config, webhooks });
  mountErpRoutes(app, { state, faults, stats, bucket });
  app.onError((err, c) => {
    log.error({ err: String(err) }, 'mock-erp.error');
    return c.json({ code: 'INTERNAL_ERROR', message: String(err) }, 500);
  });

  async function start(port = 0, hostname?: string): Promise<RunningMockErp> {
    const server: ServerType = await new Promise((resolve) => {
      const s = serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) }, () => resolve(s));
    });
    const actual = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${actual}`,
      port: actual,
      close: () =>
        new Promise<void>((resolve) => {
          webhooks.cancelAll();
          const s = server as unknown as { close(cb: () => void): void; closeAllConnections?: () => void };
          s.closeAllConnections?.(); // timeout_after_commit keeps sockets hanging
          s.close(() => resolve());
        }),
    };
  }

  return { app, state, faults, stats, config, webhooks, start };
}
