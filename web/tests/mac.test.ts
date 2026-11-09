import { describe, expect, it } from 'vitest';
import exampleScenario from '../scenarios/example.json';
import { AcousticEngine } from '../src/acoustics/engine';
import { TICK_S } from '../src/sim/clock';
import { Runner } from '../src/sim/runner';
import { parseScenario, type NodeSpec } from '../src/sim/scenario';
import { Terrain } from '../src/sim/terrain';
import { hashWorld } from '../src/sim/world';
import { airtime } from '../src/lora/channel';
import { LoRaNetwork, alertContention } from '../src/lora/mac';

const HEARD = { bandDb: 72, ambientDb: 40, comb: { on: true, tracking: true, f0Hz: 250, peak: 0.3 } };
const QUIET = { bandDb: 40, ambientDb: 40, comb: { on: false, tracking: false, f0Hz: 0, peak: 0 } };

const scenario = parseScenario(exampleScenario);
const terrain = new Terrain(scenario.seed, scenario.terrain);

function network(nodes: NodeSpec[], seed = scenario.seed): LoRaNetwork {
  return new LoRaNetwork({ seed, gateway: scenario.gateway, nodes, terrain, ambientDb: 40 });
}

function runSeconds(net: LoRaNetwork, seconds: number, observe?: (net: LoRaNetwork, t: number) => void): void {
  const ticks = Math.round(seconds / TICK_S);
  for (let i = 1; i <= ticks; i++) {
    const t = i * TICK_S;
    observe?.(net, t);
    net.tick(t);
  }
}

