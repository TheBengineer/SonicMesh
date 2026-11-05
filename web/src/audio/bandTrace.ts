// Follows one upper harmonic of each drone through a spectrogram, one column at a time. The line is measured from the
// audio and knows nothing of where the drones are, but it does search around the blade-pass frequency of each class in
// the sim, so it would miss a drone unlike those. A single band is often too faint to follow by itself, so a drone's
// fundamental is found from all its harmonics together, as the detector's comb does, and its line is drawn at the one
// harmonic chosen when it locks. Harmonics of a locked drone are masked from the other searches. This is for display:
// it does not decide whether a node detects.

import { CLASS_ACOUSTICS } from '../acoustics/model';

// A search range either side of a class's blade-pass frequency: the Doppler shift of a fast drone, and rotor wobble.
const RANGE = 0.12;
const SEARCHES = (['fpv', 'mini', 'matrice'] as const).map((c) => CLASS_ACOUSTICS[c].bpf_hz);
export const MAX_TRACKS = SEARCHES.length;
const F0_RATIO = 1.005;
const TOP_HZ = 4000;
const MAX_HARMONICS = 16;
// A fundamental needs this many harmonics clear of other drones to count.
const MIN_FREE = 3;
// A drone's line is drawn at its harmonic nearest this, because upper harmonics show the Doppler shift and wobble best,
// and at least LINE_GAP_HZ from the other lines.
const DRAW_HZ = 2400;
const LINE_GAP_HZ = 250;
// Half-width of a harmonic as a fraction of its frequency, for rotors that differ by about 2 %.
const WIDTH = 0.02;
// Smoothing per column, about four columns.
const SMOOTH = 0.75;
// Mean height of the harmonics above their flanks, in colour steps: 255 steps is 80 dB, so 10 is about 3 dB.
const LOCK_STEPS = 10;
const HOLD_STEPS = 6;
const LOCK_COLS = 10;
const LOSE_COLS = 16;
const LOCK_DRIFT = 0.03;
// A fundamental moves slowly, so it is followed within this fraction per column.
const FOLLOW = 0.012;
const FOLLOW_GAIN = 0.25;

interface Track {
  f0: number;
  harmonic: number;
  misses: number;
}

interface Search {
  grid: number[];
  candidate: number;
  candidateCols: number;
  track: Track | null;
}

export class BandTracer {
  private readonly power: Float32Array;
  private readonly sum: Float64Array;
  private readonly masked: Uint8Array;
  private readonly searches: Search[];
  private readonly out = new Array<number>(MAX_TRACKS).fill(0);
  private seeded = false;

  constructor(
    private readonly bins: number,
    private readonly binHz: number,
  ) {
    this.power = new Float32Array(bins);
    this.sum = new Float64Array(bins + 1);
    this.masked = new Uint8Array(bins);
    this.searches = SEARCHES.map((bpf) => {
      const grid: number[] = [];
      for (let f = bpf * (1 - RANGE); f <= bpf * (1 + RANGE); f *= F0_RATIO) grid.push(f);
      return { grid, candidate: 0, candidateCols: 0, track: null };
    });
  }

  // Forgets every band, for the time the tracer is not being fed.
  reset(): void {
    this.seeded = false;
    for (const s of this.searches) {
      s.track = null;
      s.candidateCols = 0;
    }
  }

  // One column of colour steps, lowest bin first. Returns the frequency in Hz of each search's line, 0 for none. The
  // array is reused by the next call.
  push(column: ArrayLike<number>): readonly number[] {
    const p = this.power;
    const a = this.seeded ? SMOOTH : 0;
    this.sum[0] = 0;
    for (let k = 0; k < this.bins; k++) {
      p[k] = a * p[k] + (1 - a) * column[k];
      this.sum[k + 1] = this.sum[k] + p[k];
    }
    this.seeded = true;
    for (const s of this.searches) if (s.track) this.follow(s, s.track);
    this.acquire();
    this.searches.forEach((s, i) => {
      this.out[i] = s.track ? s.track.harmonic * s.track.f0 : 0;
    });
    return this.out;
  }

