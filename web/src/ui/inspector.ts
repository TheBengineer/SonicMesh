import { CLASS_ACOUSTICS } from '../acoustics/model';
import { COMPONENT } from '../provenance/components';
import type { Ledger } from '../provenance/ledger';
import type { Selection } from '../selection';
import type { NodeSpec, PathSpec } from '../sim/scenario';
import { DRONE_CLASSES, type DroneState, type World } from '../sim/world';
import { badgeHtml, esc, fmt } from './dom';

// `key` is the structure of the panel. The DOM is rebuilt only when it changes, so open dropdowns stay open.
// `live` holds values that change every tick and are written in place.
export interface Panel {
  key: string;
  html: string;
  live: Record<string, string>;
}

export type InspectTab = 'details' | 'waterfall';

// Node waterfall state, owned by the app. The panel only shows it.
export interface InspectView {
  tab: InspectTab;
  mic: string | null;
  listening: string | null;
  gain: number;
  overlay: boolean;
  truth: boolean;
  ambientLabel: string;
  listenNote: string;
}

export interface InspectContext {
  world: World;
  selection: Selection;
  ledger: Ledger;
  view: InspectView;
}

export type ActionData = Record<string, string | undefined>;

const TAB_LABEL: Record<InspectTab, string> = { details: 'Details', waterfall: 'Waterfall' };

function live(name: string): string {
  return `<span data-live="${name}"></span>`;
}

