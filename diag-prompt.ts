import 'dotenv/config';
import { SYSTEM_PROMPT_V1, SYSTEM_PROMPT_V2 } from './src/ai/commander/prompt';
import { askGemini } from './api/gemini';

const USER = `TICK 330 | MAP 64x48 tiles | your squad 4 alive

YOUR SQUAD:
  UNIT #5 hp100 ammo30 at (40,22) open ground 10 tiles SW of MOTOR POOL | no contact | doing: none
  UNIT #6 hp100 ammo27 at (37,23) open ground 11 tiles N of WORKSHOP | IN CONTACT | doing: none

ENEMY CONTACTS (only what your squad has seen):
  ENEMY #1 hp100 last seen 0 ticks ago at (26,24) open ground 7 tiles NE of OUTPOST

BUILDINGS:
  OUTPOST centre (21,30) — enemy

Issue orders now. JSON array only.`;

async function one(label: string, system: string) {
  const t0 = Date.now();
  try {
    const { text } = await askGemini(system, USER, { thinking: 'off' });
    console.log(`${label.padEnd(4)} ${Date.now() - t0}ms  system=${system.length} chars`);
    console.log(`     ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
  } catch (e) {
    console.log(`${label.padEnd(4)} ${Date.now() - t0}ms  FAILED: ${(e as Error).message.slice(0, 200)}`);
  }
}

async function main() {
  console.log('model:', process.env.GEMINI_MODEL);
  await one('V1', SYSTEM_PROMPT_V1);
  await new Promise((r) => setTimeout(r, 5000));
  await one('V2', SYSTEM_PROMPT_V2);
}
main();