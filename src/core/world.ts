import { SeededRNG } from './rng';
import {
  makeEntity,
  makeRifle,
  makeWeapon,
  dist,
  sideOf,
  WEAPON_IDS,
  type Entity,
  type Bullet,
  type WeaponId,
  type Grenade, 
  type Vec2
} from './entity';
import {
  generateMap,
  nearestFloor,
  tileCenter,
  lineOfSight,
  isWallAt,
  type GameMap,
} from './map';
import { moveEntity, stepBullets } from './physics';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export type GameEvent =
  | { type: 'fire'; tick: number; shooterId: number; pellets: number }
  | {
      type: 'damage';
      tick: number;
      victimId: number;
      shooterId: number;
      amount: number;
      /** Blast damage: counted for damage totals, but never for accuracy. */
      explosive?: boolean;
    }
  | {
      type: 'death';
      tick: number;
      victimId: number;
      killerId: number;
      /** Same-side kill. Counted as a death, but never credited as a kill. */
      friendly: boolean;
    }
  | { type: 'reload'; tick: number; entityId: number }
  /**
   * Where a bullet stopped. Purely informational — nothing in the simulation
   * reads it — but without it the renderer has no way to know a round struck a
   * wall, since only entity hits produce damage.
   */
  | { type: 'impact'; tick: number; x: number; y: number; onEntity: boolean }
  | { type: 'explosion'; tick: number; x: number; y: number; radius: number }
  | { type: 'downed'; tick: number; victimId: number; shooterId: number }
  | { type: 'revived'; tick: number; entityId: number; medicId: number };

export interface World {
  tick: number;
  seed: number;
  rng: SeededRNG;
  map: GameMap;
  entities: Entity[];
  bullets: Bullet[];
  grenades: Grenade[];
  events: GameEvent[]; // cleared each tick; drained by render, eval and trace logging
  nextId: number;
  over: boolean;
  revives: boolean;
  endless: boolean;
}

export interface WorldOptions {
  mapW?: number;
  mapH?: number;
  allies?: number;
  enemies?: number;
  /**
   * 'uniform' gives everyone a rifle — the loadout the published evaluation
   * was measured under, and therefore the default. The game passes 'varied'.
   */
  weapons?: 'uniform' | 'varied';
  /** Overrides the player's weapon regardless of the mode above. */
  playerWeapon?: WeaponId;
  /** Grenades per unit. 0 keeps bot behaviour identical to the eval baseline. */
  grenades?: number;
  revives?: boolean;
  endless?: boolean;
}

export function createWorld(seed: number, opts: WorldOptions = {}): World {
  const { mapW = 64, mapH = 48, allies = 3, enemies = 4, weapons = 'uniform',
  playerWeapon, grenades = 0, revives = false, endless = false,} = opts;
  const rng = new SeededRNG(seed);
  const map = generateMap(mapW, mapH, rng);

  const world: World = {
    tick: 0,
    seed,
    rng,
    map,
    entities: [],
    bullets: [],
    grenades: [],
    events: [],
    nextId: 1,
    over: false,
    revives,
    endless,
  };

  const pickWeapon = (team: Entity['team']): Entity['weapon'] => {
    if (team === 'player' && playerWeapon) return makeWeapon(playerWeapon);
    if (weapons === 'uniform') return makeRifle();
    // Drawn from the world RNG, so a varied match is still reproducible.
    return makeWeapon(rng.pick(WEAPON_IDS));
  };

  const spawn = (team: Entity['team'], tx: number, ty: number): Entity => {
    const t = nearestFloor(map, tx, ty);
    const e = makeEntity(world.nextId++, team, tileCenter(t.x, t.y), pickWeapon(team));
    e.grenades = grenades;
    world.entities.push(e);
    return e;
  };

  // Squads deploy from opposite edges, spread down the map.
  const midY = Math.floor(mapH / 2);
  spawn('player', 3, midY);
  for (let i = 0; i < allies; i++) {
    spawn('ally', 3 + (i % 2), midY - 6 + i * 5);
  }
  for (let i = 0; i < enemies; i++) {
    spawn('enemy', mapW - 4 - (i % 2), midY - 8 + i * 5);
  }

  return world;
}

