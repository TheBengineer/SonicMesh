import { BitReader, BitWriter } from './bits';

// v0 message types, protocol-v0 section 4.
export const MESSAGE_TYPES = [
  'BEACON',
  'DETECT_START',
  'DETECT',
  'SNIPPET',
  'HEALTH',
  'RANGING_RESULT',
  'JOIN',
  'ACK',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export type MessageTypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export function typeCode(type: MessageType): MessageTypeCode {
  return MESSAGE_TYPES.indexOf(type) as MessageTypeCode;
}

export function typeName(code: number): MessageType {
  const name = MESSAGE_TYPES[code];
  if (!name) throw new Error(`protocol: unknown message type ${code}`);
  return name;
}

export interface Phy {
  sf: number;
  bw: number;
}

export interface SlotAssignment {
  node: number;
  action: number;
  arg: number;
}

export interface TrackState {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  time: number;
}

export interface SnippetRequest {
  node: number;
  requestId: number;
  startSample: number;
  lengthMs: number;
}

export interface Command {
  id: number;
  arg: number;
}

export interface BeaconMessage {
  type: 'BEACON';
  counter: number;
  gnssMs: number;
  mode: 0 | 1;
  nextPhy: Phy;
  slotMap: SlotAssignment[];
  track: TrackState | null;
  snippets: SnippetRequest[];
  commands: Command[];
}

export interface DetectStartMessage {
  type: 'DETECT_START';
  confidence: number;
  level: number;
  cls: number;
  az: number;
  el: number;
  lineHz: number;
}

export interface DetectMessage {
  type: 'DETECT';
  confidence: number;
  level: number;
  az: number;
  el: number;
  bearingSigma: number;
  line1Hz: number;
  line2Delta: number;
  cls: number;
  clipReady: number;
}

export interface SnippetMessage {
  type: 'SNIPPET';
  requestId: number;
  chunk: number;
  chunks: number;
  startSample: number;
  // One entry per data bit, 0 or 1. Packed LSB first after the six-byte header.
  data: number[];
}

export interface HealthMessage {
  type: 'HEALTH';
  // Raw values in HEALTH_FIELDS order.
  fields: number[];
}

export interface RangingEntry {
  id: number;
  rangeDm: number;
  rssi: number;
  snr: number;
}

export interface RangingResultMessage {
  type: 'RANGING_RESULT';
  results: RangingEntry[];
}

export interface JoinMessage {
  type: 'JOIN';
  lat: number;
  lon: number;
  altDm: number;
  accuracyDm: number;
  confident: number;
  nodeType: number;
  provSeq: number;
  provTime: number;
  provMac: number;
}

export interface AckMessage {
  type: 'ACK';
  commandId: number;
  result: number;
}

export type Message =
  | BeaconMessage
  | DetectStartMessage
  | DetectMessage
  | SnippetMessage
  | HealthMessage
  | RangingResultMessage
  | JoinMessage
  | AckMessage;

// Field names, widths and provenance for the 152-bit report in doc 06.
export const HEALTH_FIELDS = [
  { key: 'battery', name: 'Battery voltage, 10 mV', bits: 8, provenance: 'ASSUMED' },
  { key: 'solar', name: 'Solar harvest today, Wh/50', bits: 8, provenance: 'ASSUMED' },
  { key: 'temperature', name: 'Enclosure temperature, 0.5 C', bits: 8, provenance: 'ASSUMED' },
  { key: 'uptime', name: 'Uptime hours + reset reason', bits: 16, provenance: 'ASSUMED' },
  { key: 'micFloor', name: 'Mic band noise floor, dB', bits: 8, provenance: 'MODELLED' },
  { key: 'micFlags', name: 'Mic self-test flags', bits: 4, provenance: 'MODELLED' },
  { key: 'wind', name: 'Wind / self-noise level, dB', bits: 8, provenance: 'ASSUMED' },
  { key: 'detections', name: 'Detections + rejected candidates', bits: 12, provenance: 'MODELLED' },
  { key: 'tilt', name: 'Tilt from install orientation, deg', bits: 8, provenance: 'ASSUMED' },
  { key: 'tamper', name: 'Tamper / moved flags', bits: 4, provenance: 'MODELLED' },
  { key: 'beaconLink', name: 'Beacon RSSI + SNR', bits: 16, provenance: 'MODELLED' },
  { key: 'clock', name: 'Clock offset (us) + drift (ppm)', bits: 16, provenance: 'ASSUMED' },
  { key: 'mesh', name: 'Neighbours, retries, queue depth', bits: 12, provenance: 'MODELLED' },
  { key: 'gnss', name: 'GNSS sats + PPS lock', bits: 8, provenance: 'ASSUMED' },
  { key: 'build', name: 'Firmware hash / config CRC', bits: 16, provenance: 'ASSUMED' },
] as const;

export const HEALTH_BITS = HEALTH_FIELDS.reduce((sum, f) => sum + f.bits, 0);

// next PHY is four bits in the spec: three for SF-5 and one for 125 kHz versus 500 kHz.
export function encodePhy(p: Phy): number {
  return ((p.sf - 5) & 7) * 2 + (p.bw === 500_000 ? 1 : 0);
}

export function decodePhy(v: number): Phy {
  return { sf: ((v >> 1) & 7) + 5, bw: (v & 1) === 1 ? 500_000 : 125_000 };
}

function writeTrack(w: BitWriter, t: TrackState): void {
  w.u(t.id, 8);
  w.u(t.x / 2 + 2048, 12);
  w.u(t.y / 2 + 2048, 12);
  w.u(t.z / 2 + 2048, 12);
  w.u(t.vx / 0.5 + 128, 8);
  w.u(t.vy / 0.5 + 128, 8);
  w.u(t.vz / 0.5 + 128, 8);
  w.u(t.time, 16);
  // 84 listed bits; four reserved bits make the 11 B track state in the spec.
  w.u(0, 4);
}

function readTrack(r: BitReader): TrackState {
  const track = {
    id: r.u(8),
    x: (r.u(12) - 2048) * 2,
    y: (r.u(12) - 2048) * 2,
    z: (r.u(12) - 2048) * 2,
    vx: (r.u(8) - 128) * 0.5,
    vy: (r.u(8) - 128) * 0.5,
    vz: (r.u(8) - 128) * 0.5,
    time: r.u(16),
  };
  r.u(4);
  return track;
}

export function encodePayload(msg: Message): Uint8Array {
  const w = new BitWriter();
  switch (msg.type) {
    case 'BEACON':
      w.u(msg.counter, 32);
      w.u(msg.gnssMs, 40);
      w.u(msg.mode, 1);
      w.u(encodePhy(msg.nextPhy), 4);
      w.u(msg.slotMap.length, 6);
      for (const s of msg.slotMap) {
        w.u(s.node, 8);
        w.u(s.action, 3);
        w.u(s.arg, 5);
      }
      w.bitValue(msg.track !== null);
      if (msg.track) writeTrack(w, msg.track);
      w.u(msg.snippets.length, 3);
      for (const s of msg.snippets) {
        w.u(s.node, 8);
        w.u(s.requestId, 8);
        w.u(s.startSample, 32);
        w.u(s.lengthMs, 8);
      }
      w.u(msg.commands.length, 4);
      for (const c of msg.commands) {
        w.u(c.id, 8);
        w.u(c.arg, 8);
      }
      break;
    case 'DETECT_START':
      w.u(msg.confidence, 4);
      w.u(msg.level, 6);
      w.u(msg.cls, 3);
      w.u(msg.az, 9);
      w.u(msg.el, 5);
      w.u(msg.lineHz, 11);
      break;
    case 'DETECT':
      w.u(msg.confidence, 4);
      w.u(msg.level, 6);
      w.u(msg.az, 9);
      w.u(msg.el, 5);
      w.u(msg.bearingSigma, 4);
      w.u(msg.line1Hz, 11);
      w.u(msg.line2Delta, 6);
      w.u(msg.cls, 3);
      w.u(msg.clipReady, 1);
      // The listed fields sum to 49 bits; seven reserved bits keep the payload at the stated 8 B.
      w.u(0, 7);
      break;
    case 'SNIPPET': {
      w.u(msg.requestId, 8);
      w.u(msg.chunk, 4);
      w.u(msg.chunks, 4);
      w.u(msg.startSample, 32);
      for (const b of msg.data) w.bitValue(b !== 0);
      break;
    }
    case 'HEALTH':
      HEALTH_FIELDS.forEach((f, i) => w.u(msg.fields[i] ?? 0, f.bits));
      break;
    case 'RANGING_RESULT':
      w.u(msg.results.length, 4);
      for (const r of msg.results) {
        w.u(r.id, 8);
        w.u(r.rangeDm, 16);
        w.u(r.rssi, 8);
        w.u(r.snr, 8);
      }
      break;
    case 'JOIN':
      w.signed(msg.lat, 32);
      w.signed(msg.lon, 32);
      w.u(msg.altDm, 16);
      w.u(msg.accuracyDm, 8);
      w.u(msg.confident, 1);
      w.u(msg.nodeType, 2);
      w.u(msg.provSeq, 8);
      w.u(msg.provTime, 40);
      w.u(msg.provMac, 32);
      break;
    case 'ACK':
      w.u(msg.commandId, 8);
      w.u(msg.result, 8);
      break;
  }
  return w.finish();
}

export function decodePayload(type: MessageType, payload: Uint8Array): Message {
  const r = new BitReader(payload);
  switch (type) {
    case 'BEACON': {
      const counter = r.u(32);
      const gnssMs = r.u(40);
      const mode = r.u(1) as 0 | 1;
      const nextPhy = decodePhy(r.u(4));
      const nSlots = r.u(6);
      const slotMap: SlotAssignment[] = [];
      for (let i = 0; i < nSlots; i++) slotMap.push({ node: r.u(8), action: r.u(3), arg: r.u(5) });
      const track = r.bitValue() ? readTrack(r) : null;
      const nSnippets = r.u(3);
      const snippets: SnippetRequest[] = [];
      for (let i = 0; i < nSnippets; i++) {
        snippets.push({ node: r.u(8), requestId: r.u(8), startSample: r.u(32), lengthMs: r.u(8) });
      }
      const nCommands = r.u(4);
      const commands: Command[] = [];
      for (let i = 0; i < nCommands; i++) commands.push({ id: r.u(8), arg: r.u(8) });
      return { type, counter, gnssMs, mode, nextPhy, slotMap, track, snippets, commands };
    }
    case 'DETECT_START':
      return {
        type,
        confidence: r.u(4),
        level: r.u(6),
        cls: r.u(3),
        az: r.u(9),
        el: r.u(5),
        lineHz: r.u(11),
      };
    case 'DETECT':
      return {
        type,
        confidence: r.u(4),
        level: r.u(6),
        az: r.u(9),
        el: r.u(5),
        bearingSigma: r.u(4),
        line1Hz: r.u(11),
        line2Delta: r.u(6),
        cls: r.u(3),
        clipReady: r.u(1),
      };
    case 'SNIPPET': {
      const requestId = r.u(8);
      const chunk = r.u(4);
      const chunks = r.u(4);
      const startSample = r.u(32);
      const data: number[] = [];
      while (r.remainingBits > 0) data.push(r.u(1));
      return { type, requestId, chunk, chunks, startSample, data };
    }
    case 'HEALTH':
      return { type, fields: HEALTH_FIELDS.map((f) => r.u(f.bits)) };
    case 'RANGING_RESULT': {
      const n = r.u(4);
      const results: RangingEntry[] = [];
      for (let i = 0; i < n; i++) results.push({ id: r.u(8), rangeDm: r.u(16), rssi: r.u(8), snr: r.u(8) });
      return { type, results };
    }
    case 'JOIN':
      return {
        type,
        lat: r.signed(32),
        lon: r.signed(32),
        altDm: r.u(16),
        accuracyDm: r.u(8),
        confident: r.u(1),
        nodeType: r.u(2),
        provSeq: r.u(8),
        provTime: r.u(40),
        provMac: r.u(32),
      };
    case 'ACK':
      return { type, commandId: r.u(8), result: r.u(8) };
  }
}
