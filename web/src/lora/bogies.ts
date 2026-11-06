import { AreaGrid, isLocatable, type BogieArea } from './locate';

// Groups detections the way a gateway could, from what nodes report: position, pitch and bearing. No drone identity goes
// in, so a bogie is only "neighbouring nodes hear a matching pitch". One drone can still split into two bogies, and two
// drones with related pitches can merge into one.
// A drone at 20 m/s reads about 6 % high ahead of it and 6 % low behind, so nodes either side of it differ by twice that.
export const PITCH_TOL = 0.13;
// Three node spacings, so a node that drops out does not split the group.
export const LINK_M = 360;
const RATIOS = [1, 2, 3, 4];
// A bogie that drops out keeps its letter this long, so a short gap does not rename it.
const LETTER_HOLD_S = 3;
// Comb scores swing from frame to frame, so a node's score is its median over this long.
const SCORE_WINDOW_S = 1.25;

export interface BogieReport {
  id: number;
  x: number;
  y: number;
  pitchHz: number;
  bearingDeg: number | null;
  // The comb score, which falls with distance from this source.
  peak: number;
}

export interface Bogie {
  letter: string;
  pitchHz: number;
  // In order along the line.
  nodeIds: number[];
  area: BogieArea | null;
}

// Whether two pitches could be one source: equal, or one a low multiple of the other, since the detector can settle on
// a sub-harmonic.
export function samePitch(a: number, b: number): boolean {
  const r = Math.max(a, b) / Math.min(a, b);
  return RATIOS.some((m) => Math.abs(r / m - 1) < PITCH_TOL);
}

// Neighbouring reports with matching pitches, as connected groups.
export function groupReports(reports: BogieReport[]): BogieReport[][] {
  const parent = reports.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  reports.forEach((a, i) => {
    for (let j = i + 1; j < reports.length; j++) {
      const b = reports[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) <= LINK_M && samePitch(a.pitchHz, b.pitchHz)) parent[find(j)] = find(i);
    }
  });
  const groups = new Map<number, BogieReport[]>();
  reports.forEach((r, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  });
  return [...groups.values()];
}

// The upper middle value, always a pitch a node reported. A mean of 558 Hz and its 157 Hz sub-harmonic would name a pitch
// nobody heard.
function medianOf(values: number[]): number {
  return [...values].sort((a, b) => a - b)[values.length >> 1];
}

function letterAt(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

interface Known {
  letter: string;
  pitchHz: number;
  reports: BogieReport[];
  map: Float64Array | null;
  lastS: number;
}

// Keeps a bogie's letter while its nodes change as it moves along the line.
export class BogieTracker {
  private known: Known[] = [];
  private readonly scores = new Map<number, { t: number; peak: number }[]>();
  private readonly grid: AreaGrid;

  constructor(size: readonly [number, number] = [2000, 1400]) {
    this.grid = new AreaGrid(size);
  }

  // Each report with its node's median score over the last moments.
  private smoothed(t: number, reports: BogieReport[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const r of reports) {
      const log = (this.scores.get(r.id) ?? []).filter((s) => t - s.t < SCORE_WINDOW_S);
      log.push({ t, peak: r.peak });
      this.scores.set(r.id, log);
      out.set(r.id, medianOf(log.map((s) => s.peak)));
    }
    return out;
  }

  update(t: number, reports: BogieReport[]): Bogie[] {
    this.known = this.known.filter((k) => t - k.lastS <= LETTER_HOLD_S);
    const scores = this.smoothed(t, reports);
    const groups = groupReports(reports).sort((a, b) => b.length - a.length);
    const claimed = new Set<Known>();
    const out: Bogie[] = [];
    for (const group of groups) {
      const pitchHz = medianOf(group.map((r) => r.pitchHz));
      const known = this.bestMatch(group, pitchHz, claimed);
      const entry: Known = known ?? { letter: this.freshLetter(), pitchHz, reports: group, map: null, lastS: t };
      if (known) claimed.add(known);
      else {
        this.known.push(entry);
        claimed.add(entry);
      }
      const located = group.map((r) => ({ id: r.id, x: r.x, y: r.y, score: scores.get(r.id) ?? 0, bearingDeg: r.bearingDeg }));
      let area: BogieArea | null = null;
      if (isLocatable(located)) {
        entry.map = this.grid.update(entry.map, located);
        area = this.grid.area(entry.map, located);
      }
      entry.pitchHz = pitchHz;
      entry.reports = group;
      entry.lastS = t;
      out.push({ letter: entry.letter, pitchHz, nodeIds: alongLine(group), area });
    }
    return out.sort((a, b) => a.letter.localeCompare(b.letter));
  }

  // The known bogie sharing the most nodes with this group, or failing that one next to it, with a matching pitch.
  private bestMatch(group: BogieReport[], pitchHz: number, claimed: Set<Known>): Known | null {
    let best: Known | null = null;
    let bestShared = -1;
    for (const k of this.known) {
      if (claimed.has(k) || !samePitch(k.pitchHz, pitchHz)) continue;
      const shared = group.filter((r) => k.reports.some((o) => o.id === r.id)).length;
      const near = group.some((r) => k.reports.some((o) => Math.hypot(r.x - o.x, r.y - o.y) <= LINK_M));
      if (shared === 0 && !near) continue;
      if (shared > bestShared) {
        best = k;
        bestShared = shared;
      }
    }
    return best;
  }

  // The first letter not in use, so short-lived bogies do not use up the alphabet.
  private freshLetter(): string {
    const inUse = new Set(this.known.map((k) => k.letter));
    for (let i = 0; i < 26; i++) if (!inUse.has(letterAt(i))) return letterAt(i);
    return letterAt(this.known.length);
  }
}

// Node ids along whichever axis the group spreads over most.
function alongLine(group: BogieReport[]): number[] {
  const spread = (get: (r: BogieReport) => number): number => Math.max(...group.map(get)) - Math.min(...group.map(get));
  const key = spread((r) => r.x) >= spread((r) => r.y) ? (r: BogieReport) => r.x : (r: BogieReport) => r.y;
  return [...group].sort((a, b) => key(a) - key(b)).map((r) => r.id);
}
