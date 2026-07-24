import { TILE, isWallTile, tileCenter, type GameMap } from '../core/map';
import type { Vec2 } from '../core/entity';

interface Node {
  x: number;
  y: number;
  g: number;
  f: number;
  parent: number; // key of parent, -1 for start
}

const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  // Octile distance — admissible for 8-way movement.
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * A* over tiles. Returns world-space waypoints, or [] if unreachable.
 * maxNodes caps the search so a blocked target can't stall a tick.
 */
export function findPath(
  map: GameMap,
  from: Vec2,
  to: Vec2,
  maxNodes = 4000,
): Vec2[] {
  const sx = Math.floor(from.x / TILE);
  const sy = Math.floor(from.y / TILE);
  const gx = Math.floor(to.x / TILE);
  const gy = Math.floor(to.y / TILE);

  if (sx === gx && sy === gy) return [];
  if (isWallTile(map, gx, gy)) return [];

  const key = (x: number, y: number) => y * map.w + x;
  const nodes = new Map<number, Node>();
  const open: number[] = [];
  const closed = new Set<number>();

  const startKey = key(sx, sy);
  nodes.set(startKey, { x: sx, y: sy, g: 0, f: heuristic(sx, sy, gx, gy), parent: -1 });
  open.push(startKey);

  let expanded = 0;

  while (open.length && expanded < maxNodes) {
    // Linear scan for the lowest f. Fine at this map size; swap in a binary
    // heap if maps ever get large enough to matter.
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (nodes.get(open[i])!.f < nodes.get(open[bestIdx])!.f) bestIdx = i;
    }
    const currentKey = open.splice(bestIdx, 1)[0];
    const current = nodes.get(currentKey)!;
    closed.add(currentKey);
    expanded++;

    if (current.x === gx && current.y === gy) {
      const path: Vec2[] = [];
      let k = currentKey;
      while (k !== -1) {
        const n = nodes.get(k)!;
        path.push(tileCenter(n.x, n.y));
        k = n.parent;
      }
      path.reverse();
      path.shift(); // drop the tile we're standing on
      return path;
    }

    for (const [dx, dy, cost] of DIRS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (isWallTile(map, nx, ny)) continue;

      // No cutting diagonal corners through wall pairs.
      if (dx !== 0 && dy !== 0) {
        if (isWallTile(map, current.x + dx, current.y)) continue;
        if (isWallTile(map, current.x, current.y + dy)) continue;
      }

      const nKey = key(nx, ny);
      if (closed.has(nKey)) continue;

      const g = current.g + cost;
      const existing = nodes.get(nKey);
      if (existing && g >= existing.g) continue;

      nodes.set(nKey, {
        x: nx,
        y: ny,
        g,
        f: g + heuristic(nx, ny, gx, gy),
        parent: currentKey,
      });
      if (!existing) open.push(nKey);
    }
  }

  return [];
}