import { describe, expect, it } from 'vitest';
import { PROMPT_V1, PROMPT_V1_SHA256, PROMPT_VERSION } from '../../src/gateway/llm/anthropic-classifier.js';
import { sha256Hex } from '../../src/shared/hash.js';

// A13: a prompt edit without a version bump would silently serve old cached answers for a new prompt.
// If you change PROMPT_V1: bump PROMPT_VERSION, then update the snapshot (vitest -u).

describe('LLM prompt versioning', () => {
  it('the prompt text is pinned to its version', () => {
    expect(PROMPT_VERSION).toBe('invoice-line-v1');
    expect(sha256Hex(PROMPT_V1)).toBe(PROMPT_V1_SHA256);
    expect({ version: PROMPT_VERSION, sha256: PROMPT_V1_SHA256 }).toMatchSnapshot();
  });
});
