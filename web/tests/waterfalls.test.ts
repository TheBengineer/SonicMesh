import { describe, expect, it } from 'vitest';
import { TILE_MIN_PX, tileGrid } from '../src/ui/waterfalls';

describe('waterfall strip layout', () => {
  it('is empty with no nodes', () => {
    expect(tileGrid(0, 800)).toEqual({ cols: 1, rows: 0 });
  });

  it('fits all 13 nodes in three rows at 800 px wide', () => {
    const { cols, rows } = tileGrid(13, 800);
    expect(cols).toBeGreaterThanOrEqual(5);
    expect(rows).toBeLessThanOrEqual(3);
    expect(cols * rows).toBeGreaterThanOrEqual(13);
  });

  it('gives more columns as the strip gets wider, and never more than there are tiles', () => {
    let last = 0;
    for (let w = 800; w <= 2400; w += 200) {
      const { cols } = tileGrid(13, w);
      expect(cols).toBeGreaterThanOrEqual(last);
      expect(cols).toBeLessThanOrEqual(13);
      last = cols;
    }
    expect(tileGrid(3, 2400).cols).toBe(3);
  });

  it('keeps every tile at least the minimum width', () => {
    for (const width of [300, 500, 800, 1200]) {
      const { cols } = tileGrid(13, width);
      if (cols > 1) expect((width - (cols - 1) * 8) / cols).toBeGreaterThanOrEqual(TILE_MIN_PX);
    }
  });

  it('keeps one column when the strip has no width yet', () => {
    expect(tileGrid(13, 0)).toEqual({ cols: 1, rows: 13 });
  });
});
