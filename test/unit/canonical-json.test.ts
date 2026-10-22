import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/shared/canonical-json.js';

describe('canonicalJson', () => {
  it('is independent of key insertion order, recursively', () => {
    const a = { b: 1, a: { y: [3, { q: 1, p: 2 }], x: 'z' } };
    const b = { a: { x: 'z', y: [3, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":"z","y":[3,{"p":2,"q":1}]},"b":1}');
  });

  it('keeps array order and drops undefined object values', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('rejects non-finite numbers and functions', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });
});
