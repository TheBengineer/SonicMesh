import { TICK_S } from '../sim/clock';
import { createRng, type Rng } from '../sim/rng';
import type { DroneClass, ScenarioFile } from '../sim/scenario';
import type { Terrain } from '../sim/terrain';
import { SHOOTER_H_M, shotStartingAt, type ShooterState } from '../sim/shots';
import type { World } from '../sim/world';
import { bandLevelDb, gauss, hann, powerSpectrum } from './dsp';
import { AudioRing, PoseLog, RotorLog, SampleRing, type Vec3 } from './history';
import { ARRAY_HALF_M, ARRAY_MIC_H_M, BLOCK, DETECTOR_MIC_H_M, FS, GROUND_GAMMA, REF_PA, SELF_NOISE_DB } from './model';
import { AirFilter, barrierGain, renderPath, solveDelay } from './propagate';
import { renderShot, shotRng } from './shot';
import { DroneSource, PinkNoise } from './sources';

const SOURCE_SAMPLES = 1 << 19;
// A shooter only needs its shots, but a far mic reads a shot seconds after it was fired, so keep 16 s.
const SHOOTER_SAMPLES = 1 << 18;
// Where a microphone stops being linear: about 130 dB SPL, a typical MEMS overload point. Louder sound is squashed.
const MIC_OVERLOAD_PA = REF_PA * 10 ** (130 / 20);
// The mic's squash, applied to every source's sum: drones and shots alike.
export function micOverload(pa: number): number {
  return MIC_OVERLOAD_PA * Math.tanh(pa / MIC_OVERLOAD_PA);
}
const SPECTRUM_N = 2048;
const SPECTRUM_MAX_HZ = 4000;
export const ARRAY_OFFSETS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

export interface EngineOptions {
  ringSeconds?: number;
  // Mic rings in SharedArrayBuffers, for readers on another thread.
  shared?: boolean;
}

interface Drone {
  cls: DroneClass;
  log: PoseLog;
  rotors: RotorLog;
  src: SampleRing;
  model: DroneSource;
}

interface Shooter {
  st: ShooterState;
  log: PoseLog;
  src: SampleRing;
}

interface Mic {
  pos: Vec3;
  ground: number;
  ring: AudioRing;
  rng: Rng;
  pink: PinkNoise | null;
  // Filters per source, keyed by source ("d1", "s2"), so a drone and a shooter with the same id keep apart.
  airs: Map<string, { direct: AirFilter; image: AirFilter }>;
}

// Renders every mic in the scene, one block per tick. Call start() once, then tick() after each world step.
// Ticks must advance by exactly one. Replay stays exact because nothing here reads wall-clock time.
export class AcousticEngine {
  private readonly drones = new Map<number, Drone>();
  private readonly shooters = new Map<number, Shooter>();
  private readonly mics = new Map<string, Mic>();
  private readonly out = new Float64Array(BLOCK);
  private readonly tmp = new Float64Array(BLOCK);
  private readonly factor = new Float64Array(BLOCK);
  private readonly pose: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly selfRms = REF_PA * 10 ** (SELF_NOISE_DB / 20);
  private readonly ambRms: number;
  private readonly ringSeconds: number;
  private readonly shared: boolean;
  private lastTick = -1;

  constructor(
    private readonly scn: ScenarioFile,
    private readonly terrain: Terrain,
    opts: EngineOptions = {},
  ) {
    const amb = scn.acoustics.ambient_db_spl;
    this.ambRms = amb === null ? 0 : REF_PA * 10 ** (amb / 20);
    this.ringSeconds = opts.ringSeconds ?? 10;
    this.shared = opts.shared ?? false;
  }

  start(world: World): void {
    this.lastTick = world.state.tick;
    this.sync(world);
  }

  tick(world: World): void {
    const T = world.state.tick;
    if (this.lastTick < 0 || T !== this.lastTick + 1) {
      throw new Error(`acoustics: tick ${T} does not follow ${this.lastTick}`);
    }
    this.lastTick = T;
    this.sync(world);
    // Block T-1 covers [(T-1), T) ticks. Sources are rendered first so mics can read them.
    const n0 = (T - 1) * BLOCK;
    for (const d of this.drones.values()) {
      for (let i = 0; i < BLOCK; i++) this.factor[i] = d.log.rotorAt((n0 + i) / FS);
      d.model.render(this.tmp, this.factor);
      for (let i = 0; i < BLOCK; i++) d.src.put(n0 + i, this.tmp[i]);
      d.rotors.push(T, d.model.hz);
    }
    // A shot that starts at tick T-1 begins at the first sample of this block.
    for (const sh of this.shooters.values()) {
      // Clear the block first. The ring wraps, so an unwritten sample would otherwise read an old shot's audio.
      for (let i = 0; i < BLOCK; i++) sh.src.put(n0 + i, 0);
      const k = shotStartingAt(sh.st, T - 1);
      if (k === null) continue;
      const wave = renderShot(shotRng(this.scn.seed, sh.st.id, k));
      for (let i = 0; i < wave.length; i++) sh.src.put(n0 + i, wave[i]);
    }
    for (const m of this.mics.values()) this.renderMic(m, n0);
  }

