import { describe, expect, it } from 'vitest';
import exampleScenario from '../scenarios/example.json';
import goldenScenario from '../scenarios/golden-crossing.json';
import { powerSpectrum } from '../src/acoustics/dsp';
import { AcousticEngine } from '../src/acoustics/engine';
import { AudioRing, PoseLog, RotorLog, SampleRing, type Vec3 } from '../src/acoustics/history';
import { BLOCK, FS, REF_PA } from '../src/acoustics/model';
import { AIR_TAPS, AirFilter, absDbPerKm, barrierGain, renderPath } from '../src/acoustics/propagate';
import { TICK_S } from '../src/sim/clock';
import { Runner } from '../src/sim/runner';
import { parseScenario } from '../src/sim/scenario';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

// Stationary or constant-velocity drone along x; the mic sits at the origin.
function logOf(x0: number, vx: number, ticks: number): PoseLog {
  const log = new PoseLog();
  for (let k = 0; k <= ticks; k++) log.push(k, { x: x0 + vx * k * TICK_S, y: 0, alt: 0, vz: 0 });
  return log;
}

function toneRing(hz: number, seconds: number): SampleRing {
  const src = new SampleRing(1 << 19);
  for (let n = 0; n < seconds * FS; n++) src.put(n, Math.sin((2 * Math.PI * hz * n) / FS));
  return src;
}

// Renders blocks [from, to) of one path and returns the samples.
function render(src: SampleRing, log: PoseLog, from: number, to: number, mirrorZ: number | null = null): Float64Array {
  const out = new Float64Array((to - from) * BLOCK);
  const block = new Float64Array(BLOCK);
  const air = new AirFilter();
  for (let k = from; k < to; k++) {
    block.fill(0);
    renderPath(block, k * BLOCK, src, log, ORIGIN, mirrorZ, 1, air);
    out.set(block, (k - from) * BLOCK);
  }
  return out;
}

describe('propagation', () => {
  it('a stationary tone at 1 km gets 1/r spreading and the 1 kHz air absorption', () => {
    const log = logOf(1000, 0, 500);
    const rec = render(toneRing(1000, 6), log, 400, 500);
    const rms = Math.sqrt(rec.reduce((s, v) => s + v * v, 0) / rec.length);
    const expected = (10 ** (-3.7 / 20) / 1000) / Math.SQRT2;
    expect(Math.abs(rms / expected - 1)).toBeLessThan(0.02);
  });

  it('a source moving at 20 m/s straight at the mic is heard at f c / (c - v)', () => {
    const log = logOf(1000, -20, 500);
    const rec = render(toneRing(600, 7), log, 400, 500);
    const n = 1 << 16;
    const ps = powerSpectrum(rec, n);
    let best = 1;
    for (let i = 1; i < ps.length; i++) if (ps[i] > ps[best]) best = i;
    const f = (best * FS) / n;
    expect(Math.abs(f / ((600 * 343) / 323) - 1)).toBeLessThan(0.001);
  });

  it('a ridge across the path adds barrier loss; a ridge below the line of sight adds none', () => {
    const src = { x: 0, y: 0, z: 10 };
    const rx = { x: 200, y: 0, z: 1.5 };
    const ridge = (h: number) => ({ height: (x: number) => (Math.abs(x - 100) < 20 ? h : 0) });
    expect(barrierGain(ridge(2), src, rx)).toBe(1);
    const low = barrierGain(ridge(30), src, rx);
    const high = barrierGain(ridge(60), src, rx);
    expect(low).toBeLessThan(1);
    expect(high).toBeLessThan(low);
  });
});

