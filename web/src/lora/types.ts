import type { Message } from '../protocol/messages';
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

export interface NodeView {
  id: number;
  kind: 'detector' | 'array';
  detecting: boolean;
  // The drone this detection belongs to. The stub takes the nearest drone from truth.
  targetId: number | null;
  beaconHeard: boolean;
  lastDetectionS: number;
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
  gateway: GatewayView;
  grid: GridSlot[];
}
