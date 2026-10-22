import type {
  ErpConnector,
  ErpInvoice,
  ErpPayment,
  ErpVendor,
  PostPaymentRequest,
  PostPaymentResult,
  ReadResult,
  SendOutcome,
} from './connector.js';
import { ErpReadError } from './connector.js';
import { classifySendError, classifySendResponse, parseRetryAfter } from './outcome.js';

export interface ConnectorLane {
  id: string;
  base_url: string | null;
  request_timeout_ms: number;
}

/**
 * SAP-style HTTP connector. Rule (top of connector.ts): no rate limiting and no retries in here — the
 * dispatcher / reconciler / cache acquire tokens and own retry policy.
 */
export class HttpErpConnector implements ErpConnector {
  readonly laneId: string;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(lane: ConnectorLane) {
    if (!lane.base_url) throw new Error(`lane ${lane.id} has no base_url`);
    this.laneId = lane.id;
    this.base = lane.base_url.replace(/\/$/, '');
    this.timeoutMs = lane.request_timeout_ms;
  }

  async postPayment(req: PostPaymentRequest): Promise<SendOutcome<PostPaymentResult>> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/companies/${encodeURIComponent(req.companyCode)}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          invoice_id: req.invoiceId,
          amount_minor: req.amountMinor,
          currency: req.currency,
          reference: req.reference,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return classifySendError(err);
    }
    let body: unknown;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      // Headers arrived but the body didn't (or isn't JSON). A 2xx status still means the ERP says it
      // committed — trust the status, not our parser.
      if (res.ok) return { kind: 'committed', value: { payment: null, invoice: null } };
      return classifySendError(err);
    }
    return classifySendResponse(res.status, res.headers, body) as SendOutcome<PostPaymentResult>;
  }

  findPaymentsByReference(companyCode: string, reference: string): Promise<ErpPayment[]> {
    const q = new URLSearchParams({ reference });
    return this.read<{ payments: ErpPayment[] }>(
      `/companies/${encodeURIComponent(companyCode)}/payments?${q}`,
    ).then((r) => {
      if (r.status === 'not_found') return [];
      return r.data.payments ?? [];
    });
  }

  async getVendor(companyCode: string, vendorId: string): Promise<ReadResult<ErpVendor>> {
    const r = await this.read<ErpVendor>(
      `/companies/${encodeURIComponent(companyCode)}/vendors/${encodeURIComponent(vendorId)}`,
    );
    return r.status === 'ok' ? { status: 'ok', data: r.data, seq: r.data.seq } : r;
  }

  async getInvoice(companyCode: string, invoiceId: string): Promise<ReadResult<ErpInvoice>> {
    const r = await this.read<ErpInvoice>(
      `/companies/${encodeURIComponent(companyCode)}/invoices/${encodeURIComponent(invoiceId)}`,
    );
    return r.status === 'ok' ? { status: 'ok', data: r.data, seq: r.data.seq } : r;
  }

  private async read<T>(path: string): Promise<{ status: 'ok'; data: T } | { status: 'not_found' }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const o = classifySendError(err);
      const kind =
        o.kind === 'ambiguous' && o.reason === 'timeout'
          ? 'timeout'
          : o.kind === 'retryable'
            ? 'unavailable'
            : 'error';
      throw new ErpReadError(kind, `ERP read ${path} failed: ${String(err)}`);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return { status: 'not_found' };
    }
    if (res.status === 429 || res.status === 503) {
      await res.body?.cancel();
      throw new ErpReadError(
        res.status === 429 ? 'rate_limited' : 'unavailable',
        `ERP read ${path} → ${res.status}`,
        parseRetryAfter(res.headers.get('retry-after')),
        res.status,
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ErpReadError('error', `ERP read ${path} → ${res.status}`, undefined, res.status);
    }
    try {
      return { status: 'ok', data: (await res.json()) as T };
    } catch (err) {
      throw new ErpReadError('error', `ERP read ${path}: bad body (${String(err)})`);
    }
  }
}
