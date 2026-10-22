import type { DbOrTx } from '../../db/tx.js';
import { GatewayError } from '../../shared/errors.js';

export interface Price {
  hold: number;
  capture: number;
  cacheHitCapture: number | null;
}

const TTL_MS = 60_000;
const caches = new WeakMap<object, { at: number; prices: Map<string, Price> }>();

/** Price per action type (A11). The price list is small and static: cached per database handle for 60s. */
export async function getPrice(db: DbOrTx, actionType: string): Promise<Price> {
  let entry = caches.get(db);
  if (!entry || Date.now() - entry.at > TTL_MS || !entry.prices.has(actionType)) {
    const rows = await db.selectFrom('price_list').selectAll().execute();
    entry = {
      at: Date.now(),
      prices: new Map(
        rows.map((r) => [
          r.action_type,
          { hold: r.hold_amount, capture: r.capture_amount, cacheHitCapture: r.cache_hit_capture_amount },
        ]),
      ),
    };
    caches.set(db, entry);
  }
  const price = entry.prices.get(actionType);
  if (!price) throw new GatewayError('unknown_action_type', 400, `no price for action type "${actionType}"`);
  return price;
}
