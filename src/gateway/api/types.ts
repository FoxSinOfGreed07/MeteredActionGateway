import type { TenantRow } from '../../db/schema.js';
import type { Logger } from '../../shared/logger.js';

export type AppEnv = {
  Variables: {
    tenant: TenantRow;
    requestId: string;
    log: Logger;
  };
};
