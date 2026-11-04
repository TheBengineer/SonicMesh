import { fft } from './dsp';
import type { PoseLog, SampleRing, Vec3 } from './history';
import { ABS_DB_KM, ABS_F, FS, MAEKAWA_HZ, SOUND_SPEED_MPS as C } from './model';

const BARRIER_STEPS = 32;
// Air absorption FIR: taps per path, design grid every AIR_GRID_M metres up to AIR_MAX_M. Shared with render.py.
export const AIR_TAPS = 32;
const AIR_GRID_M = 20;
const AIR_MAX_M = 8000;
const AIR_GRID_N = AIR_MAX_M / AIR_GRID_M;
const AIR_DESIGN_N = 512;

// ISO 9613-1 attenuation in dB/km, linear in frequency between the table points, clamped at the ends.
export function absDbPerKm(f: number): number {
  if (f <= ABS_F[0]) return ABS_DB_KM[0];
  for (let i = 1; i < ABS_F.length; i++) {
    if (f <= ABS_F[i]) {
      const t = (f - ABS_F[i - 1]) / (ABS_F[i] - ABS_F[i - 1]);
      return ABS_DB_KM[i - 1] + t * (ABS_DB_KM[i] - ABS_DB_KM[i - 1]);
    }
  }
  return ABS_DB_KM[ABS_DB_KM.length - 1];
}

// Minimum-phase FIR (first AIR_TAPS taps) whose magnitude is the ISO attenuation over distance r. Cepstral method on
// a 512-point grid: the log-amplitude is folded to a causal cepstrum, then exponentiated back.
export function airFir(r: number, out: Float64Array): void {
  const n = AIR_DESIGN_N;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const scale = ((r / 1000) * Math.LN10) / 20;
  for (let i = 0; i <= n / 2; i++) {
    const v = -absDbPerKm((i * FS) / n) * scale;
    re[i] = v;
    if (i > 0 && i < n / 2) re[n - i] = v;
  }
  fft(re, im, true);
  const cre = new Float64Array(n);
  const cim = new Float64Array(n);
  cre[0] = re[0];
  for (let i = 1; i < n / 2; i++) cre[i] = 2 * re[i];
  cre[n / 2] = re[n / 2];
  fft(cre, cim);
  for (let i = 0; i < n; i++) {
    const m = Math.exp(cre[i]);
    const ph = cim[i];
    cre[i] = m * Math.cos(ph);
    cim[i] = m * Math.sin(ph);
  }
  fft(cre, cim, true);
  for (let k = 0; k < AIR_TAPS; k++) out[k] = cre[k];
}

let airGridCache: Float64Array | null = null;

// Taps for every grid distance, built once on first use.
function airGrid(): Float64Array {
  if (airGridCache) return airGridCache;
  const table = new Float64Array((AIR_GRID_N + 1) * AIR_TAPS);
  const row = new Float64Array(AIR_TAPS);
  for (let g = 0; g <= AIR_GRID_N; g++) {
    airFir(g * AIR_GRID_M, row);
    table.set(row, g * AIR_TAPS);
  }
  airGridCache = table;
  return table;
}

// Air absorption for one path. The taps are set per block from the path length (linear between grid points); the
// output is the FIR applied to the input, so each path has its own filter state.
export class AirFilter {
  private readonly taps = new Float64Array(AIR_TAPS);
  private readonly hist = new Float64Array(2 * AIR_TAPS);
  private pos = 0;

  setDistance(r: number): void {
    const table = airGrid();
    const g = Math.min(Math.max(r / AIR_GRID_M, 0), AIR_GRID_N);
    const i0 = Math.min(Math.floor(g), AIR_GRID_N - 1);
    const t = g - i0;
    const a = i0 * AIR_TAPS;
    const b = a + AIR_TAPS;
    for (let k = 0; k < AIR_TAPS; k++) this.taps[k] = table[a + k] + t * (table[b + k] - table[a + k]);
  }

