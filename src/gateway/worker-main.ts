import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { closeContext, createContext } from './context.js';

const log = createLogger('worker');
const config = loadConfig();
const ctx = createContext(config, { log });

log.info({ worker_id: config.workerId }, 'worker.started');

async function shutdown(signal: string) {
  log.info({ signal }, 'worker.stopping');
  await closeContext(ctx);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// Keep the process alive until a signal arrives (step 06 replaces this with the real worker loops).
setInterval(() => {}, 1 << 30);
