import { MockAdminClient } from '../src/mock-erp/admin-client.js';
import type { FaultRule } from '../src/mock-erp/types.js';
import { c, env, parseArgs, parseDuration } from './_cli.js';

const USAGE = `
Failure injection for the mock ERP (${env.mockErp}).

  pnpm fault timeout-after-commit [--count 1] [--hang 30s]   SAP commits, then the response never arrives
  pnpm fault drop-after-commit    [--count 1]                SAP commits, then the connection is reset
  pnpm fault 500-after-commit     [--count 1]                SAP commits, then answers HTTP 500
  pnpm fault drop-before-commit   [--count 1]                connection reset, nothing committed
  pnpm fault 429 --duration 90s [--retry-after 0]            SAP answers 429 on payments
  pnpm fault 503 [--prob 0.3] [--duration 60s]               SAP answers 503 on payments
  pnpm fault latency --ms 2000 [--count N]                   slow payments (late commits if > client timeout)
  pnpm fault stale-reads --lag 10m --duration 10m            reads served from a snapshot 10 minutes old
  pnpm fault vendor-change C100 V-0001 --name "New Name" [--webhook-delay 40s]
  pnpm fault list | clear
`;

const admin = new MockAdminClient(env.mockErp);
const { positional, flags } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = positional;
const num = (k: string) => (typeof flags[k] === 'string' ? Number(flags[k]) : undefined);
const dur = (k: string) => (typeof flags[k] === 'string' ? parseDuration(flags[k] as string) : undefined);
const PAY = { method: 'POST' as const, path: '/companies/*/payments' };

function rule(r: FaultRule): FaultRule {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as FaultRule;
}

let toAdd: FaultRule | undefined;
switch (cmd) {
  case 'timeout-after-commit':
    toAdd = rule({
      mode: 'timeout_after_commit',
      match: PAY,
      count: num('count') ?? 1,
      hang_ms: dur('hang') ?? 30_000,
    });
    break;
  case 'drop-after-commit':
    toAdd = rule({ mode: 'drop_after_commit', match: PAY, count: num('count') ?? 1 });
    break;
  case '500-after-commit':
    toAdd = rule({ mode: 'error_500_after_commit', match: PAY, count: num('count') ?? 1 });
    break;
  case 'drop-before-commit':
    toAdd = rule({ mode: 'drop_before_commit', match: PAY, count: num('count') ?? 1 });
    break;
  case '429':
    toAdd = rule({
      mode: 'status_429',
      match: PAY,
      duration_ms: dur('duration') ?? 90_000,
      retry_after_s: num('retry-after') ?? 0,
    });
    break;
  case '503':
    toAdd = rule({
      mode: 'status_503',
      match: PAY,
      probability: num('prob'),
      duration_ms: dur('duration'),
      count: num('count'),
    });
    break;
  case 'latency':
    toAdd = rule({ mode: 'latency', match: PAY, latency_ms: dur('ms') ?? 2000, count: num('count') });
    break;
  case 'stale-reads':
    toAdd = rule({
      mode: 'stale_reads',
      match: { method: 'GET' },
      lag_ms: dur('lag') ?? 600_000,
      duration_ms: dur('duration') ?? 600_000,
    });
    break;
  case 'vendor-change': {
    const [cc, vendor] = rest;
    if (!cc || !vendor)
      throw new Error(
        'usage: pnpm fault vendor-change <company> <vendor> --name <name> [--webhook-delay 40s]',
      );
    const v = await admin.patchVendor(
      cc,
      vendor,
      { name: String(flags.name ?? `Renamed ${new Date().toISOString()}`) },
      dur('webhook-delay'),
    );
    console.log(
      c.green(`vendor ${cc}/${vendor} changed "via another channel" → seq ${v.seq}, name "${v.name}"`),
    );
    process.exit(0);
    break;
  }
  case 'clear':
    await admin.clearFaults();
    console.log(c.green('all faults cleared'));
    break;
  case 'list':
  case undefined:
    if (cmd === undefined) console.log(USAGE);
    break;
  default:
    console.error(c.red(`unknown command "${cmd}"`));
    console.log(USAGE);
    process.exit(1);
}
if (toAdd) {
  const { id } = await admin.addFault(toAdd);
  console.log(c.green(`fault ${id} added:`), JSON.stringify(toAdd));
}
const { faults } = await admin.listFaults();
console.log(c.bold(`active faults (${faults.length}):`));
for (const f of faults) console.log(' ', JSON.stringify(f));
