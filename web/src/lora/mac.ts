// Gateway scheduler and node MAC for the v0 star. One LoRaNetwork owns the TDMA schedule, the frames,
// the channel model and the per-node stub behaviour. It runs inside the sim worker on the fixed 10 ms
// tick; everything here is a pure function of ticks and logged ops, so replay stays exact.
import { encodeFrame, frameHex, type Message } from '../protocol';
import { TICK_S } from '../sim/clock';
import { fnv1a } from '../sim/hash';
import { createRng, nextFloat, type Rng } from '../sim/rng';
import type { DroneClass, NodeSpec, Vec2 } from '../sim/scenario';
import type { World } from '../sim/world';
import {
  airtime,
  channelName,
  DutyMeter,
  EVENT_CHANNEL,
  FADE_SIGMA_DB,
  GATEWAY_ANT_M,
  IDLE_CHANNEL,
  linkBudget,
  NODE_ANT_M,
  rangingChannel,
  receiveWave,
  type ChannelSpec,
  type Fate,
  type TerrainLike,
  type Vec3,
  type Wave,
} from './channel';
import { BogieTracker, type Bogie } from './bogies';
import { ARRAY_OFFSETS } from '../acoustics/engine';
import { ARRAY_HALF_M } from '../acoustics/model';
import { NodeStub, RANGING_MAX_LINK_M, pitchFits, measureRange, type Detection, type HealthValue, type RingView, type NodeObservation, type TruthTarget } from './nodeStub';
import type { GatewayView, GridSlot, HealthView, LoraView, MessageView, NodeView, PacketView, RangingView, RxView, ShotFix } from './types';
import { locateShots, type ShotReport } from './shotLocate';

export const IDLE_SUPERFRAME_S = 4;
export const EVENT_SUPERFRAME_S = 0.5;
export const IDLE_SF = 9;
export const IDLE_BW = 125_000;
export const EVENT_SF = 7;
export const EVENT_BW = 500_000;
export const RANGING_SF = 8;
export const RANGING_BW = 500_000;

export const ALERT_START_S = 0.25;
export const ALERT_SLOT_S = 0.16;
export const ALERT_SLOTS = 4;
// Shots a node keeps waiting to send. Older ones are dropped first.
const MAX_SHOT_QUEUE = 8;
export const SCHED_START_S = 0.9;
export const SCHED_SLOT_S = 0.22;
export const SCHED_SLOTS = 14;
export const EVENT_NODE_START_S = 0.03;
export const EVENT_NODE_SLOT_S = 0.016;
export const EVENT_NODE_SLOTS = 16;
export const EVENT_BURST_START_S = 0.3;

export const HEALTH_PERIOD = 75;
export const EVENT_HOLD_S = 10;
export const RANGING_EVERY = 4;
// The beacon must fit its window: 7 idle slot assignments stay under 250 ms at SF9/125k.
export const MAX_IDLE_SLOT_MAP = 7;
export const MAX_EVENT_SLOT_MAP = 8;
export const MAX_SNIPPET_REQUESTS = 2;
const MAX_PACKETS = 500;
const MAX_MESSAGES = 60;
const MAX_RANGING = 40;

// Slot map actions. The v0 spec leaves the encoding open; these are the simplest readings.
export const ACTION_HEALTH = 1;
export const ACTION_DETECT = 2;
export const ACTION_RANGING = 3;
export const ACTION_ACK = 4;

export interface NetworkOptions {
  seed: number;
  gateway: Vec2;
  nodes: NodeSpec[];
  terrain: TerrainLike;
  ambientDb?: number;
}

// What the network reads from the acoustic engine.
interface EngineView {
  micRing(key: string): RingView | undefined;
  hasDrone(id: number): boolean;
  truthBpf(id: number, key: string, t: number): number[];
  bandLevel(key: string): number;
  audioSnippet(key: string, max: number): Float32Array | null;
  ambientDb(): number;
}

const PITCH_LOOKBACK_S = 0.2;
const BOGIE_PERIOD_TICKS = 25;
// Shots older than this drop off the map, and their fixes with them.
const SHOT_FIX_WINDOW_S = 8;
const MIC_OFFSETS = ARRAY_OFFSETS.map(([a, b]) => [a * ARRAY_HALF_M, b * ARRAY_HALF_M] as const);

interface PendingAlert {
  detection: Detection;
}

interface NetNode {
  spec: NodeSpec;
  stub: NodeStub;
  lastObs: NodeObservation;
  lastAudio: Float32Array | null;
  beaconHeard: boolean;
  lastBeaconS: number;
  beaconRssi: number;
  beaconSnr: number;
  pendingAlert: PendingAlert | null;
  // Onsets heard but not yet sent as SHOT, oldest first, and the newest onset already queued.
  shotQueue: number[];
  lastShotS: number;
  snippetRequested: boolean;
  health: HealthView | null;
  lastHealthS: number | null;
  healthIdleAt: number;
  messages: MessageView[];
  ranging: RangingView[];
  txSeconds: number;
  heard: number;
}

interface TxPlan {
  packet: PacketView;
  wave: Wave;
  message: Message;
  fates: Map<number, RxView>;
  health: HealthView | null;
  ranging: RangingView | null;
}

