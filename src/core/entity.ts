export interface Vec2 {
  x: number;
  y: number;
}

export type Team = 'player' | 'ally' | 'enemy';

export function sideOf(t: Team): 0 | 1 {
  return t === 'enemy' ? 1 : 0;
}

/** v0 bot states. The behaviour tree in ai/ replaces this in v1. */
export type BotState = 'idle' | 'chase' | 'shoot' | 'reload' | 'retreat' | 'reviving';
export type WeaponId = 'rifle' | 'smg' | 'shotgun' | 'marksman';

export interface Weapon {
  id: WeaponId;
  name: string;
  /** Projectiles per trigger pull. Only the shotgun exceeds 1. */
  pellets: number;
  damage: number;
  // ... rest unchanged
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
  grenades: number;
  /**
   * Bleeding out. A downed unit cannot move, shoot or be commanded, but is not
   * dead: it still counts as a living squad member for win conditions, and can
   * be brought back.
   */
  downed: boolean;
  /** Tick at which an un-revived downed unit dies for good. */
  bleedOutTick: number;
  /** Progress 0..1 while a squadmate is reviving this unit. */
  reviveProgress: number;
  /** How many times this unit has already been brought back. */
  revivesUsed: number;
  downedBy: number;
}

/**
 * Thrown explosive. Decelerates to a stop, then detonates on a fuse — so a
 * grenade lands where you aimed rather than travelling until it hits something.
 */
export interface Grenade {
  id: number;
  ownerId: number;
  team: Team;
  pos: Vec2;
  vel: Vec2;
  fuse: number; // ticks remaining
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

/**
 * Weapon table. Each entry trades along a different axis, so the choice
 * changes how you fight rather than how much damage you do: the shotgun wants
 * doorways, the marksman rifle wants the long road, the SMG wants to be moving.
 */
const TABLE: Record<WeaponId, Omit<Weapon, 'ammo' | 'lastFiredTick' | 'reloadEndTick'>> = {
  rifle: {
    id: 'rifle', name: 'RIFLE', pellets: 1,
    damage: 12, fireRateTicks: 7, spread: 0.05,
    bulletSpeed: 14, range: 640, magSize: 30, reloadTicks: 120,
  },
  smg: {
    id: 'smg', name: 'SMG', pellets: 1,
    damage: 8, fireRateTicks: 4, spread: 0.13,
    bulletSpeed: 13, range: 420, magSize: 36, reloadTicks: 100,
  },
  shotgun: {
    id: 'shotgun', name: 'SHOTGUN', pellets: 7,
    damage: 9, fireRateTicks: 32, spread: 0.24,
    bulletSpeed: 12, range: 290, magSize: 6, reloadTicks: 160,
  },
  marksman: {
    id: 'marksman', name: 'MARKSMAN', pellets: 1,
    damage: 38, fireRateTicks: 36, spread: 0.012,
    bulletSpeed: 22, range: 940, magSize: 8, reloadTicks: 145,
  },
};

export const WEAPON_IDS = Object.keys(TABLE) as WeaponId[];

export function makeWeapon(id: WeaponId): Weapon {
  const base = TABLE[id];
  return { ...base, ammo: base.magSize, lastFiredTick: -9999, reloadEndTick: 0 };
}

export function makeRifle(): Weapon {
  return makeWeapon('rifle');
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
    grenades: 0,
    downed: false,
    bleedOutTick: 0,
    reviveProgress: 0,
    revivesUsed: 0,
    downedBy: -1,
  };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function angleTo(a: Vec2, b: Vec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}