describe('air absorption', () => {
  // Magnitude response in dB of the taps at frequency hz, from the DTFT of the FIR.
  function responseDb(taps: Float64Array, hz: number): number {
    let re = 0;
    let im = 0;
    for (let k = 0; k < taps.length; k++) {
      const w = (2 * Math.PI * hz * k) / FS;
      re += taps[k] * Math.cos(w);
      im -= taps[k] * Math.sin(w);
    }
    return 20 * Math.log10(Math.hypot(re, im));
  }

  it('matches the ISO 9613-1 table within 1 dB from 100 Hz to 4 kHz at 1 km and at 300 m', () => {
    for (const r of [1000, 300]) {
      const f = new AirFilter();
      f.setDistance(r);
      const taps = new Float64Array(AIR_TAPS);
      for (let k = 0; k < AIR_TAPS; k++) taps[k] = f.process(k === 0 ? 1 : 0);
      for (let hz = 100; hz <= 4000; hz += 50) {
        const target = (-absDbPerKm(hz) * r) / 1000;
        expect(Math.abs(responseDb(taps, hz) - target), `${hz} Hz at ${r} m`).toBeLessThan(1);
      }
    }
  });
});

describe('shared audio ring and rotor log', () => {
  it('reads back written blocks and forgets blocks older than the capacity', () => {
    const ring = new AudioRing(new Float32Array(2 * BLOCK), new Int32Array(1));
    for (let b = 1; b <= 3; b++) ring.write(new Float64Array(BLOCK).fill(b));
    const out = new Float32Array(BLOCK);
    expect(ring.read(0, out)).toBe(false);
    expect(ring.read(BLOCK, out)).toBe(true);
    expect(out[0]).toBe(2);
    expect(ring.read(2 * BLOCK, out)).toBe(true);
    expect(out[BLOCK - 1]).toBe(3);
  });

  it('interpolates rotor frequencies between ticks', () => {
    const log = new RotorLog();
    log.push(0, [100, 200, 300, 400]);
    log.push(1, [110, 210, 310, 410]);
    expect(log.at(2, TICK_S / 2)).toBeCloseTo(305, 9);
  });
});

function quietScenario(acoustics: Record<string, unknown>, drones: unknown[] = []) {
  return parseScenario({ ...goldenScenario, drones, acoustics });
}

function run(scn: ReturnType<typeof parseScenario>, seconds: number): AcousticEngine {
  const runner = new Runner(scn);
  const engine = new AcousticEngine(scn, runner.world.terrain, { ringSeconds: seconds + 1 });
  engine.start(runner.world);
  const ticks = Math.round(seconds / TICK_S);
  while (runner.tick < ticks) {
    runner.stepTick();
    engine.tick(runner.world);
  }
  return engine;
}

function rmsOf(x: Float32Array): number {
  return Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
}

describe('noise and plumbing', () => {
  it('mic self-noise is 29 dB SPL', () => {
    const scn = quietScenario({ self_noise: true, ambient_db_spl: null, wobble: false, broadband: false });
    const engine = run(scn, 2);
    const db = 20 * Math.log10(rmsOf(engine.output('1.0')) / (REF_PA * 10 ** (29 / 20)));
    expect(Math.abs(db)).toBeLessThan(0.5);
  });

  it('ambient pink noise follows the set level', () => {
    const scn = quietScenario({ self_noise: false, ambient_db_spl: 40, wobble: false, broadband: false });
    const engine = run(scn, 2);
    const db = 20 * Math.log10(rmsOf(engine.output('1.0')) / (REF_PA * 10 ** (40 / 20)));
    expect(Math.abs(db)).toBeLessThan(1);
  });

  it('the same scenario renders bit-identical audio twice, with wobble and broadband on', () => {
    const scn = parseScenario(exampleScenario);
    const a = run(scn, 0.5);
    const b = run(scn, 0.5);
    for (const key of a.micKeys()) expect(Array.from(b.output(key)), key).toEqual(Array.from(a.output(key)));
  });

  it('defaults to all acoustic switches on when a scenario has no acoustics block', () => {
    expect(parseScenario(exampleScenario).acoustics).toEqual({ self_noise: true, ambient_db_spl: 40, wobble: true, broadband: true });
  });
});
