import { TILE, buildingAt, type GameMap } from '../../core/map';
import { dist, sideOf, type Team } from '../../core/entity';
import { isHostile, type World, type GameEvent } from '../../core/world';
import { canSee, SIGHT_RANGE } from '../vision';

/**
 * What one side currently knows about the other. The commander is NOT
 * omniscient: it reasons only from what its own squad has seen, and stale
 * contacts decay. Handing the model perfect information would make the whole
 * v2 comparison meaningless — a scripted bot could beat you with omniscience.
 */

export interface Contact {
  id: number;
  tile: { x: number; y: number };
  where: string;
  hp: number;
  lastSeenTick: number;
}

export interface SquadKnowledge {
  side: 0 | 1;
  contacts: Map<number, Contact>;
}

/** Contacts older than this are dropped entirely — roughly 12 seconds. */
export const CONTACT_TTL = 720;

export function createKnowledge(side: 0 | 1): SquadKnowledge {
  return { side, contacts: new Map() };
}

function toTile(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) };
}

/** Human-readable position: building name if inside, else bearing from one. */
export function describe(map: GameMap, p: { x: number; y: number }): string {
  const inside = buildingAt(map, p);
  if (inside) return `inside ${inside.name}`;

  let best = null as null | { name: string; d: number; dx: number; dy: number };
  for (const b of map.buildings) {
    const cx = (b.x + b.w / 2) * TILE;
    const cy = (b.y + b.h / 2) * TILE;
    const d = Math.hypot(cx - p.x, cy - p.y);
    if (!best || d < best.d) best = { name: b.name, d, dx: p.x - cx, dy: p.y - cy };
  }
  if (!best) return 'open ground';

  const compass =
    (Math.abs(best.dy) > Math.abs(best.dx) * 0.5 ? (best.dy < 0 ? 'N' : 'S') : '') +
    (Math.abs(best.dx) > Math.abs(best.dy) * 0.5 ? (best.dx < 0 ? 'W' : 'E') : '');
  const tiles = Math.round(best.d / TILE);
  return `open ground ${tiles} tiles ${compass || 'from'} of ${best.name}`;
}

/**
 * Refresh what `side` can currently see.
 *
 * `range` defaults to the bots' own sight range, which is what the commander
 * uses — deliberately tight, so the model never reasons about something its
 * units could not have observed. The player's minimap passes a larger value
 * matched to the visible screen, since the renderer draws every entity in
 * view: a contact you can plainly see should not be missing from your map.
 */
export function updateKnowledge(w: World, k: SquadKnowledge, range = SIGHT_RANGE): void {
  const observers = w.entities.filter((e) => e.alive && sideOf(e.team) === k.side);

  for (const target of w.entities) {
    if (!target.alive || sideOf(target.team) === k.side) continue;
    const seen = observers.some((o) => canSee(w.map, o.pos, target.pos, range));
    if (!seen) continue;
    k.contacts.set(target.id, {
      id: target.id,
      tile: toTile(target.pos),
      where: describe(w.map, target.pos),
      hp: target.hp,
      lastSeenTick: w.tick,
    });
  }

  for (const [id, c] of k.contacts) {
    const ent = w.entities.find((e) => e.id === id);
    if (!ent || !ent.alive) k.contacts.delete(id);
    else if (w.tick - c.lastSeenTick > CONTACT_TTL) k.contacts.delete(id);
  }
}

/**
 * Gunfire gives away position. Anything that fires within earshot of the squad
 * is marked, whether or not anyone has line of sight to it — which is what
 * makes the minimap useful for the two-thirds of the map that is off-screen,
 * and ties it to the audio: if you can hear it, you can see it on the map.
 */
export function markHeard(
  w: World,
  k: SquadKnowledge,
  events: GameEvent[],
  range: number,
): void {
  for (const ev of events) {
    if (ev.type !== 'fire') continue;
    const shooter = w.entities.find((e) => e.id === ev.shooterId);
    if (!shooter || !shooter.alive || sideOf(shooter.team) === k.side) continue;

    const heard = w.entities.some(
      (o) => o.alive && sideOf(o.team) === k.side && dist(o.pos, shooter.pos) <= range,
    );
    if (!heard) continue;

    k.contacts.set(shooter.id, {
      id: shooter.id,
      tile: toTile(shooter.pos),
      where: describe(w.map, shooter.pos),
      hp: shooter.hp,
      lastSeenTick: w.tick,
    });
  }
}

