import { describe, expect, it } from 'vitest';
import { groundColor, hillshade, Terrain } from '../src/sim/terrain';

const params = { size_m: [2000, 1400] as [number, number], amplitude_m: 40, wavelength_m: 220, road_y_m: 90 };

describe('terrain shading', () => {
  it('leaves flat ground at full colour', () => {
    const flat = new Terrain(1, { ...params, amplitude_m: 0 });
    expect(hillshade(flat, 100, 100)).toBeCloseTo(1, 6);
  });

  it('lights slopes facing the sun and darkens those facing away', () => {
    const t = new Terrain(1, params);
    const shades: number[] = [];
    for (let x = -900; x <= 900; x += 30) for (let y = -600; y <= 600; y += 30) shades.push(hillshade(t, x, y));
    expect(Math.min(...shades)).toBeLessThan(0.7);
    expect(Math.max(...shades)).toBeGreaterThan(1.3);
  });

  it('gives colours a canvas or mesh can use', () => {
    const t = new Terrain(1, params);
    for (const c of groundColor(t, 50, 50)) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(1);
    }
  });
});