describe('LoRa MAC and schedule', () => {
  it('idle for 10 minutes: two HEALTH per node, ~5 % beacon duty, airtime from the formula', () => {
    const net = network(scenario.nodes);
    runSeconds(net, 600);

    const view = net.snapshot();
    const health = view.packets.filter((p) => p.type === 'HEALTH');
    const perNode = new Map<number, number>();
    for (const p of health) perNode.set(p.tx, (perNode.get(p.tx) ?? 0) + 1);
    for (const n of scenario.nodes) expect(perNode.get(n.id), `node ${n.id}`).toBe(2);

    // 10 min of 4 s superframes + one extra health each.
    expect(health.length).toBe(26);
    for (const p of health) {
      expect(p.sf).toBe(9);
      expect(p.bw).toBe(125_000);
      expect(p.airtimeS).toBeCloseTo(airtime(9, 125_000, p.frameHex.length), 12);
    }

    // Beacon duty is the beacon airtime over the idle run, near the 5 % in protocol-v0.
    expect(view.gateway.beaconDuty).toBeGreaterThan(0.045);
    expect(view.gateway.beaconDuty).toBeLessThan(0.07);
    expect(view.gateway.duty.every((d) => d.duty < 0.2)).toBe(true);
    expect(view.mode).toBe('idle');
    // Ranging ran in idle slots as well.
    expect(view.packets.some((p) => p.type === 'RANGING_RESULT')).toBe(true);
  });

  it('a detecting node names the drone its pitch fits, and none once it stops detecting', () => {
    const net = network(scenario.nodes);
    const node = scenario.nodes.find((n) => n.id === 6)!;
    net.setTruth([
      { id: 1, class: 'mini', x: node.x + 2000, y: node.y, alt: 40 },
      { id: 2, class: 'mini', x: node.x + 50, y: node.y, alt: 40 },
    ]);
    const view = (): { detecting: boolean; targetIds: number[] } => net.snapshot().nodes.find((v) => v.id === 6)!;
    expect(view().targetIds).toEqual([]);
    let seen: number[] = [];
    runSeconds(net, 20, (n, t) => {
      n.observe(6, t <= 5 ? { ...HEARD, heardId: 2 } : QUIET);
      if (view().detecting) seen = view().targetIds;
    });
    expect(seen).toEqual([2]);
    expect(view().detecting).toBe(false);
    expect(view().targetIds).toEqual([]);
  });

  it('a detection that fits no drone draws nothing', () => {
    const net = network(scenario.nodes);
    const node = scenario.nodes.find((n) => n.id === 9)!;
    net.setTruth([{ id: 1, class: 'mini', x: node.x + 20, y: node.y, alt: 40 }]);
    runSeconds(net, 2, (n) => n.observe(9, { ...HEARD, heardId: null }));
    const view = net.snapshot().nodes.find((v) => v.id === 9)!;
    expect(view.detecting).toBe(true);
    expect(view.targetIds).toEqual([]);
    expect(view.bearingDeg).toBeNull();
    expect(view.pitchHz).toBe(250);
  });

  it('in the example, array bearings point near the drone with no truth going in', () => {
    const scn = parseScenario({ ...exampleScenario, drones: exampleScenario.drones.slice(0, 1) });
    const runner = new Runner(scn);
    const engine = new AcousticEngine(scn, runner.world.terrain, { ringSeconds: 3 });
    engine.start(runner.world);
    const errors: number[] = [];
    for (let i = 0; i < 5000; i++) {
      runner.stepTick();
      engine.tick(runner.world);
      runner.lora.observeFromEngine(runner.world, engine);
      if (i % 50 !== 0) continue;
      const d = runner.world.state.drones[0];
      for (const v of runner.lora.snapshot().nodes) {
        const n = scn.nodes.find((o) => o.id === v.id)!;
        if (v.kind !== 'array') expect(v.bearingDeg).toBeNull();
        if (v.bearingDeg === null || Math.hypot(d.x - n.x, d.y - n.y) > 300) continue;
        const az = (Math.atan2(d.x - n.x, d.y - n.y) * 180) / Math.PI;
        errors.push(Math.abs(((v.bearingDeg - az + 540) % 360) - 180));
      }
    }
    errors.sort((a, b) => a - b);
    expect(errors.length).toBeGreaterThan(20);
    expect(errors[errors.length >> 1]).toBeLessThan(10);
  }, 120_000);

  it('groups neighbours with matching pitches into bogies, without naming drones', () => {
    const net = network(scenario.nodes);
    net.setTruth([]);
    const reading = (f0Hz: number) => ({ bandDb: 72, ambientDb: 40, comb: { on: true, tracking: true, f0Hz, peak: 0.3 } });
    runSeconds(net, 2, (n) => {
      n.observe(6, reading(600));
      n.observe(7, reading(610));
      n.observe(8, reading(250));
    });
    expect(net.snapshot().bogies.map((b) => b.nodeIds)).toEqual([[6, 7], [8]]);
  });

  it('in the example with no drones, nothing is detected', () => {
    const scn = parseScenario({ ...exampleScenario, drones: [] });
    const runner = new Runner(scn);
    const engine = new AcousticEngine(scn, runner.world.terrain, { ringSeconds: 3 });
    engine.start(runner.world);
    for (let i = 0; i < 3000; i++) {
      runner.stepTick();
      engine.tick(runner.world);
      runner.lora.observeFromEngine(runner.world, engine);
    }
    for (const n of runner.lora.snapshot().nodes) expect(n.detections, `node ${n.id}`).toBe(0);
  }, 120_000);

  it('a detection switches to event, pauses health and ranging, and returns to idle after 10 s', () => {
    const net = network(scenario.nodes);
    const start = 2;
    const stop = 15;
    let firstDetection = -1;
    runSeconds(net, 40, (n, t) => {
      const high = t >= start && t <= stop;
      for (const id of [6, 7, 8]) n.observe(id, high ? HEARD : QUIET);
      if (high && firstDetection < 0 && n.snapshot().nodes.find((v) => v.id === 6)?.detecting) firstDetection = t;
    });

    const view = net.snapshot();
    const event = net.changes.find((c) => c.mode === 'event');
    expect(event, 'entered event mode').toBeDefined();
    expect(firstDetection).toBeGreaterThan(0);
    expect(event!.atS - firstDetection).toBeLessThanOrEqual(8.01);

    const back = net.changes.find((c) => c.mode === 'idle');
    expect(back, 'returned to idle').toBeDefined();
    expect(back!.atS - stop).toBeGreaterThanOrEqual(9.5);

    const eventStart = event!.atS;
    const eventEnd = back!.atS;
    for (const p of view.packets) {
      if (p.startS < eventStart || p.startS >= eventEnd) continue;
      expect(p.type, `packet ${p.type} during event`).not.toBe('HEALTH');
      expect(p.type, `packet ${p.type} during event`).not.toBe('RANGING_RESULT');
    }
    // Detections and snippets were sent during the event.
    expect(view.packets.some((p) => p.type === 'DETECT' && p.startS >= eventStart && p.startS < eventEnd)).toBe(true);
    expect(view.packets.some((p) => p.type === 'SNIPPET' && p.startS >= eventStart && p.startS < eventEnd)).toBe(true);
  });

  it('the example scenario produces beacons, ranging, detections and snippets', () => {
    // one drone, and the range firing as in the example, so the crossing makes exactly one event while shots are heard
    const scn = parseScenario({ ...exampleScenario, drones: exampleScenario.drones.slice(0, 1) });
    const runner = new Runner(scn);
    const engine = new AcousticEngine(scn, runner.world.terrain, { ringSeconds: 25 });
    engine.start(runner.world);
    let maxBand = -120;
    let ambient = 0;
    const droneId = runner.world.state.drones[0].id;
    let linked = 0;
    // node-ticks where a node is detecting the drone and heard a shot within half a second of that tick
    let both = 0;
    // The packet log keeps only the newest packets, so collect types during the run.
    const types = new Set<string>();
    // the drone crosses near node 3 at about 17 s; run to 90 s, past the end of the event
    for (let i = 0; i < 9000; i++) {
      runner.stepTick();
      engine.tick(runner.world);
      runner.lora.observeFromEngine(runner.world, engine);
      maxBand = Math.max(maxBand, engine.bandLevel('3.0'));
      ambient = engine.ambientDb();
      if (i % 50 === 0) {
        const snap = runner.lora.snapshot();
        for (const n of snap.nodes) {
          if (n.detecting && n.shotTimesS.some((t) => Math.abs(t - i * TICK_S) < 0.5)) both++;
        }
        for (const p of snap.packets) types.add(p.type);
        for (const n of snap.nodes) {
          if (!n.detecting) expect(n.targetIds).toEqual([]);
          if (n.targetIds.length > 0) {
            expect(n.targetIds).toEqual([droneId]);
            linked++;
          }
        }
      }
    }
    expect(linked, 'a node was linked to the drone').toBeGreaterThan(0);
    expect(both, 'a node heard a shot while it was detecting the drone').toBeGreaterThan(0);
    for (const type of ['BEACON', 'RANGING_RESULT', 'DETECT_START', 'DETECT', 'SNIPPET']) {
      expect(types.has(type), `example run sent ${type}`).toBe(true);
    }
    // One event, not restarted by a stale alert. The drone parks at the end of its path and stays audible, so the event
    // lasts; the return to idle has its own test above.
    expect(runner.lora.changes.map((c) => c.mode)).toEqual(['event']);
    expect(maxBand - ambient).toBeGreaterThan(6);
  }, 120_000);

  it('reports alert-contention delivery over 200 seeds', () => {
    const seeds = 200;
    const within = [0, 0, 0];
    let total = 0;
    for (let s = 0; s < seeds; s++) {
      const delivered = alertContention(s, 5, 3);
      for (const sf of delivered) {
        total++;
        if (sf === 1) within[0]++;
        if (sf >= 1 && sf <= 2) within[1]++;
        if (sf >= 1 && sf <= 3) within[2]++;
      }
    }
    const f = within.map((n) => n / total);
    console.log(
      `alert contention, 5 nodes over ${seeds} seeds: within 1 superframe ${(f[0] * 100).toFixed(1)} %, ` +
        `within 2 ${(f[1] * 100).toFixed(1)} %, within 3 ${(f[2] * 100).toFixed(1)} %`,
    );
    expect(f[0]).toBeGreaterThan(0.25);
    expect(f[1]).toBeGreaterThan(f[0]);
    expect(f[2]).toBeGreaterThan(f[1]);
  });

  it('moving a node 20 m along the line changes the next reported range by about 20 m', () => {
    const base: NodeSpec[] = [
      { id: 1, kind: 'detector', x: -100, y: 0 },
      { id: 2, kind: 'detector', x: 100, y: 0 },
    ];
    const moved: NodeSpec[] = [
      { id: 1, kind: 'detector', x: -80, y: 0 },
      { id: 2, kind: 'detector', x: 100, y: 0 },
    ];
    const a = network(base, 12345);
    const b = network(moved, 12345);
    runSeconds(a, 5);
    runSeconds(b, 5);

    const ra = a.snapshot().nodes.find((n) => n.id === 1)?.ranging.at(-1);
    const rb = b.snapshot().nodes.find((n) => n.id === 1)?.ranging.at(-1);
    expect(ra, 'range from the stationary layout').toBeDefined();
    expect(rb, 'range from the moved layout').toBeDefined();
    expect(ra!.trueM).toBeCloseTo(200, 6);
    expect(rb!.trueM).toBeCloseTo(180, 6);
    expect(Math.abs(ra!.measuredM - rb!.measuredM - 20)).toBeLessThan(1e-6);
  });

  it('replays a two-minute run with an event to identical state hashes', () => {
    function run(): string[] {
      const r = new Runner(scenario);
      const hashes: string[] = [];
      for (let i = 0; i < 12_000; i++) {
        r.stepTick();
        const t = r.simTimeS;
        const high = t >= 2 && t <= 12;
        for (const id of [6, 7, 8]) r.lora.observe(id, high ? HEARD : QUIET);
        if (r.tick % 100 === 0) hashes.push(hashWorld(r.world));
      }
      return hashes;
    }
    const first = run();
    const second = run();
    expect(first.length).toBe(120);
    expect(second).toEqual(first);
  });
});
