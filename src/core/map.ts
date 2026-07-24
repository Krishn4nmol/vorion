import { SeededRNG } from './rng';
import type { Vec2 } from './entity';

export const TILE = 32;

export interface GameMap {
  w: number; // tiles
  h: number;
  tiles: Uint8Array; // 0 = floor, 1 = wall
}

export function tileAt(m: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return 1;
  return m.tiles[ty * m.w + tx];
}

export function isWallTile(m: GameMap, tx: number, ty: number): boolean {
  return tileAt(m, tx, ty) === 1;
}

/** World pixel coords -> wall test. */
export function isWallAt(m: GameMap, wx: number, wy: number): boolean {
  return isWallTile(m, Math.floor(wx / TILE), Math.floor(wy / TILE));
}

export function tileCenter(tx: number, ty: number): Vec2 {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

/** Solid border plus scattered rectangular cover blocks. */
export function generateArena(w: number, h: number, rng: SeededRNG): GameMap {
  const tiles = new Uint8Array(w * h);
  const m: GameMap = { w, h, tiles };

  for (let x = 0; x < w; x++) {
    tiles[x] = 1;
    tiles[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    tiles[y * w] = 1;
    tiles[y * w + (w - 1)] = 1;
  }

  const blocks = rng.int(8, 14);
  for (let i = 0; i < blocks; i++) {
    const bw = rng.int(2, 6);
    const bh = rng.int(2, 6);
    const bx = rng.int(2, Math.max(3, w - bw - 2));
    const by = rng.int(2, Math.max(3, h - bh - 2));
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        tiles[y * w + x] = 1;
      }
    }
  }
  return m;
}

/** Nearest open tile to a given tile, breadth-first. Used for spawns. */
export function nearestFloor(m: GameMap, tx: number, ty: number): Vec2 {
  const seen = new Set<number>();
  const queue: number[][] = [[tx, ty]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    const key = y * m.w + x;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isWallTile(m, x, y)) return { x, y };
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return { x: 1, y: 1 };
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