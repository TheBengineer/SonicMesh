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
const MIN_CROSS_DEG = 15;
const MAX_FIX_M = 800;
const MIN_FIX_RADIUS_M = 25;
const MAX_FIX_RADIUS_M = 250;
const FIX_SMOOTH = 0.3;

export interface BogieReport {
  id: number;
  x: number;
  y: number;
  pitchHz: number;
  bearingDeg: number | null;
  bearingSigmaDeg: number | null;
}

export interface BogieFix {
  x: number;
  y: number;
  radiusM: number;
}

export interface Bogie {
  letter: string;
  pitchHz: number;
  // In order along the line.
  nodeIds: number[];
  fix: BogieFix | null;
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

// Where two bearings cross, and how far off that could be for their reported spread and crossing angle. Null when they diverge,
// are nearly parallel, or cross too far out to mean anything.
export function crossing(a: BogieReport, b: BogieReport): BogieFix | null {
  if (a.bearingDeg === null || b.bearingDeg === null) return null;
  const [ra, rb] = [(a.bearingDeg * Math.PI) / 180, (b.bearingDeg * Math.PI) / 180];
  const [ax, ay, bx, by] = [Math.sin(ra), Math.cos(ra), Math.sin(rb), Math.cos(rb)];
  const cross = ax * by - ay * bx;
  if (Math.abs(cross) < Math.sin((MIN_CROSS_DEG * Math.PI) / 180)) return null;
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const s = (dx * by - dy * bx) / cross;
  const t = (dx * ay - dy * ax) / cross;
  if (s <= 0 || t <= 0 || Math.max(s, t) > MAX_FIX_M) return null;
  const off = (range: number, sigma: number | null): number => range * Math.tan(((sigma ?? 0) * Math.PI) / 180);
  const spread = Math.max(off(s, a.bearingSigmaDeg), off(t, b.bearingSigmaDeg)) / Math.abs(cross);
  return { x: a.x + s * ax, y: a.y + s * ay, radiusM: Math.min(MAX_FIX_RADIUS_M, Math.max(MIN_FIX_RADIUS_M, spread)) };
}

// The mean crossing over every pair of arrays in a group.
function fixOf(group: BogieReport[]): BogieFix | null {
  const fixes: BogieFix[] = [];
  group.forEach((a, i) => {
    for (const b of group.slice(i + 1)) {
      const f = crossing(a, b);
      if (f) fixes.push(f);
    }
  });
  if (fixes.length === 0) return null;
  const mean = (get: (f: BogieFix) => number): number => fixes.reduce((sum, f) => sum + get(f), 0) / fixes.length;
  return { x: mean((f) => f.x), y: mean((f) => f.y), radiusM: mean((f) => f.radiusM) };
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
  fix: BogieFix | null;
  lastS: number;
}

// Keeps a bogie's letter while its nodes change as it moves along the line.
export class BogieTracker {
  private known: Known[] = [];

  update(t: number, reports: BogieReport[]): Bogie[] {
    this.known = this.known.filter((k) => t - k.lastS <= LETTER_HOLD_S);
    const groups = groupReports(reports).sort((a, b) => b.length - a.length);
    const claimed = new Set<Known>();
    const out: Bogie[] = [];
    for (const group of groups) {
      const pitchHz = medianOf(group.map((r) => r.pitchHz));
      const known = this.bestMatch(group, pitchHz, claimed);
      const entry: Known = known ?? { letter: this.freshLetter(), pitchHz, reports: group, fix: null, lastS: t };
      if (known) claimed.add(known);
      else {
        this.known.push(entry);
        claimed.add(entry);
      }
      const fix = fixOf(group);
      if (fix && entry.fix) {
        fix.x = entry.fix.x + FIX_SMOOTH * (fix.x - entry.fix.x);
        fix.y = entry.fix.y + FIX_SMOOTH * (fix.y - entry.fix.y);
        fix.radiusM = entry.fix.radiusM + FIX_SMOOTH * (fix.radiusM - entry.fix.radiusM);
      }
      entry.pitchHz = pitchHz;
      entry.reports = group;
      entry.fix = fix;
      entry.lastS = t;
      out.push({ letter: entry.letter, pitchHz, nodeIds: alongLine(group), fix });
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
