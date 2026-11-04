import { TICK_S } from '../sim/clock';
import { clamp } from '../sim/math';
import { BLOCK, FS, GRAVITY } from './model';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Absolute sample index to value. Indices never written read as silence.
export class SampleRing {
  readonly buf: Float64Array;
  private readonly mask: number;

  constructor(size: number) {
    this.buf = new Float64Array(size);
    this.mask = size - 1;
  }

  put(n: number, v: number): void {
    this.buf[n & this.mask] = v;
  }

  get(n: number): number {
    return this.buf[n & this.mask];
  }
}

export const POSE_TICKS = 4096;
const MASK = POSE_TICKS - 1;

// Drone pose per tick, kept for the last ~40 s. Positions between ticks are linear, which is exact for
// straight paths. Rotor speed follows thrust: omega is proportional to sqrt(g + a_z) / sqrt(g).
export class PoseLog {
  private readonly x = new Float64Array(POSE_TICKS);
  private readonly y = new Float64Array(POSE_TICKS);
  private readonly z = new Float64Array(POSE_TICKS);
  private readonly vz = new Float64Array(POSE_TICKS);
  private readonly rotor = new Float64Array(POSE_TICKS);
  private first = -1;
  private last = -1;
  private k0 = 0;
  private kf = 0;

  push(tick: number, p: { x: number; y: number; alt: number; vz: number }): void {
    if (this.first < 0) this.first = tick;
    else if (tick !== this.last + 1) throw new Error(`pose log: tick ${tick} does not follow ${this.last}`);
    const i = tick & MASK;
    const az = this.last < 0 ? 0 : clamp((p.vz - this.vz[this.last & MASK]) / TICK_S, -GRAVITY, GRAVITY);
    this.x[i] = p.x;
    this.y[i] = p.y;
    this.z[i] = p.alt;
    this.vz[i] = p.vz;
    this.rotor[i] = Math.sqrt(Math.max(0.05, 1 + az / GRAVITY));
    this.last = tick;
  }

  at(t: number, out: Vec3): void {
    this.locate(t);
    const a = this.k0 & MASK;
    const b = (this.k0 + 1) & MASK;
    const f = this.kf;
    out.x = this.x[a] + f * (this.x[b] - this.x[a]);
    out.y = this.y[a] + f * (this.y[b] - this.y[a]);
    out.z = this.z[a] + f * (this.z[b] - this.z[a]);
  }

  rotorAt(t: number): number {
    this.locate(t);
    const a = this.k0 & MASK;
    const b = (this.k0 + 1) & MASK;
    return this.rotor[a] + this.kf * (this.rotor[b] - this.rotor[a]);
  }

  private locate(t: number): void {
    const lo = Math.max(this.first, this.last - MASK + 1);
    const k = clamp(t / TICK_S, lo, this.last);
    const i0 = Math.floor(k);
    if (i0 >= this.last) {
      this.k0 = this.last;
      this.kf = 0;
    } else {
      this.k0 = i0;
      this.kf = k - i0;
    }
  }
}

// Emitted blade-pass frequency of each rotor (Hz) at the source, per tick, for the last ~40 s.
export class RotorLog {
  private readonly hz = new Float64Array(POSE_TICKS * 4);
  private first = -1;
  private last = -1;

  push(tick: number, hz: ArrayLike<number>): void {
    if (this.first < 0) this.first = tick;
    const i = (tick & MASK) * 4;
    for (let k = 0; k < 4; k++) this.hz[i + k] = hz[k];
    this.last = tick;
  }

  // Linear in time between ticks, clamped to the logged range.
  at(rotor: number, t: number): number {
    if (this.last < 0) return 0;
    const lo = Math.max(this.first, this.last - MASK + 1);
    const k = clamp(t / TICK_S, lo, this.last);
    const i0 = Math.floor(k);
    const f = k - i0;
    const a = (i0 & MASK) * 4 + rotor;
    const b = (Math.min(i0 + 1, this.last) & MASK) * 4 + rotor;
    return this.hz[a] + f * (this.hz[b] - this.hz[a]);
  }
}

// Mic output in blocks of BLOCK samples. The data and the block counter can sit in SharedArrayBuffers, so the page
// reads what the sim worker wrote. Only the newest `capacity` samples are kept.
export class AudioRing {
  private readonly blocks: number;
  readonly capacity: number;

  constructor(
    readonly data: Float32Array,
    readonly ctr: Int32Array,
  ) {
    this.blocks = data.length / BLOCK;
    this.capacity = data.length;
  }

  static create(seconds: number, shared: boolean): AudioRing {
    const blocks = Math.ceil((seconds * FS) / BLOCK);
    const n = blocks * BLOCK;
    const data = shared ? new Float32Array(new SharedArrayBuffer(4 * n)) : new Float32Array(n);
    const ctr = shared ? new Int32Array(new SharedArrayBuffer(4)) : new Int32Array(1);
    return new AudioRing(data, ctr);
  }

  // Samples written so far, which is also the index of the next sample.
  get written(): number {
    return Atomics.load(this.ctr, 0) * BLOCK;
  }

  write(block: ArrayLike<number>): void {
    const b = Atomics.load(this.ctr, 0);
    this.data.set(block, (b % this.blocks) * BLOCK);
    Atomics.store(this.ctr, 0, b + 1);
  }

  // Copies out.length samples from absolute sample index `from`. False if any of them are gone or not written yet.
  read(from: number, out: Float32Array | Float64Array): boolean {
    const end = this.written;
    if (from < Math.max(0, end - this.capacity) || from + out.length > end) return false;
    for (let i = 0; i < out.length; i++) out[i] = this.data[(from + i) % this.capacity];
    return true;
  }

  // The newest block, copied.
  lastBlock(): Float32Array {
    const b = Atomics.load(this.ctr, 0);
    const i = ((((b - 1) % this.blocks) + this.blocks) % this.blocks) * BLOCK;
    return this.data.slice(i, i + BLOCK);
  }

  // Oldest first, up to the capacity.
  snapshot(): Float32Array {
    const n = Math.min(this.written, this.capacity);
    const out = new Float32Array(n);
    this.read(this.written - n, out);
    return out;
  }
}
