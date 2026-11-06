import { clamp } from '../sim/math';
import { esc, need } from './dom';

// The "How it works" walkthrough: a dialog of short steps, each with a small scene to play with. The scenes are sketches
// that teach the idea, on made-up spectra and tracks, so they do not run the detector. Every result figure on the
// status and patience steps comes from docs/research/07-detector-baseline.md and is simulated.

const REPO = 'https://github.com/TheBengineer/SonicMesh';

const BG = '#0b1016';
const GRID = '#2a3541';
const TEXT = '#dfe6ee';
const MUTED = '#8a98a8';
const BLUE = '#5fb4ff';
const AMBER = '#ffb347';
const RED = '#ff4d6d';
const QUIET = '#6b7785';

// --- The ideas, as pure functions ---

export type Spectrum = (hz: number) => number;

const SPECTRUM_TOP_HZ = 4000;

function gauss(d: number, w: number): number {
  return Math.exp(-(d * d) / (w * w));
}

export function droneSpectrum(f0: number): Spectrum {
  return (hz) => {
    let s = 0.08 + 0.1 * Math.exp(-hz / 600);
    for (let k = 1; k <= 16 && k * f0 <= SPECTRUM_TOP_HZ; k++) {
      s += (0.9 / (1 + 0.18 * k)) * gauss(hz - k * f0, Math.max(12, 0.012 * k * f0));
    }
    return s;
  };
}

// Louder than the drone everywhere, and smooth, so nothing stands above its neighbours.
export const windSpectrum: Spectrum = (hz) => 0.15 + 0.95 * Math.exp(-hz / 500);

function meanOver(s: Spectrum, from: number, to: number): number {
  let sum = 0;
  for (let i = 0; i < 5; i++) sum += s(from + ((to - from) * i) / 4);
  return sum / 5;
}

// The comb in miniature: the log ratio of a window on each harmonic to the bins beside it, clipped at 0.
export function combScore(f0: number, s: Spectrum): number {
  let total = 0;
  let n = 0;
  for (let k = 1; k <= 16 && k * f0 <= SPECTRUM_TOP_HZ; k++) {
    const c = k * f0;
    const half = Math.max(15.6, 0.03 * c);
    const on = meanOver(s, c - half, c + half);
    const off = (meanOver(s, c - 2 * half, c - half) + meanOver(s, c + half, c + 2 * half)) / 2;
    total += Math.max(0, Math.log10(on / off));
    n++;
  }
  return n === 0 ? 0 : total / n;
}

export const COMB_LOCK = 0.2;
export type CombVerdict = 'none' | 'lock' | 'harmonic';

export function combVerdict(f: number, f0: number, score: number): CombVerdict {
  if (score < COMB_LOCK) return 'none';
  if (Math.abs(f / f0 - 1) <= 0.03) return 'lock';
  const ratio = f / f0;
  return Math.abs(ratio / Math.round(ratio) - 1) <= 0.03 ? 'harmonic' : 'none';
}

export type Segment = [number, number];
export type GateState = 'quiet' | 'arming' | 'detecting';

// A track's age restarts each time it is lost. The node goes on once the age reaches the required time.
export function gateAt(segments: Segment[], requiredS: number, t: number): { state: GateState; ageS: number } {
  const seg = segments.find(([a, b]) => t >= a && t <= b);
  if (!seg) return { state: 'quiet', ageS: 0 };
  const ageS = t - seg[0];
  return { state: ageS >= requiredS ? 'detecting' : 'arming', ageS };
}

export function gateEverOn(segments: Segment[], requiredS: number): boolean {
  return segments.some(([a, b]) => b - a >= requiredS);
}

export interface Onset {
  node: number;
  t: number;
  hz: number;
}

export function pitchesMatch(a: number, b: number, tol = 0.12): boolean {
  const r = Math.max(a, b) / Math.min(a, b);
  return Math.abs(r - 1) <= tol || Math.abs(r / 2 - 1) <= tol;
}

// The gateway rule: two adjacent nodes, within the window, on one pitch or an octave apart.
export function pairAlert(onsets: Onset[], windowS = 30): [Onset, Onset] | null {
  for (const a of onsets) {
    for (const b of onsets) {
      if (b.node !== a.node + 1) continue;
      if (Math.abs(a.t - b.t) <= windowS && pitchesMatch(a.hz, b.hz)) return [a, b];
    }
  }
  return null;
}

// --- Scene plumbing ---

interface View {
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
  dt: number;
}

interface Scene {
  draw(v: View): void;
  stop?(): void;
}

interface Step {
  kicker: string;
  title: string;
  copy: string;
  // Fills the controls under the canvas. Null makes a step with no canvas.
  scene: ((ui: HTMLElement, canvas: HTMLCanvasElement) => Scene) | null;
}

function chips<T extends string>(el: HTMLElement, options: [T, string][], active: T, onPick: (v: T) => void): void {
  el.classList.add('how-chips');
  el.innerHTML = options
    .map(([v, label]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === active}">${esc(label)}</button>`)
    .join('');
  el.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      onPick(b.dataset.v as T);
    }),
  );
}

function clear(v: View): void {
  v.g.fillStyle = BG;
  v.g.fillRect(0, 0, v.w, v.h);
}

