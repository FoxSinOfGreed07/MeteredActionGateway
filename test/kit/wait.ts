export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `predicate` returns a truthy value; throws with the last observed value on timeout. */
export async function waitFor<T>(
  predicate: () => Promise<T> | T,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      last = await predicate();
      if (last) return last as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      const shown = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${opts.message ?? ''} (last: ${shown})`);
    }
    await sleep(intervalMs);
  }
}
