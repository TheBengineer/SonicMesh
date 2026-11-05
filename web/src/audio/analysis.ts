import { bandLevelDb, fft, hann } from '../acoustics/dsp';
import type { AudioRing } from '../acoustics/history';
import { FS, N_HARM, REF_PA } from '../acoustics/model';
import type { DetectSpan } from '../lora/types';
import { drawDetectionMarks } from '../ui/detectMarks';
import { BandTracer, MAX_TRACKS } from './bandTrace';

// Spectrogram and band-level history for one mic, read from the sim's audio rings. Costs the sim nothing.
export const WF_N = 1024;
export const WF_HOP = 512;
export const WF_BINS = WF_N / 2;
export const WF_COLS = 300;
// Size of a small strip tile in the all-nodes panel: the newest TILE_COLS columns, rows sampled from the bins.
export const TILE_COLS = 200;
export const TILE_ROWS = 96;
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

// Snippet clips are 1-bit at 4 kS/s, so they have no absolute level: dB is relative to the clip's strongest bin.
export const SNIP_FS = 4000;
const SNIP_N = 128;
const SNIP_HOP = 32;
const SNIP_DB_RANGE = 40;
const SNIP_SCALE_X = 16;
const SNIP_SCALE_Y = 4;

export interface SnippetSpectrogram {
  cols: number;
  bins: number;
  // Colour index 0 to 255, cols * bins, column by column.
  index: Uint8Array;
}

export function snippetSpectrogram(bits: ArrayLike<number>): SnippetSpectrogram {
  const bins = SNIP_N / 2;
  const cols = bits.length < SNIP_N ? 0 : Math.floor((bits.length - SNIP_N) / SNIP_HOP) + 1;
  const power = new Float64Array(cols * bins);
  const win = hann(SNIP_N);
  const re = new Float64Array(SNIP_N);
  const im = new Float64Array(SNIP_N);
  let max = 1e-30;
  for (let c = 0; c < cols; c++) {
    for (let i = 0; i < SNIP_N; i++) {
      re[i] = (bits[c * SNIP_HOP + i] ? 1 : -1) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      power[c * bins + k] = p;
      if (p > max) max = p;
    }
  }
  const index = new Uint8Array(cols * bins);
  for (let i = 0; i < index.length; i++) {
    const db = 10 * Math.log10(Math.max(power[i] / max, 1e-30));
    index[i] = Math.round(255 * Math.max(0, 1 + db / SNIP_DB_RANGE));
  }
  return { cols, bins, index };
}

// A snippet's clip with the band floor and the line the node reported. The Nyquist limit of 2 kHz is the top edge.
export function drawSnippet(canvas: HTMLCanvasElement, bits: ArrayLike<number>, lineHz: number | null): void {
  const spec = snippetSpectrogram(bits);
  if (spec.cols === 0) return;
  // The columns are few, so they are drawn as blocks on a larger canvas that keeps the debug lines sharp.
  canvas.width = spec.cols * SNIP_SCALE_X;
  canvas.height = spec.bins * SNIP_SCALE_Y;
  const ctx = canvas.getContext('2d');
  const small = document.createElement('canvas');
  small.width = spec.cols;
  small.height = spec.bins;
  const smallCtx = small.getContext('2d');
  if (!ctx || !smallCtx) return;
  const image = smallCtx.createImageData(spec.cols, spec.bins);
  for (let c = 0; c < spec.cols; c++) {
    for (let k = 0; k < spec.bins; k++) {
      const o = ((spec.bins - 1 - k) * spec.cols + c) * 4;
      const j = spec.index[c * spec.bins + k] * 3;
      image.data[o] = LUT[j];
      image.data[o + 1] = LUT[j + 1];
      image.data[o + 2] = LUT[j + 2];
      image.data[o + 3] = 255;
    }
  }
  smallCtx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  const spans: DetectSpan[] = lineHz === null ? [] : [{ startS: 0, endS: null, lineHz }];
  drawDetectionMarks(ctx, canvas.width, canvas.height, { maxHz: SNIP_FS / 2, lineWidth: 2, spans, tNewest: 0, secPerCol: 1, lineOnly: true });
}

