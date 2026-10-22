import { createLogger } from '../shared/logger.js';
import { createMockErp } from './app.js';

const log = createLogger('mock-erp');
const env = process.env;
const mock = createMockErp({
  seed: Number(env.MOCK_ERP_SEED ?? 42),
  config: {
    webhook_url: env.MOCK_ERP_WEBHOOK_URL ?? 'http://localhost:3000/v1/webhooks/erp/sap-main',
    webhook_secret: env.MOCK_ERP_WEBHOOK_SECRET ?? 'dev-webhook-secret',
    webhook_delay_ms: Number(env.MOCK_ERP_WEBHOOK_DELAY_MS ?? 500),
    rate_limit_rps: Number(env.MOCK_ERP_RATE_LIMIT_RPS ?? 100),
    rate_limit_burst: Number(env.MOCK_ERP_RATE_LIMIT_BURST ?? 100),
  },
});
const running = await mock.start(Number(env.MOCK_ERP_PORT ?? 4000));
log.info({ port: running.port, webhook_url: mock.config.webhook_url }, 'mock-erp.listening');

const stop = async () => {
  await running.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
