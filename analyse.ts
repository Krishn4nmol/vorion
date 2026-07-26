import { existsSync, readFileSync } from 'fs';

/**
 * Offline post-mortem. Costs no quota — it only reads the JSONL the eval wrote.
 *
 * A null win-rate result is not the end of the analysis. If the commanded squad
 * behaves measurably differently but does not win more, the interesting
 * question is what it is doing instead, and that is answerable from the traces.
 */

const RESULTS = 'eval-results.jsonl';
const TRACES = 'eval-traces.jsonl';

interface Result {
  seed: number;
  arm: string;
  enemyWon: boolean;
  ticks: number;
  calls: number;
  accepted: number;
  rejected: number;
  errors: number;
}

interface Trace {
  seed: number;
  tick: number;
  prompt: string;
  response: string;
  accepted: { unitId: number; kind: string; reason: string }[];
  rejected: { raw: unknown; reason: string }[];
  latencyMs: number;
  error?: string;
  arm?: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Wilcoxon signed-rank, normal approximation. Paired and non-parametric, which
 * matters here: match durations are heavily right-skewed by the occasional
 * stalemate, so a t-test on the means would be misleading.
 */
function wilcoxon(pairs: [number, number][]): { n: number; z: number; p: string } {
  const diffs = pairs.map(([a, b]) => b - a).filter((d) => d !== 0);
  const n = diffs.length;
  if (n < 6) return { n, z: 0, p: 'too few pairs' };

  const ranked = diffs
    .map((d, i) => ({ d, abs: Math.abs(d), i }))
    .sort((x, y) => x.abs - y.abs);

  // average ranks for ties
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && ranked[j + 1].abs === ranked[i].abs) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }

  let wPlus = 0;
  ranked.forEach((r, idx) => {
    if (r.d > 0) wPlus += ranks[idx];
  });

  const meanW = (n * (n + 1)) / 4;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = (wPlus - meanW) / sdW;

  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { n, z, p: p < 0.001 ? '<0.001' : p.toFixed(3) };
}

function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const prob =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

function main(): void {
  const results = readJsonl<Result>(RESULTS);
  const traces = readJsonl<Trace>(TRACES);

  if (results.length === 0) {
    console.log('No eval-results.jsonl found. Run the eval first.');
    return;
  }

  const byArm = new Map<string, Result[]>();
  for (const r of results) {
    if (!byArm.has(r.arm)) byArm.set(r.arm, []);
    byArm.get(r.arm)!.push(r);
  }

  // ---- match duration: the thing the win rate is hiding ---------------------
  console.log('=== MATCH DURATION (ticks) ===');
  for (const [arm, rs] of byArm) {
    console.log(
      `${arm.padEnd(9)} n=${String(rs.length).padStart(3)}  mean ${Math.round(
        mean(rs.map((r) => r.ticks)),
      )}  median ${Math.round(median(rs.map((r) => r.ticks)))}`,
    );
  }

  for (const [target, base] of [
    ['llm', 'none'], ['llm', 'scripted'],
    ['llm2', 'none'], ['llm2', 'scripted'], ['llm2', 'llm'],
  ] as const) {
    const llm = byArm.get(target) ?? [];
    const other = byArm.get(base) ?? [];
    const byS = new Map(other.map((r) => [r.seed, r.ticks]));
    const pairs: [number, number][] = [];
    for (const r of llm) {
      const t = byS.get(r.seed);
      if (t !== undefined) pairs.push([t, r.ticks]);
    }
    const w = wilcoxon(pairs);
    const longer = pairs.filter(([a, b]) => b > a).length;
    console.log(
      `  ${target} vs ${base.padEnd(8)} llm longer in ${longer}/${pairs.length} paired matches` +
        `  (Wilcoxon z=${w.z.toFixed(2)}, p=${w.p})`,
    );
  }

  // ---- what the model actually ordered -------------------------------------
  if (traces.length) {
    // Traces from before the arm field was added are treated as v1.
    const arms = [...new Set(traces.map((t) => t.arm ?? 'llm'))];
    for (const arm of arms) {
      const ts = traces.filter((t) => (t.arm ?? 'llm') === arm);
      console.log(`\n=== ORDER MIX — ${arm} (accepted) ===`);
      const kinds = new Map<string, number>();
      for (const t of ts) {
        for (const a of t.accepted) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
      }
      const total = [...kinds.values()].reduce((a, b) => a + b, 0);
      for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(12)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(1)}%`);
      }
    }

    console.log('\n=== REJECTIONS ===');
    const reasons = new Map<string, number>();
    for (const t of traces) {
      for (const r of t.rejected) {
        // Collapse the variable parts so patterns are visible.
        const key = r.reason
          .replace(/\d+/g, 'N')
          .replace(/\(N,N\)/g, '(x,y)')
          .replace(/"[^"]*"/g, '"..."');
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
    }
    if (reasons.size === 0) console.log('  none');
    for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${r}`);
    }

    // ---- doctrine compliance ------------------------------------------------
    // Rule 2 says leave units that are IN CONTACT alone. The prompt is the
    // ground truth for who was engaged at decision time.
    let engagedOrders = 0;
    let totalOrders = 0;
    for (const t of traces) {
      const engaged = new Set(
        [...t.prompt.matchAll(/^ {2}UNIT #(\d+) .*IN CONTACT/gm)].map((m) => Number(m[1])),
      );
      for (const a of t.accepted) {
        totalOrders++;
        if (engaged.has(a.unitId)) engagedOrders++;
      }
    }
    console.log('\n=== DOCTRINE ===');
    console.log(
      `  orders issued to units already IN CONTACT: ${engagedOrders}/${totalOrders}` +
        ` (${((engagedOrders / (totalOrders || 1)) * 100).toFixed(1)}%) — doctrine says leave them alone`,
    );

    const lat = traces.filter((t) => !t.error).map((t) => t.latencyMs);
    console.log(
      `  latency mean ${Math.round(mean(lat))}ms  median ${Math.round(median(lat))}ms  n=${lat.length}`,
    );

    console.log('\n=== SAMPLE REASONS ===');
    const seen = new Set<string>();
    for (const t of traces) {
      for (const a of t.accepted) {
        const key = a.kind + a.reason;
        if (seen.has(key) || !a.reason) continue;
        seen.add(key);
        console.log(`  ${a.kind.padEnd(11)} "${a.reason}"`);
        if (seen.size >= 15) return;
      }
    }
  }
}

main();