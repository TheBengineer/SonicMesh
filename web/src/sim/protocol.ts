import type { LoraView } from '../lora/types';
import type { LogEntry, Op } from './inputs';
import type { ScenarioFile } from './scenario';
import type { WorldState } from './world';

// Messages between the page and the sim worker. The worker owns the world, the clock and the acoustic engine.
export const RING_SECONDS = 10;

// What the page is looking at: a drone (rotors, spectrum), mics whose audio it needs, and the mic for truth lines.
export interface InspectRequest {
  drone: number | null;
  mics: string[];
  truthKey: string | null;
}

export type ToWorker =
  | { t: 'load'; scenario: ScenarioFile; log: LogEntry[] }
  | { t: 'op'; op: Op }
  | { t: 'play'; on: boolean }
  | { t: 'speed'; speed: number }
  | { t: 'step' }
  | { t: 'reset' }
  | { t: 'inspect'; req: InspectRequest }
  | { t: 'export'; id: number };

export interface RotorTrace {
  id: number;
  tStart: number;
  dt: number;
  hz: number[];
}

export interface SpectrumTrace {
  id: number;
  binHz: number;
  db: number[];
}

export interface TruthTrace {
  key: string;
  t: number;
  lines: { id: number; hz: number[] }[];
}

// Everything the page draws, sent about every 10 ms. Rendering reads this and nothing else.
export interface Frame {
  tick: number;
  simTimeS: number;
  playing: boolean;
  speed: number;
  pending: number;
  logLength: number;
  msPerTick: number;
  state: WorldState;
  lora: LoraView | null;
  rotors: RotorTrace | null;
  spectrum: SpectrumTrace | null;
  truth: TruthTrace | null;
}

export interface RunExport {
  scenario: ScenarioFile;
  log: LogEntry[];
}

export type FromWorker =
  | { t: 'frame'; frame: Frame }
  | { t: 'reset' }
  | { t: 'mic'; key: string; shared: { data: SharedArrayBuffer; ctr: SharedArrayBuffer } | null }
  | { t: 'mic-del'; key: string }
  | { t: 'blocks'; items: { key: string; block: Float32Array }[] }
  | ({ t: 'export'; id: number } & RunExport)
  | { t: 'error'; message: string };
