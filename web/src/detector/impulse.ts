import { FS, REF_PA } from '../acoustics/model';

// Onset detector for impulsive sounds such as gunshots. It compares the energy of each 1 ms window with a slow
// background and reports a window that is well above it. This is a level test, not the classifier the field
// node will run: it does not tell a shot from a slam or a firework.
const WIN = FS / 1000;
const RATIO = 16; // 12 dB in power
const BG_ALPHA = 0.001; // about 1 s, in windows
// The background learns only from windows within 10 dB of itself. A shot's tail sits well above that, so it is not learned.
const BG_LEARN_RATIO = 10;
const HOLD_WINDOWS = 50; // 50 ms after an onset before another can start, long enough for the crack itself
// A crack rises from the windows just before it, over a few milliseconds. The reverb tail falls away slowly, so it never
// rises 20 dB above what came just before. This short memory is what keeps the tail of one shot from hiding the next.
const RECENT_DECAY = Math.exp(-1 / 5);
// Windows quieter than this (60 dB SPL in power) never count, so silence cannot trigger it.
const MIN_POWER = (REF_PA * 10 ** (60 / 20)) ** 2;

export interface SampleSource {
  readonly written: number;
  readonly capacity: number;
  read(start: number, out: Float32Array): boolean;
}

export class ImpulseDetector {
  private cursor = 0;
  private background = 0;
  // The loudest window of the last few milliseconds, decaying.
  private recent = 0;
  private primed = false;
  private hold = 0;
  private readonly buf = new Float32Array(WIN);

  // Reads the new audio and returns the sample index where each onset starts.
  step(src: SampleSource): number[] {
    const onsets: number[] = [];
    if (src.written - this.cursor > src.capacity) this.cursor = src.written - WIN;
    while (this.cursor + WIN <= src.written && src.read(this.cursor, this.buf)) {
      let e = 0;
      for (let i = 0; i < WIN; i++) e += this.buf[i] * this.buf[i];
      e /= WIN;
      if (!this.primed) {
        this.background = e;
        this.primed = true;
      }
      const floor = Math.max(this.background, this.recent);
      if (this.hold > 0) {
        this.hold--;
      } else if (e > RATIO * floor && e > MIN_POWER) {
        onsets.push(this.cursor);
        this.hold = HOLD_WINDOWS;
      } else if (e < BG_LEARN_RATIO * this.background) {
        this.background += BG_ALPHA * (e - this.background);
      }
      this.recent = Math.max(e, this.recent * RECENT_DECAY);
      this.cursor += WIN;
    }
    return onsets;
  }
}