/**
 * Adds a unit mid-match. Used by the survival spawner; nothing in the
 * evaluation calls it, so match composition there is still fixed at creation.
 */
export function spawnUnit(
  w: World,
  team: Entity['team'],
  tile: { x: number; y: number },
  weapon: WeaponId,
  grenades = 0,
): Entity {
  const t = nearestFloor(w.map, tile.x, tile.y);
  const e = makeEntity(w.nextId++, team, tileCenter(t.x, t.y), makeWeapon(weapon));
  e.grenades = grenades;
  w.entities.push(e);
  return e;
}

export function getEntity(w: World, id: number | null): Entity | null {
  if (id === null) return null;
  return w.entities.find((e) => e.id === id) ?? null;
}

export function isHostile(a: Entity, b: Entity): boolean {
  return sideOf(a.team) !== sideOf(b.team);
}

export function nearestVisibleEnemy(w: World, e: Entity): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const other of w.entities) {
    if (!other.alive || !isHostile(e, other)) continue;
    const d = dist(e.pos, other.pos);
    if (d < bestD && lineOfSight(w.map, e.pos, other.pos)) {
      best = other;
      bestD = d;
    }
  }
  return best;
}

export function canFire(w: World, e: Entity): boolean {
  const wp = e.weapon;
  if (wp.reloadEndTick > w.tick) return false;
  if (wp.ammo <= 0) return false;
  return w.tick - wp.lastFiredTick >= wp.fireRateTicks;
}

export function fire(w: World, e: Entity, angle: number): void {
  if (!canFire(w, e)) return;
  const wp = e.weapon;

  // One trigger pull, `pellets` projectiles. Each gets its own spread roll, so
  // a shotgun throws a genuine cone rather than a tight clump.
  for (let i = 0; i < wp.pellets; i++) {
    const a = angle + w.rng.range(-wp.spread, wp.spread);
    w.bullets.push({
      id: w.nextId++,
      ownerId: e.id,
      team: e.team,
      pos: {
        x: e.pos.x + Math.cos(a) * (e.radius + 2),
        y: e.pos.y + Math.sin(a) * (e.radius + 2),
      },
      vel: { x: Math.cos(a) * wp.bulletSpeed, y: Math.sin(a) * wp.bulletSpeed },
      damage: wp.damage,
      distanceLeft: wp.range,
    });
  }

  wp.ammo--;
  wp.lastFiredTick = w.tick;
  e.aim = angle;
  // Pellet count travels with the event so accuracy can be computed per
  // projectile. A shotgun throws seven, and counting one shot against seven
  // possible hits produced accuracy above 100%.
  w.events.push({ type: 'fire', tick: w.tick, shooterId: e.id, pellets: wp.pellets });
}

export const BLEED_OUT_TICKS = 420; // 7s to reach a downed squadmate
export const REVIVE_RANGE = 34; // px — you must stand over them
export const REVIVE_TICKS = 190; // ~3.2s of standing still, exposed
/**
 * A unit can be brought back this many times. Without a cap, two squads revive
 * each other faster than they kill and matches triple in length — measured at
 * 620 -> 2012 ticks with unlimited revives.
 */
export const MAX_REVIVES = 1;

/**
 * Applies damage, and routes it to a downed state rather than death when the
 * mode is on. Every damage path funnels through here so bullets, blasts and
 * anything added later share one definition of dying.
 */
