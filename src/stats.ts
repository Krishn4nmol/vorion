import type { GameEvent } from './core/world';

/**
 * Per-match statistics, derived entirely from the event bus.
 *
 * Deliberately outside core/: the simulation does not need to know anyone is
 * counting, and headless eval runs pay nothing for this. Same contract as the
 * renderer and the audio engine — read events, never write state.
 */

export interface EntityStats {
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  revives: number;
  timesDowned: number;
}

function blank(): EntityStats {
  return {
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    shotsFired: 0,
    shotsHit: 0,
    revives: 0,
    timesDowned: 0,
  };
}

export class MatchStats {
  private byId = new Map<number, EntityStats>();

  get(id: number): EntityStats {
    let s = this.byId.get(id);
    if (!s) {
      s = blank();
      this.byId.set(id, s);
    }
    return s;
  }

  /** Call once per tick with that tick's events. */
  ingest(events: GameEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'fire') {
        // Counted per projectile, not per trigger pull: a shotgun throws seven
        // pellets, any of which can hit, so counting one shot against seven
        // possible hits produced accuracy well above 100%.
        this.get(ev.shooterId).shotsFired += ev.pellets;
      } else if (ev.type === 'damage') {
        const shooter = this.get(ev.shooterId);
        shooter.damageDealt += ev.amount;
        // Blast damage counts toward damage dealt but not accuracy — a grenade
        // hitting three people is not three accurate shots.
        if (!ev.explosive) shooter.shotsHit++;
        this.get(ev.victimId).damageTaken += ev.amount;
      } else if (ev.type === 'death') {
        this.get(ev.victimId).deaths++;
        // Friendly fire is not an achievement. Counting it made squad kill
        // totals exceed the number of enemies on the map.
        if (!ev.friendly) this.get(ev.killerId).kills++;
      } else if (ev.type === 'downed') {
        // Credited to the medic, not the casualty: reviving is the action
        // worth reporting, and it is the one the player chooses to take.
        this.get(ev.victimId).timesDowned++;
      } else if (ev.type === 'revived') {
        this.get(ev.medicId).revives++;
      }
    }
  }

  accuracy(id: number): number {
    const s = this.get(id);
    return s.shotsFired === 0 ? 0 : s.shotsHit / s.shotsFired;
  }
}