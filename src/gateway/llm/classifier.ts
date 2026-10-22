import type { GatewayConfig } from '../../shared/config.js';
import { AnthropicClassifier } from './anthropic-classifier.js';
import { FakeClassifier } from './fake-classifier.js';
import type { NormalizedInput } from './normalize.js';
import type { ClassificationResult } from './taxonomy.js';

export interface Classifier {
  /** The model REQUESTED (part of the cache key). */
  readonly model: string;
  /** Any edit to the prompt text MUST bump this (part of the cache key). */
  readonly promptVersion: string;
  /** `modelServed` is the model that actually answered (it can differ under server-side fallbacks). */
  classify(
    input: NormalizedInput,
    signal: AbortSignal,
  ): Promise<{ result: ClassificationResult; modelServed: string }>;
}

/** LLM-lane errors: the LLM has no external side effect, so there is no "ambiguous" kind (never UNKNOWN). */
export class ClassifierError extends Error {
  constructor(
    readonly kind: 'retryable' | 'permanent' | 'invalid_output',
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClassifierError';
  }
}

/** A14: the deterministic fake by default; Claude when LLM_PROVIDER=anthropic (or ANTHROPIC_API_KEY is set). */
export function createClassifier(config: GatewayConfig, timeoutMs = 20_000): Classifier {
  if (config.llm.provider === 'anthropic') {
    return new AnthropicClassifier({ ...(config.llm.model ? { model: config.llm.model } : {}), timeoutMs });
  }
  return new FakeClassifier();
}
