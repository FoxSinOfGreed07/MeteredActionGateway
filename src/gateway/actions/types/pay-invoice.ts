import { z } from 'zod';
import type { ActionTypeDef } from '../registry.js';

/** Full-payment only (S5): the agent states the amount it believes is open; the ERP rejects a mismatch. */
export const PayInvoicePayload = z
  .object({
    invoice_id: z.string().min(1).max(64),
    amount_minor: z.number().int().positive(),
    currency: z.literal('INR'),
  })
  .strict();
export type PayInvoicePayload = z.infer<typeof PayInvoicePayload>;

export const payInvoice: ActionTypeDef<PayInvoicePayload> = {
  type: 'pay_invoice',
  laneKind: 'erp',
  payloadSchema: PayInvoicePayload,
  conflictKey: (p) => `invoice:${p.invoice_id}`,
};
