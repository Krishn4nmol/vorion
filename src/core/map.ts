import { SeededRNG } from './rng';
import type { Vec2 } from './entity';

export const TILE = 32;

/** Tile types. Anything >= SOLID_FROM blocks movement, bullets and sight. */
export const T_GROUND = 0; // open dirt
export const T_ROAD = 1;
export const T_INTERIOR = 2; // building floor
export const T_DOOR = 3; // threshold, walkable
export const T_WALL = 4;
export const T_COVER = 5; // crates, sandbags
export const SOLID_FROM = T_WALL;

export interface Building {
  name: string;
  x: number; // tile coords of top-left
  y: number;
  w: number;
  h: number;
}

export interface GameMap {
  w: number; // tiles
  h: number;
  tiles: Uint8Array;
  buildings: Building[]; // named regions — the vocabulary the v1 commander uses
}

export function tileAt(m: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return T_WALL;
  return m.tiles[ty * m.w + tx];
}

export function isWallTile(m: GameMap, tx: number, ty: number): boolean {
  return tileAt(m, tx, ty) >= SOLID_FROM;
}

/** World pixel coords -> wall test. */
export function isWallAt(m: GameMap, wx: number, wy: number): boolean {
  return isWallTile(m, Math.floor(wx / TILE), Math.floor(wy / TILE));
}

export function tileCenter(tx: number, ty: number): Vec2 {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

const NAMES = [
  'WAREHOUSE', 'DEPOT', 'BARRACKS', 'HANGAR', 'GARAGE', 'SILO',
  'WORKSHOP', 'STORES', 'OUTPOST', 'MESS HALL', 'MOTOR POOL', 'ARMOURY',
];

function set(m: GameMap, tx: number, ty: number, v: number): void {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return;
  m.tiles[ty * m.w + tx] = v;
}

function fillRect(m: GameMap, x: number, y: number, w: number, h: number, v: number): void {
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) set(m, tx, ty, v);
  }
}

function overlaps(a: Building, b: Building, pad: number): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

/** Carves a building: walls, interior, internal partition, doors. */
function carveBuilding(m: GameMap, b: Building, rng: SeededRNG): void {
  fillRect(m, b.x, b.y, b.w, b.h, T_WALL);
  fillRect(m, b.x + 1, b.y + 1, b.w - 2, b.h - 2, T_INTERIOR);

  // Optional internal partition with its own doorway.
  if (b.w >= 9 && b.h >= 7 && rng.next() < 0.65) {
    if (b.w > b.h) {
      const cx = b.x + Math.floor(b.w / 2);
      for (let ty = b.y + 1; ty < b.y + b.h - 1; ty++) set(m, cx, ty, T_WALL);
      const gap = b.y + 1 + rng.int(0, b.h - 2);
      set(m, cx, gap, T_DOOR);
    } else {
      const cy = b.y + Math.floor(b.h / 2);
      for (let tx = b.x + 1; tx < b.x + b.w - 1; tx++) set(m, tx, cy, T_WALL);
      const gap = b.x + 1 + rng.int(0, b.w - 2);
      set(m, gap, cy, T_DOOR);
    }
  }

  // Exterior doors, at least two so interiors are never a dead end.
  const doors = 2 + rng.int(0, 2);
  for (let i = 0; i < doors; i++) {
    const side = rng.int(0, 4);
    if (side === 0) set(m, b.x + 1 + rng.int(0, b.w - 2), b.y, T_DOOR);
    else if (side === 1) set(m, b.x + 1 + rng.int(0, b.w - 2), b.y + b.h - 1, T_DOOR);
    else if (side === 2) set(m, b.x, b.y + 1 + rng.int(0, b.h - 2), T_DOOR);
    else set(m, b.x + b.w - 1, b.y + 1 + rng.int(0, b.h - 2), T_DOOR);
  }

  // A little cover inside.
  const crates = rng.int(0, 3);
  for (let i = 0; i < crates; i++) {
    const cx = b.x + 2 + rng.int(0, Math.max(1, b.w - 4));
    const cy = b.y + 2 + rng.int(0, Math.max(1, b.h - 4));
    if (tileAt(m, cx, cy) === T_INTERIOR) set(m, cx, cy, T_COVER);
  }
}

/**
 * Compound-style map: open ground, roads, walled buildings with doors and
 * interior rooms, scattered hard cover. Structure is what makes flanking and
 * holding a position mean something — random blocks never did.
 */
