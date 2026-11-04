import { describe, expect, it } from 'vitest';
import exampleScenario from '../scenarios/example.json';
import { parseInputLog, type LogEntry, type Op } from '../src/sim/inputs';
import { Runner } from '../src/sim/runner';
import { parseScenario } from '../src/sim/scenario';
import { hashWorld } from '../src/sim/world';

const scenario = parseScenario(exampleScenario);
const TOTAL = 1000;
const EVERY = 100;

// A short manual flight with edits in the middle: stick changes, a node drag, a node added and removed,
// a gateway move, a second drone and a class change.
const session = new Map<number, Op[]>([
  [0, [{ type: 'drone_path', id: 1, path: { kind: 'manual', start: { x: -900, y: 600, altitude_m: 30 } } }]],
  [10, [{ type: 'drone_flight', id: 1, mode: 'manual' }]],
  [30, [{ type: 'drone_stick', id: 1, x: 0.5, y: -1, z: 0.3 }]],
  [150, [{ type: 'node_move', id: 7, x: 40, y: 60 }]],
  [200, [{ type: 'drone_stick', id: 1, x: -0.4, y: 0.2, z: 0 }]],
  [240, [{ type: 'node_add', node: { id: 14, kind: 'array', x: 2300, y: 200 } }]],
  [260, [{ type: 'gateway_move', x: 50, y: -260 }]],
  [300, [{ type: 'drone_add', drone: { id: 2, class: 'mini', flight: 'gps', path: { kind: 'hover', at: { x: -1000, y: -300 }, altitude_m: 45 } } }]],
  [330, [{ type: 'drone_class', id: 1, cls: 'matrice' }]],
  [360, [{ type: 'node_kind', id: 3, kind: 'detector' }]],
  [400, [{ type: 'drone_stick', id: 1, x: 0, y: 0, z: 0 }]],
  [520, [{ type: 'node_remove', id: 14 }]],
  [560, [{ type: 'truth', on: true }]],
  [700, [{ type: 'drone_stick', id: 1, x: 0.9, y: 0.1, z: -0.2 }]],
  [900, [{ type: 'drone_remove', id: 2 }]],
]);

function play(r: Runner, ticks: number, ops: Map<number, Op[]> | null, checkpoints: Map<number, string>): void {
  while (r.tick < ticks) {
    if (ops) for (const op of ops.get(r.tick) ?? []) r.apply(op);
    r.stepTick();
    if (r.tick % EVERY === 0) checkpoints.set(r.tick, hashWorld(r.world));
  }
}

describe('record and replay', () => {
  it('replays a recorded run to the same state hash every 100 ticks', () => {
    const recorded = new Runner(scenario);
    const expected = new Map<number, string>();
    play(recorded, TOTAL, session, expected);

    // The log goes through JSON the way a downloaded file would.
    const file = JSON.parse(
      JSON.stringify({ format: 'sonicmesh-input-log', version: 1, entries: recorded.log }),
    ) as unknown;
    const entries: LogEntry[] = parseInputLog(file);
    expect(entries.length).toBe([...session.values()].flat().length);

    const replayed = new Runner(JSON.parse(JSON.stringify(scenario)) as typeof scenario, entries);
    const actual = new Map<number, string>();
    play(replayed, TOTAL, null, actual);

    expect(actual.size).toBe(TOTAL / EVERY);
    for (const [tick, hash] of expected) expect(actual.get(tick), `tick ${tick}`).toBe(hash);
  });

  it('an edit after a rewind branches the run and drops the logged future', () => {
    const r = new Runner(scenario, []);
    play(r, 300, session, new Map());
    const before = r.log.length;
    r.reset();
    for (let i = 0; i < 100; i++) r.stepTick();
    r.apply({ type: 'truth', on: true });
    expect(r.log.length).toBeLessThan(before);
    expect(r.pending).toBe(0);
  });
});
