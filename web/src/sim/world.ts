import { TICK_S } from './clock';
import { fnv1a } from './hash';
import { approach, clamp } from './math';
import type { DroneClass, DroneSpec, FlightMode, NodeSpec, PathSpec, ScenarioFile, Vec2 } from './scenario';
import type { Terrain } from './terrain';
import type { Op } from './inputs';
import { ONE_OFF_LINGER_S, oneOffState, shooterState, type ShooterState } from './shots';
import type { LoRaNetwork } from '../lora/mac';

export interface Stick {
  x: number;
  y: number;
  z: number;
}

export interface Pose {
  x: number;
  y: number;
  alt: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface DroneState extends Pose {
  id: number;
  class: DroneClass;
  flight: FlightMode;
  stick: Stick;
  path: PathSpec;
  // tick at which the current path started
  t0: number;
}

export interface WorldState {
  tick: number;
  seed: number;
  rng: number;
  truth: boolean;
  gateway: Vec2;
  nodes: NodeSpec[];
  drones: DroneState[];
  shooters: ShooterState[];
}

export interface World {
  name: string;
  state: WorldState;
  terrain: Terrain;
  lora?: LoRaNetwork;
}

export interface ClassSpec {
  label: string;
  size_m: number;
  vmax_mps: number;
  accel_mps2: number;
  drag_per_s: number;
}

// Typical values, not measured. The ledger tags them ASSUMED.
export const DRONE_CLASSES: Record<DroneClass, ClassSpec> = {
  fpv: { label: 'FPV', size_m: 0.3, vmax_mps: 25, accel_mps2: 12, drag_per_s: 0.15 },
  mini: { label: 'Mini', size_m: 0.3, vmax_mps: 16, accel_mps2: 6, drag_per_s: 0.3 },
  matrice: { label: 'Matrice-class', size_m: 0.9, vmax_mps: 20, accel_mps2: 4, drag_per_s: 0.4 },
};

const STICK_DEADZONE = 0.05;
const MIN_AGL_M = 1.5;
const MAX_ALT_M = 400;

type Line = Extract<PathSpec, { from: Vec2 }>;
type Scripted = Exclude<PathSpec, { kind: 'manual' }>;

function lineAt(p: Line, t: number): { x: number; y: number; vx: number; vy: number } {
  const dx = p.to.x - p.from.x;
  const dy = p.to.y - p.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const dist = p.speed_mps * Math.max(t, 0);
  let s: number;
  let dir: number;
  if (p.kind === 'out_and_back') {
    const ph = dist % (2 * len);
    s = ph <= len ? ph : 2 * len - ph;
    dir = ph <= len ? 1 : -1;
  } else {
    s = Math.min(dist, len);
    dir = dist < len ? 1 : 0;
  }
  return { x: p.from.x + ux * s, y: p.from.y + uy * s, vx: ux * p.speed_mps * dir, vy: uy * p.speed_mps * dir };
}

function altitudeOn(p: Line, x: number, y: number, terrain: Terrain): number {
  return p.kind === 'terrain_follow' ? terrain.height(x, y) + p.clearance_m : p.altitude_m;
}

// Scripted paths are a function of time since the path started, so they need no integration.
function scripted(path: Scripted, t: number, terrain: Terrain): Pose {
  if (path.kind === 'hover') {
    return { x: path.at.x, y: path.at.y, alt: path.altitude_m, vx: 0, vy: 0, vz: 0 };
  }
  const a = lineAt(path, t);
  const b = lineAt(path, t + TICK_S);
  const alt = altitudeOn(path, a.x, a.y, terrain);
  const altNext = altitudeOn(path, b.x, b.y, terrain);
  return { x: a.x, y: a.y, alt, vx: a.vx, vy: a.vy, vz: (altNext - alt) / TICK_S };
}

function startPose(path: PathSpec, terrain: Terrain): Pose {
  if (path.kind === 'manual') {
    return { x: path.start.x, y: path.start.y, alt: path.start.altitude_m, vx: 0, vy: 0, vz: 0 };
  }
  return scripted(path, 0, terrain);
}

function spawnDrone(spec: DroneSpec, tick: number, terrain: Terrain): DroneState {
  return {
    id: spec.id,
    class: spec.class,
    flight: spec.flight ?? 'gps',
    ...startPose(spec.path, terrain),
    stick: { x: 0, y: 0, z: 0 },
    path: spec.path,
    t0: tick,
  };
}

function stickTarget(v: number, maxSpeed: number): number {
  return Math.abs(v) < STICK_DEADZONE ? 0 : v * maxSpeed;
}

function stepManual(d: DroneState, cls: ClassSpec, terrain: Terrain): void {
  const dt = TICK_S;
  const s = d.stick;
  if (d.flight === 'manual') {
    d.vx += (s.x * cls.accel_mps2 - cls.drag_per_s * d.vx) * dt;
    d.vy += (s.y * cls.accel_mps2 - cls.drag_per_s * d.vy) * dt;
    d.vz += (s.z * cls.accel_mps2 * 0.5 - cls.drag_per_s * d.vz) * dt;
  } else {
    const step = cls.accel_mps2 * dt;
    d.vx = approach(d.vx, stickTarget(s.x, cls.vmax_mps), step);
    d.vy = approach(d.vy, stickTarget(s.y, cls.vmax_mps), step);
    d.vz = approach(d.vz, stickTarget(s.z, cls.vmax_mps * 0.5), step);
  }

  const speed = Math.hypot(d.vx, d.vy);
  if (speed > cls.vmax_mps) {
    d.vx *= cls.vmax_mps / speed;
    d.vy *= cls.vmax_mps / speed;
  }
  d.vz = clamp(d.vz, -cls.vmax_mps * 0.5, cls.vmax_mps * 0.5);

  d.x += d.vx * dt;
  d.y += d.vy * dt;
  d.alt += d.vz * dt;

  const inside = terrain.clamp(d.x, d.y);
  if (inside.x !== d.x) d.vx = 0;
  if (inside.y !== d.y) d.vy = 0;
  d.x = inside.x;
  d.y = inside.y;

  const floor = terrain.height(d.x, d.y) + MIN_AGL_M;
  if (d.alt < floor) {
    d.alt = floor;
    d.vz = Math.max(d.vz, 0);
  }
  d.alt = Math.min(d.alt, MAX_ALT_M);
}

export function createWorld(scn: ScenarioFile, terrain: Terrain): World {
  return {
    name: scn.name,
    terrain,
    state: {
      tick: 0,
      seed: scn.seed >>> 0,
      rng: scn.seed >>> 0,
      truth: false,
      gateway: { ...scn.gateway },
      nodes: scn.nodes.map((n) => ({ ...n })),
      drones: scn.drones.map((d) => spawnDrone(d, 0, terrain)),
      shooters: (scn.shooters ?? []).map((sh) => shooterState(sh, 0, scn.seed >>> 0)),
    },
  };
}

// Advances the world by one 10 ms tick. Inputs for this tick must already be applied.
export function stepWorld(world: World): void {
  const s = world.state;
  for (const d of s.drones) {
    if (d.path.kind === 'manual') {
      stepManual(d, DRONE_CLASSES[d.class], world.terrain);
    } else {
      Object.assign(d, scripted(d.path, (s.tick + 1 - d.t0) * TICK_S, world.terrain));
    }
  }
  // A one-off shooter goes once its shot has finished, so the sound it made still reaches far nodes.
  const lingerTicks = Math.round(ONE_OFF_LINGER_S / TICK_S);
  s.shooters = s.shooters.filter((sh) => !sh.once || s.tick - sh.t0 < lingerTicks);
  s.tick += 1;
}

function findDrone(s: WorldState, id: number): DroneState | undefined {
  return s.drones.find((d) => d.id === id);
}

function findNode(s: WorldState, id: number): NodeSpec | undefined {
  return s.nodes.find((n) => n.id === id);
}

export function applyOp(world: World, op: Op): void {
  const s = world.state;
  const terrain = world.terrain;
  switch (op.type) {
    case 'drone_stick': {
      const d = findDrone(s, op.id);
      if (d) d.stick = { x: clamp(op.x, -1, 1), y: clamp(op.y, -1, 1), z: clamp(op.z, -1, 1) };
      break;
    }
    case 'drone_flight': {
      const d = findDrone(s, op.id);
      if (d) d.flight = op.mode;
      break;
    }
    case 'drone_class': {
      const d = findDrone(s, op.id);
      if (d) d.class = op.cls;
      break;
    }
    case 'drone_path': {
      const d = findDrone(s, op.id);
      if (!d) break;
      d.path = op.path;
      d.t0 = s.tick;
      // A manual path keeps the current pose. A scripted path jumps to its first point.
      if (op.path.kind !== 'manual') Object.assign(d, startPose(op.path, terrain));
      break;
    }
    case 'drone_add':
      if (!findDrone(s, op.drone.id)) s.drones.push(spawnDrone(op.drone, s.tick, terrain));
      break;
    case 'drone_remove':
      s.drones = s.drones.filter((d) => d.id !== op.id);
      break;
    case 'shooter_add':
      if (!s.shooters.some((sh) => sh.id === op.shooter.id)) s.shooters.push(shooterState(op.shooter, s.tick, s.seed));
      break;
    case 'shot_fire':
      if (!s.shooters.some((sh) => sh.id === op.id)) s.shooters.push(oneOffState(op.id, op.x, op.y, s.tick, s.seed));
      break;
    case 'shooter_remove':
      s.shooters = s.shooters.filter((sh) => sh.id !== op.id);
      break;
    case 'node_add':
      if (!findNode(s, op.node.id)) {
        const p = terrain.clamp(op.node.x, op.node.y);
        s.nodes.push({ ...op.node, x: p.x, y: p.y });
      }
      break;
    case 'node_move': {
      const n = findNode(s, op.id);
      if (n) Object.assign(n, terrain.clamp(op.x, op.y));
      break;
    }
    case 'node_kind': {
      const n = findNode(s, op.id);
      if (n) n.kind = op.kind;
      break;
    }
    case 'node_remove':
      s.nodes = s.nodes.filter((n) => n.id !== op.id);
      break;
    case 'gateway_move':
      s.gateway = terrain.clamp(op.x, op.y);
      break;
    case 'truth':
      s.truth = op.on;
      break;
  }
}

export function hashWorld(world: World): string {
  const lora = world.lora ? world.lora.stateHash() : '';
  return fnv1a(JSON.stringify(world.state) + '|' + lora);
}
