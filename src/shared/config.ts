import { hostname } from 'node:os';
import { z } from 'zod';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Environment variables (plans/00-architecture.md §12). */
const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://gateway:gateway@localhost:5432/gateway'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_PREFIX: z.string().default('mag:'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),
  OPS_API_KEY: z.string().default('ops-dev-key'),
  WORKER_ID: z.string().optional(),
  MOCK_ERP_URL: z.string().default('http://localhost:4000'),
  GATEWAY_URL: z.string().default('http://localhost:3000'),
  WEBHOOK_SECRET: z.string().default('dev-webhook-secret'),
  LLM_PROVIDER: z.enum(['fake', 'anthropic', '']).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}

/** Runtime configuration. Every duration ends in `Ms`; tests scale them with `scaleDurations`. */
export interface GatewayConfig {
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  port: number;
  logLevel: string;
  workerId: string;
  ops: { apiKey: string };
  dispatcher: { idlePollMs: number; tokenWaitMaxMs: number };
  cooldown: { baseMs: number; maxMs: number };
  retry: { baseMs: number; maxMs: number };
  recovery: { intervalMs: number };
  expiry: { queuedMaxAgeMs: number; intervalMs: number };
  reconciler: {
    intervalMs: number;
    firstLookupDelayMs: number;
    confirmGapMs: number;
    maxAmbiguous: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    staleQuarantineMs: number;
    unknownAlertAfterMs: number;
    leaseMs: number;
    batchSize: number;
  };
  cache: {
    budgets: { vendorMs: number; invoiceMs: number };
    coalesce: { leaseMs: number; waitMs: number; pollMs: number };
    hwmTtlMs: number;
    readTokenWaitMs: number;
  };
  backpressure: { retryAfterS: number };
  llm: { maxRetries: number; provider: 'fake' | 'anthropic'; model: string | undefined };
}

export function defaultConfig(env: Env = loadEnv()): GatewayConfig {
  const provider: 'fake' | 'anthropic' =
    env.LLM_PROVIDER === 'fake' || env.LLM_PROVIDER === 'anthropic'
      ? env.LLM_PROVIDER
      : env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : 'fake';
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    redisPrefix: env.REDIS_PREFIX,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    workerId: env.WORKER_ID ?? `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`,
    ops: { apiKey: env.OPS_API_KEY },
    dispatcher: { idlePollMs: 200, tokenWaitMaxMs: 1000 },
    cooldown: { baseMs: 1000, maxMs: 30_000 },
    retry: { baseMs: 500, maxMs: 30_000 },
    recovery: { intervalMs: 1000 },
    expiry: { queuedMaxAgeMs: 86_400_000, intervalMs: 60_000 },
    reconciler: {
      intervalMs: 2000,
      firstLookupDelayMs: 1000,
      confirmGapMs: 2000,
      maxAmbiguous: 3,
      backoffBaseMs: 1000,
      backoffMaxMs: 60_000,
      staleQuarantineMs: 900_000,
      unknownAlertAfterMs: 900_000,
      leaseMs: 30_000,
      batchSize: 20,
    },
    cache: {
      budgets: { vendorMs: 60_000, invoiceMs: 15_000 },
      coalesce: { leaseMs: 5000, waitMs: 3000, pollMs: 25 },
      hwmTtlMs: 86_400_000,
      readTokenWaitMs: 500,
    },
    backpressure: { retryAfterS: 5 },
    llm: { maxRetries: 5, provider, model: env.LLM_MODEL },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, overrides: DeepPartial<T> | undefined): T {
  if (!overrides) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v as DeepPartial<typeof cur>) : v;
  }
  return out as T;
}

export function loadConfig(overrides?: DeepPartial<GatewayConfig>, env?: Env): GatewayConfig {
  return deepMerge(defaultConfig(env), overrides);
}

/** Multiply every `*Ms` number (recursively) by `scale`; used by scenario tests (A15). */
export function scaleDurations<T>(cfg: T, scale: number): T {
  if (!isPlainObject(cfg)) return cfg;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'number' && k.endsWith('Ms')) out[k] = Math.max(1, Math.round(v * scale));
    else if (isPlainObject(v)) out[k] = scaleDurations(v, scale);
    else out[k] = v;
  }
  return out as T;
}
