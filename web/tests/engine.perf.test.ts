import { describe, expect, it } from 'vitest';
import exampleScenario from '../scenarios/example.json';
import { AcousticEngine } from '../src/acoustics/engine';
import { TICK_S } from '../src/sim/clock';
import { Runner } from '../src/sim/runner';
import { parseScenario } from '../src/sim/scenario';

// The example scenario: 13 nodes (4 array nodes, 25 mics) and one FPV crossing, 10 s of sim time per run.
// Skipped in `npm test`; run with `npm run bench`.
const SIM_SECONDS = 10;
const TICKS = Math.round(SIM_SECONDS / TICK_S);

function msPerTick(): number {
  const scn = parseScenario(exampleScenario);
  const runner = new Runner(scn);
  const engine = new AcousticEngine(scn, runner.world.terrain, { ringSeconds: SIM_SECONDS + 1 });
  engine.start(runner.world);
  const t0 = performance.now();
  while (runner.tick < TICKS) {
    runner.stepTick();
    engine.tick(runner.world);
  }
  return (performance.now() - t0) / TICKS;
}

describe.skipIf(!import.meta.env.BENCH)('engine speed', () => {
  it('renders the example scenario faster than real time', () => {
    msPerTick(); // warm-up
    const runs = [msPerTick(), msPerTick(), msPerTick()];
    const mean = runs.reduce((s, v) => s + v, 0) / runs.length;
    console.log(`engine ms per tick (mean of ${runs.length} runs of ${TICKS} ticks): ${mean.toFixed(3)}`);
    expect(mean).toBeLessThan(TICK_S * 1000);
  }, 120_000);
});
