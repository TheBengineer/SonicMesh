import type { Message } from '../protocol/messages';
import type { Bogie } from './bogies';
import type { Fate } from './channel';

export interface RxView {
  id: number;
  fate: Fate;
  rssi: number;
  snr: number;
  reason: string;
}

export interface PacketView {
  id: number;
  startS: number;
  endS: number;
  tx: number;
  rx: RxView[];
  sf: number;
  bw: number;
  channel: string;
  type: string;
  payloadBytes: number;
  airtimeS: number;
  slot: string;
  frameHex: string[];
  message: Message;
}

export interface MessageView {
  id: number;
  packetId: number;
  t: number;
  dir: 'sent' | 'received';
  type: string;
  peer: number;
  frameHex: string[];
  fields: Message;
}

export interface HealthValueView {
  key: string;
  name: string;
  bits: number;
  raw: number;
  value: number;
  unit: string;
  provenance: string;
}

export interface HealthView {
  atS: number;
  fields: number[];
  values: HealthValueView[];
}

export interface RangingView {
  atS: number;
  sweep: number;
  peer: number;
  measuredM: number;
  trueM: number;
  rssi: number;
  snr: number;
}

// One stretch of detection at a node. endS is null while it runs; lineHz is the last line the node reported.
export interface DetectSpan {
  startS: number;
  endS: number | null;
  lineHz: number | null;
}

// What the detector is doing: nothing to follow, following a pitch but not sure yet, or detecting.
export type DetectState = 'quiet' | 'arming' | 'detecting';

export interface NodeView {
  id: number;
  kind: 'detector' | 'array';
  detecting: boolean;
  // The nearest drone the detector's pitch fits, from truth. Only the Truth view draws it. Empty when none fits.
  targetIds: number[];
  // The detector's pitch this frame while it detects, else 0.
  trackHz: number;
  // The pitch steadied over the last second, for labels and bogies.
  pitchHz: number;
  // An array node's bearing from its own mics, in degrees clockwise from +y. Null when it has none or its estimates disagree.
  bearingDeg: number | null;
  beaconHeard: boolean;
  lastDetectionS: number;
  detectSpans: DetectSpan[];
  // The best comb score this frame, which the detector compares with its threshold.
  peak: number;
  detectState: DetectState;
  detections: number;
  queue: number;
  retries: number;
  silent: boolean;
  lastHealthS: number | null;
  health: HealthView | null;
  messages: MessageView[];
  ranging: RangingView[];
  duty: number;
  txSeconds: number;
}

export interface GatewayView {
  mode: 'idle' | 'event';
  superframe: number;
  eventLastS: number;
  health: { id: number; health: HealthView | null; silent: boolean; lastHealthS: number | null }[];
  silent: number[];
  duty: { channel: string; duty: number; seconds: number }[];
  beaconDuty: number;
  messages: MessageView[];
}

export interface GridSlot {
  startS: number;
  endS: number;
  label: string;
  kind: 'beacon' | 'alert' | 'slot' | 'burst';
}

export interface LoraView {
  mode: 'idle' | 'event';
  superframe: number;
  superframeStartS: number;
  superframeDurationS: number;
  eventLastS: number;
  packets: PacketView[];
  nodes: NodeView[];
  bogies: Bogie[];
  gateway: GatewayView;
  grid: GridSlot[];
}
