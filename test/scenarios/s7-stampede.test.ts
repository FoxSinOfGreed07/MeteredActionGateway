/**
 * Scenario 7 — Platform
 * Situation: 1,000 agents request the same vendor record at the moment its cache expires.
 * Expected:  one upstream read; everyone else is served the coalesced result.
 */
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/gateway/api/app.js';
import { assertInvariants } from '../kit/invariants.js';
import { type ScenarioTenant, tenantWithInvoices } from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';

let stack: Stack;
let t: ScenarioTenant;
beforeAll(async () => {
  stack = await startStack({
    mockErp: { config: { rate_limit_rps: 10_000, rate_limit_burst: 10_000 } },
    lanes: [
      { id: 'sap-main', kind: 'erp', request_timeout_ms: 20_000, lease_ms: 60_000 },
      { id: 'llm', kind: 'llm' },
    ],
    // Coalescing waits must outlast the injected 300 ms ERP latency even after time scaling.
    config: { cache: { coalesce: { leaseMs: 50_000, waitMs: 30_000, pollMs: 250 } } },
    worker: true,
  });
  t = await tenantWithInvoices(stack, { credits: 0, invoices: 0 });
});
afterEach(async () => {
  await stack.mockErp!.admin.clearFaults();
  await assertInvariants(stack);
});
afterAll(async () => stack?.stop());

const VENDOR_ROUTE = 'GET /companies/:cc/vendors/:id';

/** Cache it, then expire it (deleting the entry is the same as TTL expiry), and slow the ERP read down. */
async function expireAndSlow(vendor: string) {
  expect((await t.api.vendor(vendor)).status).toBe(200);
  await stack.redis.del(stack.ctx.keys.cacheEntry('sap-main', t.companyCode, 'vendor', vendor));
  await stack.mockErp!.admin.addFault({
    mode: 'latency',
    latency_ms: 300,
    match: { method: 'GET', path: '/companies/*/vendors/*' },
  });
  await stack.mockErp!.admin.resetStats();
}

function sources(bodies: { meta: { source: string } }[]) {
  const out: Record<string, number> = {};
  for (const b of bodies) out[b.meta.source] = (out[b.meta.source] ?? 0) + 1;
  return out;
}

describe('S7: stampede at expiry', () => {
  it('1,000 concurrent requests → exactly one ERP read; all 200 with the same seq', async () => {
    await expireAndSlow('V-0003');
    const res = await Promise.all(
      Array.from({ length: 1000 }, () =>
        stack.api.request('/v1/erp/vendors/V-0003', { headers: { authorization: `Bearer ${t.apiKey}` } }),
      ),
    );
    expect(res.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(res.map((r) => r.json()))) as {
      meta: { seq: number; source: string };
    }[];
    expect(new Set(bodies.map((b) => b.meta.seq)).size).toBe(1);
    const stats = await stack.mockErp!.admin.stats();
    expect(stats.reads.vendor[`${t.companyCode}/V-0003`]).toBe(1);
    const s = sources(bodies);
    expect(s.erp).toBe(1);
    expect((s.erp ?? 0) + (s.coalesced ?? 0) + (s.cache ?? 0)).toBe(1000);
  });

  it('real HTTP: 200 concurrent sockets → one ERP read', async () => {
    await expireAndSlow('V-0004');
    const dispatcher = new Agent({ connections: 256 });
    try {
      const res = await Promise.all(
        Array.from({ length: 200 }, () =>
          undiciFetch(`${stack.api.url}/v1/erp/vendors/V-0004`, {
            headers: { authorization: `Bearer ${t.apiKey}` },
            dispatcher,
          }),
        ),
      );
      expect(res.every((r) => r.status === 200)).toBe(true);
      await Promise.all(res.map((r) => r.arrayBuffer()));
    } finally {
      await dispatcher.close();
    }
    expect((await stack.mockErp!.admin.stats()).reads.vendor[`${t.companyCode}/V-0004`]).toBe(1);
  });

  it('two API processes (separate in-process caches) → still one ERP read (Redis lease)', async () => {
    await expireAndSlow('V-0006');
    const other = createApp(stack.ctx); // a second API instance: its own single-flight map, same Redis
    const hit = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }) =>
      Promise.resolve(
        app.request('/v1/erp/vendors/V-0006', { headers: { authorization: `Bearer ${t.apiKey}` } }),
      );
    const res = await Promise.all(Array.from({ length: 1000 }, (_, i) => hit(i % 2 ? other : stack.api.app)));
    const bad = res.filter((r) => r.status !== 200);
    expect(bad.length, bad[0] ? `${bad[0].status} ${await bad[0].text()}` : '').toBe(0);
    expect((await stack.mockErp!.admin.stats()).reads.vendor[`${t.companyCode}/V-0006`]).toBe(1);
  });

  it('if the single read is rate-limited, all 1,000 get 503 — and the ERP saw ONE request, not 1,000', async () => {
    expect((await t.api.vendor('V-0007')).status).toBe(200);
    await stack.redis.del(stack.ctx.keys.cacheEntry('sap-main', t.companyCode, 'vendor', 'V-0007'));
    await stack.mockErp!.admin.addFault({
      mode: 'status_429',
      match: { method: 'GET', path: '/companies/*/vendors/*' },
    });
    await stack.mockErp!.admin.resetStats();
    const res = await Promise.all(
      Array.from({ length: 1000 }, () =>
        stack.api.request('/v1/erp/vendors/V-0007', { headers: { authorization: `Bearer ${t.apiKey}` } }),
      ),
    );
    expect(res.every((r) => r.status === 503)).toBe(true);
    expect((await stack.mockErp!.admin.stats()).requests_by_route[VENDOR_ROUTE]).toBe(1);
    await stack.redis.del(stack.ctx.keys.cooldown('sap-main'), stack.ctx.keys.cool429('sap-main'));
  });
});
