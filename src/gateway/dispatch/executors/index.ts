import type { ActionRow, LaneRow, TenantRow } from '../../../db/schema.js';
import type { GatewayContext } from '../../context.js';
import { executePayInvoice } from './pay-invoice.js';

export interface ExecArgs {
  ctx: GatewayContext;
  action: ActionRow;
  tenant: TenantRow;
  lane: LaneRow;
  /** Lease owner (fencing token for settlement). */
  owner: string;
  /** True when the worker was stopped with `abandon` (crash simulation): the executor must NOT settle. */
  isAbandoned(): boolean;
}

/**
 * Executors receive a claimed (DISPATCHING, leased) action and settle it. Throwing is a bug: the dispatcher
 * logs it and does NOT settle — the lease expires, recovery moves the action to UNKNOWN, reconciliation
 * resolves it. That is the safe default.
 */
export type Executor = (a: ExecArgs) => Promise<void>;

const EXECUTORS = new Map<string, Executor>([['pay_invoice', executePayInvoice]]);

export function registerExecutor(actionType: string, fn: Executor): void {
  EXECUTORS.set(actionType, fn);
}

export function getExecutor(actionType: string): Executor | undefined {
  return EXECUTORS.get(actionType);
}
