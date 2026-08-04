import { spawnUnit, type World } from './core/world';
import { dist, sideOf, WEAPON_IDS, type WeaponId } from './core/entity';
import { TILE, isWallTile } from './core/map';
import type { MatchStats } from './stats';

/**
 * Endless wave director.
 *
 * Lives entirely above core/: it reads the world, spawns through the public
 * `spawnUnit`, and never touches simulation rules. The evaluation harness does
 * not know it exists.
 */

const INTERMISSION = 240; // 4s between waves
const SPAWN_MIN_DISTANCE = 520; // px from the nearest survivor

/**
 * A fallen squadmate returns after this many waves — the run is survivable
 * without being infinite, and losing someone still costs you the waves in
 * between.
 */
const REINFORCE_EVERY = 2;

export interface SurvivalState {
  wave: number;
  score: number;
  /** Ticks until the next wave lands; 0 while a wave is in progress. */
  countdown: number;
  lastWaveKills: number;
}

export function createSurvival(): SurvivalState {
  return { wave: 0, score: 0, countdown: 90, lastWaveKills: 0 };
}

/**
 * Wave composition. Numbers climb, but the weapon pool is what actually makes
 * later waves dangerous: early waves are SMGs at close range, later ones bring
 * marksman rifles that punish standing in the open.
 */
function waveComposition(wave: number): { count: number; weapons: WeaponId[]; grenades: number } {
  // Starts gentler than a standard match and ramps past it: wave 1 is a
  // warm-up, wave 6 is already harder than anything in the normal mode.
  const count = Math.min(9, 2 + Math.floor(wave * 0.55));
  const grenades = Math.min(3, Math.floor(wave / 3));

  let weapons: WeaponId[];
  if (wave <= 2) weapons = ['smg', 'rifle'];
  else if (wave <= 5) weapons = ['smg', 'rifle', 'shotgun'];
  else weapons = [...WEAPON_IDS];

  return { count, weapons, grenades };
}

/** A walkable tile far enough from every survivor to be a fair arrival point. */
function spawnTile(w: World, rng: () => number): { x: number; y: number } {
  const survivors = w.entities.filter((e) => e.alive && sideOf(e.team) === 0);

  let best = { x: 1, y: 1 };
  let bestScore = -Infinity;

  // Sample rather than search: a handful of candidates is enough to find
  // somewhere reasonable, and it keeps this off the hot path.
  for (let i = 0; i < 40; i++) {
    const tx = 1 + Math.floor(rng() * (w.map.w - 2));
    const ty = 1 + Math.floor(rng() * (w.map.h - 2));
    if (isWallTile(w.map, tx, ty)) continue;

    const p = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
    let nearest = Infinity;
    for (const s of survivors) nearest = Math.min(nearest, dist(s.pos, p));

    // Prefer the far side of the map, but stop rewarding extra distance past
    // the threshold — otherwise every wave arrives in the same corner.
    const score = Math.min(nearest, SPAWN_MIN_DISTANCE * 1.6);
    if (score > bestScore) {
      bestScore = score;
      best = { x: tx, y: ty };
    }
  }
  return best;
}

export function startWave(w: World, st: SurvivalState): void {
  st.wave++;

  // Reinforcement: one dead squadmate walks back on every couple of waves.
  if (st.wave % REINFORCE_EVERY === 0) {
    const fallen = w.entities.find((e) => !e.alive && sideOf(e.team) === 0);
    if (fallen) {
      fallen.alive = true;
      fallen.downed = false;
      fallen.revivesUsed = 0;
      fallen.hp = fallen.maxHp;
      fallen.grenades = 2;
      fallen.weapon.ammo = fallen.weapon.magSize;
      fallen.weapon.reloadEndTick = 0;
      fallen.order = null;
      const anchor = w.entities.find((e) => e.alive && sideOf(e.team) === 0);
      if (anchor) {
        fallen.pos.x = anchor.pos.x;
        fallen.pos.y = anchor.pos.y;
      }
    }
  }

  st.countdown = 0;
  const { count, weapons, grenades } = waveComposition(st.wave);
  const rng = () => w.rng.next();

  for (let i = 0; i < count; i++) {
    const tile = spawnTile(w, rng);
    const weapon = weapons[Math.floor(rng() * weapons.length)];
    spawnUnit(w, 'enemy', tile, weapon, grenades);
  }
}

/**
 * Between waves the squad is patched up: downed allies get back on their feet
 * and everyone heals. Without it the run ends on attrition alone and wave three
 * is the ceiling regardless of how well you played.
 */
function intermissionRecovery(w: World): void {
  for (const e of w.entities) {
    if (sideOf(e.team) !== 0) continue;
    if (!e.alive) continue;
    // Full recovery. Anything less and damage compounds across waves, so the
    // run ends on attrition rather than on the difficulty curve — measured at
    // an average of wave 2 with partial healing.
    e.downed = false;
    e.reviveProgress = 0;
    e.revivesUsed = 0;
    e.hp = e.maxHp;
    e.grenades = Math.max(e.grenades, 2);
    e.weapon.ammo = e.weapon.magSize;
    e.weapon.reloadEndTick = 0;
  }
}

/** Call once per tick, after step(). */
export function updateSurvival(w: World, st: SurvivalState, stats: MatchStats | null): void {
  if (w.over) return;

  // Score from the event bus, like every other consumer.
  for (const ev of w.events) {
    if (ev.type === 'death' && !ev.friendly) {
      const victim = w.entities.find((e) => e.id === ev.victimId);
      if (victim && victim.team === 'enemy') {
        // Later waves are worth more, so surviving deep beats farming wave one.
        st.score += 100 + st.wave * 25;
        st.lastWaveKills++;
      }
    }
  }
  void stats;

  const hostiles = w.entities.filter((e) => e.alive && e.team === 'enemy').length;

  if (hostiles === 0) {
    if (st.countdown === 0) {
      st.countdown = INTERMISSION;
      st.score += st.wave * 150; // wave clear bonus
      intermissionRecovery(w);
      st.lastWaveKills = 0;
    } else {
      st.countdown--;
      if (st.countdown <= 0) startWave(w, st);
    }
  }
}