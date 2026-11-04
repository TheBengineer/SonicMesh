import { describe, expect, it } from 'vitest';
import exampleScenario from '../scenarios/example.json';
import { SimClock, TICK_MS } from '../src/sim/clock';
import type { Op } from '../src/sim/inputs';
import { parseScenario } from '../src/sim/scenario';
import { Runner } from '../src/sim/runner';
import { hashWorld } from '../src/sim/world';

const scenario = parseScenario(exampleScenario);

// Ops keyed by the tick they are applied at.
type Schedule = Map<number, Op[]>;

const schedule: Schedule = new Map<number, Op[]>([
  [0, [{ type: 'drone_path', id: 1, path: { kind: 'manual', start: { x: -900, y: 600, altitude_m: 30 } } }]],
  [20, [{ type: 'drone_flight', id: 1, mode: 'manual' }]],
  [40, [{ type: 'drone_stick', id: 1, x: 0.6, y: -0.8, z: 0.2 }]],
  [300, [{ type: 'node_move', id: 4, x: -600, y: 40 }]],
  [520, [{ type: 'drone_stick', id: 1, x: 0, y: 0, z: 0 }]],
]);

function runTicks(r: Runner, ticks: number, ops: Schedule): void {
  while (r.tick < ticks) {
    for (const op of ops.get(r.tick) ?? []) r.apply(op);
    r.stepTick();
  }
}

// Drive the clock with wall-clock frames, applying ops at exact ticks, until endTick.
function runFrames(r: Runner, frameMs: number, endTick: number, ops: Schedule): void {
  while (r.tick < endTick) {
    const n = r.clock.ticksFor(frameMs);
    for (let i = 0; i < n && r.tick < endTick; i++) {
      for (const op of ops.get(r.tick) ?? []) r.apply(op);
      r.stepTick();
    }
  }
}

describe('fixed-step clock', () => {
  it('turns wall time into whole 10 ms ticks, scaled by speed', () => {
    const c = new SimClock();
    c.playing = true;
    c.setSpeed(2);
    expect(c.ticksFor(TICK_MS * 3)).toBe(6);
    c.setSpeed(0.25);
    expect(c.ticksFor(40)).toBe(1);
    expect(c.ticksFor(40)).toBe(1);
  });

  it('does not advance while paused', () => {
    const c = new SimClock();
    expect(c.ticksFor(1000)).toBe(0);
  });

  it('clamps speed to 0.25x to 4x', () => {
    const c = new SimClock();
    c.setSpeed(10);
    expect(c.speed).toBe(4);
    c.setSpeed(0);
    expect(c.speed).toBe(0.25);
  });

  it('same seed and same input log give the same state hash', () => {
    const a = new Runner(scenario);
    const b = new Runner(scenario);
    runTicks(a, 600, schedule);
    runTicks(b, 600, schedule);
    expect(a.tick).toBe(600);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });

  it('different speeds reach the same state at the same sim time', () => {
    const slow = new Runner(scenario);
    slow.clock.playing = true;
    slow.clock.setSpeed(0.25);
    const fast = new Runner(scenario);
    fast.clock.playing = true;
    fast.clock.setSpeed(4);
    runFrames(slow, 10, 300, schedule);
    runFrames(fast, 10, 300, schedule);
    expect(slow.simTimeS).toBeCloseTo(fast.simTimeS, 9);
    expect(hashWorld(slow.world)).toBe(hashWorld(fast.world));
  });

  it('single step advances exactly one tick', () => {
    const r = new Runner(scenario);
    r.clock.playing = true;
    r.stepOnce();
    expect(r.clock.playing).toBe(false);
    expect(r.tick).toBe(1);
  });
});
