import { describe, expect, it } from 'vitest';
import { CombDetector, type CombParams } from '../src/detector/comb';
import fixture from './fixtures/comb_parity.json';

const FS = 16_000;
const SECONDS = fixture.seconds;
const AMBIENT_PA = 20e-6 * 10 ** (40 / 20);

// The same signals as sim/detector/make_web_fixture.py.
function noise(n: number, seed: number): Float64Array {
  const out = new Float64Array(n);
  let state = seed;
  let y = 0;
  for (let i = 0; i < n; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    y = 0.9 * y + (state / 2 ** 32 - 0.5);
    out[i] = y * AMBIENT_PA * 6;
  }
  return out;
}

function addHarmonics(x: Float64Array, f0: number, amp: number, count: number, drift = 0, gain: (t: number) => number = () => 1): void {
  for (let i = 0; i < x.length; i++) {
    const t = i / FS;
    if (t < 2 || t >= 12) continue;
    const phase = 2 * Math.PI * f0 * (t + (drift * t * t) / (2 * SECONDS));
    let v = 0;
    for (let k = 1; k <= count; k++) v += (Math.SQRT2 * amp * Math.sin(k * phase)) / k;
    x[i] += v * gain(t);
  }
}

function signal(name: string): Float32Array {
  const n = SECONDS * FS;
  const x = noise(n, 12345);
  if (name === 'drone_250') addHarmonics(x, 250, AMBIENT_PA * 2, 8, 0.02);
  if (name === 'drone_100_weak') addHarmonics(x, 100, AMBIENT_PA * 0.6, 12);
  if (name === 'drone_600_fading') addHarmonics(x, 600, AMBIENT_PA * 1.5, 5, 0, (t) => 1 - t / SECONDS);
  if (name === 'vehicle_broadband') {
    for (let i = 0; i < n; i++) x[i] *= 1 + 9 * Math.exp(-(((i / FS - 7) / 3) ** 2));
  }
  if (name === 'clicks') {
    for (let start = 2 * FS; start < 12 * FS; start += 11200) {
      for (let j = 0; j < 40; j++) x[start + j] += AMBIENT_PA * 40 * Math.exp(-j / 8);
    }
  }
  return Float32Array.from(x);
}

// Python names to the port's.
function params(p: Record<string, number>): Partial<CombParams> {
  return {
    ...(p.n_fft !== undefined && { nFft: p.n_fft }),
    ...(p.hop !== undefined && { hop: p.hop }),
    ...(p.floor_up_db !== undefined && { floorUpDb: p.floor_up_db }),
    ...(p.gate_harm !== undefined && { gateHarm: p.gate_harm }),
    ...(p.gap_frames !== undefined && { gapFrames: p.gap_frames }),
    ...(p.gap_harm !== undefined && { gapHarm: p.gap_harm }),
    ...(p.sub_guard !== undefined && { subGuard: Boolean(p.sub_guard) }),
    ...(p.init_env_bins !== undefined && { initEnvBins: p.init_env_bins }),
    ...(p.hold_ratio !== undefined && { holdRatio: p.hold_ratio }),
  };
}

function run(x: Float32Array, d: CombDetector, each: (frame: number) => void): void {
  let frame = 0;
  for (let start = 0; start + d.nFft <= x.length; start += d.hop) {
    d.step(x.subarray(start, start + d.nFft));
    each(frame++);
  }
}

describe('comb detector port', () => {
  for (const c of fixture.cases) {
    it(`matches detector.py frame by frame: ${c.signal} ${JSON.stringify(c.params)}`, () => {
      const d = new CombDetector(params(c.params as Record<string, number>));
      let frames = 0;
      run(signal(c.signal), d, (i) => {
        frames++;
        const at = `frame ${i}`;
        expect(d.q, at).toBe(c.q[i]);
        expect(d.index, at).toBe(c.index[i]);
        expect(d.on ? 1 : 0, at).toBe(c.on[i]);
        expect(Math.abs(d.f0Hz - c.f0[i]), at).toBeLessThan(1e-3);
        expect(Math.abs(d.score - c.score[i]), at).toBeLessThan(1e-3);
        if (c.floor[i] !== 0) {
          expect(Math.abs(d.bandDb - c.band[i]), at).toBeLessThan(1e-2);
          expect(Math.abs(d.floorDb - c.floor[i]), at).toBeLessThan(1e-2);
          expect(Math.abs(d.peak - c.peak[i]), at).toBeLessThan(1e-3);
        }
      });
      expect(frames).toBe(c.on.length);
    }, 60_000);
  }

  const onFrames = (name: string): number => fixture.cases.filter((c) => c.signal === name && Object.keys(c.params).length === 0)[0].on.reduce((a, b) => a + b, 0);

  it('switches on for a harmonic source and not for loudness alone', () => {
    expect(onFrames('drone_600_fading')).toBeGreaterThan(0);
    expect(onFrames('noise')).toBe(0);
    expect(onFrames('vehicle_broadband')).toBe(0);
    expect(onFrames('clicks')).toBe(0);
  });
});
