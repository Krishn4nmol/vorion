import { TILE, isWallTile, nearestFloor, type GameMap } from '../../core/map';
import { sideOf, type Order, type OrderKind, type Vec2 } from '../../core/entity';
import type { World } from '../../core/world';
import { findPath } from '../pathfinding';
import type { SquadKnowledge } from './snapshot';

/**
 * Everything the model is allowed to say, and the gate it has to pass through.
 *
 * The model never touches the simulation. It emits JSON, this module validates
 * it against the actual world, and anything that fails is dropped — the bot
 * then falls back to its behaviour tree. A hallucinated coordinate, an order
 * aimed at an enemy the squad has never seen, or a unit id from the other team
 * all die here rather than corrupting the game state.
 */

export const ORDER_KINDS: OrderKind[] = [
  'hold',
  'advance_to',
  'flank',
  'suppress',
  'retreat',
  'regroup',
];

/** How long an order stands before the bot reverts to autonomous behaviour. */
export const ORDER_TTL = 420; // 7 seconds

export interface RawOrder {
  unit?: unknown;
  order?: unknown;
  x?: unknown;
  y?: unknown;
  target?: unknown;
  reason?: unknown;
}

export interface Rejection {
  raw: unknown;
  reason: string;
}

export interface ValidationResult {
  accepted: { unitId: number; order: Order; reason: string }[];
  rejected: Rejection[];
  /** Orders whose coordinates were nudged onto a walkable tile. */
  snapped: number;
}

/** How far a wall coordinate may be nudged, in tiles, before it is rejected. */
export const SNAP_RADIUS = 4;

/** Included verbatim in the system prompt so the schema has one source of truth. */
export const ORDER_SCHEMA_DOC = `Reply with ONLY a JSON array, no prose, no markdown fences.
Each element commands one of your own units:

  { "unit": <your unit id>, "order": <one of ${ORDER_KINDS.join('|')}>,
    "x": <tile x>, "y": <tile y>, "target": <enemy id or null>,
    "reason": "<max 8 words>" }

Rules:
- "x"/"y" are required for advance_to and flank; they must be walkable tiles.
- "target" is required for suppress and must be an enemy you have actually seen.
- hold, retreat and regroup take no coordinates.
- One order per unit at most. Units you omit keep acting autonomously.`;

/** Strips markdown fences and pulls out the first JSON array in the text. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function walkable(map: GameMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return false;
  return !isWallTile(map, tx, ty);
}

function tileToWorld(tx: number, ty: number): Vec2 {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

/**
 * Validates raw model output against the world. `checkReachable` runs A* per
 * move order — correct but not free, so the eval harness can switch it off.
 */
export function validateOrders(
  w: World,
  k: SquadKnowledge,
  raw: unknown,
  checkReachable = true,
): ValidationResult {
  const accepted: ValidationResult['accepted'] = [];
  const rejected: Rejection[] = [];
  let snapped = 0;

  if (!Array.isArray(raw)) {
    return { accepted, rejected: [{ raw, reason: 'not a JSON array' }], snapped };
  }

  const squad = w.entities.filter((e) => e.alive && sideOf(e.team) === k.side);
  const squadIds = new Set(squad.map((e) => e.id));
  const claimed = new Set<number>();

  for (const item of raw.slice(0, 12)) {
    if (typeof item !== 'object' || item === null) {
      rejected.push({ raw: item, reason: 'not an object' });
      continue;
    }
    const o = item as RawOrder;

    const unitId = typeof o.unit === 'number' ? o.unit : Number(o.unit);
    if (!Number.isFinite(unitId)) {
      rejected.push({ raw: item, reason: 'unit id missing or not a number' });
      continue;
    }
    if (!squadIds.has(unitId)) {
      // Covers dead units, invented ids, and — importantly — attempts to
      // command the opposing side.
      rejected.push({ raw: item, reason: `unit ${unitId} is not a living unit of yours` });
      continue;
    }

    const kind = String(o.order) as OrderKind;
    if (!ORDER_KINDS.includes(kind)) {
      rejected.push({ raw: item, reason: `unknown order "${String(o.order)}"` });
      continue;
    }

    const unit = squad.find((e) => e.id === unitId)!;
    let target: Vec2 | null = null;
    let targetId: number | null = null;

    if (kind === 'advance_to' || kind === 'flank') {
      const tx = Math.floor(Number(o.x));
      const ty = Math.floor(Number(o.y));
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
        rejected.push({ raw: item, reason: `${kind} needs numeric x,y` });
        continue;
      }
      // The prompt tells the model nothing about which tiles are walkable, so
      // a computed coordinate can land in a wall. Snapping to the nearest open
      // tile preserves the intent; only a coordinate with no open tile nearby
      // is a genuine error worth rejecting.
      let fx = tx;
      let fy = ty;
      if (!walkable(w.map, tx, ty)) {
        const near = nearestFloor(w.map, tx, ty);
        if (Math.hypot(near.x - tx, near.y - ty) > SNAP_RADIUS) {
          rejected.push({ raw: item, reason: `tile (${tx},${ty}) is a wall or off-map` });
          continue;
        }
        fx = near.x;
        fy = near.y;
        snapped++;
      }
      target = tileToWorld(fx, fy);
      if (checkReachable && findPath(w.map, unit.pos, target).length === 0) {
        rejected.push({ raw: item, reason: `no path from unit ${unitId} to (${fx},${fy})` });
        continue;
      }
    }

    if (kind === 'suppress') {
      const tid = typeof o.target === 'number' ? o.target : Number(o.target);
      if (!Number.isFinite(tid)) {
        rejected.push({ raw: item, reason: 'suppress needs a target id' });
        continue;
      }
      if (!k.contacts.has(tid)) {
        // Fog of war enforced at the gate: you cannot act on what you have
        // not seen, however confidently the model asserts it.
        rejected.push({ raw: item, reason: `enemy ${tid} has never been seen by your squad` });
        continue;
      }
      targetId = tid;
      const c = k.contacts.get(tid)!;
      target = tileToWorld(c.tile.x, c.tile.y);
    }

    // Duplicate check last, so a malformed second order for a unit reports the
    // real fault rather than masking it as a duplicate.
    if (claimed.has(unitId)) {
      rejected.push({ raw: item, reason: `duplicate order for unit ${unitId}` });
      continue;
    }

    claimed.add(unitId);
    accepted.push({
      unitId,
      order: {
        kind,
        target,
        targetId,
        issuedTick: w.tick,
        expiresTick: w.tick + ORDER_TTL,
      },
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 60) : '',
    });
  }

  return { accepted, rejected, snapped};
}

/** Writes validated orders onto the entities. The only mutation this module does. */
export function applyOrders(w: World, result: ValidationResult): void {
  for (const a of result.accepted) {
    const e = w.entities.find((x) => x.id === a.unitId);
    if (e && e.alive) e.order = a.order;
  }
}

/** Clears orders that have run out, so bots return to autonomous behaviour. */
export function expireOrders(w: World): void {
  for (const e of w.entities) {
    if (e.order && w.tick >= e.order.expiresTick) e.order = null;
  }
}