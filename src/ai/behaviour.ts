import { dist, angleTo, type Entity, type Vec2 } from '../core/entity';
import {
  fire,
  startReload,
  canFire,
  isHostile,
  type Controller,
  type World,
} from '../core/world';
import { moveToward } from '../core/physics';
import { findPath } from './pathfinding';
import { acquireTarget, findCover, aimWithLead, hasFiringLane } from './vision';

const REPATH_INTERVAL = 30; // ticks
const WAYPOINT_REACHED = 12; // px
const PREFERRED_RANGE = 240; // px — bots try to fight from about here
const RETREAT_HP = 30;
const RETREAT_TICKS = 180;
const STALEMATE_TICKS = 600; // no damage anywhere for this long -> everyone charges

/** Walks the entity along entity.path, returns true while still travelling. */
function followPath(e: Entity): boolean {
  while (e.pathIndex < e.path.length) {
    const wp = e.path[e.pathIndex];
    if (dist(e.pos, wp) <= WAYPOINT_REACHED) {
      e.pathIndex++;
      continue;
    }
    moveToward(e, wp);
    return true;
  }
  return false;
}

function setDestination(w: World, e: Entity, dest: Vec2): void {
  if (w.tick < e.repathTick) return;
  e.path = findPath(w.map, e.pos, dest);
  e.pathIndex = 0;
  e.repathTick = w.tick + REPATH_INTERVAL;
}

/** Nearest hostile regardless of line of sight — the bot's search objective. */
function nearestHostile(w: World, e: Entity): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const other of w.entities) {
    if (!other.alive || !isHostile(e, other)) continue;
    const d = dist(e.pos, other.pos);
    if (d < bestD) {
      best = other;
      bestD = d;
    }
  }
  return best;
}

/**
 * v0 rule-based bot. Deliberately competent but uncoordinated — each bot
 * fights alone. This is the baseline the LLM-commanded squads are measured
 * against in v2, so it should be decent, not stupid.
 */
export function makeBotController(): Controller {
  const retreatUntil = new Map<number, number>();

  // Stalemate detection, computed once per tick and shared by every bot.
  let lastHpSum = -1;
  let lastChangeTick = 0;
  let sampledTick = -1;
  let aggressive = false;

  const sampleStalemate = (w: World) => {
    if (sampledTick === w.tick) return;
    sampledTick = w.tick;
    let sum = 0;
    for (const en of w.entities) if (en.alive) sum += en.hp;
    if (sum !== lastHpSum) {
      lastHpSum = sum;
      lastChangeTick = w.tick;
    }
    aggressive = w.tick - lastChangeTick > STALEMATE_TICKS;
  };

  return (w: World, e: Entity) => {
    const wp = e.weapon;
    sampleStalemate(w);

    // Reloading is not interruptible; keep moving but hold fire.
    if (wp.reloadEndTick > w.tick) {
      e.state = 'reload';
      followPath(e);
      return;
    }

    if (wp.ammo === 0) {
      e.state = 'reload';
      startReload(w, e);
      return;
    }

    const target = acquireTarget(w, e);
    const until = retreatUntil.get(e.id) ?? 0;

    // --- retreat -----------------------------------------------------------
    if (!aggressive && e.hp <= RETREAT_HP && target && w.tick >= until) {
      retreatUntil.set(e.id, w.tick + RETREAT_TICKS);
      const cover = findCover(w.map, e.pos, target.pos);
      if (cover) setDestination(w, e, cover);
    }

    if (!aggressive && w.tick < until) {
      e.state = 'retreat';
      const moving = followPath(e);
      if (target) {
        e.aim = angleTo(e.pos, target.pos);
        if (canFire(w, e)) fire(w, e, e.aim); // fire while withdrawing
      }
      if (!moving && !target) retreatUntil.set(e.id, 0); // safe, resume
      return;
    }

    // --- engage ------------------------------------------------------------
    if (target) {
      e.targetId = target.id;
      const d = dist(e.pos, target.pos);
      e.aim = aimWithLead(e, target, wp.bulletSpeed);

      const lane = hasFiringLane(w.map, e.pos, target.pos, e.radius);

      // Visible but no clean corridor, or stalemate broken open: close in.
      if (!lane || aggressive || d > PREFERRED_RANGE * 1.3) {
        e.state = 'chase';
        setDestination(w, e, target.pos);
        followPath(e);
      } else if (d < PREFERRED_RANGE * 0.6) {
        e.state = 'shoot';
        // Back off, keeping the target in view.
        moveToward(e, {
          x: e.pos.x - Math.cos(e.aim) * 32,
          y: e.pos.y - Math.sin(e.aim) * 32,
        });
      } else {
        e.state = 'shoot';
        e.path = [];
      }

      if (canFire(w, e) && lane) fire(w, e, e.aim);
      return;
    }

    // --- search ------------------------------------------------------------
    e.targetId = null;
    if (wp.ammo < wp.magSize * 0.4) {
      e.state = 'reload';
      startReload(w, e);
      return;
    }

    const hunt = nearestHostile(w, e);
    if (hunt) {
      e.state = 'chase';
      setDestination(w, e, hunt.pos);
      if (followPath(e)) {
        e.aim = Math.atan2(e.vel.y, e.vel.x);
        return;
      }
    }
    e.state = 'idle';
  };
}