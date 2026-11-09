import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { areaEdge, type BogieArea } from '../lora/locate';
import type { LoraView } from '../lora/types';
import type { Selection } from '../selection';
import type { NodeKind } from '../sim/scenario';
import { lastShotTick, type ShooterState } from '../sim/shots';
import { SOUND_SPEED_MPS } from '../acoustics/model';
import { TICK_S } from '../sim/clock';
import { groundColor, placeTrees, SUV, SUVS, TENT, TENTS, type Terrain } from '../sim/terrain';
import { DRONE_CLASSES, type World, type WorldState } from '../sim/world';
import type { DroneClass } from '../sim/scenario';
import type { Point, ScreenPos } from '../ui/popup';

const FATE_COLOR: Record<string, number> = {
  decoded: 0x3ddc84,
  collision: 0xffb347,
  'half-duplex': 0xc86ad6,
  range: 0xe0605a,
};
const FATE_CSS: Record<string, string> = {
  decoded: '#3ddc84',
  collision: '#ffb347',
  'half-duplex': '#c86ad6',
  range: '#e0605a',
};
const PACKET_SECONDS = 1;

// Marker sizes: every object is drawn 3x and always has a ring; the selected one is 5x.
const ICON_SCALE = 3;
const SELECTED_SCALE = 5;
const RING_SELECTED = 0xffe066;
const RING_COLOR = { detector: 0x4aa3ff, array: 0xff9f43, gateway: 0x3ddc84, drone: 0xff4d6d } as const;
const DETECT_LINE = 0x9aa4b2; // the Truth view's link from a node to a drone
const DETECT_PULSE = 0xff4d6d;
const PULSE_PERIOD_S = 1.2;
// One colour per bogie letter.
const BOGIE_COLORS = [0xe879f9, 0xfde047, 0x22d3ee, 0xa3e635];
const bogieColor = (letter: string): number => BOGIE_COLORS[(letter.charCodeAt(0) - 65) % BOGIE_COLORS.length];
const bogieLabel = (b: { letter: string; pitchHz: number }): string => `Bogie ${b.letter}, ~${Math.round(b.pitchHz / 10) * 10} Hz`;
const css = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;
const DETECT_LINE_PX = 5;
const BOGIE_BAND_M = 50;
const BOGIE_LINE_PX = 18;
const NODE_RING_M = 39;
const LABEL_WIDTH_M = 240;
const PITCH_LABEL_PX = 70;
const AREA_LINE_PX = 3;
// Ground marks draw after the terrain with no depth test, so hills never cut through them.
const OVER_TERRAIN = 3;
const BEARING_ARROW = 0xffffff;
const BEARING_ARROW_M = 90;
const BEARING_ARROW_PX = 44;

function isSelected(selection: Selection, kind: 'node' | 'drone' | 'gateway', id = 0): boolean {
  if (!selection) return false;
  if (kind === 'gateway') return selection.kind === 'gateway';
  return selection.kind === kind && selection.id === id;
}

function packetColor(fate: string): number {
  return FATE_COLOR[fate] ?? 0x8a98a8;
}

function fateCss(fate: string): string {
  return FATE_CSS[fate] ?? '#8a98a8';
}

export type ViewMode = 'orbit' | 'follow' | 'top';

// Far enough back to keep several nodes in view; the example line has one every 120 m.
const FOLLOW_OFFSET = new THREE.Vector3(0, 204, 504);
// Camera start points for a terrain REF_TERRAIN_M wide; other sizes scale from these.
const REF_TERRAIN_M = 2000;
const TOP_HEIGHT_M = 1700;
const ORBIT_START = new THREE.Vector3(-560, 440, 760);
const FLIGHT_MS = 1500;
export type Target = { kind: 'node' | 'drone'; id: number } | { kind: 'gateway' } | { kind: 'terrain' };
export interface Hit {
  target: Target;
  x: number;
  y: number;
}

// How close the pointer must be to a marker in the 2D map to pick it, in pixels.
const PICK_PX = 16;
// Blank margin around the terrain in the 2D map, in pixels.
const MAP_MARGIN_PX = 16;
const MAP_GROUND_CELLS = 400;
const MAP_GROUND_LEVEL = 0.55;
// Lift of the anchor above the ground, so the window points at the mast or body rather than its foot.
const ANCHOR_LIFT_M = { node: 3, gateway: 4, packet: 4 } as const;

const SKY = 0xaed0e0;

// Sim (x east, y north, h up) to three.js (y up, north is -z).
export function toScene(x: number, y: number, h: number): THREE.Vector3 {
  return new THREE.Vector3(x, h, -y);
}

// Fine enough to follow the terrain's smallest bumps, and the road along them.
const TERRAIN_CELLS_X = 200;

function buildTerrain(t: Terrain): THREE.Mesh {
  const [w, h] = t.size;
  const nx = TERRAIN_CELLS_X;
  const ny = Math.round((nx * h) / w);
  const pos = new Float32Array((nx + 1) * (ny + 1) * 3);
  const col = new Float32Array((nx + 1) * (ny + 1) * 3);
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = -w / 2 + (i * w) / nx;
      const y = -h / 2 + (j * h) / ny;
      const ground = t.height(x, y);
      const k = (j * (nx + 1) + i) * 3;
      pos[k] = x;
      pos[k + 1] = ground;
      pos[k + 2] = -y;
      col.set(groundColor(t, x, y), k);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const c = a + (nx + 1);
      idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.userData.target = { kind: 'terrain' } satisfies Target;
  return mesh;
}

// Visual only. The road sits 0.6 m above the terrain.
function buildRoad(t: Terrain): THREE.Mesh {
  const [w] = t.size;
  const nx = TERRAIN_CELLS_X;
  const half = 4;
  const pos = new Float32Array((nx + 1) * 2 * 3);
  for (let i = 0; i <= nx; i++) {
    const x = -w / 2 + (i * w) / nx;
    for (let s = 0; s < 2; s++) {
      const y = t.roadY + (s === 0 ? -half : half);
      const k = (i * 2 + s) * 3;
      pos[k] = x;
      pos[k + 1] = t.height(x, y) + 0.6;
      pos[k + 2] = -y;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nx; i++) {
    const a = i * 2;
    const c = a + 2;
    idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x3b3f44, side: THREE.DoubleSide }));
}

// Visual only. Walls and body reach below the ground, so that a slope leaves no gap.
const SINK_M = 1.5;

function solid(geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, flatShading: true }));
  mesh.position.set(x, y, z);
  mesh.raycast = () => {};
  return mesh;
}

function buildTent(): THREE.Group {
  const [halfW, len, wallH, ridgeH] = [TENT.width_m / 2, TENT.length_m, 1.6, TENT.height_m];
  const color = 0x4b5320;
  const profile = new THREE.Shape([new THREE.Vector2(-halfW, 0), new THREE.Vector2(halfW, 0), new THREE.Vector2(0, ridgeH - wallH)]);
  const roof = new THREE.ExtrudeGeometry(profile, { depth: len, bevelEnabled: false });
  roof.translate(0, 0, -len / 2);
  const group = new THREE.Group();
  group.add(solid(new THREE.BoxGeometry(2 * halfW, wallH + SINK_M, len), color, 0, (wallH - SINK_M) / 2, 0), solid(roof, 0x565e28, 0, wallH, 0));
  return group;
}

