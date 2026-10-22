import { randomUUID } from 'node:crypto';
import { MockAdminClient } from '../src/mock-erp/admin-client.js';
import { c, env, http } from './_cli.js';

/**
 * Review walkthrough: one action end-to-end through the state machine, with a forced timeout AFTER commit.
 * Runs against the compose stack (`docker compose up`).
 */
const KEY = 'acme-dev-key';
const auth = { authorization: `Bearer ${KEY}` };
const admin = new MockAdminClient(env.mockErp);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => c.dim(`+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7));

type Detail = {
  id: string;
  state: string;
  events: { from: string | null; to: string; reason: string }[];
  ledger: { kind: string; amount: number; reason: string }[];
};

const wallet = async () =>
  (await http<{ available: number; held: number }>(`${env.gateway}/v1/wallet`, { headers: auth })).body;

console.log(c.bold('\n▶ Forced timeout after commit — walkthrough\n'));
const w0 = await wallet();
console.log(ts(), `acme wallet: available ${w0.available}, held ${w0.held}`);

await admin.addFault({
  mode: 'timeout_after_commit',
  count: 1,
  hang_ms: 30_000,
  match: { method: 'POST', path: '/companies/*/payments' },
});
console.log(ts(), c.yellow('fault armed: the next payment COMMITS in SAP, then the response never arrives'));

const inv = (await admin.invoices('C100', { status: 'OPEN', limit: 1 })).invoices[0];
if (!inv)
  throw new Error(
    'no OPEN invoice left for C100 — run `docker compose down -v && docker compose up` to reseed',
  );
const postsBefore = (await admin.stats()).payment_posts_received;

const sub = await http<Detail>(`${env.gateway}/v1/actions`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': `demo-${randomUUID()}` },
  body: JSON.stringify({
    action_type: 'pay_invoice',
    payload: { invoice_id: inv.invoice_id, amount_minor: inv.open_amount_minor, currency: 'INR' },
  }),
});
console.log(
  ts(),
  `POST /v1/actions → ${sub.status}  action ${c.cyan(sub.body.id)}  (pay ${inv.invoice_id}, ₹${(inv.open_amount_minor / 100).toLocaleString('en-IN')})`,
);

const say: Record<string, string> = {
  submitted: 'durable record + HOLD + enqueue committed in ONE transaction',
  claimed: 'worker won the CAS QUEUED→DISPATCHING; lease committed BEFORE the ERP call',
  'ambiguous:timeout': 'no response: SAP may or may not have committed → keep the hold, never retry blindly',
  'reconciled:found': 'looked up by reference (the action id) — found in SAP → capture',
  'reconciled:not_found_redispatch': 'trusted "not found" → re-send with the SAME reference',
  erp_committed: 'SAP answered 2xx → capture',
};
let seen = 0;
let detail: Detail | undefined;
let shownErp = false;
for (let i = 0; i < 240; i++) {
  detail = (await http<Detail>(`${env.gateway}/v1/actions/${sub.body.id}`, { headers: auth })).body;
  for (const e of detail.events.slice(seen)) {
    console.log(
      ts(),
      `${c.bold(`${e.from ?? '∅'} → ${e.to}`)}  ${c.dim(`(${e.reason})`)}  ${say[e.reason] ?? ''}`,
    );
  }
  seen = detail.events.length;
  if (detail.state === 'UNKNOWN' && !shownErp) {
    shownErp = true;
    const payments = await admin.primaryPayments('C100', { reference: detail.id });
    console.log(
      ts(),
      c.yellow(
        `   SAP primary has ${payments.length} payment(s) with reference ${detail.id} — it DID commit`,
      ),
    );
    console.log(
      ts(),
      c.yellow(
        `   ledger now: ${detail.ledger.map((l) => `${l.kind} ${l.amount}`).join(', ')} — no refund, no retry`,
      ),
    );
  }
  if (['SUCCEEDED', 'FAILED'].includes(detail.state)) break;
  await sleep(250);
}
if (!detail) throw new Error('no detail');
console.log(
  ts(),
  `final state: ${detail.state === 'SUCCEEDED' ? c.green(detail.state) : c.red(detail.state)}`,
);
console.log(ts(), `ledger: ${detail.ledger.map((l) => `${l.kind} ${l.amount}`).join(' → ')}`);
const posts = (await admin.stats()).payment_posts_received - postsBefore;
console.log(ts(), `ERP payment POSTs for this action: ${posts === 1 ? c.green('1') : c.red(String(posts))}`);
const w1 = await wallet();
console.log(
  ts(),
  `acme wallet: available ${w1.available} (−${w0.available - w1.available}), held ${w1.held}`,
);
const rec = await http<{ ok: boolean }>(`${env.gateway}/v1/ops/reconcile`, {
  method: 'POST',
  headers: { authorization: `Bearer ${env.opsKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ force: false }),
});
console.log(
  ts(),
  rec.body.ok
    ? c.green('✓ ledger invariants hold (wallets == SUM(ledger); every action settled once)')
    : c.red('✗ invariant violation'),
);
await admin.clearFaults();
