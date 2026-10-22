import type { Redis } from '../../redis/client.js';
import type { Keys } from '../../redis/keys.js';
import { runScript } from '../../redis/scripts.js';
import type { GatewayConfig } from '../../shared/config.js';

/** How the write path tells the read cache about our own writes (D5: delete-on-write is "raise the HWM"). */
export interface CacheHooks {
  /** seq = the invoice's new seq from the payment response; null = unknown (just drop the entry). */
  onInvoiceChanged(laneId: string, companyCode: string, invoiceId: string, seq: number | null): Promise<void>;
}

export const noopCacheHooks: CacheHooks = {
  async onInvoiceChanged() {},
};

export function createCacheHooks(deps: { redis: Redis; keys: Keys; config: GatewayConfig }): CacheHooks {
  return {
    async onInvoiceChanged(laneId, cc, invoiceId, seq) {
      const entry = deps.keys.cacheEntry(laneId, cc, 'invoice', invoiceId);
      if (seq === null) {
        await deps.redis.del(entry);
        return;
      }
      await runScript(
        deps.redis,
        'cache_invalidate',
        [entry, deps.keys.hwm(laneId, cc, 'invoice', invoiceId)],
        [seq, deps.config.cache.hwmTtlMs],
      );
    },
  };
}