  // The history is stored twice so the window is always contiguous.
  process(x: number): number {
    const K = AIR_TAPS;
    this.pos = this.pos === 0 ? K - 1 : this.pos - 1;
    this.hist[this.pos] = x;
    this.hist[this.pos + K] = x;
    let y = 0;
    for (let k = 0; k < K; k++) y += this.taps[k] * this.hist[this.pos + k];
    return y;
  }
}

// 4-tap Lagrange read of a ring at a fractional absolute sample index.
export function readLagrange(ring: SampleRing, pos: number): number {
  const k = Math.floor(pos);
  const f = pos - k;
  const cm1 = (-f * (f - 1) * (f - 2)) / 6;
  const c0 = ((f + 1) * (f - 1) * (f - 2)) / 2;
  const c1 = (-(f + 1) * f * (f - 2)) / 2;
  const c2 = ((f + 1) * f * (f - 1)) / 6;
  return cm1 * ring.get(k - 1) + c0 * ring.get(k) + c1 * ring.get(k + 1) + c2 * ring.get(k + 2);
}

const scratch: Vec3 = { x: 0, y: 0, z: 0 };

function pathDist(log: PoseLog, t: number, rx: Vec3, mirrorZ: number | null): number {
  log.at(t, scratch);
  const z = mirrorZ === null ? scratch.z : mirrorZ - scratch.z;
  return Math.hypot(scratch.x - rx.x, scratch.y - rx.y, z - rx.z);
}

// Retarded delay in seconds from the drone to a receiver at time t. mirrorZ, when given, mirrors the
// source in a ground plane at that height (the image path). Three fixed-point iterations.
export function solveDelay(log: PoseLog, t: number, rx: Vec3, mirrorZ: number | null): number {
  let tau = pathDist(log, t, rx, mirrorZ) / C;
  for (let i = 0; i < 3; i++) tau = pathDist(log, t - tau, rx, mirrorZ) / C;
  return Math.max(tau, 1 / C);
}

// Adds one block of one path. out holds BLOCK samples starting at sample index n0. The retarded delay is solved at
// the first and last sample of the block and interpolated linearly between them.
export function renderPath(
  out: Float64Array,
  n0: number,
  src: SampleRing,
  log: PoseLog,
  rx: Vec3,
  mirrorZ: number | null,
  gain: number,
  air: AirFilter,
): void {
  const last = out.length - 1;
  const tA = solveDelay(log, n0 / FS, rx, mirrorZ);
  const tB = solveDelay(log, (n0 + last) / FS, rx, mirrorZ);
  air.setDistance(tA * C);
  for (let i = 0; i <= last; i++) {
    const tau = tA + ((tB - tA) * i) / last;
    const v = (readLagrange(src, n0 + i - tau * FS) / (tau * C)) * gain;
    out[i] += air.process(v);
  }
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Maekawa barrier gain for a direct path. The highest ground point above the line of sight is the barrier
// top. Returns 1 when the path is clear. No ground wave or refraction.
export function barrierGain(terrain: { height(x: number, y: number): number }, s: Vec3, r: Vec3): number {
  let worst = 0;
  let top: Vec3 = { x: 0, y: 0, z: 0 };
  for (let j = 1; j <= BARRIER_STEPS; j++) {
    const u = j / (BARRIER_STEPS + 1);
    const x = s.x + (r.x - s.x) * u;
    const y = s.y + (r.y - s.y) * u;
    const zl = s.z + (r.z - s.z) * u;
    const g = terrain.height(x, y);
    if (g - zl > worst) {
      worst = g - zl;
      top = { x, y, z: g };
    }
  }
  if (worst <= 0) return 1;
  const delta = dist3(s, top) + dist3(top, r) - dist3(s, r);
  const nF = (2 * delta) / (C / MAEKAWA_HZ);
  const il = 10 * Math.log10(3 + 20 * nF);
  return 10 ** (-il / 20);
}
