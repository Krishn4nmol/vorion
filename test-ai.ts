import { createWorld, step, summary, type Controller } from './src/core/world';
import { makeBotController } from './src/ai/behaviour';

function run(seed: number) {
  const w = createWorld(seed);
  const bot = makeBotController();
  const controllers = new Map<number, Controller>();
  for (const e of w.entities) controllers.set(e.id, bot);

  let shots = 0, deaths = 0;
  while (!w.over && w.tick < 20000) {
    step(w, controllers);
    for (const ev of w.events) {
      if (ev.type === 'fire') shots++;
      if (ev.type === 'death') deaths++;
    }
  }
  const alive = w.entities.filter(e => e.alive);
  const winner = alive.length === 0 ? 'draw' : (alive[0].team === 'enemy' ? 'enemy' : 'friendly');
  return { ticks: w.tick, over: w.over, shots, deaths, winner };
}

const a = run(12345), b = run(12345);
console.log('A', a);
console.log('deterministic:', JSON.stringify(a) === JSON.stringify(b));

let ended = 0, totalTicks = 0, friendlyWins = 0;
const N = 300;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const r = run(i);
  if (r.over) ended++;
  totalTicks += r.ticks;
  if (r.winner === 'friendly') friendlyWins++;
}
console.log(`${ended}/${N} ended, avg ${Math.round(totalTicks / N)} ticks, friendly win ${(friendlyWins / N * 100).toFixed(0)}%, ${Date.now() - t0}ms`);