function label(v: View, text: string, x: number, y: number, color = MUTED, px = 12, align: CanvasTextAlign = 'left'): void {
  v.g.font = `${px}px system-ui, sans-serif`;
  v.g.textAlign = align;
  v.g.fillStyle = color;
  v.g.fillText(text, x, y);
}

function drawSpectrum(v: View, s: Spectrum, base: number, top: number, color = BLUE): void {
  const { g, w } = v;
  const toY = (a: number): number => base - clamp(a, 0, 1.25) * ((base - top) / 1.25);
  g.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const y = toY(s((x / w) * SPECTRUM_TOP_HZ));
    if (x === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.stroke();
  g.strokeStyle = GRID;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, base);
  g.lineTo(w, base);
  g.stroke();
  for (let k = 0; k <= 4; k++) {
    const x = (k / 4) * w;
    label(v, `${k} kHz`, clamp(x, 4, w - 4), base + 16, MUTED, 12, k === 0 ? 'left' : k === 4 ? 'right' : 'center');
  }
}

// --- Scenes ---

const CLASSES = { fpv: 600, mini: 250, matrice: 100 } as const;
const WOBBLE = { fpv: 0.02, mini: 0.015, matrice: 0.006 } as const;
type DroneClass = keyof typeof CLASSES;

// A synthetic drone: a stack of harmonics with a slow wobble. Made here, so no recording ships with the page.
class SynthDrone {
  private ctx: AudioContext | null = null;
  private oscs: OscillatorNode[] = [];
  private lfoDepth: GainNode | null = null;

  get playing(): boolean {
    return this.ctx !== null;
  }

  start(f0: number, wobble: number): void {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.gain.linearRampToValueAtTime(0.14, ctx.currentTime + 0.2);
    master.connect(ctx.destination);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 3.1;
    const depth = ctx.createGain();
    lfo.connect(depth);
    lfo.start();
    this.oscs = [lfo];
    for (let k = 1; k <= 8; k++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.3 / k;
      depth.connect(osc.detune);
      osc.connect(gain).connect(master);
      osc.start();
      this.oscs.push(osc);
    }
    this.ctx = ctx;
    this.lfoDepth = depth;
    this.tune(f0, wobble);
  }

  tune(f0: number, wobble: number): void {
    if (!this.ctx || !this.lfoDepth) return;
    this.oscs.slice(1).forEach((o, i) => (o.frequency.value = f0 * (i + 1)));
    this.lfoDepth.gain.value = 1200 * Math.log2(1 + wobble);
  }

  stop(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.oscs = [];
    this.lfoDepth = null;
  }
}

function hearScene(ui: HTMLElement): Scene {
  let cls: DroneClass = 'fpv';
  let t = 0;
  const synth = new SynthDrone();
  ui.innerHTML = `<div data-classes></div><button type="button" class="how-action" data-hear>▶ Hear a synthetic one</button>`;
  const hear = need<HTMLButtonElement>(ui, '[data-hear]');
  const setHear = (): void => {
    hear.textContent = synth.playing ? '■ Stop' : '▶ Hear a synthetic one';
  };
  chips(need<HTMLElement>(ui, '[data-classes]'), [['fpv', 'FPV'], ['mini', 'Mini'], ['matrice', 'Matrice']], cls, (c) => {
    cls = c;
    synth.tune(CLASSES[c], WOBBLE[c]);
  });
  hear.addEventListener('click', () => {
    if (synth.playing) synth.stop();
    else synth.start(CLASSES[cls], WOBBLE[cls]);
    setHear();
  });
  return {
    draw(v) {
      t += v.dt;
      clear(v);
      const f0 = CLASSES[cls] * (1 + WOBBLE[cls] * Math.sin(t * 2 * Math.PI * 0.8));
      drawSpectrum(v, droneSpectrum(f0), v.h - 30, 34);
      label(v, `Blade-pass pitch about ${Math.round(f0)} Hz. Watch it wobble.`, 12, 22, TEXT, 13);
    },
    stop: () => synth.stop(),
  };
}

const COMB_TRUE_HZ = 340;
const COMB_MIN_HZ = 120;
const COMB_MAX_HZ = 1200;

