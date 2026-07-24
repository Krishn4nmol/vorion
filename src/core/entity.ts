export interface Vec2 {
  x: number;
  y: number;
}

export type Team = 'player' | 'ally' | 'enemy';

export function sideOf(t: Team): 0 | 1 {
  return t === 'enemy' ? 1 : 0;
}

/** v0 bot states. The behaviour tree in ai/ replaces this in v1. */
export type BotState = 'idle' | 'chase' | 'shoot' | 'reload' | 'retreat';

export interface Weapon {
  damage: number;
  fireRateTicks: number;
  spread: number;      // radians, max deviation
  bulletSpeed: number; // px per tick
  range: number;       // px, bullet despawns past this
  ammo: number;
  magSize: number;
  reloadTicks: number;
  lastFiredTick: number;
  reloadEndTick: number; // 0 = not reloading
}

/**
 * v1 integration point. The LLM commander writes these; the behaviour tree
 * reads them. Nothing in v0 touches this field — it stays null.
 */
export type OrderKind =
  | 'hold'
  | 'advance_to'
  | 'flank'
  | 'suppress'
  | 'retreat'
  | 'regroup';

export interface Order {
  kind: OrderKind;
  target: Vec2 | null;
  targetId: number | null;
  issuedTick: number;
  expiresTick: number;
}

export interface Entity {
  id: number;
  team: Team;
  pos: Vec2;
  vel: Vec2;
  aim: number; // radians
  hp: number;
  maxHp: number;
  radius: number;
  speed: number; // px per tick
  alive: boolean;
  weapon: Weapon;
  state: BotState;
  order: Order | null;
  path: Vec2[];
  pathIndex: number;
  targetId: number | null;
  repathTick: number;
}

export interface Bullet {
  id: number;
  ownerId: number;
  team: Team;
  pos: Vec2;
  vel: Vec2;
  damage: number;
  distanceLeft: number;
}

export function makeRifle(): Weapon {
  return {
    damage: 12,
    fireRateTicks: 7,
    spread: 0.05,
    bulletSpeed: 14,
    range: 640,
    ammo: 30,
    magSize: 30,
    reloadTicks: 120,
    lastFiredTick: -9999,
    reloadEndTick: 0,
  };
}

export function makeEntity(
  id: number,
  team: Team,
  pos: Vec2,
  weapon: Weapon = makeRifle(),
): Entity {
  return {
    id,
    team,
    pos: { x: pos.x, y: pos.y },
    vel: { x: 0, y: 0 },
    aim: 0,
    hp: 100,
    maxHp: 100,
    radius: 10,
    speed: 2.2,
    alive: true,
    weapon,
    state: 'idle',
    order: null,
    path: [],
    pathIndex: 0,
    targetId: null,
    repathTick: 0,
  };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function angleTo(a: Vec2, b: Vec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}