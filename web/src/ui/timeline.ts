import type { LoraView, PacketView } from '../lora/types';
import { SPEEDS } from '../sim/clock';
import { need } from './dom';

// What the timeline shows, taken from the latest frame.
export interface TimelineInfo {
  simTimeS: number;
  tick: number;
  seed: number;
  playing: boolean;
  speed: number;
  truth: boolean;
  pending: number;
  logLength: number;
  msPerTick: number;
  lora: LoraView | null;
  selectedPacket: number | null;
}

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
  selectPacket(id: number): void;
}

const TX_COLOR: Record<string, string> = {
  BEACON: '#3ddc84',
  DETECT_START: '#e879f9',
  DETECT: '#e879f9',
  SHOT: '#ff3b3b',
  SNIPPET: '#c86ad6',
  HEALTH: '#5fb4ff',
  RANGING_RESULT: '#d6a23f',
  JOIN: '#8a98a8',
  ACK: '#8a98a8',
};

const LANE_H = 4;
const TOP = 1;
const LEFT = 22;
// Lanes are too thin for a label each.
const LABEL_EVERY = 3;

export class Timeline {
  private readonly play: HTMLButtonElement;
  private readonly speed: HTMLSelectElement;
  private readonly truth: HTMLButtonElement;
  private readonly readout: HTMLElement;
  private readonly status: HTMLElement;
  private readonly scenarioFile: HTMLInputElement;
  private readonly inputsFile: HTMLInputElement;
  private readonly canvas: HTMLCanvasElement;
  private lastInfo: TimelineInfo | null = null;
  private geom = { t0: 0, t1: 1, laneH: LANE_H, top: TOP, rows: [] as number[] };

