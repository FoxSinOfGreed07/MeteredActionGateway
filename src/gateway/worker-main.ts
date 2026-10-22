import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { closeContext, createContext } from './context.js';
import { startWorker } from './worker.js';

const log = createLogger('worker');
const config = loadConfig();
const ctx = createContext(config, { log });
const worker = await startWorker(ctx, { logDepthEveryMs: 5000 });

async function shutdown(signal: string) {
  log.info({ signal }, 'worker.stopping');
  await worker.stop();
  await closeContext(ctx);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
