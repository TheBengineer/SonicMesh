export type NodeKind = 'detector' | 'array';
export type DroneClass = 'fpv' | 'mini' | 'matrice';
export type FlightMode = 'manual' | 'gps';

export interface Vec2 {
  x: number;
  y: number;
}

export type PathSpec =
  | { kind: 'manual'; start: Vec2 & { altitude_m: number } }
  | { kind: 'hover'; at: Vec2; altitude_m: number }
  | { kind: 'crossing'; from: Vec2; to: Vec2; speed_mps: number; altitude_m: number }
  | { kind: 'out_and_back'; from: Vec2; to: Vec2; speed_mps: number; altitude_m: number }
  | { kind: 'terrain_follow'; from: Vec2; to: Vec2; speed_mps: number; clearance_m: number };

export interface NodeSpec extends Vec2 {
  id: number;
  kind: NodeKind;
}

export interface DroneSpec {
  id: number;
  class: DroneClass;
  flight?: FlightMode;
  path: PathSpec;
}

// Switches for the random and terrain-dependent parts of the acoustic model.
export interface AcousticSettings {
  self_noise: boolean;
  ambient_db_spl: number | null;
  wobble: boolean;
  broadband: boolean;
}

export const DEFAULT_ACOUSTICS: AcousticSettings = { self_noise: true, ambient_db_spl: 40, wobble: true, broadband: true };

// A gunshot emitter. A range is one of these too: it fires every every_s seconds, like the others.
export interface ShooterSpec extends Vec2 {
  id: number;
  kind: 'range' | 'shooter';
  every_s: number;
}

export interface ScenarioFile {
  format: 'sonicmesh-scenario';
  version: 1;
  name: string;
  seed: number;
  terrain: {
    size_m: [number, number];
    amplitude_m: number;
    wavelength_m: number;
    road_y_m: number;
  };
  gateway: Vec2;
  nodes: NodeSpec[];
  drones: DroneSpec[];
  shooters?: ShooterSpec[];
  acoustics: AcousticSettings;
}

const NODE_KINDS = ['detector', 'array'] as const;
const DRONE_CLASSES = ['fpv', 'mini', 'matrice'] as const;
const FLIGHT_MODES = ['manual', 'gps'] as const;
const PATH_KINDS = ['manual', 'hover', 'crossing', 'out_and_back', 'terrain_follow'] as const;
const SHOOTER_KINDS = ['range', 'shooter'] as const;

type Obj = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`Invalid scenario: ${message}`);
}

function asObj(v: unknown, what: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${what} must be an object`);
  return v as Obj;
}

function asArr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) fail(`${what} must be an array`);
  return v;
}

function num(o: Obj, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what}.${key} must be a number`);
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], what: string): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(`${what}.${key} must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function flag(o: Obj, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') fail(`acoustics.${key} must be true or false`);
  return v;
}

function parseAcoustics(v: unknown): AcousticSettings {
  if (v === undefined) return { ...DEFAULT_ACOUSTICS };
  const o = asObj(v, 'acoustics');
  const amb = o.ambient_db_spl;
  if (amb !== null && (typeof amb !== 'number' || !Number.isFinite(amb) || amb < 0)) {
    fail('acoustics.ambient_db_spl must be null or a number of at least 0');
  }
  return {
    self_noise: flag(o, 'self_noise'),
    ambient_db_spl: amb as number | null,
    wobble: flag(o, 'wobble'),
    broadband: flag(o, 'broadband'),
  };
}

function vec(v: unknown, what: string): Vec2 {
  const o = asObj(v, what);
  return { x: num(o, 'x', what), y: num(o, 'y', what) };
}

function parsePath(v: unknown): PathSpec {
  const o = asObj(v, 'path');
  const kind = oneOf(o, 'kind', PATH_KINDS, 'path');
  switch (kind) {
    case 'manual': {
      const start = asObj(o.start, 'path.start');
      return { kind, start: { ...vec(start, 'path.start'), altitude_m: num(start, 'altitude_m', 'path.start') } };
    }
    case 'hover':
      return { kind, at: vec(o.at, 'path.at'), altitude_m: num(o, 'altitude_m', 'path') };
    case 'terrain_follow':
      return {
        kind,
        from: vec(o.from, 'path.from'),
        to: vec(o.to, 'path.to'),
        speed_mps: num(o, 'speed_mps', 'path'),
        clearance_m: num(o, 'clearance_m', 'path'),
      };
    default:
      return {
        kind,
        from: vec(o.from, 'path.from'),
        to: vec(o.to, 'path.to'),
        speed_mps: num(o, 'speed_mps', 'path'),
        altitude_m: num(o, 'altitude_m', 'path'),
      };
  }
}

export function parseNode(v: unknown): NodeSpec {
  const o = asObj(v, 'node');
  return { id: num(o, 'id', 'node'), kind: oneOf(o, 'kind', NODE_KINDS, 'node'), x: num(o, 'x', 'node'), y: num(o, 'y', 'node') };
}

export function parseDrone(v: unknown): DroneSpec {
  const o = asObj(v, 'drone');
  const spec: DroneSpec = {
    id: num(o, 'id', 'drone'),
    class: oneOf(o, 'class', DRONE_CLASSES, 'drone'),
    path: parsePath(o.path),
  };
  if (o.flight !== undefined) spec.flight = oneOf(o, 'flight', FLIGHT_MODES, 'drone');
  return spec;
}

export function parseShooter(v: unknown): ShooterSpec {
  const o = asObj(v, 'shooter');
  const every = num(o, 'every_s', 'shooter');
  if (every <= 0) fail('shooter.every_s must be positive');
  return { id: num(o, 'id', 'shooter'), kind: oneOf(o, 'kind', SHOOTER_KINDS, 'shooter'), x: num(o, 'x', 'shooter'), y: num(o, 'y', 'shooter'), every_s: every };
}

function uniqueIds(items: { id: number }[], what: string): void {
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.id)) fail(`duplicate ${what} id ${item.id}`);
    seen.add(item.id);
  }
}

export function parseScenario(data: unknown): ScenarioFile {
  const o = asObj(data, 'scenario');
  if (o.format !== 'sonicmesh-scenario') fail('format must be "sonicmesh-scenario"');
  if (o.version !== 1) fail('version must be 1');
  if (typeof o.name !== 'string') fail('name must be a string');
  const seed = num(o, 'seed', 'scenario');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) fail('seed must be a uint32');

  const t = asObj(o.terrain, 'terrain');
  const size = asArr(t.size_m, 'terrain.size_m');
  if (size.length !== 2 || typeof size[0] !== 'number' || typeof size[1] !== 'number') {
    fail('terrain.size_m must be two numbers');
  }

  const nodes = asArr(o.nodes, 'nodes').map(parseNode);
  const drones = asArr(o.drones, 'drones').map(parseDrone);
  uniqueIds(nodes, 'node');
  uniqueIds(drones, 'drone');
  const shooters = o.shooters === undefined ? [] : asArr(o.shooters, 'shooters').map(parseShooter);
  uniqueIds(shooters, 'shooter');

  return {
    format: 'sonicmesh-scenario',
    version: 1,
    name: o.name,
    seed,
    terrain: {
      size_m: [size[0], size[1]],
      amplitude_m: num(t, 'amplitude_m', 'terrain'),
      wavelength_m: num(t, 'wavelength_m', 'terrain'),
      road_y_m: num(t, 'road_y_m', 'terrain'),
    },
    gateway: vec(o.gateway, 'gateway'),
    nodes,
    drones,
    shooters,
    acoustics: parseAcoustics(o.acoustics),
  };
}
