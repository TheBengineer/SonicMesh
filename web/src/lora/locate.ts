// Where a bogie could be, from what its nodes report. A node's comb score falls about as 1/distance while the source is
// above the score's floor, and it only counts that source's harmonics, so ratios of scores between nodes constrain the
// position with no shared clock. The source's own strength is unknown, so the fit sums over a range of strengths. Array
// bearings multiply in. Each bogie keeps its result as a map over a grid, carried from one update to the next.
const FLOOR = 0.06;
// The score spread a node's median shows around 1/distance, in natural log units.
const SCORE_SIGMA = 0.45;
const BEARING_SIGMA_DEG = 10;
// Assumed height of the source above a node. It only matters close in.
const HEIGHT_M = 50;
// Scores times metres, wide enough for the drone classes in the demo.
const STRENGTHS = [15, 22, 32, 45, 65, 90].map(Math.log);
const MIN_CELL_M = 25;
const MAX_CELLS = 5000;
// How far a bogie's map spreads between updates. Well above flying speed, so that old measurements fade.
const SPREAD_M = 25;
// Successive updates share their errors, so the map alone is too sure of itself. This floor brings the drawn area up to
// about 85 % coverage in the demo's flights.
const AREA_FLOOR_M = 50;
const STRONG_SCORE = 0.12;

export interface AreaReport {
  id: number;
  x: number;
  y: number;
  // Median comb score over the last second or so.
  score: number;
  bearingDeg: number | null;
}

export interface BogieArea {
  x: number;
  y: number;
  // Semi-axes at two sigma, the long one at angleRad anticlockwise from +x.
  majorM: number;
  minorM: number;
  angleRad: number;
  // The nodes hearing it well enough to count, which the map draws lines from.
  nodeIds: number[];
}

// Nodes too faint to say much stay in the fit but draw no line, and a bogie needs two good ones or a bearing.
export function isLocatable(reports: AreaReport[]): boolean {
  const strong = reports.filter((r) => r.score >= STRONG_SCORE).length;
  return strong >= 2 || (strong >= 1 && reports.some((r) => r.bearingDeg !== null));
}

// The point on the area's edge towards the given node. Null when the node is inside it.
export function areaEdge(area: BogieArea, x: number, y: number): { x: number; y: number } | null {
  const [dx, dy] = [x - area.x, y - area.y];
  const [c, s] = [Math.cos(area.angleRad), Math.sin(area.angleRad)];
  const u = (dx * c + dy * s) / area.majorM;
  const v = (-dx * s + dy * c) / area.minorM;
  const out = Math.hypot(u, v);
  return out <= 1 ? null : { x: area.x + dx / out, y: area.y + dy / out };
}

interface NodeTable {
  score: Float32Array[];
  azDeg: Float32Array;
}

export class AreaGrid {
  private readonly nx: number;
  private readonly ny: number;
  private readonly cell: number;
  private readonly halfX: number;
  private readonly halfY: number;
  private readonly kernel: number[];
  private readonly tables = new Map<string, NodeTable>();
  private readonly chi: Float64Array[];
  private readonly scratch: Float64Array;

