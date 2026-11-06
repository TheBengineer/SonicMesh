import { describe, expect, it } from 'vitest';
import { stickFromOffset } from '../src/ui/mobile';

describe('stickFromOffset', () => {
  it('reads up as positive y', () => {
    expect(stickFromOffset(0, -30, 60)).toEqual({ x: 0, y: 0.5 });
  });

  it('is zero near the centre', () => {
    expect(stickFromOffset(2, 2, 60)).toEqual({ x: 0, y: 0 });
  });

  it('keeps direction at full deflection beyond the rim', () => {
    const v = stickFromOffset(300, -300, 60);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(v.y);
  });

  it('is zero with no radius', () => {
    expect(stickFromOffset(10, 10, 0)).toEqual({ x: 0, y: 0 });
  });
});
