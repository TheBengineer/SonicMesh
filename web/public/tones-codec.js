// Deploy-tones signal, version 1. The numbers here must match
// docs/deploy-tones.md, the Python reference and the node firmware detector.
// Plain ES module with no dependencies, so the phone page can load it directly.

export const VERSION = 1;

// Tone k (0..7) is at TONE_BASE_HZ + TONE_STEP_HZ * k.
export const TONE_COUNT = 8;
export const TONE_BASE_HZ = 1500;
export const TONE_STEP_HZ = 250;

// Each symbol is one tone for SYMBOL_MS with RAMP_MS raised-cosine ramps at both ends.
export const SYMBOL_MS = 48;
export const RAMP_MS = 4;

// A frame is 12 symbols: a 4-symbol preamble then 24 bits (word + CRC) in 8 groups of 3 bits.
export const FRAME_SYMBOLS = 12;
export const PREAMBLE = [0, 7, 0, 7];

// The page plays the frame this many times, with silence between the frames.
export const REPEATS = 3;
export const GAP_MS = 250;

// Word layout: bits 15..12 are the command, bits 11..0 the argument.
export const CMD_MARK = 1;
export const MARK_MAX = 4095;

// Frequency in Hz of tone index k.
export function toneFrequency(k) {
  return TONE_BASE_HZ + TONE_STEP_HZ * k;
}

// CRC-8/SMBUS: polynomial 0x07, initial value 0x00, no reflection, no final XOR.
// Check value of ASCII "123456789" is 0xF4.
export function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? (((crc << 1) ^ 0x07) & 0xff) : ((crc << 1) & 0xff);
    }
  }
  return crc;
}

// The MARK word for mark number n (0..4095).
export function markWord(n) {
  if (!Number.isInteger(n) || n < 0 || n > MARK_MAX) {
    throw new RangeError(`mark must be an integer 0..${MARK_MAX}, got ${n}`);
  }
  return 0x1000 | n;
}

// The 12 tone indexes of the frame for a 16-bit word.
export function wordSymbols(word) {
  if (!Number.isInteger(word) || word < 0 || word > 0xffff) {
    throw new RangeError(`word must be an integer 0..65535, got ${word}`);
  }
  const crc = crc8([(word >> 8) & 0xff, word & 0xff]);
  // 24 bits: the word (high byte first) followed by its CRC.
  const bits = ((word << 8) | crc) >>> 0;
  const symbols = PREAMBLE.slice();
  for (let group = 7; group >= 0; group--) {
    symbols.push((bits >> (3 * group)) & 0x7);
  }
  return symbols;
}

// Amplitude envelope for sample j of a symbol that is len samples long.
// Both ends are zero, and the ramps are raised cosines ramp samples long.
function envelope(j, len, ramp) {
  if (j < ramp) {
    return 0.5 * (1 - Math.cos((Math.PI * j) / ramp));
  }
  if (j >= len - ramp) {
    const m = len - 1 - j;
    return 0.5 * (1 - Math.cos((Math.PI * m) / ramp));
  }
  return 1;
}

// Render the whole send for a word as a Float32Array at sampleRate:
// REPEATS frames of FRAME_SYMBOLS symbols, with GAP_MS of silence between frames.
export function synth(word, sampleRate, options = {}) {
  const repeats = options.repeats ?? REPEATS;
  const amplitude = options.amplitude ?? 0.9;
  const symbols = wordSymbols(word);

  const symLen = Math.round((SYMBOL_MS * sampleRate) / 1000);
  const ramp = Math.round((RAMP_MS * sampleRate) / 1000);
  const gap = Math.round((GAP_MS * sampleRate) / 1000);
  const frameLen = symLen * FRAME_SYMBOLS;
  const total = repeats * frameLen + Math.max(0, repeats - 1) * gap;

  const out = new Float32Array(total);
  let pos = 0;
  for (let r = 0; r < repeats; r++) {
    if (r > 0) pos += gap;
    for (const k of symbols) {
      const omega = (2 * Math.PI * toneFrequency(k)) / sampleRate;
      for (let j = 0; j < symLen; j++) {
        out[pos + j] = amplitude * envelope(j, symLen, ramp) * Math.sin(omega * j);
      }
      pos += symLen;
    }
  }
  return out;
}
