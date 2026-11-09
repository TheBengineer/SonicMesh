import exampleScenario from '../scenarios/example.json';
import { SELF_NOISE_DB } from './acoustics/model';
import { drawSnippet, MicAnalysis } from './audio/analysis';
import { Listener } from './audio/listen';
import { cameraStick, combineSticks, gamepadStick, keyboardStick, quantizeStick, sameStick, zeroStick } from './input/sticks';
import { COMPONENT } from './provenance/components';
import { loadLedger, type Ledger } from './provenance/ledger';
import type { Selection } from './selection';
import { WorldView, type Hit, type Target, type ViewMode } from './scene/worldView';
import { drawTraces, type Trace } from './ui/charts';
import { badgeHtml, download, need, readJson } from './ui/dom';
import {
  Inspector,
  buildPanel,
  micKeysOf,
  objectList,
  objectTitle,
  selectionExists,
  type ActionData,
  type InspectContext,
  type InspectTab,
  type InspectView,
  type MessageFilter,
} from './ui/inspector';
import { renderAbout, renderIntro, renderLedger } from './ui/overlays';
import { HowItWorks } from './ui/howItWorks';
import { COARSE_QUERY, NARROW_QUERY, TOUCH_CLICK_PX, TOUCH_PICK_PX, TouchSticks } from './ui/mobile';
import { Popup } from './ui/popup';
import { LevelHistory, spanAt } from './ui/detectMarks';
import { WaterfallStrip, type StripNode } from './ui/waterfalls';
import { Timeline, type TimelineInfo } from './ui/timeline';
import { parseInputLog, type LogEntry } from './sim/inputs';
import { SHOOTER_EVERY_S } from './sim/shots';
import { parseScenario, type DroneClass, type FlightMode, type NodeKind, type PathSpec, type ScenarioFile } from './sim/scenario';
import type { Frame, InspectRequest, RotorTrace, SpectrumTrace } from './sim/protocol';
import { SimHost } from './sim/simHost';
import { Terrain } from './sim/terrain';
import { createWorld, type DroneState, type World } from './sim/world';

type Mode = 'select' | 'add-node' | 'add-drone' | 'gunshot';

const CLICK_PX = 5;
const DRAG_MIN_M = 0.5;
const DRONE_DROP_ALT_M = 30;
const ROTOR_COLORS = ['#5fb4ff', '#3fbf71', '#d6a23f', '#e0605a'];
const BAND_COLOR = '#5fb4ff';
const SNR_COLOR = '#d6a23f';
// The all-nodes strip redraws this often. Its tiles are small, so 20 Hz is smooth and cheap.
const STRIP_EVERY_MS = 50;

