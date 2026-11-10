import type { DroneClass, DroneSpec, FlightMode, NodeKind, NodeSpec, PathSpec, ShooterSpec } from './scenario';

// Every change to world state is one of these. Each is logged with the tick it was applied at.
export type Op =
  | { type: 'drone_stick'; id: number; x: number; y: number; z: number }
  | { type: 'drone_flight'; id: number; mode: FlightMode }
  | { type: 'drone_class'; id: number; cls: DroneClass }
  | { type: 'drone_path'; id: number; path: PathSpec }
  | { type: 'drone_add'; drone: DroneSpec }
  | { type: 'drone_remove'; id: number }
  | { type: 'node_add'; node: NodeSpec }
  | { type: 'node_move'; id: number; x: number; y: number }
  | { type: 'node_kind'; id: number; kind: NodeKind }
  | { type: 'node_remove'; id: number }
  | { type: 'gateway_move'; x: number; y: number }
  | { type: 'shooter_add'; shooter: ShooterSpec }
  | { type: 'shooter_remove'; id: number }
  | { type: 'shot_fire'; id: number; x: number; y: number }
  | { type: 'truth'; on: boolean };

export type LogEntry = Op & { tick: number };

export interface InputLogFile {
  format: 'sonicmesh-input-log';
  version: 1;
  entries: LogEntry[];
}

const OP_TYPES: readonly Op['type'][] = [
  'drone_stick',
  'drone_flight',
  'drone_class',
  'drone_path',
  'drone_add',
  'drone_remove',
  'node_add',
  'node_move',
  'node_kind',
  'node_remove',
  'gateway_move',
  'shooter_add',
  'shooter_remove',
  'shot_fire',
  'truth',
];

export function parseInputLog(data: unknown): LogEntry[] {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid input log: not an object');
  const f = data as Partial<InputLogFile>;
  if (f.format !== 'sonicmesh-input-log' || f.version !== 1 || !Array.isArray(f.entries)) {
    throw new Error('Invalid input log: expected sonicmesh-input-log version 1');
  }
  let last = 0;
  for (const e of f.entries as LogEntry[]) {
    if (!Number.isInteger(e.tick) || e.tick < last) throw new Error('Invalid input log: ticks must be ordered integers');
    if (!OP_TYPES.includes(e.type)) throw new Error(`Invalid input log: unknown op ${String(e.type)}`);
    last = e.tick;
  }
  return f.entries as LogEntry[];
}