function rows(pairs: [string, string][]): string {
  return pairs
    .map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`)
    .join('');
}

function pathLabel(path: PathSpec): string {
  switch (path.kind) {
    case 'manual':
      return 'Hand-flown';
    case 'hover':
      return 'Hover at a point';
    case 'crossing':
      return `Crossing at ${fmt(path.speed_mps)} m/s`;
    case 'out_and_back':
      return `Out and back at ${fmt(path.speed_mps)} m/s`;
    case 'terrain_follow':
      return `Terrain-following at ${fmt(path.speed_mps)} m/s`;
  }
}

// Mic keys of a node, as the engine names them: node id and mic index.
export function micKeysOf(n: NodeSpec): string[] {
  const count = n.kind === 'array' ? 4 : 1;
  return Array.from({ length: count }, (_, j) => `${n.id}.${j}`);
}

function droneTab(ctx: InspectContext, d: DroneState): Panel {
  const { world, ledger } = ctx;
  const tag = (id: string): string => badgeHtml(ledger.byId.get(id));
  const scripted = d.path.kind !== 'manual';
  const classOptions = Object.entries(DRONE_CLASSES)
    .map(([k, v]) => `<option value="${k}"${k === d.class ? ' selected' : ''}>${esc(v.label)}</option>`)
    .join('');
  const flightButton = (mode: 'manual' | 'gps', label: string): string =>
    `<button data-action="drone-flight" data-id="${d.id}" data-value="${mode}" aria-pressed="${d.flight === mode}">${label}</button>`;
  const pathButton = (kind: string, label: string): string =>
    `<button data-action="drone-path" data-id="${d.id}" data-value="${kind}" aria-pressed="${d.path.kind === kind}">${label}</button>`;
  const alt = d.alt;
  const agl = alt - world.terrain.height(d.x, d.y);
  const bpf = CLASS_ACOUSTICS[d.class].bpf_hz;
  return {
    key: `drone|${d.id}|${d.class}|${d.flight}|${d.path.kind}`,
    html: `
      <h2>Drone ${d.id}</h2>
      <div class="badges">${tag(COMPONENT.droneDynamics)}${tag(COMPONENT.droneClasses)}${scripted ? tag(COMPONENT.dronePaths) : ''}${tag(COMPONENT.droneRotors)}</div>
      ${rows([
        ['Class', `<select data-action="drone-class" data-id="${d.id}" aria-label="Drone class">${classOptions}</select>`],
        ['Path', esc(pathLabel(d.path))],
        ['True position', live('d-pos')],
        ['Speed', live('d-speed')],
        ['Vertical speed', live('d-vspeed')],
        ['Altitude', live('d-alt')],
      ])}
      <h3>Flight</h3>
      <div class="actions">${flightButton('manual', 'Manual')}${flightButton('gps', 'GPS hover')}</div>
      <p class="note">${
        scripted
          ? 'On a scripted path. Moving the sticks takes manual control.'
          : 'Manual: sticks give acceleration and keep momentum. GPS hover: sticks give speed and the drone stops when they are centred.'
      }</p>
      <h3>Path</h3>
      <div class="actions">
        ${pathButton('manual', 'Hand-fly')}
        ${pathButton('hover', 'Hover here')}
        ${pathButton('crossing', 'Crossing 20 m/s')}
        ${pathButton('out_and_back', 'Out and back')}
        ${pathButton('terrain_follow', 'Terrain-follow')}
      </div>
      <p class="note">Drawn at an exaggerated size so it is visible at map scale.</p>
      <h3>Rotor speeds</h3>
      <canvas class="plot" data-plot="rotors" width="300" height="150" aria-label="Rotor blade-pass frequencies over the last 5 s"></canvas>
      <p class="note">Emitted blade-pass frequency of each rotor over the last 5 s, from thrust and wobble. Hover gives ${bpf} Hz for this class (ASSUMED).</p>
      <h3>Emitted spectrum</h3>
      <canvas class="plot" data-plot="spectrum" width="300" height="150" aria-label="Emitted spectrum at 1 m"></canvas>
      <p class="note">The synthetic source at 1 m, dB SPL per bin, 0 to 4 kHz.</p>
      <div class="actions"><button data-action="drone-remove" data-id="${d.id}">Remove drone</button></div>
    `,
    live: {
      'd-pos': `${fmt(d.x)}, ${fmt(d.y)} m`,
      'd-speed': `${fmt(Math.hypot(d.vx, d.vy))} m/s`,
      'd-vspeed': `${fmt(d.vz)} m/s`,
      'd-alt': `${fmt(alt)} m above datum, ${fmt(agl)} m above ground`,
    },
  };
}

function detailsNode(ctx: InspectContext, n: NodeSpec): Panel {
  const { world, ledger } = ctx;
  const isArray = n.kind === 'array';
  const other = isArray ? 'detector' : 'array';
  return {
    key: `node|${n.id}|${n.kind}`,
    html: `
      <h2>Node ${n.id}</h2>
      <div class="badges">${badgeHtml(ledger.byId.get(isArray ? COMPONENT.nodeArray : COMPONENT.nodeDetector))}${badgeHtml(ledger.byId.get(COMPONENT.mic))}</div>
      ${rows([
        ['Type', isArray ? 'Array, 4 mics' : 'Detector, 1 mic'],
        ['True position', live('n-pos')],
        ['Ground', live('n-ground')],
      ])}
      <div class="actions">
        <button data-action="node-kind" data-id="${n.id}" data-value="${other}">Make ${other}</button>
        <button data-action="node-remove" data-id="${n.id}">Remove node</button>
      </div>
      <p class="note">Open the Waterfall tab for the mic audio, band level and listen mode. Detection, bearings and messages arrive with the node core in M2.</p>
    `,
    live: {
      'n-pos': `${fmt(n.x)}, ${fmt(n.y)} m`,
      'n-ground': `${fmt(world.terrain.height(n.x, n.y))} m`,
    },
  };
}

function waterfallNode(ctx: InspectContext, n: NodeSpec): Panel {
  const { ledger, view } = ctx;
  const isArray = n.kind === 'array';
  const mics = micKeysOf(n);
  const mic = view.mic && mics.includes(view.mic) ? view.mic : mics[0];
  const listening = view.listening === mic;
  const options = mics
    .map((k, j) => `<option value="${k}"${k === mic ? ' selected' : ''}>Mic ${j + 1} (${k})</option>`)
    .join('');
  const truthOn = view.truth;
  const overlayOn = truthOn && view.overlay;
  return {
    key: `waterfall|${n.id}|${n.kind}|${mic}|${listening}|${overlayOn}|${truthOn}|${view.ambientLabel}`,
    html: `
      <h2>Node ${n.id}, waterfall</h2>
      <div class="badges">${badgeHtml(ledger.byId.get(isArray ? COMPONENT.nodeArray : COMPONENT.nodeDetector))}${badgeHtml(ledger.byId.get(COMPONENT.waterfall))}</div>
      <div class="actions"><select data-action="mic-select" data-id="${n.id}" aria-label="Mic">${options}</select></div>
      <canvas class="plot wf" data-plot="waterfall" width="300" height="512" aria-label="Mic spectrogram, 0 to 8 kHz"></canvas>
      <div class="scale"><span>10 dB</span><span class="ramp"></span><span>90 dB</span></div>
      <p class="note">dB SPL per bin, as the line level of a sine in that bin. 1024-point Hann FFT, 50 % overlap, 0 to 8 kHz, newest on the right.</p>
      <div class="actions"><button data-action="overlay" data-id="${n.id}" aria-pressed="${overlayOn}"${truthOn ? '' : ' disabled'}>Truth: blade-pass harmonics</button></div>
      <p class="note">${
        truthOn
          ? 'White dots: the true blade-pass harmonics of each rotor at this mic, from the emitted rotor speed and the Doppler delay.'
          : 'Turn truth on (T) to show the true blade-pass harmonics.'
      }</p>
      <h3>Band level and SNR</h3>
      <canvas class="plot" data-plot="level" width="300" height="150" aria-label="Band level and SNR over time"></canvas>
      <p class="note">Band 100 to 4000 Hz per 100 ms. SNR is that band minus the ambient setting (${esc(view.ambientLabel)}), so with no drone it sits near 0 dB.</p>
      <h3>Listen</h3>
      <div class="actions"><button data-action="listen" data-value="${mic}" aria-pressed="${listening}">${listening ? 'Stop listening' : 'Listen to this mic'}</button></div>
      <label class="gain">Gain <input type="range" min="0" max="2" step="0.05" value="${view.gain}" data-action="listen-gain" aria-label="Listen gain"></label>
      <p class="note">${live('listen-note')}</p>
    `,
    live: { 'listen-note': view.listenNote },
  };
}

function gatewayTab(ctx: InspectContext): Panel {
  const { world, ledger } = ctx;
  const g = world.state.gateway;
  return {
    key: 'gateway',
    html: `
      <h2>Gateway</h2>
      <div class="badges">${badgeHtml(ledger.byId.get(COMPONENT.gateway))}</div>
      ${rows([['True position', live('g-pos')]])}
      <p class="note">Drag it on the ground to move it. Fusion of detections arrives in M4.</p>
    `,
    live: { 'g-pos': `${fmt(g.x)}, ${fmt(g.y)} m` },
  };
}

function radarTab(ctx: InspectContext): Panel {
  const { ledger } = ctx;
  return {
    key: 'radar',
    html: `
      <h2>Radar</h2>
      <div class="badges">${badgeHtml(ledger.byId.get(COMPONENT.radar))}</div>
      ${rows([
        ['Coverage', '1500 m hemisphere'],
        ['Low-elevation floor', 'below 3 degrees'],
      ])}
      <p class="note">Coverage only. Detections, tracks and cues come in M4.</p>
    `,
    live: {},
  };
}

function sceneTab(ctx: InspectContext): Panel {
  const { world, ledger } = ctx;
  const s = world.state;
  const t = world.terrain;
  const tags = [COMPONENT.terrain, COMPONENT.road, COMPONENT.trees]
    .map((id) => badgeHtml(ledger.byId.get(id)))
    .join('');
  return {
    key: `scene|${world.name}|${s.truth}|${s.nodes.length}|${s.drones.length}`,
    html: `
      <h2>${esc(world.name)}</h2>
      <div class="badges">${tags}</div>
      ${rows([
        ['Seed', String(t.seed)],
        ['Terrain', `${t.size[0] / 1000} x ${t.size[1] / 1000} km`],
        ['Nodes', `${s.nodes.length}`],
        ['Drones', `${s.drones.length}`],
        ['Truth overlay', s.truth ? 'on' : 'off'],
        ['Sim time', live('s-time')],
      ])}
      <p class="note">Click a node, drone, the gateway or the radar to inspect it. Drag nodes and the gateway on the ground. Click the ground to add when a + button is active.</p>
    `,
    live: { 's-time': `${fmt(s.tick * 0.01, 2)} s, tick ${s.tick}` },
  };
}

function detailsPanel(ctx: InspectContext): Panel {
  const sel = ctx.selection;
  if (sel?.kind === 'node') {
    const n = ctx.world.state.nodes.find((o) => o.id === sel.id);
    if (n) return detailsNode(ctx, n);
  }
  if (sel?.kind === 'drone') {
    const d = ctx.world.state.drones.find((o) => o.id === sel.id);
    if (d) return droneTab(ctx, d);
  }
  if (sel?.kind === 'gateway') return gatewayTab(ctx);
  if (sel?.kind === 'radar') return radarTab(ctx);
  return sceneTab(ctx);
}

function selectionId(s: Selection): number | undefined {
  return s && 'id' in s ? s.id : undefined;
}

// Lets the user select gateway, nodes and drones without the 3D view.
function objectList(ctx: InspectContext): Panel {
  const { world, selection } = ctx;
  const s = world.state;
  const items: { kind: string; id?: number; label: string }[] = [
    { kind: 'gateway', label: 'Gateway' },
    ...s.nodes.map((n) => ({ kind: 'node', id: n.id, label: `Node ${n.id}, ${n.kind}` })),
    ...s.drones.map((d) => ({ kind: 'drone', id: d.id, label: `Drone ${d.id}, ${DRONE_CLASSES[d.class].label}` })),
  ];
  const buttons = items
    .map((it) => {
      const on = selection?.kind === it.kind && selectionId(selection) === it.id;
      const idAttr = it.id === undefined ? '' : ` data-id="${it.id}"`;
      return `<button data-action="select" data-kind="${it.kind}"${idAttr} aria-pressed="${on}">${esc(it.label)}</button>`;
    })
    .join('');
  const current = `${selection?.kind ?? ''}:${selectionId(selection) ?? ''}`;
  return {
    key: `objects|${items.map((it) => `${it.kind}${it.id ?? ''}${it.label}`).join(',')}|${current}`,
    html: `<h3>Objects</h3><div class="object-list">${buttons}</div>`,
    live: {},
  };
}

export function buildPanel(ctx: InspectContext): Panel {
  const sel = ctx.selection;
  const tabs: InspectTab[] = sel?.kind === 'node' ? ['details', 'waterfall'] : ['details'];
  const tab: InspectTab = tabs.includes(ctx.view.tab) ? ctx.view.tab : 'details';
  let main: Panel | null = null;
  if (tab === 'waterfall' && sel?.kind === 'node') {
    const n = ctx.world.state.nodes.find((o) => o.id === sel.id);
    if (n) main = waterfallNode(ctx, n);
  }
  const body = main ?? detailsPanel(ctx);
  const list = objectList(ctx);
  const bar =
    tabs.length < 2
      ? ''
      : `<div class="inspector-tabs">${tabs
          .map((t) => `<button data-action="inspector-tab" data-value="${t}" aria-selected="${t === tab}">${TAB_LABEL[t]}</button>`)
          .join('')}</div>`;
  return {
    key: `${tab}|${list.key}|${body.key}`,
    html: bar + list.html + body.html,
    live: body.live,
  };
}

export class Inspector {
  private key = '';

  constructor(
    private readonly root: HTMLElement,
    onAction: (action: string, data: ActionData) => void,
  ) {
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('button[data-action]');
      if (el?.dataset.action) onAction(el.dataset.action, { ...el.dataset });
    });
    root.addEventListener('change', (e) => {
      const el = e.target as HTMLSelectElement;
      if (el.tagName === 'SELECT' && el.dataset.action) onAction(el.dataset.action, { ...el.dataset, value: el.value });
    });
    root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.type === 'range' && el.dataset.action) onAction(el.dataset.action, { ...el.dataset, value: el.value });
    });
  }

  update(panel: Panel): void {
    if (panel.key !== this.key) {
      this.key = panel.key;
      this.root.innerHTML = panel.html;
    }
    for (const [name, text] of Object.entries(panel.live)) {
      const el = this.root.querySelector<HTMLElement>(`[data-live="${name}"]`);
      if (el && el.textContent !== text) el.textContent = text;
    }
  }
}
