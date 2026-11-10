// Harmonic-comb detector, ported from sim/detector/detector.py. tests/comb.test.ts holds it to that code frame by
// frame, so a change to one needs the same change to the other and a new fixture.
import { fft, hann } from '../acoustics/dsp';

const FS = 16_000;
const REF_PA = 20e-6;
const REF_HOP = 512;
const BASE_N = 1024;
const F_HARM_LIMIT_HZ = 4000;
const F0_MIN = 80;
const F0_MAX = 1200;
const F0_RATIO = 1.005;
const N_HARM_MAX = 16;
const TOL = 0.03;
const RELATED_TOL = 0.04;
const SUB_RATIO = 0.85;
const GATE_LOG = Math.log10(2);
const FINE_STEPS = 30;
const FINE_REL = 0.001;
const INIT_MIN_FRAMES = 3;
const MIN_HALF_HZ = FS / 1024;
const MIN_FLANK_HZ = (3 * FS) / 1024;
const MAX_H = 6;

export const COMB_LO_HZ = F0_MIN;
export const COMB_HI_HZ = F_HARM_LIMIT_HZ;

// Time constants are in baseline hops of 512 samples, as in Params in detector.py.
export interface CombParams {
  theta: number;
  holdRatio: number;
  kOn: number;
  mWin: number;
  holdFrames: number;
  smooth: number;
  floorUpDb: number;
  floorDownDb: number;
  floorGateDb: number;
  useAge: boolean;
  ageMin: number;
  goodFrac: number;
  useHarm: boolean;
  harmMin: number;
  harmTol: number;
  useImpulse: boolean;
  jumpDb: number;
  impulseHold: number;
  useSlew: boolean;
  slewRatio: number;
  gapFrames: number;
  // Above 0, a track re-found at a ratio a/b of its last pitch, a and b up to this, also keeps its age. Needs gapFrames.
  gapHarm: number;
  // No sub-harmonic takeover while the track's own score is 0, when 0 >= 0.85 * 0 would otherwise move it.
  subGuard: boolean;
  gateHarm: number;
  initFrames: number;
  refFrames: number;
  initEnvBins: number;
  nFft: number;
  hop: number;
}

export const DEFAULT_COMB_PARAMS: CombParams = {
  theta: 0.16,
  holdRatio: 1,
  kOn: 6,
  mWin: 16,
  holdFrames: 32,
  smooth: 0.75,
  floorUpDb: 0.1,
  floorDownDb: 0.5,
  floorGateDb: 6,
  useAge: true,
  ageMin: 62,
  goodFrac: 0.7,
  useHarm: true,
  harmMin: 2,
  harmTol: 0.04,
  useImpulse: true,
  jumpDb: 6,
  impulseHold: 4,
  useSlew: false,
  slewRatio: 1.3,
  gapFrames: 0,
  gapHarm: 0,
  subGuard: true,
  gateHarm: 1,
  initFrames: 8,
  refFrames: 31,
  initEnvBins: 0,
  nFft: BASE_N,
  hop: REF_HOP,
};

// What nodes run: CHOSEN in sim/perimeter/run.py, the round-2 setting that round 3 kept as the default.
export const NODE_COMB_PARAMS: Partial<CombParams> = { theta: 0.1 };