function combScene(ui: HTMLElement): Scene {
  let source: 'drone' | 'wind' = 'drone';
  let f = 190;
  ui.innerHTML = `
    <div data-source></div>
    <label class="how-slider">Slide the comb <input type="range" min="0" max="1000" value="${Math.round(
      (1000 * Math.log(f / COMB_MIN_HZ)) / Math.log(COMB_MAX_HZ / COMB_MIN_HZ),
    )}" aria-label="Candidate pitch"></label>
    <p class="how-result" data-result aria-live="polite"></p>`;
  const result = need<HTMLElement>(ui, '[data-result]');
  chips(need<HTMLElement>(ui, '[data-source]'), [['drone', 'A drone'], ['wind', 'A loud gust of wind']], source, (s) => {
    source = s;
  });
  need<HTMLInputElement>(ui, 'input').addEventListener('input', (e) => {
    const p = Number((e.target as HTMLInputElement).value) / 1000;
    f = COMB_MIN_HZ * Math.pow(COMB_MAX_HZ / COMB_MIN_HZ, p);
  });
  let shown = '';
  return {
    draw(v) {
      clear(v);
      const spec = source === 'drone' ? droneSpectrum(COMB_TRUE_HZ) : windSpectrum;
      const score = combScore(f, spec);
      const verdict = combVerdict(f, COMB_TRUE_HZ, score);
      const base = v.h - 30;
      const top = 44;
      for (let k = 1; k <= 16 && k * f <= SPECTRUM_TOP_HZ; k++) {
        const x = (k * f * v.w) / SPECTRUM_TOP_HZ;
        const half = Math.max(1.5, (Math.max(15.6, 0.03 * k * f) * v.w) / SPECTRUM_TOP_HZ);
        v.g.fillStyle = verdict === 'lock' ? 'rgba(255, 77, 109, 0.3)' : 'rgba(255, 179, 71, 0.26)';
        v.g.fillRect(x - half, top, half * 2, base - top);
      }
      drawSpectrum(v, spec, base, top);
      label(v, `Candidate pitch ${Math.round(f)} Hz`, 12, 20, TEXT, 13);
      const meterW = Math.min(150, v.w * 0.3);
      label(v, 'Comb score', v.w - meterW - 12, 20, MUTED, 12);
      v.g.fillStyle = GRID;
      v.g.fillRect(v.w - meterW - 12, 26, meterW, 8);
      v.g.fillStyle = verdict === 'lock' ? RED : verdict === 'harmonic' ? AMBER : QUIET;
      v.g.fillRect(v.w - meterW - 12, 26, meterW * clamp(score / 0.6, 0, 1), 8);
      let text = 'The teeth miss the peaks, so the score stays low. Keep sliding.';
      if (source === 'wind') text = 'Louder than the drone, yet nothing stands above its neighbours. The score stays near zero wherever you slide.';
      else if (verdict === 'lock') text = `Locked at ${Math.round(f)} Hz. Every tooth is on a peak, and that’s the pitch.`;
      else if (verdict === 'harmonic') text = 'Close! The teeth are on peaks, but this is a harmonic of the pitch. The real tracker checks lower for this. Try lower.';
      if (text !== shown) {
        result.textContent = text;
        shown = text;
      }
    },
  };
}

// Illustrative tracks. The mini's short, jumping pieces follow what the demo trace showed: tracks of about 0.2 to 0.4 s.
const GATE_SOURCES = {
  fpv: { name: 'FPV close by', drone: true, segments: [[0.1, 3.6]] as Segment[], hz: [600] },
  mini: { name: 'Mini further off', drone: true, segments: [[0.2, 0.55], [0.75, 1.05], [1.3, 1.65], [1.9, 2.25], [2.6, 2.95]] as Segment[], hz: [250, 500, 250, 750, 250] },
  bird: { name: 'A bird', drone: false, segments: [[0.8, 1.25]] as Segment[], hz: [1400] },
  insect: { name: 'An insect', drone: false, segments: [[0.6, 2.0]] as Segment[], hz: [900] },
};
type GateSource = keyof typeof GATE_SOURCES;
type Patience = '0' | '1' | '2';

// Doc 07 section 2: folds 1-3, 96 crossings below 100 m, theta 0.10, alarms on a 13 node-hour bed.
export const PATIENCE_RESULTS: Record<Patience, { crossings: string; alarms: string }> = {
  '0': { crossings: '57%', alarms: '2,566' },
  '1': { crossings: '45%', alarms: '223' },
  '2': { crossings: '19%', alarms: '0 in a short test' },
};

