// Node behaviour for M3. Detection is the comb detector ported from sim/detector and bearings come from the array's own
// mics; class and confidence are still a clearly labelled stand-in. Framing, scheduling, collisions and reception are the real v0 design.
import { createRng, nextFloat, nextU32, type Rng } from '../sim/rng';
import type { DroneClass } from '../sim/scenario';
import { gauss } from '../acoustics/dsp';
import { FS } from '../acoustics/model';
import { BEARING_SAMPLES, BearingTrack, estimateBearing } from '../detector/bearing';
import { CombDetector, NODE_COMB_PARAMS } from '../detector/comb';
import { ImpulseDetector } from '../detector/impulse';
import { HEALTH_FIELDS } from '../protocol/messages';
import type { DetectSpan, DetectState } from './types';

// A detection keeps naming its drone this long after the pitch last matched it. The pitch drops out while the detector
// holds on, and wanders onto noise for single frames.
export const TARGET_HOLD_S = 1;
// How often an array node takes a new bearing.
export const BEARING_PERIOD_S = 0.5;
// Readings behind a node's steady pitch, one per tick: about 3 s, so the detector's jumps to a sub-harmonic or a harmonic
// do not move it.
const PITCH_WINDOW = 300;
// How far a reading can sit from the steady pitch and still show on the waterfall, with room for Doppler.
const LINE_TOL = 0.13;
// Spans kept for the debug lines; the waterfalls show well under a minute.
export const MAX_DETECT_SPANS = 8;
const MAX_SHOT_TIMES = 8;
// The harmonic detector skips any frame that overlaps a shot and this long after it, so a shot cannot break or start a
// drone track. A drone's track holds for about a second, so a quarter-second gap leaves it intact.
const SHOT_MASK_S = 0.25;
export const RANGE_SIGMA_M = 4;
export const NLOS_P = 0.25;
export const NLOS_MAX_M = 12;
export const RANGING_SPACING_M = 120;
export const RANGING_MAX_LINK_M = 2.2 * RANGING_SPACING_M;

export interface RingView {
  written: number;
  capacity: number;
  read(start: number, out: Float32Array): boolean;
}

// What the comb detector says at the latest frame.
export interface CombReading {
  on: boolean;
  tracking: boolean;
  f0Hz: number;
  peak: number;
}

export interface NodeObservation {
  bandDb: number;
  ambientDb: number;
  comb?: CombReading;
  // The drone whose true rotor pitch matches the detector's, if any.
  heardId?: number | null;
  beaconRssi?: number;
  beaconSnr?: number;
  neighboursHeard?: number;
  audio?: Float32Array;
}

export interface TruthTarget {
  id: number;
  class: DroneClass;
  x: number;
  y: number;
  alt: number;
}

export interface Detection {
  confidence: number;
  levelDb: number;
  cls: number;
  az: number;
  el: number;
  bearingSigma: number;
  lineHz: number;
  line2Delta: number;
}

export interface HealthValue {
  key: string;
  name: string;
  bits: number;
  raw: number;
  value: number;
  unit: string;
  provenance: string;
}