export function applyDamage(
  w: World,
  victim: Entity,
  amount: number,
  shooterId: number,
  explosive = false,
): void {
  if (!victim.alive) return;

  // A downed unit takes no further damage. Otherwise stray fire in a firefight
  // executes them instantly and the revive window never exists.
  if (victim.downed) return;

  victim.hp -= amount;
  w.events.push({
    type: 'damage',
    tick: w.tick,
    victimId: victim.id,
    shooterId,
    amount,
    explosive,
  });
  if (victim.hp > 0) return;

  victim.hp = 0;

  if (w.revives && victim.revivesUsed < MAX_REVIVES) {
    victim.downed = true;
    victim.downedBy = shooterId;
    victim.bleedOutTick = w.tick + BLEED_OUT_TICKS;
    victim.reviveProgress = 0;
    victim.vel.x = 0;
    victim.vel.y = 0;
    victim.path = [];
    w.events.push({ type: 'downed', tick: w.tick, victimId: victim.id, shooterId });
    return;
  }

  victim.alive = false;
  w.events.push({
    type: 'death',
    tick: w.tick,
    victimId: victim.id,
    killerId: shooterId,
    friendly: isFriendlyKill(w, victim, shooterId),
  });
}

/** True when the killer is on the victim's own side, or is the victim. */
function isFriendlyKill(w: World, victim: Entity, killerId: number): boolean {
  if (killerId === victim.id) return true;
  const killer = w.entities.find((x) => x.id === killerId);
  return !killer || sideOf(killer.team) === sideOf(victim.team);
}

/**
 * Bleed-out and revives. A unit standing within range of a downed squadmate
 * revives it; progress decays if they leave, so an interrupted revive is a
 * setback rather than a restart.
 */
function stepDowned(w: World): void {
  if (!w.revives) return;

  for (const e of w.entities) {
    if (!e.alive || !e.downed) continue;

    const medic = w.entities.find(
      (o) =>
        o.alive &&
        !o.downed &&
        o.id !== e.id &&
        sideOf(o.team) === sideOf(e.team) &&
        dist(o.pos, e.pos) <= REVIVE_RANGE,
    );

    if (medic) {
      e.reviveProgress += 1 / REVIVE_TICKS;
      if (e.reviveProgress >= 1) {
        e.downed = false;
        e.reviveProgress = 0;
        e.revivesUsed++;
        e.downedBy = -1;
        e.hp = Math.round(e.maxHp * 0.45); // back up, but fragile // back up, but fragile
        e.weapon.ammo = e.weapon.magSize;
        w.events.push({ type: 'revived', tick: w.tick, entityId: e.id, medicId: medic.id });
      }
      continue;
    }

    e.reviveProgress = Math.max(0, e.reviveProgress - 0.4 / REVIVE_TICKS);
    if (w.tick >= e.bleedOutTick) {
      e.alive = false;
      e.downed = false;
      // Credited to whoever downed them: bleeding out is the delayed result of
      // being shot, not a suicide.
      const killerId = e.downedBy >= 0 ? e.downedBy : e.id;
      w.events.push({
        type: 'death',
        tick: w.tick,
        victimId: e.id,
        killerId,
        friendly: isFriendlyKill(w, e, killerId),
      });
    }
  }
}

export const GRENADE_FUSE = 130; // ~2.2s
export const GRENADE_RADIUS = 96; // px, three tiles
export const GRENADE_MAX_THROW = 330; // px
const GRENADE_DRAG = 0.93;

/**
 * Throws toward a world point. Initial speed is solved from the drag so the
 * grenade comes to rest at roughly the aimed spot: for a geometric decay the
 * total distance is v0 / (1 - drag).
 */
export function throwGrenade(w: World, e: Entity, target: Vec2): boolean {
  if (e.grenades <= 0) return false;
  e.grenades--;

  const dx = target.x - e.pos.x;
  const dy = target.y - e.pos.y;
  const d = Math.min(GRENADE_MAX_THROW, Math.hypot(dx, dy)) || 1;
  const v0 = d * (1 - GRENADE_DRAG);
  const a = Math.atan2(dy, dx);

  w.grenades.push({
    id: w.nextId++,
    ownerId: e.id,
    team: e.team,
    pos: { x: e.pos.x + Math.cos(a) * (e.radius + 3), y: e.pos.y + Math.sin(a) * (e.radius + 3) },
    vel: { x: Math.cos(a) * v0, y: Math.sin(a) * v0 },
    fuse: GRENADE_FUSE,
  });
  return true;
}

