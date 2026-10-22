import { serve } from '@hono/node-server';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { createApp } from './api/app.js';
import { closeContext, createContext } from './context.js';

const log = createLogger('api');
const config = loadConfig();
const ctx = createContext(config, { log });
const app = createApp(ctx);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info({ port: info.port }, 'api.listening');
});

async function shutdown(signal: string) {
  log.info({ signal }, 'api.stopping');
  server.close();
  await closeContext(ctx);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
