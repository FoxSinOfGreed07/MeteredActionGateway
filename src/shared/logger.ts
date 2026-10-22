import { type Logger, pino } from 'pino';

export type { Logger };

let root: Logger | undefined;

function rootLogger(): Logger {
  if (!root) {
    const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY && !process.env.VITEST;
    root = pino({
      level: process.env.LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
      ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
    });
  }
  return root;
}

export function createLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger().child({ component, ...bindings });
}
