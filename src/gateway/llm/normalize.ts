import type { ClassifyInvoiceLinePayload } from '../actions/types/classify-invoice-line.js';

export interface NormalizedInput {
  description: string;
  amount_minor?: number;
  currency?: string;
  vendor_id?: string;
}

/**
 * A13: what the cache key hashes. Trim, collapse whitespace, Unicode NFC. Case is PRESERVED on purpose
 * ("AWS" vs "aws" may differ for some taxonomies; a miss is cheaper than a wrong shared answer).
 */
export function normalizeInput(p: ClassifyInvoiceLinePayload): NormalizedInput {
  return {
    description: p.description.normalize('NFC').trim().replace(/\s+/g, ' '),
    ...(p.amount_minor === undefined ? {} : { amount_minor: p.amount_minor }),
    ...(p.currency === undefined ? {} : { currency: p.currency }),
    ...(p.vendor_id === undefined ? {} : { vendor_id: p.vendor_id }),
  };
}
