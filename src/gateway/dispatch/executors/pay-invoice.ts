import { expBackoff, fullJitter } from '../../../shared/backoff.js';
import type { PayInvoicePayload } from '../../actions/types/pay-invoice.js';
import { connectorForLane } from '../../erp/index.js';
import * as cooldown from '../cooldown.js';
import { markFailed, markSucceeded, markUnknown, requeueRetryable } from '../settle.js';
import type { ExecArgs } from './index.js';

/**
 * pay_invoice: one ERP send, then act on the outcome kind (A8):
 *   committed  → SUCCEEDED + CAPTURE (fenced by lease; if the lease was lost to recovery, UNKNOWN → SUCCEEDED
 *                using the committed response as strong evidence)
 *   retryable  → QUEUED with backoff (429 also trips the lane cooldown). No attempt cap: no action lost.
 *   permanent  → FAILED + RELEASE with the ERP's code (S8; S3b keeps the ERP's current invoice state)
 *   ambiguous  → UNKNOWN, hold kept, NEVER resent blindly (D2)
 */
export async function executePayInvoice({
  ctx,
  action,
  tenant,
  lane,
  owner,
  isAbandoned,
}: ExecArgs): Promise<void> {
  const payload = action.payload as PayInvoicePayload;
  const log = ctx.log.child({ action_id: action.id, tenant_id: tenant.id, lane_id: lane.id });
  const outcome = await connectorForLane(lane).postPayment({
    companyCode: tenant.erp_company_code,
    invoiceId: payload.invoice_id,
    amountMinor: payload.amount_minor,
    currency: payload.currency,
    reference: action.id,
  });
  if (isAbandoned()) {
    log.warn({ outcome: outcome.kind }, 'executor.abandoned_result_dropped');
    return;
  }

  switch (outcome.kind) {
    case 'committed': {
      const result = {
        payment: outcome.value.payment,
        invoice: outcome.value.invoice
          ? {
              invoice_id: outcome.value.invoice.invoice_id,
              status: outcome.value.invoice.status,
              seq: outcome.value.invoice.seq,
            }
          : null,
      };
      let row = await markSucceeded(ctx, action, {
        result,
        via: 'response',
        reason: 'erp_committed',
        leaseOwner: owner,
      });
      if (!row) {
        // Our lease expired mid-call and recovery moved the action to UNKNOWN: the 2xx is strong evidence.
        row = await markSucceeded(ctx, action, {
          result,
          via: 'response',
          reason: 'late_response:committed',
          from: ['UNKNOWN'],
        });
        if (!row) log.warn('settle.cas_lost');
      }
      await cooldown.onSuccess(ctx, lane.id).catch(() => {});
      await ctx.cacheHooks
        .onInvoiceChanged(
          lane.id,
          tenant.erp_company_code,
          payload.invoice_id,
          outcome.value.invoice?.seq ?? null,
        )
        .catch((err) => log.warn({ err: String(err) }, 'cache_hook.failed'));
      return;
    }
    case 'retryable': {
      let delayMs: number;
      if (outcome.reason === 'rate_limited') {
        const cooldownMs = await cooldown
          .trip(ctx, lane.id, outcome.retryAfterMs)
          .catch(() => ctx.config.cooldown.baseMs);
        delayMs = Math.max(outcome.retryAfterMs ?? 0, cooldownMs);
      } else {
        delayMs = fullJitter(
          expBackoff(action.retry_count + 1, ctx.config.retry.baseMs, ctx.config.retry.maxMs),
        );
      }
      const row = await requeueRetryable(ctx, action, {
        reason: `retry:${outcome.reason}`,
        delayMs,
        leaseOwner: owner,
        details: { retry_after_ms: outcome.retryAfterMs ?? null, delay_ms: delayMs },
      });
      if (!row) log.warn('settle.cas_lost');
      return;
    }
    case 'permanent': {
      const details = outcome.details as { invoice?: unknown } | undefined;
      const row = await markFailed(ctx, action, {
        code: outcome.code,
        message: outcome.message,
        reason: `erp_rejected:${outcome.code}`,
        currentState: details?.invoice ?? null,
        details: { http_status: outcome.httpStatus },
        leaseOwner: owner,
      });
      if (!row) log.warn('settle.cas_lost');
      await cooldown.onSuccess(ctx, lane.id).catch(() => {});
      return;
    }
    case 'ambiguous': {
      const row = await markUnknown(ctx, action, {
        reason: `ambiguous:${outcome.reason}`,
        leaseOwner: owner,
        lane,
        details: { detail: outcome.detail ?? null },
      });
      if (!row) log.warn('settle.cas_lost');
      return;
    }
  }
}
