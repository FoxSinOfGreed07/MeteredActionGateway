import { randomUUID } from 'node:crypto';
import { createPrng, type Prng } from './prng.js';
import { invoiceId, makeInvoice, makeVendor, pad, vendorId } from './seed.js';
import type { Invoice, ObjectType, Payment, Vendor, WebhookEvent } from './types.js';

/** One object with its version history: stale reads are served from `history` (plans/02-mock-erp.md). */
interface Versioned<T> {
  current: T;
  history: Array<{ seq: number; atMs: number; data: T }>;
}

interface CompanyState {
  vendors: Map<string, Versioned<Vendor>>;
  invoices: Map<string, Versioned<Invoice>>;
  payments: Array<Payment & { createdAtMs: number }>;
  paymentsByRef: Map<string, Array<Payment & { createdAtMs: number }>>; // NOT unique (assumption S2)
  paymentSeq: number;
  invoiceSeq: number;
}

const MAX_VERSIONS = 50;

export type PayResult =
  | { status: 201; body: { payment: Payment; invoice: Invoice } }
  | { status: 400 | 404 | 409 | 422; body: { code: string; message: string; invoice?: Invoice } };

export interface PayRequest {
  invoice_id?: unknown;
  amount_minor?: unknown;
  currency?: unknown;
  reference?: unknown;
}

export type Emit = (event: WebhookEvent, delayOverrideMs?: number) => void;

export class MockState {
  readonly companies = new Map<string, CompanyState>();
  private prng: Prng;
  private seedAtMs: number;

  constructor(
    private readonly seed: number,
    private readonly opts: { companies: string[]; vendorsPerCompany: number; invoicesPerCompany: number },
    private readonly emit: Emit,
  ) {
    this.prng = createPrng(seed);
    this.seedAtMs = Date.now() - 86_400_000;
    this.reset(seed);
  }

  reset(seed = this.seed): void {
    this.prng = createPrng(seed);
    this.seedAtMs = Date.now() - 86_400_000;
    this.companies.clear();
    for (const cc of this.opts.companies) this.createCompany(cc, this.opts.invoicesPerCompany);
  }

  private createCompany(cc: string, invoices: number): CompanyState {
    const at = new Date(this.seedAtMs).toISOString();
    const company: CompanyState = {
      vendors: new Map(),
      invoices: new Map(),
      payments: [],
      paymentsByRef: new Map(),
      paymentSeq: 0,
      invoiceSeq: 0,
    };
    for (let i = 1; i <= this.opts.vendorsPerCompany; i++) {
      const v = makeVendor(this.prng, cc, i, at);
      company.vendors.set(v.vendor_id, this.versioned(v, this.seedAtMs));
    }
    for (let i = 1; i <= invoices; i++) {
      const vendor = vendorId(this.prng.int(1, this.opts.vendorsPerCompany));
      const inv = makeInvoice(this.prng, cc, i, vendor, at);
      company.invoices.set(inv.invoice_id, this.versioned(inv, this.seedAtMs));
    }
    company.invoiceSeq = invoices;
    this.companies.set(cc, company);
    return company;
  }

  /** Unknown company codes are created on demand (vendors only), so tests can use fresh tenants. */
  company(cc: string): CompanyState {
    return this.companies.get(cc) ?? this.createCompany(cc, 0);
  }

  private versioned<T extends { seq: number }>(data: T, atMs: number): Versioned<T> {
    return { current: data, history: [{ seq: data.seq, atMs, data }] };
  }

  /** Copy-on-write update: new version (seq + 1) pushed to history, webhook emitted. */
  private write<T extends { seq: number; updated_at: string }>(
    cc: string,
    type: ObjectType,
    id: string,
    v: Versioned<T>,
    mutate: (draft: T) => void,
    delayOverrideMs?: number,
  ): T {
    const nowMs = Date.now();
    const draft = structuredClone(v.current);
    mutate(draft);
    draft.seq = v.current.seq + 1;
    draft.updated_at = new Date(nowMs).toISOString();
    v.current = draft;
    v.history.push({ seq: draft.seq, atMs: nowMs, data: draft });
    if (v.history.length > MAX_VERSIONS) v.history.splice(0, v.history.length - MAX_VERSIONS);
    this.emitChange(cc, type, id, draft.seq, delayOverrideMs);
    return draft;
  }

  private emitChange(cc: string, type: ObjectType, id: string, seq: number, delayOverrideMs?: number): void {
    this.emit(
      {
        event_id: randomUUID(),
        company_code: cc,
        object_type: type,
        object_id: id,
        seq,
        occurred_at: new Date().toISOString(),
      },
      delayOverrideMs,
    );
  }

  private readAsOf<T>(v: Versioned<T> | undefined, asOfMs: number): T | undefined {
    if (!v) return undefined;
    for (let i = v.history.length - 1; i >= 0; i--) {
      const h = v.history[i];
      if (h && h.atMs <= asOfMs) return h.data;
    }
    return undefined; // didn't exist yet in that snapshot
  }

  getVendor(cc: string, id: string, asOfMs = Date.now()): Vendor | undefined {
    return this.readAsOf(this.company(cc).vendors.get(id), asOfMs);
  }

  getInvoice(cc: string, id: string, asOfMs = Date.now()): Invoice | undefined {
    return this.readAsOf(this.company(cc).invoices.get(id), asOfMs);
  }

