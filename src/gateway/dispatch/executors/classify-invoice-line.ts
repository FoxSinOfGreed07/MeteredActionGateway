import type { ClassificationRow } from '../../../db/schema.js';
import { expBackoff, fullJitter } from '../../../shared/backoff.js';
import type { ClassifyInvoiceLinePayload } from '../../actions/types/classify-invoice-line.js';
import { SingleFlight } from '../../cache/singleflight.js';
import { cacheKey, getCached, putIfAbsent } from '../../llm/classification-cache.js';
import { ClassifierError } from '../../llm/classifier.js';
import { normalizeInput } from '../../llm/normalize.js';
import { getPrice } from '../../wallet/pricing.js';
import { markFailed, markSucceeded, requeueRetryable } from '../settle.js';
import type { ExecArgs } from './index.js';

const flights = new SingleFlight<{ row: ClassificationRow; called: boolean }>();

/**
 * classify_invoice_line (A11, A13): content-hash cache first. A hit captures the discounted price (2 of the
 * 20 held — hold-and-capture with capture < hold, D3). A miss calls the classifier once per key (in-process
 * single-flight), stores first-writer-wins, and returns the STORED answer, so there is exactly one answer per
 * key forever. LLM-lane actions never go UNKNOWN: a repeated classification has no external side effect.
 */
export async function executeClassifyInvoiceLine({
  ctx,
  action,
  tenant,
  lane,
  owner,
  isAbandoned,
}: ExecArgs): Promise<void> {
  const classifier = ctx.classifier;
  const input = normalizeInput(action.payload as ClassifyInvoiceLinePayload);
  const key = cacheKey({
    tenantId: tenant.id,
    input,
    model: classifier.model,
    promptVersion: classifier.promptVersion,
  });
  const price = await getPrice(ctx.db, action.action_type);

  let row: ClassificationRow;
  let causedCall = false;
  try {
    const cached = await getCached(ctx.db, key);
    if (cached) row = cached;
    else {
      const [p, leader] = flights.do(key, async () => {
        const out = await classifier.classify(input, AbortSignal.timeout(lane.request_timeout_ms));
        const won = await putIfAbsent(ctx.db, {
          key,
          tenantId: tenant.id,
          input,
          result: { ...out.result, model_served: out.modelServed },
          model: classifier.model,
          promptVersion: classifier.promptVersion,
          actionId: action.id,
        });
        const stored = await getCached(ctx.db, key);
        if (!stored) throw new Error(`classification ${key} missing after insert`);
        return { row: stored, called: won };
      });
      const r = await p;
      row = r.row;
      causedCall = leader && r.called;
    }
  } catch (err) {
    if (isAbandoned()) return;
    const e = err instanceof ClassifierError ? err : new ClassifierError('retryable', 'unknown', String(err));
    const retriesLeft = action.retry_count < ctx.config.llm.maxRetries;
    if ((e.kind === 'retryable' && retriesLeft) || (e.kind === 'invalid_output' && action.retry_count < 1)) {
      await requeueRetryable(ctx, action, {
        reason: `retry:llm_${e.kind === 'invalid_output' ? 'invalid_output' : 'error'}`,
        delayMs: fullJitter(
          expBackoff(action.retry_count + 1, ctx.config.retry.baseMs, ctx.config.retry.maxMs),
        ),
        leaseOwner: owner,
        details: { code: e.code, message: e.message },
      });
      return;
    }
    const code = e.kind === 'retryable' ? 'llm_unavailable' : `llm_failed:${e.code}`;
    await markFailed(ctx, action, { code, message: e.message, reason: code, leaseOwner: owner });
    return;
  }
  if (isAbandoned()) return;

  const hit = !causedCall;
  const result = row.result as Record<string, unknown>;
  await markSucceeded(ctx, action, {
    result: {
      category: result.category,
      confidence: result.confidence,
      rationale: result.rationale,
      model: row.model,
      model_served: result.model_served ?? row.model,
      prompt_version: row.prompt_version,
      cache: {
        hit,
        key,
        created_at: new Date(row.created_at).toISOString(),
        source_action_id: row.source_action_id,
      },
    },
    capture: hit ? (price.cacheHitCapture ?? price.capture) : price.capture,
    via: 'response',
    reason: hit ? 'llm_cache_hit' : 'llm_classified',
    leaseOwner: owner,
  });
}
