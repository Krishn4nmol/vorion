import { dist, sideOf, type Vec2 } from './core/entity';
import type { World } from './core/world';
import { validateOrders, applyOrders } from './ai/commander/orders';
import type { SquadKnowledge } from './ai/commander/snapshot';
import { TILE } from './core/map';

/**
 * Player-issued squad orders.
 *
 * Runs through exactly the same validator the LLM commander does — same fog of
 * war, same walkability and reachability checks, same rejection reasons. That
 * matters beyond code reuse: it means a human and the model are commanding
 * under identical constraints, so comparing them is meaningful rather than
 * merely suggestive.
 */

export type SquadOrderKind = 'advance_to' | 'suppress' | 'hold' | 'regroup' | 'flank';

/** Allies under the player's command — the player's own unit is excluded. */
function squadOf(w: World, playerId: number) {
  return w.entities.filter(
    (e) => e.alive && e.id !== playerId && sideOf(e.team) === 0,
  );
}

/** Nearest visible hostile to a world point, within a generous click radius. */
export function hostileAt(w: World, k: SquadKnowledge, p: Vec2): number | null {
  let best: number | null = null;
  let bestD = TILE * 2.2;
  for (const id of k.contacts.keys()) {
    const e = w.entities.find((x) => x.id === id);
    if (!e || !e.alive) continue;
    const d = dist(e.pos, p);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

export function commandSquad(
  w: World,
  k: SquadKnowledge,
  playerId: number,
  kind: SquadOrderKind,
  point: Vec2 | null,
  targetId: number | null,
): string {
  const squad = squadOf(w, playerId);
  if (squad.length === 0) return 'no squad left';

  const tx = point ? Math.floor(point.x / TILE) : 0;
  const ty = point ? Math.floor(point.y / TILE) : 0;
  const raw: unknown[] = [];

  if (kind === 'flank') {
    // A flank is one unit swinging wide, not the whole squad relocating —
    // sending everyone was the single costliest mistake in the eval.
    const runner = squad.reduce((a, b) =>
      dist(a.pos, point ?? a.pos) > dist(b.pos, point ?? b.pos) ? a : b,
    );
    raw.push({ unit: runner.id, order: 'flank', x: tx, y: ty, reason: 'ordered flank' });
  } else {
    for (const e of squad) {
      raw.push(
        kind === 'suppress'
          ? { unit: e.id, order: 'suppress', target: targetId, reason: 'ordered suppress' }
          : kind === 'advance_to'
            ? { unit: e.id, order: 'advance_to', x: tx, y: ty, reason: 'ordered advance' }
            : { unit: e.id, order: kind, reason: `ordered ${kind}` },
      );
    }
  }

  const res = validateOrders(w, k, raw);
  applyOrders(w, res);

  if (res.accepted.length === 0) {
    return res.rejected[0]?.reason ?? 'order refused';
  }
  const verb = kind.replace('_', ' ').toUpperCase();
  return `${verb} — ${res.accepted.length} unit${res.accepted.length > 1 ? 's' : ''}`;
}