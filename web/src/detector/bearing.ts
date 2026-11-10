// Direction of a harmonic source from a small mic array, from the audio alone. The pitch comes from the comb detector, so
// the search only listens at that source's harmonics and a second source at another pitch mostly stays out of it. For
// each direction on a grid it lines the mics up as a plane wave from there would arrive, and takes the direction where
// they add up the most: delay and sum, per harmonic.
import { fft, hann } from '../acoustics/dsp';
import { FS, SOUND_SPEED_MPS } from '../acoustics/model';

export const BEARING_SAMPLES = 4096;
// Above this the 12 cm mic spacing is over half a wavelength, and directions alias.
const MAX_HZ = 1400;
const AZ_STEP_DEG = 2;
const EL_STEPS_DEG = [0, 10, 20, 30, 40, 50, 60];
const PEAK_TOL = 0.015;

const WINDOW = hann(BEARING_SAMPLES);
const BIN_HZ = FS / BEARING_SAMPLES;

export interface BearingResult {
  azDeg: number;
  elDeg: number;
}

// frames holds BEARING_SAMPLES of each mic, and offsets each mic's position in metres from the array centre (x, y). The
// mics share a height, so elevation is weakly seen. Null when no harmonic of the pitch is in range.
export function estimateBearing(frames: ArrayLike<number>[], offsets: readonly (readonly [number, number])[], f0Hz: number): BearingResult | null {
  if (f0Hz <= 0) return null;
  const spectra = frames.map((x) => {
    const re = new Float64Array(BEARING_SAMPLES);
    const im = new Float64Array(BEARING_SAMPLES);
    for (let i = 0; i < BEARING_SAMPLES; i++) re[i] = x[i] * WINDOW[i];
    fft(re, im);
    return { re, im };
  });

  // The strongest bin near each harmonic, since Doppler and rotor speed move it. A pitch above MAX_HZ keeps its fundamental.
  const bins: number[] = [];
  for (let h = 1; h === 1 || h * f0Hz <= MAX_HZ; h++) {
    const f = h * f0Hz;
    const lo = Math.max(1, Math.floor((f * (1 - PEAK_TOL)) / BIN_HZ));
    const hi = Math.min(BEARING_SAMPLES / 2 - 1, Math.ceil((f * (1 + PEAK_TOL)) / BIN_HZ));
    let best = -1;
    let bestPower = -1;
    for (let k = lo; k <= hi; k++) {
      let p = 0;
      for (const s of spectra) p += s.re[k] * s.re[k] + s.im[k] * s.im[k];
      if (p > bestPower) {
        bestPower = p;
        best = k;
      }
    }
    if (best >= 0 && !bins.includes(best)) bins.push(best);
  }
  if (bins.length === 0) return null;

  let bestPower = -1;
  let bestAz = 0;
  let bestEl = 0;
  for (const elDeg of EL_STEPS_DEG) {
    const cosEl = Math.cos((elDeg * Math.PI) / 180);
    for (let azDeg = 0; azDeg < 360; azDeg += AZ_STEP_DEG) {
      const az = (azDeg * Math.PI) / 180;
      const [ux, uy] = [Math.sin(az) * cosEl, Math.cos(az) * cosEl];
      let power = 0;
      for (const k of bins) {
        const w = (2 * Math.PI * k * BIN_HZ) / SOUND_SPEED_MPS;
        let sumRe = 0;
        let sumIm = 0;
        spectra.forEach((s, m) => {
          // A mic further towards the source hears it earlier: undo that phase lead.
          const phase = -w * (offsets[m][0] * ux + offsets[m][1] * uy);
          const [c, d] = [Math.cos(phase), Math.sin(phase)];
          sumRe += s.re[k] * c - s.im[k] * d;
          sumIm += s.re[k] * d + s.im[k] * c;
        });
        power += sumRe * sumRe + sumIm * sumIm;
      }
      if (power > bestPower) {
        bestPower = power;
        bestAz = azDeg;
        bestEl = elDeg;
      }
    }
  }
  return { azDeg: bestAz, elDeg: bestEl };
}

