import { expect } from 'vitest';
import { verifySettlements, verifyWallets } from '../../src/gateway/wallet/verify.js';
import type { Stack } from './stack.js';

/**
 * §13 invariants checked after every scenario: I2 (projection == ledger), I4 (settlement matches state),
 * and "no ERP reference was paid twice" (read from the mock's primary state, in-process).
 */
export async function assertInvariants(stack: Stack): Promise<void> {
  const drift = await verifyWallets(stack.db);
  expect(drift, `wallet drift: ${JSON.stringify(drift)}`).toEqual([]);
  const violations = await verifySettlements(stack.db);
  expect(violations, `settlement violations: ${JSON.stringify(violations)}`).toEqual([]);
  if (stack.mockErp) {
    const dupes: { company: string; reference: string; count: number }[] = [];
    for (const [cc] of stack.mockErp.instance.state.companies) {
      const counts = new Map<string, number>();
      for (const p of stack.mockErp.instance.state.listPayments(cc))
        counts.set(p.reference, (counts.get(p.reference) ?? 0) + 1);
      for (const [reference, count] of counts) if (count > 1) dupes.push({ company: cc, reference, count });
    }
    expect(dupes, `references paid more than once: ${JSON.stringify(dupes)}`).toEqual([]);
  }
}
