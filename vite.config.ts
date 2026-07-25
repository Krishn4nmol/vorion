import 'dotenv/config';
import { defineConfig, type Plugin } from 'vite';
import { askGemini } from './api/gemini';

/**
 * Vite does not execute the /api folder in dev, so the same Gemini caller is
 * mounted as middleware here. Both paths import askGemini, so local play and
 * the deployed function cannot drift apart.
 */
function commanderApi(): Plugin {
  return {
    name: 'vorion-commander-api',
    configureServer(server) {
      server.middlewares.use('/api/commander', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }

        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const { system, user, model } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          if (typeof system !== 'string' || typeof user !== 'string') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'system and user must be strings' }));
            return;
          }

          const result = await askGemini(system, user, { model });
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.statusCode = /gemini 429/.test(msg) ? 429 : 502;
          res.end(JSON.stringify({ error: msg }));
          server.config.logger.error('[commander] ' + msg);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [commanderApi()],
});