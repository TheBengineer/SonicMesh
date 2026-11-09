import { FS, REF_PA } from '../acoustics/model';

// Onset detector for impulsive sounds such as gunshots. It compares the energy of each 1 ms window with a slow
// background and reports a window that is well above it. This is a level test, not the classifier the field
// node will run: it does not tell a shot from a slam or a firework.
const WIN = FS / 1000;
const RATIO = 100; // 20 dB in power
const BG_ALPHA = 0.001; // about 1 s, in windows
const HOLD_WINDOWS = 300; // 0.3 s after an onset before another can start
// The peak follower decays with a 0.2 s time constant. A new onset must rise 20 dB above it, so the reverb tail of one
// shot does not count as the next.
const ENV_DECAY = Math.exp(-1 / 200);
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
  private envelope = 0;
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
        this.envelope = e;
        this.primed = true;
      }
      const floor = Math.max(this.background, this.envelope * ENV_DECAY);
      if (this.hold > 0) {
        this.hold--;
      } else if (e > RATIO * floor && e > MIN_POWER) {
        onsets.push(this.cursor);
        this.hold = HOLD_WINDOWS;
      } else {
        this.background += BG_ALPHA * (e - this.background);
      }
      this.envelope = Math.max(e, this.envelope * ENV_DECAY);
      this.cursor += WIN;
    }
    return onsets;
  }
}
