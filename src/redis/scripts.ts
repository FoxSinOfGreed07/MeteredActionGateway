import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';

const LUA_DIR = fileURLToPath(new URL('./lua/', import.meta.url));

/**
 * Loads every src/redis/lua/*.lua as an ioredis custom command. Each file declares its key count in a
 * header line: `--! keys=N`. Call them through `runScript` (typed at the call site).
 */
export function registerScripts(redis: Redis): void {
  let files: string[] = [];
  try {
    files = readdirSync(LUA_DIR).filter((f) => f.endsWith('.lua'));
  } catch {
    return;
  }
  for (const file of files) {
    const lua = readFileSync(`${LUA_DIR}${file}`, 'utf8');
    const m = /^--!\s*keys=(\d+)/m.exec(lua);
    if (!m) throw new Error(`${file}: missing "--! keys=N" header`);
    redis.defineCommand(file.replace(/\.lua$/, ''), { numberOfKeys: Number(m[1]), lua });
  }
}

type ScriptFn = (...args: (string | number)[]) => Promise<unknown>;

export async function runScript<T>(
  redis: Redis,
  name: string,
  keys: string[],
  args: (string | number)[] = [],
): Promise<T> {
  const fn = (redis as unknown as Record<string, ScriptFn | undefined>)[name];
  if (typeof fn !== 'function') throw new Error(`redis script "${name}" is not registered`);
  return (await fn.call(redis, ...keys, ...args)) as T;
}