export function generateMap(w: number, h: number, rng: SeededRNG): GameMap {
  const m: GameMap = { w, h, tiles: new Uint8Array(w * h), buildings: [] };

  fillRect(m, 0, 0, w, h, T_GROUND);

  // Roads: one horizontal spine, one or two crossing lanes.
  const roadY = Math.floor(h / 2) + rng.int(-3, 4);
  fillRect(m, 1, roadY - 1, w - 2, 3, T_ROAD);
  const lanes = 1 + rng.int(0, 2);
  for (let i = 0; i < lanes; i++) {
    const rx = Math.floor((w / (lanes + 1)) * (i + 1)) + rng.int(-3, 4);
    fillRect(m, rx - 1, 1, 3, h - 2, T_ROAD);
  }

  // Buildings, rejection-sampled so they never touch.
  const wanted = 7 + rng.int(0, 4);
  const used = new Set<number>();
  let attempts = 0;
  while (m.buildings.length < wanted && attempts < 400) {
    attempts++;
    const bw = 7 + rng.int(0, 8);
    const bh = 6 + rng.int(0, 7);
    const bx = 2 + rng.int(0, Math.max(1, w - bw - 4));
    const by = 2 + rng.int(0, Math.max(1, h - bh - 4));

    const cand: Building = { name: '', x: bx, y: by, w: bw, h: bh };
    if (m.buildings.some((b) => overlaps(cand, b, 3))) continue;

    // Claim a name only once the placement is accepted, or rejected
    // candidates burn through the pool and later buildings share names.
    let nameIdx = rng.int(0, NAMES.length);
    let guard = 0;
    while (used.has(nameIdx) && guard++ < NAMES.length) nameIdx = (nameIdx + 1) % NAMES.length;
    used.add(nameIdx);
    cand.name = NAMES[nameIdx];

    m.buildings.push(cand);
    carveBuilding(m, cand, rng);
  }

  // Outdoor cover, avoiding roads so lanes stay usable.
  const crates = 24 + rng.int(0, 18);
  for (let i = 0; i < crates; i++) {
    const cx = 2 + rng.int(0, w - 4);
    const cy = 2 + rng.int(0, h - 4);
    if (tileAt(m, cx, cy) !== T_GROUND) continue;
    set(m, cx, cy, T_COVER);
    if (rng.next() < 0.4) set(m, cx + 1, cy, T_COVER); // small clusters
  }

  // Map border.
  for (let x = 0; x < w; x++) {
    set(m, x, 0, T_WALL);
    set(m, x, h - 1, T_WALL);
  }
  for (let y = 0; y < h; y++) {
    set(m, 0, y, T_WALL);
    set(m, w - 1, y, T_WALL);
  }

  pruneUnreachable(m);
  return m;
}

/**
 * Flood-fills from the largest open region and walls off anything cut off from
 * it. Guarantees every walkable tile is reachable, so bots can never be given
 * an impossible destination.
 */
function pruneUnreachable(m: GameMap): void {
  const seen = new Int32Array(m.w * m.h).fill(-1);
  const regions: number[][] = [];

  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const k = y * m.w + x;
      if (isWallTile(m, x, y) || seen[k] !== -1) continue;
      const id = regions.length;
      const cells: number[] = [];
      const stack = [k];
      seen[k] = id;
      while (stack.length) {
        const cur = stack.pop()!;
        cells.push(cur);
        const cx = cur % m.w;
        const cy = (cur / m.w) | 0;
        const nbrs = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of nbrs) {
          if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
          const nk = ny * m.w + nx;
          if (isWallTile(m, nx, ny) || seen[nk] !== -1) continue;
          seen[nk] = id;
          stack.push(nk);
        }
      }
      regions.push(cells);
    }
  }

  if (regions.length <= 1) return;
  let biggest = 0;
  for (let i = 1; i < regions.length; i++) {
    if (regions[i].length > regions[biggest].length) biggest = i;
  }
  for (let i = 0; i < regions.length; i++) {
    if (i === biggest) continue;
    for (const k of regions[i]) m.tiles[k] = T_WALL;
  }
}

/** Nearest walkable tile to a given tile, breadth-first. Used for spawns. */
export function nearestFloor(m: GameMap, tx: number, ty: number): Vec2 {
  const seen = new Set<number>();
  const queue: number[][] = [[tx, ty]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    const key = y * m.w + x;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isWallTile(m, x, y)) return { x, y };
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return { x: 1, y: 1 };
}

/** Which named building contains this point, if any. */
export function buildingAt(m: GameMap, p: Vec2): Building | null {
  const tx = Math.floor(p.x / TILE);
  const ty = Math.floor(p.y / TILE);
  for (const b of m.buildings) {
    if (tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h) return b;
  }
  return null;
}

/** Bresenham over tiles. True if no wall blocks the segment. */
export function lineOfSight(m: GameMap, a: Vec2, b: Vec2): boolean {
  let x0 = Math.floor(a.x / TILE);
  let y0 = Math.floor(a.y / TILE);
  const x1 = Math.floor(b.x / TILE);
  const y1 = Math.floor(b.y / TILE);

  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    if (isWallTile(m, x0, y0)) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}