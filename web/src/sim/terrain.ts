import { clamp } from './math';
import { createRng, range } from './rng';
import type { ScenarioFile, Vec2 } from './scenario';

export interface Tree {
  x: number;
  y: number;
  height_m: number;
  radius_m: number;
}

// Integer lattice hash to [0, 1).
function lattice(ix: number, iy: number, seed: number): number {
  let h = seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lattice(ix, iy, seed);
  const b = lattice(ix + 1, iy, seed);
  const c = lattice(ix, iy + 1, seed);
  const d = lattice(ix + 1, iy + 1, seed);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

// Sim coordinates: x east, y north, metres. Origin at the centre of the terrain.
export class Terrain {
  readonly halfX: number;
  readonly halfY: number;

  constructor(
    readonly seed: number,
    readonly params: ScenarioFile['terrain'],
  ) {
    this.halfX = params.size_m[0] / 2;
    this.halfY = params.size_m[1] / 2;
  }

  get size(): [number, number] {
    return this.params.size_m;
  }

  get amplitude(): number {
    return this.params.amplitude_m;
  }

  get roadY(): number {
    return this.params.road_y_m;
  }

  // Ground height above datum, 0 to amplitude_m.
  height(x: number, y: number): number {
    const wl = this.params.wavelength_m;
    const u = (x + this.halfX) / wl;
    const v = (y + this.halfY) / wl;
    const n =
      0.6 * valueNoise(u, v, this.seed) +
      0.3 * valueNoise(2 * u, 2 * v, this.seed + 1) +
      0.1 * valueNoise(4 * u, 4 * v, this.seed + 2);
    return this.params.amplitude_m * n;
  }

  contains(x: number, y: number): boolean {
    return Math.abs(x) <= this.halfX && Math.abs(y) <= this.halfY;
  }

  clamp(x: number, y: number): Vec2 {
    return { x: clamp(x, -this.halfX, this.halfX), y: clamp(y, -this.halfY, this.halfY) };
  }
}

// Visual only. The sun comes from the south-west, low enough to pick out small slopes. Shade is 1 on flat ground, and
// slopes are steepened so that gentle hills still read.
const SUN = (() => {
  const [x, y, z] = [-0.6, -0.4, 0.55];
  const len = Math.hypot(x, y, z);
  return { x: x / len, y: y / len, z: z / len };
})();
const SHADE_STEP_M = 8;
const SHADE_STEEPEN = 2;

export function hillshade(t: Terrain, x: number, y: number): number {
  const dx = (t.height(x + SHADE_STEP_M, y) - t.height(x - SHADE_STEP_M, y)) / (2 * SHADE_STEP_M);
  const dy = (t.height(x, y + SHADE_STEP_M) - t.height(x, y - SHADE_STEP_M)) / (2 * SHADE_STEP_M);
  const [nx, ny] = [-dx * SHADE_STEEPEN, -dy * SHADE_STEEPEN];
  const lit = (nx * SUN.x + ny * SUN.y + SUN.z) / Math.hypot(nx, ny, 1);
  return clamp(lit / SUN.z, 0.35, 1.5);
}

// Visual only. Ground colour from red, green and blue in 0 to 1: paler with height, and shaded.
export function groundColor(t: Terrain, x: number, y: number): [number, number, number] {
  const f = t.amplitude > 0 ? t.height(x, y) / t.amplitude : 0;
  const shade = hillshade(t, x, y);
  return [(0.2 + 0.3 * f) * shade, (0.34 + 0.24 * f) * shade, (0.17 + 0.14 * f) * shade];
}

// Visual only. Trees come from the seed, not from the sim state.
export function placeTrees(t: Terrain): Tree[] {
  const rng = createRng(t.seed ^ 0x9e3779b9);
  const trees: Tree[] = [];
  const clusters = Math.round((70 * (t.halfX * t.halfY)) / (2500 * 1000)); // the same tree density on any terrain
  for (let c = 0; c < clusters; c++) {
    const cx = range(rng, -t.halfX + 100, t.halfX - 100);
    const cy = range(rng, -t.halfY + 100, t.halfY - 100);
    const count = 4 + Math.floor(range(rng, 0, 12));
    const spread = range(rng, 30, 90);
    for (let i = 0; i < count; i++) {
      const x = cx + (range(rng, -1, 1) + range(rng, -1, 1)) * spread;
      const y = cy + (range(rng, -1, 1) + range(rng, -1, 1)) * spread;
      if (!t.contains(x, y) || Math.abs(y - t.roadY) < 25) continue;
      trees.push({ x, y, height_m: range(rng, 7, 14), radius_m: range(rng, 2.5, 4) });
    }
  }
  return trees;
}
