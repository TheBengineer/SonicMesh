import { aesCmac } from './cmac';
import { littleEndian } from './bits';
import { decodePayload, encodePayload, type Message, type MessageTypeCode, typeName, typeCode } from './messages';

// Fixed test site used by the golden vectors. A real deployment provisions its own key.
export const TEST_SITE_KEY = Uint8Array.from([0x53, 0x6f, 0x6e, 0x69, 0x63, 0x4d, 0x65, 0x73, 0x68, 0x2d, 0x74, 0x65, 0x73, 0x74, 0x30, 0x31]);
export const TEST_SITE_ID = 0x534d;

export const FRAME_OVERHEAD = 7;

export interface FrameOptions {
  siteKey?: Uint8Array;
  siteId?: number;
  fullCounter: number;
  // Reject a frame whose low counter byte differs from the expected superframe.
  expectedCtr?: number;
  // Reject a counter at or below the last accepted one. The caller resets this on beacon wrap.
  lastCtr?: number;
}

export interface Frame {
  type: MessageTypeCode;
  src: number;
  ctr: number;
  version: number;
  relayed: boolean;
  encrypted: boolean;
  payload: Uint8Array;
  mic: number;
}

export interface DecodedFrame extends Frame {
  message: Message;
}

function cmacInput(siteId: number, fullCounter: number, head: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + 4 + head.length);
  out.set(littleEndian(siteId, 2), 0);
  out.set(littleEndian(fullCounter, 4), 2);
  out.set(head, 6);
  return out;
}

function micOf(key: Uint8Array, siteId: number, fullCounter: number, head: Uint8Array): number {
  const mac = aesCmac(key, cmacInput(siteId, fullCounter, head));
  return ((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) >>> 0;
}

export function encodeFrame(message: Message, src: number, opts: FrameOptions): Uint8Array {
  if (!Number.isInteger(src) || src < 0 || src > 255) throw new Error('protocol: src must be a byte');
  const payload = encodePayload(message);
  if (payload.length > 247) throw new Error('protocol: payload exceeds 247 bytes');
  const hdr = typeCode(message.type) | (0 << 4);
  const head = new Uint8Array(3 + payload.length);
  head[0] = hdr;
  head[1] = src;
  head[2] = opts.fullCounter & 0xff;
  head.set(payload, 3);
  const key = opts.siteKey ?? TEST_SITE_KEY;
  const siteId = opts.siteId ?? TEST_SITE_ID;
  const mic = micOf(key, siteId, opts.fullCounter, head);
  const out = new Uint8Array(head.length + 4);
  out.set(head);
  out[head.length] = (mic >>> 24) & 0xff;
  out[head.length + 1] = (mic >>> 16) & 0xff;
  out[head.length + 2] = (mic >>> 8) & 0xff;
  out[head.length + 3] = mic & 0xff;
  return out;
}

export function decodeFrame(bytes: Uint8Array, opts: FrameOptions): DecodedFrame {
  if (bytes.length < FRAME_OVERHEAD) throw new Error('protocol: frame too short');
  const hdr = bytes[0];
  const type = (hdr & 0x0f) as MessageTypeCode;
  const version = (hdr >> 4) & 0x03;
  const relayed = (hdr & 0x40) !== 0;
  const encrypted = (hdr & 0x80) !== 0;
  if (version !== 0) throw new Error(`protocol: unsupported version ${version}`);
  const src = bytes[1];
  const ctr = bytes[2];
  if (type > 7) throw new Error(`protocol: unknown message type ${type}`);
  if (opts.expectedCtr !== undefined && ctr !== (opts.expectedCtr & 0xff)) {
    throw new Error(`protocol: counter ${ctr} does not match expected ${opts.expectedCtr & 0xff}`);
  }
  if (opts.lastCtr !== undefined && ctr <= opts.lastCtr) {
    throw new Error(`protocol: replayed counter ${ctr}`);
  }
  const head = bytes.subarray(0, bytes.length - 4);
  const payload = head.subarray(3);
  const mic = ((bytes[bytes.length - 4] << 24) | (bytes[bytes.length - 3] << 16) | (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1]) >>> 0;
  const key = opts.siteKey ?? TEST_SITE_KEY;
  const siteId = opts.siteId ?? TEST_SITE_ID;
  const expected = micOf(key, siteId, opts.fullCounter, head);
  if (mic !== expected) throw new Error('protocol: bad MIC');
  const message = decodePayload(typeName(type), payload);
  return { type, src, ctr, version, relayed, encrypted, payload: Uint8Array.from(payload), mic, message };
}

// Raw hex grouped by byte, for the packet inspector.
export function frameHex(bytes: Uint8Array): string[] {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
}
