import type { SendOutcome } from './connector.js';

/**
 * A8 — conservative outcome taxonomy (plans/00-architecture.md §10). Only failures that PROVABLY happened
 * before the ERP could commit are retryable. When in doubt → ambiguous → UNKNOWN → lookup by reference.
 * Retrying a request that had committed is a double payment; an unnecessary UNKNOWN costs one lookup.
 */

/** Errors raised before any byte of the request reached the server (TCP connect / DNS phase). */
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
/** The connection died after the request may have been sent. */
const SOCKET_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'UND_ERR_CLOSED']);
/** Response took too long: the server may still be processing (or have committed). */
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** `Retry-After`: delta-seconds or an HTTP-date → milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

export function classifySendResponse(status: number, headers: Headers, body: unknown): SendOutcome<unknown> {
  if (status >= 200 && status < 300) return { kind: 'committed', value: body };
  // 429: the ERP refused before doing anything. Definitely not committed.
  if (status === 429) return withRetryAfter({ kind: 'retryable', reason: 'rate_limited' }, headers);
  // 503: "service unavailable" — refused before processing (assumption S6: maintenance / load shedding).
  if (status === 503) return withRetryAfter({ kind: 'retryable', reason: 'unavailable' }, headers);
  if (status >= 400 && status < 500) {
    // 4xx: the ERP processed the request and said no (validation, already paid, not found, auth). Permanent.
    const b = (typeof body === 'object' && body !== null ? body : {}) as {
      code?: unknown;
      message?: unknown;
    };
    const code =
      status === 401 || status === 403 ? 'ERP_AUTH' : typeof b.code === 'string' ? b.code : `HTTP_${status}`;
    const message = typeof b.message === 'string' ? b.message : `ERP responded ${status}`;
    return { kind: 'permanent', code, message, details: body, httpStatus: status };
  }
  // 500/502/504/other 5xx: something failed somewhere — possibly AFTER the commit (a 504 is a gateway that
  // gave up waiting on an upstream that may still be processing). Ambiguous.
  return { kind: 'ambiguous', reason: 'http_5xx', detail: `HTTP ${status}` };
}

function withRetryAfter(
  o: { kind: 'retryable'; reason: 'rate_limited' | 'unavailable' },
  headers: Headers,
): SendOutcome<never> {
  const ms = parseRetryAfter(headers.get('retry-after'));
  return ms === undefined ? o : { ...o, retryAfterMs: ms };
}

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  const queue: unknown[] = [err];
  while (queue.length && out.length < 10) {
    const e = queue.shift();
    if (e === undefined || e === null || out.includes(e)) continue;
    out.push(e);
    if (typeof e === 'object') {
      const { cause, errors } = e as { cause?: unknown; errors?: unknown };
      if (cause !== undefined) queue.push(cause);
      if (Array.isArray(errors)) queue.push(...errors);
    }
  }
  return out;
}

export function classifySendError(err: unknown): SendOutcome<never> {
  const chain = causeChain(err);
  const codes = chain
    .map((e) => (e as { code?: unknown })?.code)
    .filter((c): c is string => typeof c === 'string');
  const names = chain.map((e) => (e as { name?: unknown })?.name);
  const messages = chain.map((e) => String((e as { message?: unknown })?.message ?? ''));

  // AbortSignal.timeout() → DOMException named TimeoutError: we stopped waiting; the ERP may have committed.
  if (names.includes('TimeoutError') || codes.some((c) => TIMEOUT_CODES.has(c))) {
    return { kind: 'ambiguous', reason: 'timeout', detail: messages[0] ?? '' };
  }
  if (codes.some((c) => CONNECT_PHASE_CODES.has(c))) {
    return { kind: 'retryable', reason: 'unreachable' };
  }
  if (
    codes.some((c) => SOCKET_CODES.has(c)) ||
    messages.some((m) => /other side closed|socket hang up/i.test(m))
  ) {
    return { kind: 'ambiguous', reason: 'connection_reset', detail: codes[0] ?? messages[0] ?? '' };
  }
  return { kind: 'ambiguous', reason: 'unclassified', detail: String(err) };
}
