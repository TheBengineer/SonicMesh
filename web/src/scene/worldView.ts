import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LoraView } from '../lora/types';
import type { Selection } from '../selection';
import type { NodeKind } from '../sim/scenario';
import { placeTrees, type Terrain } from '../sim/terrain';
import { DRONE_CLASSES, type World, type WorldState } from '../sim/world';
import type { DroneClass } from '../sim/scenario';

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

// Marker sizes: every object is drawn 3x and always has a ring; the selected one is 10x.
const ICON_SCALE = 3;
const SELECTED_SCALE = 10;
const RING_SELECTED = 0xffe066;
const RING_COLOR = { detector: 0x4aa3ff, array: 0xff9f43, gateway: 0x3ddc84, drone: 0xff4d6d } as const;

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

const FOLLOW_OFFSET = new THREE.Vector3(0, 120, 300);
const FLIGHT_MS = 1500;
export type Target = { kind: 'node' | 'drone'; id: number } | { kind: 'gateway' } | { kind: 'terrain' };
export interface Hit {
  target: Target;
  x: number;
  y: number;
}

const SKY = 0xaed0e0;

// Sim (x east, y north, h up) to three.js (y up, north is -z).
export function toScene(x: number, y: number, h: number): THREE.Vector3 {
  return new THREE.Vector3(x, h, -y);
}

function buildTerrain(t: Terrain): THREE.Mesh {
  const [w, h] = t.size;
  const nx = 100;
  const ny = 40;
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
      const f = t.amplitude > 0 ? ground / t.amplitude : 0;
      col[k] = 0.24 + 0.18 * f;
      col[k + 1] = 0.38 + 0.12 * f;
      col[k + 2] = 0.2 + 0.08 * f;
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
  const nx = 100;
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
    this.scene.add(this.staticGroup, this.nodeGroup, this.droneGroup, this.packetGroup, this.gateway);
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
    this.staticGroup.add(this.terrainMesh, buildRoad(world.terrain), buildTrees(world.terrain));
    this.nodeGroup.clear();
    this.nodeMeshes.clear();
    this.droneGroup.clear();
    this.droneMeshes.clear();
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
    if (view === 'top') {
      controls.target.set(0, 0, 0);
      this.camera.position.set(0, 4200, 1);
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
      this.camera.position.set(-1400, 1100, 1900);
    }
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

    this.updateRings(world, state, selection);
    this.updatePackets(world, state, lora, nowS);
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
          new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true }),
        );
        ring.rotation.x = -Math.PI / 2;
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

  private draw2d(world: World, state: WorldState, selection: Selection, lora: LoraView | null, nowS: number): void {
    const canvas = this.map;
    const ctx = this.mapCtx;
    if (!canvas || !ctx) return;
    const { w, h } = this.lastMap;
    const terrain = world.terrain;
    const [sw, sh] = terrain.size;
    const m = 16;
    const scale = Math.min((w - 2 * m) / sw, (h - 2 * m) / sh);
    const sx = (x: number): number => m + (x + sw / 2) * scale;
    const sy = (y: number): number => m + (sh / 2 - y) * scale;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#16221a';
    ctx.fillRect(sx(-sw / 2), sy(sh / 2), sw * scale, sh * scale);
    ctx.strokeStyle = '#3b3f44';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx(-sw / 2), sy(terrain.roadY));
    ctx.lineTo(sx(sw / 2), sy(terrain.roadY));
    ctx.stroke();

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
    ctx.fillStyle = '#dfe6ee';
    ctx.font = '12px system-ui, sans-serif';
    const mode = lora ? `LoRa ${lora.mode} mode, superframe ${lora.superframe}` : 'LoRa starting';
    ctx.fillText(mode, m, h - 10);
    ctx.fillStyle = '#8a98a8';
    ctx.fillText('lines: green decoded, amber collision, red range, purple half-duplex', m, h - 26);
  }

  // Returns what is under the pointer, or the ground point if nothing else is.
  pick(clientX: number, clientY: number): Hit | null {
    const renderer = this.renderer;
    if (!renderer) return null;
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

  // The ground point under the pointer, for dragging.
  groundAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const renderer = this.renderer;
    if (!renderer || !this.terrainMesh) return null;
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
