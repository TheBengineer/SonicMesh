import { TICK_S } from './clock';
import type { ShooterSpec } from './scenario';

// Shooter height above the ground. A standing shooter's mouth is about here.
export const SHOOTER_H_M = 1.5;
// What a click in gunshot mode adds: a shooter that fires as often as the range does.
export const SHOOTER_EVERY_S = 4;

// A shooter in world state. Shots start at t0 and then every everyTicks ticks, so the schedule is a function of
// the tick and needs no random numbers. Replay stays exact.
export interface ShooterState {
  id: number;
  kind: 'range' | 'shooter';
  x: number;
  y: number;
  everyTicks: number;
  t0: number;
}

export function everyTicks(everyS: number): number {
  return Math.max(1, Math.round(everyS / TICK_S));
}

export function shooterState(spec: ShooterSpec, t0: number): ShooterState {
  return { id: spec.id, kind: spec.kind, x: spec.x, y: spec.y, everyTicks: everyTicks(spec.every_s), t0 };
}

// Whether a shot starts at this tick.
export function isShotTick(s: ShooterState, tick: number): boolean {
  return tick >= s.t0 && (tick - s.t0) % s.everyTicks === 0;
}

// The tick of the latest shot that has started by this tick, or null before the first.
export function lastShotTick(s: ShooterState, tick: number): number | null {
  if (tick < s.t0) return null;
  return tick - ((tick - s.t0) % s.everyTicks);
}
