import { describe, expect, it } from 'vitest';
import goldenJson from './golden/golden-crossing.json';
import goldenScenario from '../scenarios/golden-crossing.json';
import { bandLevelDb, centroidHz } from '../src/acoustics/dsp';
import { AcousticEngine } from '../src/acoustics/engine';
import { FS } from '../src/acoustics/model';
import { TICK_S } from '../src/sim/clock';
import { Runner } from '../src/sim/runner';
import { parseScenario } from '../src/sim/scenario';

// Written by sim/golden/render.py. Regenerate with: uv run sim/golden/render.py
interface GoldenMic {
  key: string;
  pos: number[];
  delay_s: number[];
  // Mean received blade-pass frequency of the four rotors at each checkpoint, from the delay derivative.
  bpf_hz: number[];
  band_db: number[];
}
interface GoldenFile {
  duration_s: number;
  checkpoints_s: number[];
  mics: GoldenMic[];
}

const golden = goldenJson as GoldenFile;
const WINDOW = 1600;
const DRONE_ID = 1;
// Measurement window around each checkpoint. One second resolves the four rotor lines (2.4 to 3.6 Hz apart) well
// enough that their interference does not pull the centroid, and the Doppler sweep across it (under 7 Hz at closest
// approach) stays inside the half-width of the band the centroid is taken over.
const BPF_WINDOW_S = 0.25; // must match BPF_WINDOW_S in sim/golden/render.py
const BPF_HALF_HZ = 15;

// Received blade-pass frequency measured from the audio: power centroid of the window around the checkpoint.
function measuredBpf(x: Float32Array, t: number, expected: number): number {
  const half = Math.round((BPF_WINDOW_S / 2) * FS);
  const c = Math.round(t * FS);
  return centroidHz(x.subarray(c - half, c + half), expected - BPF_HALF_HZ, expected + BPF_HALF_HZ);
}

describe('golden: TypeScript engine against the Python renderer', () => {
  const scn = parseScenario(goldenScenario);
  const runner = new Runner(scn);
  const engine = new AcousticEngine(scn, runner.world.terrain, { ringSeconds: golden.duration_s + 1 });
  engine.start(runner.world);
  const ticks = Math.round(golden.duration_s / TICK_S);
  while (runner.tick < ticks) {
    runner.stepTick();
    engine.tick(runner.world);
  }

  it('renders the same mics as the golden file', () => {
    expect(engine.micKeys().sort()).toEqual(golden.mics.map((m) => m.key).sort());
  });

  for (const g of golden.mics) {
    it(`mic ${g.key}: band levels within 0.5 dB, delays within 20 us, measured BPF within 0.1 %`, () => {
      const x = engine.output(g.key);
      expect(g.band_db.length).toBe(x.length / WINDOW);
      g.band_db.forEach((ref, k) => {
        const level = bandLevelDb(x.subarray(k * WINDOW, (k + 1) * WINDOW), 100, 4000);
        expect(Math.abs(level - ref), `window ${k}`).toBeLessThan(0.5);
      });
      golden.checkpoints_s.forEach((t, i) => {
        const delay = engine.directDelay(DRONE_ID, g.key, t);
        expect(Math.abs(delay - g.delay_s[i]), `delay at ${t} s`).toBeLessThan(20e-6);
        const bpf = measuredBpf(x, t, g.bpf_hz[i]);
        expect(Math.abs(bpf / g.bpf_hz[i] - 1), `BPF at ${t} s, measured ${bpf.toFixed(2)} Hz`).toBeLessThan(1e-3);
      });
    });
  }
});
