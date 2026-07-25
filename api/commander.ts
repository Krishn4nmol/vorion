import { askGemini } from './gemini';

/**
 * Serverless proxy. The browser never sees the API key — it POSTs a prompt
 * here and gets raw model text back. Deployed on Vercel; the dev server mounts
 * the same caller as middleware (see vite.config.ts).
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const { system, user, model } = req.body ?? {};
    if (typeof system !== 'string' || typeof user !== 'string') {
      res.status(400).json({ error: 'system and user must be strings' });
      return;
    }
    // Cheap abuse guard: this endpoint is public once deployed.
    if (system.length + user.length > 20000) {
      res.status(413).json({ error: 'prompt too large' });
      return;
    }

    const result = await askGemini(system, user, { model });
    res.status(200).json(result);
  } catch (err: any) {
    const msg = err?.message ?? 'unknown error';
    const status = /gemini 429/.test(msg) ? 429 : 502;
    res.status(status).json({ error: msg });
  }
}