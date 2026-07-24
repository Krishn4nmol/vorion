/** Deterministic PRNG (mulberry32). The ONLY source of randomness in core/. */
export class SeededRNG {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, maxExclusive: number): number {
    return Math.floor(this.range(min, maxExclusive));
  }

  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length)];
  }

  getState(): number {
    return this.s;
  }

  setState(s: number): void {
    this.s = s >>> 0;
  }
}