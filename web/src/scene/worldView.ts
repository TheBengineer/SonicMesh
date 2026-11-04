import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Selection } from '../selection';
import type { NodeKind } from '../sim/scenario';
import { placeTrees, type Terrain } from '../sim/terrain';
import { DRONE_CLASSES, type World, type WorldState } from '../sim/world';
import type { DroneClass } from '../sim/scenario';

export type ViewMode = 'orbit' | 'follow' | 'top';
export type Target = { kind: 'node' | 'drone'; id: number } | { kind: 'gateway' } | { kind: 'terrain' };
export interface Hit {
  target: Target;
  x: number;
  y: number;
}

const RADAR_RANGE_M = 1500;
const RADAR_FLOOR_DEG = 3;
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

// Radar stub: dome plus a floor disc at the low-elevation cut-off.
function buildRadar(): THREE.Group {
  const g = new THREE.Group();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(RADAR_RANGE_M, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x5fd4ff, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false }),
  );
  const rad = (RADAR_FLOOR_DEG * Math.PI) / 180;
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(RADAR_RANGE_M * Math.cos(rad), 64),
    new THREE.MeshBasicMaterial({ color: 0xe0605a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = RADAR_RANGE_M * Math.sin(rad);
  g.add(dome, floor);
  return g;
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
  private readonly gateway = buildGateway();
  private readonly radar = buildRadar();
  private readonly ring: THREE.Mesh;
  private readonly nodeMeshes = new Map<number, { kind: NodeKind; obj: THREE.Group }>();
  private readonly droneMeshes = new Map<number, { cls: DroneClass; obj: THREE.Group; tether: THREE.Line }>();
  private terrain: Terrain | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  private view: ViewMode = 'orbit';
  private followId: number | null = null;

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
    this.scene.add(this.staticGroup, this.nodeGroup, this.droneGroup, this.gateway, this.radar);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(10, 13, 40),
      new THREE.MeshBasicMaterial({ color: 0xffe066, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);
    if (!renderer || !controls) {
      const note = document.createElement('div');
      note.className = 'no-webgl';
      note.textContent = '3D view needs WebGL; the simulation, inspector and timeline still work';
      container.appendChild(note);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    controls.enableDamping = true;
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

  setView(view: ViewMode, followId: number | null): void {
    const controls = this.controls;
    if (!controls) return;
    this.view = view;
    this.followId = followId;
    controls.enableRotate = view !== 'top';
    if (view === 'top') {
      controls.target.set(0, 0, 0);
      this.camera.position.set(0, 4200, 1);
    } else if (view === 'follow') {
      const m = followId === null ? undefined : this.droneMeshes.get(followId);
      if (m) {
        controls.target.copy(m.obj.position);
        this.camera.position.copy(m.obj.position).add(new THREE.Vector3(0, 120, 300));
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
      if (m) {
        const delta = m.obj.position.clone().sub(controls.target);
        controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    controls.update();
    renderer.render(this.scene, this.camera);
  }

  // Makes three.js objects match world state. Rendering only reads state.
  sync(world: World, state: WorldState, selection: Selection): void {
    if (!this.renderer) return;
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
      const pos = e.tether.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setY(1, -(d.alt - terrain.height(d.x, d.y)));
      pos.needsUpdate = true;
    }
    for (const [id, e] of this.droneMeshes) {
      if (!seenDrones.has(id)) {
        this.droneGroup.remove(e.obj);
        this.droneMeshes.delete(id);
      }
    }

    this.gateway.position.copy(toScene(state.gateway.x, state.gateway.y, terrain.height(state.gateway.x, state.gateway.y)));
    this.radar.position.copy(this.gateway.position);

    this.updateRing(world, state, selection);
  }

  private updateRing(world: World, state: WorldState, selection: Selection): void {
    let x: number | null = null;
    let y: number | null = null;
    if (selection?.kind === 'node') {
      const n = state.nodes.find((o) => o.id === selection.id);
      if (n) [x, y] = [n.x, n.y];
    } else if (selection?.kind === 'drone') {
      const d = state.drones.find((o) => o.id === selection.id);
      if (d) [x, y] = [d.x, d.y];
    } else if (selection?.kind === 'gateway' || selection?.kind === 'radar') {
      [x, y] = [state.gateway.x, state.gateway.y];
    }
    this.ring.visible = x !== null && y !== null;
    if (x !== null && y !== null) {
      this.ring.position.copy(toScene(x, y, world.terrain.height(x, y) + 0.5));
    }
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
