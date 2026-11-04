import { SPEEDS } from '../sim/clock';
import type { Runner } from '../sim/runner';
import { need } from './dom';

export interface TimelineHandlers {
  togglePlay(): void;
  step(): void;
  reset(): void;
  replay(): void;
  setSpeed(speed: number): void;
  toggleTruth(): void;
  loadScenario(file: File): void;
  loadInputs(file: File): void;
  saveRun(): void;
}

export class Timeline {
  private readonly play: HTMLButtonElement;
  private readonly speed: HTMLSelectElement;
  private readonly truth: HTMLButtonElement;
  private readonly readout: HTMLElement;
  private readonly status: HTMLElement;
  private readonly scenarioFile: HTMLInputElement;
  private readonly inputsFile: HTMLInputElement;

  constructor(root: HTMLElement, handlers: TimelineHandlers) {
    const speedOptions = SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}×</option>`).join('');
    root.innerHTML = `
      <div class="transport">
        <button id="tl-reset" title="Clear the log and go back to the scenario file">⟲ Reset</button>
        <button id="tl-replay" title="Go back to tick 0 and replay the logged inputs">⏮ Replay</button>
        <button id="tl-play" title="Play or pause (P)">▶ Play</button>
        <button id="tl-step" title="Advance one 10 ms tick (.)">⏭ Step</button>
        <select id="tl-speed" aria-label="Simulation speed">${speedOptions}</select>
        <span class="readout" id="tl-readout"></span>
        <button id="tl-truth" aria-pressed="false" title="Truth overlay (T)">Truth</button>
        <span class="spacer"></span>
        <button id="tl-load-scenario">Load scenario…</button>
        <button id="tl-load-inputs">Load inputs…</button>
        <button id="tl-save">Save run</button>
        <input id="tl-file-scenario" type="file" accept="application/json,.json" hidden />
        <input id="tl-file-inputs" type="file" accept="application/json,.json" hidden />
      </div>
      <div class="status" id="tl-status"></div>
    `;
    this.play = need<HTMLButtonElement>(root, '#tl-play');
    this.speed = need<HTMLSelectElement>(root, '#tl-speed');
    this.truth = need<HTMLButtonElement>(root, '#tl-truth');
    this.readout = need<HTMLElement>(root, '#tl-readout');
    this.status = need<HTMLElement>(root, '#tl-status');
    this.scenarioFile = need<HTMLInputElement>(root, '#tl-file-scenario');
    this.inputsFile = need<HTMLInputElement>(root, '#tl-file-inputs');

    need<HTMLButtonElement>(root, '#tl-reset').addEventListener('click', () => handlers.reset());
    need<HTMLButtonElement>(root, '#tl-replay').addEventListener('click', () => handlers.replay());
    this.play.addEventListener('click', () => handlers.togglePlay());
    need<HTMLButtonElement>(root, '#tl-step').addEventListener('click', () => handlers.step());
    this.speed.addEventListener('change', () => handlers.setSpeed(Number(this.speed.value)));
    this.truth.addEventListener('click', () => handlers.toggleTruth());
    need<HTMLButtonElement>(root, '#tl-load-scenario').addEventListener('click', () => this.scenarioFile.click());
    need<HTMLButtonElement>(root, '#tl-load-inputs').addEventListener('click', () => this.inputsFile.click());
    need<HTMLButtonElement>(root, '#tl-save').addEventListener('click', () => handlers.saveRun());
    this.scenarioFile.addEventListener('change', () => {
      const f = this.scenarioFile.files?.[0];
      this.scenarioFile.value = '';
      if (f) handlers.loadScenario(f);
    });
    this.inputsFile.addEventListener('change', () => {
      const f = this.inputsFile.files?.[0];
      this.inputsFile.value = '';
      if (f) handlers.loadInputs(f);
    });
  }

  update(runner: Runner, message = ''): void {
    const s = runner.world.state;
    const playing = runner.clock.playing;
    const label = playing ? '❚❚ Pause' : '▶ Play';
    if (this.play.textContent !== label) this.play.textContent = label;
    if (this.speed.value !== String(runner.clock.speed)) this.speed.value = String(runner.clock.speed);
    this.truth.setAttribute('aria-pressed', String(s.truth));
    const readout = `t = ${runner.simTimeS.toFixed(2)} s · tick ${s.tick} · seed ${runner.world.terrain.seed}`;
    if (this.readout.textContent !== readout) this.readout.textContent = readout;

    const replaying = runner.pending > 0;
    const text = replaying
      ? `Replaying: ${runner.pending} logged inputs still to come`
      : `Recording: ${runner.log.length} inputs logged this run`;
    const full = message ? `${text} · ${message}` : text;
    if (this.status.textContent !== full) this.status.textContent = full;
    this.status.classList.toggle('replay', replaying);
  }
}
