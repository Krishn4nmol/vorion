import { isWallTile, TILE } from '../../core/map';
import { sideOf } from '../../core/entity';
import type { World } from '../../core/world';
import { canSee } from '../vision';
import { updateKnowledge, type SquadKnowledge } from './snapshot';
import { validateOrders, applyOrders, expireOrders } from './orders';

/**
 * The hand-written baseline. Shared between the evaluation harness and the
 * deployed game, where it takes over if the LLM endpoint is rate-limited —
 * which is no great loss, since it was the strongest arm in the evaluation
 * (57.5% vs 52.5% for the model).
 *
 * Two rules, both derived from measured failures:
 *   - only command units NOT already in contact (dense commanding scored 39.8%)
 *   - concentrate before contact; scattering across objectives cost ~20 points
 */
export function scriptedOrders(w: World, k: SquadKnowledge): unknown[] {
  const squad = w.entities
    .filter((e) => e.alive && sideOf(e.team) === k.side)
    .filter(
      (e) =>
        !w.entities.some(
          (o) => o.alive && sideOf(o.team) !== k.side && canSee(w.map, e.pos, o.pos),
        ),
    );
  if (squad.length === 0) return [];

  const contacts = [...k.contacts.values()];
  const orders: unknown[] = [];

  if (contacts.length === 0) {
    const cx = w.map.w / 2;
    const cy = w.map.h / 2;
    let obj = w.map.buildings[0];
    let bestD = Infinity;
    for (const b of w.map.buildings) {
      const d = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
      if (d < bestD) {
        bestD = d;
        obj = b;
      }
    }
    for (const e of squad) {
      orders.push({
        unit: e.id,
        order: 'advance_to',
        x: Math.round(obj.x + obj.w / 2),
        y: Math.round(obj.y + obj.h / 2),
        reason: 'advance together',
      });
    }
    return orders;
  }

  const mark = contacts.reduce((a, b) => (a.hp <= b.hp ? a : b));
  squad.forEach((e, i) => {
    if (i % 2 === 0) {
      orders.push({ unit: e.id, order: 'suppress', target: mark.id, reason: 'pin the mark' });
    } else {
      const ex = Math.floor(e.pos.x / TILE);
      const ey = Math.floor(e.pos.y / TILE);
      const dx = mark.tile.x - ex;
      const dy = mark.tile.y - ey;
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

/** Drop-in replacement for Commander with the same update() contract. */
export class ScriptedCommander {
  readonly knowledge: SquadKnowledge;
  private interval: number;
  private lastTick = -Infinity;
  lastOrders: { unitId: number; kind: string; reason: string }[] = [];

  constructor(knowledge: SquadKnowledge, intervalTicks = 150) {
    this.knowledge = knowledge;
    this.interval = intervalTicks;
  }

  update(w: World): void {
    expireOrders(w);
    if (w.over || w.tick - this.lastTick < this.interval) return;
    this.lastTick = w.tick;

    updateKnowledge(w, this.knowledge);
    const res = validateOrders(w, this.knowledge, scriptedOrders(w, this.knowledge));
    applyOrders(w, res);
    this.lastOrders = res.accepted.map((a) => ({
      unitId: a.unitId,
      kind: a.order.kind,
      reason: a.reason,
    }));
  }
}