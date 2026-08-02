import { dist, angleTo, sideOf, type Entity, type Order, type Vec2 } from '../core/entity';
import {
  fire,
  startReload,
  canFire,
  isHostile,
  throwGrenade, 
  GRENADE_RADIUS,
  GRENADE_MAX_THROW, 
  GRENADE_FUSE,
  REVIVE_RANGE,
  type Controller,
  type World,
} from '../core/world';
import { moveToward } from '../core/physics';
import { findPath } from './pathfinding';
import { acquireTarget, findCover, aimWithLead, hasFiringLane, canSee } from './vision';

const REPATH_INTERVAL = 30; // ticks
const WAYPOINT_REACHED = 12; // px
const RETREAT_HP = 30;
const RETREAT_TICKS = 180;
const STALEMATE_TICKS = 600; // no damage anywhere for this long -> everyone charges
const ARRIVED = 40; // px, close enough to consider a move order complete
const SUPPRESS_HOLD = 300; // px, how far a suppressing unit will push toward its mark
const GRENADE_COOLDOWN = 300; // ticks between throws by the same unit

/** Only go for a downed squadmate within this far — not across the map. */
const REVIVE_SEEK_RANGE = 300;

/**
 * Nearest downed squadmate worth going to. Bots will not abandon a fight to
 * attempt a revive, so this returns nothing while the unit is in contact and
 * not at full strength — the revive is meant to be a choice with a cost, not a
 * reflex that gets two units killed instead of one.
 */
function reviveTarget(w: World, e: Entity, inContact: boolean): Entity | null {
  // Tightened after measurement: bots that broke off fights too readily turned
  // ten-second matches into thirty-second ones without changing who won.
  if (inContact && e.hp < 80) return null;
  let best: Entity | null = null;
  let bestD = REVIVE_SEEK_RANGE;
  for (const o of w.entities) {
    if (!o.alive || !o.downed || sideOf(o.team) !== sideOf(e.team)) continue;
    const d = dist(e.pos, o.pos);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * Bots fight at a fraction of their weapon's effective range rather than a
 * fixed distance. Shotgun carriers close to knife range, marksmen hang back —
 * behaviour that falls out of the weapon table without any extra AI code.
 */
function preferredRange(e: Entity): number {
  // 0.375 is exact for the rifle (640 * 0.375 = 240), which is the constant
  // the published evaluation was run under. Changing it would silently
  // invalidate those numbers.
  return e.weapon.range * 0.375;
}

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

/** Mean position of this unit's living squadmates. */
function squadCentroid(w: World, e: Entity): Vec2 | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const o of w.entities) {
    if (!o.alive || o.id === e.id || sideOf(o.team) !== sideOf(e.team)) continue;
    sx += o.pos.x;
    sy += o.pos.y;
    n++;
  }
  return n === 0 ? null : { x: sx / n, y: sy / n };
}

/** Direction away from every hostile this unit can currently see. */
function awayFromThreats(w: World, e: Entity): Vec2 {
  let dx = 0;
  let dy = 0;
  for (const o of w.entities) {
    if (!o.alive || !isHostile(e, o)) continue;
    const d = Math.max(1, dist(e.pos, o.pos));
    dx += (e.pos.x - o.pos.x) / d;
    dy += (e.pos.y - o.pos.y) / d;
  }
  const len = Math.hypot(dx, dy) || 1;
  return { x: e.pos.x + (dx / len) * 200, y: e.pos.y + (dy / len) * 200 };
}

/**
 * Decides whether to throw, and where.
 *
 * The rule is deliberately conservative: only when the grenade beats shooting.
 * That means either the target is behind cover the bot cannot shoot through, or
 * two or more hostiles are clustered. It never throws with a squadmate in the
 * blast — friendly fire is real, so a bot that ignored it would lose more units
 * than it killed.
 */
