// AudioWorklet for listen mode. Plays sim mic audio (16 kHz) at the device rate, 4-point Lagrange interpolation.
// The page pushes samples by message. The worklet waits for 150 ms before it starts and goes silent on underrun.

// TypeScript has no lib for the AudioWorklet global scope; declare the parts used here.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

const CAP = 1 << 16;
const START = 2400;

class ListenProcessor extends AudioWorkletProcessor {
  private readonly q = new Float32Array(CAP);
  private readonly step: number;
  private wr = 0;
  private pos = 1;
  private playing = false;

  constructor(options: { processorOptions: { step: number } }) {
    super();
    this.step = options.processorOptions.step;
    this.port.onmessage = (e: MessageEvent<{ t: 'clear' } | { t: 'samples'; samples: Float32Array }>) => {
      const m = e.data;
      if (m.t === 'clear') {
        this.wr = 0;
        this.pos = 1;
        this.playing = false;
        return;
      }
      for (let i = 0; i < m.samples.length; i++) {
        this.q[this.wr % CAP] = m.samples[i];
        this.wr++;
      }
      if (this.wr - this.pos > CAP - 4096) this.pos = this.wr - START;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.playing) {
      if (this.wr - this.pos < START) {
        out.fill(0);
        return true;
      }
      this.playing = true;
    }
    for (let i = 0; i < out.length; i++) {
      const k = Math.floor(this.pos);
      if (k + 2 >= this.wr) {
        out.fill(0, i);
        this.playing = false;
        return true;
      }
      const f = this.pos - k;
      const cm1 = (-f * (f - 1) * (f - 2)) / 6;
      const c0 = ((f + 1) * (f - 1) * (f - 2)) / 2;
      const c1 = (-(f + 1) * f * (f - 2)) / 2;
      const c2 = ((f + 1) * f * (f - 1)) / 6;
      out[i] =
        cm1 * this.q[(k - 1) % CAP] +
        c0 * this.q[k % CAP] +
        c1 * this.q[(k + 1) % CAP] +
        c2 * this.q[(k + 2) % CAP];
      this.pos += this.step;
    }
    return true;
  }
}

registerProcessor('listen', ListenProcessor);

export {};