export interface SquadMemberView {
  id: number;
  hp: number;
  ammo: number;
  state: string;
  tile: { x: number; y: number };
  where: string;
  engaged: boolean;
  currentOrder: string;
}

export interface Snapshot {
  tick: number;
  squadSize: number;
  enemyEstimate: number;
  squad: SquadMemberView[];
  contacts: (Contact & { stale: boolean })[];
  buildings: { name: string; tile: { x: number; y: number }; holder: string }[];
}

export function buildSnapshot(w: World, k: SquadKnowledge): Snapshot {
  const squad = w.entities.filter((e) => e.alive && sideOf(e.team) === k.side);

  const members: SquadMemberView[] = squad.map((e) => ({
    id: e.id,
    hp: e.hp,
    ammo: e.weapon.ammo,
    state: e.state,
    tile: toTile(e.pos),
    where: describe(w.map, e.pos),
    engaged: w.entities.some(
      (o) => o.alive && isHostile(e, o) && canSee(w.map, e.pos, o.pos),
    ),
    currentOrder: e.order ? e.order.kind : 'none',
  }));

  const contacts = [...k.contacts.values()]
    .map((c) => ({ ...c, stale: w.tick - c.lastSeenTick > 180 }))
    .sort((a, b) => a.lastSeenTick - b.lastSeenTick);

  const buildings = w.map.buildings.map((b) => {
    // "Holding" a building means inside it or right against its wall — not
    // merely nearest to it, or half the map reads as occupied.
    const inOrBeside = (tx: number, ty: number) =>
      tx >= b.x - 1 && tx <= b.x + b.w && ty >= b.y - 1 && ty <= b.y + b.h;
    const friendly = squad.some((e) => {
      const t = toTile(e.pos);
      return inOrBeside(t.x, t.y);
    });
    const hostile = [...k.contacts.values()].some((c) => inOrBeside(c.tile.x, c.tile.y));
    return {
      name: b.name,
      tile: { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) },
      holder: friendly ? 'ours' : hostile ? 'enemy' : 'empty',
    };
  });

  return {
    tick: w.tick,
    squadSize: squad.length,
    enemyEstimate: w.entities.filter((e) => e.alive && sideOf(e.team) !== k.side).length,
    squad: members,
    contacts,
    buildings,
  };
}

/**
 * Compact text form. Prose beats raw JSON here: fewer tokens, and models reason
 * about spatial relationships better from named places than from coordinates.
 * Tile coords are still included because orders must be machine-checkable.
 */
export function toPrompt(s: Snapshot, mapW: number, mapH: number): string {
  const lines: string[] = [];
  lines.push(`TICK ${s.tick} | MAP ${mapW}x${mapH} tiles | your squad ${s.squadSize} alive`);

  lines.push('');
  lines.push('YOUR SQUAD:');
  for (const m of s.squad) {
    lines.push(
      `  UNIT #${m.id} hp${m.hp} ammo${m.ammo} at (${m.tile.x},${m.tile.y}) ${m.where}` +
        ` | ${m.engaged ? 'IN CONTACT' : 'no contact'} | doing: ${m.currentOrder}`,
    );
  }

  lines.push('');
  if (s.contacts.length === 0) {
    lines.push('ENEMY CONTACTS: none seen recently.');
  } else {
    lines.push('ENEMY CONTACTS (only what your squad has seen):');
    for (const c of s.contacts) {
      const age = s.tick - c.lastSeenTick;
      lines.push(
        `  ENEMY #${c.id} hp${c.hp} last seen ${age} ticks ago at (${c.tile.x},${c.tile.y}) ${c.where}` +
          (c.stale ? ' [STALE]' : ''),
      );
    }
  }

  lines.push('');
  lines.push('BUILDINGS:');
  for (const b of s.buildings) {
    lines.push(`  ${b.name} centre (${b.tile.x},${b.tile.y}) — ${b.holder}`);
  }

  return lines.join('\n');
}

/** Convenience for tests and for the eval harness. */
export function sideName(t: Team): string {
  return sideOf(t) === 1 ? 'hostile' : 'friendly';
}