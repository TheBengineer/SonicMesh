// Sim worker. Owns the world, the clock and the acoustic engine. Ticks come from a timer, not from requestAnimationFrame,
// so the sim keeps running in a hidden tab. Replay is exact because the world only ever sees ticks and logged ops.
import { AcousticEngine } from '../acoustics/engine';
import { TICK_S } from './clock';
import { Runner } from './runner';
import { RING_SECONDS, type Frame, type FromWorker, type InspectRequest, type ToWorker } from './protocol';

const LOOP_MS = 10;
const MAX_WALL_MS = 250;
const ROTOR_SECONDS = 5;
const ROTOR_DT = 0.05;
const SPECTRUM_EVERY_MS = 500;

type Batch = { key: string; block: Float32Array }[];

const shared = self.crossOriginIsolated === true;
let runner: Runner | null = null;
let engine: AcousticEngine | null = null;
let micKeys = new Set<string>();
let inspect: InspectRequest = { drone: null, mics: [], truthKey: null };
let msAvg = 0;
let spectrum: { id: number; binHz: number; db: number[] } | null = null;
let spectrumAt = -Infinity;
let lastLoop = performance.now();

function post(msg: FromWorker, transfer: ArrayBuffer[] = []): void {
  self.postMessage(msg, { transfer });
}

function startEngine(): void {
  if (!runner) return;
  engine = new AcousticEngine(runner.scenario, runner.world.terrain, { ringSeconds: RING_SECONDS, shared });
  engine.start(runner.world);
  micKeys = new Set();
  spectrum = null;
  post({ t: 'reset' });
  syncMics();
}

// Tells the page about mics that appeared or went away. With shared memory the page gets the buffers once.
function syncMics(): void {
  if (!engine) return;
  const keys = new Set(engine.micKeys());
  for (const key of keys) {
    if (micKeys.has(key)) continue;
    const ring = engine.micRing(key);
    const buffers = shared && ring ? { data: ring.data.buffer as SharedArrayBuffer, ctr: ring.ctr.buffer as SharedArrayBuffer } : null;
    post({ t: 'mic', key, shared: buffers });
  }
  for (const key of micKeys) if (!keys.has(key)) post({ t: 'mic-del', key });
  micKeys = keys;
}

function advance(batch: Batch): void {
  if (!runner || !engine) return;
  const t0 = performance.now();
  runner.stepTick();
  engine.tick(runner.world);
  const dt = performance.now() - t0;
  msAvg = msAvg === 0 ? dt : 0.9 * msAvg + 0.1 * dt;
  syncMics();
  if (shared) return;
  for (const key of inspect.mics) {
    const ring = engine.micRing(key);
    if (ring) batch.push({ key, block: ring.lastBlock() });
  }
}

function flush(batch: Batch): void {
  if (batch.length === 0) return;
  post({ t: 'blocks', items: batch }, batch.map((b) => b.block.buffer as ArrayBuffer));
}

function buildFrame(): Frame | null {
  if (!runner || !engine) return null;
  const s = runner.world.state;
  const t = s.tick * TICK_S;
  const frame: Frame = {
    tick: s.tick,
    simTimeS: t,
    playing: runner.clock.playing,
    speed: runner.clock.speed,
    pending: runner.pending,
    logLength: runner.log.length,
    msPerTick: msAvg,
    state: s,
    rotors: null,
    spectrum: null,
    truth: null,
  };
  const id = inspect.drone;
  if (id !== null && engine.hasDrone(id)) {
    frame.rotors = { id, ...engine.rotorTrace(id, ROTOR_SECONDS, ROTOR_DT) };
    if (spectrum?.id !== id || performance.now() - spectrumAt >= SPECTRUM_EVERY_MS) {
      spectrum = { id, ...engine.emittedSpectrum(id) };
      spectrumAt = performance.now();
    }
    frame.spectrum = spectrum?.id === id ? spectrum : null;
  }
  const key = inspect.truthKey;
  if (key !== null && s.truth && engine.hasMic(key)) {
    const lines = s.drones
      .filter((d) => engine?.hasDrone(d.id))
      .map((d) => ({ id: d.id, hz: engine?.truthBpf(d.id, key, t) ?? [] }));
    frame.truth = { key, t, lines };
  }
  return frame;
}

function guarded(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

setInterval(() => {
  const now = performance.now();
  const wall = Math.min(now - lastLoop, MAX_WALL_MS);
  lastLoop = now;
  guarded(() => {
    if (!runner) return;
    const batch: Batch = [];
    const n = runner.clock.ticksFor(wall);
    for (let i = 0; i < n; i++) advance(batch);
    flush(batch);
    const frame = buildFrame();
    if (frame) post({ t: 'frame', frame });
  });
}, LOOP_MS);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  guarded(() => {
    switch (m.t) {
      case 'load':
        runner = new Runner(m.scenario, m.log);
        startEngine();
        break;
      case 'op':
        runner?.apply(m.op);
        break;
      case 'play':
        if (runner) runner.clock.playing = m.on;
        break;
      case 'speed':
        runner?.clock.setSpeed(m.speed);
        break;
      case 'step': {
        if (!runner) break;
        runner.clock.playing = false;
        const batch: Batch = [];
        advance(batch);
        flush(batch);
        break;
      }
      case 'reset':
        if (runner) {
          runner.reset();
          startEngine();
        }
        break;
      case 'inspect':
        inspect = m.req;
        break;
      case 'export':
        if (runner) post({ t: 'export', id: m.id, scenario: runner.scenario, log: runner.log });
        break;
    }
  });
};
