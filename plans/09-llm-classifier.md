# Step 09: LLM classification (content-hash cache, model and prompt versioning)

- **Goal:** a metered `classify_invoice_line` action that is **deterministic at the boundary**. The same tenant, content, model and prompt version always return the same stored answer, and every stored answer records the model and prompt version that produced it.
  - Default provider: a deterministic fake.
  - Optional provider: a Claude adapter, switched on by `ANTHROPIC_API_KEY`.
  - Cache hits capture a discounted price, which is hold-and-capture with capture < hold.
- **Depends on:** 06 (lanes, dispatcher, settlement). The `llm` lane already exists from the seed.
- **Decisions applied:** A13 (key composition and tenant scope), A14 (fake by default), A11 (20 / 20 / 2 pricing), D3 (partial capture), I12.
- **Estimate:** ~1.5 h (plus ~30 min for the optional Claude adapter).
- **No scenario tests this step.** Constraint 3 governs it. Keep it small: in the 48 h plan this is the **first thing to cut** after A17.

## Deliverables
- `src/gateway/llm/taxonomy.ts`: `CATEGORIES` (as a const tuple) and `TASK = 'invoice_line_category'`, `SCHEMA_VERSION = 1`
- `src/gateway/llm/normalize.ts`: `normalizeInput(payload)` → `{ description, amount_minor?, currency?, vendor_id? }`, with the description trimmed, whitespace collapsed to single spaces and Unicode NFC applied. Case is preserved.
- `src/gateway/llm/classifier.ts`: the `Classifier` interface and `createClassifier(config)`
- `src/gateway/llm/fake-classifier.ts`
- `src/gateway/llm/anthropic-classifier.ts` (optional; see below)
- `src/gateway/llm/classification-cache.ts`: `cacheKey()`, `getCached()`, `putIfAbsent()`
- `src/gateway/dispatch/executors/classify-invoice-line.ts`
- `test/integration/classification.test.ts`

## Contracts
```ts
const CATEGORIES = ['IT_INFRASTRUCTURE','SOFTWARE_SUBSCRIPTIONS','PROFESSIONAL_SERVICES','TRAVEL',
  'OFFICE_SUPPLIES','UTILITIES','RENT','MARKETING','LOGISTICS','RAW_MATERIALS','OTHER'] as const;

interface ClassificationResult {
  category: typeof CATEGORIES[number];
  confidence: number;            // 0..1
  rationale: string;             // ≤ 200 chars
}
interface Classifier {
  readonly model: string;          // the model *requested*, e.g. 'fake-keyword-v1' or the configured Claude model
  readonly promptVersion: string;  // e.g. 'invoice-line-v1'
  classify(input: NormalizedInput, signal: AbortSignal): Promise<{ result: ClassificationResult; modelServed: string }>;
}
```

**Cache key (A13):**
```ts
cacheKey = sha256Hex(canonicalJson({
  tenant_id, task: TASK, schema_version: SCHEMA_VERSION,
  input: normalizeInput(payload), model: classifier.model, prompt_version: classifier.promptVersion,
}))
```

**The stored row** goes in `classification_cache` (immutable; §5):
- `cache_key`, `tenant_id`, `input` (the normalized input)
- `result`, which is `{ ...ClassificationResult, model_served }`
- `model` (requested), `prompt_version`, `source_action_id`

**The action's `result`:**
```json
{ "category": "IT_INFRASTRUCTURE", "confidence": 0.9, "rationale": "…",
  "cache": { "hit": true, "key": "<sha256>", "created_at": "…", "source_action_id": "…" },
  "model": "fake-keyword-v1", "model_served": "fake-keyword-v1", "prompt_version": "invoice-line-v1" }
```

## Executor (`classify-invoice-line.ts`)
1. `input = normalizeInput(action.payload)`, then `key = cacheKey(...)`.
2. **Cache hit** (`getCached(key)`): `markSucceeded(action, { result: {..., cache.hit: true}, capture: price.cache_hit_capture_amount (2), via: 'response' })`. `settleSuccess` captures 2 and releases 18 (reason `release:unused_hold`).
3. **Miss.** Run an in-process singleflight on `key` around the classifier call:
   1. `{result, modelServed} = await classifier.classify(input, AbortSignal.timeout(lane.request_timeout_ms))`
   2. `putIfAbsent(row)` = `INSERT … ON CONFLICT (cache_key) DO NOTHING`
   3. `stored = getCached(key)`. **First writer wins.** If a concurrent worker stored a different answer first, we return *its* answer, so there's exactly one answer per key forever (I12).
   4. `markSucceeded(..., capture: price.capture_amount (20))`, with `cache.hit` set to false only if *our* insert won.
4. **Errors.** LLM-lane actions **never** enter UNKNOWN, because a repeated classification has no external side effect.
   - **Retryable** (rate limit, 5xx/overloaded, connection error, timeout): `requeueRetryable`.
   - **After `llm.maxRetries` (5) retries:** `markFailed(code 'llm_unavailable')`.
   - **Permanent** (bad request, auth, permission, not found, refusal, unparseable output after 1 retry): `markFailed(code 'llm_failed:<kind>')`.
   - In every failure case the hold is released (S8 semantics carry over).

