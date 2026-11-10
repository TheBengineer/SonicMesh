import { createRng, nextFloat, type Rng } from '../sim/rng';
import { Biquad, gauss } from './dsp';
import { FS, REF_PA } from './model';

// ASSUMED: a rifle-class shot, peak level at 1 m. The recordings fix the shape and decay, not this level, which is not
// measured. The ledger tags it.
export const SHOT_PEAK_DB_1M = 130;
// Long enough for the tail to fall about 60 dB below its peak (rt60 about 2.2 s). A shorter shot is cut off while it
// still rings, and the cut is an audible click.
export const SHOT_LEN_S = 2.4;

// Fitted offline to 26 shots from four recordings (see data/gunshots, local only): the envelope, the decay
// (t30 about 0.61 s in the recordings) and the band balance (low and high about 7 dB under the mid band). The
// fit sits near the edge of its search grid for the tail, so treat these as a fit, not a physical measurement.
export const SHOT_FIT = {
  crackS: 0.0006,
  crackTauS: 0.0005,
  tailRel: 0.9,
  // The tail fades in over this long, so the crack is the only event: no separate knock after it.
  tailAttackS: 0.03,
  tailRt60S: 2.2,
  tailLoHz: 300,
  tailHiHz: 5000,
};

// Shot-to-shot variation, as a fraction of the fitted value, so no two shots from one gun sound the same.
const VARY = { rt60: 0.2, gainDb: 3 };
const Q_BAND = Math.SQRT1_2;

// One shot as pressure in Pa at 1 m, with the nominal crack peak at SHOT_PEAK_DB_1M. The crack is under-sampled at
// 16 kHz, so its shape is approximate.
//   crack: a short N-wave, positive then negative, decaying. The one event a shot makes.
//   tail: band-limited noise with an exponential decay that fades in, a stand-in for the reverberant field around the shooter.
// The muzzle blast and the bullet's shockwave are not modelled separately.
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
    const attack = Math.min(1, t / f.tailAttackS);
    p += f.tailRel * attack * lp.process(hp.process(gauss(rng))) * Math.exp((-6.9 * t) / rt60);
    out[i] = gain * p;
  }
  return out;
}

// The shot's seed: the same shot of the same shooter in the same scenario always sounds the same.
export function shotRng(seed: number, shooterId: number, shotIndex: number): Rng {
  return createRng((seed ^ Math.imul(shooterId + 1, 0x2545f491) ^ Math.imul(shotIndex + 1, 0x9e3779b1)) >>> 0);
}
