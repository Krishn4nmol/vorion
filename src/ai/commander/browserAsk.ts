import type { AskFn } from './runtime';

/**
 * Browser-side transport. Talks to our own /api/commander, never to Google
 * directly — putting a Gemini key in client JavaScript would publish it to
 * anyone who opens devtools.
 */
export function createBrowserAsk(model?: string): AskFn {
  return async (system, user) => {
    console.debug('[commander] asking…');
    const res = await fetch('/api/commander', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, user, model }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`commander endpoint ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    console.debug('[commander] got', (data.text ?? '').slice(0, 120));
    return data.text ?? '';
  };
}