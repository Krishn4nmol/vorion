import type { World } from '../../core/world';
import { buildSnapshot, updateKnowledge, type SquadKnowledge } from './snapshot';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import {
  extractJson,
  validateOrders,
  applyOrders,
  expireOrders,
  type Rejection,
} from './orders';

/** Transport: given a system and user prompt, return the model's raw text. */
export type AskFn = (system: string, user: string) => Promise<string>;

export interface TraceEntry {
  tick: number;
  prompt: string;
  response: string;
  accepted: { unitId: number; kind: string; reason: string }[];
  rejected: Rejection[];
  latencyMs: number;
  error?: string;
}

export interface CommanderOptions {
  intervalTicks?: number; // how often to think
  maxCalls?: number; // hard budget per match
  timeoutMs?: number;
  /**
   * 'async' keeps the 60Hz loop running while the request is in flight — right
   * for the live game. 'blocking' awaits each decision, which makes headless
   * eval runs comparable to each other instead of dependent on network jitter.
   */
  mode?: 'async' | 'blocking';
  trace?: boolean;
}

export class Commander {
  readonly knowledge: SquadKnowledge;
  readonly trace: TraceEntry[] = [];

  private ask: AskFn;
  private interval: number;
  private maxCalls: number;
  private timeoutMs: number;
  private mode: 'async' | 'blocking';
  private keepTrace: boolean;

  private inFlight = false;
  private pending: Promise<void> | null = null;
  private calls = 0;
  private failures = 0;
  private nextAllowedTick = 0;
  private lastCallTick = -Infinity;

  constructor(knowledge: SquadKnowledge, ask: AskFn, opts: CommanderOptions = {}) {
    this.knowledge = knowledge;
    this.ask = ask;
    this.interval = opts.intervalTicks ?? 180;
    this.maxCalls = opts.maxCalls ?? 40;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.mode = opts.mode ?? 'async';
    this.keepTrace = opts.trace ?? true;
  }

  get callCount(): number {
    return this.calls;
  }

  get failureCount(): number {
    return this.failures;
  }

  /** True while a decision is in flight — drives the HUD indicator. */
  get thinking(): boolean {
    return this.inFlight;
  }

  get lastDecision(): TraceEntry | null {
    return this.trace.length ? this.trace[this.trace.length - 1] : null;
  }

  /** Call once per tick, after step(). Never throws, never blocks in async mode. */
  update(w: World): void | Promise<void> {
    expireOrders(w);

    if (w.over) return;
    // Elapsed-time gate rather than modulo: this fires on the very first update
    // of a match, which is when a squad most needs direction, and it cannot be
    // skipped if the loop ever advances more than one tick per frame.
    if (w.tick - this.lastCallTick < this.interval) return;
    if (w.tick < this.nextAllowedTick) return;
    if (this.calls >= this.maxCalls) return;
    if (this.inFlight) return; // one decision at a time; skip rather than queue

    updateKnowledge(w, this.knowledge);
    const snap = buildSnapshot(w, this.knowledge);
    if (snap.squad.length === 0) return;

    const user = buildUserPrompt(snap, w.map.w, w.map.h);
    this.inFlight = true;
    this.calls++;
    this.lastCallTick = w.tick;

    const started = Date.now();
    const promise = (this.pending = this.request(user)
      .then((text) => this.consume(w, user, text, Date.now() - started))
      .catch((err) => this.fail(w, user, err, Date.now() - started))
      .finally(() => {
        this.inFlight = false;
        this.pending = null;
      }));

    if (this.mode === 'blocking') return promise;
  }

  private async request(user: string): Promise<string> {
    return await Promise.race([
      this.ask(SYSTEM_PROMPT, user),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('commander timeout')), this.timeoutMs),
      ),
    ]);
  }

  /**
   * Orders are re-validated against the world as it is NOW, not as it was when
   * the prompt was built. In async mode the sim has advanced during the round
   * trip: units may have died and enemies moved, so a stale-but-well-formed
   * order must still be checked before it lands.
   */
  private consume(w: World, prompt: string, text: string, latencyMs: number): void {
    const result = validateOrders(w, this.knowledge, extractJson(text));
    // Only apply if the match is still running — but always record, or a
    // decision that arrived a moment too late looks like nothing happened.
    if (!w.over) applyOrders(w, result);
    this.failures = 0;

    if (this.keepTrace) {
      this.trace.push({
        tick: w.tick,
        prompt,
        response: text,
        accepted: result.accepted.map((a) => ({
          unitId: a.unitId,
          kind: a.order.kind,
          reason: a.reason,
        })),
        rejected: result.rejected,
        latencyMs,
      });
    }
  }

  /**
   * A failed call is not an error condition for the game: units simply keep
   * fighting autonomously. Backoff doubles per consecutive failure so a dead
   * endpoint costs one call every few minutes rather than one every cycle.
   */
  private fail(w: World, prompt: string, err: unknown, latencyMs: number): void {
    this.failures++;
    this.nextAllowedTick = w.tick + this.interval * Math.min(8, 2 ** this.failures);

    if (this.keepTrace) {
      this.trace.push({
        tick: w.tick,
        prompt,
        response: '',
        accepted: [],
        rejected: [],
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Await any in-flight decision. Call at end of match before reading traces. */
  async flush(): Promise<void> {
    if (this.pending) await this.pending;
  }

  /** JSONL, one line per decision — replayable and diffable. */
  traceToJsonl(): string {
    return this.trace.map((t) => JSON.stringify(t)).join('\n');
  }
}