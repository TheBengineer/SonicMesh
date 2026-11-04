import exampleScenario from '../scenarios/example.json';
import { COMPONENT } from './provenance/components';
import { loadLedger, type Ledger } from './provenance/ledger';
import { combineSticks, gamepadStick, keyboardStick, quantizeStick, sameStick, zeroStick } from './input/sticks';
import type { Selection } from './selection';
import { WorldView, type Hit, type Target, type ViewMode } from './scene/worldView';
import { badgeHtml, download, esc, need, readJson } from './ui/dom';
import { Inspector, buildPanel, type ActionData } from './ui/inspector';
import { renderAbout, renderLedger } from './ui/overlays';
import { Timeline } from './ui/timeline';
import { parseInputLog, type LogEntry } from './sim/inputs';
import { parseScenario, type DroneClass, type FlightMode, type NodeKind, type PathSpec, type ScenarioFile } from './sim/scenario';
import { Runner } from './sim/runner';
import type { DroneState, World } from './sim/world';

type Mode = 'select' | 'add-node' | 'add-drone';

const CLICK_PX = 5;
const DRAG_MIN_M = 0.5;
const DRONE_DROP_ALT_M = 30;

function nextId(ids: number[]): number {
  return Math.max(0, ...ids) + 1;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function presentIds(world: World): Set<string> {
  const s = world.state;
  const ids = new Set<string>([COMPONENT.terrain, COMPONENT.road, COMPONENT.trees, COMPONENT.gateway, COMPONENT.radar]);
  if (s.nodes.some((n) => n.kind === 'detector')) ids.add(COMPONENT.nodeDetector);
  if (s.nodes.some((n) => n.kind === 'array')) ids.add(COMPONENT.nodeArray);
  if (s.drones.length > 0) {
    ids.add(COMPONENT.droneDynamics);
    ids.add(COMPONENT.droneClasses);
  }
  if (s.drones.some((d) => d.path.kind !== 'manual')) ids.add(COMPONENT.dronePaths);
  return ids;
}

function selectionFor(t: Target): Selection {
  if (t.kind === 'node') return { kind: 'node', id: t.id };
  if (t.kind === 'drone') return { kind: 'drone', id: t.id };
  if (t.kind === 'gateway') return { kind: 'gateway' };
  return null;
}

function pathPreset(kind: string, d: DroneState, runner: Runner): PathSpec | null {
  const here = { x: d.x, y: d.y };
  const far = runner.world.terrain.clamp(d.x >= 0 ? d.x - 1000 : d.x + 1000, d.y);
  switch (kind) {
    case 'manual':
      return { kind: 'manual', start: { x: d.x, y: d.y, altitude_m: d.alt } };
    case 'hover':
      return { kind: 'hover', at: here, altitude_m: d.alt };
    case 'crossing':
      return { kind: 'crossing', from: here, to: far, speed_mps: 20, altitude_m: d.alt };
    case 'out_and_back':
      return { kind: 'out_and_back', from: here, to: far, speed_mps: 15, altitude_m: d.alt };
    case 'terrain_follow':
      return { kind: 'terrain_follow', from: here, to: far, speed_mps: 15, clearance_m: 30 };
    default:
      return null;
  }
}

function markPressed(scope: ParentNode, selector: string, attr: string, value: string): void {
  scope.querySelectorAll<HTMLButtonElement>(selector).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
  });
}

