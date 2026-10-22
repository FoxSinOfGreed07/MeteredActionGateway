import type { z } from 'zod';
import type { TenantRow } from '../../db/schema.js';
import { classifyInvoiceLine } from './types/classify-invoice-line.js';
import { payInvoice } from './types/pay-invoice.js';

/**
 * Action types. Executors are NOT here (they live in dispatch/executors/*, keyed by type); the registry
 * only knows how to validate, route and conflict-check a submission.
 */
export interface ActionTypeDef<P = unknown> {
  type: string;
  laneKind: 'erp' | 'llm';
  payloadSchema: z.ZodType<P>;
  /** A10: only one non-final action per (tenant, conflict key). null = no conflict scope. */
  conflictKey(payload: P): string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry, each entry is typed at its definition
const REGISTRY: Record<string, ActionTypeDef<any>> = {
  [payInvoice.type]: payInvoice,
  [classifyInvoiceLine.type]: classifyInvoiceLine,
};

export function getActionType(type: string): ActionTypeDef | undefined {
  return Object.hasOwn(REGISTRY, type) ? REGISTRY[type] : undefined;
}

export function resolveLane(
  tenant: Pick<TenantRow, 'erp_lane_id'>,
  def: Pick<ActionTypeDef, 'laneKind'>,
): string {
  return def.laneKind === 'erp' ? tenant.erp_lane_id : 'llm';
}
