import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import exampleScenario from '../scenarios/example.json';
import schema from '../scenarios/schema.json';
import { parseScenario } from '../src/sim/scenario';

const validate = new Ajv({ allErrors: true }).compile(schema);

describe('scenario schema', () => {
  it('the example scenario validates against schema.json', () => {
    const ok = validate(exampleScenario);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('the example has the M0 layout: 13 nodes at 350 m, every third an array, one FPV crossing', () => {
    const s = parseScenario(exampleScenario);
    expect(s.nodes).toHaveLength(13);
    const xs = s.nodes.map((n) => n.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBe(350);
    expect(s.nodes.filter((n) => n.kind === 'array').map((n) => n.id)).toEqual([3, 6, 9, 12]);
    expect(s.gateway.y).toBeLessThan(0);
    expect(s.drones).toHaveLength(1);
    expect(s.drones[0].class).toBe('fpv');
    expect(s.drones[0].path).toMatchObject({ kind: 'crossing', speed_mps: 20, altitude_m: 30 });
  });

  it('rejects a scenario with a duplicate node id', () => {
    const bad = JSON.parse(JSON.stringify(exampleScenario)) as typeof exampleScenario;
    bad.nodes[1].id = bad.nodes[0].id;
    expect(() => parseScenario(bad)).toThrow(/duplicate node id/);
  });

  it('rejects an unknown path kind', () => {
    const bad = JSON.parse(JSON.stringify(exampleScenario)) as { drones: { path: { kind: string } }[] };
    bad.drones[0].path.kind = 'teleport';
    expect(() => parseScenario(bad)).toThrow(/path.kind/);
    expect(validate(bad)).toBe(false);
  });
});
