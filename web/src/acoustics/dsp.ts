import { nextFloat, type Rng } from '../sim/rng';
import { FS, REF_PA } from './model';

export const BAND_NFFT = 2048;

// Box-Muller. Always two uniforms per call, so the draw count does not depend on earlier values.
export function gauss(rng: Rng): number {
  const u1 = Math.max(nextFloat(rng), 1e-12);
  const u2 = nextFloat(rng);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// RBJ cookbook second-order section, Direct Form I.
export class Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(type: 'hp' | 'lp', f0: number, q: number, fs: number) {
    const w = (2 * Math.PI * f0) / fs;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = (type === 'lp' ? (1 - cw) / 2 : (1 + cw) / 2) / a0;
    this.b0 = b0;
    this.b1 = (type === 'lp' ? 1 - cw : -(1 + cw)) / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b0 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// In-place radix-2 FFT of length n, a power of two. The inverse scales by 1/n.
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos((2 * Math.PI * k) / len);
      const wi = sign * Math.sin((2 * Math.PI * k) / len);
      for (let i = 0; i < n; i += len) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// Periodic Hann window.
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// One-sided power spectrum of x, zero-padded to n (a power of two). Returns bins 0..n/2.
export function powerSpectrum(x: ArrayLike<number>, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < x.length && i < n; i++) re[i] = x[i];
  fft(re, im);
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k < out.length; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

// Power-weighted mean frequency in [lo, hi] Hz of x, Hann-windowed and zero-padded to n. Four rotors of one drone
// make four close lines in the blade-pass band, so a single peak is ambiguous; their centroid is their mean.
export function centroidHz(x: ArrayLike<number>, lo: number, hi: number, n = 16384): number {
  const w = hann(x.length);
  const seg = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) seg[i] = x[i] * w[i];
  const ps = powerSpectrum(seg, n);
  let sum = 0;
  let pow = 0;
  for (let k = 1; k < ps.length; k++) {
    const f = (k * FS) / n;
    if (f >= lo && f <= hi) {
      sum += f * ps[k];
      pow += ps[k];
    }
  }
  return sum / pow;
}

// Band level in dB SPL over [lo, hi] Hz, from the mean square of the window (zero-padded to BAND_NFFT).
export function bandLevelDb(x: ArrayLike<number>, lo: number, hi: number): number {
  const ps = powerSpectrum(x, BAND_NFFT);
  let sum = 0;
  for (let k = 1; k < BAND_NFFT / 2; k++) {
    const f = (k * FS) / BAND_NFFT;
    if (f >= lo && f <= hi) sum += ps[k];
  }
  const p = (2 * sum) / (BAND_NFFT * x.length);
  return 10 * Math.log10(Math.max(p, 1e-30) / (REF_PA * REF_PA));
}
