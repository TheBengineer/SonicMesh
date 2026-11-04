import { AudioRing } from '../acoustics/history';
import type { LogEntry, Op } from './inputs';
import type { ScenarioFile } from './scenario';
import { RING_SECONDS, type Frame, type FromWorker, type InspectRequest, type RunExport, type ToWorker } from './protocol';

// Page side of the sim worker. Holds the latest frame for rendering and the audio rings for listening and waterfalls.
export class SimHost {
  private readonly worker: Worker;
  private readonly rings = new Map<string, AudioRing>();
  private readonly waiting = new Map<number, (run: RunExport) => void>();
  private nextExport = 1;
  frame: Frame | null = null;

  constructor() {
    this.worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    this.worker.onerror = (e) => console.error(e.message);
  }

  ring(key: string): AudioRing | undefined {
    return this.rings.get(key);
  }

  load(scenario: ScenarioFile, log: LogEntry[] = []): void {
    this.frame = null;
    this.post({ t: 'load', scenario, log });
  }

  apply(op: Op): void {
    this.post({ t: 'op', op });
  }

  play(on: boolean): void {
    this.post({ t: 'play', on });
  }

  speed(speed: number): void {
    this.post({ t: 'speed', speed });
  }

  step(): void {
    this.post({ t: 'step' });
  }

  reset(): void {
    this.post({ t: 'reset' });
  }

  inspect(req: InspectRequest): void {
    this.post({ t: 'inspect', req });
  }

  exportRun(): Promise<RunExport> {
    const id = this.nextExport++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.post({ t: 'export', id });
    });
  }

  private post(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  private receive(m: FromWorker): void {
    switch (m.t) {
      case 'frame':
        this.frame = m.frame;
        break;
      case 'reset':
        this.rings.clear();
        break;
      case 'mic':
        this.rings.set(
          m.key,
          m.shared
            ? new AudioRing(new Float32Array(m.shared.data), new Int32Array(m.shared.ctr))
            : AudioRing.create(RING_SECONDS, false),
        );
        break;
      case 'mic-del':
        this.rings.delete(m.key);
        break;
      case 'blocks':
        for (const it of m.items) this.rings.get(it.key)?.write(it.block);
        break;
      case 'export': {
        const resolve = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        resolve?.({ scenario: m.scenario, log: m.log });
        break;
      }
      case 'error':
        console.error(m.message);
        break;
    }
  }
}
