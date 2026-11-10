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

  it('the example has the demo layout: 13 nodes at 120 m, every third an array, one drone crossing', () => {
    const s = parseScenario(exampleScenario);
    expect(s.nodes).toHaveLength(13);
    const xs = s.nodes.map((n) => n.x);
    // Spacing averages 120 m; each gap is within 40 m of that, so the jitter stays small.
    for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i] - xs[i - 1] - 120)).toBeLessThan(40);
    expect(s.nodes.filter((n) => n.kind === 'array').map((n) => n.id)).toEqual([3, 6, 9, 12]);
    // Nodes sit near the line, jittered so they are not on two exact rows, and arrays fall on both sides.
    // Travel times still tell the two sides apart, because the rows are not perfectly parallel.
    for (const n of s.nodes) expect(Math.abs(n.y)).toBeLessThan(100);
    expect(new Set(s.nodes.map((n) => n.y)).size).toBeGreaterThan(10);
    // Arrays fall on both sides of the line.
    expect(s.nodes.filter((n) => n.kind === 'array').some((n) => n.y > 0) && s.nodes.filter((n) => n.kind === 'array').some((n) => n.y < 0)).toBe(true);
    expect(s.gateway.y).toBeLessThan(0);
    expect(s.drones.map((d) => d.class)).toEqual(['fpv']);
    expect(s.drones[0].path).toMatchObject({ kind: 'terrain_follow', speed_mps: 20, clearance_m: 20 });
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
