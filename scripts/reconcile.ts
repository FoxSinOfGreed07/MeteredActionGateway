import { c, env, http } from './_cli.js';

/**
 * The reconciliation run: asks the gateway to resolve UNKNOWN actions now (force: ignores the schedule but
 * NEVER the trust rule) and to verify the ledger invariants. Exit code 1 on wallet drift or a settlement
 * violation. Runs through the API so it works from the host against the compose stack.
 */
const force = !process.argv.includes('--due-only');
const { status, body } = await http<{
  resolved: { action_id: string; to: string; why: string }[];
  still_unknown: { action_id: string; why: string }[];
  wallet_drift: unknown[];
  settlement_violations: unknown[];
  unknown_alerts: { action_id: string; age_ms: number }[];
  ok: boolean;
}>(`${env.gateway}/v1/ops/reconcile`, {
  method: 'POST',
  headers: { authorization: `Bearer ${env.opsKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ force }),
});
if (status !== 200) {
  console.error(c.red(`reconcile failed: HTTP ${status}`), body);
  process.exit(2);
}
console.log(c.bold(`Reconciliation run (${force ? 'all UNKNOWN' : 'due only'})`));
if (body.resolved.length) console.table(body.resolved);
else console.log(c.dim('  no UNKNOWN action resolved in this pass'));
if (body.still_unknown.length) {
  console.log(c.yellow(`still UNKNOWN (${body.still_unknown.length}) — waiting for trustworthy evidence:`));
  console.table(body.still_unknown);
}
if (body.unknown_alerts.length)
  console.log(c.yellow('UNKNOWN older than the alert threshold:'), body.unknown_alerts);
console.log(
  body.wallet_drift.length === 0
    ? c.green('✓ wallets == SUM(ledger) for every tenant')
    : c.red(`✗ wallet drift: ${JSON.stringify(body.wallet_drift)}`),
);
console.log(
  body.settlement_violations.length === 0
    ? c.green('✓ every action settled exactly once (HOLD → CAPTURE | RELEASE)')
    : c.red(`✗ settlement violations: ${JSON.stringify(body.settlement_violations)}`),
);
process.exit(body.ok ? 0 : 1);