  findPayments(cc: string, reference: string, asOfMs = Date.now()): Payment[] {
    return (this.company(cc).paymentsByRef.get(reference) ?? [])
      .filter((p) => p.createdAtMs <= asOfMs)
      .map(({ createdAtMs: _, ...p }) => p);
  }

  /** Primary (never stale) listing, for assertions. */
  listPayments(cc: string, filter: { reference?: string; invoice_id?: string } = {}): Payment[] {
    return this.company(cc)
      .payments.filter((p) => filter.reference === undefined || p.reference === filter.reference)
      .filter((p) => filter.invoice_id === undefined || p.invoice_id === filter.invoice_id)
      .map(({ createdAtMs: _, ...p }) => p);
  }

  listInvoices(cc: string, filter: { status?: string; limit?: number } = {}): Invoice[] {
    const out: Invoice[] = [];
    for (const v of this.company(cc).invoices.values()) {
      if (filter.status && v.current.status !== filter.status) continue;
      out.push(v.current);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  /**
   * Validate AND commit synchronously — no `await` anywhere in here. That is what serializes two concurrent
   * posts for the same invoice: the second sees PAID and gets a 409.
   */
  payInvoice(cc: string, req: PayRequest): PayResult {
    const { invoice_id, amount_minor, currency, reference } = req;
    if (
      typeof invoice_id !== 'string' ||
      typeof currency !== 'string' ||
      typeof reference !== 'string' ||
      reference.length < 1 ||
      reference.length > 64 ||
      typeof amount_minor !== 'number' ||
      !Number.isInteger(amount_minor) ||
      amount_minor <= 0
    ) {
      return { status: 400, body: { code: 'VALIDATION_ERROR', message: 'invalid payment body' } };
    }
    const company = this.company(cc);
    const inv = company.invoices.get(invoice_id);
    if (!inv)
      return { status: 404, body: { code: 'INVOICE_NOT_FOUND', message: `invoice ${invoice_id} not found` } };
    if (inv.current.status !== 'OPEN') {
      return {
        status: 409,
        body: {
          code: 'INVOICE_ALREADY_PAID',
          message: `invoice ${invoice_id} is already paid`,
          invoice: inv.current,
        },
      };
    }
    if (currency !== inv.current.currency) {
      return {
        status: 422,
        body: {
          code: 'CURRENCY_MISMATCH',
          message: `currency must be ${inv.current.currency}`,
          invoice: inv.current,
        },
      };
    }
    if (amount_minor !== inv.current.open_amount_minor) {
      return {
        status: 422,
        body: {
          code: 'AMOUNT_MISMATCH',
          message: `amount ${amount_minor} does not equal open amount ${inv.current.open_amount_minor}`,
          invoice: inv.current,
        },
      };
    }
    // ---- commit ----
    const nowMs = Date.now();
    company.paymentSeq += 1;
    const payment: Payment & { createdAtMs: number } = {
      payment_id: `PAY-${pad(company.paymentSeq, 6)}`,
      company_code: cc,
      invoice_id,
      amount_minor,
      currency,
      reference,
      created_at: new Date(nowMs).toISOString(),
      seq: 1,
      createdAtMs: nowMs,
    };
    company.payments.push(payment);
    const list = company.paymentsByRef.get(reference) ?? [];
    list.push(payment);
    company.paymentsByRef.set(reference, list);
    this.emitChange(cc, 'payment', payment.payment_id, 1);
    const invoice = this.write(cc, 'invoice', invoice_id, inv, (d) => {
      d.status = 'PAID';
      d.open_amount_minor = 0;
    });
    const { createdAtMs: _, ...publicPayment } = payment;
    return { status: 201, body: { payment: publicPayment, invoice } };
  }

  /** A change "via another channel" (an accountant editing SAP directly). */
  patchVendor(
    cc: string,
    id: string,
    patch: Partial<Pick<Vendor, 'name' | 'bank_account' | 'payment_terms_days' | 'blocked'>>,
    delayOverrideMs?: number,
  ): Vendor | undefined {
    const v = this.company(cc).vendors.get(id);
    if (!v) return undefined;
    return this.write(
      cc,
      'vendor',
      id,
      v,
      (d) => {
        if (patch.name !== undefined) d.name = patch.name;
        if (patch.bank_account !== undefined) d.bank_account = patch.bank_account;
        if (patch.payment_terms_days !== undefined) d.payment_terms_days = patch.payment_terms_days;
        if (patch.blocked !== undefined) d.blocked = patch.blocked;
      },
      delayOverrideMs,
    );
  }

  createInvoices(cc: string, opts: { count: number; amount_minor?: number; vendor_id?: string }): string[] {
    const company = this.company(cc);
    const at = new Date().toISOString();
    const nowMs = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < opts.count; i++) {
      company.invoiceSeq += 1;
      const vendor = opts.vendor_id ?? vendorId(this.prng.int(1, Math.max(1, company.vendors.size)));
      const inv = makeInvoice(this.prng, cc, company.invoiceSeq, vendor, at, opts.amount_minor);
      company.invoices.set(inv.invoice_id, this.versioned(inv, nowMs));
      ids.push(inv.invoice_id);
    }
    return ids;
  }
}

export { invoiceId };