function tryGrenade(w: World, e: Entity, target: Entity, lane: boolean): boolean {
  if (e.grenades <= 0) return false;

  const d = dist(e.pos, target.pos);
  // Too far to reach, or close enough that the thrower is inside its own blast.
  if (d > GRENADE_MAX_THROW || d < GRENADE_RADIUS * 1.3) return false;
  if (!canSee(w.map, e.pos, target.pos, GRENADE_MAX_THROW)) return false;

  // Lead the throw: the fuse is over two seconds, and a moving target will not
  // be standing where it is now.
  const lead = GRENADE_FUSE * 0.45;
  const aim = {
    x: target.pos.x + target.vel.x * lead,
    y: target.pos.y + target.vel.y * lead,
  };

  let hostiles = 0;
  for (const o of w.entities) {
    if (!o.alive) continue;
    if (dist(o.pos, aim) > GRENADE_RADIUS * 0.9) continue;
    if (sideOf(o.team) === sideOf(e.team)) return false; // squadmate in the blast
    hostiles++;
  }
  if (hostiles === 0) return false;

  // Worth a grenade only if shooting is not already working.
  if (hostiles < 2 && lane) return false;

  return throwGrenade(w, e, aim);
}

/**
 * Carries out the movement half of an order. Returns false if the order is
 * finished or impossible, in which case the caller falls back to autonomy.
 *
 * Orders decide WHERE a unit should be. They never decide when to shoot, when
 * to reload, or whether to break contact — those stay with the behaviour tree,
 * which runs every tick instead of every few seconds.
 */
function executeOrder(w: World, e: Entity, order: Order, target: Entity | null): boolean {
  switch (order.kind) {
    case 'advance_to':
    case 'flank': {
      if (!order.target) return false;
      if (dist(e.pos, order.target) <= ARRIVED) return false; // arrived
      e.state = 'chase';
      setDestination(w, e, order.target);
      followPath(e);
      return true;
    }

    case 'regroup': {
      const c = squadCentroid(w, e);
      if (!c || dist(e.pos, c) <= ARRIVED * 2) return false;
      e.state = 'chase';
      setDestination(w, e, c);
      followPath(e);
      return true;
    }

    case 'retreat': {
      const dest = target ? findCover(w.map, e.pos, target.pos) : null;
      setDestination(w, e, dest ?? awayFromThreats(w, e));
      e.state = 'retreat';
      followPath(e);
      return true;
    }

    case 'suppress': {
      if (!order.target) return false;
      const d = dist(e.pos, order.target);
      // Close until the mark is within effective range, then hold and shoot.
      if (d > SUPPRESS_HOLD) {
        e.state = 'chase';
        setDestination(w, e, order.target);
        followPath(e);
        return true;
      }
      // In position but nothing visible: the mark has moved or died. Standing
      // in the open firing at a memory is how ordered squads get wiped, so the
      // order is considered complete and the unit resumes hunting.
      if (!target) return false;
      const cover = findCover(w.map, e.pos, target.pos, 3);
      if (cover && dist(e.pos, cover) > ARRIVED) {
        setDestination(w, e, cover);
        followPath(e);
      } else {
        e.path = [];
      }
      e.state = 'shoot';
      return true;
    }

    case 'hold': {
      // Standing still in the open is how ordered squads die. Take cover from
      // whatever is currently threatening, but do not leave the position.
      if (target) {
        const cover = findCover(w.map, e.pos, target.pos, 3);
        if (cover && dist(e.pos, cover) > ARRIVED) {
          setDestination(w, e, cover);
          followPath(e);
          e.state = 'shoot';
          return true;
        }
      }
      e.path = [];
      e.state = 'shoot';
      return true;
    }
  }
}

/**
 * Rule-based bot, now order-aware. With no orders it behaves exactly as the v0
 * baseline — that equivalence is what makes the v2 comparison meaningful.
 */
