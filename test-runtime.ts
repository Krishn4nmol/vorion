import { createWorld, step, type Controller } from './src/core/world';
import { makeBotController } from './src/ai/behaviour';
import { createKnowledge } from './src/ai/commander/snapshot';
import { Commander, type AskFn } from './src/ai/commander/runtime';
import { sideOf } from './src/core/entity';

/**
 * Mock transport standing in for Gemini: realistic latency, and a mix of good
 * output, malformed output, and outright failures.
 */
function mockAsk(failRate: number, latency: number): AskFn {
  let n = 0;
  return async (_system, user) => {
    n++;
    await new Promise(r => setTimeout(r, latency));
    if (n % Math.round(1 / failRate) === 0) throw new Error('503 upstream');
    const ids = [...user.matchAll(/^  UNIT #(\d+) hp/gm)].map(m => Number(m[1]));
    const engaged = [...user.matchAll(/^  UNIT #(\d+) .*IN CONTACT/gm)].map(m => Number(m[1]));
    const free = ids.filter(i => !engaged.includes(i));
    if (n % 7 === 0) return 'Sure! Here are my orders: [not json';
    const orders = free.slice(0, 3).map(id => ({ unit: id, order: 'regroup', reason: 'concentrate' }));
    return '```json\n' + JSON.stringify(orders) + '\n```';
  };
}

async function run(seed: number, ask: AskFn | null, mode: 'async' | 'blocking') {
  const w = createWorld(seed);
  const bot = makeBotController();
  const cs = new Map<number, Controller>();
  for (const e of w.entities) cs.set(e.id, bot);
  const cmd = ask ? new Commander(createKnowledge(1), ask, { mode, maxCalls: 40 }) : null;

  while (!w.over && w.tick < 20000) {
    step(w, cs);
    if (cmd) {
      const p = cmd.update(w);
      if (p) await p;                 // blocking mode only
    }
    if (mode === 'async' && w.tick % 400 === 0) await new Promise(r => setImmediate(r));
  }
  if (cmd) await cmd.flush();
  const alive = w.entities.filter(e => e.alive);
  return {
    winner: alive.length === 0 ? 'draw' : (sideOf(alive[0].team) === 1 ? 'enemy' : 'friendly'),
    ticks: w.tick,
    calls: cmd?.callCount ?? 0,
    traced: cmd?.trace.length ?? 0,
    errors: cmd?.trace.filter(t => t.error).length ?? 0,
    rejected: cmd?.trace.reduce((s, t) => s + t.rejected.length, 0) ?? 0,
    accepted: cmd?.trace.reduce((s, t) => s + t.accepted.length, 0) ?? 0,
    sampleTrace: cmd?.trace[1],
  };
}

// wrapped in main() — top-level await needs ESM, and this project is CJS
async function main() {
const t0 = Date.now();
const ask = mockAsk(0.15, 120);

const a = await run(7, ask, 'blocking');
console.log('blocking mode :', { winner: a.winner, ticks: a.ticks, calls: a.calls, accepted: a.accepted, rejected: a.rejected, errors: a.errors });

// Async mode is for the LIVE GAME only, where the loop is paced at 60Hz by
// wall clock. Headless it runs thousands of ticks per second, so a 120ms
// response lands hundreds of ticks late — which is exactly what this shows.
const b = await run(7, ask, 'async');
console.log('async (headless, expect few landed):', { winner: b.winner, ticks: b.ticks, calls: b.calls, accepted: b.accepted });

const c = await run(7, null, 'async');
console.log('no commander  :', { winner: c.winner, ticks: c.ticks });

console.log('\nsample trace entry:');
console.log(JSON.stringify({ ...a.sampleTrace, prompt: '<' + (a.sampleTrace?.prompt.length ?? 0) + ' chars>' }, null, 1).slice(0, 600));

console.log('\nwall clock:', Date.now() - t0, 'ms');
}

main();