export class MicAnalysis {
  // Colour index per bin, one column of WF_BINS per hop. Column slot = column number mod WF_COLS.
  private readonly cols = new Uint8Array(WF_COLS * WF_BINS);
  // Truth lines per column: for each drone, the received rotor frequencies.
  private readonly truth: (number[][] | null)[] = new Array<number[][] | null>(WF_COLS).fill(null);
  // The traced harmonics per column in Hz, MAX_TRACKS per column, 0 with no lock.
  private readonly trace = new Float32Array(WF_COLS * MAX_TRACKS);
  private tracer = new BandTracer(WF_BINS, FS / WF_N);
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
  private tileImage: ImageData | null = null;

  constructor(readonly key: string) {}

  // tracing says whether to follow the drone's band. The tracer is the costly part, and its line only shows during a
  // detection, so quiet nodes skip it.
  update(ring: AudioRing, truth: number[][] | null, tracing = false): void {
    if (ring !== this.ring) this.restart(ring);
    const end = ring.written;
    if (end - this.wfCursor > ring.capacity) this.wfCursor = end - WF_HOP * 4;
    if (end - this.levelCursor > ring.capacity) this.levelCursor = end - LEVEL_WIN * 4;
    for (let budget = 100; budget > 0 && this.wfCursor + WF_N <= end; budget--) {
      this.column(ring, truth, tracing);
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

  // Latest band level in dB, or null before the first 100 ms of audio.
  latestBandDb(): number | null {
    return this.levelCount === 0 ? null : this.bands[(this.levelCount - 1) % LEVEL_COLS];
  }

  // The same columns and colours as drawWaterfall, at tile size. Rows are sampled, so a tile is a small view of the
  // full spectrogram at a fraction of its cost.
  drawStrip(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = Math.min(canvas.width, WF_COLS);
    const h = canvas.height;
    if (!this.tileImage || this.tileImage.width !== w || this.tileImage.height !== h) {
      this.tileImage = ctx.createImageData(w, h);
    }
    const data = this.tileImage.data;
    for (let r = 0; r < h; r++) {
      // Row 0 is the top, so it shows the highest bin.
      const k = Math.min(WF_BINS - 1, Math.floor(((h - 1 - r + 0.5) * WF_BINS) / h));
      for (let c = 0; c < w; c++) {
        const seq = this.colCount - w + c;
        const o = (r * w + c) * 4;
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
    ctx.putImageData(this.tileImage, 0, 0);
  }

  // The detector's debug lines over the columns drawStrip or drawWaterfall just drew. nowS is the sim time of the
  // newest audio; the newest column is centred a little before it.
  drawMarks(canvas: HTMLCanvasElement, spans: DetectSpan[], nowS: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx || !this.ring || this.colCount === 0) return;
    const centre = this.wfCursor - WF_HOP + WF_N / 2;
    const w = Math.min(canvas.width, WF_COLS);
    const traces: number[][] = [];
    for (let i = 0; i < MAX_TRACKS; i++) {
      const trace = new Array<number>(w);
      for (let c = 0; c < w; c++) {
        const seq = this.colCount - w + c;
        trace[c] = seq < 0 ? 0 : this.trace[(seq % WF_COLS) * MAX_TRACKS + i];
      }
      traces.push(trace);
    }
    drawDetectionMarks(ctx, w, canvas.height, {
      maxHz: FS / 2,
      lineWidth: 2,
      spans,
      tNewest: nowS - (this.ring.written - centre) / FS,
      secPerCol: WF_HOP / FS,
      traces,
    });
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
    this.tracer = new BandTracer(WF_BINS, FS / WF_N);
    this.colCount = 0;
    this.levelCount = 0;
    const end = ring.written;
    this.wfCursor = Math.max(0, end - Math.min(ring.capacity, WF_HOP * WF_COLS + WF_N));
    this.levelCursor = Math.max(0, end - Math.min(ring.capacity, LEVEL_WIN * LEVEL_COLS));
  }

  private column(ring: AudioRing, truth: number[][] | null, tracing: boolean): void {
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
    if (tracing) {
      this.trace.set(this.tracer.push(this.cols.subarray(base, base + WF_BINS)), slot * MAX_TRACKS);
    } else {
      this.tracer.reset();
      this.trace.fill(0, slot * MAX_TRACKS, (slot + 1) * MAX_TRACKS);
    }
    this.colCount++;
  }

  private level(ring: AudioRing): void {
    if (!ring.read(this.levelCursor, this.win)) return;
    this.bands[this.levelCount % LEVEL_COLS] = bandLevelDb(this.win, 100, 4000);
    this.levelCount++;
  }
}
