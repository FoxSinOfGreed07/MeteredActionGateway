import type { Stack } from './stack.js';

// biome-ignore lint/suspicious/noExplicitAny: test responses are asserted structurally
export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

// biome-ignore lint/suspicious/noExplicitAny: test responses are asserted structurally
async function call<T = any>(
  stack: Stack,
  path: string,
  init: RequestInit & { viaHttp?: boolean } = {},
): Promise<ApiResponse<T>> {
  const { viaHttp, ...rest } = init;
  const res = viaHttp ? await fetch(`${stack.api.url}${path}`, rest) : await stack.api.request(path, rest);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, headers: res.headers, body: body as T };
}

export function tenantClient(stack: Stack, apiKey: string, defaults: { viaHttp?: boolean } = {}) {
  const auth = { authorization: `Bearer ${apiKey}` };
  return {
    submit(actionType: string, payload: unknown, idempotencyKey: string, opts: { viaHttp?: boolean } = {}) {
      return call(stack, '/v1/actions', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ action_type: actionType, payload }),
        viaHttp: opts.viaHttp ?? defaults.viaHttp,
      });
    },
    getAction(id: string) {
      return call(stack, `/v1/actions/${id}`, { headers: auth, viaHttp: defaults.viaHttp });
    },
    listActions(query = '') {
      return call(stack, `/v1/actions${query}`, { headers: auth, viaHttp: defaults.viaHttp });
    },
    wallet() {
      return call(stack, '/v1/wallet', { headers: auth, viaHttp: defaults.viaHttp });
    },
    ledger() {
      return call(stack, '/v1/wallet/ledger', { headers: auth, viaHttp: defaults.viaHttp });
    },
    vendor(id: string) {
      return call(stack, `/v1/erp/vendors/${id}`, { headers: auth, viaHttp: defaults.viaHttp });
    },
    invoice(id: string) {
      return call(stack, `/v1/erp/invoices/${id}`, { headers: auth, viaHttp: defaults.viaHttp });
    },
    raw(path: string, init: RequestInit = {}) {
      return call(stack, path, {
        ...init,
        headers: { ...auth, ...(init.headers ?? {}) },
        viaHttp: defaults.viaHttp,
      });
    },
  };
}

export function opsClient(stack: Stack, apiKey = stack.ctx.config.ops.apiKey) {
  const auth = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  return {
    queue() {
      return call(stack, '/v1/ops/queue', { headers: auth });
    },
    reconcile(force = false) {
      return call(stack, '/v1/ops/reconcile', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ force }),
      });
    },
    grant(tenantId: string, amount: number, reason = 'test') {
      return call(stack, `/v1/ops/tenants/${tenantId}/grant`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ amount, reason }),
      });
    },
  };
}