function gateScene(ui: HTMLElement): Scene {
  let source: GateSource = 'fpv';
  let patience: Patience = '2';
  let t = 0;
  const loopS = 4.4;
  ui.innerHTML = `
    <div data-source></div>
    <div class="how-row"><span>How patient?</span><div data-patience></div></div>
    <p class="how-result" data-result aria-live="polite"></p>`;
  const result = need<HTMLElement>(ui, '[data-result]');
  const writeResult = (): void => {
    const s = GATE_SOURCES[source];
    const on = gateEverOn(s.segments, Number(patience));
    const verdict = s.drone ? (on ? 'Caught.' : 'Missed.') : on ? 'False alarm.' : 'Rightly ignored.';
    const r = PATIENCE_RESULTS[patience];
    result.innerHTML = `<strong>${verdict}</strong> Across the simulated line at this setting: ${r.crossings} of crossings confirmed, ${r.alarms} false alarms per km per day.`;
  };
  const restart = (): void => {
    t = 0;
    writeResult();
  };
  chips(
    need<HTMLElement>(ui, '[data-source]'),
    (Object.keys(GATE_SOURCES) as GateSource[]).map((k) => [k, GATE_SOURCES[k].name] as [GateSource, string]),
    source,
    (s) => {
      source = s;
      restart();
    },
  );
  chips(need<HTMLElement>(ui, '[data-patience]'), [['0', 'None'], ['1', '1 s'], ['2', '2 s']], patience, (p) => {
    patience = p;
    restart();
  });
  writeResult();
  return {
    draw(v) {
      t = (t + v.dt) % loopS;
      clear(v);
      const s = GATE_SOURCES[source];
      const required = Number(patience);
      const base = v.h - 66;
      const top = 30;
      const toX = (time: number): number => (time / 3.8) * v.w;
      const toY = (hz: number): number => base - (Math.log(hz / 100) / Math.log(20)) * (base - top);
      label(v, 'Pitch the node is following, over time', 12, 20, TEXT, 13);
      s.segments.forEach(([a, b], i) => {
        const hz = s.hz[i] ?? s.hz[0];
        const from = Math.min(a, t);
        const to = Math.min(b, t);
        if (to <= from) return;
        const onAt = a + required;
        const armEnd = Math.min(to, onAt);
        v.g.lineWidth = 3;
        const wiggle = (x: number): number => toY(hz * (1 + 0.012 * Math.sin(x * 9)));
        const stroke = (x0: number, x1: number, color: string): void => {
          if (x1 <= x0) return;
          v.g.strokeStyle = color;
          v.g.beginPath();
          for (let x = x0; x <= x1 + 1e-6; x += 0.03) {
            const px = toX(x);
            if (x === x0) v.g.moveTo(px, wiggle(x));
            else v.g.lineTo(px, wiggle(x));
          }
          v.g.stroke();
        };
        stroke(from, armEnd, AMBER);
        stroke(Math.max(from, onAt), to, RED);
      });
      v.g.fillStyle = 'rgba(223, 230, 238, 0.5)';
      v.g.fillRect(toX(Math.min(t, 3.8)), top, 1, base - top);
      const gate = gateAt(s.segments, required, t);
      const color = gate.state === 'detecting' ? RED : gate.state === 'arming' ? AMBER : QUIET;
      const name = gate.state === 'detecting' ? 'Detecting' : gate.state === 'arming' ? 'Following a pitch, not yet sure' : 'Nothing to follow';
      label(v, name, 12, base + 22, color, 13);
      label(v, `Track age ${gate.ageS.toFixed(1)} s`, v.w - 12, base + 22, MUTED, 12, 'right');
      v.g.fillStyle = GRID;
      v.g.fillRect(12, base + 32, v.w - 24, 10);
      v.g.fillStyle = color;
      v.g.fillRect(12, base + 32, (v.w - 24) * clamp(gate.ageS / 3, 0, 1), 10);
      v.g.fillStyle = TEXT;
      v.g.fillRect(12 + (v.w - 24) * (required / 3) - 1, base + 28, 2, 18);
    },
  };
}

const LINE_NODES = 7;
const NODE_REACH = 1.15; // in node spacings
const NEIGHBOUR_AGE_S = 2;
const NEIGHBOUR_TIME = 5; // simulated seconds per second on screen

