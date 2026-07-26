import 'dotenv/config';
import { createWorld, step, type Controller } from './src/core/world';
import { makeBotController } from './src/ai/behaviour';
import { createKnowledge, updateKnowledge, buildSnapshot } from './src/ai/commander/snapshot';
import { buildUserPrompt, SYSTEM_PROMPT } from './src/ai/commander/prompt';
import { extractJson, validateOrders } from './src/ai/commander/orders';
import { askGemini } from './lib/gemini';

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
  console.log('--- PROMPT ---\n' + user + '\n');

  const t0 = Date.now();
  const { text, model, usage } = await askGemini(SYSTEM_PROMPT, user);
  console.log(`--- RESPONSE (${model}, ${Date.now() - t0}ms) ---\n` + text + '\n');
  console.log('usage:', JSON.stringify(usage));

  const res = validateOrders(w, k, extractJson(text));
  console.log('\nACCEPTED:');
  for (const a of res.accepted) console.log(`  #${a.unitId} ${a.order.kind} "${a.reason}"`);
  console.log('REJECTED:');
  for (const r of res.rejected) console.log('  ' + r.reason);
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });