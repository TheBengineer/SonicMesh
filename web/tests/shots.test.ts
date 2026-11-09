import { describe, expect, it } from 'vitest';
import { ImpulseDetector, type SampleSource } from '../src/detector/impulse';
import { renderShot, SHOT_FIT, SHOT_PEAK_DB_1M, shotRng } from '../src/acoustics/shot';
import { FS, REF_PA } from '../src/acoustics/model';
import { everyTicks, isShotTick, lastShotTick, rangeClearing, RANGE_BERM_M, shooterState } from '../src/sim/shots';
import { createRng as rng0 } from '../src/sim/rng';
import { placeTrees } from '../src/sim/terrain';
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