function neighbourScene(ui: HTMLElement, canvas: HTMLCanvasElement): Scene {
  let drone: { fx: number; fy: number; dir: 1 | -1 } | null = null;
  let onsets: Onset[] = [];
  let heard = new Map<number, number>();
  let birds: { node: number; left: number }[] = [];
  let simT = 0;
  let idle = 0;
  let alert: [Onset, Onset] | null = null;
  let last = { w: 1, h: 1 };
  const reset = (): void => {
    drone = null;
    onsets = [];
    heard = new Map();
    birds = [];
    alert = null;
    simT = 0;
    idle = 0;
  };
  ui.innerHTML = `
    <div class="how-chips">
      <button type="button" data-bird>A bird by one node</button>
      <button type="button" data-birds>Two different birds</button>
    </div>
    <p class="how-result" data-result aria-live="polite"></p>`;
  const result = need<HTMLElement>(ui, '[data-result]');
  const hint = 'Tap above or below the line to send a drone across it there.';
  result.textContent = hint;
  const addBird = (node: number, hz: number): void => {
    birds.push({ node, left: 2.5 });
    onsets.push({ node, t: simT, hz });
  };
  need<HTMLButtonElement>(ui, '[data-bird]').addEventListener('click', () => {
    reset();
    addBird(3, 2100);
    result.textContent = 'One node goes off, and nobody backs it up. No alert. Alone, a node would alarm about 120 times per km per day.';
  });
  need<HTMLButtonElement>(ui, '[data-birds]').addEventListener('click', () => {
    reset();
    addBird(2, 2100);
    addBird(3, 1400);
    result.textContent = 'Two neighbours go off, but on pitches that don’t match. No alert.';
  });
  const launch = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    // Starts on the side that was tapped: below the line it flies north, above it south.
    const dir = e.clientY - r.top > r.height / 2 ? 1 : -1;
    reset();
    drone = { fx: clamp((e.clientX - r.left) / r.width, 0.05, 0.95), fy: dir === 1 ? 1.02 : -0.02, dir };
    result.textContent = 'Nodes in reach start following the pitch…';
  };
  canvas.addEventListener('pointerdown', launch);
  return {
    draw(v) {
      last = { w: v.w, h: v.h };
      clear(v);
      const lineY = v.h / 2;
      const gap = v.w / (LINE_NODES + 0.4);
      const nodeX = (i: number): number => gap * (i + 0.7);
      simT += v.dt * NEIGHBOUR_TIME;
      if (drone) {
        drone.fy -= drone.dir * v.dt * 0.16;
        const px = drone.fx * last.w;
        const py = drone.fy * last.h;
        for (let i = 0; i < LINE_NODES; i++) {
          if (Math.hypot(px - nodeX(i), py - lineY) <= NODE_REACH * gap) {
            if (!heard.has(i)) heard.set(i, simT);
            if (simT - (heard.get(i) ?? simT) >= NEIGHBOUR_AGE_S && !onsets.some((o) => o.node === i)) {
              onsets.push({ node: i, t: simT, hz: 600 * (1 + 0.03 * Math.sin(i * 2.1)) });
            }
          } else {
            heard.delete(i);
          }
        }
        if (!alert) {
          alert = pairAlert(onsets);
          if (alert) {
            const [a, b] = alert;
            result.innerHTML = `<strong>Alert: crossing between nodes ${a.node + 1} and ${b.node + 1}, heading ${drone.dir === 1 ? 'north' : 'south'}.</strong> Two neighbours, one pitch. That’s where, which way and when.`;
          }
        }
        if (drone.fy < -0.08 || drone.fy > 1.08) drone = null;
      } else if (alert || onsets.length > 0) {
        idle += v.dt;
        if (idle > 6) {
          reset();
          result.textContent = hint;
        }
      }
      birds = birds.filter((b) => (b.left -= v.dt) > 0);
      v.g.strokeStyle = GRID;
      v.g.lineWidth = 1;
      v.g.setLineDash([6, 6]);
      v.g.beginPath();
      v.g.moveTo(0, lineY);
      v.g.lineTo(v.w, lineY);
      v.g.stroke();
      v.g.setLineDash([]);
      if (alert) {
        v.g.strokeStyle = RED;
        v.g.lineWidth = 4;
        v.g.beginPath();
        v.g.moveTo(nodeX(alert[0].node), lineY);
        v.g.lineTo(nodeX(alert[1].node), lineY);
        v.g.stroke();
      }
      for (let i = 0; i < LINE_NODES; i++) {
        const x = nodeX(i);
        const on = onsets.some((o) => o.node === i);
        const arming = heard.has(i);
        const color = on ? RED : arming ? AMBER : QUIET;
        if (arming || on) {
          v.g.strokeStyle = color;
          v.g.globalAlpha = 0.35;
          v.g.lineWidth = 1;
          v.g.beginPath();
          v.g.arc(x, lineY, NODE_REACH * gap * 0.55, 0, Math.PI * 2);
          v.g.stroke();
          v.g.globalAlpha = 1;
        }
        v.g.fillStyle = color;
        v.g.beginPath();
        v.g.arc(x, lineY, 9, 0, Math.PI * 2);
        v.g.fill();
        label(v, String(i + 1), x, lineY + 26, MUTED, 12, 'center');
      }
      for (const b of birds) label(v, 'bird', nodeX(b.node), lineY - 22, TEXT, 12, 'center');
      if (drone) {
        const px = drone.fx * v.w;
        const py = drone.fy * v.h;
        v.g.fillStyle = TEXT;
        v.g.beginPath();
        v.g.moveTo(px, py - 10 * drone.dir);
        v.g.lineTo(px - 8, py + 8 * drone.dir);
        v.g.lineTo(px + 8, py + 8 * drone.dir);
        v.g.closePath();
        v.g.fill();
      }
      label(v, 'north', 12, 20, MUTED, 12);
      label(v, 'south', 12, v.h - 10, MUTED, 12);
    },
    stop: () => canvas.removeEventListener('pointerdown', launch),
  };
}

// docs/protocol-v0.md section 4, DETECT.
const DETECT_FIELDS: [string, number, string][] = [
  ['Confidence', 4, 'How sure the node is, in 16 steps.'],
  ['Level', 6, 'How loud the band is. Neighbours’ levels hint at which one is closest.'],
  ['Azimuth', 9, 'Bearing to the sound. Only array nodes fill this in.'],
  ['Elevation', 5, 'How high the sound is. Array nodes only.'],
  ['Bearing error', 4, 'How far to trust that bearing.'],
  ['Line 1', 11, 'The strongest harmonic line, in Hz. The gateway matches neighbours on this.'],
  ['Line 2', 6, 'The second line, as an offset from the first.'],
  ['Class', 3, 'A guess at the type of drone.'],
  ['Clip', 1, 'Whether a short one-bit audio clip is ready, if the gateway wants precise timing.'],
];

