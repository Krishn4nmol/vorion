import { lineOfSight, isWallTile, tileCenter, TILE, type GameMap } from '../core/map';
import { dist, type Entity, type Vec2 } from '../core/entity';
import { isHostile, type World } from '../core/world';

export const SIGHT_RANGE = 430;

export function canSee(map: GameMap, from: Vec2, to: Vec2, range = SIGHT_RANGE): boolean {
  if (dist(from, to) > range) return false;
  return lineOfSight(map, from, to);
}

export function visibleEnemies(w: World, e: Entity): Entity[] {
  const out: Entity[] = [];
  for (const other of w.entities) {
    if (!other.alive || !isHostile(e, other)) continue;
    if (canSee(w.map, e.pos, other.pos)) out.push(other);
  }
  return out;
}

/** Closest visible hostile, or null. */
export function acquireTarget(w: World, e: Entity): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const other of visibleEnemies(w, e)) {
    const d = dist(e.pos, other.pos);
    if (d < bestD) {
      best = other;
      bestD = d;
    }
  }
  return best;
}

/**
 * Line of sight is a zero-width ray, but bullets have width and travel from
 * the shooter's hull. A target can be visible through a diagonal corner gap
 * that every bullet then clips. Sampling the centre plus both shoulders means
 * bots only fire when a real projectile corridor exists.
 */
export function hasFiringLane(
  map: GameMap,
  from: Vec2,
  to: Vec2,
  halfWidth = 10,
): boolean {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  const px = -Math.sin(a) * halfWidth;
  const py = Math.cos(a) * halfWidth;
  return (
    lineOfSight(map, from, to) &&
    lineOfSight(map, { x: from.x + px, y: from.y + py }, { x: to.x + px, y: to.y + py }) &&
    lineOfSight(map, { x: from.x - px, y: from.y - py }, { x: to.x - px, y: to.y - py })
  );
}

/**
 * Nearest floor tile within `radius` tiles that breaks line of sight to the
 * threat. Used by retreat, and by the v1 'hold' and 'suppress' orders.
 */
export function findCover(
  map: GameMap,
  from: Vec2,
  threat: Vec2,
  radius = 6,
): Vec2 | null {
  const cx = Math.floor(from.x / TILE);
  const cy = Math.floor(from.y / TILE);
  let best: Vec2 | null = null;
  let bestD = Infinity;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = cx + dx;
      const ty = cy + dy;
      if (isWallTile(map, tx, ty)) continue;
      const c = tileCenter(tx, ty);
      if (lineOfSight(map, c, threat)) continue; // still exposed
      const d = dist(from, c);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
  }
  return best;
}

/** Leads a moving target so bots don't always shoot where it just was. */
export function aimWithLead(shooter: Entity, target: Entity, bulletSpeed: number): number {
  const d = dist(shooter.pos, target.pos);
  const travelTicks = d / bulletSpeed;
  const px = target.pos.x + target.vel.x * travelTicks;
  const py = target.pos.y + target.vel.y * travelTicks;
  return Math.atan2(py - shooter.pos.y, px - shooter.pos.x);
}