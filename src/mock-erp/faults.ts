import { randomUUID } from 'node:crypto';
import type { FaultMode, FaultRule } from './types.js';

interface StoredRule extends FaultRule {
  id: string;
  createdAtMs: number;
  remaining: number | null;
  regex: RegExp | null;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}$`);
}

/** Fault rules, matched per request. `*` in a path glob matches exactly one path segment. */
export class FaultStore {
  private rules: StoredRule[] = [];

  add(rule: FaultRule): StoredRule {
    const stored: StoredRule = {
      ...rule,
      id: rule.id ?? randomUUID().slice(0, 8),
      createdAtMs: Date.now(),
      remaining: rule.count ?? null,
      regex: rule.match?.path ? globToRegex(rule.match.path) : null,
    };
    this.rules = this.rules.filter((r) => r.id !== stored.id);
    this.rules.push(stored);
    return stored;
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    return this.rules.length < before;
  }

  clear(): void {
    this.rules = [];
  }

  private prune(now: number): void {
    this.rules = this.rules.filter(
      (r) => r.remaining !== 0 && (r.duration_ms === undefined || now < r.createdAtMs + r.duration_ms),
    );
  }

  list() {
    const now = Date.now();
    this.prune(now);
    return this.rules.map(({ regex: _, createdAtMs, ...r }) => ({
      ...r,
      expires_in_ms: r.duration_ms === undefined ? null : Math.max(0, createdAtMs + r.duration_ms - now),
    }));
  }

  /** First active rule of one of `modes` matching the request; consumes one use of a counted rule. */
  match(modes: readonly FaultMode[], method: string, path: string): StoredRule | undefined {
    const now = Date.now();
    this.prune(now);
    for (const r of this.rules) {
      if (!modes.includes(r.mode)) continue;
      if (r.match?.method && r.match.method !== method) continue;
      if (r.regex && !r.regex.test(path)) continue;
      if (r.probability !== undefined && Math.random() >= r.probability) continue;
      if (r.remaining !== null) r.remaining -= 1;
      return r;
    }
    return undefined;
  }
}