function buildSuv(): THREE.Group {
  const [len, wide] = [SUV.length_m, SUV.width_m];
  const group = new THREE.Group();
  const bodyTop = 1.1;
  group.add(
    solid(new THREE.BoxGeometry(wide, bodyTop + SINK_M - 0.35, len), 0x3d4436, 0, (bodyTop + 0.35 - SINK_M) / 2, 0),
    solid(new THREE.BoxGeometry(wide * 0.92, SUV.height_m - bodyTop, len * 0.62), 0x2b3128, 0, (SUV.height_m + bodyTop) / 2, -len * 0.1),
  );
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = solid(new THREE.CylinderGeometry(0.38, 0.38, 0.28, 12), 0x15181a, (sx * wide) / 2, 0.38, (sz * len) / 3);
      wheel.rotation.z = Math.PI / 2;
      group.add(wheel);
    }
  }
  return group;
}

export function buildCamp(t: Terrain): THREE.Group {
  const camp = new THREE.Group();
  const place = (obj: THREE.Group, at: { x: number; y: number }): void => {
    obj.position.copy(toScene(at.x, at.y, t.height(at.x, at.y)));
    camp.add(obj);
  };
  for (const at of TENTS) place(buildTent(), at);
  for (const at of SUVS) place(buildSuv(), at);
  return camp;
}

function buildTrees(t: Terrain): THREE.InstancedMesh {
  const trees = placeTrees(t);
  const geo = new THREE.ConeGeometry(1, 1, 6, 1);
  geo.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0x2f6135, flatShading: true }), trees.length);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const q = new THREE.Quaternion();
  trees.forEach((tr, i) => {
    p.copy(toScene(tr.x, tr.y, t.height(tr.x, tr.y)));
    s.set(tr.radius_m, tr.height_m, tr.radius_m);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// Invisible sphere so small objects are easy to click.
function hitSphere(radius: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), mat);
}

function buildNode(kind: NodeKind, id: number): THREE.Group {
  const g = new THREE.Group();
  g.userData.target = { kind: 'node', id } satisfies Target;
  if (kind === 'detector') {
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.5, 4, 8),
      new THREE.MeshLambertMaterial({ color: 0x4aa3ff }),
    );
    mast.position.y = 2;
    const mic = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshLambertMaterial({ color: 0xbfe3ff }));
    mic.position.y = 4.4;
    g.add(mast, mic);
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshLambertMaterial({ color: 0xff9f43 }));
    body.position.y = 2;
    g.add(body);
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const mic = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshLambertMaterial({ color: 0xffe0b3 }));
      mic.position.set(sx * 1.1, 4.4, sz * 1.1);
      g.add(mic);
    }
  }
  g.add(hitSphere(6));
  return g;
}

// Visual only, at real size. A range has a firing line at its origin and its targets downrange, which is south (+z here,
// away from the line of nodes), so the targets sit at 25, 50 and 100 m. The berm stops the rounds at the end.
function buildRange(): THREE.Group {
  const group = new THREE.Group();
  const wood = 0x6b5a3e;
  const steel = 0x7a7f86;
  for (const x of [-6, 0, 6]) group.add(solid(new THREE.BoxGeometry(2.5, 0.5, 0.8), wood, x, 0.4, 0));
  for (const x of [-10, 10]) group.add(solid(new THREE.BoxGeometry(0.25, 3.2, 0.25), wood, x, 1.6, 0));
  group.add(solid(new THREE.BoxGeometry(22, 0.3, 4), steel, 0, 3.35, -0.5));
  group.add(solid(new THREE.BoxGeometry(4, 2.6, 3), steel, 16, 1.3, -2));
  group.add(solid(new THREE.BoxGeometry(4.6, 0.25, 3.6), 0x4b5320, 16, 2.7, -2));
  group.add(solid(new THREE.CylinderGeometry(0.08, 0.08, 7, 6), 0xbfc3c8, -14, 3.5, 0));
  group.add(solid(new THREE.BoxGeometry(1.2, 0.7, 0.04), 0xb0302f, -13.4, 6.4, 0));
  for (const z of [25, 50, 100]) {
    group.add(solid(new THREE.BoxGeometry(0.15, 2, 0.15), wood, 0, 1, z));
    group.add(solid(new THREE.BoxGeometry(1.0, 1.2, 0.05), 0xdedacb, 0, 1.6, z));
    group.add(solid(new THREE.BoxGeometry(0.4, 0.4, 0.06), 0x222222, 0, 1.6, z + 0.03));
  }
  group.add(solid(new THREE.BoxGeometry(60, 6, 6), 0x5d6b3a, 0, 2.5, 115));
  return group;
}

// A shooter on the ground, standing at its origin with the rifle downrange (-z).
function buildShooter(): THREE.Group {
  const group = new THREE.Group();
  const cloth = 0x3d4a2f;
  group.add(solid(new THREE.BoxGeometry(0.5, 0.9, 0.4), 0x2b2f24, 0, 0.45, 0));
  group.add(solid(new THREE.BoxGeometry(0.6, 0.9, 0.4), cloth, 0, 1.35, 0));
  group.add(solid(new THREE.SphereGeometry(0.2, 8, 6), 0xd9b79a, 0, 2.0, 0));
  group.add(solid(new THREE.BoxGeometry(0.1, 0.12, 1.0), 0x1d1d1d, 0.1, 1.4, -0.5));
  return group;
}

// The bright part of a shot, at the muzzle. Shown for a moment after each shot. A range faces south (+z), a shooter north (-z).
function muzzleFlash(kind: ShooterState['kind']): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0, depthWrite: false });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), mat);
  flash.position.set(0.1, 1.4, kind === 'range' ? 1.1 : -1.1);
  flash.raycast = () => {};
  return flash;
}

// The blast wave on the ground, drawn at the speed of sound so its growth is real.
function blastWave(): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const wave = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), mat);
  wave.rotation.x = -Math.PI / 2;
  wave.position.y = 0.5;
  wave.raycast = () => {};
  return wave;
}

const FLASH_S = 0.08;
const WAVE_S = 1.5;
const HEARD_S = 1.5;
const HEARD_RADIUS_M = 40;

function buildGateway(): THREE.Group {
  const g = new THREE.Group();
  g.userData.target = { kind: 'gateway' } satisfies Target;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3, 8, 12), new THREE.MeshLambertMaterial({ color: 0x3ddc84 }));
  body.position.y = 4;
  g.add(body, hitSphere(8));
  return g;
}

