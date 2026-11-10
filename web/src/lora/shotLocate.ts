// Where a shot was fired, from the moment each node heard it and the bearings the arrays took. A node hears a shot at its
// time of fire plus its travel time, so the differences between nodes place the shot on hyperbolas, with no clock but
// the network's own. The hyperbolas are symmetric about the line of nodes, so an array's bearing picks the side.
import { SOUND_SPEED_MPS } from '../acoustics/model';
import type { ShotFix, ShotHeard } from './types';

export interface ShotReport extends ShotHeard {
  id: number;
  x: number;
  y: number;
}

// Onsets closer together than this belong to one shot. Nodes 120 m apart differ by about 0.35 s in arrival, so one
// shot's onsets chain together, while two shots a few seconds apart do not.
export const CLUSTER_GAP_S = 1.5;
// The onset time's error: a 1 ms detector window plus the crack's rise.
const TIME_SIGMA_S = 0.002;
// An array's bearing error for a shot.
const BEARING_SIGMA_DEG = 8;
const COARSE_M = 10;
const FINE_M = 1;
const FINE_SPAN_M = 15;
const MIN_NODES = 3;
// A fit whose onset times disagree by more than this (about 1.7 m of travel) is two shots, or noise, not one shot.
const MAX_RESIDUAL_S = 0.005;
const MIN_RADIUS_M = 8;

// Splits reports into shots: runs of onsets with no gap longer than CLUSTER_GAP_S.
export function clusterShots(reports: ShotReport[]): ShotReport[][] {
  const sorted = [...reports].sort((a, b) => a.tS - b.tS);
  const out: ShotReport[][] = [];
  let last = -Infinity;
  for (const r of sorted) {
    if (r.tS - last > CLUSTER_GAP_S) out.push([]);
    out[out.length - 1].push(r);
    last = r.tS;
  }
  return out;
}

interface Score {
  cost: number;
  tFireS: number;
  residualS: number;
}

// The fit's cost at one point. The time of fire is free, so it is the mean over the nodes of onset minus travel time.
function score(x: number, y: number, reports: ShotReport[]): Score {
  const travel = reports.map((r) => Math.hypot(x - r.x, y - r.y) / SOUND_SPEED_MPS);
  const tFireS = reports.reduce((sum, r, j) => sum + r.tS - travel[j], 0) / reports.length;
  let cost = 0;
  let sq = 0;
  reports.forEach((r, j) => {
    const res = r.tS - tFireS - travel[j];
    cost += (res / TIME_SIGMA_S) ** 2;
    sq += res * res;
  });
  for (const r of reports) {
    if (r.azDeg === null) continue;
    // Bearings run clockwise from +y, as the array estimator reports them.
    const pred = (Math.atan2(x - r.x, y - r.y) * 180) / Math.PI;
    const diff = ((((pred - r.azDeg) % 360) + 540) % 360) - 180;
    cost += (diff / BEARING_SIGMA_DEG) ** 2;
  }
  return { cost, tFireS, residualS: Math.sqrt(sq / reports.length) };
}

// Places one shot inside a world of the given size, centred on the origin (the demo's default size when none is given).
// Null without two nodes or without a bearing.
export function locateShot(reports: ShotReport[], size: readonly [number, number] = [2000, 1400]): ShotFix | null {
  if (reports.length < MIN_NODES || !reports.some((r) => r.azDeg !== null)) return null;
  const [hx, hy] = [size[0] / 2, size[1] / 2];
  let best = { x: 0, y: 0, ...score(0, 0, reports) };
  for (let x = -hx; x <= hx; x += COARSE_M) {
    for (let y = -hy; y <= hy; y += COARSE_M) {
      const s = score(x, y, reports);
      if (s.cost < best.cost) best = { x, y, ...s };
    }
  }
  const [cx, cy] = [best.x, best.y];
  for (let x = cx - FINE_SPAN_M; x <= cx + FINE_SPAN_M; x += FINE_M) {
    for (let y = cy - FINE_SPAN_M; y <= cy + FINE_SPAN_M; y += FINE_M) {
      const s = score(x, y, reports);
      if (s.cost < best.cost) best = { x, y, ...s };
    }
  }
  if (best.residualS > MAX_RESIDUAL_S) return null;
  // The bearing error sets the area: two sigma of it, at the nearest node that gave a bearing.
  const dBearing = Math.min(...reports.filter((r) => r.azDeg !== null).map((r) => Math.hypot(best.x - r.x, best.y - r.y)));
  return {
    x: best.x,
    y: best.y,
    tFireS: best.tFireS,
    nodeIds: [...new Set(reports.map((r) => r.id))],
    residualS: best.residualS,
    radiusM: Math.max(MIN_RADIUS_M, ((2 * BEARING_SIGMA_DEG * Math.PI) / 180) * dBearing),
  };
}
