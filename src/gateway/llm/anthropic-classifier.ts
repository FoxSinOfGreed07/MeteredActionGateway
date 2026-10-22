import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { canonicalJson } from '../../shared/canonical-json.js';
import { sha256Hex } from '../../shared/hash.js';
import { type Classifier, ClassifierError } from './classifier.js';
import type { NormalizedInput } from './normalize.js';
import { CATEGORIES, type ClassificationResult, ClassificationSchema } from './taxonomy.js';

export const PROMPT_VERSION = 'invoice-line-v1';
export const PROMPT_V1 = `You classify one line item from a vendor invoice into exactly one expense category.
Categories: ${CATEGORIES.join(', ')}.
The user message is a JSON object with the line's description and optional amount (minor units, INR) and vendor id.
Choose the single best category; use OTHER only when none fits. Confidence is your probability (0 to 1) that the
category is correct. Rationale: one short sentence (max 200 characters).`;
/** Bump PROMPT_VERSION whenever PROMPT_V1 changes — a unit test checks this hash. */
export const PROMPT_V1_SHA256 = sha256Hex(PROMPT_V1);

/**
 * Claude adapter (A14). Notes from the claude-api skill:
 * - default model claude-opus-5 (LLM_MODEL overrides; a cheaper model is the operator's cost/quality call);
 * - effort 'low' (classification is a low-effort route); no temperature (sampling params are rejected on
 *   current Opus models) — determinism comes from the content-hash cache, which is Constraint 3's point;
 * - structured output via messages.parse + zod; refusals checked before reading the output;
 * - server-side fallbacks ("default") enabled; the model that actually answered is recorded (model_served);
 * - maxRetries 0: the lane owns retry policy, like the ERP connector.
 */
export class AnthropicClassifier implements Classifier {
  readonly model: string;
  readonly promptVersion = PROMPT_VERSION;
  private readonly client: Anthropic;

  constructor(opts: { model?: string; timeoutMs: number }) {
    this.model = opts.model ?? 'claude-opus-5';
    this.client = new Anthropic({ maxRetries: 0, timeout: opts.timeoutMs });
  }

  async classify(
    input: NormalizedInput,
    signal: AbortSignal,
  ): Promise<{ result: ClassificationResult; modelServed: string }> {
    let res: Awaited<ReturnType<typeof this.client.beta.messages.parse>>;
    try {
      res = await this.client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: 2048,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: PROMPT_V1,
          messages: [{ role: 'user', content: canonicalJson(input) }],
          output_config: { effort: 'low', format: betaZodOutputFormat(ClassificationSchema) },
        },
        { signal },
      );
    } catch (err) {
      throw mapError(err);
    }
    if (res.stop_reason === 'refusal')
      throw new ClassifierError('permanent', 'refused', 'the model declined to classify');
    const parsed = res.parsed_output as ClassificationResult | null | undefined;
    if (!parsed)
      throw new ClassifierError(
        'invalid_output',
        'unparseable',
        `no parseable output (stop_reason ${res.stop_reason})`,
      );
    return { result: parsed, modelServed: res.model };
  }
}

/** Most specific first: in the TS SDK APIConnectionError is a subclass of APIError. */
function mapError(err: unknown): ClassifierError {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Anthropic.RateLimitError) return new ClassifierError('retryable', 'rate_limited', msg);
  if (err instanceof Anthropic.APIConnectionError) return new ClassifierError('retryable', 'connection', msg);
  if (err instanceof Anthropic.InternalServerError)
    return new ClassifierError('retryable', 'server_error', msg);
  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError
  ) {
    return new ClassifierError('permanent', `http_${err.status}`, msg);
  }
  if (err instanceof Anthropic.APIError) {
    return typeof err.status === 'number' && err.status >= 500
      ? new ClassifierError('retryable', `http_${err.status}`, msg)
      : new ClassifierError('permanent', `http_${err.status ?? 'unknown'}`, msg);
  }
  // Aborts / timeouts / unknown: retrying a classification has no side effect.
  return new ClassifierError('retryable', 'unknown', msg);
}