// Round half to even, as numpy's rint and Python's round do.
function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function clip(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Whether two pitches stand at a ratio a/b with a and b up to limit.
function related(fa: number, fb: number, limit: number): boolean {
  const ratio = Math.max(fa, fb) / Math.min(fa, fb);
  for (let a = 1; a <= limit; a++) for (let b = 1; b <= a; b++) if (Math.abs((ratio * b) / a - 1) <= RELATED_TOL) return true;
  return false;
}

function median(values: Float64Array): number {
  values.sort();
  const n = values.length;
  return n % 2 === 1 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
}

function toFrames(p: CombParams): CombParams {
  const k = p.hop / REF_HOP;
  const count = (x: number, floorOne = true): number => {
    if (x === 0) return 0;
    const v = rint(x / k);
    return floorOne ? Math.max(1, v) : v;
  };
  return {
    ...p,
    smooth: p.smooth ** k,
    floorUpDb: p.floorUpDb * k,
    floorDownDb: p.floorDownDb * k,
    kOn: count(p.kOn),
    mWin: count(p.mWin),
    holdFrames: count(p.holdFrames),
    ageMin: count(p.ageMin),
    impulseHold: count(p.impulseHold, false),
    gapFrames: count(p.gapFrames, false),
    initEnvBins: rint(p.initEnvBins * (p.nFft / BASE_N)),
    refFrames: count(p.refFrames),
    initFrames: Math.max(INIT_MIN_FRAMES, rint(p.initFrames / k)),
  };
}

// The read-only tables for one frame length. Harmonic tables are flat: [candidate * N_HARM_MAX + harmonic - 1].
class Geometry {
  readonly n: number;
  readonly nb: number;
  readonly df: number;
  readonly loBin: number;
  readonly hann: Float64Array;
  readonly hannPow: number;
  readonly grid: number;
  readonly f0: Float64Array;
  readonly nh: Int32Array;
  readonly lo: Int32Array;
  readonly hi1: Int32Array;
  readonly a: Int32Array;
  readonly b: Int32Array;
  readonly invWin: Float64Array;
  readonly invFlank: Float64Array;
  readonly valid: Uint8Array;
  readonly hasFlank: Uint8Array;
  readonly sub: Int32Array;
  readonly trackStep: number;

  constructor(nFft: number, hop: number) {
    if (nFft < 256 || nFft > 16384 || hop <= 0 || hop > nFft) throw new Error(`comb: unsupported frame ${nFft}/${hop}`);
    const df = FS / nFft;
    const nb = rint(F_HARM_LIMIT_HZ / df) + 1;
    const loBin = Math.ceil(F0_MIN / df);
    const minHalf = Math.max(1, rint(MIN_HALF_HZ / df));
    const minFlank = Math.max(3, rint(MIN_FLANK_HZ / df));
    const grid = Math.floor(Math.log(F0_MAX / F0_MIN) / Math.log(F0_RATIO)) + 1;
    this.n = nFft;
    this.nb = nb;
    this.df = df;
    this.loBin = loBin;
    this.hann = hann(nFft);
    this.hannPow = this.hann.reduce((sum, w) => sum + w * w, 0);
    this.grid = grid;
    this.f0 = new Float64Array(grid);
    this.nh = new Int32Array(grid);
    const size = grid * N_HARM_MAX;
    this.lo = new Int32Array(size);
    this.hi1 = new Int32Array(size);
    this.a = new Int32Array(size);
    this.b = new Int32Array(size);
    this.invWin = new Float64Array(size);
    this.invFlank = new Float64Array(size);
    this.valid = new Uint8Array(size);
    this.hasFlank = new Uint8Array(size);
    this.sub = new Int32Array(grid * 4).fill(-1);
    for (let i = 0; i < grid; i++) {
      this.f0[i] = F0_MIN * F0_RATIO ** i;
      this.nh[i] = Math.min(N_HARM_MAX, Math.floor(F_HARM_LIMIT_HZ / this.f0[i]));
      for (let h = 1; h <= N_HARM_MAX; h++) {
        const o = i * N_HARM_MAX + h - 1;
        const c = rint((this.f0[i] * h) / df);
        const half = Math.max(minHalf, rint(TOL * c));
        const valid = h <= this.nh[i] && c < nb;
        const lo = clip(c - half, loBin, nb);
        const hi1 = clip(c + half + 1, loBin, nb);
        const fl = Math.max(minFlank, 2 * half);
        const a = clip(lo - fl, loBin, nb);
        const b = clip(hi1 + fl, loBin, nb);
        const flank = Math.max(lo - a + (b - hi1), 0);
        this.lo[o] = lo;
        this.hi1[o] = hi1;
        this.a[o] = a;
        this.b[o] = b;
        this.valid[o] = valid ? 1 : 0;
        this.invWin[o] = valid ? 1 / Math.max(hi1 - lo, 1) : 0;
        this.hasFlank[o] = valid && flank > 0 ? 1 : 0;
        this.invFlank[o] = valid && flank > 0 ? 1 / flank : 0;
      }
    }
    for (let i = 0; i < grid; i++) {
      for (let m = 2; m <= 4; m++) {
        const target = this.f0[i] / m;
        const j = clip(rint(Math.log(target / F0_MIN) / Math.log(F0_RATIO)), 0, grid - 1);
        const ok = Math.abs(this.f0[j] / target - 1) < 0.5 * (F0_RATIO - 1) && target >= F0_MIN * 0.99;
        this.sub[i * 4 + m - 1] = ok ? j : -1;
      }
    }
    this.trackStep = rint((TOL * (hop / REF_HOP)) / Math.log(F0_RATIO));
  }
}

const geometries = new Map<string, Geometry>();
function geometry(nFft: number, hop: number): Geometry {
  const key = `${nFft}/${hop}`;
  let g = geometries.get(key);
  if (!g) {
    g = new Geometry(nFft, hop);
    geometries.set(key, g);
  }
  return g;
}

export class CombDetector {
  readonly nFft: number;
  readonly hop: number;
  // The detector's output for the latest frame.
  on = false;
  f0Hz = 0;
  score = 0;
  nharm = 0;
  bandDb = 0;
  floorDb = 0;
  // Best comb score over all candidates this frame: what is compared with theta to start a track.
  peak = 0;
  // Track state.
  q = 0;
  index = -1;
  frames = 0;

  readonly theta: number;
  private readonly p: CombParams;
  private readonly g: Geometry;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly power: Float64Array;
  private readonly ps: Float64Array;
  private readonly level: Float64Array;
  private readonly floor: Float64Array;
  private readonly w: Float64Array;
  private readonly cs: Float64Array;
  private readonly s: Float32Array;
  private readonly init: Float64Array;
  private readonly column: Float64Array;
  private initCount = 0;
  private started = false;
  private floorReady = false;
  private bbPrev = 0;
  private impulseLeft = 0;
  private t = -1;
  private lastHit = -1e9;
  private age = 0;
  private good = 0;
  private ref = -1;
  private refT = 0;
  private dormant: { index: number; age: number; good: number; lastHit: number } | null = null;

  constructor(params: Partial<CombParams> = {}) {
    const given = { ...DEFAULT_COMB_PARAMS, ...params };
    this.p = toFrames(given);
    this.theta = given.theta;
    this.nFft = given.nFft;
    this.hop = given.hop;
    const g = geometry(given.nFft, given.hop);
    this.g = g;
    this.re = new Float64Array(g.n);
    this.im = new Float64Array(g.n);
    this.power = new Float64Array(g.nb);
    this.ps = new Float64Array(g.nb);
    this.level = new Float64Array(g.nb);
    this.floor = new Float64Array(g.nb);
    this.w = new Float64Array(g.nb);
    this.cs = new Float64Array(g.nb + 1);
    this.s = new Float32Array(g.grid);
    this.init = new Float64Array(this.p.initFrames * g.nb);
    this.column = new Float64Array(this.p.initFrames);
  }

  // One frame of nFft samples of pressure in Pa. The caller advances by hop between frames.
  step(x: ArrayLike<number>): boolean {
    this.frames++;
    this.powerOf(x);
    if (!this.combOf()) return false;
    this.update();
    this.outputs();
    return this.on;
  }

  stateHash(): string {
    return `${this.frames}:${this.q}:${this.index}:${this.age}:${this.good}:${this.on ? 1 : 0}:${this.f0Hz.toFixed(6)}`;
  }

  private powerOf(x: ArrayLike<number>): void {
    const g = this.g;
    const { re, im } = this;
    for (let i = 0; i < g.n; i++) {
      re[i] = x[i] * g.hann[i];
      im[i] = 0;
    }
    fft(re, im);
    const scale = 2 / (g.n * g.hannPow);
    for (let k = 0; k < g.nb; k++) this.power[k] = scale * (re[k] * re[k] + im[k] * im[k]);
  }

  // Smoothing, floor and comb. False during start-up.
  private combOf(): boolean {
    const p = this.p;
    const g = this.g;
    const { ps, power, level, floor, w } = this;
    for (let k = 0; k < g.nb; k++) {
      ps[k] = this.started ? p.smooth * ps[k] + (1 - p.smooth) * power[k] : power[k];
      level[k] = 10 * Math.log10(ps[k] + 1e-20);
    }
    this.started = true;
    if (this.initCount < p.initFrames) {
      this.init.set(level, this.initCount * g.nb);
      this.initCount++;
      return false;
    }
    if (!this.floorReady) this.startFloor();

    let sum = 0;
    for (let k = g.loBin; k < g.nb; k++) sum += power[k];
    const bb = 10 * Math.log10(sum + 1e-20);
    const rose = bb - this.bbPrev > p.jumpDb;
    const jump = p.useImpulse && (rose || this.impulseLeft > 0);
    if (p.useImpulse) this.impulseLeft = rose ? p.impulseHold : Math.max(0, this.impulseLeft - 1);
    this.bbPrev = bb;

    for (let k = 0; k < g.nb; k++) {
      if (!jump) {
        if (level[k] < floor[k]) floor[k] -= p.floorDownDb;
        else if (level[k] <= floor[k] + p.floorGateDb) floor[k] += p.floorUpDb;
      }
      w[k] = k < g.loBin ? 0 : 10 ** ((level[k] - floor[k]) / 10);
    }
    const cs = this.cs;
    cs[0] = 0;
    for (let k = 0; k < g.nb; k++) cs[k + 1] = cs[k] + w[k];

    const s = this.s;
    let peak = 0;
    for (let c = 0; c < g.grid; c++) {
      let total = 0;
      let gate = false;
      const base = c * N_HARM_MAX;
      const nh = g.nh[c];
      for (let h = 0; h < N_HARM_MAX; h++) {
        const o = base + h;
        if (!g.valid[o] || !g.hasFlank[o]) continue;
        const win = (cs[g.hi1[o]] - cs[g.lo[o]]) * g.invWin[o];
        const fl = (cs[g.lo[o]] - cs[g.a[o]] + cs[g.b[o]] - cs[g.hi1[o]]) * g.invFlank[o];
        const ratio = win / Math.max(fl, 1e-30);
        if (ratio <= 1) continue;
        const e = Math.log10(ratio);
        total += e;
        if (h < p.gateHarm && e >= GATE_LOG) gate = true;
      }
      s[c] = jump || !gate ? 0 : total / nh;
      if (s[c] > peak) peak = s[c];
    }
    this.peak = peak;
    return true;
  }

  private startFloor(): void {
    const p = this.p;
    const g = this.g;
    const { floor, column, init } = this;
    for (let k = 0; k < g.nb; k++) {
      for (let f = 0; f < p.initFrames; f++) column[f] = init[f * g.nb + k];
      floor[k] = median(column);
    }
    if (p.initEnvBins > 0) {
      const w = p.initEnvBins;
      const env = new Float64Array(g.nb);
      const window = new Float64Array(2 * w + 1);
      for (let k = 0; k < g.nb; k++) {
        for (let j = -w; j <= w; j++) window[j + w] = floor[clip(k + j, 0, g.nb - 1)];
        env[k] = median(window);
      }
      for (let k = 0; k < g.nb; k++) floor[k] = Math.min(floor[k], env[k]);
    }
    this.floorReady = true;
  }

  private harmonicCount(c: number, tol: number): number {
    const g = this.g;
    const w = this.w;
    let count = 0;
    for (let h = 1; h <= MAX_H && h <= g.nh[c]; h++) {
      const o = c * N_HARM_MAX + h - 1;
      const lo = g.lo[o];
      const hi1 = g.hi1[o];
      if (hi1 <= lo) continue;
      let b = lo;
      for (let k = lo + 1; k < hi1; k++) if (w[k] > w[b]) b = k;
      const fa = g.a[o];
      const fb = g.b[o];
      const size = lo - fa + (fb - hi1);
      if (size === 0) continue;
      const mean = (this.cs[lo] - this.cs[fa] + this.cs[fb] - this.cs[hi1]) / size;
      if (w[b] < 2 * Math.max(mean, 1e-30)) continue;
      if (Math.abs((b * g.df) / (g.f0[c] * h) - 1) <= tol) count++;
    }
    return count;
  }

  // Whether a hit on candidate c stands, and its harmonic count.
  private hitOk(c: number): [boolean, number] {
    const p = this.p;
    if (p.useSlew && this.ref >= 0 && Math.abs(Math.log(this.g.f0[c] / this.g.f0[this.ref])) > Math.log(p.slewRatio)) return [false, 0];
    const h = p.useHarm || p.useAge ? this.harmonicCount(c, p.harmTol) : 0;
    return [!p.useHarm || h >= p.harmMin, h];
  }

  private argmax(lo: number, hi: number): number {
    let c = lo;
    for (let i = lo + 1; i <= hi; i++) if (this.s[i] > this.s[c]) c = i;
    return c;
  }

  private update(): void {
    const p = this.p;
    const g = this.g;
    const s = this.s;
    this.t++;
    if (this.q === 0) {
      const c = this.argmax(0, g.grid - 1);
      if (s[c] >= p.theta) {
        const [ok, h] = this.hitOk(c);
        if (ok) {
          let age = 1;
          let good = h >= p.harmMin ? 1 : 0;
          const d = this.dormant;
          if (p.gapFrames > 0 && d && this.t - d.lastHit <= p.gapFrames && (Math.abs(c - d.index) <= g.trackStep || related(g.f0[c], g.f0[d.index], p.gapHarm))) {
            age = d.age + 1;
            good = d.good + (h >= p.harmMin ? 1 : 0);
          }
          this.dormant = null;
          this.index = c;
          this.q = 1;
          this.lastHit = this.t;
          this.age = age;
          this.good = good;
          this.ref = c;
          this.refT = this.t;
        }
      }
    } else {
      const c = this.argmax(Math.max(0, this.index - g.trackStep), Math.min(g.grid - 1, this.index + g.trackStep));
      const [ok, h] = s[c] >= p.theta * p.holdRatio ? this.hitOk(c) : [false, 0];
      if (ok) {
        this.index = c;
        this.q = Math.min(p.mWin, this.q + 1);
        this.lastHit = this.t;
        this.age++;
        if (h >= p.harmMin) this.good++;
      } else {
        this.q--;
        if (this.q === 0) {
          if (p.gapFrames > 0 && this.age > 0) this.dormant = { index: this.index, age: this.age, good: this.good, lastHit: this.lastHit };
          this.index = -1;
          this.age = 0;
          this.good = 0;
        }
      }
      if (this.q > 0 && this.t - this.refT >= p.refFrames) {
        this.ref = this.index;
        this.refT = this.t;
      }
    }
    if (this.q > 0) {
      // Sub-harmonic takeover: the lowest candidate that is nearly as strong.
      for (const m of [3, 2, 1]) {
        const j = g.sub[this.index * 4 + m];
        if ((!p.subGuard || s[this.index] > 0) && j >= 0 && s[j] >= SUB_RATIO * s[this.index]) {
          this.index = j;
          break;
        }
      }
      if (this.q >= p.kOn && (!p.useAge || (this.age >= p.ageMin && this.good >= p.goodFrac * this.age))) this.on = true;
    }
    if (this.on && this.t - this.lastHit > p.holdFrames) this.on = false;
  }

  private outputs(): void {
    const g = this.g;
    const { q, index } = this;
    this.score = q > 0 ? (q / this.p.mWin) * this.s[index] : 0;
    this.f0Hz = q > 0 ? g.f0[index] : 0;
    this.nharm = q > 0 ? g.nh[index] : 0;
    if (this.on && q > 0) this.fineF0();
    let sum = 0;
    let floor = 0;
    if (this.nharm > 0) {
      const lo = Math.ceil((0.5 * this.f0Hz) / g.df);
      const hi = Math.min(g.nb - 1, Math.trunc((this.nharm * this.f0Hz) / g.df));
      for (let k = lo; k <= hi; k++) {
        sum += this.power[k];
        floor += this.floor[k];
      }
      floor /= hi - lo + 1;
    } else {
      for (let k = 0; k < g.nb; k++) {
        sum += this.power[k];
        floor += this.floor[k];
      }
      floor /= g.nb;
    }
    this.bandDb = 10 * Math.log10(Math.max(sum, 1e-30) / (REF_PA * REF_PA));
    this.floorDb = floor;
  }

  // Sub-grid f0: the candidate within 3 % of the track that maximises the log of W at its exact harmonics.
  private fineF0(): void {
    const g = this.g;
    const w = this.w;
    let bestScore = -Infinity;
    let bestF = this.f0Hz;
    let bestNh = 0;
    for (let j = -FINE_STEPS; j <= FINE_STEPS; j++) {
      const f = this.f0Hz * (1 + FINE_REL * j);
      const nh = Math.min(N_HARM_MAX, Math.floor(F_HARM_LIMIT_HZ / f));
      let total = 0;
      for (let h = 1; h <= nh; h++) {
        const x = (f * h) / g.df;
        if (x >= g.nb - 1) continue;
        const i0 = Math.floor(x);
        const fr = x - i0;
        const val = w[i0] * (1 - fr) + w[i0 + 1] * fr;
        if (val > 1) total += Math.log10(val);
      }
      const score = total / Math.max(nh, 1);
      if (score > bestScore) {
        bestScore = score;
        bestF = f;
        bestNh = nh;
      }
    }
    this.f0Hz = bestF;
    this.nharm = bestNh;
  }
}
