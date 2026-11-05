import { describe, expect, it } from 'vitest';
import exampleScenario from '../scenarios/example.json';
import { fft, hann } from '../src/acoustics/dsp';
import { AcousticEngine } from '../src/acoustics/engine';
import { FS, REF_PA } from '../src/acoustics/model';
import { BandTracer } from '../src/audio/bandTrace';
import { WF_BINS, WF_HOP, WF_N } from '../src/audio/analysis';
import { Runner } from '../src/sim/runner';
import { parseScenario } from '../src/sim/scenario';
import { traceRuns } from '../src/ui/detectMarks';

const BIN_HZ = FS / WF_N;
const WIN = hann(WF_N);
const WIN_SUM = WIN.reduce((s, v) => s + v, 0);

function lines(tracks: readonly number[]): number[] {
  return tracks.filter((hz) => hz > 0);
}

function noisy(i: number, k: number): number {
  return 60 + ((Math.imul(i * 977 + k, 2654435761) >>> 24) % 8);
}

describe('harmonic band tracer', () => {
  it('stays unlocked on noise alone', () => {
    const tracer = new BandTracer(WF_BINS, BIN_HZ);
    const column = new Uint8Array(WF_BINS);
    for (let i = 0; i < 300; i++) {
      for (let k = 0; k < WF_BINS; k++) column[k] = noisy(i, k);
      expect(lines(tracer.push(column))).toEqual([]);
    }
  });

  it('follows a drifting set of harmonics, then lets go when they stop', () => {
    const tracer = new BandTracer(WF_BINS, BIN_HZ);
    const column = new Uint8Array(WF_BINS);
    const f0 = (i: number): number => 600 * (1 + 0.05 * Math.sin(i / 60));
    const seen: number[] = [];
    for (let i = 0; i < 300; i++) {
      for (let k = 0; k < WF_BINS; k++) column[k] = noisy(i, k);
      for (let h = 1; h <= 6; h++) {
        const b = Math.round((h * f0(i)) / BIN_HZ);
        for (let d = -1; d <= 1; d++) column[b + d] = 110;
      }
      const [hz] = lines(tracer.push(column));
      if (hz !== undefined && i > 40) {
        seen.push(hz);
        expect(Math.abs(hz - 4 * f0(i)) / (4 * f0(i))).toBeLessThan(0.03);
      }
    }
    expect(seen.length).toBeGreaterThan(200);
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(100);
    let last = [1];
    for (let i = 300; i < 340; i++) {
      for (let k = 0; k < WF_BINS; k++) column[k] = noisy(i, k);
      last = lines(tracer.push(column));
    }
    expect(last).toEqual([]);
  });

  it('gives two drones two lines, each on its own harmonics', () => {
    const tracer = new BandTracer(WF_BINS, BIN_HZ);
    const column = new Uint8Array(WF_BINS);
    let both = 0;
    for (let i = 0; i < 200; i++) {
      for (let k = 0; k < WF_BINS; k++) column[k] = noisy(i, k);
      for (const f0 of [600, 250]) {
        for (let h = 1; h * f0 < 3900; h++) {
          const b = Math.round((h * f0) / BIN_HZ);
          for (let d = -1; d <= 1; d++) column[b + d] = 110;
        }
      }
      const found = lines(tracer.push(column));
      if (found.length !== 2) continue;
      both++;
      for (const [hz, f0] of [[found[0], 600], [found[1], 250]]) {
        const h = Math.round(hz / f0);
        expect(Math.abs(hz - h * f0) / (h * f0)).toBeLessThan(0.02);
      }
    }
    expect(both).toBeGreaterThan(150);
  });

  it('traces the 4th harmonic of the example FPV in simulated audio', () => {
    const scn = parseScenario({ ...exampleScenario, drones: exampleScenario.drones.slice(0, 1) });
    const runner = new Runner(scn);
    const engine = new AcousticEngine(scn, runner.world.terrain, { ringSeconds: 25 });
    engine.start(runner.world);
    const key = '7.0';
    const id = runner.world.state.drones[0].id;
    const tracer = new BandTracer(WF_BINS, BIN_HZ);
    const frame = new Float32Array(WF_N);
    const re = new Float64Array(WF_N);
    const im = new Float64Array(WF_N);
    const column = new Uint8Array(WF_BINS);
    const errors: number[] = [];
    const harmonics = new Set<number>();
    let cursor = 0;
    let extra = 0;
    for (let i = 0; i < 5000; i++) {
      runner.stepTick();
      engine.tick(runner.world);
      const ring = engine.micRing(key)!;
      while (cursor + WF_N <= ring.written) {
        ring.read(cursor, frame);
        for (let j = 0; j < WF_N; j++) {
          re[j] = frame[j] * WIN[j];
          im[j] = 0;
        }
        fft(re, im);
        for (let k = 0; k < WF_BINS; k++) {
          const p = re[k] * re[k] + im[k] * im[k];
          const db = 10 * Math.log10(Math.max((2 * p) / (WIN_SUM * WIN_SUM), 1e-30) / (REF_PA * REF_PA));
          column[k] = Math.round(255 * Math.min(1, Math.max(0, (db - 10) / 80)));
        }
        cursor += WF_HOP;
        const found = lines(tracer.push(column));
        extra += Math.max(0, found.length - 1);
        const hz = found[0];
        if (hz === undefined) continue;
        const rotors = engine.truthBpf(id, key, runner.simTimeS);
        const mean = rotors.reduce((a, b) => a + b, 0) / rotors.length;
        harmonics.add(Math.round(hz / mean));
        errors.push(Math.abs(hz / (4 * mean) - 1));
      }
    }
    errors.sort((a, b) => a - b);
    expect(errors.length).toBeGreaterThan(300);
    expect([...harmonics]).toEqual([4]);
    expect(errors[errors.length >> 1]).toBeLessThan(0.025);
    // one drone should give one line nearly all the time
    expect(extra / errors.length).toBeLessThan(0.05);
  }, 60_000);
});

describe('where the traced line shows', () => {
  const span = { x0: 2, x1: 6, start: true, end: true, lineHz: null };

  it('only where a band is locked and the node detects', () => {
    expect(traceRuns([9, 9, 9, 9, 0, 9, 9, 9, 9], [span])).toEqual([[2, 3], [5, 6]]);
  });

  it('nowhere with no detection', () => {
    expect(traceRuns([9, 9, 9], [])).toEqual([]);
  });
});
