import { COMPONENT } from '../provenance/components';
import type { Ledger } from '../provenance/ledger';
import type { Selection } from '../selection';
import type { PathSpec } from '../sim/scenario';
import { DRONE_CLASSES, type DroneState, type World } from '../sim/world';
import { badgeHtml, esc, fmt } from './dom';

// `key` is the structure of the panel. The DOM is rebuilt only when it changes, so open dropdowns stay open.
// `live` holds values that change every tick and are written in place.
export interface Panel {
  key: string;
  html: string;
  live: Record<string, string>;
}

export interface InspectContext {
  world: World;
  selection: Selection;
  ledger: Ledger;
}

export type ActionData = Record<string, string | undefined>;

interface Tab {
  id: string;
  label: string;
  applies(selection: Selection): boolean;
  build(ctx: InspectContext): Panel;
}

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
  return {
    key: `drone|${d.id}|${d.class}|${d.flight}|${d.path.kind}`,
    html: `
      <h2>Drone ${d.id}</h2>
      <div class="badges">${tag(COMPONENT.droneDynamics)}${tag(COMPONENT.droneClasses)}${scripted ? tag(COMPONENT.dronePaths) : ''}</div>
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

function nodeTab(ctx: InspectContext, id: number): Panel | null {
  const { world, ledger } = ctx;
  const n = world.state.nodes.find((o) => o.id === id);
  if (!n) return null;
  const isArray = n.kind === 'array';
  const other = isArray ? 'detector' : 'array';
  return {
    key: `node|${n.id}|${n.kind}`,
    html: `
      <h2>Node ${n.id}</h2>
      <div class="badges">${badgeHtml(ledger.byId.get(isArray ? COMPONENT.nodeArray : COMPONENT.nodeDetector))}</div>
      ${rows([
        ['Type', isArray ? 'Array, 4 mics' : 'Detector, 1 mic'],
        ['True position', live('n-pos')],
        ['Ground', live('n-ground')],
      ])}
      <div class="actions">
        <button data-action="node-kind" data-id="${n.id}" data-value="${other}">Make ${other}</button>
        <button data-action="node-remove" data-id="${n.id}">Remove node</button>
      </div>
      <p class="note">A marker in M0. Detection, bearings and messages arrive with the node core in M2.</p>
    `,
    live: {
      'n-pos': `${fmt(n.x)}, ${fmt(n.y)} m`,
      'n-ground': `${fmt(world.terrain.height(n.x, n.y))} m`,
    },
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
        ['Truth overlay', s.truth ? 'on (no effect yet)' : 'off (no effect yet)'],
        ['Sim time', live('s-time')],
      ])}
      <p class="note">Click a node, drone, the gateway or the radar to inspect it. Drag nodes and the gateway on the ground. Click the ground to add when a + button is active.</p>
    `,
    live: { 's-time': `${fmt(s.tick * 0.01, 2)} s, tick ${s.tick}` },
  };
}

const TABS: Tab[] = [
  {
    id: 'details',
    label: 'Details',
    applies: () => true,
    build(ctx) {
      const sel = ctx.selection;
      if (sel?.kind === 'node') {
        const p = nodeTab(ctx, sel.id);
        if (p) return p;
      }
      if (sel?.kind === 'drone') {
        const d = ctx.world.state.drones.find((o) => o.id === sel.id);
        if (d) return droneTab(ctx, d);
      }
      if (sel?.kind === 'gateway') return gatewayTab(ctx);
      if (sel?.kind === 'radar') return radarTab(ctx);
      return sceneTab(ctx);
    },
  },
];

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
  const tab = TABS.find((t) => t.applies(ctx.selection)) ?? TABS[0];
  const panel = tab.build(ctx);
  const list = objectList(ctx);
  const key = `${list.key}|${panel.key}`;
  if (TABS.length < 2) return { ...panel, key, html: list.html + panel.html };
  const bar = TABS.map(
    (t) => `<button data-action="inspector-tab" data-value="${t.id}" aria-selected="${t.id === tab.id}">${esc(t.label)}</button>`,
  ).join('');
  return {
    ...panel,
    key: `${tab.id}|${key}`,
    html: `<div class="inspector-tabs">${bar}</div>${list.html}${panel.html}`,
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