function radioScene(ui: HTMLElement): Scene {
  let mode: 'event' | 'idle' = 'event';
  let t = 0;
  ui.innerHTML = `
    <div data-mode></div>
    <div class="how-bits" role="group" aria-label="The fields of a detection message">${DETECT_FIELDS.map(
      ([name, bits], i) =>
        `<button type="button" style="flex: ${bits} 1 0" data-i="${i}" aria-pressed="${i === 5}" aria-label="${esc(name)}, ${bits} bits">${bits}</button>`,
    ).join('')}</div>
    <p class="how-result" data-result aria-live="polite"></p>`;
  const result = need<HTMLElement>(ui, '[data-result]');
  const show = (i: number): void => {
    const [name, bits, text] = DETECT_FIELDS[i];
    result.innerHTML = `<strong>${esc(name)}, ${bits} bit${bits === 1 ? '' : 's'}.</strong> ${esc(text)}`;
  };
  show(5);
  ui.querySelectorAll<HTMLButtonElement>('.how-bits button').forEach((b) =>
    b.addEventListener('click', () => {
      ui.querySelectorAll('.how-bits button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      show(Number(b.dataset.i));
    }),
  );
  chips(need<HTMLElement>(ui, '[data-mode]'), [['event', 'Drone heard: 2 updates a second'], ['idle', 'All quiet: every 4 s']], mode, (m) => {
    mode = m;
    t = 0;
  });
  return {
    draw(v) {
      clear(v);
      const span = mode === 'event' ? 500 : 4000;
      t = (t + v.dt * (mode === 'event' ? 100 : 800)) % span;
      const parts: [number, number, string, string][] =
        mode === 'event'
          ? [[0, 25, AMBER, ''], [30, 290, BLUE, '16 node slots'], [300, 495, GRID, 'clips, if asked']]
          : [[0, 230, AMBER, ''], [250, 890, BLUE, 'alerts'], [900, 3980, GRID, 'health, ranging, join']];
      const barTop = v.h * 0.5 - 28;
      const barH = 56;
      const toX = (ms: number): number => 12 + (ms / span) * (v.w - 24);
      label(v, mode === 'event' ? 'One 500 ms frame, slowed down 10×' : 'One 4 s frame, slowed down', 12, 22, TEXT, 13);
      for (const [a, b, color, text] of parts) {
        v.g.globalAlpha = 0.45;
        v.g.fillStyle = color;
        v.g.fillRect(toX(a), barTop, toX(b) - toX(a), barH);
        v.g.globalAlpha = 1;
        if (text) label(v, text, (toX(a) + toX(b)) / 2, barTop + barH + 18, MUTED, 12, 'center');
      }
      label(v, 'beacon', 12, barTop - 8, AMBER, 12);
      if (mode === 'event') {
        for (let i = 0; i < 16; i++) {
          const a = 30 + i * 16;
          if (t >= a) {
            v.g.fillStyle = BLUE;
            v.g.fillRect(toX(a) + 1, barTop + 6, Math.max(2, toX(a + 11.6) - toX(a)), barH - 12);
          }
        }
      }
      v.g.fillStyle = TEXT;
      v.g.fillRect(toX(t), barTop - 4, 2, barH + 8);
      label(v, 'A slot’s timing says who sent it, and when.', 12, v.h - 12, MUTED, 12);
    },
  };
}

function installScene(ui: HTMLElement): Scene {
  let t = 0;
  ui.innerHTML = `<button type="button" class="how-action" data-again>Place another node</button><p class="how-result" data-result aria-live="polite"></p>`;
  const result = need<HTMLElement>(ui, '[data-result]');
  let shown = '';
  need<HTMLButtonElement>(ui, '[data-again]').addEventListener('click', () => (t = 0));
  return {
    draw(v) {
      t = Math.min(t + v.dt, 8.5);
      clear(v);
      const nodeX = v.w * 0.5;
      const groundY = v.h * 0.68;
      // Walks in, lingers beside the node, then walks away.
      const phoneX = t < 2 ? v.w * 0.1 + (t / 2) * (nodeX - 44 - v.w * 0.1) : t < 3.8 ? nodeX - 44 : nodeX - 44 + (t - 3.8) * v.w * 0.11;
      const phoneY = groundY - 34;
      const leaving = t >= 3.8 && t < 6.2;
      const committed = t >= 6.2;
      v.g.strokeStyle = GRID;
      v.g.lineWidth = 1;
      v.g.beginPath();
      v.g.moveTo(0, groundY);
      v.g.lineTo(v.w, groundY);
      v.g.stroke();
      if (!committed) {
        // Sound rings spread from the phone.
        v.g.strokeStyle = BLUE;
        v.g.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) {
          const r = ((t * 46 + i * 40) % 160) + 6;
          v.g.globalAlpha = Math.max(0, 1 - r / 166) * 0.8;
          v.g.beginPath();
          v.g.arc(phoneX, phoneY, r, 0, Math.PI * 2);
          v.g.stroke();
        }
        v.g.globalAlpha = 1;
      }
      v.g.fillStyle = TEXT;
      v.g.fillRect(phoneX - 7, phoneY - 13, 14, 26);
      v.g.fillStyle = committed ? BLUE : QUIET;
      v.g.beginPath();
      v.g.arc(nodeX, groundY - 9, 9, 0, Math.PI * 2);
      v.g.fill();
      label(v, 'node', nodeX, groundY + 20, MUTED, 12, 'center');
      label(v, 'phone', phoneX, phoneY - 20, MUTED, 12, 'center');
      if (committed) {
        v.g.strokeStyle = BLUE;
        v.g.lineWidth = 2;
        v.g.beginPath();
        v.g.arc(nodeX, groundY - 9, 22, 0, Math.PI * 2);
        v.g.stroke();
      }
      let text = 'The phone loops its GPS fix as a signed 3-second sound. The node listens with the same mic it uses for drones.';
      if (t >= 2 && t < 3.8) text = 'Set down beside it. The node keeps the fixes it hears loudest and closest.';
      if (leaving) text = 'Walking off stretches the sound slightly. That Doppler shift tells the node you’re leaving.';
      if (committed) text = 'Position fixed: 1.1 m median error in simulation, 3.6 m at worst. No GPS on the node, no app on the phone.';
      if (text !== shown) {
        result.textContent = text;
        shown = text;
      }
    },
  };
}

