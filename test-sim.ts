import { createWorld, step, fire, startReload, nearestVisibleEnemy, canFire, summary, type Controller, type World } from './src/core/world';
import { angleTo, dist, type Entity } from './src/core/entity';
import { moveToward } from './src/core/physics';

const scripted: Controller = (w: World, e: Entity) => {
  const target = nearestVisibleEnemy(w, e);
  if (!target) return;
  e.aim = angleTo(e.pos, target.pos);
  if (e.weapon.ammo === 0) { startReload(w, e); return; }
  const d = dist(e.pos, target.pos);
  if (d > 220) moveToward(e, target.pos);
  if (canFire(w, e) && d < 400) fire(w, e, e.aim);
};

function run(seed: number) {
  const w = createWorld(seed);
  const controllers = new Map<number, Controller>();
  for (const e of w.entities) controllers.set(e.id, scripted);
  let shots = 0, damage = 0, deaths = 0;
  while (!w.over && w.tick < 20000) {
    step(w, controllers);
    for (const ev of w.events) {
      if (ev.type === 'fire') shots++;
      if (ev.type === 'damage') damage += ev.amount;
      if (ev.type === 'death') deaths++;
    }
  }
  return { ticks: w.tick, shots, damage, deaths, sum: JSON.stringify(summary(w)) };
}

const a = run(12345), b = run(12345), c = run(999);
console.log('A', a);
console.log('deterministic:', JSON.stringify(a) === JSON.stringify(b));
console.log('seed matters:', JSON.stringify(a) !== JSON.stringify(c));