import { askGemini } from '../lib/gemini.js';

/**
 * Public endpoint. Once deployed this is reachable by anyone, so it is capped
 * on two axes: a short-window per-IP budget, and a hard daily total. When
 * either is exhausted it returns 429 and the client falls back to the scripted
 * commander — which was the strongest arm in the evaluation anyway, so the
 * degraded experience is not a worse game.
 *
 * State is per-instance and in-memory. Serverless instances come and go, so
 * this is a speed bump rather than a guarantee; for a portfolio deployment
 * that is the right trade against pulling in a KV store.
 */

const PER_IP_LIMIT = 40; // calls
const PER_IP_WINDOW_MS = 10 * 60 * 1000;
const DAILY_LIMIT = 700; // leaves headroom under the free tier

const ipHits = new Map<string, number[]>();
let dayStamp = '';
let dayCount = 0;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function overDailyCap(): boolean {
  const d = today();
  if (d !== dayStamp) {
    dayStamp = d;
    dayCount = 0;
  }
  return dayCount >= DAILY_LIMIT;
}

function overIpCap(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (hits.length >= PER_IP_LIMIT) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);

  // Bound memory: drop entries that have aged out entirely.
  if (ipHits.size > 500) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => now - t >= PER_IP_WINDOW_MS)) ipHits.delete(k);
    }
  }
  return false;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const ip =
    (req.headers?.['x-forwarded-for'] ?? '').toString().split(',')[0].trim() || 'unknown';

  if (overDailyCap()) {
    res.status(429).json({ error: 'daily commander budget reached', fallback: 'scripted' });
    return;
  }
  if (overIpCap(ip)) {
    res.status(429).json({ error: 'rate limit — slow down', fallback: 'scripted' });
    return;
  }

  try {
    const { system, user, model } = req.body ?? {};
    if (typeof system !== 'string' || typeof user !== 'string') {
      res.status(400).json({ error: 'system and user must be strings' });
      return;
    }
    if (system.length + user.length > 8000) {
      res.status(413).json({ error: 'prompt too large' });
      return;
    }

    dayCount++;
    const result = await askGemini(system, user, { model });
    res.status(200).json(result);
  } catch (err: any) {
    const msg = err?.message ?? 'unknown error';
    const status = /gemini 429/.test(msg) ? 429 : 502;
    res.status(status).json({ error: msg, fallback: status === 429 ? 'scripted' : undefined });
  }
}