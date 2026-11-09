import { describe, expect, it } from 'vitest';
import { ImpulseDetector, type SampleSource } from '../src/detector/impulse';
import { shotWave, SHOT_PEAK_DB_1M } from '../src/acoustics/shot';
import { FS, REF_PA } from '../src/acoustics/model';
import { everyTicks, isShotTick, lastShotTick, shooterState } from '../src/sim/shots';
import { parseScenario } from '../src/sim/scenario';
import exampleScenario from '../scenarios/example.json';
import { createRng } from '../src/sim/rng';
import { gauss } from '../src/acoustics/dsp';
import { Terrain } from '../src/sim/terrain';
import { applyOp, createWorld, hashWorld } from '../src/sim/world';

// A fixed buffer shaped like a mic ring: samples are read by absolute index.
function ringOf(samples: Float32Array): SampleSource {
  return {
    written: samples.length,
    capacity: samples.length,
    read(start, out) {
      if (start < 0 || start + out.length > samples.length) return false;
      out.set(samples.subarray(start, start + out.length));
      return true;
    },
  };
}

describe('shot schedule', () => {
  it('fires on the first tick and then every interval', () => {
    const s = shooterState({ id: 1, kind: 'range', x: 0, y: 0, every_s: 4 }, 100);
    expect(everyTicks(4)).toBe(400);
    expect(isShotTick(s, 99)).toBe(false);
    expect(isShotTick(s, 100)).toBe(true);
    expect(isShotTick(s, 499)).toBe(false);
    expect(isShotTick(s, 500)).toBe(true);
  });

  it('reports the latest shot that has started', () => {
    const s = shooterState({ id: 1, kind: 'range', x: 0, y: 0, every_s: 4 }, 100);
    expect(lastShotTick(s, 50)).toBeNull();
    expect(lastShotTick(s, 100)).toBe(100);
    expect(lastShotTick(s, 650)).toBe(500);
  });
});

describe('shot waveform', () => {
  it('peaks at the stated level at 1 m', () => {
    const w = shotWave();
    let peak = 0;
    for (const v of w) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(REF_PA * 10 ** (SHOT_PEAK_DB_1M / 20), 6);
  });
});

describe('impulse detector', () => {
  it('finds one onset at a shot and nothing in quiet noise', () => {
    const rng = createRng(7);
    const n = FS * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 1e-4 * gauss(rng);
    const at = FS; // a shot at one second
    const w = shotWave();
    for (let i = 0; i < w.length; i++) x[at + i] += w[i] * 0.1;
    const onsets = new ImpulseDetector().step(ringOf(x));
    expect(onsets.length).toBe(1);
    expect(Math.abs(onsets[0] - at)).toBeLessThanOrEqual(16);
  });

  it('finds nothing in a steady drone-like tone', () => {
    const rng = createRng(9);
    const x = new Float32Array(FS * 2);
    for (let i = 0; i < x.length; i++) {
      x[i] = 0.5 * Math.sin((2 * Math.PI * 600 * i) / FS) + 0.2 * Math.sin((2 * Math.PI * 1200 * i) / FS) + 0.01 * gauss(rng);
    }
    expect(new ImpulseDetector().step(ringOf(x))).toEqual([]);
  });

  it('finds nothing in silence or steady noise', () => {
    const rng = createRng(8);
    const x = new Float32Array(FS * 2);
    for (let i = 0; i < x.length; i++) x[i] = 1e-4 * gauss(rng);
    expect(new ImpulseDetector().step(ringOf(x))).toEqual([]);
  });
});

describe('scenario shooters', () => {
  it('parses the example range', () => {
    const scn = parseScenario(exampleScenario);
    expect(scn.shooters?.[0]).toMatchObject({ kind: 'range', every_s: 4 });
  });

  it('rejects a shooter that never fires', () => {
    expect(() => parseScenario({ ...exampleScenario, shooters: [{ id: 2, kind: 'shooter', x: 0, y: 0, every_s: 0 }] })).toThrow(/every_s/);
  });
});

describe('shooter ops', () => {
  it('adds and removes a shooter, starting its schedule at the tick it was added', () => {
    const scn = parseScenario(exampleScenario);
    const world = createWorld(scn, new Terrain(scn.seed, scn.terrain));
    world.state.tick = 250;
    applyOp(world, { type: 'shooter_add', shooter: { id: 9, kind: 'shooter', x: 10, y: 20, every_s: 4 } });
    const added = world.state.shooters.find((sh) => sh.id === 9);
    expect(added).toMatchObject({ t0: 250, everyTicks: 400, x: 10, y: 20 });
    const before = hashWorld(world);
    applyOp(world, { type: 'shooter_add', shooter: { id: 9, kind: 'shooter', x: 99, y: 99, every_s: 4 } });
    expect(hashWorld(world)).toBe(before);
    applyOp(world, { type: 'shooter_remove', id: 9 });
    expect(world.state.shooters.some((sh) => sh.id === 9)).toBe(false);
  });
});
