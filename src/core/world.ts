import { SeededRNG } from './rng';
import {
  makeEntity,
  makeRifle,
  dist,
  type Entity,
  type Bullet,
} from './entity';
import {
  generateArena,
  nearestFloor,
  tileCenter,
  lineOfSight,
  type GameMap,
} from './map';
import { moveEntity, stepBullets } from './physics';

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export type GameEvent =
  | { type: 'fire'; tick: number; shooterId: number }
  | { type: 'damage'; tick: number; victimId: number; shooterId: number; amount: number }
  | { type: 'death'; tick: number; victimId: number; killerId: number }
  | { type: 'reload'; tick: number; entityId: number };

export interface World {
  tick: number;
  seed: number;
  rng: SeededRNG;
  map: GameMap;
  entities: Entity[];
  bullets: Bullet[];
  events: GameEvent[]; // cleared each tick; drained by render, eval and trace logging
  nextId: number;
  over: boolean;
}

export interface WorldOptions {
  mapW?: number;
  mapH?: number;
  allies?: number;
  enemies?: number;
}

export function createWorld(seed: number, opts: WorldOptions = {}): World {
  const { mapW = 40, mapH = 30, allies = 3, enemies = 4 } = opts;
  const rng = new SeededRNG(seed);
  const map = generateArena(mapW, mapH, rng);

  const world: World = {
    tick: 0,
    seed,
    rng,
    map,
    entities: [],
    bullets: [],
    events: [],
    nextId: 1,
    over: false,
  };

  const spawn = (team: Entity['team'], tx: number, ty: number): Entity => {
    const t = nearestFloor(map, tx, ty);
    const e = makeEntity(world.nextId++, team, tileCenter(t.x, t.y), makeRifle());
    world.entities.push(e);
    return e;
  };

  spawn('player', 3, Math.floor(mapH / 2));
  for (let i = 0; i < allies; i++) spawn('ally', 3 + (i % 2), 3 + i * 3);
  for (let i = 0; i < enemies; i++) spawn('enemy', mapW - 4 - (i % 2), 3 + i * 3);

  return world;
}

export function getEntity(w: World, id: number | null): Entity | null {
  if (id === null) return null;
  return w.entities.find((e) => e.id === id) ?? null;
}

export function isHostile(a: Entity, b: Entity): boolean {
  const aSide = a.team === 'enemy' ? 1 : 0;
  const bSide = b.team === 'enemy' ? 1 : 0;
  return aSide !== bSide;
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
  const spread = w.rng.range(-wp.spread, wp.spread);
  const a = angle + spread;

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

  wp.ammo--;
  wp.lastFiredTick = w.tick;
  e.aim = angle;
  w.events.push({ type: 'fire', tick: w.tick, shooterId: e.id });
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

  finishReloads(w);

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