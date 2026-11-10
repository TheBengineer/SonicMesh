import { createRng, nextFloat, type Rng } from '../sim/rng';
import { Biquad, gauss } from './dsp';
import { FS, REF_PA } from './model';

// ASSUMED: a rifle-class shot, peak level at 1 m. The recordings fix the shape and decay, not this level, which is not
// measured. The ledger tags it.
export const SHOT_PEAK_DB_1M = 130;
export const SHOT_LEN_S = 0.8;

// Fitted offline to 26 shots from four recordings (see data/gunshots, local only): the envelope, the decay
// (t30 about 0.61 s in the recordings) and the band balance (low and high about 7 dB under the mid band). The
// fit sits near the edge of its search grid for the tail, so treat these as a fit, not a physical measurement.
export const SHOT_FIT = {
  crackS: 0.0006,
  crackTauS: 0.0005,
  blastDelayS: 0.002,
  blastTauS: 0.02,
  blastHz: 90,
  blastRel: 0.3,
  tailRel: 0.9,
  tailRt60S: 2.2,
  tailLoHz: 300,
  tailHiHz: 5000,
};

// Shot-to-shot variation, as a fraction of the fitted value, so no two shots from one gun sound the same.
const VARY = { blastHz: 0.15, blastRel: 0.3, rt60: 0.2, gainDb: 3 };
const Q_BAND = Math.SQRT1_2;

// One shot as pressure in Pa at 1 m, with the nominal crack peak at SHOT_PEAK_DB_1M. The crack is under-sampled at
// 16 kHz, so its shape is approximate.
//   crack: a short N-wave, positive then negative, decaying.
//   muzzle blast: a low damped tone that follows the crack, with its pitch and level varied per shot.
//   tail: band-limited noise with an exponential decay, a stand-in for the reverberant field around the shooter.
// Typical peak of a shot with its reverb tail, so SHOT_PEAK_DB_1M is the level a shot reaches, not just its crack.
const TAIL_PEAK = (() => {
  let sum = 0;
  for (let k = 0; k < 16; k++) sum += peakOf(renderUnit(createRng(0x51a7 + k)));
  return sum / 16;
})();

function peakOf(w: Float64Array): number {
  let p = 0;
  for (const v of w) p = Math.max(p, Math.abs(v));
  return p;
}

export function renderShot(rng: Rng): Float64Array {
  return renderUnit(rng, (REF_PA * 10 ** (SHOT_PEAK_DB_1M / 20)) / TAIL_PEAK);
}

function renderUnit(rng: Rng, scale = 1): Float64Array {
  const f = SHOT_FIT;
  const r = () => 2 * nextFloat(rng) - 1;
  const blastHz = f.blastHz * (1 + VARY.blastHz * r());
  const blastRel = f.blastRel * (1 + VARY.blastRel * r());
  const rt60 = f.tailRt60S * (1 + VARY.rt60 * r());
  const gain = scale * 10 ** ((VARY.gainDb * r()) / 20);
  const n = Math.round(SHOT_LEN_S * FS);
  const out = new Float64Array(n);
  const hp = new Biquad('hp', f.tailLoHz, Q_BAND, FS);
  const lp = new Biquad('lp', f.tailHiHz, Q_BAND, FS);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    let p = 0;
    if (t < f.crackS) p += (1 - (2 * t) / f.crackS) * Math.exp(-t / f.crackTauS);
    if (t >= f.blastDelayS) {
      const v = t - f.blastDelayS;
      p += blastRel * Math.exp(-v / f.blastTauS) * Math.sin(2 * Math.PI * blastHz * v);
    }
    p += f.tailRel * lp.process(hp.process(gauss(rng))) * Math.exp((-6.9 * t) / rt60);
    out[i] = gain * p;
  }
  return out;
}

// The shot's seed: the same shot of the same shooter in the same scenario always sounds the same.
export function shotRng(seed: number, shooterId: number, shotIndex: number): Rng {
  return createRng((seed ^ Math.imul(shooterId + 1, 0x2545f491) ^ Math.imul(shotIndex + 1, 0x9e3779b1)) >>> 0);
}
