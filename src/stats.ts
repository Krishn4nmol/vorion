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
}

function blank(): EntityStats {
  return {
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    shotsFired: 0,
    shotsHit: 0,
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
        this.get(ev.shooterId).shotsFired++;
      } else if (ev.type === 'damage') {
        // One bullet produces exactly one damage event, so counting these
        // gives hits without tracking individual projectiles.
        const shooter = this.get(ev.shooterId);
        shooter.damageDealt += ev.amount;
        shooter.shotsHit++;
        this.get(ev.victimId).damageTaken += ev.amount;
      } else if (ev.type === 'death') {
        this.get(ev.victimId).deaths++;
        if (ev.killerId !== ev.victimId) this.get(ev.killerId).kills++;
      }
    }
  }

  accuracy(id: number): number {
    const s = this.get(id);
    return s.shotsFired === 0 ? 0 : s.shotsHit / s.shotsFired;
  }
}