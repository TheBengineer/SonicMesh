import { FS, REF_PA } from './model';

// ASSUMED: a rifle-class shot, peak level at 1 m. Not measured. The ledger tags it.
export const SHOT_PEAK_DB_1M = 150;
// Crack: a short N-wave, positive then negative, decaying. Muzzle blast: a low damped tone that follows it.
const CRACK_S = 0.0015;
const CRACK_TAU_S = 0.0005;
const BLAST_DELAY_S = 0.002;
const BLAST_TAU_S = 0.025;
const BLAST_HZ = 90;
const BLAST_REL = 0.35;
export const SHOT_LEN_S = 0.15;

// One shot as pressure in Pa at 1 m, peak SHOT_PEAK_DB_1M. The crack is under-sampled at 16 kHz, so its shape is
// approximate. Its level and timing are what the nodes react to.
export function shotWave(): Float64Array {
  const n = Math.round(SHOT_LEN_S * FS);
  const out = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    let p = 0;
    if (t < CRACK_S) p += (1 - (2 * t) / CRACK_S) * Math.exp(-t / CRACK_TAU_S);
    if (t >= BLAST_DELAY_S) {
      const u = t - BLAST_DELAY_S;
      p += BLAST_REL * Math.exp(-u / BLAST_TAU_S) * Math.sin(2 * Math.PI * BLAST_HZ * u);
    }
    out[i] = p;
    peak = Math.max(peak, Math.abs(p));
  }
  const gain = (REF_PA * 10 ** (SHOT_PEAK_DB_1M / 20)) / peak;
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}
