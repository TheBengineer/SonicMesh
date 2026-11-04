import { SimClock, TICK_MS } from './clock';
import type { LogEntry, Op } from './inputs';
import type { ScenarioFile } from './scenario';
import { Terrain } from './terrain';
import { applyOp, createWorld, stepWorld, type World } from './world';

// Owns the world, the clock and the input log. Live edits and replayed log entries go through the same path.
export class Runner {
  readonly clock = new SimClock();
  scenario: ScenarioFile;
  world: World;
  log: LogEntry[];
  private terrain: Terrain;
  private cursor = 0;

  constructor(scenario: ScenarioFile, log: LogEntry[] = []) {
    this.scenario = scenario;
    this.log = log.slice();
    this.terrain = new Terrain(scenario.seed, scenario.terrain);
    this.world = createWorld(scenario, this.terrain);
  }

  get tick(): number {
    return this.world.state.tick;
  }

  get simTimeS(): number {
    return (this.tick * TICK_MS) / 1000;
  }

  // Log entries not yet reached. Non-zero while replaying.
  get pending(): number {
    return this.log.length - this.cursor;
  }

  // Start a new run from the scenario file.
  newRun(scenario: ScenarioFile, log: LogEntry[] = []): void {
    this.scenario = scenario;
    this.terrain = new Terrain(scenario.seed, scenario.terrain);
    this.log = log.slice();
    this.clock.playing = false;
    this.reset();
  }

  // Back to tick 0, keeping the log so it replays.
  reset(): void {
    this.world = createWorld(this.scenario, this.terrain);
    this.cursor = 0;
  }

  // Apply an edit now and log it. Pending log entries after this tick are dropped, so an edit branches the run.
  apply(op: Op): void {
    this.log.length = this.cursor;
    this.log.push({ ...op, tick: this.tick } as LogEntry);
    this.cursor = this.log.length;
    applyOp(this.world, op);
  }

  stepTick(): void {
    const s = this.world.state;
    while (this.cursor < this.log.length && this.log[this.cursor].tick <= s.tick) {
      applyOp(this.world, this.log[this.cursor]);
      this.cursor++;
    }
    stepWorld(this.world);
  }

  stepOnce(): void {
    this.clock.playing = false;
    this.stepTick();
  }

  advance(wallMs: number): number {
    const n = this.clock.ticksFor(wallMs);
    for (let i = 0; i < n; i++) this.stepTick();
    return n;
  }
}
