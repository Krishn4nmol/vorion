import 'dotenv/config';
import { createWorld, step, type Controller } from './src/core/world';
import { makeBotController } from './src/ai/behaviour';
import { createKnowledge, updateKnowledge, buildSnapshot } from './src/ai/commander/snapshot';
import { buildUserPrompt, SYSTEM_PROMPT } from './src/ai/commander/prompt';
import { extractJson, validateOrders } from './src/ai/commander/orders';
import { askGemini } from './api/gemini';

/**
 * Latency is a hard constraint: the commander runs inside a live 60Hz game.
 * A model that reasons beautifully in 8 seconds is useless. Picks the model
 * empirically, and prints enough to diagnose failures rather than just count them.
 */
const CANDIDATES: [string, 'off' | 'low' | 'default'][] = [
  ['gemini-flash-lite-latest', 'off'],
  ['gemini-3.1-flash-lite', 'off'],
  ['gemini-3.5-flash-lite', 'off'],
  ['gemini-2.0-flash-lite', 'off'],
  ['gemini-flash-latest', 'off'],
  ['gemini-3.5-flash', 'low'],
];

async function main() {
  const w = createWorld(31);
  const bot = makeBotController();
  const cs = new Map<number, Controller>();
  for (const e of w.entities) cs.set(e.id, bot);
  const k = createKnowledge(1);
  for (let i = 0; i < 3000 && !w.over; i++) {
    step(w, cs);
    if (w.tick % 30 === 0) { updateKnowledge(w, k); if (k.contacts.size > 0) break; }
  }
  const user = buildUserPrompt(buildSnapshot(w, k), w.map.w, w.map.h);
  const engaged = new Set([6, 7, 8]);

  for (const [model, thinking] of CANDIDATES) {
    console.log('\n=== ' + model + '  (thinking: ' + thinking + ') ===');
    try {
      const t0 = Date.now();
      const { text, usage } = await askGemini(SYSTEM_PROMPT, user, { model, thinking });
      const ms = Date.now() - t0;
      const u = usage as { thoughtsTokenCount?: number; totalTokenCount?: number } | undefined;
      console.log(`latency ${ms}ms | thoughts ${u?.thoughtsTokenCount ?? 0} | total ${u?.totalTokenCount ?? 0}`);
      console.log('RAW: ' + JSON.stringify(text));

      const res = validateOrders(w, k, extractJson(text));
      const meddling = res.accepted.filter(a => engaged.has(a.unitId)).length;
      console.log(`accepted ${res.accepted.length}, rejected ${res.rejected.length}, micromanaged ${meddling}`);
      for (const a of res.accepted) console.log(`   OK  #${a.unitId} ${a.order.kind} "${a.reason}"`);
      for (const r of res.rejected) console.log(`   REJ ${r.reason}  <- ${JSON.stringify(r.raw)}`);
    } catch (e) {
      console.log('FAILED: ' + (e as Error).message);
    }
    await new Promise(r => setTimeout(r, 6000)); // stay under free-tier RPM
  }
}
main();