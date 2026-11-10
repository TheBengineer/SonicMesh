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

// The onset time's error: a 1 ms detector window plus the crack's rise.
const TIME_SIGMA_S = 0.002;
// An array's bearing error for a shot.
const BEARING_SIGMA_DEG = 8;
const COARSE_M = 10;
const FINE_M = 1;
const FINE_SPAN_M = 15;
const MIN_NODES = 3;
// Two bearings: nodes on one line give travel times that are symmetric about it, so a single bearing cannot pick the side.
const MIN_BEARINGS = 2;
// A fit whose onset times disagree by more than this (about 1.7 m of travel) is two shots, or noise, not one shot.
const MAX_RESIDUAL_S = 0.005;
const MIN_RADIUS_M = 8;
// Onsets agree on one fire time within this, and their bearings within BEARING_TOL_DEG of the spot.
const TIME_TOL_S = 0.01;
const BEARING_TOL_DEG = 15;
// Shots one window can hold. A range fires every ~12 s, so this is well above what a real window needs.
const MAX_SHOTS = 8;
// A group must hold this many onsets to be a shot. Three can fit almost anything, so a shot needs more.
const MIN_GROUP = 4;
// Two fits this close in place and time are one shot.
const SAME_SHOT_M = 20;
const SAME_SHOT_S = 0.05;

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
// Null without three nodes or without two bearings.
export function locateShot(reports: ShotReport[], size: readonly [number, number] = [2000, 1400]): ShotFix | null {
  if (reports.length < MIN_NODES || reports.filter((r) => r.azDeg !== null).length < MIN_BEARINGS) return null;
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

// The bearing a report would give from (x, y), in degrees, minus its measured one, wrapped to (-180, 180].
function bearingOff(r: ShotReport, x: number, y: number): number {
  const pred = (Math.atan2(x - r.x, y - r.y) * 180) / Math.PI;
  return ((((pred - (r.azDeg ?? 0)) % 360) + 540) % 360) - 180;
}

// The onsets that one shot at (x, y) explains: those whose fire time agrees with the densest run of them, and whose
// bearing (where they have one) points at the spot. Every onset in the pool is a candidate, so a shot is found whatever
// time it was fired, even when another shot went off in the same second.
function explainedBy(pool: ShotReport[], x: number, y: number): ShotReport[] {
  const timed = pool
    .map((r) => ({ r, fire: r.tS - Math.hypot(x - r.x, y - r.y) / SOUND_SPEED_MPS }))
    .sort((a, b) => a.fire - b.fire);
  let best: ShotReport[] = [];
  let lo = 0;
  for (let hi = 0; hi < timed.length; hi++) {
    while (timed[hi].fire - timed[lo].fire > 2 * TIME_TOL_S) lo++;
    const run = timed.slice(lo, hi + 1).map((t) => t.r).filter((r) => r.azDeg === null || Math.abs(bearingOff(r, x, y)) <= BEARING_TOL_DEG);
    if (run.length > best.length) best = run;
  }
  return best;
}

// Whether one onset belongs to a fitted shot: its fire time matches the shot's, and its bearing points at the spot.
function isOf(r: ShotReport, fix: ShotFix): boolean {
  const fire = r.tS - Math.hypot(fix.x - r.x, fix.y - r.y) / SOUND_SPEED_MPS;
  return Math.abs(fire - fix.tFireS) <= TIME_TOL_S && (r.azDeg === null || Math.abs(bearingOff(r, fix.x, fix.y)) <= BEARING_TOL_DEG);
}

// Where two bearings from different arrays cross, in front of both. Null when they are nearly parallel or cross behind.
function crossing(a: ShotReport, b: ShotReport): { x: number; y: number } | null {
  const [sa, ca] = [Math.sin((a.azDeg! * Math.PI) / 180), Math.cos((a.azDeg! * Math.PI) / 180)];
  const [sb, cb] = [Math.sin((b.azDeg! * Math.PI) / 180), Math.cos((b.azDeg! * Math.PI) / 180)];
  const det = -sa * cb + sb * ca;
  if (Math.abs(det) < 0.1) return null;
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const t = (-dx * cb + sb * dy) / det;
  const u = (sa * dy - ca * dx) / det;
  if (t <= 0 || u <= 0) return null;
  return { x: a.x + t * sa, y: a.y + t * ca };
}

// Every group the pool could hold as one shot, largest first: each spot where two bearings cross, with the onsets that
// fit it. A group that mixes two shots usually fails its fit, so the solver falls back to the next one.
function candidateGroups(pool: ShotReport[], size: readonly [number, number]): ShotReport[][] {
  const bearings = pool.filter((r) => r.azDeg !== null);
  const [hx, hy] = [size[0] / 2, size[1] / 2];
  const groups: ShotReport[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < bearings.length; i++) {
    for (let j = i + 1; j < bearings.length; j++) {
      const p = crossing(bearings[i], bearings[j]);
      if (!p || Math.abs(p.x) > hx || Math.abs(p.y) > hy) continue;
      const group = explainedBy(pool, p.x, p.y);
      const bearingsIn = group.filter((r) => r.azDeg !== null).length;
      if (group.length < MIN_GROUP || bearingsIn < MIN_BEARINGS) continue;
      const key = groupKey(group);
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(group);
    }
  }
  return groups.sort((a, b) => b.length - a.length);
}

function groupKey(group: ShotReport[]): string {
  return group
    .map((r) => `${r.id}:${r.tS.toFixed(4)}:${r.azDeg === null ? '-' : r.azDeg.toFixed(1)}`)
    .sort()
    .join('|');
}

// Every shot in one window of reports, each placed by locateShot from the onsets that belong to it. Shots that overlap
// in time are told apart by where their bearings cross, not by when they arrive. The cache keeps a fit for a shot whose
// onsets have not changed, so a settled shot is not refitted each update. Returns the fixes and the cache keys in use.
export function locateShots(
  reports: ShotReport[],
  size: readonly [number, number] = [2000, 1400],
  cache = new Map<string, ShotFix>(),
): { fixes: ShotFix[]; keys: Set<string> } {
  const fixes: ShotFix[] = [];
  const keys = new Set<string>();
  let pool = [...reports];
  for (let n = 0; n < MAX_SHOTS; n++) {
    let accepted: { group: ShotReport[]; fix: ShotFix } | null = null;
    for (const group of candidateGroups(pool, size)) {
      const key = groupKey(group);
      let fix = cache.get(key);
      if (!fix) {
        const found = locateShot(group, size);
        if (!found) continue;
        fix = found;
        cache.set(key, fix);
      }
      keys.add(key);
      accepted = { group, fix };
      break;
    }
    if (!accepted) break;
    const { group, fix } = accepted;
    // A shot whose onsets were split between two fits is the same shot twice: keep the first.
    if (!fixes.some((f) => Math.hypot(f.x - fix.x, f.y - fix.y) < SAME_SHOT_M && Math.abs(f.tFireS - fix.tFireS) < SAME_SHOT_S)) {
      fixes.push(fix);
    }
    // Whatever the fit explains is used up, and so is the group itself, so the loop always makes progress.
    pool = pool.filter((r) => !group.includes(r) && !isOf(r, fix));
  }
  return { fixes, keys };
}
