import type { Stats } from './stats.js';
import type { FaultRule, Invoice, MockErpConfig, Payment, Vendor } from './types.js';

/** Typed client for the mock ERP's /__admin API — used by tests AND scripts (fault injection, demo). */
export class MockAdminClient {
  constructor(readonly baseUrl: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`mock admin ${method} ${path} → ${res.status}: ${text}`);
    return parsed as T;
  }

  reset(seed?: number) {
    return this.req<{ ok: true }>('POST', '/__admin/reset', seed === undefined ? {} : { seed });
  }
  stats() {
    return this.req<Stats>('GET', '/__admin/stats');
  }
  resetStats() {
    return this.req<{ ok: true }>('POST', '/__admin/stats/reset');
  }
  addFault(rule: FaultRule) {
    return this.req<{ id: string }>('POST', '/__admin/faults', rule);
  }
  listFaults() {
    return this.req<{ faults: (FaultRule & { remaining: number | null; expires_in_ms: number | null })[] }>(
      'GET',
      '/__admin/faults',
    );
  }
  clearFaults() {
    return this.req<{ ok: true }>('DELETE', '/__admin/faults');
  }
  removeFault(id: string) {
    return this.req<{ removed: boolean }>('DELETE', `/__admin/faults/${id}`);
  }
  patchVendor(cc: string, id: string, patch: Partial<Vendor>, webhookDelayMs?: number) {
    const q = webhookDelayMs === undefined ? '' : `?webhook_delay_ms=${webhookDelayMs}`;
    return this.req<Vendor>('PATCH', `/__admin/companies/${cc}/vendors/${id}${q}`, patch);
  }
  createInvoices(cc: string, body: { count: number; amount_minor?: number; vendor_id?: string }) {
    return this.req<{ invoice_ids: string[] }>('POST', `/__admin/companies/${cc}/invoices`, body);
  }
  invoices(cc: string, filter: { status?: 'OPEN' | 'PAID'; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.limit) q.set('limit', String(filter.limit));
    return this.req<{ invoices: Invoice[] }>('GET', `/__admin/companies/${cc}/invoices?${q}`);
  }
  invoice(cc: string, id: string) {
    return this.req<Invoice>('GET', `/__admin/companies/${cc}/invoices/${id}`);
  }
  primaryPayments(cc: string, filter: { reference?: string; invoice_id?: string } = {}) {
    const q = new URLSearchParams(filter as Record<string, string>);
    return this.req<{ payments: Payment[] }>('GET', `/__admin/companies/${cc}/payments?${q}`).then(
      (r) => r.payments,
    );
  }
  getConfig() {
    return this.req<MockErpConfig>('GET', '/__admin/config');
  }
  putConfig(patch: Partial<MockErpConfig>) {
    return this.req<MockErpConfig>('PUT', '/__admin/config', patch);
  }
}