  constructor(
    root: HTMLElement,
    private readonly handlers: TimelineHandlers,
  ) {
    const speedOptions = SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}×</option>`).join('');
    root.innerHTML = `
      <div class="transport">
        <button class="panel-toggle" id="tl-lanes-toggle" aria-expanded="true" title="Show or hide the LoRa logic analyser">LoRa</button>
        <button id="tl-reset" title="Clear the log and go back to the scenario file">⟲ Reset</button>
        <button id="tl-replay" title="Go back to tick 0 and replay the logged inputs">⏮ Replay</button>
        <button id="tl-play" title="Play or pause (P)">▶ Play</button>
        <button id="tl-step" title="Advance one 10 ms tick (.)">⏭ Step</button>
        <select id="tl-speed" aria-label="Simulation speed">${speedOptions}</select>
        <span class="readout" id="tl-readout"></span>
        <button id="tl-truth" aria-pressed="false" title="Truth overlay (T)">Truth</button>
        <span class="status" id="tl-status"></span>
        <button id="tl-load-scenario">Load scenario…</button>
        <button id="tl-load-inputs">Load inputs…</button>
        <button id="tl-save">Save run</button>
        <input id="tl-file-scenario" type="file" accept="application/json,.json" hidden />
        <input id="tl-file-inputs" type="file" accept="application/json,.json" hidden />
      </div>
      <canvas class="lanes" id="tl-lanes" title="LoRa logic analyser, one lane per node and the gateway. Click a block to open the packet." aria-label="LoRa transmit lanes and superframe grid"></canvas>
    `;
    this.play = need<HTMLButtonElement>(root, '#tl-play');
    this.speed = need<HTMLSelectElement>(root, '#tl-speed');
    this.truth = need<HTMLButtonElement>(root, '#tl-truth');
    this.readout = need<HTMLElement>(root, '#tl-readout');
    this.status = need<HTMLElement>(root, '#tl-status');
    this.scenarioFile = need<HTMLInputElement>(root, '#tl-file-scenario');
    this.inputsFile = need<HTMLInputElement>(root, '#tl-file-inputs');
    this.canvas = need<HTMLCanvasElement>(root, '#tl-lanes');

    need<HTMLButtonElement>(root, '#tl-reset').addEventListener('click', () => handlers.reset());
    need<HTMLButtonElement>(root, '#tl-replay').addEventListener('click', () => handlers.replay());
    this.play.addEventListener('click', () => handlers.togglePlay());
    need<HTMLButtonElement>(root, '#tl-step').addEventListener('click', () => handlers.step());
    this.speed.addEventListener('change', () => handlers.setSpeed(Number(this.speed.value)));
    this.truth.addEventListener('click', () => handlers.toggleTruth());
    need<HTMLButtonElement>(root, '#tl-load-scenario').addEventListener('click', () => this.scenarioFile.click());
    need<HTMLButtonElement>(root, '#tl-load-inputs').addEventListener('click', () => this.inputsFile.click());
    need<HTMLButtonElement>(root, '#tl-save').addEventListener('click', () => handlers.saveRun());
    const lanesToggle = need<HTMLButtonElement>(root, '#tl-lanes-toggle');
    lanesToggle.addEventListener('click', () => {
      this.canvas.hidden = !this.canvas.hidden;
      lanesToggle.setAttribute('aria-expanded', String(!this.canvas.hidden));
    });
    this.canvas.addEventListener('click', (e) => this.pick(e));
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

  update(info: TimelineInfo, message = ''): void {
    const label = info.playing ? '❚❚ Pause' : '▶ Play';
    if (this.play.textContent !== label) this.play.textContent = label;
    if (this.speed.value !== String(info.speed)) this.speed.value = String(info.speed);
    this.truth.setAttribute('aria-pressed', String(info.truth));
    const readout = `t = ${info.simTimeS.toFixed(2)} s · tick ${info.tick} · seed ${info.seed} · engine ${info.msPerTick.toFixed(2)} ms/tick`;
    if (this.readout.textContent !== readout) this.readout.textContent = readout;

    const replaying = info.pending > 0;
    const text = replaying
      ? `Replaying: ${info.pending} logged inputs still to come`
      : `Recording: ${info.logLength} inputs logged this run`;
    const full = message ? `${text} · ${message}` : text;
    if (this.status.textContent !== full) this.status.textContent = full;
    this.status.classList.toggle('replay', replaying);
    this.lastInfo = info;
    if (!this.canvas.hidden) this.draw(info);
  }

  private draw(info: TimelineInfo): void {
    const canvas = this.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const lora = info.lora;
    const nodes = lora?.nodes ?? [];
    const rows = 1 + nodes.length;
    const cssW = Math.max(240, canvas.clientWidth || 800);
    const cssH = TOP + rows * LANE_H + 1;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, cssW, cssH);

    const sf = lora?.superframeDurationS ?? 4;
    const span = Math.max(4, Math.min(30, sf * 10));
    const t1 = Math.max(info.simTimeS, lora ? lora.superframeStartS : info.simTimeS);
    const t0 = Math.max(0, t1 - span);
    const x0 = LEFT;
    const x1 = cssW - 6;
    const x = (t: number): number => x0 + ((t - t0) / Math.max(1e-9, t1 - t0)) * (x1 - x0);
    this.geom = { t0, t1, laneH: LANE_H, top: TOP, rows: [0, ...nodes.map((n) => n.id)] };

    // Lane labels.
    ctx.font = '8px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const labels = ['GW', ...nodes.map((n) => String(n.id))];
    labels.forEach((label, i) => {
      if (i % LABEL_EVERY !== 0) return;
      ctx.fillStyle = '#8a98a8';
      ctx.fillText(label, 3, Math.max(4, TOP + i * LANE_H + LANE_H / 2));
    });

    // Superframe and slot grid.
    if (lora) {
      for (const g of lora.grid) {
        if (g.endS < t0 || g.startS > t1) continue;
        const a = x(Math.max(g.startS, t0));
        const b = x(Math.min(g.endS, t1));
        ctx.fillStyle = g.kind === 'beacon' ? 'rgba(61,220,132,0.15)' : g.kind === 'alert' ? 'rgba(255,179,71,0.05)' : 'rgba(95,180,255,0.035)';
        ctx.fillRect(a, TOP, Math.max(1, b - a), rows * LANE_H);
      }
    }
    const beacons = (lora?.packets ?? []).filter((p) => p.type === 'BEACON');
    ctx.strokeStyle = '#2a3541';
    for (const b of beacons) {
      if (b.startS < t0 || b.startS > t1) continue;
      const bx = x(b.startS);
      ctx.beginPath();
      ctx.moveTo(bx, TOP);
      ctx.lineTo(bx, TOP + rows * LANE_H);
      ctx.stroke();
    }

    // Transmit blocks.
    const laneOf = new Map<number, number>(nodes.map((n, i) => [n.id, i + 1]));
    for (const p of lora?.packets ?? []) {
      if (p.endS < t0 || p.startS > t1) continue;
      const lane = p.tx === 0 ? 0 : laneOf.get(p.tx);
      if (lane === undefined) continue;
      const a = x(Math.max(p.startS, t0));
      const b = Math.max(a + 1, x(Math.min(p.endS, t1)));
      const y = TOP + lane * LANE_H;
      ctx.fillStyle = TX_COLOR[p.type] ?? '#8a98a8';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(a, y, Math.max(1, b - a), LANE_H - 1);
      if (info.selectedPacket === p.id) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(a - 0.5, y - 0.5, Math.max(1, b - a) + 1, LANE_H);
      }
    }
    ctx.globalAlpha = 1;

    if (!lora) {
      ctx.fillStyle = '#8a98a8';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('waiting for the first LoRa superframe', x0 + 8, TOP + 10);
    }
  }

  private pick(e: MouseEvent): void {
    const info = this.lastInfo;
    const lora = info?.lora;
    if (!info || !lora) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const lane = Math.floor((py - this.geom.top) / this.geom.laneH);
    const x0 = LEFT;
    const x1 = rect.width - 6;
    const t = this.geom.t0 + ((px - x0) / Math.max(1, x1 - x0)) * (this.geom.t1 - this.geom.t0);
    // short frames are drawn wider than their airtime, so accept clicks within a few pixels
    const slack = (4 / Math.max(1, x1 - x0)) * (this.geom.t1 - this.geom.t0);
    // lanes are thin, so a click that misses its lane falls back to the ones either side
    for (const row of [lane, lane - 1, lane + 1]) {
      const id = this.geom.rows[row];
      if (id === undefined) continue;
      let best: PacketView | null = null;
      let bestGap = Infinity;
      for (const p of lora.packets) {
        if (p.tx !== id) continue;
        const gap = t < p.startS ? p.startS - t : t > p.endS ? t - p.endS : 0;
        if (gap > slack || gap > bestGap) continue;
        if (gap < bestGap || (best && p.endS - p.startS < best.endS - best.startS)) best = p;
        bestGap = gap;
      }
      if (best) {
        this.handlers.selectPacket(best.id);
        return;
      }
    }
  }
}
