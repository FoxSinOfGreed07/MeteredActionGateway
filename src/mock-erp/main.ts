import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createLogger } from '../shared/logger.js';

// Step 01 stub: health only. Step 02 replaces this with the full mock ERP.
const log = createLogger('mock-erp');
const port = Number(process.env.MOCK_ERP_PORT ?? 4000);
const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));
serve({ fetch: app.fetch, port }, (info) => log.info({ port: info.port }, 'mock-erp.listening'));