function buildDrone(id: number, cls: DroneClass): { obj: THREE.Group; tether: THREE.Line } {
  const span = Math.max(3, DRONE_CLASSES[cls].size_m * 8);
  const g = new THREE.Group();
  g.userData.target = { kind: 'drone', id } satisfies Target;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(span * 0.3, span * 0.12, span * 0.3),
    new THREE.MeshLambertMaterial({ color: 0xff4d6d }),
  );
  g.add(body);
  const rotorMat = new THREE.MeshLambertMaterial({ color: 0x202830, transparent: true, opacity: 0.7 });
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(span * 0.22, span * 0.22, span * 0.02, 12), rotorMat);
    rotor.position.set(sx * span * 0.4, span * 0.08, sz * span * 0.4);
    g.add(rotor);
  }
  g.add(hitSphere(span * 1.5));
  // Drop line to the ground, so altitude reads at a glance.
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]);
  const tether = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
  tether.raycast = () => {};
  g.add(tether);
  return { obj: g, tether };
}

// Null when the browser has no WebGL. The app then runs without the 3D view.
function createRenderer(): THREE.WebGLRenderer | null {
  try {
    return new THREE.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
}

function disposeGroup(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

export class WorldView {
  private readonly renderer: THREE.WebGLRenderer | null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 1, 30000);
  private readonly controls: OrbitControls | null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly staticGroup = new THREE.Group();
  private readonly nodeGroup = new THREE.Group();
  private readonly droneGroup = new THREE.Group();
  private readonly packetGroup = new THREE.Group();
  private readonly detectGroup = new THREE.Group();
  private readonly shooterGroup = new THREE.Group();
  private readonly shooterMeshes = new Map<number, { kind: ShooterState['kind']; obj: THREE.Group; flash: THREE.Mesh; wave: THREE.Mesh }>();
  private readonly shotGroup = new THREE.Group();
  private readonly labelTextures = new Map<string, THREE.CanvasTexture>();
  private readonly gateway = buildGateway();
  private map: HTMLCanvasElement | null = null;
  private mapCtx: CanvasRenderingContext2D | null = null;
  private readonly ringGroup = new THREE.Group();
  private readonly rings = new Map<string, THREE.Mesh>();
  private readonly nodeMeshes = new Map<number, { kind: NodeKind; obj: THREE.Group }>();
  private readonly droneMeshes = new Map<number, { cls: DroneClass; obj: THREE.Group; tether: THREE.Line }>();
  private terrain: Terrain | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  private view: ViewMode = 'orbit';
  private followId: number | null = null;
  private flight: { startMs: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3 } | null = null;
  // The last state handed to sync(), for screenPos and the 2D picking.
  private snap: { world: World; state: WorldState; lora: LoraView | null; nowS: number } | null = null;

  constructor(private readonly container: HTMLElement) {
    const renderer = createRenderer();
    const controls = renderer && new OrbitControls(this.camera, renderer.domElement);
    this.renderer = renderer;
    this.controls = controls;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 4000, 12000);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(-1500, 2500, 1000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4d6035, 1.8), sun);
    this.scene.add(this.staticGroup, this.nodeGroup, this.droneGroup, this.packetGroup, this.detectGroup, this.gateway);
    this.scene.add(this.shooterGroup, this.shotGroup);
    this.scene.add(this.ringGroup);
    if (!renderer || !controls) {
      const note = document.createElement('div');
      note.className = 'no-webgl';
      note.textContent = '3D view needs WebGL; this 2D top-down map shows the same world and packets';
      this.map = document.createElement('canvas');
      this.map.className = 'map2d';
      this.mapCtx = this.map.getContext('2d');
      container.append(this.map, note);
      const ro = new ResizeObserver(() => this.resize2d());
      ro.observe(container);
      this.resize2d();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    controls.enableDamping = true;
    controls.addEventListener('start', () => (this.flight = null)); // the user took the camera
    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(container);
    this.resize();
    this.setView('orbit', null);
  }

  setWorld(world: World): void {
    if (!this.renderer || world.terrain === this.terrain) return;
    this.terrain = world.terrain;
    disposeGroup(this.staticGroup);
    this.staticGroup.clear();
    this.terrainMesh = buildTerrain(world.terrain);
    this.staticGroup.add(this.terrainMesh, buildRoad(world.terrain), buildTrees(world.terrain), buildCamp(world.terrain));
    this.nodeGroup.clear();
    this.nodeMeshes.clear();
    this.droneGroup.clear();
    this.droneMeshes.clear();
    disposeGroup(this.shooterGroup);
    this.shooterGroup.clear();
    this.shooterMeshes.clear();
    this.setView('orbit', null);
  }

  // smooth flies the camera to a followed drone instead of cutting to it.
  setView(view: ViewMode, followId: number | null, smooth = false): void {
    const controls = this.controls;
    if (!controls) return;
    this.view = view;
    this.followId = followId;
    this.flight = null;
    controls.enableRotate = view !== 'top';
    const scale = (this.terrain?.size[0] ?? REF_TERRAIN_M) / REF_TERRAIN_M;
    if (view === 'top') {
      controls.target.set(0, 0, 0);
      this.camera.position.set(0, TOP_HEIGHT_M * scale, 1);
    } else if (view === 'follow') {
      const m = followId === null ? undefined : this.droneMeshes.get(followId);
      if (m && smooth) {
        this.flight = {
          startMs: performance.now(),
          fromPos: this.camera.position.clone(),
          fromTarget: controls.target.clone(),
        };
      } else if (m) {
        controls.target.copy(m.obj.position);
        this.camera.position.copy(m.obj.position).add(FOLLOW_OFFSET);
      }
    } else {
      controls.target.set(0, 0, 0);
      this.camera.position.copy(ORBIT_START).multiplyScalar(scale);
    }
  }

  // The ground direction the camera faces, as a unit vector (x east, y north). The 2D map is north up.
  cameraHeading(): { x: number; y: number } {
    if (!this.renderer) return { x: 0, y: 1 };
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const len = Math.hypot(dir.x, dir.z);
    return len < 1e-6 ? { x: 0, y: 1 } : { x: dir.x / len, y: -dir.z / len };
  }

  // Moves the scene camera with the followed drone. Called every frame.
  render(): void {
    const { renderer, controls } = this;
    if (!renderer || !controls) return;
    if (this.view === 'follow' && this.followId !== null) {
      const m = this.droneMeshes.get(this.followId);
      if (m && this.flight) {
        // Aim at the moving drone throughout, so the flight ends exactly where following begins.
        const u = Math.min(1, (performance.now() - this.flight.startMs) / FLIGHT_MS);
        const ease = u * u * (3 - 2 * u);
        controls.target.lerpVectors(this.flight.fromTarget, m.obj.position, ease);
        this.camera.position.lerpVectors(this.flight.fromPos, m.obj.position.clone().add(FOLLOW_OFFSET), ease);
        if (u >= 1) this.flight = null;
      } else if (m) {
        const delta = m.obj.position.clone().sub(controls.target);
        controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    controls.update();
    renderer.render(this.scene, this.camera);
  }

  // Makes three.js objects match world state. Rendering only reads state.
  sync(world: World, state: WorldState, selection: Selection, lora: LoraView | null = null, nowS = 0): void {
    this.snap = { world, state, lora, nowS };
    if (!this.renderer) {
      this.draw2d(world, state, selection, lora, nowS);
      return;
    }
    const terrain = world.terrain;
    const seenNodes = new Set<number>();
    for (const n of state.nodes) {
      seenNodes.add(n.id);
      let e = this.nodeMeshes.get(n.id);
      if (!e || e.kind !== n.kind) {
        if (e) this.nodeGroup.remove(e.obj);
        e = { kind: n.kind, obj: buildNode(n.kind, n.id) };
        this.nodeGroup.add(e.obj);
        this.nodeMeshes.set(n.id, e);
      }
      e.obj.position.copy(toScene(n.x, n.y, terrain.height(n.x, n.y)));
      e.obj.scale.setScalar(isSelected(selection, 'node', n.id) ? SELECTED_SCALE : ICON_SCALE);
    }
    for (const [id, e] of this.nodeMeshes) {
      if (!seenNodes.has(id)) {
        this.nodeGroup.remove(e.obj);
        this.nodeMeshes.delete(id);
      }
    }

    const seenDrones = new Set<number>();
    for (const d of state.drones) {
      seenDrones.add(d.id);
      let e = this.droneMeshes.get(d.id);
      if (!e || e.cls !== d.class) {
        if (e) this.droneGroup.remove(e.obj);
        const built = buildDrone(d.id, d.class);
        e = { cls: d.class, ...built };
        this.droneGroup.add(e.obj);
        this.droneMeshes.set(d.id, e);
      }
      e.obj.position.copy(toScene(d.x, d.y, d.alt));
      const droneScale = isSelected(selection, 'drone', d.id) ? SELECTED_SCALE : ICON_SCALE;
      e.obj.scale.setScalar(droneScale);
      const pos = e.tether.geometry.getAttribute('position') as THREE.BufferAttribute;
      // the tether is a child of the scaled group, so undo the scale to keep it reaching the ground
      pos.setY(1, -(d.alt - terrain.height(d.x, d.y)) / droneScale);
      pos.needsUpdate = true;
    }
    for (const [id, e] of this.droneMeshes) {
      if (!seenDrones.has(id)) {
        this.droneGroup.remove(e.obj);
        this.droneMeshes.delete(id);
      }
    }

    this.gateway.position.copy(toScene(state.gateway.x, state.gateway.y, terrain.height(state.gateway.x, state.gateway.y)));
    this.gateway.scale.setScalar(isSelected(selection, 'gateway') ? SELECTED_SCALE : ICON_SCALE);

    this.updateShooters(world, state);
    this.updateShots(world, state, lora, nowS);
    this.updateRings(world, state, selection);
    this.updatePackets(world, state, lora, nowS);
    this.updateDetections(world, state, lora, nowS);
  }

  // Each shooter at its place, with its flash and blast wave for a moment after each shot. A range shows its
  // firing line, targets and berm.
  private updateShooters(world: World, state: WorldState): void {
    const terrain = world.terrain;
    const seen = new Set<number>();
    for (const sh of state.shooters) {
      seen.add(sh.id);
      let e = this.shooterMeshes.get(sh.id);
      if (!e || e.kind !== sh.kind) {
        if (e) {
          this.shooterGroup.remove(e.obj);
          disposeGroup(e.obj);
        }
        const obj = new THREE.Group();
        obj.add(sh.kind === 'range' ? buildRange() : buildShooter());
        const flash = muzzleFlash(sh.kind);
        const wave = blastWave();
        obj.add(flash, wave);
        e = { kind: sh.kind, obj, flash, wave };
        this.shooterGroup.add(obj);
        this.shooterMeshes.set(sh.id, e);
      }
      e.obj.position.copy(toScene(sh.x, sh.y, terrain.height(sh.x, sh.y)));
      const last = lastShotTick(sh, state.tick);
      const age = last === null ? Infinity : (state.tick - last) * TICK_S;
      const flashOn = age < FLASH_S;
      (e.flash.material as THREE.MeshBasicMaterial).opacity = flashOn ? 0.9 : 0;
      e.flash.visible = flashOn;
      const waveAge = Math.min(age, WAVE_S);
      const wave = e.wave.material as THREE.MeshBasicMaterial;
      e.wave.visible = age < WAVE_S;
      e.wave.scale.setScalar(Math.max(1, SOUND_SPEED_MPS * waveAge));
      wave.opacity = age < WAVE_S ? 0.7 * (1 - waveAge / WAVE_S) : 0;
    }
    for (const [id, e] of this.shooterMeshes) {
      if (seen.has(id)) continue;
      this.shooterGroup.remove(e.obj);
      disposeGroup(e.obj);
      this.shooterMeshes.delete(id);
    }
  }

  // A ring on each node that heard a shot, growing for a moment after the shot reached it.
  private updateShots(world: World, state: WorldState, lora: LoraView | null, nowS: number): void {
    disposeGroup(this.shotGroup);
    this.shotGroup.clear();
    if (!lora) return;
    for (const v of lora.nodes) {
      const n = state.nodes.find((node) => node.id === v.id);
      if (!n) continue;
      for (const t of v.shotTimesS) {
        const age = nowS - t;
        if (age < 0 || age > HEARD_S) continue;
        const mat = new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0.8 * (1 - age / HEARD_S), side: THREE.DoubleSide, depthWrite: false, depthTest: false });
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), mat);
        ring.rotation.x = -Math.PI / 2;
        ring.scale.setScalar(4 + (HEARD_RADIUS_M * age) / HEARD_S);
        ring.position.copy(toScene(n.x, n.y, world.terrain.height(n.x, n.y) + 2));
        ring.raycast = () => {};
        this.shotGroup.add(ring);
      }
    }
  }

  // What nodes report: a pulse and pitch on each detecting node, an array's bearing arrow, a band over each bogie, and a
  // soft area where a bogie is estimated to be, with lines from the nodes that place it. Only the Truth view links a node to a drone.
  private updateDetections(world: World, state: WorldState, lora: LoraView | null, nowS = 0): void {
    disposeGroup(this.detectGroup);
    this.detectGroup.clear();
    if (!lora) return;
    const groundAt = (x: number, y: number, lift: number): THREE.Vector3 => toScene(x, y, world.terrain.height(x, y) + lift);
    const flat = (geo: THREE.BufferGeometry, color: number, opacity: number, at: THREE.Vector3): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.copy(at);
      mesh.renderOrder = OVER_TERRAIN;
      mesh.raycast = () => {};
      return mesh;
    };
    const phase = ((nowS % PULSE_PERIOD_S) + PULSE_PERIOD_S) % PULSE_PERIOD_S / PULSE_PERIOD_S;

    for (const b of lora.bogies ?? []) {
      const members = b.nodeIds.map((id) => state.nodes.find((n) => n.id === id)).filter((n) => n !== undefined);
      if (members.length === 0) continue;
      const color = bogieColor(b.letter);
      for (const n of members) this.detectGroup.add(flat(new THREE.CircleGeometry(BOGIE_BAND_M, 32), color, 0.28, groundAt(n.x, n.y, 1)));
      if (members.length > 1) {
        const points = members.flatMap((n) => {
          const p = groundAt(n.x, n.y, 1.5);
          return [p.x, p.y, p.z];
        });
        this.detectGroup.add(new Line2(new LineGeometry().setPositions(points), new LineMaterial({ color, linewidth: BOGIE_LINE_PX, transparent: true, opacity: 0.45 })));
      }
      // Over the estimated area when there is one, else over the nodes that hear it.
      const mid = members[members.length >> 1];
      this.detectGroup.add(this.label(bogieLabel(b), color, b.area ? groundAt(b.area.x, b.area.y, 130) : groundAt(mid.x, mid.y, 130), 1.4));
      if (b.area) {
        const at = groundAt(b.area.x, b.area.y, 2);
        for (const k of [1, 0.5]) {
          const disc = flat(new THREE.CircleGeometry(1, 48), color, 0.22, at);
          disc.scale.set(b.area.majorM * k, b.area.minorM * k, 1);
          disc.rotation.z = b.area.angleRad;
          this.detectGroup.add(disc);
        }
        for (const id of b.area.nodeIds) {
          const n = members.find((o) => o.id === id);
          const edge = n && areaEdge(b.area, n.x, n.y);
          if (!n || !edge) continue;
          const [from, to] = [groundAt(n.x, n.y, 4), groundAt(edge.x, edge.y, 3)];
          const line = new Line2(
            new LineGeometry().setPositions([from.x, from.y, from.z, to.x, to.y, to.z]),
            new LineMaterial({ color, linewidth: AREA_LINE_PX, transparent: true, opacity: 0.8, depthTest: false }),
          );
          line.renderOrder = OVER_TERRAIN;
          this.detectGroup.add(line);
        }
      }
    }

    for (const v of lora.nodes) {
      const node = state.nodes.find((n) => n.id === v.id);
      if (v.detecting && node) {
        const r = NODE_RING_M * (1 + 0.5 * phase);
        this.detectGroup.add(flat(new THREE.RingGeometry(r, r + 6, 40), DETECT_PULSE, 0.9 * (1 - phase), groundAt(node.x, node.y, 2)));
        if (v.pitchHz > 0) this.detectGroup.add(this.label(`${Math.round(v.pitchHz / 10) * 10} Hz`, DETECT_PULSE, groundAt(node.x, node.y, 70), 0.8));
      }
      if (v.bearingDeg !== null && v.bearingDeg !== undefined) {
        const a = this.packetPos(v.id, state, world.terrain);
        const rad = (v.bearingDeg * Math.PI) / 180;
        const dir = toScene(Math.sin(rad), Math.cos(rad), 0).sub(toScene(0, 0, 0)).normalize();
        this.detectGroup.add(new THREE.ArrowHelper(dir, a, BEARING_ARROW_M, BEARING_ARROW, BEARING_ARROW_M * 0.3, BEARING_ARROW_M * 0.18));
      }
      if (!state.truth) continue;
      for (const id of v.targetIds) {
        const d = state.drones.find((o) => o.id === id);
        if (!d) continue;
        const a = this.packetPos(v.id, state, world.terrain);
        const b = toScene(d.x, d.y, d.alt);
        const geo = new LineGeometry().setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
        // A plain WebGL line is always 1 pixel wide. Line2 keeps this width at any distance.
        const line = new Line2(geo, new LineMaterial({ color: DETECT_LINE, linewidth: DETECT_LINE_PX, dashed: true, dashSize: 12, gapSize: 8 }));
        line.computeLineDistances();
        this.detectGroup.add(line);
      }
    }
  }

  // A text label that faces the camera. Textures are kept per text and colour, since these repeat every frame.
  private label(text: string, color: number, at: THREE.Vector3, size: number): THREE.Sprite {
    const key = `${color}:${text}`;
    let texture = this.labelTextures.get(key);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 96;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = 'bold 56px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 10;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.strokeText(text, 256, 48);
        ctx.fillStyle = css(color);
        ctx.fillText(text, 256, 48);
      }
      texture = new THREE.CanvasTexture(canvas);
      this.labelTextures.set(key, texture);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.position.copy(at);
    sprite.scale.set(LABEL_WIDTH_M * size, (LABEL_WIDTH_M * size * 96) / 512, 1);
    sprite.raycast = () => {};
    return sprite;
  }

  // One ground ring per object, always shown; the selected object's ring is larger and yellow.
  private updateRings(world: World, state: WorldState, selection: Selection): void {
    const seen = new Set<string>();
    const place = (key: string, x: number, y: number, color: number, selected: boolean): void => {
      seen.add(key);
      let ring = this.rings.get(key);
      if (!ring) {
        ring = new THREE.Mesh(
          new THREE.RingGeometry(10, 13, 40),
          new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.renderOrder = OVER_TERRAIN;
        ring.raycast = () => {};
        this.ringGroup.add(ring);
        this.rings.set(key, ring);
      }
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.color.setHex(selected ? RING_SELECTED : color);
      mat.opacity = selected ? 0.9 : 0.6;
      ring.scale.setScalar(selected ? SELECTED_SCALE : ICON_SCALE);
      ring.position.copy(toScene(x, y, world.terrain.height(x, y) + 0.5));
    };
    for (const n of state.nodes) place(`n${n.id}`, n.x, n.y, RING_COLOR[n.kind], isSelected(selection, 'node', n.id));
    for (const d of state.drones) place(`d${d.id}`, d.x, d.y, RING_COLOR.drone, isSelected(selection, 'drone', d.id));
    place('gw', state.gateway.x, state.gateway.y, RING_COLOR.gateway, isSelected(selection, 'gateway'));
    for (const [key, ring] of this.rings) {
      if (seen.has(key)) continue;
      this.ringGroup.remove(ring);
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
      this.rings.delete(key);
    }
  }

  private packetPos(id: number, state: WorldState, terrain: Terrain): THREE.Vector3 {
    if (id === 0) return toScene(state.gateway.x, state.gateway.y, terrain.height(state.gateway.x, state.gateway.y) + 8);
    const n = state.nodes.find((o) => o.id === id);
    if (!n) return toScene(state.gateway.x, state.gateway.y, terrain.height(state.gateway.x, state.gateway.y) + 8);
    return toScene(n.x, n.y, terrain.height(n.x, n.y) + 4);
  }

  private updatePackets(world: World, state: WorldState, lora: LoraView | null, nowS: number): void {
    disposeGroup(this.packetGroup);
    this.packetGroup.clear();
    if (!lora) return;
    for (const p of lora.packets) {
      const age = nowS - p.startS;
      if (age < 0 || age > PACKET_SECONDS) continue;
      const from = this.packetPos(p.tx, state, world.terrain);
      const fade = Math.max(0, 1 - age / PACKET_SECONDS);
      for (const rx of p.rx) {
        if (rx.id === p.tx) continue;
        const to = this.packetPos(rx.id, state, world.terrain);
        const lift = Math.max(20, Math.min(150, from.distanceTo(to) * 0.06));
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const v = from.clone().lerp(to, t);
          v.y += Math.sin(Math.PI * t) * lift;
          points.push(v);
        }
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
          color: packetColor(rx.fate),
          transparent: true,
          opacity: 0.15 + 0.8 * fade,
          depthWrite: false,
        });
        this.packetGroup.add(new THREE.Line(geo, mat));
      }
    }
  }

  private resize2d(): void {
    const canvas = this.map;
    if (!canvas) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.mapCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lastMap = { w, h };
  }

  private lastMap = { w: 1, h: 1 };
  private mapGround: { terrain: Terrain; canvas: HTMLCanvasElement } | null = null;

  // Sim metres to map pixels, and back. The map fits the terrain with a margin, north up.
  private mapTransform(terrain: Terrain): { scale: number; sx(x: number): number; sy(y: number): number; inv(p: Point): Point } {
    const { w, h } = this.lastMap;
    const [sw, sh] = terrain.size;
    const m = MAP_MARGIN_PX;
    // A panel squeezed smaller than its margins must not flip the map.
    const scale = Math.max(1e-3, Math.min((w - 2 * m) / sw, (h - 2 * m) / sh));
    return {
      scale,
      sx: (x: number): number => m + (x + sw / 2) * scale,
      sy: (y: number): number => m + (sh / 2 - y) * scale,
      inv: (p: Point): Point => ({ x: (p.x - m) / scale - sw / 2, y: sh / 2 - (p.y - m) / scale }),
    };
  }

  // The ground for the 2D map, kept dark so that the markers stand out. Drawn once per terrain.
  private shadedMap(t: Terrain): HTMLCanvasElement {
    if (this.mapGround?.terrain === t) return this.mapGround.canvas;
    const [w, h] = t.size;
    const canvas = document.createElement('canvas');
    canvas.width = MAP_GROUND_CELLS;
    canvas.height = Math.round((MAP_GROUND_CELLS * h) / w);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const image = ctx.createImageData(canvas.width, canvas.height);
      for (let j = 0; j < canvas.height; j++) {
        for (let i = 0; i < canvas.width; i++) {
          const x = -w / 2 + ((i + 0.5) * w) / canvas.width;
          const y = h / 2 - ((j + 0.5) * h) / canvas.height;
          const k = (j * canvas.width + i) * 4;
          image.data.set(groundColor(t, x, y).map((c) => c * MAP_GROUND_LEVEL * 255), k);
          image.data[k + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    }
    this.mapGround = { terrain: t, canvas };
    return canvas;
  }

  // A bogie's estimated area, with a line from each node that places it to the area's edge.
  private drawArea2d(ctx: CanvasRenderingContext2D, area: BogieArea, color: string, members: { id: number; x: number; y: number }[], sx: (x: number) => number, sy: (y: number) => number, scale: number): void {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    for (const id of area.nodeIds) {
      const n = members.find((o) => o.id === id);
      const edge = n && areaEdge(area, n.x, n.y);
      if (!n || !edge) continue;
      ctx.beginPath();
      ctx.moveTo(sx(n.x), sy(n.y));
      ctx.lineTo(sx(edge.x), sy(edge.y));
      ctx.stroke();
    }
    ctx.beginPath();
    // The canvas y axis runs down, so its angles run the other way.
    ctx.ellipse(sx(area.x), sy(area.y), area.majorM * scale, area.minorM * scale, -area.angleRad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private draw2d(world: World, state: WorldState, selection: Selection, lora: LoraView | null, nowS: number): void {
    const canvas = this.map;
    const ctx = this.mapCtx;
    if (!canvas || !ctx) return;
    const { w, h } = this.lastMap;
    const terrain = world.terrain;
    const [sw, sh] = terrain.size;
    const { sx, sy, scale } = this.mapTransform(terrain);
    const m = MAP_MARGIN_PX;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.shadedMap(terrain), sx(-sw / 2), sy(sh / 2), sw * scale, sh * scale);
    ctx.strokeStyle = '#3b3f44';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx(-sw / 2), sy(terrain.roadY));
    ctx.lineTo(sx(sw / 2), sy(terrain.roadY));
    ctx.stroke();
    // The camp at its real size, which is what it is here to show.
    for (const [size, spots, color] of [[TENT, TENTS, '#6b7530'], [SUV, SUVS, '#c8ccc0']] as const) {
      ctx.fillStyle = color;
      for (const at of spots) ctx.fillRect(sx(at.x) - (size.width_m * scale) / 2, sy(at.y) - (size.length_m * scale) / 2, size.width_m * scale, size.length_m * scale);
    }
    // Shooters, flashing at each shot, and the rings of shots that nodes heard.
    for (const sh of state.shooters) {
      const last = lastShotTick(sh, state.tick);
      const age = last === null ? Infinity : (state.tick - last) * TICK_S;
      ctx.fillStyle = age < FLASH_S ? '#ffd166' : '#d9a441';
      ctx.fillRect(sx(sh.x) - 4, sy(sh.y) - 4, 8, 8);
    }
    for (const v of lora?.nodes ?? []) {
      const n = state.nodes.find((node) => node.id === v.id);
      if (!n) continue;
      for (const t of v.shotTimesS) {
        const age = nowS - t;
        if (age < 0 || age > HEARD_S) continue;
        ctx.strokeStyle = `rgba(255, 77, 109, ${0.8 * (1 - age / HEARD_S)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx(n.x), sy(n.y), 6 + (HEARD_RADIUS_M * age) / HEARD_S / scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (lora) {
      for (const p of lora.packets) {
        const age = nowS - p.startS;
        if (age < 0 || age > PACKET_SECONDS) continue;
        const tx = p.tx === 0 ? state.gateway : state.nodes.find((n) => n.id === p.tx);
        if (!tx) continue;
        ctx.globalAlpha = Math.max(0.1, 1 - age / PACKET_SECONDS);
        for (const rx of p.rx) {
          const to = rx.id === 0 ? state.gateway : state.nodes.find((n) => n.id === rx.id);
          if (!to) continue;
          ctx.strokeStyle = fateCss(rx.fate);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx(tx.x), sy(tx.y));
          ctx.lineTo(sx(to.x), sy(to.y));
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // Bogies go under the markers: a band over their nodes, and a soft area where they are estimated to be.
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const b of lora.bogies) {
        const members = b.nodeIds.map((id) => state.nodes.find((o) => o.id === id)).filter((o) => o !== undefined);
        if (members.length === 0) continue;
        ctx.strokeStyle = css(bogieColor(b.letter));
        ctx.globalAlpha = 0.32;
        ctx.lineWidth = 12 * ICON_SCALE * 2;
        ctx.beginPath();
        ctx.moveTo(sx(members[0].x), sy(members[0].y));
        // A single point still needs a segment for the round cap to draw.
        for (const o of members.length > 1 ? members.slice(1) : members) ctx.lineTo(sx(o.x) + (members.length > 1 ? 0 : 0.01), sy(o.y));
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (b.area) this.drawArea2d(ctx, b.area, css(bogieColor(b.letter)), members, sx, sy, scale);
      }
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';

      if (state.truth) {
        ctx.strokeStyle = css(DETECT_LINE);
        ctx.lineWidth = DETECT_LINE_PX - 2;
        ctx.setLineDash([10, 8]);
        for (const v of lora.nodes) {
          const n = state.nodes.find((o) => o.id === v.id);
          for (const id of v.targetIds) {
            const d = state.drones.find((o) => o.id === id);
            if (!n || !d) continue;
            ctx.beginPath();
            ctx.moveTo(sx(n.x), sy(n.y));
            ctx.lineTo(sx(d.x), sy(d.y));
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
      }
    }

    // Every marker is ICON_SCALE x its old size with a ring around it; the selected one is SELECTED_SCALE x.
    const ring = (x: number, y: number, r: number, color: string, selected: boolean): void => {
      ctx.strokeStyle = selected ? '#ffe066' : color;
      ctx.globalAlpha = selected ? 0.95 : 0.6;
      ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    for (const n of state.nodes) {
      const view = lora?.nodes.find((v) => v.id === n.id);
      const k = isSelected(selection, 'node', n.id) ? SELECTED_SCALE : ICON_SCALE;
      const color = n.kind === 'array' ? '#ff9f43' : '#4aa3ff';
      const [x, y] = [sx(n.x), sy(n.y)];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, (view?.detecting ? 7 : 5) * k, 0, Math.PI * 2);
      ctx.fill();
      ring(x, y, 10 * k, view?.detecting ? '#ff4d6d' : color, k === SELECTED_SCALE);
    }
    {
      const k = isSelected(selection, 'gateway') ? SELECTED_SCALE : ICON_SCALE;
      const [x, y] = [sx(state.gateway.x), sy(state.gateway.y)];
      ctx.fillStyle = '#3ddc84';
      ctx.fillRect(x - 6 * k, y - 6 * k, 12 * k, 12 * k);
      ring(x, y, 11 * k, '#3ddc84', k === SELECTED_SCALE);
    }
    for (const d of state.drones) {
      const k = isSelected(selection, 'drone', d.id) ? SELECTED_SCALE : ICON_SCALE;
      const [x, y] = [sx(d.x), sy(d.y)];
      ctx.fillStyle = '#ff4d6d';
      ctx.beginPath();
      ctx.moveTo(x, y - 7 * k);
      ctx.lineTo(x - 5 * k, y + 5 * k);
      ctx.lineTo(x + 5 * k, y + 5 * k);
      ctx.closePath();
      ctx.fill();
      ring(x, y, 10 * k, '#ff4d6d', k === SELECTED_SCALE);
    }

    // A pulse on each detecting node, then its pitch if that fits. Neighbours are close on this map, and the bogie's name
    // already gives the pitch, so a label that would overlap another is left out.
    const phase = ((nowS % PULSE_PERIOD_S) + PULSE_PERIOD_S) % PULSE_PERIOD_S / PULSE_PERIOD_S;
    ctx.textAlign = 'center';
    const text = (label: string, x: number, y: number, color: string, px: number): void => {
      ctx.font = `bold ${px}px sans-serif`;
      // Kept on the map, since a narrow screen has a node at each edge.
      const half = ctx.measureText(label).width / 2 + 4;
      const cx = half * 2 < w ? Math.min(Math.max(x, half), w - half) : x;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.strokeText(label, cx, y);
      ctx.fillStyle = color;
      ctx.fillText(label, cx, y);
    };
    const placed: [number, number][] = [];
    for (const n of state.nodes) {
      const view = lora?.nodes.find((v) => v.id === n.id);
      if (!view?.detecting) continue;
      const k = isSelected(selection, 'node', n.id) ? SELECTED_SCALE : ICON_SCALE;
      const [x, y] = [sx(n.x), sy(n.y)];
      ctx.strokeStyle = css(DETECT_PULSE);
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.9 * (1 - phase);
      ctx.beginPath();
      ctx.arc(x, y, 10 * k * (1 + 0.5 * phase), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (view.pitchHz <= 0) continue;
      const row = [y + 10 * k + 22, y + 10 * k + 44].find((ty) => !placed.some(([px, py]) => py === ty && Math.abs(px - x) < PITCH_LABEL_PX));
      if (row === undefined) continue;
      placed.push([x, row]);
      text(`${Math.round(view.pitchHz)} Hz`, x, row, css(DETECT_PULSE), 18);
    }
    // Each bogie's name over its estimated area, or without one below its band and the pitch rows, stacked so overlapping
    // bands stay readable.
    (lora?.bogies ?? []).forEach((b, i) => {
      const members = b.nodeIds.map((id) => state.nodes.find((o) => o.id === id)).filter((o) => o !== undefined);
      if (members.length === 0) return;
      const mid = members[members.length >> 1];
      if (b.area) text(bogieLabel(b), sx(b.area.x), sy(b.area.y) - (b.area.minorM * scale) / 2, css(bogieColor(b.letter)), 22);
      else text(bogieLabel(b), sx(mid.x), sy(mid.y) + 10 * ICON_SCALE + 72 + i * 26, css(bogieColor(b.letter)), 22);
    });
    ctx.textAlign = 'start';

    // Array nodes' bearings, on top of every marker. An arrow shows direction only, so its length is fixed on screen.
    for (const n of state.nodes) {
      const view = lora?.nodes.find((v) => v.id === n.id);
      if (!view || view.bearingDeg === null) continue;
      const k = isSelected(selection, 'node', n.id) ? SELECTED_SCALE : ICON_SCALE;
      const [x, y] = [sx(n.x), sy(n.y)];
      const rad = (view.bearingDeg * Math.PI) / 180;
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);
      const r0 = 10 * k + 2;
      const [x1, y1] = [x + dx * (r0 + BEARING_ARROW_PX), y + dy * (r0 + BEARING_ARROW_PX)];
      const head = BEARING_ARROW_PX * 0.4;
      const angle = Math.atan2(dy, dx);
      ctx.strokeStyle = `#${BEARING_ARROW.toString(16)}`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x + dx * r0, y + dy * r0);
      ctx.lineTo(x1, y1);
      ctx.moveTo(x1 - head * Math.cos(angle - 0.5), y1 - head * Math.sin(angle - 0.5));
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(angle + 0.5), y1 - head * Math.sin(angle + 0.5));
      ctx.stroke();
    }
    ctx.fillStyle = '#dfe6ee';
    ctx.font = '12px system-ui, sans-serif';
    const mode = lora ? `LoRa ${lora.mode} mode, superframe ${lora.superframe}` : 'LoRa starting';
    ctx.fillText(mode, m, h - 10);
    ctx.fillStyle = '#8a98a8';
    const legend = 'lines: green decoded, amber collision, red range, purple half-duplex';
    const truthLegend = 'dashed grey in Truth: the nearest drone whose pitch fits';
    if (ctx.measureText(`${legend}, ${truthLegend}`).width <= w - 2 * m) {
      ctx.fillText(`${legend}, ${truthLegend}`, m, h - 26);
    } else {
      ctx.fillText(truthLegend, m, h - 26);
      ctx.fillText(legend, m, h - 42);
    }
  }

  // Where an object sits in sim coordinates, or null if it is gone.
  private anchorOf(selection: Selection): { x: number; y: number; h: number } | null {
    const snap = this.snap;
    if (!snap || !selection) return null;
    const { state, world, lora } = snap;
    const terrain = world.terrain;
    const onGround = (x: number, y: number, lift: number): { x: number; y: number; h: number } => ({
      x,
      y,
      h: terrain.height(x, y) + lift,
    });
    switch (selection.kind) {
      case 'node': {
        const n = state.nodes.find((o) => o.id === selection.id);
        return n ? onGround(n.x, n.y, ANCHOR_LIFT_M.node) : null;
      }
      case 'drone': {
        const d = state.drones.find((o) => o.id === selection.id);
        return d ? { x: d.x, y: d.y, h: d.alt } : null;
      }
      case 'gateway':
        return onGround(state.gateway.x, state.gateway.y, ANCHOR_LIFT_M.gateway);
      case 'packet': {
        // A packet belongs to its transmitter.
        const p = lora?.packets.find((o) => o.id === selection.id);
        if (!p) return null;
        if (p.tx === 0) return onGround(state.gateway.x, state.gateway.y, ANCHOR_LIFT_M.packet);
        const n = state.nodes.find((o) => o.id === p.tx);
        return n ? onGround(n.x, n.y, ANCHOR_LIFT_M.packet) : null;
      }
      default:
        return null;
    }
  }

  // The object's position in view pixels, for the pop-up window and its tail. Null if the object is gone or there is
  // no frame yet. Off screen or behind the camera, the point lies outside the view in the direction of the object.
  screenPos(selection: Selection): ScreenPos | null {
    const a = this.anchorOf(selection);
    if (!a) return null;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const terrain = this.snap?.world.terrain;
    if (!terrain) return null;
    if (!this.renderer) {
      const { sx, sy } = this.mapTransform(terrain);
      const x = sx(a.x);
      const y = sy(a.y);
      return { x, y, visible: x >= 0 && x <= w && y >= 0 && y <= h };
    }
    this.camera.updateMatrixWorld();
    const v = toScene(a.x, a.y, a.h);
    const behind = v.clone().applyMatrix4(this.camera.matrixWorldInverse).z > 0;
    const ndc = v.project(this.camera);
    // A point behind the camera projects to the mirror image of its direction, so flip it and push it far out.
    const nx = behind ? -ndc.x * 1e3 : ndc.x;
    const ny = behind ? -ndc.y * 1e3 : ndc.y;
    const x = ((nx + 1) / 2) * w;
    const y = ((1 - ny) / 2) * h;
    return { x, y, visible: !behind && x >= 0 && x <= w && y >= 0 && y <= h };
  }

  // Returns what is under the pointer, or the ground point if nothing else is. With slopPx, a marker that close to the
  // pointer wins over the ground, since a finger cannot land exactly on one.
  pick(clientX: number, clientY: number, slopPx = 0): Hit | null {
    const hit = this.pickExact(clientX, clientY);
    if (slopPx <= 0 || (hit && hit.target.kind !== 'terrain')) return hit;
    return this.markerNear(clientX, clientY, slopPx) ?? hit;
  }

  private markerNear(clientX: number, clientY: number, slopPx: number): Hit | null {
    const snap = this.snap;
    if (!snap) return null;
    const rect = this.container.getBoundingClientRect();
    let best: Hit | null = null;
    let bestD = slopPx;
    const consider = (selection: Selection, target: Target, x: number, y: number): void => {
      const p = this.screenPos(selection);
      if (!p?.visible) return;
      const d = Math.hypot(p.x - (clientX - rect.left), p.y - (clientY - rect.top));
      if (d > bestD) return;
      bestD = d;
      best = { target, x, y };
    };
    for (const n of snap.state.nodes) consider({ kind: 'node', id: n.id }, { kind: 'node', id: n.id }, n.x, n.y);
    consider({ kind: 'gateway' }, { kind: 'gateway' }, snap.state.gateway.x, snap.state.gateway.y);
    for (const d of snap.state.drones) consider({ kind: 'drone', id: d.id }, { kind: 'drone', id: d.id }, d.x, d.y);
    return best;
  }

  private pickExact(clientX: number, clientY: number): Hit | null {
    const renderer = this.renderer;
    if (!renderer) return this.pick2d(clientX, clientY);
    this.setPointer(renderer.domElement, clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const roots: THREE.Object3D[] = [this.nodeGroup, this.droneGroup, this.gateway];
    if (this.terrainMesh) roots.push(this.terrainMesh);
    for (const hit of this.raycaster.intersectObjects(roots, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const target = o.userData.target as Target | undefined;
        if (target) return { target, x: hit.point.x, y: -hit.point.z };
        o = o.parent;
      }
    }
    return null;
  }

  // 2D map picking: the nearest marker within PICK_PX, else the ground point if it is on the terrain.
  private pick2d(clientX: number, clientY: number): Hit | null {
    const canvas = this.map;
    const snap = this.snap;
    if (!canvas || !snap) return null;
    const rect = canvas.getBoundingClientRect();
    const p = { x: clientX - rect.left, y: clientY - rect.top };
    const { state, world } = snap;
    const { sx, sy, inv } = this.mapTransform(world.terrain);
    const near: { d: number; hit: Hit }[] = [];
    const consider = (target: Target, x: number, y: number): void => {
      const d = Math.hypot(sx(x) - p.x, sy(y) - p.y);
      if (d <= PICK_PX) near.push({ d, hit: { target, x, y } });
    };
    for (const n of state.nodes) consider({ kind: 'node', id: n.id }, n.x, n.y);
    consider({ kind: 'gateway' }, state.gateway.x, state.gateway.y);
    for (const d of state.drones) consider({ kind: 'drone', id: d.id }, d.x, d.y);
    if (near.length > 0) return near.reduce((a, b) => (b.d < a.d ? b : a)).hit;
    const g = inv(p);
    const [sw, sh] = world.terrain.size;
    if (Math.abs(g.x) > sw / 2 || Math.abs(g.y) > sh / 2) return null;
    return { target: { kind: 'terrain' }, x: g.x, y: g.y };
  }

  // The ground point under the pointer, for dragging.
  groundAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const renderer = this.renderer;
    if (!renderer) {
      const canvas = this.map;
      const snap = this.snap;
      if (!canvas || !snap) return null;
      const rect = canvas.getBoundingClientRect();
      const g = this.mapTransform(snap.world.terrain).inv({ x: clientX - rect.left, y: clientY - rect.top });
      const [sw, sh] = snap.world.terrain.size;
      return Math.abs(g.x) > sw / 2 || Math.abs(g.y) > sh / 2 ? null : g;
    }
    if (!this.terrainMesh) return null;
    this.setPointer(renderer.domElement, clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    return hit ? { x: hit.point.x, y: -hit.point.z } : null;
  }

  setOrbitEnabled(on: boolean): void {
    if (this.controls) this.controls.enabled = on;
  }

  private setPointer(canvas: HTMLCanvasElement, clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  private resize(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
