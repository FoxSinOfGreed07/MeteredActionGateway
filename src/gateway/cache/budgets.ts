import type { LaneRow } from '../../db/schema.js';
import type { CacheObjectType } from '../../redis/keys.js';
import type { GatewayConfig } from '../../shared/config.js';

/**
 * Declared staleness budgets (D5). Budget = the longest a value may be served after the ERP write that made
 * it wrong. TTL = budget − max_read_lag, because a fill can already be up to max_read_lag old when it lands.
 *
 * | Object type                 | Budget        | TTL (lag 5 s) | Invalidated by                               |
 * |-----------------------------|---------------|---------------|----------------------------------------------|
 * | Vendor master               | 60 s          | 55 s          | webhook seq; TTL backstop                    |
 * | Invoice                     | 15 s          | 10 s          | own payment response seq + webhook; TTL      |
 * | Payment lookup by reference | never cached  | —             | — (reconciliation must see the ERP)          |
 * | Classification result       | unbounded     | none          | immutable; key includes model + prompt ver.  |
 */
export function budgetFor(type: CacheObjectType, config: GatewayConfig): number {
  return type === 'vendor' ? config.cache.budgets.vendorMs : config.cache.budgets.invoiceMs;
}

export function ttlFor(
  type: CacheObjectType,
  lane: Pick<LaneRow, 'max_read_lag_ms'>,
  config: GatewayConfig,
): number {
  return budgetFor(type, config) - lane.max_read_lag_ms;
}
