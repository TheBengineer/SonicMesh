import { describe, expect, it } from 'vitest';
import { ARRAY_OFFSETS } from '../src/acoustics/engine';
import { ARRAY_HALF_M, FS, SOUND_SPEED_MPS } from '../src/acoustics/model';
import { BEARING_SAMPLES, BearingTrack, MAX_SPREAD_DEG, estimateBearing } from '../src/detector/bearing';

const OFFSETS = ARRAY_OFFSETS.map(([a, b]) => [a * ARRAY_HALF_M, b * ARRAY_HALF_M] as const);

// A harmonic plane wave from azimuth az on each mic, with independent noise from a small LCG.
function sources(list: { azDeg: number; f0: number; amp: number }[], noise = 0.05): Float64Array[] {
  let state = 77;
  return OFFSETS.map(([x, y]) => {
    const out = new Float64Array(BEARING_SAMPLES);
    for (let i = 0; i < BEARING_SAMPLES; i++) {
      let v = 0;
      for (const s of list) {
        const a = (s.azDeg * Math.PI) / 180;
        const lead = (x * Math.sin(a) + y * Math.cos(a)) / SOUND_SPEED_MPS;
        for (let h = 1; h <= 4; h++) v += (s.amp / h) * Math.sin(2 * Math.PI * h * s.f0 * (i / FS + lead));
      }
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = v + noise * (state / 2 ** 32 - 0.5);
    }
    return out;
  });
}

const angleError = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('bearing from four mics', () => {
  for (const azDeg of [0, 45, 90, 170, 200, 290, 359]) {
    it(`finds a source at ${azDeg} degrees`, () => {
      const b = estimateBearing(sources([{ azDeg, f0: 600, amp: 1 }]), OFFSETS, 600)!;
      expect(angleError(b.azDeg, azDeg)).toBeLessThanOrEqual(4);
    });
  }

  it('works at a low pitch, from its harmonics', () => {
    const b = estimateBearing(sources([{ azDeg: 130, f0: 250, amp: 1 }]), OFFSETS, 250)!;
    expect(angleError(b.azDeg, 130)).toBeLessThanOrEqual(6);
  });

  it('listens at the given pitch when two sources sound together', () => {
    const both = sources([
      { azDeg: 60, f0: 600, amp: 1 },
      { azDeg: 250, f0: 410, amp: 1 },
    ]);
    expect(angleError(estimateBearing(both, OFFSETS, 600)!.azDeg, 60)).toBeLessThanOrEqual(6);
    expect(angleError(estimateBearing(both, OFFSETS, 410)!.azDeg, 250)).toBeLessThanOrEqual(6);
  });

  it('gives nothing with no pitch', () => {
    expect(estimateBearing(sources([]), OFFSETS, 0)).toBeNull();
  });
});

describe('bearing track', () => {
  it('needs two estimates', () => {
    const t = new BearingTrack();
    t.push(90);
    expect(t.bearingDeg).toBeNull();
    t.push(94);
    expect(t.bearingDeg).toBeCloseTo(92, 3);
  });

  it('averages across north', () => {
    const t = new BearingTrack();
    t.push(358);
    t.push(4);
    expect(angleError(t.bearingDeg!, 1)).toBeLessThan(0.01);
  });

  it('claims no direction while estimates disagree', () => {
    const t = new BearingTrack();
    t.push(10);
    t.push(100);
    expect(t.spreadDeg!).toBeGreaterThan(MAX_SPREAD_DEG);
    expect(t.bearingDeg).toBeNull();
  });

  it('forgets old estimates and can reset', () => {
    const t = new BearingTrack();
    for (const a of [10, 100, 50, 52, 50, 51]) t.push(a);
    expect(angleError(t.bearingDeg!, 51)).toBeLessThan(2);
    t.reset();
    expect(t.bearingDeg).toBeNull();
  });
});
