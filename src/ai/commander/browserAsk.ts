import type { AskFn } from './runtime';

/** Thrown when the endpoint is rate-limited, so the caller can degrade. */
export class QuotaError extends Error {}

/**
 * Browser-side transport. Talks to our own /api/commander, never to Google
 * directly — putting a Gemini key in client JavaScript would publish it to
 * anyone who opens devtools.
 */
export function createBrowserAsk(model?: string): AskFn {
  return async (system, user) => {
    const res = await fetch('/api/commander', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, user, model }),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      throw new QuotaError((body as { error?: string }).error ?? 'rate limited');
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`commander endpoint ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = (await res.json()) as { text?: string };
    return data.text ?? '';
  };
}