  constructor([w, h]: readonly [number, number]) {
    this.cell = Math.max(MIN_CELL_M, Math.sqrt((w * h) / MAX_CELLS));
    this.nx = Math.ceil(w / this.cell) + 1;
    this.ny = Math.ceil(h / this.cell) + 1;
    this.halfX = w / 2;
    this.halfY = h / 2;
    const n = this.nx * this.ny;
    this.chi = STRENGTHS.map(() => new Float64Array(n));
    this.scratch = new Float64Array(n);
    const sigma = SPREAD_M / this.cell;
    const raw = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => Math.exp(-0.5 * (k / sigma) ** 2));
    const sum = raw.reduce((a, b) => a + b, 0);
    this.kernel = raw.map((k) => k / sum);
  }

  private cellX(i: number): number {
    return -this.halfX + i * this.cell;
  }

  private cellY(j: number): number {
    return -this.halfY + j * this.cell;
  }

  // The expected log score at this node from a source in each cell, and the direction to each cell, kept per position.
  private table(x: number, y: number): NodeTable {
    const key = `${x},${y}`;
    let t = this.tables.get(key);
    if (t) return t;
    // Dragging a node passes through many positions.
    if (this.tables.size > 64) this.tables.clear();
    const n = this.nx * this.ny;
    t = { score: STRENGTHS.map(() => new Float32Array(n)), azDeg: new Float32Array(n) };
    for (let j = 0, c = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++, c++) {
        const [dx, dy] = [this.cellX(i) - x, this.cellY(j) - y];
        const logR = 0.5 * Math.log(dx * dx + dy * dy + HEIGHT_M * HEIGHT_M);
        for (let a = 0; a < STRENGTHS.length; a++) {
          t.score[a][c] = 0.5 * Math.log(Math.exp(2 * (STRENGTHS[a] - logR)) + FLOOR * FLOOR);
        }
        t.azDeg[c] = (Math.atan2(dx, dy) * 180) / Math.PI;
      }
    }
    this.tables.set(key, t);
    return t;
  }

  // The bogie's new map, from its last one and the latest reports. The result is a new array when there was no last one.
  update(prev: Float64Array | null, reports: AreaReport[]): Float64Array {
    const n = this.nx * this.ny;
    let min = Infinity;
    for (let a = 0; a < STRENGTHS.length; a++) {
      const chi = this.chi[a];
      chi.fill(0);
      for (const r of reports) {
        const logScore = Math.log(Math.max(r.score, FLOOR));
        const expected = this.table(r.x, r.y).score[a];
        for (let c = 0; c < n; c++) {
          const e = (logScore - expected[c]) / SCORE_SIGMA;
          chi[c] += e * e;
        }
      }
      for (let c = 0; c < n; c++) if (chi[c] < min) min = chi[c];
    }
    const map = prev ?? new Float64Array(n);
    if (prev) this.spread(prev);
    else map.fill(1);
    const like = this.scratch;
    for (let c = 0; c < n; c++) {
      let sum = 0;
      for (let a = 0; a < STRENGTHS.length; a++) sum += Math.exp(-0.5 * (this.chi[a][c] - min));
      like[c] = sum;
    }
    for (const r of reports) {
      if (r.bearingDeg === null) continue;
      const az = this.table(r.x, r.y).azDeg;
      for (let c = 0; c < n; c++) {
        const d = ((((az[c] - r.bearingDeg + 180) % 360) + 360) % 360) - 180;
        like[c] *= Math.exp(-0.5 * (d / BEARING_SIGMA_DEG) ** 2);
      }
    }
    let total = 0;
    for (let c = 0; c < n; c++) {
      map[c] = (map[c] + 1e-6 / n) * like[c];
      total += map[c];
    }
    if (total > 0) for (let c = 0; c < n; c++) map[c] /= total;
    else map.fill(1 / n);
    return map;
  }

  // Blurs the map in place, in x then in y.
  private spread(map: Float64Array): void {
    const k = this.kernel;
    const reach = (k.length - 1) / 2;
    const run = (count: number, len: number, at: (line: number, i: number) => number): void => {
      const buf = new Float64Array(len);
      for (let line = 0; line < count; line++) {
        for (let i = 0; i < len; i++) {
          let v = 0;
          for (let o = -reach; o <= reach; o++) {
            const p = i + o;
            if (p >= 0 && p < len) v += k[o + reach] * map[at(line, p)];
          }
          buf[i] = v;
        }
        for (let i = 0; i < len; i++) map[at(line, i)] = buf[i];
      }
    };
    run(this.ny, this.nx, (j, i) => j * this.nx + i);
    run(this.nx, this.ny, (i, j) => j * this.nx + i);
  }

  // The map's mean and spread as an ellipse.
  area(map: Float64Array, reports: AreaReport[]): BogieArea {
    let [mx, my] = [0, 0];
    for (let j = 0, c = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++, c++) {
        mx += map[c] * this.cellX(i);
        my += map[c] * this.cellY(j);
      }
    }
    let [xx, yy, xy] = [0, 0, 0];
    for (let j = 0, c = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++, c++) {
        const [dx, dy] = [this.cellX(i) - mx, this.cellY(j) - my];
        xx += map[c] * dx * dx;
        yy += map[c] * dy * dy;
        xy += map[c] * dx * dy;
      }
    }
    const extra = (this.cell * this.cell) / 12 + AREA_FLOOR_M * AREA_FLOOR_M;
    xx += extra;
    yy += extra;
    const [mean, half] = [(xx + yy) / 2, Math.hypot((xx - yy) / 2, xy)];
    return {
      x: mx,
      y: my,
      majorM: 2 * Math.sqrt(mean + half),
      minorM: 2 * Math.sqrt(Math.max(mean - half, 0)),
      angleRad: 0.5 * Math.atan2(2 * xy, xx - yy),
      nodeIds: reports.filter((r) => r.score >= STRONG_SCORE).map((r) => r.id),
    };
  }
}
