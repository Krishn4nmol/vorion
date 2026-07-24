import { createWorld, step, type Controller } from './src/core/world';
import { makeBotController } from './src/ai/behaviour';
import { createKnowledge, updateKnowledge, type SquadKnowledge } from './src/ai/commander/snapshot';
import { validateOrders, applyOrders, expireOrders } from './src/ai/commander/orders';
import { isWallTile, TILE } from './src/core/map';
import { canSee } from './src/ai/vision';
import { sideOf } from './src/core/entity';
import type { World } from './src/core/world';

const COMMAND_INTERVAL = 180; // 3 seconds

/**
 * A deliberately simple scripted commander. No model, no network — it exists to
 * answer one question: does the order vocabulary allow coordination that beats
 * four bots fighting individually?
 */
function scriptedCommander(w: World, k: SquadKnowledge, sparse: boolean): unknown[] {
  let squad = w.entities.filter(e => e.alive && sideOf(e.team) === k.side);
  const contacts = [...k.contacts.values()];

  // Sparse mode: never interrupt a unit that is already in a fight. A commander
  // adds value by moving units that are NOT engaged.
  if (sparse) {
    squad = squad.filter(e => !w.entities.some(o => o.alive && sideOf(o.team) !== k.side && canSee(w.map, e.pos, o.pos)));
    if (squad.length === 0) return [];
  }

  const orders: unknown[] = [];

  if (contacts.length === 0) {
    // No contact: advance as ONE body toward the centre of the map. Sending
    // each unit to a different building scatters the squad and gets it beaten
    // in detail — concentration matters more than ground held.
    const cx = w.map.w / 2, cy = w.map.h / 2;
    let obj = w.map.buildings[0];
    let bestD = Infinity;
    for (const b of w.map.buildings) {
      const d = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
      if (d < bestD) { bestD = d; obj = b; }
    }
    for (const e of squad) {
      orders.push({ unit: e.id, order: 'advance_to', x: Math.round(obj.x + obj.w / 2), y: Math.round(obj.y + obj.h / 2), reason: 'advance together' });
    }
    return orders;
  }

  // Pick the weakest contact as the focus of effort.
  const mark = contacts.reduce((a, b) => (a.hp <= b.hp ? a : b));

  squad.forEach((e, i) => {
    if (i % 2 === 0) {
      orders.push({ unit: e.id, order: 'suppress', target: mark.id, reason: 'pin the mark' });
    } else {
      // Flank: step perpendicular to the approach line, 8 tiles out.
      const ex = Math.floor(e.pos.x / TILE), ey = Math.floor(e.pos.y / TILE);
      const dx = mark.tile.x - ex, dy = mark.tile.y - ey;
      const len = Math.hypot(dx, dy) || 1;
      for (const sign of [1, -1]) {
        const fx = Math.round(mark.tile.x + (-dy / len) * 8 * sign);
        const fy = Math.round(mark.tile.y + (dx / len) * 8 * sign);
        if (fx > 0 && fy > 0 && fx < w.map.w && fy < w.map.h && !isWallTile(w.map, fx, fy)) {
          orders.push({ unit: e.id, order: 'flank', x: fx, y: fy, reason: 'swing wide' });
          break;
        }
      }
    }
  });
  return orders;
}

function run(seed: number, commandSide: 0 | 1 | null, sparse = false) {
  const w = createWorld(seed);
  const bot = makeBotController();
  const cs = new Map<number, Controller>();
  for (const e of w.entities) cs.set(e.id, bot);
  const k = commandSide === null ? null : createKnowledge(commandSide);

  let issued = 0, rejected = 0;
  while (!w.over && w.tick < 20000) {
    step(w, cs);
    if (k && w.tick % COMMAND_INTERVAL === 0) {
      updateKnowledge(w, k);
      const res = validateOrders(w, k, scriptedCommander(w, k, sparse));
      applyOrders(w, res);
      issued += res.accepted.length;
      rejected += res.rejected.length;
    }
    expireOrders(w);
  }
  const alive = w.entities.filter(e => e.alive);
  const winner = alive.length === 0 ? 'draw' : (sideOf(alive[0].team) === 1 ? 'enemy' : 'friendly');
  return { winner, ticks: w.tick, over: w.over, issued, rejected };
}

const modes: [string, 0 | 1 | null, boolean][] = [
  ['no commander', null, false],
  ['commanded (dense)', 1, false],
  ['commanded (sparse)', 1, true],
];
for (const [label, side, sparse] of modes) {
  let enemyWins = 0, ended = 0, ticks = 0, issued = 0, rejected = 0;
  const N = 1200;
  for (let s = 0; s < N; s++) {
    const r = run(s, side, sparse);
    if (r.winner === 'enemy') enemyWins++;
    if (r.over) ended++;
    ticks += r.ticks; issued += r.issued; rejected += r.rejected;
  }
  console.log(`${label.padEnd(22)} enemy win ${(enemyWins / N * 100).toFixed(1)}%  | ${ended}/${N} ended | avg ${Math.round(ticks / N)} ticks | orders ${issued} ok / ${rejected} rejected`);
}