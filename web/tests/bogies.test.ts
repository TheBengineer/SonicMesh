import { describe, expect, it } from 'vitest';
import { BogieTracker, crossing, groupReports, samePitch, type BogieReport } from '../src/lora/bogies';

const report = (id: number, x: number, pitchHz: number, bearingDeg: number | null = null): BogieReport => ({ id, x, y: 0, pitchHz, bearingDeg, bearingSigmaDeg: bearingDeg === null ? null : 5 });

describe('pitch matching', () => {
  it('takes equal pitches and low multiples, with room for Doppler', () => {
    expect(samePitch(562, 626)).toBe(true);
    expect(samePitch(600, 150)).toBe(true);
    expect(samePitch(100, 300)).toBe(true);
  });

  it('keeps unrelated pitches apart', () => {
    expect(samePitch(600, 250)).toBe(false);
    expect(samePitch(600, 100)).toBe(false);
  });
});

describe('grouping', () => {
  it('joins neighbours with a matching pitch', () => {
    expect(groupReports([report(1, 0, 600), report(2, 120, 610), report(3, 240, 590)])).toHaveLength(1);
  });

  it('splits on pitch at neighbouring nodes', () => {
    expect(groupReports([report(1, 0, 600), report(2, 120, 250)])).toHaveLength(2);
  });

  it('splits on distance at the same pitch', () => {
    expect(groupReports([report(1, 0, 600), report(2, 1000, 600)])).toHaveLength(2);
  });
});

describe('bearing crossing', () => {
  it('finds the point two arrows meet', () => {
    const f = crossing(report(1, -100, 600, 45), report(2, 100, 600, 315))!;
    expect(f.x).toBeCloseTo(0, 6);
    expect(f.y).toBeCloseTo(100, 6);
  });

  it('gives a wider marker for a shallow crossing', () => {
    const steep = crossing(report(1, -100, 600, 45), report(2, 100, 600, 315))!;
    const shallow = crossing(report(1, -100, 600, 10), report(2, 100, 600, 350))!;
    expect(shallow.radiusM).toBeGreaterThan(steep.radiusM);
  });

  it('gives a wider marker for less certain bearings', () => {
    const sure = crossing(report(1, -100, 600, 45), report(2, 100, 600, 315))!;
    const unsure = crossing({ ...report(1, -100, 600, 45), bearingSigmaDeg: 14 }, report(2, 100, 600, 315))!;
    expect(unsure.radiusM).toBeGreaterThan(sure.radiusM);
  });

  it('gives none for arrows that diverge, run parallel, or lack a bearing', () => {
    expect(crossing(report(1, -100, 600, 315), report(2, 100, 600, 45))).toBeNull();
    expect(crossing(report(1, -100, 600, 10), report(2, 100, 600, 10))).toBeNull();
    expect(crossing(report(1, -100, 600), report(2, 100, 600, 315))).toBeNull();
  });
});

describe('bogie letters', () => {
  it('keeps a letter as the group moves along the line', () => {
    const t = new BogieTracker();
    expect(t.update(0, [report(1, 0, 600), report(2, 120, 600)])[0].letter).toBe('A');
    expect(t.update(1, [report(2, 120, 600), report(3, 240, 600)])[0].letter).toBe('A');
    expect(t.update(2, [report(4, 360, 600)])[0].letter).toBe('A');
  });

  it('gives a second pitch its own letter', () => {
    const t = new BogieTracker();
    const out = t.update(0, [report(1, 0, 600), report(2, 120, 600), report(3, 240, 250)]);
    expect(out.map((b) => [b.letter, b.nodeIds])).toEqual([
      ['A', [1, 2]],
      ['B', [3]],
    ]);
  });

  it('holds a letter through a short gap, and frees it after a long one', () => {
    const t = new BogieTracker();
    t.update(0, [report(1, 0, 600)]);
    t.update(1, []);
    expect(t.update(2, [report(1, 0, 600)])[0].letter).toBe('A');
    // A held letter is not given to a different pitch.
    expect(t.update(3, [report(5, 2000, 250)])[0].letter).toBe('B');
    expect(t.update(10, [report(5, 2000, 400)])[0].letter).toBe('A');
  });

  it('names a pitch a node actually reported, even with a sub-harmonic in the group', () => {
    const t = new BogieTracker();
    expect(t.update(0, [report(1, 0, 558), report(2, 120, 157)])[0].pitchHz).toBe(558);
  });

  it('reports a crossing only with two arrays in the group', () => {
    const t = new BogieTracker();
    expect(t.update(0, [report(1, -100, 600, 45), report(2, 100, 600)])[0].fix).toBeNull();
    const fix = t.update(1, [report(1, -100, 600, 45), report(2, 100, 600, 315)])[0].fix!;
    expect(fix.y).toBeCloseTo(100, 6);
  });
});