interface RangingPair {
  a: number;
  b: number;
  slot: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function gaussUnit(seed: number, a: number, b: number, salt: number): number {
  let h = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b) ^ Math.imul(salt + 1, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const u1 = Math.max((h >>> 8) / 16777216, 1e-9);
  h = Math.imul(h ^ 0x27d4eb2d, 0x165667b1) >>> 0;
  const u2 = (h >>> 8) / 16777216;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Per-packet fading, fixed by the packet id and the two ends of the link.
export function packetFadeDb(seed: number, packet: number, a: number, b: number): number {
  return gaussUnit(seed, Math.min(a, b), Math.max(a, b), packet) * FADE_SIGMA_DB;
}

// One round of 1-of-4 slotted ALOHA. Returns the superframe (1-based) each node was delivered in,
// or 0 if it never got through. Pure, so the test can run it over many seeds.
export function alertContention(seed: number, nodes = 5, superframes = 3, slots = ALERT_SLOTS): number[] {
  const rng = createRng(seed >>> 0);
  const delivered = new Array<number>(nodes).fill(0);
  let pending = Array.from({ length: nodes }, (_, i) => i);
  for (let sf = 1; sf <= superframes && pending.length > 0; sf++) {
    const choice = new Map<number, number[]>();
    for (const i of pending) {
      const s = Math.floor(nextFloat(rng) * slots);
      const list = choice.get(s);
      if (list) list.push(i);
      else choice.set(s, [i]);
    }
    const next: number[] = [];
    for (const group of choice.values()) {
      if (group.length === 1) delivered[group[0]] = sf;
      else next.push(...group);
    }
    pending = next;
  }
  return delivered;
}

function healthView(fields: number[], values: HealthValue[], atS: number): HealthView {
  return { atS, fields: fields.slice(), values: values.map((v) => ({ ...v })) };
}

function messageType(msg: Message): string {
  return msg.type;
}

// A tiny deterministic source for the slot map cache: peers above 31 need the local pair table.
function argOf(peer: number): number {
  return peer & 0x1f;
}

export class LoRaNetwork {
  private readonly seed: number;
  private terrain: TerrainLike;
  private gatewayPos: Vec2;
  private readonly ambientDb: number;
  private nodes: NetNode[] = [];
  private readonly bogieTracker: BogieTracker;
  private bogies: Bogie[] = [];
  private shotFixes: ShotFix[] = [];
  // Fits already made, by shot, so a settled shot is not refitted every update.
  private readonly shotFitCache = new Map<string, ShotFix>();
  private truth: TruthTarget[] = [];
  private mode: 'idle' | 'event' = 'idle';
  private superframe = 0;
  private nextSfStart = 0;
  private eventLastS = -Infinity;
  private nowS = 0;
  private fullCounter = 0;
  private packetId = 1;
  private rangingCursor = 0;
  private rangingSweep = 0;
  private lastRanging = new Map<number, RangingView>();
  private duty = new DutyMeter();
  private beaconSeconds = 0;
  private packets: PacketView[] = [];
  private gatewayMessages: MessageView[] = [];
  private grid: GridSlot[] = [];
  private sfStartS = 0;
  private sfDurationS = IDLE_SUPERFRAME_S;
  private modeChanges: { atS: number; mode: 'idle' | 'event' }[] = [];
  private readonly rng: Rng;

  constructor(opts: NetworkOptions) {
    this.seed = opts.seed >>> 0;
    this.terrain = opts.terrain;
    this.bogieTracker = new BogieTracker(opts.terrain.size);
    this.gatewayPos = { ...opts.gateway };
    this.ambientDb = opts.ambientDb ?? 40;
    this.rng = createRng((this.seed ^ 0x5f356495) >>> 0);
    this.reset(opts.nodes);
  }

  reset(nodes: NodeSpec[]): void {
    this.nodes = [];
    for (const spec of nodes) this.addNode(spec);
    this.mode = 'idle';
    this.superframe = 0;
    this.nextSfStart = 0;
    this.eventLastS = -Infinity;
    this.nowS = 0;
    this.fullCounter = 0;
    this.packetId = 1;
    this.rangingCursor = 0;
    this.rangingSweep = 0;
    this.lastRanging.clear();
    this.duty = new DutyMeter();
    this.beaconSeconds = 0;
    this.packets = [];
    this.gatewayMessages = [];
    this.grid = [];
    this.sfStartS = 0;
    this.sfDurationS = IDLE_SUPERFRAME_S;
    this.modeChanges = [];
  }

  get timeS(): number {
    return this.nowS;
  }

  get superframeCount(): number {
    return this.superframe;
  }

  get currentMode(): 'idle' | 'event' {
    return this.mode;
  }

  private addNode(spec: NodeSpec): void {
    const node: NetNode = {
      spec: { ...spec },
      stub: new NodeStub(spec.id, spec.kind, this.seed),
      lastObs: { bandDb: this.ambientDb, ambientDb: this.ambientDb },
      lastAudio: null,
      beaconHeard: false,
      lastBeaconS: -Infinity,
      beaconRssi: -160,
      beaconSnr: -30,
      pendingAlert: null,
      shotQueue: [],
      lastShotS: -Infinity,
      snippetRequested: false,
      health: null,
      lastHealthS: null,
      healthIdleAt: 0,
      messages: [],
      ranging: [],
      txSeconds: 0,
      heard: 0,
    };
    this.nodes.push(node);
  }

  // Matches the world: positions, kinds, added and removed nodes, gateway and truth targets.
  sync(world: World): void {
    this.setNodes(world.state.nodes, world.state.gateway, world.terrain);
    this.setTruth(world.state.drones);
  }

  setNodes(nodes: NodeSpec[], gateway: Vec2, terrain: TerrainLike): void {
    this.terrain = terrain;
    this.gatewayPos = { ...gateway };
    const keep = new Map<number, NetNode>();
    for (const n of this.nodes) keep.set(n.spec.id, n);
    const next: NetNode[] = [];
    for (const spec of nodes) {
      const old = keep.get(spec.id);
      if (old) {
        old.spec = { ...spec };
        next.push(old);
      } else {
        const node: NetNode = {
          spec: { ...spec },
          stub: new NodeStub(spec.id, spec.kind, this.seed),
          lastObs: { bandDb: this.ambientDb, ambientDb: this.ambientDb },
          lastAudio: null,
          beaconHeard: false,
          lastBeaconS: -Infinity,
          beaconRssi: -160,
          beaconSnr: -30,
          pendingAlert: null,
          shotQueue: [],
          lastShotS: -Infinity,
          snippetRequested: false,
          health: null,
          lastHealthS: null,
          healthIdleAt: 0,
          messages: [],
          ranging: [],
          txSeconds: 0,
          heard: 0,
        };
        next.push(node);
      }
    }
    this.nodes = next;
  }

  setTruth(drones: { id: number; class: DroneClass; x: number; y: number; alt: number }[]): void {
    this.truth = drones.map((d) => ({ id: d.id, class: d.class, x: d.x, y: d.y, alt: d.alt }));
  }

  // Band level and (optionally) audio for one node, from the acoustic engine.
  observe(id: number, obs: NodeObservation): void {
    const node = this.node(id);
    if (!node) return;
    node.lastObs = obs;
    if (obs.audio) node.lastAudio = obs.audio;
  }

  observeFromEngine(world: World, engine: EngineView): void {
    // Band levels are 100 ms windows, so refresh them (and the snippet audio) once per 10 ticks, not every tick.
    const refresh = Math.round(this.nowS * 100) % 10 === 0;
    for (const n of world.state.nodes) {
      const key = `${n.id}.0`;
      const node = this.node(n.id);
      const ring = engine.micRing(key);
      if (!node || !ring) continue;
      node.stub.hearShots(ring);
      const comb = node.stub.hear(ring);
      if (node.spec.kind === 'array') {
        const rings = ARRAY_OFFSETS.map((_, j) => engine.micRing(`${n.id}.${j}`)).filter((r) => r !== undefined);
        node.stub.listenForShotBearing(rings, MIC_OFFSETS);
        node.stub.listenForBearing(this.nowS, rings, MIC_OFFSETS);
      }
      const heardId = comb.on && comb.f0Hz > 0 ? this.droneAtPitch(comb.f0Hz, node, key, engine) : null;
      const audio = refresh ? engine.audioSnippet(key, 7680) : null;
      this.observe(n.id, {
        bandDb: refresh ? engine.bandLevel(key) : node.lastObs.bandDb,
        ambientDb: engine.ambientDb(),
        comb,
        heardId,
        audio: audio ?? undefined,
      });
    }
  }

  // The nearest drone the detector's pitch fits, from the true rotor speeds at this mic. Nothing here feeds the bogies or
  // the bearings: it only draws the lines in the Truth view and fills the stand-in class, and a detection that fits none
  // names none.
  // The rotors are read a little back in time so the delay solve stays inside the logged poses.
  private droneAtPitch(f0Hz: number, node: NetNode, key: string, engine: EngineView): number | null {
    const at = this.nowS - PITCH_LOOKBACK_S;
    if (at <= 0) return null;
    let best: number | null = null;
    let bestD = Infinity;
    for (const t of this.truth) {
      if (!engine.hasDrone(t.id)) continue;
      const rotors = engine.truthBpf(t.id, key, at);
      if (!pitchFits(f0Hz, rotors.reduce((a, b) => a + b, 0) / rotors.length)) continue;
      const d = Math.hypot(t.x - node.spec.x, t.y - node.spec.y);
      if (d < bestD) {
        best = t.id;
        bestD = d;
      }
    }
    return best;
  }

  // Advances to the absolute sim time tS. Superframes run at their exact internal times.
  tick(tS: number): void {
    this.nowS = tS;
    this.duty.nowS = tS;
    for (const node of this.nodes) {
      node.stub.update(tS, node.lastObs);
      for (const h of node.stub.shots) {
        if (h.tS <= node.lastShotS) continue;
        node.lastShotS = h.tS;
        node.shotQueue.push(Math.round(h.tS * 1000));
        if (node.shotQueue.length > MAX_SHOT_QUEUE) node.shotQueue.shift();
      }
      // In event mode detections go out as DETECT in the event slots; only idle needs a contention alert.
      if (this.mode === 'idle' && node.stub.lastDetectionS === tS && node.pendingAlert === null) {
        node.pendingAlert = { detection: this.detectionFor(node) };
      }
    }
    if (Math.round(tS * 100) % BOGIE_PERIOD_TICKS === 0) this.updateBogies(tS);
    // A long jump may cross several superframes; process them in order.
    while (this.nextSfStart <= tS + 1e-9) this.runSuperframe(this.nextSfStart);
  }

  private node(id: number): NetNode | undefined {
    return this.nodes.find((n) => n.spec.id === id);
  }

  private updateBogies(tS: number): void {
    const reports = this.nodes
      .filter((n) => n.stub.detecting && n.stub.pitchHz > 0)
      .map((n) => ({ id: n.spec.id, x: n.spec.x, y: n.spec.y, pitchHz: n.stub.pitchHz, bearingDeg: n.stub.bearingDeg, peak: n.stub.peak }));
    this.bogies = this.bogieTracker.update(tS, reports);
    this.updateShotFixes(tS);
  }

  // Places every recent shot that enough nodes heard, from their onset times and array bearings.
  private updateShotFixes(tS: number): void {
    const reports: ShotReport[] = [];
    for (const n of this.nodes) {
      for (const h of n.stub.shots) {
        if (h.tS >= tS - SHOT_FIX_WINDOW_S) reports.push({ ...h, id: n.spec.id, x: n.spec.x, y: n.spec.y });
      }
    }
    const { fixes, keys } = locateShots(reports, this.terrain.size, this.shotFitCache);
    for (const k of [...this.shotFitCache.keys()]) if (!keys.has(k)) this.shotFitCache.delete(k);
    this.shotFixes = fixes;
  }

  private targetOf(node: NetNode): TruthTarget | null {
    return this.truth.find((t) => t.id === node.stub.targetId) ?? null;
  }

  private detectionFor(node: NetNode): Detection {
    return node.stub.detection(this.targetOf(node));
  }

  private position(id: number): Vec3 {
    if (id === 0) return { x: this.gatewayPos.x, y: this.gatewayPos.y, z: this.terrain.height(this.gatewayPos.x, this.gatewayPos.y) + GATEWAY_ANT_M };
    const n = this.node(id);
    const spec = n ? n.spec : { x: 0, y: 0 };
    return { x: spec.x, y: spec.y, z: this.terrain.height(spec.x, spec.y) + NODE_ANT_M };
  }

  private receivers(tx: number): number[] {
    if (tx === 0) return this.nodes.map((n) => n.spec.id);
    return [0, ...this.nodes.map((n) => n.spec.id).filter((id) => id !== tx)];
  }

  private runSuperframe(startS: number): void {
    const sfMode = this.mode;
    const duration = sfMode === 'idle' ? IDLE_SUPERFRAME_S : EVENT_SUPERFRAME_S;
    const sf = this.superframe;
    const phy = sfMode === 'idle' ? { sf: IDLE_SF, bw: IDLE_BW } : { sf: EVENT_SF, bw: EVENT_BW };
    const channel = sfMode === 'idle' ? IDLE_CHANNEL : EVENT_CHANNEL;
    this.sfStartS = startS;
    this.sfDurationS = duration;

    const plan = this.planSlots(sfMode, sf);
    const slotMap: { node: number; action: number; arg: number }[] = [];
    let slot = 0;
    if (sfMode === 'idle') {
      for (const n of plan.health) slotMap.push({ node: n, action: ACTION_HEALTH, arg: slot++ });
      for (const p of plan.ranging) slotMap.push({ node: p.a, action: ACTION_RANGING, arg: argOf(p.b) });
    } else {
      for (let i = 0; i < plan.detecting.length && i < MAX_EVENT_SLOT_MAP; i++) {
        slotMap.push({ node: plan.detecting[i], action: ACTION_DETECT, arg: i });
      }
    }

    const beaconMessage: Message = {
      type: 'BEACON',
      counter: this.fullCounter,
      gnssMs: Math.round(startS * 1000) >>> 0,
      mode: sfMode === 'idle' ? 0 : 1,
      nextPhy: sfMode === 'idle' ? { sf: EVENT_SF, bw: EVENT_BW } : { sf: IDLE_SF, bw: IDLE_BW },
      slotMap,
      track: sfMode === 'event' ? this.trackState() : null,
      snippets: sfMode === 'event' ? plan.snippets : [],
      commands: [],
    };

    const beaconFrame = encodeFrame(beaconMessage, 0, { fullCounter: this.fullCounter });
    const beaconStart = startS;
    const beaconEnd = startS + airtime(phy.sf, phy.bw, beaconFrame.length);
    const waves: Wave[] = [];
    const txs: TxPlan[] = [];

    const beacon = this.makeTx(0, beaconMessage, beaconFrame, beaconStart, beaconEnd, phy.sf, phy.bw, channel, 'beacon', waves);
    txs.push(beacon);
    this.beaconSeconds += beaconEnd - beaconStart;
    this.duty.addTx(0, channelName(channel), beaconEnd - beaconStart);
    this.duty.addBusy(channelName(channel), beaconEnd - beaconStart);
    this.logGatewayMessage(beaconMessage, 0, beaconStart, 'sent', beacon.packet.id, beacon.packet.frameHex);

    // Who heard the beacon decides who transmits this superframe.
    const heard = new Set<number>();
    for (const node of this.nodes) {
      const fate = receiveWave(beacon.wave, node.spec.id, waves, this.busyFor(node.spec.id, txs));
      node.beaconHeard = fate.fate === 'decoded';
      if (node.beaconHeard) {
        heard.add(node.spec.id);
        node.lastBeaconS = beaconStart;
        node.beaconRssi = fate.rssi;
        node.beaconSnr = fate.snr;
        node.messages.push({
          id: this.packetId++,
          packetId: beacon.packet.id,
          t: beaconStart,
          dir: 'received',
          type: 'BEACON',
          peer: 0,
          frameHex: beacon.packet.frameHex,
          fields: beaconMessage,
        });
        this.trim(node.messages);
      }
    }
    beacon.fates = this.fatesFor(beacon, waves, txs);

    if (sfMode === 'idle') {
      for (const node of this.nodes) {
        if (!heard.has(node.spec.id)) continue;
        if (node.pendingAlert) this.scheduleAlert(node, startS, channel, waves, txs);
        if (node.shotQueue.length > 0) this.scheduleShot(node, startS, channel, waves, txs);
      }
      let idx = 0;
      for (const id of plan.health) {
        if (!heard.has(id)) {
          idx++;
          continue;
        }
        const node = this.node(id);
        if (node) this.scheduleHealth(node, startS + SCHED_START_S + idx * SCHED_SLOT_S, channel, waves, txs);
        idx++;
      }
      for (const pair of plan.ranging) {
        if (!heard.has(pair.a) || !heard.has(pair.b)) continue;
        this.scheduleRanging(pair, startS + SCHED_START_S + pair.slot * SCHED_SLOT_S, waves, txs);
      }
    } else {
      let i = 0;
      for (const id of plan.detecting) {
        if (i >= MAX_EVENT_SLOT_MAP) break;
        if (!heard.has(id)) {
          i++;
          continue;
        }
        const node = this.node(id);
        if (node) this.scheduleDetect(node, startS + EVENT_NODE_START_S + i * EVENT_NODE_SLOT_S, channel, waves, txs);
        i++;
      }
      let burst = 0;
      for (const req of plan.snippets) {
        if (!heard.has(req.node)) continue;
        const node = this.node(req.node);
        if (!node) continue;
        this.scheduleSnippet(node, req, startS + EVENT_BURST_START_S + burst * 0.06, channel, waves, txs);
        burst++;
      }
    }

    // Resolve every node transmission now that the whole superframe is known.
    for (const tx of txs) {
      if (tx.wave.tx !== 0) tx.fates = this.fatesFor(tx, waves, txs);
    }

    let alertDecoded = false;
    for (const tx of txs) {
      if (tx.wave.tx === 0) continue;
      const gatewayFate = tx.fates.get(0);
      if (!gatewayFate || gatewayFate.fate !== 'decoded') continue;
      const node = this.node(tx.wave.tx);
      if (!node) continue;
      this.logGatewayMessage(tx.message, tx.wave.tx, tx.packet.startS, 'received', tx.packet.id, tx.packet.frameHex);
      if (tx.message.type === 'SHOT') node.shotQueue.shift();
      if (tx.message.type === 'DETECT_START' || tx.message.type === 'DETECT') {
        alertDecoded = true;
        this.eventLastS = Math.max(this.eventLastS, tx.packet.startS);
        node.pendingAlert = null;
      }
      if (tx.health) {
        node.health = tx.health;
        node.lastHealthS = tx.packet.startS;
        node.healthIdleAt = this.idleSeconds();
      }
      if (tx.ranging) {
        node.ranging.push({ ...tx.ranging, atS: tx.packet.startS });
        this.trim(node.ranging);
        this.lastRanging.set(node.spec.id, { ...tx.ranging, atS: tx.packet.startS });
        const peer = this.node(tx.ranging.peer);
        if (peer) {
          peer.ranging.push({ ...tx.ranging, atS: tx.packet.startS, measuredM: tx.ranging.measuredM, trueM: tx.ranging.trueM });
          this.trim(peer.ranging);
        }
      }
    }

    // Mode decisions take effect on the next superframe.
    if (sfMode === 'idle' && alertDecoded) {
      this.mode = 'event';
      this.modeChanges.push({ atS: startS + duration, mode: 'event' });
      for (const n of this.nodes) {
        n.pendingAlert = null;
        n.snippetRequested = false;
      }
    } else if (sfMode === 'event' && startS - this.eventLastS >= EVENT_HOLD_S) {
      this.mode = 'idle';
      this.modeChanges.push({ atS: startS + duration, mode: 'idle' });
    }

    this.grid = this.buildGrid(sfMode, startS);
    this.superframe++;
    this.fullCounter = (this.fullCounter + 1) >>> 0;
    this.nextSfStart = startS + duration;
  }

  private planSlots(mode: 'idle' | 'event', sf: number): { health: number[]; ranging: RangingPair[]; detecting: number[]; snippets: { node: number; requestId: number; startSample: number; lengthMs: number }[] } {
    const health: number[] = [];
    const ranging: RangingPair[] = [];
    const detecting: number[] = [];
    const snippets: { node: number; requestId: number; startSample: number; lengthMs: number }[] = [];
    if (mode === 'idle') {
      for (const n of this.nodes) {
        if ((sf - n.spec.id) % HEALTH_PERIOD === 0) health.push(n.spec.id);
      }
      if (sf % RANGING_EVERY === 0) {
        const links = this.rangingLinks();
        const count = Math.max(0, MAX_IDLE_SLOT_MAP - health.length);
        for (let i = 0; i < Math.min(count, links.length); i++) {
          const link = links[(this.rangingCursor + i) % links.length];
          ranging.push({ ...link, slot: health.length + i });
        }
        if (links.length > 0) {
          this.rangingCursor = (this.rangingCursor + count) % links.length;
          this.rangingSweep++;
        }
      }
    } else {
      for (const n of this.nodes) if (n.stub.detecting) detecting.push(n.spec.id);
      detecting.sort((a, b) => a - b);
      for (const id of detecting) {
        const n = this.node(id);
        if (!n || n.snippetRequested || snippets.length >= MAX_SNIPPET_REQUESTS) continue;
        n.snippetRequested = true;
        snippets.push({ node: id, requestId: this.packetId & 0xff, startSample: Math.round((this.nowS * 4000) % 0xffffffff), lengthMs: 250 });
      }
    }
    return { health, ranging, detecting, snippets };
  }

  private rangingLinks(): { a: number; b: number }[] {
    const links: { a: number; b: number; d: number }[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        const d = Math.hypot(a.spec.x - b.spec.x, a.spec.y - b.spec.y);
        if (d <= RANGING_MAX_LINK_M) links.push({ a: a.spec.id, b: b.spec.id, d });
      }
    }
    links.sort((x, y) => x.a - y.a || x.b - y.b);
    return links.map(({ a, b }) => ({ a, b }));
  }

  private makeTx(tx: number, message: Message, frame: Uint8Array, startS: number, endS: number, sf: number, bw: number, channel: ChannelSpec, slot: string, waves: Wave[]): TxPlan {
    const id = this.packetId++;
    const power = new Map<number, number>();
    for (const rx of this.receivers(tx)) {
      if (rx === tx) continue;
      const budget = linkBudget(this.position(tx), this.position(rx), bw, {
        seed: this.seed,
        terrain: this.terrain,
        linkA: tx,
        linkB: rx,
        fadeDb: packetFadeDb(this.seed, id, tx, rx),
      });
      power.set(rx, budget.rssiDbm);
    }
    const wave: Wave = { id, tx, rx: [...power.keys()], startS, endS, sf, bw, channel: channel.index, power };
    waves.push(wave);
    const packet: PacketView = {
      id,
      startS,
      endS,
      tx,
      rx: [],
      sf,
      bw,
      channel: channelName(channel),
      type: messageType(message),
      payloadBytes: frame.length - 7,
      airtimeS: endS - startS,
      slot,
      frameHex: frameHex(frame),
      message,
    };
    this.duty.addTx(tx, channelName(channel), endS - startS);
    this.duty.addBusy(channelName(channel), endS - startS);
    if (tx !== 0) {
      const node = this.node(tx);
      if (node) {
        node.txSeconds += endS - startS;
        node.messages.push({
          id: this.packetId++,
          packetId: id,
          t: startS,
          dir: 'sent',
          type: messageType(message),
          peer: 0,
          frameHex: packet.frameHex,
          fields: message,
        });
        this.trim(node.messages);
      }
    }
    this.pushPacket(packet);
    return { packet, wave, message, fates: new Map(), health: null, ranging: null };
  }

  private scheduleAlert(node: NetNode, startS: number, channel: ChannelSpec, waves: Wave[], txs: TxPlan[]): void {
    const slot = Math.floor(node.stub.nextFloat() * ALERT_SLOTS);
    const msg: Message = {
      type: 'DETECT_START',
      confidence: node.pendingAlert ? node.pendingAlert.detection.confidence : 0,
      level: node.pendingAlert ? node.pendingAlert.detection.levelDb : 0,
      cls: node.pendingAlert ? node.pendingAlert.detection.cls : 0,
      az: node.pendingAlert ? node.pendingAlert.detection.az : 0,
      el: node.pendingAlert ? node.pendingAlert.detection.el : 0,
      lineHz: node.pendingAlert ? node.pendingAlert.detection.lineHz : 0,
    };
    const s = startS + ALERT_START_S + slot * ALERT_SLOT_S;
    const frame = encodeFrame(msg, node.spec.id, { fullCounter: this.fullCounter });
    const e = s + airtime(IDLE_SF, IDLE_BW, frame.length);
    txs.push(this.makeTx(node.spec.id, msg, frame, s, e, IDLE_SF, IDLE_BW, channel, `alert ${slot + 1}`, waves));
  }

  // One SHOT for the oldest queued onset, in a random alert slot. The queue keeps it until the gateway decodes it.
  private scheduleShot(node: NetNode, startS: number, channel: ChannelSpec, waves: Wave[], txs: TxPlan[]): void {
    const slot = Math.floor(node.stub.nextFloat() * ALERT_SLOTS);
    const msg: Message = { type: 'SHOT', tMs: node.shotQueue[0] };
    const s = startS + ALERT_START_S + slot * ALERT_SLOT_S;
    const frame = encodeFrame(msg, node.spec.id, { fullCounter: this.fullCounter });
    const e = s + airtime(IDLE_SF, IDLE_BW, frame.length);
    txs.push(this.makeTx(node.spec.id, msg, frame, s, e, IDLE_SF, IDLE_BW, channel, `shot ${slot + 1}`, waves));
  }

  private scheduleHealth(node: NetNode, s: number, channel: ChannelSpec, waves: Wave[], txs: TxPlan[]): void {
    const ctx = {
      bandFloorDb: node.stub.minBandDb === 255 ? this.ambientDb : node.stub.minBandDb,
      beaconRssi: node.beaconRssi,
      beaconSnr: node.beaconSnr,
      neighboursHeard: node.heard,
      detections: node.stub.detections,
      rejected: node.stub.rejected,
      retries: node.stub.retries,
      queue: node.stub.queue,
      arrayNode: node.spec.kind === 'array',
    };
    const { fields, values } = node.stub.healthFields(ctx);
    const msg: Message = { type: 'HEALTH', fields };
    const frame = encodeFrame(msg, node.spec.id, { fullCounter: this.fullCounter });
    const e = s + airtime(IDLE_SF, IDLE_BW, frame.length);
    const tx = this.makeTx(node.spec.id, msg, frame, s, e, IDLE_SF, IDLE_BW, channel, 'health', waves);
    tx.health = healthView(fields, values, s);
    txs.push(tx);
  }

  private scheduleDetect(node: NetNode, s: number, channel: ChannelSpec, waves: Wave[], txs: TxPlan[]): void {
    const det = node.pendingAlert?.detection ?? this.detectionFor(node);
    const msg: Message = {
      type: 'DETECT',
      confidence: det.confidence,
      level: det.levelDb,
      az: det.az,
      el: det.el,
      bearingSigma: det.bearingSigma,
      line1Hz: det.lineHz,
      line2Delta: det.line2Delta,
      cls: det.cls,
      clipReady: 1,
    };
    const frame = encodeFrame(msg, node.spec.id, { fullCounter: this.fullCounter });
    const e = s + airtime(EVENT_SF, EVENT_BW, frame.length);
    txs.push(this.makeTx(node.spec.id, msg, frame, s, e, EVENT_SF, EVENT_BW, channel, 'detect', waves));
  }

  private scheduleSnippet(node: NetNode, req: { requestId: number; startSample: number; lengthMs: number }, s: number, channel: ChannelSpec, waves: Wave[], txs: TxPlan[]): void {
    const bits = node.stub.snippet(node.lastAudio, this.nowS, Math.min(960, req.lengthMs * 4));
    const msg: Message = {
      type: 'SNIPPET',
      requestId: req.requestId,
      chunk: 0,
      chunks: Math.max(1, Math.ceil((req.lengthMs * 4) / Math.max(1, bits.length))),
      startSample: req.startSample,
      data: bits,
    };
    const frame = encodeFrame(msg, node.spec.id, { fullCounter: this.fullCounter });
    const e = s + airtime(EVENT_SF, EVENT_BW, frame.length);
    txs.push(this.makeTx(node.spec.id, msg, frame, s, e, EVENT_SF, EVENT_BW, channel, 'snippet', waves));
  }

  private scheduleRanging(pair: RangingPair, s: number, waves: Wave[], txs: TxPlan[]): void {
    const a = this.node(pair.a);
    const b = this.node(pair.b);
    if (!a || !b) return;
    const trueM = Math.hypot(a.spec.x - b.spec.x, a.spec.y - b.spec.y);
    const measuredM = measureRange(this.seed, pair.a, pair.b, trueM, this.rangingSweep);
    const budget = linkBudget(this.position(pair.a), this.position(pair.b), RANGING_BW, {
      seed: this.seed,
      terrain: this.terrain,
      linkA: pair.a,
      linkB: pair.b,
      fadeDb: packetFadeDb(this.seed, this.packetId, pair.a, pair.b),
    });
    const chan = rangingChannel(this.rangingSweep + pair.slot);
    const rangeDm = clamp(Math.round(measuredM * 10), 0, 0xffff);
    const rssi = clamp(Math.round(budget.rssiDbm + 160), 0, 255);
    const snr = clamp(Math.round(budget.snrDb + 20), 0, 255);
    const msg: Message = { type: 'RANGING_RESULT', results: [{ id: pair.b, rangeDm, rssi, snr }] };
    const frame = encodeFrame(msg, pair.a, { fullCounter: this.fullCounter });
    const e = s + airtime(RANGING_SF, RANGING_BW, frame.length);
    const tx = this.makeTx(pair.a, msg, frame, s, e, RANGING_SF, RANGING_BW, chan, 'ranging', waves);
    tx.ranging = { atS: s, sweep: this.rangingSweep, peer: pair.b, measuredM, trueM, rssi: budget.rssiDbm, snr: budget.snrDb };
    txs.push(tx);
  }

  private fatesFor(tx: TxPlan, waves: Wave[], txs: TxPlan[]): Map<number, RxView> {
    const out = new Map<number, RxView>();
    for (const rx of tx.wave.rx) {
      const fate = receiveWave(tx.wave, rx, waves, this.busyFor(rx, txs));
      out.set(rx, { id: rx, fate: fate.fate, rssi: fate.rssi, snr: fate.snr, reason: fate.reason });
    }
    tx.packet.rx = [...out.values()];
    this.completePacket(tx.packet);
    return out;
  }

  private busyFor(receiver: number, txs: TxPlan[]): { startS: number; endS: number }[] {
    const out: { startS: number; endS: number }[] = [];
    for (const tx of txs) if (tx.wave.tx === receiver) out.push({ startS: tx.wave.startS, endS: tx.wave.endS });
    return out;
  }

  private pushPacket(packet: PacketView): void {
    this.packets.push(packet);
    if (this.packets.length > MAX_PACKETS) this.packets.splice(0, this.packets.length - MAX_PACKETS);
  }

  // Replaces the recorded packet after its fates are known.
  private completePacket(packet: PacketView): void {
    const i = this.packets.findIndex((p) => p.id === packet.id);
    if (i >= 0) this.packets[i] = packet;
  }

  private logGatewayMessage(message: Message, peer: number, tS: number, dir: 'sent' | 'received', packetId: number, frameHex: string[]): void {
    this.gatewayMessages.push({
      id: this.packetId++,
      packetId,
      t: tS,
      dir,
      type: message.type,
      peer,
      frameHex,
      fields: message,
    });
    this.trim(this.gatewayMessages);
  }

  private trim<T>(list: T[]): void {
    if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
  }

  private idleSeconds(): number {
    // Mode runs are short in the demo; the health dashboard uses this to exclude event time.
    return this.superframe * IDLE_SUPERFRAME_S;
  }

  private trackState(): { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; time: number } | null {
    const t = this.truth[0];
    if (!t) return null;
    return {
      id: t.id,
      x: t.x,
      y: t.y,
      z: t.alt,
      vx: 0,
      vy: 0,
      vz: 0,
      time: Math.round(this.nowS * 1000) & 0xffff,
    };
  }

  private buildGrid(mode: 'idle' | 'event', startS: number): GridSlot[] {
    const out: GridSlot[] = [];
    if (mode === 'idle') {
      out.push({ startS, endS: startS + ALERT_START_S, label: 'Beacon', kind: 'beacon' });
      for (let i = 0; i < ALERT_SLOTS; i++) {
        out.push({ startS: startS + ALERT_START_S + i * ALERT_SLOT_S, endS: startS + ALERT_START_S + (i + 1) * ALERT_SLOT_S, label: `Alert ${i + 1}`, kind: 'alert' });
      }
      for (let i = 0; i < SCHED_SLOTS; i++) {
        out.push({ startS: startS + SCHED_START_S + i * SCHED_SLOT_S, endS: startS + SCHED_START_S + (i + 1) * SCHED_SLOT_S, label: `Slot ${i + 1}`, kind: 'slot' });
      }
    } else {
      out.push({ startS, endS: startS + 0.025, label: 'Beacon', kind: 'beacon' });
      for (let i = 0; i < EVENT_NODE_SLOTS; i++) {
        out.push({ startS: startS + EVENT_NODE_START_S + i * EVENT_NODE_SLOT_S, endS: startS + EVENT_NODE_START_S + (i + 1) * EVENT_NODE_SLOT_S, label: `Node ${i + 1}`, kind: 'slot' });
      }
      out.push({ startS: startS + EVENT_BURST_START_S, endS: startS + EVENT_SUPERFRAME_S, label: 'Burst', kind: 'burst' });
    }
    return out;
  }

  private nodeView(node: NetNode): NodeView {
    const elapsed = Math.max(this.nowS, TICK_S);
    const nil = node.lastHealthS === null;
    const silent = this.mode === 'idle' && (nil ? this.idleSeconds() > 2 * HEALTH_PERIOD * IDLE_SUPERFRAME_S : this.idleSeconds() - node.healthIdleAt > 2 * HEALTH_PERIOD * IDLE_SUPERFRAME_S);
    return {
      id: node.spec.id,
      kind: node.spec.kind,
      detecting: node.stub.detecting,
      targetIds: node.stub.targetId === null ? [] : [node.stub.targetId],
      trackHz: node.stub.trackHz,
      pitchHz: node.stub.pitchHz,
      bearingDeg: node.stub.bearingDeg,
      beaconHeard: node.beaconHeard,
      lastDetectionS: node.stub.lastDetectionS,
      detectSpans: node.stub.spans.map((s) => ({ ...s })),
      shotTimesS: [...node.stub.shotTimesS],
      peak: node.stub.peak,
      detectState: node.stub.state,
      detections: node.stub.detections,
      queue: node.stub.queue,
      retries: node.stub.retries,
      silent,
      lastHealthS: node.lastHealthS,
      health: node.health,
      messages: node.messages.slice(-MAX_MESSAGES),
      ranging: node.ranging.slice(-MAX_RANGING),
      duty: node.txSeconds / elapsed,
      txSeconds: node.txSeconds,
    };
  }

  private gatewayView(): GatewayView {
    const health = this.nodes.map((n) => {
      const age = n.lastHealthS === null ? Infinity : this.nowS - n.lastHealthS;
      const silent = n.lastHealthS === null || age > 2 * HEALTH_PERIOD * IDLE_SUPERFRAME_S;
      return { id: n.spec.id, health: n.health, silent, lastHealthS: n.lastHealthS };
    });
    const channels = new Map<string, number>();
    for (const p of this.packets) {
      channels.set(p.channel, 0);
    }
    const duty = [...channels.keys()].map((channel) => ({
      channel,
      duty: this.duty.channelDuty(channel),
      seconds: this.duty.channelSeconds(channel),
    }));
    const elapsed = Math.max(this.nowS, TICK_S);
    return {
      mode: this.mode,
      superframe: this.superframe,
      eventLastS: this.eventLastS,
      health,
      silent: health.filter((h) => h.silent).map((h) => h.id),
      duty,
      beaconDuty: this.beaconSeconds / elapsed,
      messages: this.gatewayMessages.slice(-MAX_MESSAGES),
    };
  }

  snapshot(): LoraView {
    return {
      mode: this.mode,
      superframe: this.superframe,
      superframeStartS: this.sfStartS,
      superframeDurationS: this.sfDurationS,
      eventLastS: this.eventLastS,
      packets: this.packets,
      nodes: this.nodes.map((n) => this.nodeView(n)),
      bogies: this.bogies,
      shotFixes: this.shotFixes,
      gateway: this.gatewayView(),
      grid: this.grid,
    };
  }

  // Compact, deterministic state for replay. The packet log is not part of the hash; the counters and
  // node stubs that decide future packets are.
  stateHash(): string {
    const nodes = this.nodes.map((n) => `${n.spec.id}:${n.spec.kind}:${n.spec.x.toFixed(3)}:${n.spec.y.toFixed(3)}:${n.stub.stateHash()}:${n.beaconHeard ? 1 : 0}:${n.pendingAlert ? 1 : 0}:${n.shotQueue.join(',')}:${n.snippetRequested ? 1 : 0}:${n.lastHealthS ?? '-'}:${n.healthIdleAt.toFixed(3)}:${n.beaconRssi.toFixed(4)}:${n.beaconSnr.toFixed(4)}:${n.txSeconds.toFixed(6)}`).join('|');
    return fnv1a(
      JSON.stringify({
        mode: this.mode,
        superframe: this.superframe,
        nextSfStart: this.nextSfStart,
        eventLastS: this.eventLastS,
        fullCounter: this.fullCounter,
        packetId: this.packetId,
        rangingCursor: this.rangingCursor,
        rangingSweep: this.rangingSweep,
        beaconSeconds: this.beaconSeconds.toFixed(6),
        duty: this.duty.asObject(),
        nodes,
        gateway: this.gatewayPos,
        rng: this.rng.state,
      }),
    );
  }

  // Times of mode changes, for the tests and the gateway inspector.
  get changes(): { atS: number; mode: 'idle' | 'event' }[] {
    return this.modeChanges;
  }

  packet(id: number): PacketView | undefined {
    return this.packets.find((p) => p.id === id);
  }

  fateOf(packet: PacketView, receiver: number): Fate | null {
    return packet.rx.find((r) => r.id === receiver)?.fate ?? null;
  }
}
