import { z } from 'zod';
import type { ActionTypeDef } from '../registry.js';

export const ClassifyInvoiceLinePayload = z
  .object({
    description: z.string().min(1).max(500),
    amount_minor: z.number().int().nonnegative().optional(),
    currency: z.literal('INR').optional(),
    vendor_id: z.string().min(1).max(64).optional(),
  })
  .strict();
export type ClassifyInvoiceLinePayload = z.infer<typeof ClassifyInvoiceLinePayload>;

export const classifyInvoiceLine: ActionTypeDef<ClassifyInvoiceLinePayload> = {
  type: 'classify_invoice_line',
  laneKind: 'llm',
  payloadSchema: ClassifyInvoiceLinePayload,
  conflictKey: () => null,
};