  micKeys(): string[] {
    return [...this.mics.keys()];
  }

  hasMic(key: string): boolean {
    return this.mics.has(key);
  }

  hasDrone(id: number): boolean {
    return this.drones.has(id);
  }

  micRing(key: string): AudioRing | undefined {
    return this.mics.get(key)?.ring;
  }

  // Band level, 100 to 4000 Hz, over the newest 100 ms. Used by the node detection stub.
  bandLevel(key: string, samples = 1600): number {
    const ring = this.mic(key).ring;
    if (ring.written < samples) return -120;
    const buf = new Float32Array(samples);
    if (!ring.read(ring.written - samples, buf)) return -120;
    return bandLevelDb(buf, 100, 4000);
  }

  // Newest audio for the snippet stub, up to max samples.
  audioSnippet(key: string, max: number): Float32Array | null {
    const ring = this.mic(key).ring;
    const n = Math.min(max, ring.written, ring.capacity);
    if (n <= 0) return null;
    const out = new Float32Array(n);
    return ring.read(ring.written - n, out) ? out : null;
  }

  ambientDb(): number {
    return this.scn.acoustics.ambient_db_spl ?? SELF_NOISE_DB;
  }

  // Mic output in pressure (Pa), oldest sample first.
  output(key: string): Float32Array {
    return this.mic(key).ring.snapshot();
  }

  // Direct-path delay in seconds from a drone to a mic at time t.
  directDelay(droneId: number, key: string, t: number): number {
    return solveDelay(this.drone(droneId).log, t, this.mic(key).pos, null);
  }

  // True received blade-pass frequency of each rotor at a mic at time t: the emitted rotor frequency at the
  // emission time, times the Doppler factor (1 - d tau / dt).
  truthBpf(droneId: number, key: string, t: number): number[] {
    const d = this.drone(droneId);
    const h = 1e-3;
    const tau = this.directDelay(droneId, key, t);
    const rate = (this.directDelay(droneId, key, t + h) - this.directDelay(droneId, key, t - h)) / (2 * h);
    const te = t - tau;
    return [0, 1, 2, 3].map((i) => d.rotors.at(i, te) * (1 - rate));
  }

