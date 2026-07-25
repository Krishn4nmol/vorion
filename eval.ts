import 'dotenv/config';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { createWorld, step, type Controller, type World } from './src/core/world';
import { makeBotController } from './src/ai/behaviour';
import { sideOf } from './src/core/entity';
import { isWallTile, TILE } from './src/core/map';
import { canSee } from './src/ai/vision';
import {
  createKnowledge,
  updateKnowledge,
  type SquadKnowledge,
} from './src/ai/commander/snapshot';
import { validateOrders, applyOrders, expireOrders } from './src/ai/commander/orders';
import { Commander } from './src/ai/commander/runtime';
import { createNodeAsk } from './src/ai/commander/nodeAsk';
import { SYSTEM_PROMPT_V1, SYSTEM_PROMPT_V2 } from './src/ai/commander/prompt';

/**
 * Measures whether an LLM commander actually helps.
 *
 * Design notes that matter for the result being trustworthy:
 *
 * PAIRED. Every arm plays the SAME seeds, so map layout and spawns are held
 * constant. Comparing independent samples would need several times as many
 * matches to see the same effect, and API quota is the binding constraint.
 *
 * BLOCKING. The commander awaits each decision. In async mode a headless run
 * executes thousands of ticks per second, so responses land hundreds of ticks
 * late and the experiment would measure network latency, not tactics.
 *
 * CHECKPOINTED. Results append to JSONL after every match. Free-tier quota
 * means this runs across several sessions; rerunning skips completed work.
 */

const ARMS = ['none', 'scripted', 'llm', 'llm2'] as const;
type Arm = (typeof ARMS)[number];

const RESULTS = 'eval-results.jsonl';
const TRACES = 'eval-traces.jsonl';
const COMMAND_INTERVAL = 150;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

interface Result {
  seed: number;
  arm: Arm;
  enemyWon: boolean;
  ticks: number;
  calls: number;
  accepted: number;
  rejected: number;
  errors: number;
}

/** Same scripted commander that scored 49.2% at N=1200 — the arm to beat. */
function scriptedCommander(w: World, k: SquadKnowledge): unknown[] {
  const squad = w.entities
    .filter((e) => e.alive && sideOf(e.team) === k.side)
    .filter(
      (e) =>
        !w.entities.some(
          (o) => o.alive && sideOf(o.team) !== k.side && canSee(w.map, e.pos, o.pos),
        ),
    );
  if (squad.length === 0) return [];

  const contacts = [...k.contacts.values()];
  const orders: unknown[] = [];

  if (contacts.length === 0) {
    const cx = w.map.w / 2;
    const cy = w.map.h / 2;
    let obj = w.map.buildings[0];
    let bestD = Infinity;
    for (const b of w.map.buildings) {
      const d = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
      if (d < bestD) {
        bestD = d;
        obj = b;
      }
    }
    for (const e of squad) {
      orders.push({
        unit: e.id,
        order: 'advance_to',
        x: Math.round(obj.x + obj.w / 2),
        y: Math.round(obj.y + obj.h / 2),
        reason: 'advance together',
      });
    }
    return orders;
  }

  const mark = contacts.reduce((a, b) => (a.hp <= b.hp ? a : b));
  squad.forEach((e, i) => {
    if (i % 2 === 0) {
      orders.push({ unit: e.id, order: 'suppress', target: mark.id, reason: 'pin the mark' });
    } else {
      const ex = Math.floor(e.pos.x / TILE);
      const ey = Math.floor(e.pos.y / TILE);
      const dx = mark.tile.x - ex;
      const dy = mark.tile.y - ey;
      const len = Math.hypot(dx, dy) || 1;
      for (const sign of [1, -1]) {
        const fx = Math.round(mark.tile.x + (-dy / len) * 8 * sign);
        const fy = Math.round(mark.tile.y + (dx / len) * 8 * sign);
        if (fx > 0 && fy > 0 && fx < w.map.w && fy < w.map.h && !isWallTile(w.map, fx, fy)) {
          orders.push({ unit: e.id, order: 'flank', x: fx, y: fy, reason: 'swing wide' });
          break;
        }
      }
    }
  });
  return orders;
}

async function runMatch(seed: number, arm: Arm, ask: ReturnType<typeof createNodeAsk>): Promise<Result> {
  const w = createWorld(seed);
  const bot = makeBotController();
  const cs = new Map<number, Controller>();
  for (const e of w.entities) cs.set(e.id, bot);

  const k = arm === 'none' ? null : createKnowledge(1);
  const isLlm = arm === 'llm' || arm === 'llm2';
  const cmd = isLlm
    ? new Commander(k!, ask, {
        intervalTicks: COMMAND_INTERVAL,
        mode: 'blocking',
        maxCalls: 12, // caps quota burn per match
        timeoutMs: 60000,
        // llm = v1 doctrine (concentrate only), llm2 = v2 (fix and flank).
        system: arm === 'llm' ? SYSTEM_PROMPT_V1 : SYSTEM_PROMPT_V2,
      })
    : null;

  let accepted = 0;
  let rejected = 0;

  while (!w.over && w.tick < 20000) {
    step(w, cs);

    if (arm === 'scripted' && k && w.tick % COMMAND_INTERVAL === 0) {
      updateKnowledge(w, k);
      const res = validateOrders(w, k, scriptedCommander(w, k));
      applyOrders(w, res);
      accepted += res.accepted.length;
      rejected += res.rejected.length;
    }

    if (cmd) {
      const p = cmd.update(w);
      if (p) await p;
    }

    expireOrders(w);
  }

  if (cmd) {
    await cmd.flush();
    for (const t of cmd.trace) {
      accepted += t.accepted.length;
      rejected += t.rejected.length;
      appendFileSync(TRACES, JSON.stringify({ seed, arm, ...t }) + '\n');
    }
  }

  const alive = w.entities.filter((e) => e.alive);
  return {
    seed,
    arm,
    enemyWon: alive.length > 0 && sideOf(alive[0].team) === 1,
    ticks: w.tick,
    calls: cmd?.callCount ?? 0,
    accepted,
    rejected,
    errors: cmd?.trace.filter((t) => t.error).length ?? 0,
  };
}

