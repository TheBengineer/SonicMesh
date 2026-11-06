import { describe, expect, it } from 'vitest';
import { BogieTracker, groupReports, samePitch, type BogieReport } from '../src/lora/bogies';
import { areaEdge, type BogieArea } from '../src/lora/locate';

const report = (id: number, x: number, pitchHz: number, bearingDeg: number | null = null, peak = 0.2): BogieReport => ({ id, x, y: 0, pitchHz, bearingDeg, peak });

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

describe('estimated area', () => {
  // Scores for a source at (x, y): strength / distance, with the height the fit assumes.
  const heard = (nodes: [number, number, number, (number | null)?][], x: number, y: number, strength = 40): BogieReport[] =>
    nodes.map(([id, nx, ny, bearing]) => ({ id, x: nx, y: ny, pitchHz: 600, bearingDeg: bearing ?? null, peak: strength / Math.hypot(nx - x, ny - y, 50) }));
  const settle = (reports: BogieReport[]) => {
    const t = new BogieTracker();
    let last = t.update(0, reports);
    for (let i = 1; i <= 12; i++) last = t.update(i * 0.25, reports);
    return last[0].area!;
  };
  const staggered: [number, number, number][] = [
    [1, -240, 30],
    [2, -120, -30],
    [3, 0, 30],
    [4, 120, -30],
    [5, 240, 30],
  ];

  it('places a source from single mics alone, without being told its strength', () => {
    for (const strength of [25, 40, 70]) {
      const a = settle(heard(staggered, 60, 90, strength));
      expect(Math.hypot(a.x - 60, a.y - 90), `strength ${strength}`).toBeLessThan(50);
    }
  });

  it('draws a wider area across the line when nodes sit in a straight line, as they cannot tell its sides apart', () => {
    const straight = staggered.map(([id, x]): [number, number, number] => [id, x, 0]);
    const a = settle(heard(straight, 60, 90));
    expect(Math.abs(a.y)).toBeLessThan(40);
    expect(a.minorM + a.majorM).toBeGreaterThan(settle(heard(staggered, 60, 90)).minorM + settle(heard(staggered, 60, 90)).majorM);
  });

  it('settles the side from an array bearing', () => {
    const straight = staggered.map(([id, x]): [number, number, number, number | null] => [id, x, 0, id === 3 ? (Math.atan2(60, 90) * 180) / Math.PI : null]);
    const a = settle(heard(straight, 60, 90));
    expect(a.y).toBeGreaterThan(40);
  });

  it('gives no area for one faint node, and lines only from nodes that count', () => {
    const t = new BogieTracker();
    expect(t.update(0, [report(1, 0, 600, null, 0.2)])[0].area).toBeNull();
    expect(t.update(1, [report(1, 0, 600, null, 0.07), report(2, 120, 600, null, 0.07)])[0].area).toBeNull();
    const a = t.update(2, [report(1, 0, 600, null, 0.3), report(2, 120, 600, null, 0.3), report(3, 240, 600, null, 0.07)])[0].area!;
    expect(a.nodeIds).toEqual([1, 2]);
  });

  it('ends a line on the edge of the area, and draws none from inside it', () => {
    const area: BogieArea = { x: 0, y: 0, majorM: 100, minorM: 50, angleRad: Math.PI / 2, nodeIds: [] };
    expect(areaEdge(area, 0, 300)).toEqual({ x: 0, y: 100 });
    const side = areaEdge(area, 200, 0)!;
    expect(side.x).toBeCloseTo(50, 6);
    expect(areaEdge(area, 10, 10)).toBeNull();
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
});
