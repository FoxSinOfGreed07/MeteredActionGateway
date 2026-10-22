import { hmacSha256Hex } from '../shared/hash.js';
import type { Logger } from '../shared/logger.js';
import type { Stats } from './stats.js';
import type { MockErpConfig, WebhookEvent } from './types.js';

/**
 * Delayed, HMAC-signed webhook delivery with retries. Events are sent in delay order, NOT guaranteed in
 * seq order (realistic); tests that need duplicates / reordering POST to the gateway directly.
 */
export class WebhookSender {
  private timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly config: MockErpConfig,
    private readonly stats: Stats,
    private readonly log: Logger,
  ) {}

  enqueue(event: WebhookEvent, delayOverrideMs?: number): void {
    if (!this.config.webhooks_enabled || !this.config.webhook_url) {
      this.stats.webhooks.dropped += 1;
      return;
    }
    const delay = delayOverrideMs ?? this.config.webhook_delay_ms;
    this.stats.webhooks.pending += 1;
    this.schedule(() => this.deliver(event, 1), delay);
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private async deliver(event: WebhookEvent, attempt: number): Promise<void> {
    const url = this.config.webhook_url;
    const body = JSON.stringify(event);
    try {
      if (!url) throw new Error('no webhook_url');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-erp-signature': `sha256=${hmacSha256Hex(this.config.webhook_secret, body)}`,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
      this.stats.webhooks.pending -= 1;
      this.stats.webhooks.sent += 1;
    } catch (err) {
      if (attempt < 5) {
        this.schedule(() => void this.deliver(event, attempt + 1), 1000);
        return;
      }
      this.stats.webhooks.pending -= 1;
      this.stats.webhooks.failed += 1;
      this.log.warn({ err: String(err), event_id: event.event_id }, 'mock-erp.webhook_failed');
    }
  }

  cancelAll(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.stats.webhooks.pending = 0;
  }
}