/**
 * Advances grenades and detonates the expired ones. Blast damage falls off
 * with distance and does NOT pass through walls, so a corner is real cover —
 * and it hurts both sides, which is what makes throwing a decision rather than
 * a free action.
 */
function stepGrenades(w: World): void {
  const survivors: Grenade[] = [];

  for (const g of w.grenades) {
    // Axis-separated like entity movement, and bouncing rather than stopping,
    // so a grenade thrown into a doorway behaves plausibly.
    const nx = g.pos.x + g.vel.x;
    if (!isWallAt(w.map, nx, g.pos.y)) g.pos.x = nx;
    else g.vel.x *= -0.4;
    const ny = g.pos.y + g.vel.y;
    if (!isWallAt(w.map, g.pos.x, ny)) g.pos.y = ny;
    else g.vel.y *= -0.4;

    g.vel.x *= GRENADE_DRAG;
    g.vel.y *= GRENADE_DRAG;
    g.fuse--;

    if (g.fuse > 0) {
      survivors.push(g);
      continue;
    }

    w.events.push({
      type: 'explosion',
      tick: w.tick,
      x: g.pos.x,
      y: g.pos.y,
      radius: GRENADE_RADIUS,
    });

    for (const e of w.entities) {
      if (!e.alive) continue;
      const d = dist(e.pos, g.pos);
      if (d > GRENADE_RADIUS) continue;
      if (!lineOfSight(w.map, g.pos, e.pos)) continue;

      const falloff = 1 - d / GRENADE_RADIUS;
      applyDamage(w, e, Math.round(12 + 48 * falloff * falloff), g.ownerId, true);
    }
  }

  w.grenades.length = 0;
  w.grenades.push(...survivors);
}

export function startReload(w: World, e: Entity): void {
  const wp = e.weapon;
  if (wp.reloadEndTick > w.tick || wp.ammo === wp.magSize) return;
  wp.reloadEndTick = w.tick + wp.reloadTicks;
  w.events.push({ type: 'reload', tick: w.tick, entityId: e.id });
}

function finishReloads(w: World): void {
  for (const e of w.entities) {
    const wp = e.weapon;
    if (wp.reloadEndTick > 0 && wp.reloadEndTick <= w.tick) {
      wp.ammo = wp.magSize;
      wp.reloadEndTick = 0;
    }
  }
}

/**
 * A controller decides one entity's intent for this tick: set vel, set aim,
 * call fire()/startReload(). v1 passes the behaviour tree reading entity.order.
 */
export type Controller = (w: World, e: Entity) => void;

export function step(w: World, controllers: Map<number, Controller>): void {
  w.events.length = 0;

  stepGrenades(w);
  stepDowned(w);
  finishReloads(w);

  for (const e of w.entities) {
    if (!e.alive) continue;
    e.vel.x = 0;
    e.vel.y = 0;
    if (e.downed) continue;
    const c = controllers.get(e.id);
    if (c) c(w, e);
  }

  for (const e of w.entities) {
    if (e.alive) moveEntity(w.map, e);
  }

  const hits = stepBullets(w.map, w.bullets, w.entities);
  for (const hit of hits) {
    const victim = hit.victim;
    w.events.push({
      type: 'impact',
      tick: w.tick,
      x: hit.bullet.pos.x,
      y: hit.bullet.pos.y,
      onEntity: victim !== null,
    });
    if (!victim) continue;
    applyDamage(w, victim, hit.bullet.damage, hit.bullet.ownerId);
  }

  const friendliesLeft = w.entities.some((e) => e.alive && e.team !== 'enemy');
  const enemiesLeft = w.entities.some((e) => e.alive && e.team === 'enemy');
  // In endless mode an empty battlefield is an intermission, not a result.
  if (!friendliesLeft || (!enemiesLeft && !w.endless)) w.over = true;

  w.tick++;
}

/** Snapshot for eval and for the v1 commander prompt. */
export function summary(w: World) {
  return {
    tick: w.tick,
    over: w.over,
    alive: w.entities
      .filter((e) => e.alive)
      .map((e) => ({ id: e.id, team: e.team, hp: e.hp, ammo: e.weapon.ammo })),
  };
}