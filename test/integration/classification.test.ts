import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { claimNext } from '../../src/gateway/dispatch/claim.js';
import { recoverExpiredLeases } from '../../src/gateway/dispatch/recovery.js';
import { FakeClassifier } from '../../src/gateway/llm/fake-classifier.js';
import { tenantClient } from '../kit/clients.js';
import { createTenant } from '../kit/fixtures.js';
import { assertInvariants } from '../kit/invariants.js';
import { eventsOf, ledgerOf, mapLimit, newKey, waitForState } from '../kit/scenario.js';
import { type Stack, startStack } from '../kit/stack.js';

let stack: Stack;
let fake: FakeClassifier;
beforeAll(async () => {
  fake = new FakeClassifier();
  stack = await startStack({ classifier: fake, worker: true });
});
afterEach(async () => assertInvariants(stack));
afterAll(async () => stack?.stop());

async function tenant(credits = 10_000) {
  const t = await createTenant(stack.db, { credits });
  return { ...t, api: tenantClient(stack, t.apiKey) };
}
async function classify(api: ReturnType<typeof tenantClient>, description: string) {
  const r = await api.submit('classify_invoice_line', { description }, newKey());
  expect(r.status).toBe(202);
  return waitForState(stack, r.body.id, ['SUCCEEDED', 'FAILED']);
}
const cacheRows = async () =>
  Number(
    (
      await stack.db
        .selectFrom('classification_cache')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

describe('LLM classification (A11, A13, A14)', () => {
  it('miss then hit: one classifier call; captures 20 then 2 (+ release 18); same answer', async () => {
    const t = await tenant();
    const calls = fake.calls;
    const a = await classify(t.api, 'AWS hosting - Sept');
    const b = await classify(t.api, 'AWS hosting - Sept');
    expect(fake.calls - calls).toBe(1);
    expect(a.result).toMatchObject({
      category: 'IT_INFRASTRUCTURE',
      cache: { hit: false },
      model: 'fake-keyword-v1',
      prompt_version: 'invoice-line-v1',
    });
    expect(b.result).toMatchObject({ category: 'IT_INFRASTRUCTURE', cache: { hit: true } });
    expect((await ledgerOf(stack, a.id)).map((l) => [l.kind, l.amount])).toEqual([
      ['HOLD', 20],
      ['CAPTURE', 20],
    ]);
    expect((await ledgerOf(stack, b.id)).map((l) => [l.kind, l.amount])).toEqual([
      ['HOLD', 20],
      ['CAPTURE', 2],
      ['RELEASE', 18],
    ]);
    expect((await eventsOf(stack, b.id)).at(-1)?.reason).toBe('llm_cache_hit');
  });

  it('whitespace variants normalize to the same key; case is preserved (different key)', async () => {
    const t = await tenant();
    const calls = fake.calls;
    await classify(t.api, 'Slack  subscription ');
    const b = await classify(t.api, 'Slack subscription');
    expect(b.result).toMatchObject({ cache: { hit: true } });
    const c = await classify(t.api, 'SLACK SUBSCRIPTION');
    expect(c.result).toMatchObject({ cache: { hit: false } });
    expect(fake.calls - calls).toBe(2);
  });

  it('tenant-scoped: the same text for another tenant is a miss', async () => {
    const t1 = await tenant();
    const t2 = await tenant();
    await classify(t1.api, 'Freight charges Mumbai');
    const other = await classify(t2.api, 'Freight charges Mumbai');
    expect(other.result).toMatchObject({ cache: { hit: false }, category: 'LOGISTICS' });
  });

  it('a prompt version bump is a miss; the old version’s row stays', async () => {
    const t = await tenant();
    await classify(t.api, 'Office rent October');
    const before = await cacheRows();
    const v2 = await startStack({ classifier: new FakeClassifier('invoice-line-v2'), worker: true });
    try {
      // a fresh stack has its own DB; prove the key differs by computing both keys directly instead
      const { cacheKey } = await import('../../src/gateway/llm/classification-cache.js');
      const input = { description: 'Office rent October' };
      const k1 = cacheKey({
        tenantId: t.id,
        input,
        model: 'fake-keyword-v1',
        promptVersion: 'invoice-line-v1',
      });
      const k2 = cacheKey({
        tenantId: t.id,
        input,
        model: 'fake-keyword-v1',
        promptVersion: 'invoice-line-v2',
      });
      expect(k1).not.toBe(k2);
      expect(
        await stack.db
          .selectFrom('classification_cache')
          .select('prompt_version')
          .where('cache_key', '=', k1)
          .executeTakeFirst(),
      ).toEqual({
        prompt_version: 'invoice-line-v1',
      });
      expect(await cacheRows()).toBe(before);
    } finally {
      await v2.stop();
    }
  });

  it('20 parallel submits with the same content → one cache row, one answer, ≤ 1 call in-process', async () => {
    const t = await tenant();
    const calls = fake.calls;
    const ids = await mapLimit(Array.from({ length: 20 }), 20, async () => {
      const r = await t.api.submit('classify_invoice_line', { description: 'Toner cartridges x4' }, newKey());
      return r.body.id as string;
    });
    const rows = await Promise.all(ids.map((id) => waitForState(stack, id, 'SUCCEEDED')));
    expect(new Set(rows.map((r) => (r.result as { category: string }).category))).toEqual(
      new Set(['OFFICE_SUPPLIES']),
    );
    expect(fake.calls - calls).toBeLessThanOrEqual(1);
    const misses = rows.filter((r) => !(r.result as { cache: { hit: boolean } }).cache.hit);
    expect(misses.length).toBe(1); // exactly one action caused the call and pays the full price
  });

  it('stored answers are immutable', async () => {
    await expect(sql`UPDATE classification_cache SET model = 'x'`.execute(stack.db)).rejects.toThrow(
      /append-only/,
    );
  });

  it('retryable provider errors → retried (retry_count 2) then SUCCEEDED; permanent → FAILED with HOLD + RELEASE', async () => {
    const t = await tenant();
    fake.failNext(2, 'retryable');
    const ok = await classify(t.api, 'Consulting fees Q3');
    expect(ok.state).toBe('SUCCEEDED');
    expect(ok.retry_count).toBe(2);

    fake.failNext(1, 'permanent', 'refused');
    const bad = await classify(t.api, 'Mystery line item 42');
    expect(bad.state).toBe('FAILED');
    expect(bad.failure_code).toBe('llm_failed:refused');
    expect((await ledgerOf(stack, bad.id)).map((l) => l.kind)).toEqual(['HOLD', 'RELEASE']);
  });

  it('never UNKNOWN: an expired lease on the LLM lane goes back to QUEUED', async () => {
    const t = await tenant();
    await stack.worker.stop();
    try {
      const r = await t.api.submit(
        'classify_invoice_line',
        { description: 'Hotel Bengaluru 2 nights' },
        newKey(),
      );
      await claimNext(stack.ctx, { id: 'llm', lease_ms: 10 }, 'crashed');
      await new Promise((res) => setTimeout(res, 30));
      const { requeued, unknown } = await recoverExpiredLeases(stack.ctx);
      expect(requeued).toContain(r.body.id);
      expect(unknown).not.toContain(r.body.id);
    } finally {
      await stack.worker.start();
    }
    const t2 = await waitForState(
      stack,
      (
        await stack.db
          .selectFrom('actions')
          .select('id')
          .where('tenant_id', '=', t.id)
          .executeTakeFirstOrThrow()
      ).id,
      'SUCCEEDED',
    );
    expect((await eventsOf(stack, t2.id)).map((e) => e.reason)).toContain('lease_expired_requeue');
  });
});
