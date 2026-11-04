import { bandLevelDb, fft, hann } from '../acoustics/dsp';
import type { AudioRing } from '../acoustics/history';
import { FS, N_HARM, REF_PA } from '../acoustics/model';

// Spectrogram and band-level history for one mic, read from the sim's audio rings. Costs the sim nothing.
export const WF_N = 1024;
export const WF_HOP = 512;
export const WF_BINS = WF_N / 2;
export const WF_COLS = 300;
const LEVEL_WIN = 1600;
const LEVEL_COLS = 300;
const DB_LO = 10;
const DB_HI = 90;
const WIN = hann(WF_N);
const WIN_SUM = WIN.reduce((s, v) => s + v, 0);

// Colour ramp from dark to bright, 256 entries of RGB.
const STOPS: [number, number, number, number][] = [
  [0, 8, 10, 24],
  [0.35, 60, 20, 120],
  [0.6, 200, 60, 70],
  [0.8, 250, 170, 50],
  [1, 255, 255, 225],
];
const LUT = new Uint8ClampedArray(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  let j = 1;
  while (j < STOPS.length - 1 && t > STOPS[j][0]) j++;
  const [t0, r0, g0, b0] = STOPS[j - 1];
  const [t1, r1, g1, b1] = STOPS[j];
  const u = (t - t0) / (t1 - t0);
  LUT[i * 3] = r0 + u * (r1 - r0);
  LUT[i * 3 + 1] = g0 + u * (g1 - g0);
  LUT[i * 3 + 2] = b0 + u * (b1 - b0);
}

export class MicAnalysis {
  // Colour index per bin, one column of WF_BINS per hop. Column slot = column number mod WF_COLS.
  private readonly cols = new Uint8Array(WF_COLS * WF_BINS);
  // Truth lines per column: for each drone, the received rotor frequencies.
  private readonly truth: (number[][] | null)[] = new Array<number[][] | null>(WF_COLS).fill(null);
  private readonly bands = new Float64Array(LEVEL_COLS);
  private readonly frame = new Float32Array(WF_N);
  private readonly win = new Float32Array(LEVEL_WIN);
  private readonly re = new Float64Array(WF_N);
  private readonly im = new Float64Array(WF_N);
  private ring: AudioRing | null = null;
  private colCount = 0;
  private wfCursor = 0;
  private levelCount = 0;
  private levelCursor = 0;
  private image: ImageData | null = null;

  constructor(readonly key: string) {}

  update(ring: AudioRing, truth: number[][] | null): void {
    if (ring !== this.ring) this.restart(ring);
    const end = ring.written;
    if (end - this.wfCursor > ring.capacity) this.wfCursor = end - WF_HOP * 4;
    if (end - this.levelCursor > ring.capacity) this.levelCursor = end - LEVEL_WIN * 4;
    for (let budget = 100; budget > 0 && this.wfCursor + WF_N <= end; budget--) {
      this.column(ring, truth);
      this.wfCursor += WF_HOP;
    }
    for (let budget = 40; budget > 0 && this.levelCursor + LEVEL_WIN <= end; budget--) {
      this.level(ring);
      this.levelCursor += LEVEL_WIN;
    }
  }

  // Band levels (100 to 4000 Hz) per 100 ms, oldest first.
  bandDb(): number[] {
    const n = Math.min(this.levelCount, LEVEL_COLS);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.bands[(this.levelCount - n + i) % LEVEL_COLS];
    return out;
  }

  drawWaterfall(canvas: HTMLCanvasElement, overlay: boolean): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (canvas.width !== WF_COLS || canvas.height !== WF_BINS) {
      canvas.width = WF_COLS;
      canvas.height = WF_BINS;
      this.image = null;
    }
    if (!this.image) this.image = ctx.createImageData(WF_COLS, WF_BINS);
    const data = this.image.data;
    for (let c = 0; c < WF_COLS; c++) {
      const seq = this.colCount - WF_COLS + c;
      for (let k = 0; k < WF_BINS; k++) {
        const o = ((WF_BINS - 1 - k) * WF_COLS + c) * 4;
        if (seq < 0) {
          data[o] = 0;
          data[o + 1] = 0;
          data[o + 2] = 0;
        } else {
          const j = this.cols[(seq % WF_COLS) * WF_BINS + k] * 3;
          data[o] = LUT[j];
          data[o + 1] = LUT[j + 1];
          data[o + 2] = LUT[j + 2];
        }
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(this.image, 0, 0);
    if (!overlay) return;
    ctx.fillStyle = '#ffffff';
    const binHz = FS / WF_N;
    for (let c = 0; c < WF_COLS; c++) {
      const seq = this.colCount - WF_COLS + c;
      if (seq < 0) continue;
      const lines = this.truth[seq % WF_COLS];
      if (!lines) continue;
      for (const rotors of lines) {
        for (const f of rotors) {
          for (let h = 1; h <= N_HARM; h++) {
            const bin = Math.round((h * f) / binHz);
            if (bin < 1 || bin >= WF_BINS) continue;
            ctx.fillRect(c, WF_BINS - 1 - bin, 1, 1);
          }
        }
      }
    }
  }

  private restart(ring: AudioRing): void {
    this.ring = ring;
    this.colCount = 0;
    this.levelCount = 0;
    const end = ring.written;
    this.wfCursor = Math.max(0, end - Math.min(ring.capacity, WF_HOP * WF_COLS + WF_N));
    this.levelCursor = Math.max(0, end - Math.min(ring.capacity, LEVEL_WIN * LEVEL_COLS));
  }

  private column(ring: AudioRing, truth: number[][] | null): void {
    if (!ring.read(this.wfCursor, this.frame)) return;
    for (let i = 0; i < WF_N; i++) {
      this.re[i] = this.frame[i] * WIN[i];
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    const slot = this.colCount % WF_COLS;
    const base = slot * WF_BINS;
    for (let k = 0; k < WF_BINS; k++) {
      const p = this.re[k] * this.re[k] + this.im[k] * this.im[k];
      // Line level of a sine in the bin: 2|X|^2 / (sum w)^2 is the mean square of the sine.
      const db = 10 * Math.log10(Math.max((2 * p) / (WIN_SUM * WIN_SUM), 1e-30) / (REF_PA * REF_PA));
      this.cols[base + k] = Math.round(255 * Math.min(1, Math.max(0, (db - DB_LO) / (DB_HI - DB_LO))));
    }
    this.truth[slot] = truth;
    this.colCount++;
  }

  private level(ring: AudioRing): void {
    if (!ring.read(this.levelCursor, this.win)) return;
    this.bands[this.levelCount % LEVEL_COLS] = bandLevelDb(this.win, 100, 4000);
    this.levelCount++;
  }
}
