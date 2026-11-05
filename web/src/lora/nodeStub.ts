// STUB node behaviour for M3. The detector core lands in M2; what it reports here is a clearly
// labelled stand-in. Framing, scheduling, collisions and reception are the real v0 design.
import { createRng, nextFloat, nextU32, type Rng } from '../sim/rng';
import type { DroneClass } from '../sim/scenario';
import { gauss } from '../acoustics/dsp';
import { HEALTH_FIELDS } from '../protocol/messages';

export const DETECTION_THRESHOLD_DB = 6;
export const DETECTION_HOLD_S = 0.5;
export const RANGE_SIGMA_M = 4;
export const NLOS_P = 0.25;
export const NLOS_MAX_M = 12;
export const RANGING_SPACING_M = 120;
export const RANGING_MAX_LINK_M = 2.2 * RANGING_SPACING_M;

export interface NodeObservation {
  bandDb: number;
  ambientDb: number;
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
  target: TruthTarget;
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
const CLASS_BPF: Record<DroneClass, number> = { fpv: 600, mini: 250, matrice: 100 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
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
  private aboveSince = -1;
  private latched = false;
  detecting = false;
  detections = 0;
  rejected = 0;
  retries = 0;
  queue = 0;
  neighboursHeard = 0;
  lastDetectionS = -1;
  lastBandDb = 0;
  minBandDb = 255;

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
    const trigger = obs.bandDb >= obs.ambientDb + DETECTION_THRESHOLD_DB;
    if (trigger) {
      if (this.aboveSince < 0) this.aboveSince = t;
      if (!this.latched && t - this.aboveSince >= DETECTION_HOLD_S) {
        this.latched = true;
        this.detecting = true;
        this.detections++;
        this.lastDetectionS = t;
      }
    } else {
      this.aboveSince = -1;
      this.latched = false;
      this.detecting = false;
    }
    return this.detecting && this.lastDetectionS === t ? null : null;
  }

  // Detection fields from truth with noise. Array nodes get a bearing; detector nodes report 0.
  detection(_t: number, target: TruthTarget, ownX: number, ownY: number, ownZ: number): Detection {
    const dx = target.x - ownX;
    const dy = target.y - ownY;
    const dz = target.alt - ownZ;
    const trueAz = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    const trueEl = (Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
    const az = this.kind === 'array' ? (trueAz + gauss(this.rng) * 5 + 360) % 360 : 0;
    const el = clamp(trueEl + (this.kind === 'array' ? gauss(this.rng) * 2 : 0), 0, 31);
    const snr = this.neighboursHeard >= 0 ? 12 : 0;
    const confidence = clamp(Math.round(4 + snr * 0.6), 0, 15);
    const level = clamp(Math.round(this.lastBandDb), 0, 63);
    const line = CLASS_BPF[target.class] + gauss(this.rng) * 4;
    return {
      confidence,
      levelDb: level,
      cls: CLASS_CODE[target.class],
      az: Math.round(az) & 511,
      el: Math.round(el) & 31,
      bearingSigma: this.kind === 'array' ? 5 : 15,
      lineHz: clamp(Math.round(line), 0, 2047),
      line2Delta: clamp(Math.round(Math.abs(gauss(this.rng)) * 8), 0, 63),
      target,
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
    return `${this.id}:${this.aboveSince}:${this.latched ? 1 : 0}:${this.detecting ? 1 : 0}:${this.detections}:${this.rejected}:${this.retries}:${this.queue}:${this.energy.batteryV.toFixed(6)}:${this.energy.clockOffsetUs.toFixed(6)}:${this.rng.state}`;
  }
}
