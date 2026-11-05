import listenWorkletUrl from './listen-worklet.ts?worker&url';
import type { AudioRing } from '../acoustics/history';
import { FS } from '../acoustics/model';
import type { SimHost } from '../sim/simHost';
import type { Frame } from '../sim/protocol';

const LATENCY_S = 0.2;
const MAX_LAG_S = 0.5;
const PUMP_MS = 20;

// Plays one mic in real time. The sim sends 16 kHz samples; the worklet upsamples them to the device rate. Gain
// follows the slider, and the output is muted unless the sim is running at 1x.
export class Listener {
  key: string | null = null;
  rate = 0;
  private ctx: AudioContext | null = null;
  private ready: Promise<void> | null = null;
  // The mic most recently asked for. start() waits on the browser, and may be overtaken while it does.
  private wanted: string | null = null;
  private node: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private gainValue = 1;
  private ring: AudioRing | null = null;
  private cursor = -1;
  private timer = 0;

  constructor(private readonly host: SimHost) {}

  async start(key: string): Promise<void> {
    this.wanted = key;
    this.ready ??= this.init().catch((err: unknown) => {
      this.ready = null;
      throw err;
    });
    await this.ready;
    const ctx = this.ctx;
    const node = this.node;
    if (!ctx || !node) return;
    if (ctx.state === 'suspended') await ctx.resume();
    if (this.wanted !== key) return;
    this.key = key;
    this.cursor = -1;
    node.port.postMessage({ t: 'clear' });
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.pump(), PUMP_MS);
  }

  // Retries a start the browser held back, from a later user gesture.
  wake(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  stop(): void {
    this.wanted = null;
    this.key = null;
    window.clearInterval(this.timer);
    this.timer = 0;
    this.node?.port.postMessage({ t: 'clear' });
    if (this.gainNode) this.gainNode.gain.value = 0;
  }

  setGain(v: number): void {
    this.gainValue = v;
  }

  sync(f: Frame): void {
    if (!this.gainNode) return;
    this.gainNode.gain.value = this.key !== null && f.playing && f.speed === 1 ? this.gainValue : 0;
  }

  private async init(): Promise<void> {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(listenWorkletUrl);
    const node = new AudioWorkletNode(ctx, 'listen', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { step: FS / ctx.sampleRate },
    });
    const gain = new GainNode(ctx, { gain: 0 });
    node.connect(gain).connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    this.gainNode = gain;
    this.rate = ctx.sampleRate;
  }

  private pump(): void {
    const ring = this.key === null ? undefined : this.host.ring(this.key);
    if (!ring || !this.node) return;
    if (ring !== this.ring) {
      this.ring = ring;
      this.cursor = -1;
    }
    const end = ring.written;
    if (this.cursor < 0 || end < this.cursor || end - this.cursor > MAX_LAG_S * FS) {
      this.cursor = Math.max(0, end - LATENCY_S * FS);
    }
    const n = end - this.cursor;
    if (n <= 0) return;
    const samples = new Float32Array(n);
    if (!ring.read(this.cursor, samples)) {
      this.cursor = Math.max(0, end - LATENCY_S * FS);
      return;
    }
    this.cursor = end;
    this.node.port.postMessage({ t: 'samples', samples }, [samples.buffer]);
  }
}
