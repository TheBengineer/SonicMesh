// Bit packing for v0 payloads: LSB first inside each byte, fields little-endian.
export class BitWriter {
  private readonly bytes: number[] = [];
  private bit = 0;

  get lengthBits(): number {
    return this.bytes.length * 8 - (8 - this.bit);
  }

  u(value: number, width: number): void {
    let v = Math.max(0, Math.floor(value));
    for (let i = 0; i < width; i++) {
      const b = v % 2;
      v = Math.floor(v / 2);
      if (this.bit === 0) this.bytes.push(0);
      if (b) this.bytes[this.bytes.length - 1] |= 1 << this.bit;
      this.bit = (this.bit + 1) % 8;
    }
  }

  signed(value: number, width: number): void {
    const span = 2 ** width;
    this.u(((Math.round(value) % span) + span) % span, width);
  }

  bitValue(b: boolean): void {
    this.u(b ? 1 : 0, 1);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export class BitReader {
  private bit = 0;

  constructor(private readonly data: Uint8Array) {}

  get remainingBits(): number {
    return this.data.length * 8 - this.bit;
  }

  u(width: number): number {
    let v = 0;
    let scale = 1;
    for (let i = 0; i < width; i++) {
      const byte = this.data[Math.floor(this.bit / 8)];
      if (byte === undefined) throw new Error('protocol: payload too short');
      const b = (byte >> (this.bit % 8)) & 1;
      if (b) v += scale;
      scale *= 2;
      this.bit++;
    }
    return v;
  }

  signed(width: number): number {
    const v = this.u(width);
    const sign = 2 ** (width - 1);
    return v >= sign ? v - 2 ** width : v;
  }

  bitValue(): boolean {
    return this.u(1) === 1;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('protocol: odd hex length');
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

export function littleEndian(value: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}
