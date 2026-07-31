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
  | { type: 'fire'; tick: number; shooterId: number }
  | { type: 'damage'; tick: number; victimId: number; shooterId: number; amount: number }
  | { type: 'death'; tick: number; victimId: number; killerId: number }
  | { type: 'reload'; tick: number; entityId: number }
  /**
   * Where a bullet stopped. Purely informational — nothing in the simulation
   * reads it — but without it the renderer has no way to know a round struck a
   * wall, since only entity hits produce damage.
   */
  | { type: 'impact'; tick: number; x: number; y: number; onEntity: boolean }
  | { type: 'explosion'; tick: number; x: number; y: number; radius: number };

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
}

export function createWorld(seed: number, opts: WorldOptions = {}): World {
  const { mapW = 64, mapH = 48, allies = 3, enemies = 4, weapons = 'uniform',
  playerWeapon, grenades = 0,} = opts;
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
  w.events.push({ type: 'fire', tick: w.tick, shooterId: e.id });
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
      const amount = Math.round(12 + 48 * falloff * falloff);
      e.hp -= amount;
      w.events.push({
        type: 'damage',
        tick: w.tick,
        victimId: e.id,
        shooterId: g.ownerId,
        amount,
      });
      if (e.hp <= 0) {
        e.hp = 0;
        e.alive = false;
        w.events.push({ type: 'death', tick: w.tick, victimId: e.id, killerId: g.ownerId });
      }
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
  finishReloads(w);

  for (const e of w.entities) {
    if (!e.alive) continue;
    e.vel.x = 0;
    e.vel.y = 0;
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
    if (!victim || !victim.alive) continue;
    victim.hp -= hit.bullet.damage;
    w.events.push({
      type: 'damage',
      tick: w.tick,
      victimId: victim.id,
      shooterId: hit.bullet.ownerId,
      amount: hit.bullet.damage,
    });
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      w.events.push({
        type: 'death',
        tick: w.tick,
        victimId: victim.id,
        killerId: hit.bullet.ownerId,
      });
    }
  }

  const friendliesLeft = w.entities.some((e) => e.alive && e.team !== 'enemy');
  const enemiesLeft = w.entities.some((e) => e.alive && e.team === 'enemy');
  if (!friendliesLeft || !enemiesLeft) w.over = true;

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