// Doc 07 section 11.5: the r3 draw, folds 4-5 clips, 199 crossings below 100 m. Gateway Pd.
export const STATUS_RESULTS = {
  default: { All: 0.1, FPV: 0.35, Mini: 0, Matrice: 0, note: 'The current default detector.' },
  long: { All: 0.29, FPV: 0.89, Mini: 0.13, Matrice: 0, note: 'A candidate that listens eight times longer. It’s still not the default, because it does far worse in very noisy places.' },
};
const STATUS_TARGET = 0.95;

function statusScene(ui: HTMLElement): Scene {
  let setting: keyof typeof STATUS_RESULTS = 'default';
  let grow = 0;
  ui.innerHTML = `<div data-setting></div><p class="how-result" data-result aria-live="polite"></p>`;
  const result = need<HTMLElement>(ui, '[data-result]');
  result.textContent = STATUS_RESULTS[setting].note;
  chips(need<HTMLElement>(ui, '[data-setting]'), [['default', 'Default detector'], ['long', 'Long-frame candidate']], setting, (s) => {
    setting = s;
    grow = 0;
    result.textContent = STATUS_RESULTS[s].note;
  });
  return {
    draw(v) {
      grow = Math.min(1, grow + v.dt * 1.6);
      clear(v);
      const data = STATUS_RESULTS[setting];
      const rows: [string, number][] = [['All', data.All], ['FPV', data.FPV], ['Mini', data.Mini], ['Matrice', data.Matrice]];
      const left = 76;
      const right = v.w - 58;
      const top = 44;
      const rowH = (v.h - top - 34) / rows.length;
      label(v, 'Low crossings confirmed, in simulation', 12, 22, TEXT, 13);
      rows.forEach(([name, value], i) => {
        const y = top + i * rowH;
        const h = Math.min(30, rowH * 0.6);
        label(v, name, left - 10, y + h / 2 + 4, TEXT, 13, 'right');
        v.g.fillStyle = GRID;
        v.g.fillRect(left, y, right - left, h);
        v.g.fillStyle = i === 0 ? AMBER : BLUE;
        v.g.fillRect(left, y, (right - left) * value * grow, h);
        label(v, `${Math.round(value * 100)}%`, right + 8, y + h / 2 + 4, TEXT, 13);
      });
      const tx = left + (right - left) * STATUS_TARGET;
      v.g.fillStyle = RED;
      v.g.fillRect(tx - 1, top - 6, 2, v.h - top - 22);
      label(v, 'Target 95%', tx, v.h - 10, RED, 12, 'center');
    },
  };
}

// --- The steps ---

const STEPS: Step[] = [
  {
    kicker: 'The idea',
    title: 'A drone can’t fly quietly',
    copy: `<p>Spinning rotors chop the air at a steady rate, which makes a stack of evenly spaced tones: a pitch and its harmonics. Few natural sounds look like that.</p>
      <p>SonicMesh is a line of cheap microphone nodes, a few hundred metres apart, that listens for that pattern. It works as a tripwire: did something cross, where, which way, and when?</p>
      <p>It also hears drones that send no radio signal at all.</p>`,
    scene: hearScene,
  },
  {
    kicker: 'Step 1: on the node',
    title: 'Find the pitch with a comb',
    copy: `<p>Loudness alone is useless outdoors, since wind is louder than a far-off drone. So each node asks a different question: <em>do evenly spaced peaks stand above the sound right beside them?</em></p>
      <p>Every 32 ms it tries hundreds of candidate pitches from 80 to 1200 Hz. Each one is a comb with a tooth on every harmonic.</p>
      <p><strong>Try it:</strong> find the drone’s pitch, then switch to wind.</p>`,
    scene: combScene,
  },
  {
    kicker: 'Step 2: on the node',
    title: 'Don’t believe it too quickly',
    copy: `<p>Birds and insects make tones as well. So a node only speaks up once it has followed one pitch without a break for 2 seconds.</p>
      <p>This one setting holds most of the trade-off. Less patience catches more drones and raises far more false alarms.</p>
      <p><strong>Try it:</strong> turn the patience down and send in the insect. Then try the mini, whose track keeps breaking. That’s the hardest open problem here.</p>`,
    scene: gateScene,
  },
  {
    kicker: 'Step 3: across the line',
    title: 'Two neighbours must agree',
    copy: `<p>A node alone isn’t trusted. The gateway raises an alert only when two adjacent nodes go off within 30 seconds on the same pitch, or an octave apart, because one node may lock onto a harmonic.</p>
      <p>Each node has its own patch of wind and birds, so two matching by chance is rare, and a real drone passes both.</p>
      <p><strong>Try it:</strong> send a drone, then try the birds. Time runs 5× fast here.</p>`,
    scene: neighbourScene,
  },
  {
    kicker: 'Step 4: on the radio',
    title: 'A detection is 49 bits',
    copy: `<p>No audio is streamed. A node sends a tiny LoRa message that fits in a 15-byte frame, in its own time slot, and the gateway’s beacon keeps everyone’s clocks together.</p>
      <p>That’s why a detector node can run on about 2 mA, for around 2 months on one battery cell, or indefinitely on a small panel. Those are estimates, not yet measured on a board.</p>
      <p><strong>Try it:</strong> tap the bits to see what each field carries.</p>`,
    scene: radioScene,
  },
  {
    kicker: 'Step 5: setting it up',
    title: 'The phone sings the node its location',
    copy: `<p>Detector nodes have no GPS, to save cost and power. The installer opens a web page, and the phone plays its GPS fix as sound while the node is set down.</p>
      <p>Later, nodes range each other over LoRa to catch one that has been moved or swapped, and report their health every 5 minutes in 23 bytes.</p>`,
    scene: installScene,
  },
  {
    kicker: 'Where it stands',
    title: 'It doesn’t work well enough yet',
    copy: `<p>The goal is 95% of low crossings confirmed, with at most one false alarm per km per day. In simulation neither setting gets close on detection, and FPVs make up nearly all of it.</p>
      <p>Mini and matrice are the hard cases: nodes do hear them, but rarely two in a row on one pitch. They’re out of the demo until that changes.</p>
      <p>Much of this rests on an <em>assumed</em> background noise level, and nothing has been tested in a field yet. That’s the next big step.</p>`,
    scene: statusScene,
  },
  {
    kicker: 'Your turn',
    title: 'Now try to sneak past it',
    copy: `<p>The scenes here were sketches. Behind this window, a simulated line of nodes runs the same comb logic as the research code, on simulated sound.</p>`,
    scene: null,
  },
];

