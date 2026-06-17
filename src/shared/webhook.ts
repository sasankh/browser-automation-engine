import type { Envelope } from '../types/envelope';
import { runLogger } from './logger';

/** Recorded on the run (`runs.webhook_status`) so delivery is observable. */
export type WebhookStatus = 'delivered' | 'failed';

export interface WebhookDispatcher {
  deliver(callbackUrl: string, envelope: Envelope, runId: string): Promise<WebhookStatus>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Delivers the terminal envelope to `callback_url` (POST JSON), retrying with exponential backoff on
 * a non-2xx or network error. **Unsigned this phase** — HMAC `X-Engine-Signature` lands with caller
 * auth in Phase 7 (DECISIONS #30), since v1 has no caller identity to key a per-caller secret on.
 */
export class HttpWebhookDispatcher implements WebhookDispatcher {
  constructor(private readonly maxRetries: number) {}

  async deliver(callbackUrl: string, envelope: Envelope, runId: string): Promise<WebhookStatus> {
    const body = JSON.stringify(envelope);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (res.ok) return 'delivered';
        runLogger(runId).warn({ status: res.status, attempt }, 'webhook non-2xx');
      } catch (err) {
        runLogger(runId).warn({ err, attempt }, 'webhook delivery error');
      }
      if (attempt < this.maxRetries) await sleep(Math.min(200 * 2 ** attempt, 5_000));
    }
    return 'failed';
  }
}