// A shot is broadband, with no pitch to follow, so its bearing uses every bin from SHOT_LO_HZ to MAX_HZ over a short
// window from the onset. The window is short so the reverb tail is left out; the crack and muzzle blast carry the timing.
export const SHOT_BEARING_SAMPLES = 512;
const SHOT_LO_HZ = 150;
const SHOT_BIN_HZ = FS / SHOT_BEARING_SAMPLES;
const SHOT_WINDOW = hann(SHOT_BEARING_SAMPLES);

// The bearing of a shot's onset in degrees, measured clockwise from +y, in the horizontal plane. Null when no bin is in range.
export function estimateShotBearing(frames: ArrayLike<number>[], offsets: readonly (readonly [number, number])[]): number | null {
  const spectra = frames.map((x) => {
    const re = new Float64Array(SHOT_BEARING_SAMPLES);
    const im = new Float64Array(SHOT_BEARING_SAMPLES);
    for (let i = 0; i < SHOT_BEARING_SAMPLES; i++) re[i] = x[i] * SHOT_WINDOW[i];
    fft(re, im);
    return { re, im };
  });
  const bins: number[] = [];
  for (let k = Math.ceil(SHOT_LO_HZ / SHOT_BIN_HZ); k * SHOT_BIN_HZ <= MAX_HZ; k++) bins.push(k);
  if (bins.length === 0) return null;

  let bestPower = -1;
  let bestAz = 0;
  for (let azDeg = 0; azDeg < 360; azDeg += AZ_STEP_DEG) {
    const az = (azDeg * Math.PI) / 180;
    const [ux, uy] = [Math.sin(az), Math.cos(az)];
    let power = 0;
    for (const k of bins) {
      const w = (2 * Math.PI * k * SHOT_BIN_HZ) / SOUND_SPEED_MPS;
      let sumRe = 0;
      let sumIm = 0;
      spectra.forEach((s, m) => {
        const phase = -w * (offsets[m][0] * ux + offsets[m][1] * uy);
        const [c, d] = [Math.cos(phase), Math.sin(phase)];
        sumRe += s.re[k] * c - s.im[k] * d;
        sumIm += s.re[k] * d + s.im[k] * c;
      });
      power += sumRe * sumRe + sumIm * sumIm;
    }
    if (power > bestPower) {
      bestPower = power;
      bestAz = azDeg;
    }
  }
  return bestAz;
}

// How many recent estimates a node compares, and how far they may disagree before it stops claiming a direction.
const TRACK_LEN = 4;
const TRACK_MIN = 2;
export const MAX_SPREAD_DEG = 15;

// A node's recent bearings. Their circular mean is the bearing it reports, and their spread is how sure it is, which
// needs no truth: far or quiet sources scatter from one estimate to the next.
export class BearingTrack {
  private readonly az: number[] = [];

  push(azDeg: number): void {
    this.az.push(azDeg);
    if (this.az.length > TRACK_LEN) this.az.shift();
  }

  reset(): void {
    this.az.length = 0;
  }

  private resultant(): { x: number; y: number; r: number } {
    let x = 0;
    let y = 0;
    for (const a of this.az) {
      x += Math.sin((a * Math.PI) / 180);
      y += Math.cos((a * Math.PI) / 180);
    }
    return { x, y, r: Math.hypot(x, y) / Math.max(this.az.length, 1) };
  }

  // Circular standard deviation in degrees, or null with too few estimates.
  get spreadDeg(): number | null {
    if (this.az.length < TRACK_MIN) return null;
    return (Math.sqrt(-2 * Math.log(Math.max(this.resultant().r, 1e-6))) * 180) / Math.PI;
  }

  // The bearing, or null while the estimates are too few or disagree.
  get bearingDeg(): number | null {
    const spread = this.spreadDeg;
    if (spread === null || spread > MAX_SPREAD_DEG) return null;
    const { x, y } = this.resultant();
    return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  }
}
