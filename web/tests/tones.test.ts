import { describe, expect, it } from 'vitest';
import {
  GAP_MS,
  crc8,
  markWord,
  synth,
  toneFrequency,
  wordSymbols,
} from '../public/tones-codec.js';

const SR = 48000;
const SYMBOL_LEN = Math.round(0.048 * SR); // 2304 samples
const RAMP_LEN = Math.round(0.004 * SR); // 192 samples
const GAP_LEN = Math.round((GAP_MS / 1000) * SR); // 12000 samples
const FRAME_LEN = 12 * SYMBOL_LEN;

// Goertzel power of x at frequency hz (sample rate sr).
function goertzel(x: ArrayLike<number>, hz: number, sr: number): number {
  const w = (2 * Math.PI * hz) / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// Sample offset of symbol s (0..11) of frame f (0..2) in the synthesized send.
function symbolStart(frame: number, s: number): number {
  return frame * (FRAME_LEN + GAP_LEN) + s * SYMBOL_LEN;
}

describe('crc8 (CRC-8/SMBUS)', () => {
  it('has check value 0xF4 for "123456789"', () => {
    const bytes = Array.from('123456789', (c) => c.charCodeAt(0));
    expect(crc8(bytes)).toBe(0xf4);
  });
});

describe('markWord', () => {
  it('sets command 1 in bits 15..12 and the mark in bits 11..0', () => {
    expect(markWord(0)).toBe(0x1000);
    expect(markWord(7)).toBe(0x1007);
    expect(markWord(4095)).toBe(0x1fff);
  });

  it('rejects marks out of range', () => {
    expect(() => markWord(-1)).toThrow();
    expect(() => markWord(4096)).toThrow();
    expect(() => markWord(1.5)).toThrow();
  });
});

describe('wordSymbols', () => {
  it('matches the hand-computed frame for 0x1007', () => {
    // Word bytes 0x10 0x07, CRC-8 0x42. Bits: 0001 0000 0000 0111 0100 0010.
    // 3-bit groups: 000 100 000 000 011 101 000 010.
    expect(wordSymbols(0x1007)).toEqual([0, 7, 0, 7, 0, 4, 0, 0, 3, 5, 0, 2]);
  });

  it('returns 12 tone indexes, each 0..7', () => {
    const syms = wordSymbols(markWord(1234));
    expect(syms).toHaveLength(12);
    for (const s of syms) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(7);
    }
  });
});

describe('synth', () => {
  const word = markWord(7);
  const out = synth(word, SR);

  it('has the length 3 frames plus 2 gaps at 48000 Hz', () => {
    expect(out.length).toBe(3 * 12 * 0.048 * SR + 2 * 0.25 * SR);
    expect(out.length).toBe(106944);
  });

  it('plays each symbol at its expected tone (Goertzel over the middle 32 ms)', () => {
    const syms = wordSymbols(word);
    const mid0 = Math.round(0.008 * SR);
    const midLen = Math.round(0.032 * SR);
    for (let frame = 0; frame < 3; frame++) {
      for (let s = 0; s < 12; s++) {
        const start = symbolStart(frame, s) + mid0;
        const seg = out.subarray(start, start + midLen);
        let best = -1;
        let bestPower = -Infinity;
        for (let k = 0; k < 8; k++) {
          const p = goertzel(seg, toneFrequency(k), SR);
          if (p > bestPower) {
            bestPower = p;
            best = k;
          }
        }
        expect(best, `frame ${frame} symbol ${s}`).toBe(syms[s]);
      }
    }
  });

  it('starts and ends each symbol at zero amplitude', () => {
    for (let frame = 0; frame < 3; frame++) {
      for (let s = 0; s < 12; s++) {
        const start = symbolStart(frame, s);
        expect(Math.abs(out[start])).toBeLessThan(1e-9);
        expect(Math.abs(out[start + SYMBOL_LEN - 1])).toBeLessThan(1e-3);
      }
    }
  });

  it('keeps the envelope inside the ramps', () => {
    // Samples after the first ramp reach full level somewhere in the symbol.
    const start = symbolStart(0, 0);
    let peakInside = 0;
    for (let j = RAMP_LEN; j < SYMBOL_LEN - RAMP_LEN; j++) {
      peakInside = Math.max(peakInside, Math.abs(out[start + j]));
    }
    expect(peakInside).toBeGreaterThan(0.85);
  });

  it('never exceeds the amplitude', () => {
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('is silent in the gaps between frames', () => {
    const gapStart = FRAME_LEN;
    for (let i = gapStart; i < gapStart + GAP_LEN; i++) {
      expect(out[i]).toBe(0);
    }
  });
});
