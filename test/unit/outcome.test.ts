import { describe, expect, it } from 'vitest';
import { classifySendError, classifySendResponse, parseRetryAfter } from '../../src/gateway/erp/outcome.js';

const h = (o: Record<string, string> = {}) => new Headers(o);
const netErr = (code: string, msg = 'fetch failed') =>
  Object.assign(new TypeError(msg), { cause: Object.assign(new Error(code), { code }) });

describe('outcome taxonomy (A8)', () => {
  it.each([
    [201, {}, { kind: 'committed' }],
    [200, {}, { kind: 'committed' }],
    [429, { 'retry-after': '3' }, { kind: 'retryable', reason: 'rate_limited', retryAfterMs: 3000 }],
    [429, {}, { kind: 'retryable', reason: 'rate_limited' }],
    [503, { 'retry-after': '1' }, { kind: 'retryable', reason: 'unavailable', retryAfterMs: 1000 }],
    [500, {}, { kind: 'ambiguous', reason: 'http_5xx' }],
    [502, {}, { kind: 'ambiguous', reason: 'http_5xx' }],
    [504, {}, { kind: 'ambiguous', reason: 'http_5xx' }],
  ] as const)('HTTP %i → %j', (status, headers, expected) => {
    expect(classifySendResponse(status, h(headers), {})).toMatchObject(expected);
  });

  it('409 INVOICE_ALREADY_PAID → permanent, passing the invoice through in details', () => {
    const body = { code: 'INVOICE_ALREADY_PAID', message: 'paid', invoice: { status: 'PAID' } };
    expect(classifySendResponse(409, h(), body)).toEqual({
      kind: 'permanent',
      code: 'INVOICE_ALREADY_PAID',
      message: 'paid',
      details: body,
      httpStatus: 409,
    });
  });

  it('422 AMOUNT_MISMATCH → permanent; 401/403 → ERP_AUTH; bare 4xx → HTTP_<status>', () => {
    expect(classifySendResponse(422, h(), { code: 'AMOUNT_MISMATCH' })).toMatchObject({
      kind: 'permanent',
      code: 'AMOUNT_MISMATCH',
    });
    expect(classifySendResponse(401, h(), {})).toMatchObject({ kind: 'permanent', code: 'ERP_AUTH' });
    expect(classifySendResponse(403, h(), {})).toMatchObject({ kind: 'permanent', code: 'ERP_AUTH' });
    expect(classifySendResponse(418, h(), null)).toMatchObject({ kind: 'permanent', code: 'HTTP_418' });
  });

  it('AbortSignal.timeout (TimeoutError) → ambiguous/timeout', () => {
    expect(
      classifySendError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    ).toMatchObject({
      kind: 'ambiguous',
      reason: 'timeout',
    });
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    '%s (connect phase) → retryable/unreachable',
    (code) => {
      expect(classifySendError(netErr(code))).toEqual({ kind: 'retryable', reason: 'unreachable' });
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'])('%s → ambiguous/connection_reset', (code) => {
    expect(classifySendError(netErr(code))).toMatchObject({ kind: 'ambiguous', reason: 'connection_reset' });
  });

  it('"other side closed" message → ambiguous/connection_reset', () => {
    expect(
      classifySendError(new TypeError('fetch failed', { cause: new Error('other side closed') })),
    ).toMatchObject({
      kind: 'ambiguous',
      reason: 'connection_reset',
    });
  });

  it('AggregateError cause (multi-address connect) is searched too', () => {
    const agg = Object.assign(
      new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })], 'agg'),
    );
    expect(classifySendError(new TypeError('fetch failed', { cause: agg }))).toMatchObject({
      kind: 'retryable',
    });
  });

  it('anything else → ambiguous/unclassified (when in doubt, UNKNOWN)', () => {
    expect(classifySendError(new Error('weird'))).toMatchObject({
      kind: 'ambiguous',
      reason: 'unclassified',
    });
  });

  it('parseRetryAfter: seconds, HTTP-date, garbage', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    const inFive = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(inFive)).toBeGreaterThan(3000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