  private mean(lo: number, hi: number): number {
    const a = Math.max(0, lo);
    const b = Math.min(this.bins - 1, hi);
    return b < a ? 0 : (this.sum[b + 1] - this.sum[a]) / (b - a + 1);
  }

  // How far a band at hz stands above the bins either side, in colour steps. Never below zero.
  private height(hz: number): number {
    const k = Math.round(hz / this.binHz);
    const half = Math.max(1, Math.round((WIDTH * hz) / this.binHz));
    const flank = half + 2;
    const band = this.mean(k - half, k + half);
    const below = this.mean(k - half - flank, k - half - 1);
    const above = this.mean(k + half + 1, k + half + flank);
    return Math.max(0, band - (below + above) / 2);
  }

  // Mean height of a fundamental's harmonics, leaving out those masked by another drone.
  private score(f0: number, useMask: boolean): number {
    const n = Math.min(MAX_HARMONICS, Math.floor(TOP_HZ / f0));
    let total = 0;
    let free = 0;
    for (let h = 1; h <= n; h++) {
      const hz = h * f0;
      if (useMask && this.masked[Math.round(hz / this.binHz)]) continue;
      total += this.height(hz);
      free++;
    }
    return useMask && free < MIN_FREE ? 0 : total / Math.max(1, free);
  }

  private best(grid: number[], lo: number, hi: number, useMask: boolean): { f0: number; score: number } {
    let f0 = 0;
    let score = -1;
    for (const f of grid) {
      if (f < lo || f > hi) continue;
      const s = this.score(f, useMask);
      if (s > score) {
        score = s;
        f0 = f;
      }
    }
    return { f0, score };
  }

  private follow(s: Search, t: Track): void {
    const { f0, score } = this.best(s.grid, t.f0 * (1 - FOLLOW), t.f0 * (1 + FOLLOW), false);
    if (score < HOLD_STEPS) {
      if (++t.misses >= LOSE_COLS) s.track = null;
      return;
    }
    t.misses = 0;
    t.f0 += FOLLOW_GAIN * (f0 - t.f0);
  }

  private mask(): void {
    this.masked.fill(0);
    for (const s of this.searches) {
      if (!s.track) continue;
      const f0 = s.track.f0;
      for (let h = 1; h * f0 <= TOP_HZ; h++) {
        const hz = h * f0;
        const k = Math.round(hz / this.binHz);
        const half = Math.max(1, Math.round((WIDTH * hz) / this.binHz)) + 1;
        for (let j = Math.max(0, k - half); j <= Math.min(this.bins - 1, k + half); j++) this.masked[j] = 1;
      }
    }
  }

  // The harmonic to draw: nearest DRAW_HZ and clear of the other lines, or simply nearest if none is clear.
  private lineHarmonic(f0: number): number {
    const others = this.searches.flatMap((s) => (s.track ? [s.track.harmonic * s.track.f0] : []));
    const top = Math.max(1, Math.floor(TOP_HZ / f0));
    let best = Math.min(top, Math.max(1, Math.round(DRAW_HZ / f0)));
    let bestD = Infinity;
    for (let h = 1; h <= top; h++) {
      const hz = h * f0;
      if (others.some((o) => Math.abs(o - hz) < LINE_GAP_HZ)) continue;
      const d = Math.abs(hz - DRAW_HZ);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  private acquire(): void {
    this.mask();
    for (const s of this.searches) {
      if (s.track) continue;
      const { f0, score } = this.best(s.grid, 0, Infinity, true);
      if (score < LOCK_STEPS) {
        s.candidateCols = 0;
        continue;
      }
      const steady = s.candidateCols > 0 && Math.abs(f0 / s.candidate - 1) <= LOCK_DRIFT;
      s.candidate = f0;
      s.candidateCols = steady ? s.candidateCols + 1 : 1;
      if (s.candidateCols < LOCK_COLS) continue;
      s.track = { f0, harmonic: this.lineHarmonic(f0), misses: 0 };
      s.candidateCols = 0;
      this.mask();
    }
  }
}
