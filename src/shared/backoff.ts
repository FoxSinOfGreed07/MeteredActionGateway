/** min(maxMs, baseMs * 2^(attempt-1)); attempt starts at 1. */
export function expBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const a = Math.max(1, attempt);
  return Math.min(maxMs, baseMs * 2 ** Math.min(a - 1, 30));
}

/** Uniform in [ms/2, ms], never below 50ms (avoids busy loops). */
export function fullJitter(ms: number, floorMs = 50): number {
  const v = ms / 2 + Math.random() * (ms / 2);
  return Math.max(Math.min(floorMs, ms), Math.round(v));
}