export function startApp(root: HTMLElement): void {
  const ledger: Ledger = loadLedger();
  const runner = new Runner(parseScenario(exampleScenario));
  const view = new WorldView(need<HTMLElement>(root, '#scene'));
  view.setWorld(runner.world);
  const legendEl = need<HTMLElement>(root, '#legend');
  const aboutDialog = need<HTMLDialogElement>(document, '#about-dialog');
  const ledgerDialog = need<HTMLDialogElement>(document, '#ledger-dialog');
  renderAbout(aboutDialog);

  let selection: Selection = null;
  let mode: Mode = 'select';
  let viewMode: ViewMode = 'orbit';
  let drag: { target: Target; lastX: number; lastY: number } | null = null;
  let press: { x: number; y: number; hit: Hit | null } | null = null;
  let message = '';
  let messageTimer = 0;
  let lastPolled = zeroStick();
  let lastTarget: number | null = null;
  let lastLegend = '';
  const keysDown = new Set<string>();

  function flash(text: string): void {
    message = text;
    window.clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => (message = ''), 6000);
  }

  function select(s: Selection): void {
    selection = s;
    if (viewMode === 'follow' && s?.kind === 'drone') view.setView('follow', s.id);
  }

  function setViewMode(v: ViewMode): void {
    viewMode = v;
    const followId =
      selection?.kind === 'drone' ? selection.id : (runner.world.state.drones[0]?.id ?? null);
    view.setView(v, followId);
    markPressed(root, '[data-view]', 'view', v);
  }

  function setMode(m: Mode): void {
    mode = m;
    markPressed(root, '[data-mode]', 'mode', m);
  }

  function reload(scn: ScenarioFile, log: LogEntry[] = []): void {
    runner.newRun(scn, log);
    view.setWorld(runner.world);
    select(null);
  }

  function replay(): void {
    runner.clock.playing = false;
    runner.reset();
    flash('Back at tick 0. Press play to replay the logged inputs.');
  }

  function toggleTruth(): void {
    runner.apply({ type: 'truth', on: !runner.world.state.truth });
  }

  function toggleFlight(): void {
    if (selection?.kind !== 'drone') return;
    const id = selection.id;
    const d = runner.world.state.drones.find((o) => o.id === id);
    if (!d) return;
    const flight: FlightMode = d.flight === 'manual' ? 'gps' : 'manual';
    runner.apply({ type: 'drone_flight', id: d.id, mode: flight });
  }

  function removeSelected(): void {
    if (selection?.kind === 'node') runner.apply({ type: 'node_remove', id: selection.id });
    else if (selection?.kind === 'drone') runner.apply({ type: 'drone_remove', id: selection.id });
    else return;
    select(null);
  }

  // Keyboard and gamepad sticks go to the selected drone. Only changes are logged, so an idle controller does not
  // touch the run.
  function pollSticks(): void {
    const polled = quantizeStick(combineSticks(keyboardStick(keysDown), gamepadStick()));
    const id = selection?.kind === 'drone' ? selection.id : null;
    if (sameStick(polled, lastPolled) && id === lastTarget) return;
    lastPolled = polled;
    lastTarget = id;
    if (id === null) return;
    const d = runner.world.state.drones.find((o) => o.id === id);
    if (!d) return;
    const active = polled.x !== 0 || polled.y !== 0 || polled.z !== 0;
    if (active && d.path.kind !== 'manual') {
      runner.apply({
        type: 'drone_path',
        id,
        path: { kind: 'manual', start: { x: d.x, y: d.y, altitude_m: d.alt } },
      });
    }
    runner.apply({ type: 'drone_stick', id, ...polled });
  }

  function onAction(action: string, data: ActionData): void {
    const id = Number(data.id);
    const value = data.value ?? '';
    switch (action) {
      case 'select':
        if (data.kind === 'gateway') select({ kind: 'gateway' });
        else if (data.kind === 'node' || data.kind === 'drone') select({ kind: data.kind, id });
        break;
      case 'node-kind':
        runner.apply({ type: 'node_kind', id, kind: value as NodeKind });
        break;
      case 'node-remove':
        runner.apply({ type: 'node_remove', id });
        select(null);
        break;
      case 'drone-class':
        runner.apply({ type: 'drone_class', id, cls: value as DroneClass });
        break;
      case 'drone-flight':
        runner.apply({ type: 'drone_flight', id, mode: value as FlightMode });
        break;
      case 'drone-path': {
        const d = runner.world.state.drones.find((o) => o.id === id);
        const path = d ? pathPreset(value, d, runner) : null;
        if (path) runner.apply({ type: 'drone_path', id, path });
        break;
      }
      case 'drone-remove':
        runner.apply({ type: 'drone_remove', id });
        select(null);
        break;
    }
    refresh();
  }

  const inspector = new Inspector(need<HTMLElement>(root, '#inspector'), onAction);
  const timeline = new Timeline(need<HTMLElement>(root, '#timeline'), {
    togglePlay: () => (runner.clock.playing = !runner.clock.playing),
    step: () => runner.stepOnce(),
    reset: () => {
      reload(runner.scenario);
      flash('Log cleared. Back at the scenario file.');
    },
    replay,
    setSpeed: (s) => runner.clock.setSpeed(s),
    toggleTruth,
    loadScenario: async (file) => {
      try {
        const scn = parseScenario(await readJson(file));
        reload(scn);
        flash(`Loaded ${scn.name}`);
      } catch (err) {
        flash(errorText(err));
      }
    },
    loadInputs: async (file) => {
      try {
        const log = parseInputLog(await readJson(file));
        reload(runner.scenario, log);
        flash(`Loaded ${log.length} inputs. Press play to replay them.`);
      } catch (err) {
        flash(errorText(err));
      }
    },
    saveRun: () => {
      download('sonicmesh-scenario.json', runner.scenario);
      download('sonicmesh-inputs.json', { format: 'sonicmesh-input-log', version: 1, entries: runner.log });
    },
  });

  // Scene pointer handling. Clicks select; a press on a node or the gateway drags it on the ground.
  const sceneEl = need<HTMLElement>(root, '#scene');
  sceneEl.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      const hit = view.pick(e.clientX, e.clientY);
      press = { x: e.clientX, y: e.clientY, hit };
      const t = hit?.target;
      if (mode === 'select' && t && (t.kind === 'node' || t.kind === 'gateway')) {
        e.stopPropagation();
        drag = { target: t, lastX: NaN, lastY: NaN };
        select(selectionFor(t));
      }
    },
    { capture: true },
  );

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const g = view.groundAt(e.clientX, e.clientY);
    if (!g || Math.hypot(g.x - drag.lastX, g.y - drag.lastY) < DRAG_MIN_M) return;
    drag.lastX = g.x;
    drag.lastY = g.y;
    const t = drag.target;
    const x = Math.round(g.x * 10) / 10;
    const y = Math.round(g.y * 10) / 10;
    if (t.kind === 'gateway') runner.apply({ type: 'gateway_move', x, y });
    else if (t.kind === 'node') runner.apply({ type: 'node_move', id: t.id, x, y });
  });

  window.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    drag = null;
    if (!p || e.button !== 0) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_PX) return;
    const hit = p.hit;
    if (mode === 'select') {
      select(hit ? selectionFor(hit.target) : null);
      return;
    }
    if (!hit || hit.target.kind !== 'terrain') return;
    if (mode === 'add-node') {
      const id = nextId(runner.world.state.nodes.map((n) => n.id));
      const kind = need<HTMLSelectElement>(root, '#place-kind').value as NodeKind;
      runner.apply({ type: 'node_add', node: { id, kind, x: hit.x, y: hit.y } });
      select({ kind: 'node', id });
    } else {
      const id = nextId(runner.world.state.drones.map((d) => d.id));
      const cls = need<HTMLSelectElement>(root, '#place-class').value as DroneClass;
      const alt = runner.world.terrain.height(hit.x, hit.y) + DRONE_DROP_ALT_M;
      runner.apply({
        type: 'drone_add',
        drone: { id, class: cls, flight: 'gps', path: { kind: 'hover', at: { x: hit.x, y: hit.y }, altitude_m: alt } },
      });
      select({ kind: 'drone', id });
    }
    setMode('select');
  });

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    keysDown.add(e.code);
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyP':
        runner.clock.playing = !runner.clock.playing;
        break;
      case 'Period':
        runner.stepOnce();
        break;
      case 'KeyR':
        replay();
        break;
      case 'KeyF':
        setViewMode('follow');
        break;
      case 'KeyT':
        toggleTruth();
        break;
      case 'KeyM':
        toggleFlight();
        break;
      case 'Delete':
      case 'Backspace':
        removeSelected();
        break;
    }
  });
  window.addEventListener('keyup', (e) => keysDown.delete(e.code));
  window.addEventListener('blur', () => keysDown.clear());

  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
    b.addEventListener('click', () => setViewMode(b.dataset.view as ViewMode)),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.mode as Mode)),
  );
  need<HTMLButtonElement>(root, '#select-radar').addEventListener('click', () => select({ kind: 'radar' }));
  need<HTMLButtonElement>(root, '#open-about').addEventListener('click', () => aboutDialog.showModal());
  need<HTMLButtonElement>(root, '#open-whats-real').addEventListener('click', () => {
    renderLedger(ledgerDialog, ledger, presentIds(runner.world));
    ledgerDialog.showModal();
  });

  function refresh(): void {
    inspector.update(buildPanel({ world: runner.world, selection, ledger }));
    const present = presentIds(runner.world);
    const legend = ledger.entries
      .filter((e) => present.has(e.id))
      .map((e) => `<div class="legend-row">${badgeHtml(e)} ${esc(e.name)}</div>`)
      .join('');
    if (legend !== lastLegend) {
      lastLegend = legend;
      legendEl.innerHTML = legend;
    }
    timeline.update(runner, message);
  }

  let last = performance.now();
  let sinceRefresh = 0;
  function frame(now: number): void {
    const wall = Math.min(now - last, 250);
    last = now;
    pollSticks();
    runner.advance(wall);
    view.sync(runner.world, runner.world.state, selection);
    view.render();
    sinceRefresh += wall;
    if (sinceRefresh >= 100) {
      sinceRefresh = 0;
      refresh();
    }
    requestAnimationFrame(frame);
  }

  setViewMode('orbit');
  refresh();
  requestAnimationFrame(frame);
}