function loadDone(): Set<string> {
  const done = new Set<string>();
  if (!existsSync(RESULTS)) return done;
  for (const line of readFileSync(RESULTS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Result;
      done.add(`${r.seed}:${r.arm}`);
    } catch {
      /* skip malformed */
    }
  }
  return done;
}

function loadAll(): Result[] {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Result);
}

/** Wilson score interval — behaves sensibly at small N, unlike the normal approximation. */
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - spread) / d, (centre + spread) / d];
}

/**
 * McNemar's test on the seeds both arms played. Only discordant pairs — where
 * the arms disagreed — carry information; matches both won or both lost say
 * nothing about which is better.
 */
function mcnemar(a: Result[], b: Result[]): string {
  const byA = new Map(a.map((r) => [r.seed, r.enemyWon]));
  let aOnly = 0;
  let bOnly = 0;
  for (const r of b) {
    const other = byA.get(r.seed);
    if (other === undefined || other === r.enemyWon) continue;
    if (r.enemyWon) bOnly++;
    else aOnly++;
  }
  const n = aOnly + bOnly;
  if (n < 10) return `  discordant pairs ${n} — too few to test`;
  const chi = (Math.abs(bOnly - aOnly) - 1) ** 2 / n; // continuity-corrected
  const p = Math.exp(-chi / 2); // rough upper bound on p for 1 df
  return `  discordant ${aOnly}/${bOnly}, chi2≈${chi.toFixed(2)}, p${p < 0.05 ? '<0.05' : '≈' + p.toFixed(2)}`;
}

function report(): void {
  const all = loadAll();
  console.log('\n=== RESULTS ===');
  const byArm = new Map<Arm, Result[]>();
  for (const arm of ARMS) byArm.set(arm, all.filter((r) => r.arm === arm));

  for (const arm of ARMS) {
    const rs = byArm.get(arm)!;
    if (rs.length === 0) continue;
    const wins = rs.filter((r) => r.enemyWon).length;
    const [lo, hi] = wilson(wins, rs.length);
    const calls = rs.reduce((s, r) => s + r.calls, 0);
    const rej = rs.reduce((s, r) => s + r.rejected, 0);
    const acc = rs.reduce((s, r) => s + r.accepted, 0);
    const err = rs.reduce((s, r) => s + r.errors, 0);
    console.log(
      `${arm.padEnd(9)} n=${String(rs.length).padStart(4)}  enemy win ${(
        (wins / rs.length) * 100
      ).toFixed(1)}%  [95% CI ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}]` +
        (calls ? `  calls ${calls}  orders ${acc} ok/${rej} rej  errors ${err}` : ''),
    );
  }

  for (const arm of ['llm', 'llm2'] as const) {
    const rs = byArm.get(arm)!;
    if (rs.length < 10) continue;
    console.log(`\nPaired comparisons (${arm} vs baselines, same seeds):`);
    console.log('  vs none:    ' + mcnemar(byArm.get('none')!, rs));
    console.log('  vs scripted:' + mcnemar(byArm.get('scripted')!, rs));
    if (arm === 'llm2') console.log('  vs llm(v1): ' + mcnemar(byArm.get('llm')!, rs));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'report') {
    report();
    return;
  }

  const count = Number(args[0] ?? 30);
  const startSeed = Number(args[1] ?? 0);
  const done = loadDone();
  const ask = createNodeAsk(MODEL);

  console.log(`Running seeds ${startSeed}..${startSeed + count - 1}, ${done.size} already done.`);
  console.log(`Model ${MODEL}. Ctrl-C is safe — progress is checkpointed.\n`);

  for (let i = 0; i < count; i++) {
    const seed = startSeed + i;
    for (const arm of ARMS) {
      const key = `${seed}:${arm}`;
      if (done.has(key)) continue;
      const t0 = Date.now();
      try {
        const r = await runMatch(seed, arm, ask);
        // An LLM arm where every call failed is the no-commander arm in
        // disguise. Recording it would silently corrupt the comparison.
        if ((arm === 'llm' || arm === 'llm2') && r.calls > 0 && r.accepted === 0) {
          console.log(`seed ${seed} ${arm} VOID: ${r.calls} calls, ${r.errors} errors, no orders landed`);
          continue;
        }
        appendFileSync(RESULTS, JSON.stringify(r) + '\n');
        console.log(
          `seed ${String(seed).padStart(4)} ${arm.padEnd(9)} ` +
            `${r.enemyWon ? 'ENEMY' : 'friendly'} ${String(r.ticks).padStart(5)}t ` +
            `${r.calls ? r.calls + ' calls ' : ''}${Date.now() - t0}ms`,
        );
      } catch (e) {
        // A failed arm must not be recorded: a missing row is retried later,
        // whereas a recorded loss would silently bias the result.
        console.log(`seed ${seed} ${arm} FAILED: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }

  report();
}

main();