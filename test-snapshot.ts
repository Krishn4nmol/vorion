import { createWorld, step, type Controller } from './src/core/world';
import { makeBotController } from './src/ai/behaviour';
import { createKnowledge, updateKnowledge, buildSnapshot, toPrompt } from './src/ai/commander/snapshot';

const w = createWorld(31);
const bot = makeBotController();
const cs = new Map<number, Controller>();
for (const e of w.entities) cs.set(e.id, bot);

const k = createKnowledge(1); // the enemy side's commander

// stop at the first tick where the commander actually has something to decide
for (let i = 0; i < 3000 && !w.over; i++) {
  step(w, cs);
  if (w.tick % 30 === 0) {
    updateKnowledge(w, k);
    if (k.contacts.size > 0) break;
  }
}

const text = toPrompt(buildSnapshot(w, k), w.map.w, w.map.h);
console.log(text);
console.log('\nchars:', text.length, '| approx tokens:', Math.round(text.length / 4));