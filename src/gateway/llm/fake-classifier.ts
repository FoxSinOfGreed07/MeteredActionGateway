import { sha256Hex } from '../../shared/hash.js';
import { type Classifier, ClassifierError } from './classifier.js';
import type { NormalizedInput } from './normalize.js';
import type { Category, ClassificationResult } from './taxonomy.js';

const RULES: [RegExp, Category][] = [
  [/\b(aws|azure|gcp|hosting|server|cloud)\b/, 'IT_INFRASTRUCTURE'],
  [/\b(license|licence|subscription|saas|slack|github)\b/, 'SOFTWARE_SUBSCRIPTIONS'],
  [/\b(consult\w*|legal|audit|advisory)\b/, 'PROFESSIONAL_SERVICES'],
  [/\b(flight|hotel|cab|travel)\b/, 'TRAVEL'],
  [/\b(paper|stationery|toner)\b/, 'OFFICE_SUPPLIES'],
  [/\b(electricity|water|internet|broadband)\b/, 'UTILITIES'],
  [/\b(rent|lease)\b/, 'RENT'],
  [/\b(ads|campaign|marketing)\b/, 'MARKETING'],
  [/\b(freight|courier|shipping)\b/, 'LOGISTICS'],
  [/\b(steel|cement|resin|raw)\b/, 'RAW_MATERIALS'],
];

/**
 * A14: deterministic keyword classifier — the default and the only provider tests use. Same boundary as the
 * Claude adapter (cache key, model + prompt version recorded). `calls` and `failNext` exist for tests.
 */
export class FakeClassifier implements Classifier {
  readonly model = 'fake-keyword-v1';
  calls = 0;
  private failures: { kind: ClassifierError['kind']; code: string }[] = [];

  constructor(readonly promptVersion = 'invoice-line-v1') {}

  /** Test hook: make the next `n` calls fail with the given kind. */
  failNext(n: number, kind: ClassifierError['kind'] = 'retryable', code = 'fake_unavailable'): void {
    for (let i = 0; i < n; i++) this.failures.push({ kind, code });
  }

  async classify(input: NormalizedInput): Promise<{ result: ClassificationResult; modelServed: string }> {
    this.calls += 1;
    const fail = this.failures.shift();
    if (fail) throw new ClassifierError(fail.kind, fail.code, `injected ${fail.kind} failure`);
    const text = input.description.toLowerCase();
    const hit = RULES.find(([re]) => re.test(text));
    const category: Category = hit?.[1] ?? 'OTHER';
    const kw = hit ? (text.match(hit[0])?.[0] ?? '') : '';
    const confidence = 0.6 + (Number.parseInt(sha256Hex(input.description).slice(0, 4), 16) % 36) / 100;
    return {
      result: { category, confidence, rationale: hit ? `matched keyword "${kw}"` : 'no keyword matched' },
      modelServed: this.model,
    };
  }
}