const CLASS_CODE: Record<DroneClass, number> = { fpv: 1, mini: 2, matrice: 3 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Whether a detector pitch fits a drone's true blade-pass frequency: the fundamental, a sub-harmonic the detector's
// octave rule took, or a harmonic of it. The Doppler shift is already in bpfHz.
export function pitchFits(f0Hz: number, bpfHz: number): boolean {
  const r = f0Hz / bpfHz;
  if (Math.abs(r - 1) < 0.06) return true;
  return [1 / 2, 1 / 3, 1 / 4, 2, 3, 4, 5, 6].some((m) => Math.abs(r / m - 1) < 0.04);
}

function hash(seed: number, a: number, b: number, sweep: number): number {
  let h = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b) ^ Math.imul(sweep + 1, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Static link bias: 25 % of links are partly blocked and read 0 to 12 m long.
export function nlosBias(seed: number, a: number, b: number): number {
  const h = hash(seed, Math.min(a, b), Math.max(a, b), 0);
  if ((h & 0xffff) / 65536 >= NLOS_P) return 0;
  return ((h >>> 16) / 65536) * NLOS_MAX_M;
}

// Deterministic per-sweep Gaussian, so moving a node only changes the true distance.
export function rangingNoise(seed: number, a: number, b: number, sweep: number): number {
  const h = hash(seed, Math.min(a, b), Math.max(a, b), sweep + 1);
  const u1 = Math.max((h & 0xffffff) / 0x1000000, 1e-9);
  const u2 = ((h >>> 8) & 0xffff) / 65536;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * RANGE_SIGMA_M;
}

export function measureRange(seed: number, a: number, b: number, distanceM: number, sweep: number): number {
  const r = distanceM + nlosBias(seed, a, b) + rangingNoise(seed, a, b, sweep);
  return Math.max(0.5, r);
}

export interface HealthContext {
  bandFloorDb: number;
  beaconRssi: number;
  beaconSnr: number;
  neighboursHeard: number;
  detections: number;
  rejected: number;
  retries: number;
  queue: number;
  arrayNode: boolean;
}

// Simple battery/solar/clock assumptions. The UI marks these ASSUMED; the measured fields stay
// MODELLED. Fields are packed in HEALTH_FIELDS order.
export class EnergyModel {
  batteryV = 4.05;
  solarWh = 4.2;
  temperatureC = 18;
  uptimeH = 0;
  driftPpm = 2.5;
  clockOffsetUs = 0;

  step(dtS: number): void {
    // ASSUMED: 2 mA average, 1 W panel with a 0.35 duty of useful sun.
    const usedWh = 0.002 * 3.7 * (dtS / 3600);
    const harvested = 1.0 * (dtS / 3600) * 0.35;
    this.solarWh = Math.min(20, this.solarWh + harvested);
    this.batteryV = clamp(this.batteryV + (harvested - usedWh) * 0.3, 3.0, 4.2);
    this.temperatureC += (18 + 4 * Math.sin(this.uptimeH / 6) - this.temperatureC) * Math.min(1, dtS / 600);
    this.uptimeH = (this.uptimeH + dtS / 3600) % 4096;
    this.clockOffsetUs += this.driftPpm * dtS;
  }
}

export class NodeStub {
  readonly energy = new EnergyModel();
  private readonly rng: Rng;
  private readonly comb = new CombDetector(NODE_COMB_PARAMS);
  private readonly frame = new Float32Array(this.comb.nFft);
  private cursor = 0;
  private targetAt = -1;
  private bearingAt = -Infinity;
  private readonly bearings = new BearingTrack();
  private bearingFrames: Float32Array[] | null = null;
  private elDeg = 0;
  private tracking = false;
  private lastF0 = 0;
  private readonly pitches: number[] = [];
  detecting = false;
  detections = 0;
  rejected = 0;
  retries = 0;
  queue = 0;
  neighboursHeard = 0;
  lastDetectionS = -1;
  readonly spans: DetectSpan[] = [];
  // Recent shot onsets at this node, in sim seconds. Only the newest few are kept.
  readonly shotTimesS: number[] = [];
  private readonly impulse = new ImpulseDetector();
  // Sample indices of recent shot onsets, for masking the harmonic detector.
  private readonly shotSamples: number[] = [];
  lastBandDb = 0;
  // The best comb score this frame, which the detector compares with its threshold.
  peak = 0;
  minBandDb = 255;
  // The drone this detection's pitch fits, from truth. Only class and the Truth view use it.
  targetId: number | null = null;

  constructor(
    readonly id: number,
    readonly kind: 'detector' | 'array',
    seed: number,
  ) {
    this.rng = createRng((seed ^ Math.imul(id + 1, 0x9e3779b1)) >>> 0);
  }

  update(t: number, obs: NodeObservation): Detection | null {
    this.energy.step(0.01);
    this.lastBandDb = obs.bandDb;
    this.minBandDb = Math.min(this.minBandDb, obs.bandDb);
    const comb = obs.comb;
    const on = comb?.on ?? false;
    this.peak = comb?.peak ?? 0;
    this.tracking = comb?.tracking ?? false;
    if (on && !this.detecting) {
      this.detecting = true;
      this.detections++;
      this.lastDetectionS = t;
      this.spans.push({ startS: t, endS: null, lineHz: null });
      if (this.spans.length > MAX_DETECT_SPANS) this.spans.shift();
    } else if (!on && this.detecting) {
      this.detecting = false;
      this.lastF0 = 0;
      this.pitches.length = 0;
      this.bearings.reset();
      this.bearingAt = -Infinity;
      const span = this.spans.at(-1);
      if (span) span.endS = t;
    }
    if (this.detecting && comb && comb.f0Hz > 0) {
      this.lastF0 = comb.f0Hz;
      this.pitches.push(comb.f0Hz);
      if (this.pitches.length > PITCH_WINDOW) this.pitches.shift();
      const span = this.spans.at(-1);
      if (span) span.lineHz = clamp(Math.round(comb.f0Hz), 0, 2047);
    }
    if (this.detecting && obs.heardId !== undefined && obs.heardId !== null) {
      this.targetId = obs.heardId;
      this.targetAt = t;
    } else if (!this.detecting || t - this.targetAt > TARGET_HOLD_S) {
      this.targetId = null;
    }
    return null;
  }

  // Runs the impulse detector over any new audio and keeps the times of the shots it finds.
  hearShots(ring: RingView): void {
    for (const i of this.impulse.step(ring)) {
      this.shotTimesS.push(i / FS);
      if (this.shotTimesS.length > MAX_SHOT_TIMES) this.shotTimesS.shift();
      this.shotSamples.push(i);
    }
  }

  // Whether a frame starting at start and nFft long overlaps a shot or the time just after it.
  private inShot(start: number, nFft: number): boolean {
    const mask = Math.round(SHOT_MASK_S * FS);
    return this.shotSamples.some((s) => start < s + mask && start + nFft > s);
  }

  private forgetShots(nFft: number): void {
    const keep = this.cursor - nFft - Math.round(SHOT_MASK_S * FS);
    while (this.shotSamples.length > 0 && this.shotSamples[0] < keep) this.shotSamples.shift();
  }

  // Runs the detector over any new audio, one frame per hop from the start of the mic's ring. Call hearShots first, so
  // the frames that overlap a shot can be skipped.
  hear(ring: RingView): CombReading {
    const { comb, frame } = this;
    if (ring.written - this.cursor > ring.capacity) this.cursor = ring.written - comb.nFft;
    while (this.cursor + comb.nFft <= ring.written && ring.read(this.cursor, frame)) {
      if (!this.inShot(this.cursor, comb.nFft)) comb.step(frame);
      this.cursor += comb.hop;
    }
    this.forgetShots(comb.nFft);
    return { on: comb.on, tracking: comb.q > 0, f0Hz: comb.f0Hz, peak: comb.peak };
  }

  get state(): DetectState {
    if (this.detecting) return 'detecting';
    return this.tracking ? 'arming' : 'quiet';
  }

  // The pitch on the waterfall: the detector's own while it detects, and 0 for a gap while it has jumped away from its
  // steady pitch.
  get trackHz(): number {
    const steady = this.pitchHz;
    return steady > 0 && Math.abs(this.lastF0 / steady - 1) <= LINE_TOL ? this.lastF0 : 0;
  }

  // The median pitch over the last 3 s of a detection, which the map labels and bogies use. 0 before the first.
  get pitchHz(): number {
    if (!this.detecting || this.pitches.length === 0) return 0;
    const sorted = [...this.pitches].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  // An array node's bearing: taken from its own mics while it detects, at the detector's pitch.
  listenForBearing(t: number, rings: RingView[], offsets: readonly (readonly [number, number])[]): void {
    if (this.kind !== 'array' || !this.detecting || t - this.bearingAt < BEARING_PERIOD_S) return;
    const f0 = this.pitchHz;
    if (f0 <= 0 || rings.length !== offsets.length) return;
    this.bearingFrames ??= offsets.map(() => new Float32Array(BEARING_SAMPLES));
    const frames = this.bearingFrames;
    if (!rings.every((r, j) => r.written >= BEARING_SAMPLES && r.read(r.written - BEARING_SAMPLES, frames[j]))) return;
    this.bearingAt = t;
    const found = estimateBearing(frames, offsets, f0);
    if (!found) return;
    this.bearings.push(found.azDeg);
    this.elDeg = found.elDeg;
  }

  // What the array will claim, null when it has no bearing or its estimates disagree.
  get bearingDeg(): number | null {
    return this.detecting ? this.bearings.bearingDeg : null;
  }

  get bearingSigmaDeg(): number | null {
    return this.bearingDeg === null ? null : this.bearings.spreadDeg;
  }

  // Detection fields. Pitch and bearing are measured. Confidence and the second line are still stand-ins, and class comes
  // from the drone the pitch fits, so it is 0 when none does.
  detection(target: TruthTarget | null): Detection {
    const snr = this.neighboursHeard >= 0 ? 12 : 0;
    const confidence = clamp(Math.round(4 + snr * 0.6), 0, 15);
    const level = clamp(Math.round(this.lastBandDb), 0, 63);
    const az = this.bearingDeg;
    const sigma = this.bearingSigmaDeg;
    return {
      confidence,
      levelDb: level,
      cls: target ? CLASS_CODE[target.class] : 0,
      az: az === null ? 0 : Math.round(az) & 511,
      el: az === null ? 0 : clamp(this.elDeg, 0, 31),
      bearingSigma: sigma === null ? 15 : clamp(Math.round(sigma), 1, 15),
      lineHz: clamp(Math.round(this.lastF0), 0, 2047),
      line2Delta: clamp(Math.round(Math.abs(gauss(this.rng)) * 8), 0, 63),
    };
  }

  healthFields(ctx: HealthContext): { fields: number[]; values: HealthValue[] } {
    const e = this.energy;
    const battery = clamp(Math.round((e.batteryV - 3.0) / 0.01), 0, 255);
    const solar = clamp(Math.round(e.solarWh / 0.05), 0, 255);
    const temp = clamp(Math.round((e.temperatureC + 20) / 0.5), 0, 255);
    const uptime = (Math.floor(e.uptimeH) & 0xfff) | (1 << 12);
    const micFloor = clamp(Math.round(ctx.bandFloorDb), 0, 255);
    const micFlags = 0;
    const wind = clamp(Math.round(ctx.bandFloorDb - 3), 0, 255);
    const detections = (clamp(ctx.detections, 0, 255) & 0xff) | (clamp(ctx.rejected, 0, 15) << 8);
    const tilt = 0;
    const tamper = 0;
    const rssi = clamp(Math.round(ctx.beaconRssi + 160), 0, 255);
    const snr = clamp(Math.round(ctx.beaconSnr + 20), 0, 255);
    const beaconLink = rssi | (snr << 8);
    const offset = (Math.round(e.clockOffsetUs) & 0xfff) | ((Math.round(e.driftPpm) & 0xf) << 12);
    const mesh = (clamp(ctx.neighboursHeard, 0, 15) & 0xf) | ((clamp(ctx.retries, 0, 15) & 0xf) << 4) | ((clamp(ctx.queue, 0, 15) & 0xf) << 8);
    const gnss = this.kind === 'array' ? (10 & 0xf) | 0x10 : 0;
    const build = 0x1a2b;
    const fields = [battery, solar, temp, uptime, micFloor, micFlags, wind, detections, tilt, tamper, beaconLink, offset, mesh, gnss, build];
    const decoded = [
      e.batteryV,
      e.solarWh,
      e.temperatureC,
      e.uptimeH,
      ctx.bandFloorDb,
      micFlags,
      ctx.bandFloorDb - 3,
      ctx.detections,
      0,
      0,
      ctx.beaconRssi,
      e.clockOffsetUs,
      ctx.neighboursHeard,
      this.kind === 'array' ? 10 : 0,
      build,
    ];
    const units = ['V', 'Wh', 'C', 'h', 'dB', 'flags', 'dB', 'count', 'deg', 'flags', 'dBm', 'us', 'count', 'sats', 'hash'];
    const values = HEALTH_FIELDS.map((f, i) => ({
      key: f.key,
      name: f.name,
      bits: f.bits,
      raw: fields[i],
      value: decoded[i],
      unit: units[i],
      provenance: f.provenance,
    }));
    return { fields, values };
  }

  // 1-bit 4 kS/s clip: decimate 16 kS/s by 4 and keep the sign. MODELLED.
  snippet(samples: Float32Array | null, t: number, maxBits = 1920): number[] {
    const bits: number[] = [];
    if (samples && samples.length >= 4) {
      for (let i = 0; i < samples.length && bits.length < maxBits; i += 4) bits.push(samples[i] >= 0 ? 1 : 0);
    }
    let k = bits.length;
    while (bits.length < maxBits) {
      const phase = Math.sin(2 * Math.PI * 600 * t + k * 0.31);
      bits.push(phase >= 0 ? 1 : 0);
      k++;
    }
    while (bits.length % 8 !== 0) bits.pop();
    return bits;
  }

  // Stub-only helper: reception quality used to size retry and confidence.
  observeLink(_rssi: number, snr: number): void {
    if (snr < -7.5) this.retries++;
  }

  nextU32(): number {
    return nextU32(this.rng);
  }

  nextFloat(): number {
    return nextFloat(this.rng);
  }

  stateHash(): string {
    return `${this.id}:${this.comb.stateHash()}:${this.targetId}:${this.bearingDeg?.toFixed(3)}:${this.detecting ? 1 : 0}:${this.detections}:${this.rejected}:${this.retries}:${this.queue}:${this.energy.batteryV.toFixed(6)}:${this.energy.clockOffsetUs.toFixed(6)}:${this.rng.state}`;
  }
}
