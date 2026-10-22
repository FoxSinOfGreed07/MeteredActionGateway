export interface BankAccount {
  account_number: string;
  ifsc: string;
}

export interface Vendor {
  vendor_id: string;
  company_code: string;
  name: string;
  gstin: string;
  bank_account: BankAccount;
  payment_terms_days: number;
  blocked: boolean;
  seq: number;
  updated_at: string;
}

export interface Invoice {
  invoice_id: string;
  company_code: string;
  vendor_id: string;
  amount_minor: number;
  currency: 'INR';
  status: 'OPEN' | 'PAID';
  open_amount_minor: number;
  due_date: string;
  seq: number;
  updated_at: string;
}

export interface Payment {
  payment_id: string;
  company_code: string;
  invoice_id: string;
  amount_minor: number;
  currency: string;
  reference: string;
  created_at: string;
  seq: number;
}

export type ObjectType = 'vendor' | 'invoice' | 'payment';

export interface WebhookEvent {
  event_id: string;
  company_code: string;
  object_type: ObjectType;
  object_id: string;
  seq: number;
  occurred_at: string;
}

export type FaultMode =
  | 'status_429'
  | 'status_503'
  | 'latency'
  | 'drop_before_commit'
  | 'timeout_after_commit'
  | 'drop_after_commit'
  | 'error_500_after_commit'
  | 'stale_reads';

export const FAULT_MODES: readonly FaultMode[] = [
  'status_429',
  'status_503',
  'latency',
  'drop_before_commit',
  'timeout_after_commit',
  'drop_after_commit',
  'error_500_after_commit',
  'stale_reads',
];

export interface FaultRule {
  id?: string;
  mode: FaultMode;
  match?: { method?: 'GET' | 'POST' | 'PATCH'; path?: string };
  probability?: number;
  count?: number;
  duration_ms?: number;
  retry_after_s?: number;
  latency_ms?: number;
  hang_ms?: number;
  lag_ms?: number;
}

export interface MockErpConfig {
  webhook_url: string | null;
  webhook_secret: string;
  webhook_delay_ms: number;
  webhooks_enabled: boolean;
  rate_limit_rps: number;
  rate_limit_burst: number;
}

export interface MockErpOptions {
  seed?: number;
  config?: Partial<MockErpConfig>;
  /** Companies created at seed time (default C100, C200, C300). Unknown companies are created on demand. */
  companies?: string[];
  vendorsPerCompany?: number;
  invoicesPerCompany?: number;
}
