import type { ErpConnector } from './connector.js';
import { type ConnectorLane, HttpErpConnector } from './http-erp-connector.js';

export * from './connector.js';

const connectors = new Map<string, ErpConnector>();

/** One connector per lane configuration (memoized; lane config changes produce a new connector). */
export function connectorForLane(lane: ConnectorLane): ErpConnector {
  const key = `${lane.id}|${lane.base_url}|${lane.request_timeout_ms}`;
  let c = connectors.get(key);
  if (!c) {
    c = new HttpErpConnector(lane);
    connectors.set(key, c);
  }
  return c;
}