export function makeBotController(): Controller {
  const retreatUntil = new Map<number, number>();
  const grenadeReady = new Map<number, number>();

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
    // --- revive -------------------------------------------------------------
    // Checked before engagement: a squadmate bleeding out is worth more than
    // another few rounds downrange, provided this unit is not itself in
    // trouble.
    const casualty = reviveTarget(w, e, target !== null);
    if (casualty) {
      const d = dist(e.pos, casualty.pos);
      if (d > REVIVE_RANGE * 0.8) {
        e.state = 'chase';
        setDestination(w, e, casualty.pos);
        followPath(e);
      } else {
        e.state = 'reviving';
        e.path = [];
      }
      // Still shoots while working — standing over a casualty is exposed
      // enough without also being defenceless.
      if (target) {
        e.aim = aimWithLead(e, target, wp.bulletSpeed);
        if (canFire(w, e) && hasFiringLane(w.map, e.pos, target.pos, e.radius)) {
          fire(w, e, e.aim);
        }
      }
      return;
    }
    const order = e.order && w.tick < e.order.expiresTick ? e.order : null;
    if (e.order && !order) e.order = null; // expired

    // --- retreat -----------------------------------------------------------
    // Only an explicit 'hold' makes a unit stand its ground while wounded, and
    // even then executeOrder puts it in cover. Everything else yields to
    // survival — an order that gets your unit killed served nobody.
    const orderOverridesRetreat = order?.kind === 'hold';
    if (!aggressive && !orderOverridesRetreat && e.hp <= RETREAT_HP && target && w.tick >= until) {
      retreatUntil.set(e.id, w.tick + RETREAT_TICKS);
      const cover = findCover(w.map, e.pos, target.pos);
      if (cover) setDestination(w, e, cover);
    }

    if (!aggressive && !orderOverridesRetreat && w.tick < until) {
      e.state = 'retreat';
      const moving = followPath(e);
      if (target) {
        e.aim = angleTo(e.pos, target.pos);
        if (canFire(w, e)) fire(w, e, e.aim); // fire while withdrawing
      }
      if (!moving && !target) retreatUntil.set(e.id, 0); // safe, resume
      return;
    }

    // --- ordered movement ---------------------------------------------------
    // Runs before autonomous engagement so a unit under orders keeps shooting
    // at whatever it sees without abandoning where it was told to go.
    if (order && !aggressive) {
      const moving = executeOrder(w, e, order, target);
      if (moving) {
        if (target) {
          e.targetId = target.id;
          e.aim = aimWithLead(e, target, wp.bulletSpeed);
          const lane = hasFiringLane(w.map, e.pos, target.pos, e.radius);
          // A flanking unit avoids picking long-range fights it was sent to
          // avoid, but always returns fire on anything close enough to hurt it.
          const nextThrow = grenadeReady.get(e.id) ?? 0;
          if (w.tick >= nextThrow && tryGrenade(w, e, target, lane)) {
          grenadeReady.set(e.id, w.tick + GRENADE_COOLDOWN);
          }
          const engageRange =
            order.kind === 'flank' ? preferredRange(e) : e.weapon.range;
          if (canFire(w, e) && lane && dist(e.pos, target.pos) <= engageRange) {
            fire(w, e, e.aim);
          }
        }
        return;
      }
      e.order = null; // order complete or impossible — resume autonomy
    }

    // --- engage ------------------------------------------------------------
    if (target) {
      e.targetId = target.id;
      const d = dist(e.pos, target.pos);
      e.aim = aimWithLead(e, target, wp.bulletSpeed);

      const lane = hasFiringLane(w.map, e.pos, target.pos, e.radius);

      // Visible but no clean corridor, or stalemate broken open: close in.
      const pref = preferredRange(e);
      if (!lane || aggressive || d > pref * 1.3) {
        e.state = 'chase';
        setDestination(w, e, target.pos);
        followPath(e);
      } else if (d < pref * 0.6) {
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