/**
 * Career stats, persisted in localStorage.
 *
 * Survival is the mode that needs this most: a hard endless mode without a
 * number to beat is just a wall. Everything here is derived from figures the
 * match already tracked — nothing new is measured during play.
 */

const KEY = 'vorion.profile';

export interface Profile {
  matchesPlayed: number;
  matchesWon: number;
  totalKills: number;
  totalRevives: number;
  /** Best single-match accuracy, 0..1. Only counted over a meaningful sample. */
  bestAccuracy: number;
  bestWave: number;
  bestScore: number;
}

function blank(): Profile {
  return {
    matchesPlayed: 0,
    matchesWon: 0,
    totalKills: 0,
    totalRevives: 0,
    bestAccuracy: 0,
    bestWave: 0,
    bestScore: 0,
  };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    // Merged over a blank rather than trusted wholesale, so a profile written
    // by an older build is missing fields rather than broken.
    return { ...blank(), ...(JSON.parse(raw) as Partial<Profile>) };
  } catch {
    return blank();
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private browsing, quota — not worth interrupting the game over */
  }
}

export interface MatchOutcome {
  won: boolean;
  kills: number;
  revives: number;
  shotsFired: number;
  shotsHit: number;
  /** Survival only. */
  wave?: number;
  score?: number;
}

/** Folds one finished match into the career record and returns what improved. */
export function recordMatch(p: Profile, m: MatchOutcome): string[] {
  const records: string[] = [];

  p.matchesPlayed++;
  if (m.won) p.matchesWon++;
  p.totalKills += m.kills;
  p.totalRevives += m.revives;

  // A single lucky shot is not 100% accuracy. Twenty rounds is enough of a
  // sample that the figure means something.
  if (m.shotsFired >= 20) {
    const acc = m.shotsHit / m.shotsFired;
    if (acc > p.bestAccuracy) {
      p.bestAccuracy = acc;
      records.push(`BEST ACCURACY ${(acc * 100).toFixed(0)}%`);
    }
  }

  if (m.wave !== undefined && m.wave > p.bestWave) {
    p.bestWave = m.wave;
    records.push(`BEST WAVE ${m.wave}`);
  }
  if (m.score !== undefined && m.score > p.bestScore) {
    p.bestScore = m.score;
    records.push(`HIGH SCORE ${m.score.toLocaleString()}`);
  }

  saveProfile(p);
  return records;
}