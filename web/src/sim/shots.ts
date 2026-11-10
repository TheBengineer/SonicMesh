import { TICK_S } from './clock';
import { createRng, nextFloat } from './rng';
import type { ShooterSpec } from './scenario';
import type { Clearing } from './terrain';

// Shooter height above the ground. A standing shooter's mouth is about here.
export const SHOOTER_H_M = 1.5;
// A range's berm, downrange of its firing line. The shots bounce off it, and the 3D view draws it at the same distance.
export const RANGE_BERM_M = 115;

// A range fires about this often. Each shot lands anywhere within SHOT_JITTER of its slot, so the cadence is irregular.
export const SHOOTER_EVERY_S = 4;
export const SHOT_JITTER = 0.25;
// A one-off shot's marker stays this long: long enough for its sound to reach a far node (about 3 s over 1 km) and to
// fade, after which the shooter is removed.
export const ONE_OFF_LINGER_S = 8;

// A shooter in world state. A repeating shooter (everyTicks > 0) fires shot k near t0 + (k + 1/2) everyTicks, offset by a
// seeded random amount, so the schedule is a pure function of the tick and the seed and replay stays exact. A one-off
// (once) fires once at t0.
export interface ShooterState {
  id: number;
  kind: 'range' | 'shooter';
  x: number;
  y: number;
  everyTicks: number;
  t0: number;
  seed: number;
  once: boolean;
}

// The ground a range takes: its firing line, targets and berm, in sim metres. Trees keep out of it.
export function rangeClearing(s: { kind: 'range' | 'shooter'; x: number; y: number }): Clearing | null {
  if (s.kind !== 'range') return null;
  return { x0: s.x - 35, x1: s.x + 35, y0: s.y - RANGE_BERM_M - 10, y1: s.y + 15 };
}

export function everyTicks(everyS: number): number {
  return Math.max(1, Math.round(everyS / TICK_S));
}

export function shooterState(spec: ShooterSpec, t0: number, seed: number): ShooterState {
  return { id: spec.id, kind: spec.kind, x: spec.x, y: spec.y, everyTicks: everyTicks(spec.every_s), t0, seed, once: false };
}

// A one-off shot at a point, fired at t0. Its id must not clash with a shooter's.
export function oneOffState(id: number, x: number, y: number, t0: number, seed: number): ShooterState {
  return { id, kind: 'shooter', x, y, everyTicks: 0, t0, seed, once: true };
}

// The tick at which shot k of a shooter starts.
export function shotTick(s: ShooterState, k: number): number {
  if (s.once) return s.t0;
  const u = nextFloat(createRng((s.seed ^ Math.imul(s.id + 1, 0x2545f491) ^ Math.imul(k + 1, 0x7feb352d)) >>> 0));
  return s.t0 + Math.round((k + 0.5 + (2 * u - 1) * SHOT_JITTER) * s.everyTicks);
}

// The index of the shot that starts at this tick, or null when none does.
export function shotStartingAt(s: ShooterState, tick: number): number | null {
  if (tick < s.t0) return null;
  if (s.once) return tick === s.t0 ? 0 : null;
  const guess = Math.round((tick - s.t0) / s.everyTicks - 0.5);
  for (let k = Math.max(0, guess - 1); k <= guess + 1; k++) if (shotTick(s, k) === tick) return k;
  return null;
}

// Whether a shot starts at this tick.
export function isShotTick(s: ShooterState, tick: number): boolean {
  return shotStartingAt(s, tick) !== null;
}

// The tick of the latest shot that has started by this tick, or null before the first.
export function lastShotTick(s: ShooterState, tick: number): number | null {
  if (tick < s.t0) return null;
  if (s.once) return s.t0;
  const guess = Math.round((tick - s.t0) / s.everyTicks - 0.5);
  let best: number | null = null;
  for (let k = Math.max(0, guess - 1); k <= guess + 1; k++) {
    const t = shotTick(s, k);
    if (t <= tick && (best === null || t > best)) best = t;
  }
  return best;
}