export type HowTry = 'fly' | 'listen' | 'real';

export interface HowOptions {
  onClose(): void;
  onTry(what: HowTry): void;
}

export class HowItWorks {
  private index = 0;
  private scene: Scene | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private lastFrame = 0;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly opts: HowOptions,
  ) {
    dialog.addEventListener('close', () => {
      this.leaveStep();
      opts.onClose();
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') this.go(this.index + 1);
      if (e.key === 'ArrowLeft') this.go(this.index - 1);
    });
  }

  open(): void {
    this.dialog.showModal();
    this.show(0);
  }

  private go(i: number): void {
    if (i >= 0 && i < STEPS.length && i !== this.index) this.show(i);
  }

  private leaveStep(): void {
    cancelAnimationFrame(this.raf);
    this.scene?.stop?.();
    this.scene = null;
    this.canvas = null;
  }

  private show(i: number): void {
    this.leaveStep();
    this.index = i;
    const step = STEPS[i];
    const last = i === STEPS.length - 1;
    this.dialog.innerHTML = `
      <div class="how-wrap">
        <header class="how-top">
          <div class="how-dots">${STEPS.map(
            (s, n) =>
              `<button type="button" data-go="${n}" aria-label="Step ${n + 1}: ${esc(s.title)}" ${n === i ? 'aria-current="step"' : ''} class="${n < i ? 'seen' : ''}"></button>`,
          ).join('')}</div>
          <button type="button" class="how-close" data-close aria-label="Close">×</button>
        </header>
        <div class="how-main ${step.scene ? '' : 'no-scene'}">
          <div class="how-head"><p class="how-kicker">${esc(step.kicker)}</p><h2>${esc(step.title)}</h2></div>
          ${
            step.scene
              ? '<div class="how-stage"><div class="how-canvas"><canvas aria-hidden="true"></canvas></div><div class="how-ui"></div></div>'
              : `<div class="how-stage how-try">
                  <button type="button" data-try="fly"><strong>Fly a drone</strong><span>Take the sticks and try to cross unheard.</span></button>
                  <button type="button" data-try="listen"><strong>Hear what a node hears</strong><span>Open a node and watch its waterfall.</span></button>
                  <button type="button" data-try="real"><strong>See what’s real</strong><span>Every part of this simulation, tagged and sourced.</span></button>
                  <a href="${REPO}" target="_blank" rel="noopener"><strong>Read the research</strong><span>Code, data and every result on GitHub.</span></a>
                </div>`
          }
          <div class="how-copy">${step.copy}</div>
        </div>
        <footer class="how-nav">
          <button type="button" data-back ${i === 0 ? 'disabled' : ''}>Back</button>
          <span>${i + 1} of ${STEPS.length}</span>
          <button type="button" class="how-next" data-next>${last ? 'Start the simulation' : 'Next'}</button>
        </footer>
      </div>`;
    const d = this.dialog;
    need<HTMLElement>(d, '[data-close]').addEventListener('click', () => d.close());
    need<HTMLElement>(d, '[data-back]').addEventListener('click', () => this.go(i - 1));
    need<HTMLElement>(d, '[data-next]').addEventListener('click', () => (last ? d.close() : this.go(i + 1)));
    d.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => this.go(Number(b.dataset.go))));
    d.querySelectorAll<HTMLElement>('[data-try]').forEach((b) =>
      b.addEventListener('click', () => {
        d.close();
        this.opts.onTry(b.dataset.try as HowTry);
      }),
    );
    need<HTMLElement>(d, '.how-main').scrollTop = 0;
    need<HTMLElement>(d, '[data-next]').focus({ preventScroll: true });
    if (!step.scene) return;
    this.canvas = need<HTMLCanvasElement>(d, 'canvas');
    this.scene = step.scene(need<HTMLElement>(d, '.how-ui'), this.canvas);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    const canvas = this.canvas;
    const scene = this.scene;
    const g = canvas?.getContext('2d');
    if (!canvas || !scene || !g) return;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    scene.draw({ g, w, h, dt });
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }
}
