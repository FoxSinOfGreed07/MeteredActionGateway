/**
 * The gateway ↔ ERP adapter contract (plans/05-erp-connector.md). Every send is classified into exactly one
 * outcome kind; every downstream component acts on that classification, so it is the most under-rated
 * piece of the system.
 *
 * RULE: the connector does NOT rate-limit or retry. Callers acquire a token first (dispatcher, reconciler,
 * cache) and own the retry policy, because only they know the action's state.
 */

export type SendOutcome<T> =
  | { kind: 'committed'; value: T }
  | { kind: 'retryable'; reason: 'rate_limited' | 'unavailable' | 'unreachable'; retryAfterMs?: number }
  | { kind: 'permanent'; code: string; message: string; details?: unknown; httpStatus: number }
  | {
      kind: 'ambiguous';
      reason: 'timeout' | 'connection_reset' | 'http_5xx' | 'unclassified';
      detail?: string;
    };

export interface ErpVendor {
  vendor_id: string;
  company_code: string;
  name: string;
  gstin: string;
  bank_account: { account_number: string; ifsc: string };
  payment_terms_days: number;
  blocked: boolean;
  seq: number;
  updated_at: string;
}

export interface ErpInvoice {
  invoice_id: string;
  company_code: string;
  vendor_id: string;
  amount_minor: number;
  currency: string;
  status: 'OPEN' | 'PAID';
  open_amount_minor: number;
  due_date: string;
  seq: number;
  updated_at: string;
}

export interface ErpPayment {
  payment_id: string;
  company_code: string;
  invoice_id: string;
  amount_minor: number;
  currency: string;
  reference: string;
  created_at: string;
  seq: number;
}

export interface PostPaymentRequest {
  companyCode: string;
  invoiceId: string;
  amountMinor: number;
  currency: 'INR';
  /** D1: our action id, stamped on the ERP document so any later doubt is settled by lookup. */
  reference: string;
}

export interface PostPaymentResult {
  /** null only when the ERP answered 2xx but the body was unreadable (still committed: trust the status). */
  payment: ErpPayment | null;
  /** Carries the invoice's NEW seq — an own-write HWM bump for the cache (D5). */
  invoice: ErpInvoice | null;
}

export type ReadResult<T> = { status: 'ok'; data: T; seq: number } | { status: 'not_found' };

export type ErpReadErrorKind = 'rate_limited' | 'unavailable' | 'timeout' | 'error';

export class ErpReadError extends Error {
  constructor(
    readonly kind: ErpReadErrorKind,
    message: string,
    readonly retryAfterMs?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ErpReadError';
  }
}

export interface ErpConnector {
  readonly laneId: string;
  /** Never throws: every observation maps to a SendOutcome. */
  postPayment(req: PostPaymentRequest): Promise<SendOutcome<PostPaymentResult>>;
  /** Throws ErpReadError. Reads are safe to repeat, so there is no "ambiguous" class for them. */
  findPaymentsByReference(companyCode: string, reference: string): Promise<ErpPayment[]>;
  getVendor(companyCode: string, vendorId: string): Promise<ReadResult<ErpVendor>>;
  getInvoice(companyCode: string, invoiceId: string): Promise<ReadResult<ErpInvoice>>;
}