## Fake classifier (`fake-classifier.ts`), the default
- `model = 'fake-keyword-v1'`, `promptVersion = 'invoice-line-v1'`.
- Ordered keyword rules on the lower-cased description, first match wins:
  - `aws|azure|gcp|hosting|server|cloud` → IT_INFRASTRUCTURE
  - `license|subscription|saas|slack|github` → SOFTWARE_SUBSCRIPTIONS
  - `consult|legal|audit|advisory` → PROFESSIONAL_SERVICES
  - `flight|hotel|cab|travel` → TRAVEL
  - `paper|stationery|toner` → OFFICE_SUPPLIES
  - `electricity|water|internet|broadband` → UTILITIES
  - `rent|lease` → RENT
  - `ads|campaign|marketing` → MARKETING
  - `freight|courier|shipping` → LOGISTICS
  - `steel|cement|resin|raw` → RAW_MATERIALS
  - otherwise OTHER
- `confidence = 0.6 + (parseInt(sha256Hex(description).slice(0,4),16) % 36) / 100`, which is deterministic.
- `rationale = 'matched keyword "<kw>"'`, `modelServed = model`.
- Expose `calls` (a counter) for tests.

## Claude adapter (`anthropic-classifier.ts`), optional
**Load the `claude-api` skill before writing this file** (SDK usage must come from its docs, not memory). Notes taken from it while planning (verify while implementing):
- **SDK:** `@anthropic-ai/sdk`, created with `new Anthropic({ maxRetries: 0, timeout: lane.request_timeout_ms })`. Set `maxRetries: 0` so the **lane** owns retry policy, the same rule as the ERP connector.
- **Model:** `LLM_MODEL` env, default **`claude-opus-5`** (the skill's default). Choosing a cheaper model (for example `claude-haiku-4-5`) is a cost/quality call for *you*, not something the code decides. It's one env var.
  - **Use `output_config.effort: 'low'`.** Classification is the textbook low-effort route.
  - **No `temperature`:** sampling parameters are rejected on current Opus models. Determinism comes from the content-hash cache, which is exactly the point of Constraint 3.
- **Structured output:** `client.messages.parse({ model, max_tokens: 2048, system: PROMPT_V1, messages: [{role:'user', content: canonicalJson(input)}], output_config: { effort: 'low', format: zodOutputFormat(ClassificationSchema) } })`, with `zodOutputFormat` imported from `@anthropic-ai/sdk/helpers/zod`.
  - `ClassificationSchema` is `z.object({ category: z.enum(CATEGORIES), confidence: z.number().min(0).max(1), rationale: z.string().max(200) })`.
  - If `response.parsed_output` is null, the output is invalid: retry once, then fail it as permanent.
- **Refusals:** check `response.stop_reason === 'refusal'` *before* reading the output, and treat it as permanent `llm_failed:refused`.
  - The skill recommends opting into server-side fallbacks (`fallbacks: "default"` with beta `server-side-fallback-2026-07-01`) by default for `claude-opus-5`. If the beta `parse` path supports it, enable it and **record `response.model` as `model_served`**: the cache key keeps the *requested* model, and the row records which model actually answered.
  - If combining it with `parse` isn't documented, skip fallbacks and say so in the README's "what we cut".
- **Error mapping**, most specific first. In the TS SDK, `APIConnectionError` is a subclass of `APIError`, so check it first:
  - `Anthropic.RateLimitError` → retryable
  - `Anthropic.APIConnectionError` → retryable
  - `Anthropic.InternalServerError` → retryable (≥ 500, including 529 overloaded)
  - `Anthropic.BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError` → permanent
  - other `Anthropic.APIError` → retryable if `status >= 500`, otherwise permanent
  - a timeout (abort) → retryable
- **Prompt:** keep `PROMPT_V1` as a const string in the file, and `promptVersion = 'invoice-line-v1'`. Any edit to the prompt text **must** bump the version. Add a unit test that fails if the prompt's hash changes without a version bump (store the hash next to the version).
- **Provider selection** (`createClassifier`): `LLM_PROVIDER` env (`fake` or `anthropic`). If it's unset, use `anthropic` when `ANTHROPIC_API_KEY` is set, otherwise `fake`. **Tests always force `fake`.**

## Tests (`test/integration/classification.test.ts`, fake provider)
| Test | Assert |
|---|---|
| Miss then hit (different idempotency keys, same content) | the first: SUCCEEDED, `cache.hit = false`, CAPTURE 20; the second: `cache.hit = true`, CAPTURE 2 + RELEASE 18; `fake.calls === 1`; both have an identical category |
| Whitespace variants (`"AWS  hosting "` vs `"AWS hosting"`) | same key → a hit |
| Case is preserved | `"aws"` vs `"AWS"` → different keys (a documented choice) |
| Tenant scope | tenant B with the same content → a miss (`fake.calls === 2`) |
| Prompt version bump | a classifier with `promptVersion 'invoice-line-v2'` → a miss; the v1 row is still there |
| Concurrency | 20 parallel submits with the same content → exactly one `classification_cache` row; every action has the same category; `fake.calls ≤ 2` (only cross-worker races can double-call; single-process singleflight → 1) |
| Immutability | `UPDATE classification_cache` → error |
| Provider failure | a fake that throws a retryable error 2×, then succeeds → SUCCEEDED, `retry_count = 2`; one that always throws a permanent error → FAILED, HOLD + RELEASE, no CAPTURE |
| Never UNKNOWN | a recovery sweep on an LLM action whose lease expired → QUEUED, not UNKNOWN |
| Ledger | `verifySettlements` = [] |

## Done when
- [ ] Tests green, and every earlier test still green.
- [ ] `curl` against compose with `classify_invoice_line` and `{"description":"AWS hosting - Sept"}` → SUCCEEDED, category IT_INFRASTRUCTURE. A second identical submit (new key) → `cache.hit: true`, and the wallet is charged 2.
- [ ] Commit `step 09: LLM classification`.
