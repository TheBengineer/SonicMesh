import { describe, expect, it } from 'vitest';
import { ImpulseDetector, type SampleSource } from '../src/detector/impulse';
import { renderShot, SHOT_FIT, SHOT_PEAK_DB_1M, shotRng } from '../src/acoustics/shot';
import { FS, REF_PA } from '../src/acoustics/model';
import { everyTicks, isShotTick, lastShotTick, oneOffState, rangeClearing, RANGE_BERM_M, shooterState, shotStartingAt, shotTick } from '../src/sim/shots';
import { createRng as rng0 } from '../src/sim/rng';
import { placeTrees } from '../src/sim/terrain';
import { parseScenario } from '../src/sim/scenario';
import exampleScenario from '../scenarios/example.json';
import { createRng } from '../src/sim/rng';
import { gauss } from '../src/acoustics/dsp';
import { Terrain } from '../src/sim/terrain';
import { applyOp, createWorld, hashWorld, stepWorld } from '../src/sim/world';
import { AcousticEngine } from '../src/acoustics/engine';
import { Runner } from '../src/sim/runner';

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
  const spec = { id: 1, kind: 'range' as const, x: 0, y: 0, every_s: 4 };

  it('fires about every interval, each shot somewhere within its slot, with an irregular gap', () => {
    const s = shooterState(spec, 100, 5);
    const E = everyTicks(4);
    expect(E).toBe(400);
    const ticks = Array.from({ length: 60 }, (_, k) => shotTick(s, k));
    ticks.forEach((t, k) => {
      expect(t).toBeGreaterThanOrEqual(100 + (k + 0.1) * E);
      expect(t).toBeLessThanOrEqual(100 + (k + 0.9) * E);
      expect(isShotTick(s, t)).toBe(true);
    });
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
    expect(Math.min(...gaps)).toBeLessThan(E * 0.8);
    expect(Math.max(...gaps)).toBeGreaterThan(E * 1.2);
  });

  it('draws the same cadence for the same seed, and a different one for another seed', () => {
    const a = Array.from({ length: 20 }, (_, k) => shotTick(shooterState(spec, 0, 5), k));
    const b = Array.from({ length: 20 }, (_, k) => shotTick(shooterState(spec, 0, 5), k));
    const c = Array.from({ length: 20 }, (_, k) => shotTick(shooterState(spec, 0, 6), k));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('reports the latest shot that has started, matching a brute-force search', () => {
    const s = shooterState(spec, 100, 5);
    const all = Array.from({ length: 60 }, (_, k) => shotTick(s, k));
    expect(lastShotTick(s, 50)).toBeNull();
    for (let tick = 100; tick < 2000; tick += 7) {
      const started = all.filter((t) => t <= tick);
      expect(lastShotTick(s, tick)).toBe(started.length ? Math.max(...started) : null);
    }
  });

  it('a one-off shot fires once, at its tick', () => {
    const s = oneOffState(3, 10, 20, 250, 5);
    expect(shotStartingAt(s, 250)).toBe(0);
    expect(shotStartingAt(s, 251)).toBeNull();
    expect(lastShotTick(s, 1000)).toBe(250);
  });
});

describe('shot waveform', () => {
  it('peaks near the stated level at 1 m, with per-shot gain varied by a few dB', () => {
    const peaks = [1, 2, 3, 4, 5].map((k) => {
      const w = renderShot(shotRng(7, 1, k));
      return Math.max(...Array.from(w, Math.abs));
    });
    const nominal = REF_PA * 10 ** (SHOT_PEAK_DB_1M / 20);
    for (const p of peaks) {
      const db = 20 * Math.log10(p / nominal);
      expect(db).toBeGreaterThan(-4);
      expect(db).toBeLessThan(4);
    }
  });

  it('is deterministic for the same shot and different for the next one', () => {
    const a = renderShot(shotRng(7, 1, 3));
    const b = renderShot(shotRng(7, 1, 3));
    const c = renderShot(shotRng(7, 1, 4));
    expect(Array.from(a.slice(0, 500))).toEqual(Array.from(b.slice(0, 500)));
    expect(Array.from(a.slice(0, 500))).not.toEqual(Array.from(c.slice(0, 500)));
  });

  it('has died away by its last 10 ms, so it does not end in a click', () => {
    const w = renderShot(rng0(13));
    const pk = Math.max(...Array.from(w, Math.abs));
    const tail = w.slice(w.length - Math.round(0.01 * FS));
    const rms = Math.sqrt(tail.reduce((s, v) => s + v * v, 0) / tail.length);
    expect(20 * Math.log10(rms / pk)).toBeLessThan(-60);
  });

  it('decays with a t30 close to the recordings (about 0.6 s)', () => {
    const w = renderShot(rng0(11));
    const pk = Math.max(...Array.from(w, Math.abs));
    const win = Math.round(0.005 * FS);
    let t30 = NaN;
    for (let i = Math.round(0.02 * FS); i < w.length; i++) {
      let e = 0;
      for (let j = i - win; j < i; j++) e += w[j] * w[j];
      const db = 10 * Math.log10(e / win / (pk * pk) + 1e-15);
      if (db < -30) {
        t30 = i / FS;
        break;
      }
    }
    expect(t30).toBeGreaterThan(0.4);
    expect(t30).toBeLessThan(0.8);
    expect(SHOT_FIT.tailRt60S).toBeGreaterThan(0);
  });
});