  // Emitted rotor frequencies over the last `seconds`, every dt, flat: [sample * 4 + rotor].
  rotorTrace(droneId: number, seconds: number, dt: number): { tStart: number; dt: number; hz: number[] } {
    const d = this.drone(droneId);
    const n = Math.round(seconds / dt);
    const tNow = Math.max(this.lastTick, 0) * TICK_S;
    const tStart = tNow - (n - 1) * dt;
    const hz = new Array<number>(n * 4);
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < 4; i++) hz[k * 4 + i] = d.rotors.at(i, tStart + k * dt);
    }
    return { tStart, dt, hz };
  }

  // Source spectrum at 1 m over the last SPECTRUM_N samples, dB SPL per bin (line level of a sine in that bin),
  // 0 to 4 kHz.
  emittedSpectrum(droneId: number): { binHz: number; db: number[] } {
    const d = this.drone(droneId);
    const n = SPECTRUM_N;
    const end = Math.max(this.lastTick, 0) * BLOCK;
    const w = hann(n);
    const x = new Float64Array(n);
    let sumW = 0;
    for (let i = 0; i < n; i++) {
      x[i] = d.src.get(end - n + i) * w[i];
      sumW += w[i];
    }
    const ps = powerSpectrum(x, n);
    const bins = Math.round((SPECTRUM_MAX_HZ * n) / FS);
    const db = new Array<number>(bins);
    for (let k = 0; k < bins; k++) {
      const p = (2 * ps[k]) / (sumW * sumW);
      db[k] = 10 * Math.log10(Math.max(p, 1e-30) / (REF_PA * REF_PA));
    }
    return { binHz: FS / n, db };
  }

  private drone(id: number): Drone {
    const d = this.drones.get(id);
    if (!d) throw new Error(`acoustics: no drone ${id}`);
    return d;
  }

  private mic(key: string): Mic {
    const m = this.mics.get(key);
    if (!m) throw new Error(`acoustics: no mic ${key}`);
    return m;
  }

  private renderMic(m: Mic, n0: number): void {
    const out = this.out;
    const settings = this.scn.acoustics;
    out.fill(0);
    for (const [id, d] of this.drones) this.renderSource(m, out, n0, `d${id}`, d.src, d.log);
    for (const [id, sh] of this.shooters) {
      this.renderSource(m, out, n0, `s${id}`, sh.src, sh.log);
    }
    for (let i = 0; i < BLOCK; i++) {
      let v = out[i];
      if (settings.self_noise) v += this.selfRms * gauss(m.rng);
      if (m.pink) v += this.ambRms * m.pink.next();
      out[i] = micOverload(v);
    }
    m.ring.write(out);
  }

  private renderSource(m: Mic, out: Float64Array, n0: number, key: string, src: SampleRing, log: PoseLog): void {
    let airs = m.airs.get(key);
    if (!airs) {
      airs = { direct: new AirFilter(), image: new AirFilter() };
      m.airs.set(key, airs);
    }
    log.at(n0 / FS, this.pose);
    const barrier = barrierGain(this.terrain, this.pose, m.pos);
    renderPath(out, n0, src, log, m.pos, null, barrier, airs.direct);
    renderPath(out, n0, src, log, m.pos, 2 * m.ground, GROUND_GAMMA, airs.image);
  }

  // Makes drones, shooters and mics match the world. Poses are recorded for the current tick.
  private sync(world: World): void {
    const s = world.state;
    const seenShooters = new Set<number>();
    for (const st of s.shooters) {
      seenShooters.add(st.id);
      let sh = this.shooters.get(st.id);
      if (!sh) {
        sh = { st, log: new PoseLog(), src: new SampleRing(SHOOTER_SAMPLES) };
        this.shooters.set(st.id, sh);
      }
      sh.st = st;
      const alt = this.terrain.height(st.x, st.y) + SHOOTER_H_M;
      sh.log.push(s.tick, { x: st.x, y: st.y, alt, vz: 0 });
    }
    for (const id of [...this.shooters.keys()]) if (!seenShooters.has(id)) this.shooters.delete(id);
    const seenDrones = new Set<number>();
    for (const d of s.drones) {
      seenDrones.add(d.id);
      let e = this.drones.get(d.id);
      if (!e || e.cls !== d.class) {
        e = this.newDrone(d.id, d.class);
        this.drones.set(d.id, e);
      }
      e.log.push(s.tick, d);
    }
    for (const id of [...this.drones.keys()]) if (!seenDrones.has(id)) this.drones.delete(id);

    const seenMics = new Set<string>();
    for (const n of s.nodes) {
      const ground = this.terrain.height(n.x, n.y);
      const array = n.kind === 'array';
      const offsets: [number, number][] = array ? ARRAY_OFFSETS : [[0, 0]];
      const h = array ? ARRAY_MIC_H_M : DETECTOR_MIC_H_M;
      offsets.forEach(([dx, dy], j) => {
        const key = `${n.id}.${j}`;
        seenMics.add(key);
        let m = this.mics.get(key);
        if (!m) {
          m = this.newMic(n.id, j);
          this.mics.set(key, m);
        }
        m.pos = { x: n.x + dx * ARRAY_HALF_M, y: n.y + dy * ARRAY_HALF_M, z: ground + h };
        m.ground = ground;
      });
    }
    for (const key of [...this.mics.keys()]) if (!seenMics.has(key)) this.mics.delete(key);
  }

  private newDrone(id: number, cls: DroneClass): Drone {
    const seed = (this.scn.seed ^ Math.imul(id + 1, 0x27d4eb2d)) >>> 0;
    const { wobble, broadband } = this.scn.acoustics;
    return {
      cls,
      log: new PoseLog(),
      rotors: new RotorLog(),
      src: new SampleRing(SOURCE_SAMPLES),
      model: new DroneSource(cls, seed, { wobble, broadband }),
    };
  }

  private newMic(id: number, j: number): Mic {
    const seed = (this.scn.seed ^ Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(j + 1, 0x85ebca6b)) >>> 0;
    const rng = createRng(seed);
    const ambient = this.scn.acoustics.ambient_db_spl !== null;
    return {
      pos: { x: 0, y: 0, z: 0 },
      ground: 0,
      ring: AudioRing.create(this.ringSeconds, this.shared),
      rng,
      pink: ambient ? new PinkNoise(rng) : null,
      airs: new Map(),
    };
  }
}
