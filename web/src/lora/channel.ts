// LoRa radio model: airtime, sensitivity, path loss, shadowing, terrain diffraction, capture and
// half-duplex. Constants come from sim/experiments/lora_budget.py.

export const PAYLOAD = 255;
export const PREAMBLE = 8;
export const CR = 1;
export const GUARD_S = 0.004;
export const NF_DB = 6;
export const SNR_REQ: Record<number, number> = { 5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

export const TX_DBM = 20;
export const ANT_DBI = 2;
export const PL_1M_DB = 31.7;
export const PL_EXP = 3.0;
export const SPACING_M = 400;

// ASSUMED: log-normal shadowing and per-packet fading are not measured.
export const SHADOW_SIGMA_DB = 6;
export const FADE_SIGMA_DB = 2;
export const CAPTURE_DB = 6;
export const FREQ_HZ = 915e6;
export const LIGHT_SPEED = 299_792_458;
export const NODE_ANT_M = 4;
export const GATEWAY_ANT_M = 8;

export type Fate = 'decoded' | 'range' | 'collision' | 'half-duplex';
export type ChannelKind = 'idle' | 'event' | 'ranging';

export interface ChannelSpec {
  kind: ChannelKind;
  index: number;
  bw: number;
}

export const IDLE_CHANNEL: ChannelSpec = { kind: 'idle', index: 0, bw: 125_000 };
export const EVENT_CHANNEL: ChannelSpec = { kind: 'event', index: 0, bw: 500_000 };
export function rangingChannel(index: number): ChannelSpec {
  return { kind: 'ranging', index: ((index % 8) + 8) % 8, bw: 500_000 };
}

export function channelName(c: ChannelSpec): string {
  if (c.kind === 'idle') return 'idle SF9/125k';
  if (c.kind === 'event') return 'event SF7/500k';
  return `ranging ${c.index}/8, 500k`;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TerrainLike {
  height(x: number, y: number): number;
  size?: readonly [number, number];
}

export function airtime(sf: number, bw: number, nBytes: number): number {
  const tSym = 2 ** sf / bw;
  const de = tSym > 0.016 ? 1 : 0;
  const pre = PREAMBLE + (sf <= 6 ? 6.25 : 4.25);
  const num = 8 * nBytes - 4 * sf + 16 + (sf > 6 ? 28 : 20);
  const nPayload = 8 + Math.max(Math.ceil(num / (4 * (sf - 2 * de))) * (CR + 4), 0);
  return (pre + nPayload) * tSym;
}

export function sensitivity(sf: number, bw: number): number {
  return -174 + 10 * Math.log10(bw) + NF_DB + SNR_REQ[sf];
}

export function noiseFloor(bw: number): number {
  return -174 + 10 * Math.log10(bw) + NF_DB;
}

export function pathLoss(distanceM: number): number {
  return PL_1M_DB + 10 * PL_EXP * Math.log10(Math.max(distanceM, 1));
}

export function dbl(x: number): number {
  return x;
}

// Deterministic standard normal for a link, fixed by the seed and the pair of ids.
export function linkShadowDb(seed: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let h = (seed ^ Math.imul(lo + 1, 0x9e3779b1) ^ Math.imul(hi + 7, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const u1 = Math.max((h >>> 8) / 16777216, 1e-9);
  h = Math.imul(h ^ 0x27d4eb2d, 0x165667b1) >>> 0;
  const u2 = (h >>> 8) / 16777216;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * SHADOW_SIGMA_DB;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ITU-R P.526 single knife edge over the highest terrain point above the line of sight.
export function diffractionLossDb(terrain: TerrainLike, tx: Vec3, rx: Vec3): number {
  const steps = 64;
  let worst = 0;
  let top: Vec3 | null = null;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = tx.x + (rx.x - tx.x) * t;
    const y = tx.y + (rx.y - tx.y) * t;
    const line = tx.z + (rx.z - tx.z) * t;
    const g = terrain.height(x, y);
    if (g - line > worst) {
      worst = g - line;
      top = { x, y, z: g };
    }
  }
  if (!top) return 0;
  const lambda = LIGHT_SPEED / FREQ_HZ;
  const d1 = dist(tx, top);
  const d2 = dist(top, rx);
  if (d1 <= 0 || d2 <= 0) return 0;
  const v = worst * Math.sqrt((2 / lambda) * (1 / d1 + 1 / d2));
  if (v <= -0.78) return 0;
  const loss = 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
  return Math.max(0, loss);
}

export interface LinkBudget {
  distanceM: number;
  pathLossDb: number;
  shadowDb: number;
  diffractionDb: number;
  rssiDbm: number;
  snrDb: number;
}

export interface LinkOptions {
  seed: number;
  terrain: TerrainLike;
  linkA: number;
  linkB: number;
  // Extra per-packet fading, dB, already drawn by the caller.
  fadeDb?: number;
}

export function linkBudget(tx: Vec3, rx: Vec3, bw: number, opts: LinkOptions): LinkBudget {
  const d = dist(tx, rx);
  const shadowDb = linkShadowDb(opts.seed, opts.linkA, opts.linkB);
  const diffractionDb = diffractionLossDb(opts.terrain, tx, rx);
  const loss = pathLoss(d) + shadowDb + diffractionDb + (opts.fadeDb ?? 0);
  const rssiDbm = TX_DBM + ANT_DBI + ANT_DBI - loss;
  return {
    distanceM: d,
    pathLossDb: loss,
    shadowDb,
    diffractionDb,
    rssiDbm,
    snrDb: rssiDbm - noiseFloor(bw),
  };
}

export interface Wave {
  id: number;
  tx: number;
  rx: number[];
  startS: number;
  endS: number;
  sf: number;
  bw: number;
  channel: number;
  // Received power in dBm of this wave at a receiver.
  power: Map<number, number>;
}

export function overlaps(a: { startS: number; endS: number }, b: { startS: number; endS: number }): boolean {
  return a.startS < b.endS && b.startS < a.endS;
}

export interface FateResult {
  fate: Fate;
  rssi: number;
  snr: number;
  reason: string;
}

// Decides one receiver's fate for one wave. `busy` are [start, end] intervals when that receiver
// was transmitting (half-duplex). Interference is any other overlapping wave on the same channel
// and SF. Capture needs signal-to-interference of at least 6 dB.
export function receiveWave(
  wave: Wave,
  receiver: number,
  waves: Wave[],
  busy: { startS: number; endS: number }[] = [],
): FateResult {
  const rssi = wave.power.get(receiver);
  if (rssi === undefined) return { fate: 'range', rssi: -Infinity, snr: -Infinity, reason: 'no path' };
  const snr = rssi - noiseFloor(wave.bw);
  if (busy.some((b) => overlaps(wave, b))) {
    return { fate: 'half-duplex', rssi, snr, reason: 'radio was transmitting' };
  }
  if (snr < SNR_REQ[wave.sf]) {
    return { fate: 'range', rssi, snr, reason: `SNR ${snr.toFixed(1)} dB below ${SNR_REQ[wave.sf]} dB` };
  }
  let interference = -Infinity;
  for (const other of waves) {
    if (other.id === wave.id || other.tx === wave.tx) continue;
    if (other.channel !== wave.channel || other.sf !== wave.sf) continue;
    if (!overlaps(wave, other)) continue;
    const p = other.power.get(receiver);
    if (p !== undefined) interference = Math.max(interference, p);
  }
  if (interference > -Infinity && rssi - interference < CAPTURE_DB) {
    return {
      fate: 'collision',
      rssi,
      snr,
      reason: `SIR ${(rssi - interference).toFixed(1)} dB below ${CAPTURE_DB} dB`,
    };
  }
  return { fate: 'decoded', rssi, snr, reason: 'captured' };
}

// Airtime accounting per node and per channel. All times are sim seconds.
export class DutyMeter {
  private readonly tx = new Map<string, number>();
  private readonly busy = new Map<string, number>();
  startS = 0;
  nowS = 0;

  addTx(node: number, channel: string, seconds: number): void {
    const key = `${node}|${channel}`;
    this.tx.set(key, (this.tx.get(key) ?? 0) + seconds);
  }

  addBusy(channel: string, seconds: number): void {
    this.busy.set(channel, (this.busy.get(channel) ?? 0) + seconds);
  }

  nodeSeconds(node: number, channel?: string): number {
    let sum = 0;
    for (const [key, v] of this.tx) {
      const [id, ch] = key.split('|');
      if (Number(id) === node && (channel === undefined || ch === channel)) sum += v;
    }
    return sum;
  }

  channelSeconds(channel: string): number {
    return this.busy.get(channel) ?? 0;
  }

  nodeDuty(node: number, channel: string, elapsedS: number): number {
    return elapsedS > 0 ? this.nodeSeconds(node, channel) / elapsedS : 0;
  }

  channelDuty(channel: string): number {
    const elapsed = this.nowS - this.startS;
    return elapsed > 0 ? this.channelSeconds(channel) / elapsed : 0;
  }

  asObject(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, v] of this.tx) out[`tx:${key}`] = v;
    for (const [key, v] of this.busy) out[`busy:${key}`] = v;
    return out;
  }
}
