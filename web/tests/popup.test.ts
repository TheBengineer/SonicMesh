import { describe, expect, it } from 'vitest';
import {
  WINDOW_MIN,
  clampRect,
  defaultRect,
  nearestEdgePoint,
  tailGeometry,
  tailPolygon,
  type Rect,
  type ScreenPos,
} from '../src/ui/popup';

const VIEW = { w: 800, h: 600 };
const WIN: Rect = { x: 100, y: 100, w: 300, h: 200 };

describe('pop-up window clamping', () => {
  it('leaves a window that is already inside unchanged', () => {
    expect(clampRect(WIN, VIEW)).toEqual(WIN);
  });

  it('pulls a window dragged off an edge back inside the view', () => {
    expect(clampRect({ ...WIN, x: -500, y: -40 }, VIEW)).toEqual({ ...WIN, x: 0, y: 0 });
    expect(clampRect({ ...WIN, x: 790, y: 590 }, VIEW)).toEqual({ ...WIN, x: 500, y: 400 });
  });

  it('never leaves the window fully off screen, even when it is larger than the view', () => {
    const r = clampRect({ x: 2000, y: 2000, w: 5000, h: 5000 }, VIEW);
    expect(r).toEqual({ x: 0, y: 0, w: VIEW.w, h: VIEW.h });
  });

  it('keeps the minimum size when a resize goes below it', () => {
    const r = clampRect({ x: 10, y: 10, w: 20, h: 20 }, VIEW);
    expect(r.w).toBe(WINDOW_MIN.w);
    expect(r.h).toBe(WINDOW_MIN.h);
  });

  it('shifts the window back in when a resize pushes it past the right or bottom edge', () => {
    const r = clampRect({ x: 600, y: 500, w: 300, h: 200 }, VIEW);
    expect(r.x + r.w).toBeLessThanOrEqual(VIEW.w);
    expect(r.y + r.h).toBeLessThanOrEqual(VIEW.h);
  });
});

describe('pop-up default position', () => {
  it('opens to the right of the object when there is room', () => {
    const anchor: ScreenPos = { x: 200, y: 300, visible: true };
    const r = defaultRect(anchor, VIEW, { w: 300, h: 200 });
    expect(r.x).toBeGreaterThan(anchor.x);
    expect(r.x).toBe(240);
  });

  it('opens to the left when the object is near the right edge', () => {
    const anchor: ScreenPos = { x: 760, y: 300, visible: true };
    const r = defaultRect(anchor, VIEW, { w: 300, h: 200 });
    expect(r.x + r.w).toBeLessThanOrEqual(anchor.x);
  });

  it('stays in the view when the object is off screen', () => {
    const r = defaultRect({ x: -4000, y: 9000, visible: false }, VIEW, { w: 300, h: 200 });
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(VIEW.h);
  });

  it('falls back to the top right corner with no object position', () => {
    const r = defaultRect(null, VIEW, { w: 300, h: 200 });
    expect(r.x + r.w).toBeLessThanOrEqual(VIEW.w);
    expect(r.y).toBeLessThan(40);
  });
});

describe('tail geometry', () => {
  it('starts at the nearest window edge and ends on the object', () => {
    const tail = tailGeometry(WIN, { x: 600, y: 200, visible: true }, VIEW);
    expect(tail).not.toBeNull();
    expect(tail?.from).toEqual({ x: 400, y: 200 });
    expect(tail?.to).toEqual({ x: 600, y: 200 });
    expect(tail?.onScreen).toBe(true);
  });

  it('picks the corner when the object is diagonal from the window', () => {
    expect(nearestEdgePoint(WIN, { x: 600, y: 600 })).toEqual({ x: 400, y: 300 });
    expect(nearestEdgePoint(WIN, { x: 0, y: 0 })).toEqual({ x: 100, y: 100 });
  });

  it('projects a point inside the window to its nearest side', () => {
    expect(nearestEdgePoint(WIN, { x: 110, y: 200 })).toEqual({ x: 100, y: 200 });
    expect(nearestEdgePoint(WIN, { x: 390, y: 290 })).toEqual({ x: 400, y: 290 });
  });

  it('draws nothing when the object is under the window', () => {
    expect(tailGeometry(WIN, { x: 200, y: 200, visible: true }, VIEW)).toBeNull();
  });

  it('stops at the view edge when the object is off screen to the left', () => {
    const tail = tailGeometry(WIN, { x: -1000, y: 200, visible: false }, VIEW);
    expect(tail).not.toBeNull();
    expect(tail?.onScreen).toBe(false);
    expect(tail?.from).toEqual({ x: 100, y: 200 });
    expect(tail?.to.x).toBeCloseTo(0, 6);
    expect(tail?.to.y).toBeCloseTo(200, 6);
  });

  it('stops at the view edge along the line to an object off the top right', () => {
    // From the window's top right corner towards (1400, -400): the segment leaves the view through the top edge.
    const tail = tailGeometry(WIN, { x: 1400, y: -400, visible: false }, VIEW);
    expect(tail).not.toBeNull();
    expect(tail?.to.y).toBeCloseTo(0, 6);
    expect(tail?.to.x).toBeGreaterThan(400);
    expect(tail?.to.x).toBeLessThanOrEqual(VIEW.w);
  });

  it('returns null for a position that is not finite', () => {
    expect(tailGeometry(WIN, { x: Number.NaN, y: 0, visible: false }, VIEW)).toBeNull();
  });
});

describe('tail polygon', () => {
  it('is empty for a zero-length tail', () => {
    expect(tailPolygon({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, onScreen: true })).toBe('');
  });

  it('has three points, wide at the window and a point at the object', () => {
    const poly = tailPolygon({ from: { x: 400, y: 200 }, to: { x: 600, y: 200 }, onScreen: true }, 10);
    const pts = poly.split(' ').map((p) => p.split(',').map(Number));
    expect(pts).toHaveLength(3);
    expect(pts[2]).toEqual([600, 200]);
    expect(pts[0][0]).toBeCloseTo(400, 6);
    expect(Math.abs(pts[0][1] - pts[1][1])).toBeCloseTo(10, 6);
  });
});
