import { describe, expect, it } from 'vitest';
import {
  COMB_LOCK,
  combScore,
  combVerdict,
  droneSpectrum,
  gateAt,
  gateEverOn,
  pairAlert,
  pitchesMatch,
  windSpectrum,
  type Segment,
} from '../src/ui/howItWorks';

describe('comb sketch', () => {
  const drone = droneSpectrum(340);

  it('locks at the true pitch', () => {
    const score = combScore(340, drone);
    expect(score).toBeGreaterThan(COMB_LOCK);
    expect(combVerdict(340, 340, score)).toBe('lock');
  });

  it('calls a multiple of the pitch a harmonic', () => {
    expect(combVerdict(680, 340, combScore(680, drone))).toBe('harmonic');
  });

  it('does not lock between the peaks', () => {
    for (const f of [150, 190, 250, 420, 500, 900]) {
      expect(combVerdict(f, 340, combScore(f, drone))).toBe('none');
    }
  });

  it('scores wind low at every pitch, though it is louder', () => {
    expect(windSpectrum(340)).toBeGreaterThan(droneSpectrum(340)(500));
    for (let f = 120; f <= 1200; f *= 1.05) expect(combScore(f, windSpectrum)).toBeLessThan(COMB_LOCK);
  });
});

describe('age gate sketch', () => {
  const broken: Segment[] = [[0, 0.4], [0.6, 1]];

  it('goes on only after the required age', () => {
    expect(gateAt([[0, 5]], 2, 1).state).toBe('arming');
    expect(gateAt([[0, 5]], 2, 2.5).state).toBe('detecting');
    expect(gateAt([[0, 5]], 2, 6).state).toBe('quiet');
  });

  it('restarts the age when a track breaks', () => {
    expect(gateAt(broken, 2, 0.8).ageS).toBeCloseTo(0.2);
    expect(gateEverOn(broken, 2)).toBe(false);
    expect(gateEverOn(broken, 0)).toBe(true);
  });
});

describe('gateway rule sketch', () => {
  it('needs two adjacent nodes', () => {
    expect(pairAlert([{ node: 3, t: 0, hz: 600 }])).toBeNull();
    expect(pairAlert([{ node: 1, t: 0, hz: 600 }, { node: 3, t: 1, hz: 600 }])).toBeNull();
    expect(pairAlert([{ node: 2, t: 0, hz: 600 }, { node: 3, t: 15, hz: 610 }])).not.toBeNull();
  });

  it('needs them inside the window', () => {
    expect(pairAlert([{ node: 2, t: 0, hz: 600 }, { node: 3, t: 31, hz: 600 }])).toBeNull();
  });

  it('needs one pitch or an octave', () => {
    expect(pitchesMatch(600, 1200)).toBe(true);
    expect(pitchesMatch(2100, 1400)).toBe(false);
    expect(pairAlert([{ node: 2, t: 0, hz: 2100 }, { node: 3, t: 0, hz: 1400 }])).toBeNull();
  });
});
