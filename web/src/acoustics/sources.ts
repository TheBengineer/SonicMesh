import { createRng, type Rng } from '../sim/rng';
import type { DroneClass } from '../sim/scenario';
import { Biquad, gauss } from './dsp';
import { CLASS_ACOUSTICS, FS, N_HARM, REF_PA, ROTOR_OFFSETS } from './model';

const TWO_PI = 2 * Math.PI;
// Harmonic phases are fixed, not random. Shared with sim/golden/render.py.
const PHASE_STEP = 0.6180339887498949;
const COMMON_HZ = 0.3;
const ATTITUDE_HZ = 6;
// Broadband weight relative to unit harmonics, as in tdoa_feasibility.py. BB_STD is the approximate std of
// the 150 Hz to 3 kHz band-pass of unit white noise, so the broadband term has about unit std.
const BB_REL = 0.5;
const BB_STD = 0.6;
const Q_BAND = Math.SQRT1_2;

const HARM_AMP = new Float64Array(N_HARM);
const HARM_PHASE = new Float64Array(4 * N_HARM);
let harmPower = 0;
for (let h = 0; h < N_HARM; h++) {
  HARM_AMP[h] = (h + 1) ** -0.7;
  harmPower += (h + 1) ** -1.4;
  for (let i = 0; i < 4; i++) HARM_PHASE[i * N_HARM + h] = TWO_PI * (((i * N_HARM + h) * PHASE_STEP) % 1);
}

export interface SourceOptions {
  wobble: boolean;
  broadband: boolean;
}

// Synthetic quadrotor, ported from tdoa_feasibility.py synth_source / _synth_at. Output is pressure in Pa at
// 1 m. The gain is set so the harmonic part has RMS equal to the class level at 1 m (ASSUMED).
export class DroneSource {
  private readonly rng: Rng;
  private readonly bpf: number;
  private readonly gain: number;
  private readonly sigma: number;
  private readonly phase = new Float64Array(4);
  private readonly att = new Float64Array(4);
  private readonly bb: [Biquad, Biquad] | null;
  private readonly commonA: number;
  private readonly attA: number;
  private readonly commonDrive: number;
  private readonly attDrive: number;
  private common = 0;
  // Emitted blade-pass frequency of each rotor (Hz) at the last sample rendered.
  readonly hz = new Float64Array(4);

  constructor(cls: DroneClass, seed: number, opts: SourceOptions) {
    const spec = CLASS_ACOUSTICS[cls];
    this.rng = createRng(seed);
    this.bpf = spec.bpf_hz;
    this.gain = (REF_PA * 10 ** (spec.level_db_1m / 20)) / Math.sqrt(2 * harmPower);
    this.sigma = opts.wobble ? spec.wobble : 0;
    this.bb = opts.broadband ? [new Biquad('hp', 150, Q_BAND, FS), new Biquad('lp', 3000, Q_BAND, FS)] : null;
    this.commonA = Math.exp(-(TWO_PI * COMMON_HZ) / FS);
    this.attA = Math.exp(-(TWO_PI * ATTITUDE_HZ) / FS);
    // One-pole drive that gives each wobble term std = sigma.
    this.commonDrive = this.sigma * Math.sqrt(1 - this.commonA * this.commonA);
    this.attDrive = this.sigma * Math.sqrt(1 - this.attA * this.attA);
  }

  // Fills out with consecutive samples. factor[s] is the rotor speed factor (thrust based) at sample s.
  render(out: Float64Array, factor: ArrayLike<number>): void {
    const wobble = this.sigma > 0;
    for (let s = 0; s < out.length; s++) {
      if (wobble) this.common = this.commonA * this.common + this.commonDrive * gauss(this.rng);
      let tonal = 0;
      let blade = 0;
      for (let i = 0; i < 4; i++) {
        let rate = 1;
        if (wobble) {
          this.att[i] = this.attA * this.att[i] + this.attDrive * gauss(this.rng);
          rate = 1 + this.common + this.att[i];
        }
        const hz = this.bpf * (1 + ROTOR_OFFSETS[i]) * factor[s] * rate;
        this.hz[i] = hz;
        let p = this.phase[i] + hz / FS;
        p -= Math.floor(p);
        this.phase[i] = p;
        blade += Math.sin(TWO_PI * p);
        for (let h = 0; h < N_HARM; h++) {
          tonal += HARM_AMP[h] * Math.sin(TWO_PI * (h + 1) * p + HARM_PHASE[i * N_HARM + h]);
        }
      }
      let v = tonal;
      if (this.bb) {
        const w = this.bb[1].process(this.bb[0].process(gauss(this.rng)));
        v += BB_REL * (w / BB_STD) * (1 + 0.25 * blade);
      }
      out[s] = this.gain * v;
    }
  }
}

// Diffuse ambient noise. Paul Kellet's economy pink filter, band-limited to 100 Hz to 4 kHz.
export class PinkNoise {
  private static gain = 0;
  private readonly b = new Float64Array(7);
  private readonly hp = new Biquad('hp', 100, Q_BAND, FS);
  private readonly lp = new Biquad('lp', 4000, Q_BAND, FS);

  constructor(private readonly rng: Rng) {}

  // Unit RMS over a fixed calibration run, so the caller sets the level.
  next(): number {
    return this.raw() * PinkNoise.calibrate();
  }

  private raw(): number {
    const w = gauss(this.rng);
    const b = this.b;
    b[0] = 0.99886 * b[0] + w * 0.0555179;
    b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856;
    b[4] = 0.55 * b[4] + w * 0.5329522;
    b[5] = -0.7616 * b[5] - w * 0.016898;
    const pink = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11;
    b[6] = w * 0.115926;
    return this.lp.process(this.hp.process(pink));
  }

  private static calibrate(): number {
    if (PinkNoise.gain === 0) {
      const cal = new PinkNoise(createRng(0x5eed));
      const n = 1 << 16;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = cal.raw();
        sum += v * v;
      }
      PinkNoise.gain = 1 / Math.sqrt(sum / n);
    }
    return PinkNoise.gain;
  }
}

// Background recordings are loaded at run time from a file picker or local folder. They are never bundled and
// never read from data/. Not implemented yet.
export interface RecordingSource {
  readonly kind: 'recording';
  readonly name: string;
  readonly sampleRate: number;
  // Fills out with samples from `start`, looping at the end.
  read(start: number, out: Float64Array): void;
}
