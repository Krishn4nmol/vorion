import { createWorld, step, type Controller } from './src/core/world';
import { makeBotController } from './src/ai/behaviour';
import { createKnowledge, updateKnowledge } from './src/ai/commander/snapshot';
import { extractJson, validateOrders, applyOrders, expireOrders } from './src/ai/commander/orders';

const w = createWorld(31);
const bot = makeBotController();
const cs = new Map<number, Controller>();
for (const e of w.entities) cs.set(e.id, bot);
const k = createKnowledge(1);
for (let i = 0; i < 3000 && !w.over; i++) {
  step(w, cs);
  if (w.tick % 30 === 0) { updateKnowledge(w, k); if (k.contacts.size > 0) break; }
}
console.log('tick', w.tick, '| seen contacts:', [...k.contacts.keys()].join(','));

// A deliberately mixed model response: some good, some hallucinated, some hostile.
const modelOutput = `Here's my plan!
\`\`\`json
[
  { "unit": 5, "order": "advance_to", "x": 30, "y": 24, "reason": "push the centre" },
  { "unit": 6, "order": "flank", "x": 30, "y": 34, "reason": "swing south" },
  { "unit": 7, "order": "suppress", "target": ${[...k.contacts.keys()][0] ?? 1}, "reason": "pin them" },
  { "unit": 8, "order": "hold", "reason": "cover the rear" },
  { "unit": 2, "order": "retreat", "reason": "commanding the enemy team" },
  { "unit": 99, "order": "hold", "reason": "unit does not exist" },
  { "unit": 5, "order": "hold", "reason": "duplicate for unit 5" },
  { "unit": 6, "order": "nuke", "reason": "invented order" },
  { "unit": 7, "order": "advance_to", "x": 0, "y": 0, "reason": "into the border wall" },
  { "unit": 8, "order": "advance_to", "x": 999, "y": 999, "reason": "off the map" },
  { "unit": 6, "order": "suppress", "target": 4242, "reason": "enemy never seen" },
  "not even an object"
]
\`\`\``;

const res = validateOrders(w, k, extractJson(modelOutput));

console.log('\nACCEPTED:');
for (const a of res.accepted) console.log(`  #${a.unitId} ${a.order.kind}${a.order.target ? ` -> (${Math.floor(a.order.target.x/32)},${Math.floor(a.order.target.y/32)})` : ''}  "${a.reason}"`);
console.log('\nREJECTED:');
for (const r of res.rejected) console.log(`  ${r.reason}`);

applyOrders(w, res);
console.log('\norders on entities:', w.entities.filter(e=>e.order).map(e=>`#${e.id}:${e.order!.kind}`).join(' '));

console.log('\n--- garbage handling ---');
for (const bad of ['', 'no json here', '{"unit":5}', '[', 'null', '[[]]']) {
  const r = validateOrders(w, k, extractJson(bad));
  console.log(`  input ${JSON.stringify(bad).padEnd(18)} -> accepted ${r.accepted.length}, rejected ${r.rejected.length}`);
}

const before = w.entities.filter(e=>e.order).length;
w.tick += 1000;
expireOrders(w);
console.log(`\nexpiry: ${before} orders before, ${w.entities.filter(e=>e.order).length} after TTL`);