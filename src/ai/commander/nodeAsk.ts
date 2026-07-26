import type { AskFn } from './runtime';
import { askGemini } from '../../../lib/gemini';

/**
 * Server-side transport for the eval harness. Calls Gemini directly rather
 * than going through the HTTP proxy — there is no browser here, and the key
 * is already in this process.
 *
 * The rate limiter is shared across every match in a run: free tier is roughly
 * 15 requests/minute, and a 429 mid-eval would silently turn LLM matches into
 * no-commander matches and corrupt the result.
 */
export function createNodeAsk(model: string, minGapMs = 5000): AskFn {
  let nextSlot = 0;

  return async (system, user) => {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minGapMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const { text } = await askGemini(system, user, { model, thinking: 'off' });
    return text;
  };
}