function nextId(ids: number[]): number {
  return Math.max(0, ...ids) + 1;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function presentIds(world: World, scn: ScenarioFile): Set<string> {
  const s = world.state;
  const ids = new Set<string>([
    COMPONENT.terrain,
    COMPONENT.road,
    COMPONENT.trees,
    COMPONENT.gateway,
    COMPONENT.simWorker,
  ]);
  if (s.nodes.some((n) => n.kind === 'detector')) ids.add(COMPONENT.nodeDetector);
  if (s.nodes.some((n) => n.kind === 'array')) ids.add(COMPONENT.nodeArray);
  if (s.nodes.length > 0) {
    ids.add(COMPONENT.mic);
    ids.add(COMPONENT.waterfall);
    ids.add(COMPONENT.listen);
    ids.add(COMPONENT.bandSnr);
    ids.add(COMPONENT.loraCodec);
    ids.add(COMPONENT.loraAirtime);
    ids.add(COMPONENT.loraPathLoss);
    ids.add(COMPONENT.loraMac);
    ids.add(COMPONENT.loraNodeStub);
    ids.add(COMPONENT.ranging);
    ids.add(COMPONENT.healthReport);
    ids.add(COMPONENT.energyModel);
  }
  if (scn.acoustics.ambient_db_spl !== null) ids.add(COMPONENT.ambient);
  if (s.drones.length > 0) {
    ids.add(COMPONENT.droneDynamics);
    ids.add(COMPONENT.droneClasses);
    ids.add(COMPONENT.droneSound);
    ids.add(COMPONENT.sourceLevel);
    ids.add(COMPONENT.droneRotors);
    if (s.nodes.length > 0) {
      ids.add(COMPONENT.propagation);
      ids.add(COMPONENT.airAbsorption);
      ids.add(COMPONENT.terrainBlocking);
    }
  }
  if (s.drones.some((d) => d.path.kind !== 'manual')) ids.add(COMPONENT.dronePaths);
  if (s.truth) ids.add(COMPONENT.truthOverlay);
  return ids;
}

function selectionFor(t: Target): Selection {
  if (t.kind === 'node') return { kind: 'node', id: t.id };
  if (t.kind === 'drone') return { kind: 'drone', id: t.id };
  if (t.kind === 'gateway') return { kind: 'gateway' };
  return null;
}

function pathPreset(kind: string, d: DroneState, terrain: Terrain): PathSpec | null {
  const here = { x: d.x, y: d.y };
  const far = terrain.clamp(d.x >= 0 ? d.x - 1000 : d.x + 1000, d.y);
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

// Before the first frame arrives, the page shows the scenario as it starts.
function blankFrame(scn: ScenarioFile, terrain: Terrain): Frame {
  return {
    tick: 0,
    simTimeS: 0,
    playing: false,
    speed: 1,
    pending: 0,
    logLength: 0,
    msPerTick: 0,
    state: createWorld(scn, terrain).state,
    lora: null,
    rotors: null,
    spectrum: null,
    truth: null,
  };
}

// Noise floor the SNR is measured against: the ambient setting, else the mic self-noise, else none.
function noiseFloor(scn: ScenarioFile): { db: number | null; label: string } {
  const a = scn.acoustics;
  if (a.ambient_db_spl !== null) return { db: a.ambient_db_spl, label: `${a.ambient_db_spl} dB SPL ambient` };
  if (a.self_noise) return { db: SELF_NOISE_DB, label: `${SELF_NOISE_DB} dB SPL mic self-noise` };
  return { db: null, label: 'no ambient or self-noise' };
}

function timelineInfo(f: Frame, seed: number, selectedPacket: number | null): TimelineInfo {
  return {
    simTimeS: f.simTimeS,
    tick: f.tick,
    seed,
    playing: f.playing,
    speed: f.speed,
    truth: f.state.truth,
    pending: f.pending,
    logLength: f.logLength,
    msPerTick: f.msPerTick,
    lora: f.lora,
    selectedPacket,
  };
}

function drawRotors(canvas: HTMLCanvasElement, t: RotorTrace): void {
  const n = t.hz.length / 4;
  const traces = [0, 1, 2, 3].map((i) => ({
    label: `rotor ${i + 1}`,
    color: ROTOR_COLORS[i],
    values: Array.from({ length: n }, (_, k) => t.hz[k * 4 + i]),
  }));
  drawTraces(canvas, traces, { unit: 'Hz', xLabel: 'last 5 s' });
}

function drawSpectrum(canvas: HTMLCanvasElement, s: SpectrumTrace): void {
  drawTraces(canvas, [{ label: 'emitted at 1 m', color: BAND_COLOR, values: s.db }], { unit: 'dB', xLabel: '0 to 4 kHz' });
}

export function startApp(root: HTMLElement): void {
  const ledger: Ledger = loadLedger();
  let scenario: ScenarioFile = parseScenario(exampleScenario);
  let terrain = new Terrain(scenario.seed, scenario.terrain);
  let blank = blankFrame(scenario, terrain);
  const host = new SimHost();
  const listener = new Listener(host);
  const view = new WorldView(need<HTMLElement>(root, '#scene'));
  const inspectorEl = need<HTMLElement>(root, '#inspector');
  const aboutDialog = need<HTMLDialogElement>(document, '#about-dialog');
  const ledgerDialog = need<HTMLDialogElement>(document, '#ledger-dialog');
  renderAbout(aboutDialog, () => openHow(false));
  host.load(scenario);

  const frameNow = (): Frame => host.frame ?? blank;
  const worldNow = (): World => ({ name: scenario.name, terrain, state: frameNow().state });
  view.setWorld(worldNow());

  let selection: Selection = null;
  let mode: Mode = 'select';
  let viewMode: ViewMode = 'orbit';
  let viewPicked = false;
  let drag: { target: Target; lastX: number; lastY: number } | null = null;
  let press: { x: number; y: number; hit: Hit | null } | null = null;
  let message = '';
  let messageTimer = 0;
  let lastPolled = zeroStick();
  let lastTarget: number | null = null;
  let lastInspect = '';
  const keysDown = new Set<string>();
  // Node tabs and filters.
  let nodeTab: InspectTab = 'waterfall';
  let msgFilter: MessageFilter = 'all';
  let micPick: string | null = null;
  let overlay = false;
  let listenKey: string | null = null;
  let gain = 1;
  let analysis: MicAnalysis | null = null;
  // The all-nodes waterfall strip. Closed, it asks the worker for no extra mics and does no analysis.
  let wfOpen = false;
  // Phones show one panel at a time under the map, chosen from the bottom tabs.
  const narrow = window.matchMedia(NARROW_QUERY);
  const coarse = window.matchMedia(COARSE_QUERY);
  let sheet: string | null = null;

  function flash(text: string): void {
    message = text;
    window.clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => (message = ''), 6000);
  }

  // Selecting opens the object's window; clearing the selection closes it.
  function select(s: Selection): void {
    const sameNode = s?.kind === 'node' && selection?.kind === 'node' && s.id === selection.id;
    const changed = JSON.stringify(s) !== JSON.stringify(selection);
    selection = s;
    if (s && narrow.matches) setSheet(null);
    // On a phone a drone opens folded, to fly it with the map clear. Its window is one tap away.
    if (changed) popup.setFolded(narrow.matches && s?.kind === 'drone');
    // Clicking a node plays its mic. Pressing and releasing both select, so only a change of node restarts it.
    if (sameNode) listener.wake();
    else if (s?.kind === 'node') startListening(waterfallMic() ?? `${s.id}.0`);
    else if (listenKey !== null) stopListening();
    if (viewMode === 'follow' && s?.kind === 'drone') view.setView('follow', s.id);
    if (s === null) popup.close();
    else if (!popup.isOpen) popup.show(view.screenPos(s));
  }

  function startListening(key: string): void {
    listenKey = key;
    listener.start(key).catch((err: unknown) => {
      if (listenKey === key) listenKey = null;
      flash(errorText(err));
    });
  }

  function stopListening(): void {
    listener.stop();
    listenKey = null;
  }

  function setViewMode(v: ViewMode, smooth = false): void {
    viewMode = v;
    const followId = selection?.kind === 'drone' ? selection.id : (frameNow().state.drones[0]?.id ?? null);
    view.setView(v, followId, smooth);
    markPressed(root, '[data-view]', 'view', v);
  }

  // Play flies to the drone, unless the user has picked a view themselves.
  function togglePlay(): void {
    const playing = !frameNow().playing;
    if (playing && !viewPicked && viewMode !== 'follow' && frameNow().state.drones.length > 0) setViewMode('follow', true);
    host.play(playing);
  }

  function setMode(m: Mode): void {
    mode = m;
    markPressed(root, '[data-mode]', 'mode', m);
  }

  function reload(scn: ScenarioFile, log: LogEntry[] = []): void {
    scenario = scn;
    terrain = new Terrain(scn.seed, scn.terrain);
    blank = blankFrame(scn, terrain);
    host.load(scn, log);
    analysis = null;
    listener.stop();
    listenKey = null;
    view.setWorld(worldNow());
    viewPicked = false;
    setViewMode('orbit');
    select(null);
  }

  function replay(): void {
    host.play(false);
    host.reset();
    flash('Back at tick 0. Press play to replay the logged inputs.');
  }

  function toggleTruth(): void {
    host.apply({ type: 'truth', on: !frameNow().state.truth });
  }

  function toggleFlight(): void {
    if (selection?.kind !== 'drone') return;
    const id = selection.id;
    const d = frameNow().state.drones.find((o) => o.id === id);
    if (!d) return;
    const flight: FlightMode = d.flight === 'manual' ? 'gps' : 'manual';
    host.apply({ type: 'drone_flight', id: d.id, mode: flight });
  }

  function removeSelected(): void {
    if (selection?.kind === 'node') host.apply({ type: 'node_remove', id: selection.id });
    else if (selection?.kind === 'drone') host.apply({ type: 'drone_remove', id: selection.id });
    else return;
    select(null);
  }

  // Keyboard and gamepad sticks go to the selected drone, turned to the camera's heading. The log holds the turned
  // stick, so a replay flies the same path whatever the camera does. Only changes are logged, so an idle controller
  // does not touch the run.
  function pollSticks(): void {
    const sticks = combineSticks(combineSticks(keyboardStick(keysDown), gamepadStick()), touchSticks.stick);
    const polled = quantizeStick(cameraStick(sticks, view.cameraHeading()));
    const id = selection?.kind === 'drone' ? selection.id : null;
    if (sameStick(polled, lastPolled) && id === lastTarget) return;
    lastPolled = polled;
    lastTarget = id;
    if (id === null) return;
    const d = frameNow().state.drones.find((o) => o.id === id);
    if (!d) return;
    const active = polled.x !== 0 || polled.y !== 0 || polled.z !== 0;
    if (active && d.path.kind !== 'manual') {
      host.apply({
        type: 'drone_path',
        id,
        path: { kind: 'manual', start: { x: d.x, y: d.y, altitude_m: d.alt } },
      });
    }
    host.apply({ type: 'drone_stick', id, ...polled });
  }

  // The mic the node waterfall shows: the picked one if this node has it, else its first.
  function waterfallMic(): string | null {
    if (!selection || selection.kind !== 'node') return null;
    const id = selection.id;
    const n = frameNow().state.nodes.find((o) => o.id === id);
    if (!n) return null;
    const keys = micKeysOf(n);
    return micPick && keys.includes(micPick) ? micPick : keys[0];
  }

  function listenNote(): string {
    if (listenKey === null) return 'Not listening. Clicking a node plays its mic, or press the button above.';
    const f = frameNow();
    if (f.speed !== 1 || !f.playing) {
      return `Muted: audio plays only at 1× while the sim runs (now ${f.speed}×${f.playing ? '' : ', paused'}).`;
    }
    const rate = listener.rate ? `${(listener.rate / 1000).toFixed(1)} kHz` : 'the device rate';
    return `Playing, upsampled from the 16 kHz sim rate to ${rate}.`;
  }

  function inspectView(): InspectView {
    return {
      tab: nodeTab,
      mic: waterfallMic(),
      listening: listenKey,
      gain,
      overlay,
      truth: frameNow().state.truth,
      ambientLabel: noiseFloor(scenario).label,
      listenNote: listenNote(),
      msgFilter,
    };
  }

  // Tells the sim worker what the page is showing, so it sends only the traces it needs.
  function syncInspect(): void {
    const drone = selection?.kind === 'drone' ? selection.id : null;
    const wf = popup.isOpen && nodeTab === 'waterfall' ? waterfallMic() : null;
    const mics: string[] = [];
    if (wf) mics.push(wf);
    // The strip needs the first mic of every node, and only while it is open.
    if (wfOpen) for (const n of frameNow().state.nodes) mics.push(micKeysOf(n)[0]);
    if (listenKey && !mics.includes(listenKey)) mics.push(listenKey);
    const req: InspectRequest = { drone, mics: [...new Set(mics)], truthKey: wf };
    const s = JSON.stringify(req);
    if (s !== lastInspect) {
      lastInspect = s;
      host.inspect(req);
    }
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
        host.apply({ type: 'node_kind', id, kind: value as NodeKind });
        break;
      case 'node-remove':
        host.apply({ type: 'node_remove', id });
        select(null);
        break;
      case 'drone-class':
        host.apply({ type: 'drone_class', id, cls: value as DroneClass });
        break;
      case 'drone-flight':
        host.apply({ type: 'drone_flight', id, mode: value as FlightMode });
        break;
      case 'drone-path': {
        const d = frameNow().state.drones.find((o) => o.id === id);
        const path = d ? pathPreset(value, d, terrain) : null;
        if (path) host.apply({ type: 'drone_path', id, path });
        break;
      }
      case 'drone-remove':
        host.apply({ type: 'drone_remove', id });
        select(null);
        break;
      case 'inspector-tab':
        if (['details', 'waterfall', 'messages', 'health', 'ranging'].includes(value)) nodeTab = value as InspectTab;
        break;
      case 'msg-filter':
        msgFilter = value === 'sent' || value === 'received' ? value : 'all';
        break;
      case 'mic-select':
        micPick = value;
        if (listenKey !== null) startListening(value);
        break;
      case 'overlay':
        overlay = !overlay;
        break;
      case 'listen': {
        if (listenKey === value) stopListening();
        else startListening(value);
        break;
      }
      case 'listen-gain':
        gain = Number(value);
        listener.setGain(gain);
        break;
    }
    refresh();
  }

  const objects = new Inspector(inspectorEl, onAction);
  const popup = new Popup({
    container: need<HTMLElement>(root, '#viewport'),
    onClose: () => {
      select(null);
      refresh();
    },
  });
  const popupInspector = new Inspector(popup.body, onAction);
  const touchSticks = new TouchSticks(need<HTMLElement>(root, '#viewport'));
  const waterfallsEl = need<HTMLElement>(root, '#waterfalls');
  const strip = new WaterfallStrip(waterfallsEl, badgeHtml(ledger.byId.get(COMPONENT.waterfall)), (id) => {
    select({ kind: 'node', id });
    refresh();
  });
  const waterfallToggle = need<HTMLButtonElement>(waterfallsEl, '.wf-toggle');
  const timeline = new Timeline(need<HTMLElement>(root, '#timeline'), {
    togglePlay,
    step: () => host.step(),
    reset: () => {
      reload(scenario);
      flash('Log cleared. Back at the scenario file.');
    },
    replay,
    setSpeed: (s) => host.speed(s),
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
        reload(scenario, log);
        flash(`Loaded ${log.length} inputs. Press play to replay them.`);
      } catch (err) {
        flash(errorText(err));
      }
    },
    saveRun: () => {
      void host.exportRun().then(({ scenario: scn, log }) => {
        download('sonicmesh-scenario.json', scn);
        download('sonicmesh-inputs.json', { format: 'sonicmesh-input-log', version: 1, entries: log });
      });
    },
    selectPacket: (id) => select({ kind: 'packet', id }),
  });

  // Scene pointer handling. Clicks select; a press on a node or the gateway drags it on the ground.
  const sceneEl = need<HTMLElement>(root, '#scene');
  sceneEl.addEventListener(
    'pointerdown',
    (e) => {
      // A second finger is a pinch for the camera, so it cancels any tap or drag the first one began.
      if (!e.isPrimary) {
        press = null;
        drag = null;
        return;
      }
      if (e.button !== 0) return;
      const touch = e.pointerType === 'touch';
      const hit = view.pick(e.clientX, e.clientY, touch ? TOUCH_PICK_PX : 0);
      press = { x: e.clientX, y: e.clientY, hit };
      const t = hit?.target;
      // By touch, only an object that is already selected drags. Otherwise a swipe to orbit that starts near a node
      // would move the node.
      const held = !touch || (t && JSON.stringify(selectionFor(t)) === JSON.stringify(selection));
      if (mode === 'select' && held && t && (t.kind === 'node' || t.kind === 'gateway')) {
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
    if (t.kind === 'gateway') host.apply({ type: 'gateway_move', x, y });
    else if (t.kind === 'node') host.apply({ type: 'node_move', id: t.id, x, y });
  });

  window.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    drag = null;
    if (!p || e.button !== 0) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > (e.pointerType === 'touch' ? TOUCH_CLICK_PX : CLICK_PX)) return;
    const hit = p.hit;
    if (mode === 'select') {
      select(hit ? selectionFor(hit.target) : null);
      return;
    }
    if (!hit || hit.target.kind !== 'terrain') return;
    const state = frameNow().state;
    if (mode === 'gunshot') {
      // Stays in gunshot mode, so several shooters can be placed in a row.
      const id = nextId(state.shooters.map((sh) => sh.id));
      host.apply({ type: 'shooter_add', shooter: { id, kind: 'shooter', x: hit.x, y: hit.y, every_s: SHOOTER_EVERY_S } });
      return;
    }
    if (mode === 'add-node') {
      const id = nextId(state.nodes.map((n) => n.id));
      const kind = need<HTMLSelectElement>(root, '#place-kind').value as NodeKind;
      host.apply({ type: 'node_add', node: { id, kind, x: hit.x, y: hit.y } });
      select({ kind: 'node', id });
    } else {
      const id = nextId(state.drones.map((d) => d.id));
      const cls = need<HTMLSelectElement>(root, '#place-class').value as DroneClass;
      const alt = terrain.height(hit.x, hit.y) + DRONE_DROP_ALT_M;
      host.apply({
        type: 'drone_add',
        drone: { id, class: cls, flight: 'gps', path: { kind: 'hover', at: { x: hit.x, y: hit.y }, altitude_m: alt } },
      });
      select({ kind: 'drone', id });
    }
    setMode('select');
  });

  window.addEventListener('pointercancel', () => {
    press = null;
    drag = null;
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
        togglePlay();
        break;
      case 'Period':
        host.step();
        break;
      case 'KeyR':
        replay();
        break;
      case 'KeyF':
        viewPicked = true;
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
      case 'Escape':
        if (selection) {
          select(null);
          refresh();
        }
        break;
    }
  });
  window.addEventListener('keyup', (e) => keysDown.delete(e.code));
  window.addEventListener('blur', () => keysDown.clear());

  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      viewPicked = true;
      setViewMode(b.dataset.view as ViewMode);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      setMode(b.dataset.mode as Mode);
      if (!narrow.matches || b.dataset.mode === 'select') return;
      setToolbarOpen(false);
      flash('Tap the ground to place it.');
    }),
  );
  const toolbarEl = need<HTMLElement>(root, '#toolbar');
  const toolbarMore = need<HTMLButtonElement>(root, '#toolbar-more');
  function setToolbarOpen(on: boolean): void {
    toolbarEl.classList.toggle('open', on);
    toolbarMore.setAttribute('aria-expanded', String(on));
  }
  toolbarMore.addEventListener('click', () => setToolbarOpen(!toolbarEl.classList.contains('open')));
  root.querySelectorAll<HTMLButtonElement>('[data-sheet-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      const tab = b.dataset.sheetTab ?? null;
      setSheet(tab === sheet ? null : tab);
    }),
  );
  // The walkthrough pauses the run behind it, and picks it back up on closing. From the splash, closing starts the run.
  let playAfterHow = false;
  const how = new HowItWorks(need<HTMLDialogElement>(document, '#how-dialog'), {
    onClose: () => {
      if (playAfterHow && !frameNow().playing) togglePlay();
    },
    onTry: (what) => {
      playAfterHow = true;
      if (what === 'real') {
        need<HTMLButtonElement>(root, '#open-whats-real').click();
        return;
      }
      const state = frameNow().state;
      if (what === 'fly' && state.drones[0]) {
        viewPicked = true;
        select({ kind: 'drone', id: state.drones[0].id });
        setViewMode('follow');
        flash(coarse.matches ? 'Use the thumb sticks to fly it.' : 'Fly it with WASD or the arrow keys. Q and E go down and up.');
      } else if (what === 'listen' && state.nodes[0]) {
        select({ kind: 'node', id: state.nodes[0].id });
      }
      refresh();
    },
  });
  function openHow(fromSplash: boolean): void {
    playAfterHow = fromSplash || frameNow().playing;
    if (frameNow().playing) host.play(false);
    howButton.classList.remove('attention');
    how.open();
  }
  const howButton = need<HTMLButtonElement>(root, '#open-how');
  howButton.addEventListener('click', () => openHow(false));
  need<HTMLButtonElement>(root, '#open-about').addEventListener('click', () => aboutDialog.showModal());
  need<HTMLButtonElement>(root, '#open-whats-real').addEventListener('click', () => {
    renderLedger(ledgerDialog, ledger, presentIds(worldNow(), scenario));
    ledgerDialog.showModal();
  });

  // Node waterfall: the spectrogram and band level are read from the mic's audio ring, and the drone plots from the
  // latest frame. Canvases are looked up each time because the inspector rebuilds its DOM when its key changes.
  function drawPlots(f: Frame): void {
    if (!popup.isOpen) return;
    const body = popup.body;
    const mic = nodeTab === 'waterfall' ? waterfallMic() : null;
    const ring = mic ? host.ring(mic) : undefined;
    const wf = body.querySelector<HTMLCanvasElement>('canvas[data-plot="waterfall"]');
    if (mic && ring && wf) {
      if (!analysis || analysis.key !== mic) analysis = new MicAnalysis(mic);
      const lines = f.truth && f.truth.key === mic && f.state.truth ? f.truth.lines.map((l) => l.hz) : null;
      const nodeView = f.lora?.nodes.find((n) => selection?.kind === 'node' && n.id === selection.id);
      analysis.update(ring, lines);
      analysis.drawWaterfall(wf, overlay && lines !== null);
      analysis.drawMarks(wf, nodeView?.detectSpans ?? [], nodeView ? (levels.get(nodeView.id)?.samples ?? []) : [], f.simTimeS);
      const strip = body.querySelector<HTMLCanvasElement>('canvas[data-plot="strip"]');
      if (strip && nodeView) analysis.drawLevel(strip, levels.get(nodeView.id)?.samples ?? [], f.simTimeS);
      const level = body.querySelector<HTMLCanvasElement>('canvas[data-plot="level"]');
      if (level) {
        const band = analysis.bandDb();
        const floor = noiseFloor(scenario).db;
        const traces: Trace[] = [{ label: 'band', color: BAND_COLOR, values: band }];
        if (floor !== null) traces.push({ label: 'SNR', color: SNR_COLOR, values: band.map((b) => b - floor), dashed: true });
        drawTraces(level, traces, { unit: 'dB', xLabel: 'last 10 s' });
      }
    }
    const clip = body.querySelector<HTMLCanvasElement>('canvas[data-plot="snippet"]');
    if (clip && !clip.dataset.drawn && selection?.kind === 'packet') {
      const id = selection.id;
      const packet = f.lora?.packets.find((p) => p.id === id);
      if (packet?.message.type === 'SNIPPET') {
        const spans = f.lora?.nodes.find((n) => n.id === packet.tx)?.detectSpans ?? [];
        drawSnippet(clip, packet.message.data, spanAt(spans, packet.startS)?.lineHz ?? null);
        clip.dataset.drawn = '1';
      }
    }
    const rotors = body.querySelector<HTMLCanvasElement>('canvas[data-plot="rotors"]');
    if (f.rotors && rotors && selection?.kind === 'drone' && f.rotors.id === selection.id) drawRotors(rotors, f.rotors);
    const spectrum = body.querySelector<HTMLCanvasElement>('canvas[data-plot="spectrum"]');
    if (f.spectrum && spectrum && selection?.kind === 'drone' && f.spectrum.id === selection.id) {
      drawSpectrum(spectrum, f.spectrum);
    }
  }

  // Shows or hides the strip. Opening it asks the worker for the node mics; closing it drops the analysis.
  function setWaterfalls(on: boolean): void {
    wfOpen = on;
    waterfallsEl.classList.toggle('collapsed', !on);
    waterfallToggle.setAttribute('aria-expanded', String(on));
    if (!on) strip.clear();
    refresh();
  }

  // Opens one phone panel, or none. The waterfalls follow theirs, so a phone runs no strip analysis it is not showing.
  function setSheet(s: string | null): void {
    if (s === sheet) return;
    sheet = s;
    if (s) root.dataset.sheet = s;
    else delete root.dataset.sheet;
    markPressed(root, '[data-sheet-tab]', 'sheetTab', s ?? '');
    setWaterfalls(s === 'waterfalls');
  }

  function drawStrip(f: Frame): void {
    const nodes: StripNode[] = f.state.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      mic: micKeysOf(n)[0],
      detecting: f.lora?.nodes.find((v) => v.id === n.id)?.detecting ?? false,
      spans: f.lora?.nodes.find((v) => v.id === n.id)?.detectSpans ?? [],
      peak: f.lora?.nodes.find((v) => v.id === n.id)?.peak ?? 0,
      samples: levels.get(n.id)?.samples ?? [],
      state: f.lora?.nodes.find((v) => v.id === n.id)?.detectState ?? 'quiet',
      listening: listenKey !== null && micKeysOf(n).includes(listenKey),
    }));
    strip.update(nodes, selection?.kind === 'node' ? selection.id : null, f.simTimeS, (key) => host.ring(key));
  }

  function refresh(): void {
    const f = frameNow();
    const world = worldNow();
    if (selection && !selectionExists(world, selection)) select(null);
    const ctx: InspectContext = { world, selection, view: inspectView(), lora: f.lora };
    objects.update(objectList(ctx));
    if (selection) {
      popupInspector.update(buildPanel(ctx));
      popup.setTitle(objectTitle(world, selection));
    }
    root.classList.toggle('audio-muted', !f.playing || f.speed !== 1);
    timeline.update(timelineInfo(f, terrain.seed, selection?.kind === 'packet' ? selection.id : null), message);
    syncInspect();
    const flyable = selection?.kind === 'drone';
    touchSticks.setVisible(flyable && (narrow.matches ? sheet === null && popup.folded : coarse.matches));
  }

  // Each node's level, kept here so the strip has its history as soon as a node is opened.
  const levels = new Map<number, LevelHistory>();
  function recordLevels(f: Frame): void {
    for (const n of f.lora?.nodes ?? []) {
      let history = levels.get(n.id);
      if (!history) {
        history = new LevelHistory();
        levels.set(n.id, history);
      }
      history.push({ t: f.simTimeS, peak: n.peak, state: n.detectState, trackHz: n.trackHz });
    }
  }

  let last = performance.now();
  let sinceRefresh = 0;
  let sinceStrip = 0;
  function frame(now: number): void {
    const wall = Math.min(now - last, 250);
    last = now;
    pollSticks();
    const f = frameNow();
    recordLevels(f);
    view.sync(worldNow(), f.state, selection, f.lora, f.simTimeS);
    view.render();
    if (popup.isOpen) popup.update(selection ? view.screenPos(selection) : null);
    drawPlots(f);
    listener.sync(f);
    sinceRefresh += wall;
    if (sinceRefresh >= 100) {
      sinceRefresh = 0;
      refresh();
    }
    sinceStrip += wall;
    if (wfOpen && sinceStrip >= STRIP_EVERY_MS) {
      sinceStrip = 0;
      drawStrip(f);
    }
    requestAnimationFrame(frame);
  }

  waterfallToggle.addEventListener('click', () => setWaterfalls(!wfOpen));
  const paneToggle = need<HTMLButtonElement>(root, '#pane-toggle');
  paneToggle.addEventListener('click', () => {
    const closed = root.classList.toggle('pane-closed');
    paneToggle.setAttribute('aria-expanded', String(!closed));
    const label = closed ? 'Expand the object list' : 'Collapse the object list';
    paneToggle.textContent = closed ? '◂' : '▸';
    paneToggle.title = label;
    paneToggle.setAttribute('aria-label', label);
  });
  narrow.addEventListener('change', () => {
    if (narrow.matches) {
      setSheet(null);
      setWaterfalls(false);
      return;
    }
    setSheet(null);
    setToolbarOpen(false);
    popup.setFolded(false);
    setWaterfalls(true);
  });
  setViewMode('orbit');
  setWaterfalls(!narrow.matches);
  requestAnimationFrame(frame);

  const intro = need<HTMLDialogElement>(document.body, '#intro-dialog');
  renderIntro(intro, () => {
    if (!frameNow().playing) togglePlay();
    if (narrow.matches) flash('Tap a node to hear it, or a drone to fly it.');
  }, () => openHow(true));
  // A link ending in #how-it-works goes straight to the walkthrough.
  if (window.location.hash === '#how-it-works') openHow(true);
  else intro.showModal();
}