describe('range clearing', () => {
  it('keeps trees out of the range footprint', () => {
    const scn = parseScenario(exampleScenario);
    const range = scn.shooters?.[0];
    expect(range).toBeDefined();
    const terrain = new Terrain(scn.seed, scn.terrain);
    const c = rangeClearing(range!);
    expect(c).not.toBeNull();
    const inside = placeTrees(terrain, [c!]).filter((t) => t.x > c!.x0 && t.x < c!.x1 && t.y > c!.y0 && t.y < c!.y1);
    expect(inside).toEqual([]);
    // the berm sits inside the clearing
    expect(range!.y - RANGE_BERM_M).toBeGreaterThan(c!.y0);
  });

  it('does not clear anything for a shooter placed on the map', () => {
    expect(rangeClearing({ kind: 'shooter', x: 0, y: 0 })).toBeNull();
  });
});

describe('impulse detector', () => {
  it('finds one onset at a shot and nothing in quiet noise', () => {
    const rng = createRng(7);
    const n = FS * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 1e-4 * gauss(rng);
    const at = FS; // a shot at one second
    const w = renderShot(rng0(5));
    for (let i = 0; i < w.length; i++) x[at + i] += w[i] * 0.1;
    const onsets = new ImpulseDetector().step(ringOf(x));
    expect(onsets.length).toBe(1);
    expect(Math.abs(onsets[0] - at)).toBeLessThanOrEqual(16);
  });

  it('finds two shots a second apart, so one shot\'s tail does not hide the next', () => {
    const rng = createRng(7);
    const n = FS * 3;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 1e-4 * gauss(rng);
    for (const at of [FS, 2 * FS]) {
      const w = renderShot(rng0(at));
      for (let i = 0; i < w.length && at + i < n; i++) x[at + i] += w[i] * 0.1;
    }
    const onsets = new ImpulseDetector().step(ringOf(x));
    expect(onsets.length).toBe(2);
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
    expect(scn.shooters?.[0]).toMatchObject({ kind: 'range', every_s: 12 });
  });

  it('rejects a shooter that never fires', () => {
    expect(() => parseScenario({ ...exampleScenario, shooters: [{ id: 2, kind: 'shooter', x: 0, y: 0, every_s: 0 }] })).toThrow(/every_s/);
  });
});

describe('shooter ops', () => {
  it('a click fires one shot, and the shooter is gone once its sound has finished', () => {
    const scn = parseScenario(exampleScenario);
    const world = createWorld(scn, new Terrain(scn.seed, scn.terrain));
    world.state.tick = 250;
    applyOp(world, { type: 'shot_fire', id: 9, x: 10, y: 20 });
    expect(world.state.shooters.find((sh) => sh.id === 9)).toMatchObject({ once: true, t0: 250, x: 10, y: 20 });
    for (let i = 0; i < 1000; i++) stepWorld(world);
    expect(world.state.shooters.some((sh) => sh.id === 9)).toBe(false);
  });

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

describe('shot audio at a mic', () => {
  it('keeps the reverb tail after the crack, not just the first block', () => {
    const scn = parseScenario({ ...exampleScenario, shooters: [], drones: [] });
    const runner = new Runner(scn);
    const engine = new AcousticEngine(scn, runner.world.terrain, { ringSeconds: 25 });
    // A one-off shot at tick 0, about 160 m from node 10, so its crack reaches the mic about 0.5 s in.
    applyOp(runner.world, { type: 'shot_fire', id: 1, x: 420, y: -200 });
    engine.start(runner.world);
    for (let i = 0; i < 210; i++) {
      runner.stepTick();
      engine.tick(runner.world);
    }
    const x = engine.output('10.0');
    const level = (t: number): number => {
      const a = Math.round(t * FS);
      let s = 0;
      for (let j = a; j < a + 160; j++) s += x[j] * x[j];
      return 10 * Math.log10(s / 160 + 1e-30);
    };
    // Just after the crack the tail should still be well above the level 1.5 s later.
    expect(level(0.6)).toBeGreaterThan(level(2.0) + 15);
  });
});
