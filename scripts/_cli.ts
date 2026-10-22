/** Tiny shared helpers for the operator scripts (no dependencies). */
export const env = {
  gateway: process.env.GATEWAY_URL ?? 'http://localhost:3000',
  mockErp: process.env.MOCK_ERP_URL ?? 'http://localhost:4000',
  opsKey: process.env.OPS_API_KEY ?? 'ops-dev-key',
};

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  cyan: paint(36),
};

/** "90s", "10m", "500ms", "2000" → milliseconds. */
export function parseDuration(v: string | undefined, fallbackMs?: number): number | undefined {
  if (v === undefined) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim());
  if (!m) throw new Error(`bad duration "${v}" (use e.g. 500ms, 90s, 10m)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function http<T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}
