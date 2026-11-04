import { describe, expect, it } from 'vitest';
import vectors from './golden/protocol_v0.json';
import { aesCmac } from '../src/protocol/cmac';
import { hexToBytes } from '../src/protocol/bits';
import { decodeFrame, encodeFrame, TEST_SITE_ID, TEST_SITE_KEY } from '../src/protocol/frame';
import {
  decodePayload,
  encodePayload,
  HEALTH_FIELDS,
  type Message,
  type MessageType,
} from '../src/protocol/messages';

const key = Uint8Array.from(vectors.site_key_hex.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? []);

// RFC 4493, AES-128 key and CMAC tags.
const RFC_KEY = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
const RFC_CASES: [string, string][] = [
  ['', 'bb1d6929e95937287fa37d129b756746'],
  ['6bc1bee22e409f96e93d7e117393172a', '070a16b46b4d4144f79bdd9dd04a287c'],
  [
    '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411',
    'dfa66747de9ae63030ca32611497c827',
  ],
  [
    '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710',
    '51f0bebf7e3b9d92fc49741779363cfe',
  ],
];

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMessage(type: MessageType, rnd: () => number): Message {
  const u = (width: number): number => Math.floor(rnd() * 2 ** width);
  switch (type) {
    case 'BEACON':
      return {
        type,
        counter: u(32),
        gnssMs: u(40),
        mode: rnd() < 0.5 ? 0 : 1,
        nextPhy: { sf: 5 + u(3), bw: rnd() < 0.5 ? 125_000 : 500_000 },
        slotMap: Array.from({ length: u(6) }, () => ({ node: u(8), action: u(3), arg: u(5) })),
        track:
          rnd() < 0.5
            ? null
            : {
                id: u(8),
                x: (u(12) - 2048) * 2,
                y: (u(12) - 2048) * 2,
                z: (u(12) - 2048) * 2,
                vx: (u(8) - 128) * 0.5,
                vy: (u(8) - 128) * 0.5,
                vz: (u(8) - 128) * 0.5,
                time: u(16),
              },
        snippets: Array.from({ length: u(3) }, () => ({ node: u(8), requestId: u(8), startSample: u(32), lengthMs: u(8) })),
        commands: Array.from({ length: u(4) }, () => ({ id: u(8), arg: u(8) })),
      };
    case 'DETECT_START':
      return { type, confidence: u(4), level: u(6), cls: u(3), az: u(9), el: u(5), lineHz: u(11) };
    case 'DETECT':
      return {
        type,
        confidence: u(4),
        level: u(6),
        az: u(9),
        el: u(5),
        bearingSigma: u(4),
        line1Hz: u(11),
        line2Delta: u(6),
        cls: u(3),
        clipReady: u(1),
      };
    case 'SNIPPET': {
      const bytes = u(5);
      return {
        type,
        requestId: u(8),
        chunk: u(4),
        chunks: u(4),
        startSample: u(32),
        data: Array.from({ length: bytes * 8 }, () => u(1)),
      };
    }
    case 'HEALTH':
      return { type, fields: HEALTH_FIELDS.map((f) => u(f.bits)) };
    case 'RANGING_RESULT':
      return {
        type,
        results: Array.from({ length: u(4) }, () => ({ id: u(8), rangeDm: u(16), rssi: u(8), snr: u(8) })),
      };
    case 'JOIN':
      return {
        type,
        lat: u(32) - 2 ** 31,
        lon: u(32) - 2 ** 31,
        altDm: u(16),
        accuracyDm: u(8),
        confident: u(1),
        nodeType: u(2),
        provSeq: u(8),
        provTime: u(40),
        provMac: u(32),
      };
    case 'ACK':
      return { type, commandId: u(8), result: u(8) };
  }
}

describe('AES-CMAC-32', () => {
  it('matches the RFC 4493 vectors', () => {
    for (const [msg, tag] of RFC_CASES) {
      expect(Array.from(aesCmac(RFC_KEY, hexToBytes(msg)))).toEqual(Array.from(hexToBytes(tag)));
    }
  });
});

describe('protocol v0 codec', () => {
  it('encodes every golden vector to the same hex and decodes to its fields', () => {
    expect(vectors.messages.length).toBeGreaterThanOrEqual(40);
    for (const v of vectors.messages) {
      const msg = v.fields as unknown as Message;
      const frame = encodeFrame(msg, v.src, { siteKey: key, siteId: vectors.site_id, fullCounter: v.full_counter });
      expect(Array.from(frame, (b) => b.toString(16).padStart(2, '0')).join(''), `${v.name} #${v.full_counter}`).toBe(
        v.frame_hex,
      );
      const decoded = decodeFrame(hexToBytes(v.frame_hex), {
        siteKey: key,
        siteId: vectors.site_id,
        fullCounter: v.full_counter,
        expectedCtr: v.full_counter,
      });
      expect(decoded.message).toEqual(msg);
      expect(decoded.src).toBe(v.src);
      expect(decoded.ctr).toBe(v.full_counter & 0xff);
    }
  });

  it('round-trips 1000 random messages', () => {
    const rnd = mulberry(0x5eed1234);
    const types: MessageType[] = [
      'BEACON',
      'DETECT_START',
      'DETECT',
      'SNIPPET',
      'HEALTH',
      'RANGING_RESULT',
      'JOIN',
      'ACK',
    ];
    for (let i = 0; i < 1000; i++) {
      const msg = randomMessage(types[i % types.length], rnd);
      expect(decodePayload(msg.type, encodePayload(msg))).toEqual(msg);
    }
  });

  it('rejects a frame with a wrong MIC or a replayed counter', () => {
    const msg: Message = { type: 'ACK', commandId: 3, result: 1 };
    const frame = encodeFrame(msg, 4, { fullCounter: 77 });
    const bad = frame.slice();
    bad[bad.length - 1] ^= 0xff;
    expect(() => decodeFrame(bad, { fullCounter: 77 })).toThrow(/bad MIC/);
    expect(() => decodeFrame(frame, { fullCounter: 77, lastCtr: 77 })).toThrow(/replayed counter/);
    expect(() => decodeFrame(frame, { fullCounter: 78 })).toThrow(/bad MIC/);
  });

  it('uses the fixed test site key in the golden file', () => {
    expect(Array.from(key)).toEqual(Array.from(TEST_SITE_KEY));
    expect(vectors.site_id).toBe(TEST_SITE_ID);
  });
});
