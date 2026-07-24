import type { Entity, Bullet, Vec2 } from './entity';
import { isWallAt, type GameMap } from './map';

/** Circle-vs-tile test at eight points around the entity's hull. */
function collides(map: GameMap, x: number, y: number, r: number): boolean {
  return (
    isWallAt(map, x - r, y) ||
    isWallAt(map, x + r, y) ||
    isWallAt(map, x, y - r) ||
    isWallAt(map, x, y + r) ||
    isWallAt(map, x - r * 0.7, y - r * 0.7) ||
    isWallAt(map, x + r * 0.7, y - r * 0.7) ||
    isWallAt(map, x - r * 0.7, y + r * 0.7) ||
    isWallAt(map, x + r * 0.7, y + r * 0.7)
  );
}

/** Axis-separated so entities slide along walls instead of sticking. */
export function moveEntity(map: GameMap, e: Entity): void {
  const nx = e.pos.x + e.vel.x;
  if (!collides(map, nx, e.pos.y, e.radius)) e.pos.x = nx;
  else e.vel.x = 0;

  const ny = e.pos.y + e.vel.y;
  if (!collides(map, e.pos.x, ny, e.radius)) e.pos.y = ny;
  else e.vel.y = 0;
}

export function moveToward(e: Entity, target: Vec2): void {
  const dx = target.x - e.pos.x;
  const dy = target.y - e.pos.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.001) {
    e.vel.x = 0;
    e.vel.y = 0;
    return;
  }
  e.vel.x = (dx / d) * e.speed;
  e.vel.y = (dy / d) * e.speed;
}

export interface BulletHit {
  bullet: Bullet;
  victim: Entity | null; // null = hit a wall or expired
}

/** Advances every bullet one tick, returns hits and prunes dead bullets. */
export function stepBullets(
  map: GameMap,
  bullets: Bullet[],
  entities: Entity[],
): BulletHit[] {
  const hits: BulletHit[] = [];
  const survivors: Bullet[] = [];

  for (const b of bullets) {
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const steps = Math.max(1, Math.ceil(speed / 8)); // substep so fast rounds can't tunnel
    let consumed = false;

    for (let s = 0; s < steps && !consumed; s++) {
      b.pos.x += b.vel.x / steps;
      b.pos.y += b.vel.y / steps;
      b.distanceLeft -= speed / steps;

      if (isWallAt(map, b.pos.x, b.pos.y)) {
        hits.push({ bullet: b, victim: null });
        consumed = true;
        break;
      }

      for (const e of entities) {
        if (!e.alive || e.id === b.ownerId || e.team === b.team) continue;
        const d = Math.hypot(e.pos.x - b.pos.x, e.pos.y - b.pos.y);
        if (d <= e.radius) {
          hits.push({ bullet: b, victim: e });
          consumed = true;
          break;
        }
      }

      if (b.distanceLeft <= 0) {
        hits.push({ bullet: b, victim: null });
        consumed = true;
      }
    }

    if (!consumed) survivors.push(b);
  }

  bullets.length = 0;
  bullets.push(...survivors);
  return hits;
}