import type { World, GameEvent } from '../core/world';
import type { RenderState } from './canvas';

/**
 * Procedural audio. Every sound is synthesised from noise and oscillators —
 * no sample files, nothing to license, nothing to load.
 *
 * Audio is render-side only. It reads the event bus and never touches the
 * simulation, exactly like the animation state, so headless eval runs are
 * unaffected.
 */

/**
 * Beyond this, sounds are inaudible. Deliberately larger than SIGHT_RANGE
 * (430): hearing a firefight you cannot see is information the screen does not
 * give you, and it makes an approaching squad feel threatening rather than
 * sudden.
 */
const MAX_DIST = 1400;

/** Hard cap on simultaneous voices. Four bots firing is ~34 sounds/second. */
const MAX_VOICES = 14;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices = 0;
  private muted = false;

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.now(), 0.02);
    }
    return this.muted;
  }

  /**
   * Browsers refuse to start audio without a user gesture, so this is called
   * from the first keypress or click rather than at load.
   */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;

    // Gentle limiter. Without it, several shots landing on the same frame
    // clip audibly.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 12;
    comp.attack.value = 0.002;
    comp.release.value = 0.15;

    this.master.connect(comp).connect(this.ctx.destination);
    this.noise = this.makeNoise(1.0);
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Distance attenuation and stereo placement relative to the camera centre. */
  private place(
    rs: RenderState,
    x: number,
    y: number,
    viewW: number,
  ): { gain: number; pan: number; near: number } | null {
    const cx = rs.camera.x + viewW / 2;
    const cy = rs.camera.y + 440; // VIEW_H / 2
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d > MAX_DIST) return null;

    const near = 1 - d / MAX_DIST; // 1 at the camera, 0 at the edge of hearing
    return {
      gain: near * near, // inverse-square-ish; linear falloff sounds too flat
      pan: Math.max(-1, Math.min(1, dx / (viewW * 0.6))),
      near,
    };
  }

  private voice(): boolean {
    if (!this.ctx || this.muted || this.voices >= MAX_VOICES) return false;
    this.voices++;
    return true;
  }

  private release(node: AudioScheduledSourceNode): void {
    node.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
    };
  }

  /**
   * Gunshot: a noise burst through a rapidly closing lowpass, plus a short
   * low sine for body. Distant shots get a lower cutoff — air absorbs high
   * frequencies first, and it doubles as a distance cue.
   */
  private shot(gain: number, pan: number, near: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.playbackRate.value = 0.9 + Math.random() * 0.25;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1200 + 5200 * near, t);
    lp.frequency.exponentialRampToValueAtTime(180 + 400 * near, t + 0.09);
    lp.Q.value = 1.2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain * 0.55, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    src.connect(lp).connect(env).connect(panner).connect(this.master!);
    src.start(t, Math.random() * 0.5, 0.14);

    // low-frequency thump for weight
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.07);
    const oenv = ctx.createGain();
    oenv.gain.setValueAtTime(gain * 0.35, t);
    oenv.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(oenv).connect(panner);
    osc.start(t);
    osc.stop(t + 0.09);

    this.release(src);
  }

  /** Impact: shorter, brighter, with a click transient. */
  private impact(gain: number, pan: number, onPlayer: boolean): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.playbackRate.value = 1.6;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = onPlayer ? 700 : 1800;
    bp.Q.value = 1.6;

    const env = ctx.createGain();
    const level = gain * (onPlayer ? 0.9 : 0.4);
    env.gain.setValueAtTime(level, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + (onPlayer ? 0.18 : 0.06));

    const panner = ctx.createStereoPanner();
    panner.pan.value = onPlayer ? 0 : pan;

    src.connect(bp).connect(env).connect(panner).connect(this.master!);
    src.start(t, Math.random() * 0.5, 0.2);
    this.release(src);
  }

  /** Death: a descending filtered thud. */
  private death(gain: number, pan: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.35);

    const env = ctx.createGain();
    env.gain.setValueAtTime(gain * 0.5, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    osc.connect(env).connect(panner).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.42);
    this.release(osc);
  }

  /** Reload: two mechanical clicks, mag out then mag in. */
  private reload(gain: number, pan: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    for (const [delay, freq] of [
      [0, 2600],
      [0.13, 1900],
    ] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise!;
      src.playbackRate.value = 2.2;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 5;

      const env = ctx.createGain();
      env.gain.setValueAtTime(gain * 0.3, t + delay);
      env.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.05);

      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;

      src.connect(bp).connect(env).connect(panner).connect(this.master!);
      src.start(t + delay, Math.random() * 0.5, 0.06);
      this.release(src);
    }
  }

  /**
   * Turns one tick's events into sound. Called from the game loop alongside
   * ingestEvents, and shares its contract: read-only over the world.
   */
  ingest(w: World, rs: RenderState, events: GameEvent[], playerId: number, viewW: number): void {
    if (!this.ctx || this.muted) return;

    for (const ev of events) {
      let x = 0;
      let y = 0;
      let onPlayer = false;

      if (ev.type === 'fire') {
        const e = w.entities.find((n) => n.id === ev.shooterId);
        if (!e) continue;
        x = e.pos.x;
        y = e.pos.y;
      } else if (ev.type === 'damage' || ev.type === 'death') {
        const v = w.entities.find((n) => n.id === ev.victimId);
        if (!v) continue;
        x = v.pos.x;
        y = v.pos.y;
        onPlayer = v.id === playerId;
      } else {
        const e = w.entities.find((n) => n.id === ev.entityId);
        if (!e) continue;
        x = e.pos.x;
        y = e.pos.y;
      }

      const p = this.place(rs, x, y, viewW);
      if (!p) continue;
      if (!this.voice()) continue;

      if (ev.type === 'fire') this.shot(p.gain, p.pan, p.near);
      else if (ev.type === 'damage') this.impact(p.gain, p.pan, onPlayer);
      else if (ev.type === 'death') this.death(p.gain, p.pan);
      else this.reload(p.gain, p.pan);
    }
  }
}