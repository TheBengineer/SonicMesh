import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { describe, expect, it } from 'vitest';
import { cameraStick } from '../src/input/sticks';
import { WorldView, toScene } from '../src/scene/worldView';

const terrain = { height: () => 10 };
const truthOn = {
  truth: true,
  gateway: { x: 0, y: -90 },
  nodes: [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 120, y: 0 },
  ],
  drones: [{ id: 5, x: 100, y: 40, alt: 60 }],
};

// The renderer needs WebGL, so this runs the drawing step alone on a real scene group.
function linesFor(nodes: { id: number; targetIds: number[]; bearingDeg?: number | null }[], world: typeof truthOn = truthOn): Line2[] {
  const proto = WorldView.prototype as unknown as Record<string, (...a: unknown[]) => void>;
  const self = { detectGroup: new THREE.Group(), packetPos: proto.packetPos };
  proto.updateDetections.call(self, { terrain }, world, { nodes });
  return self.detectGroup.children as Line2[];
}

describe('detection lines in the 3D view', () => {
  it('show a pulse, a bogie band, an estimated area and its lines without any Truth line', () => {
    const proto = WorldView.prototype as unknown as Record<string, (...a: unknown[]) => void>;
    const self = { detectGroup: new THREE.Group(), packetPos: proto.packetPos, label: () => new THREE.Sprite() };
    const node = (id: number) => ({ id, detecting: true, pitchHz: 600, targetIds: [5], bearingDeg: null });
    const bogie = { letter: 'A', pitchHz: 600, nodeIds: [1, 2], area: { x: 60, y: 200, majorM: 80, minorM: 40, angleRad: 0, nodeIds: [1, 2] } };
    proto.updateDetections.call(self, { terrain }, { ...truthOn, truth: false }, { nodes: [node(1), node(2)], bogies: [bogie] });
    const kids = self.detectGroup.children;
    // Two discs, one band and a label for the bogie, two discs and a line per node for the area, and a pulse and label per
    // node.
    expect(kids.filter((k) => k instanceof Line2)).toHaveLength(3);
    expect(kids.filter((k) => k instanceof THREE.Sprite)).toHaveLength(3);
    expect(kids.filter((k) => k instanceof THREE.Mesh && !(k instanceof Line2))).toHaveLength(6);
    expect((kids.find((k) => k instanceof Line2) as Line2).material.dashed).toBe(false);
  });

  it('hover a bogie name over its estimated area, or over its nodes without one', () => {
    const proto = WorldView.prototype as unknown as Record<string, (...a: unknown[]) => void>;
    const at: THREE.Vector3[] = [];
    const self = { detectGroup: new THREE.Group(), packetPos: proto.packetPos, label: (_t: string, _c: number, p: THREE.Vector3) => (at.push(p), new THREE.Sprite()) };
    const area = { x: 60, y: 200, majorM: 80, minorM: 40, angleRad: 0, nodeIds: [] };
    proto.updateDetections.call(self, { terrain }, { ...truthOn, truth: false }, { nodes: [], bogies: [{ letter: 'A', pitchHz: 600, nodeIds: [1], area }] });
    proto.updateDetections.call(self, { terrain }, { ...truthOn, truth: false }, { nodes: [], bogies: [{ letter: 'A', pitchHz: 600, nodeIds: [1], area: null }] });
    expect(at[0].x).toBe(60);
    expect(at[0].z).toBe(-200);
    expect(at[1].x).toBe(0);
  });

  it('are hidden with Truth off', () => {
    expect(linesFor([{ id: 1, targetIds: [5] }], { ...truthOn, truth: false })).toHaveLength(0);
  });

  it('add a bearing arrow only for a node that reports one', () => {
    expect(linesFor([{ id: 1, targetIds: [], bearingDeg: null }])).toHaveLength(0);
    const [arrow] = linesFor([{ id: 1, targetIds: [], bearingDeg: 90 }]) as unknown as THREE.ArrowHelper[];
    expect(arrow).toBeInstanceOf(THREE.ArrowHelper);
    // 90 degrees is along +x on the ground.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(arrow.quaternion);
    const east = toScene(1, 0, 0).sub(toScene(0, 0, 0)).normalize();
    expect(up.dot(east)).toBeCloseTo(1, 6);
  });

  it('run from the detecting node to the drone, dashed, in the Truth view', () => {
    const lines = linesFor([
      { id: 1, targetIds: [5] },
      { id: 2, targetIds: [] },
    ]);
    expect(lines).toHaveLength(1);
    const geo = lines[0].geometry;
    const start = geo.getAttribute('instanceStart') as unknown as THREE.BufferAttribute;
    const end = geo.getAttribute('instanceEnd') as unknown as THREE.BufferAttribute;
    expect(new THREE.Vector3().fromBufferAttribute(start, 0).distanceTo(toScene(0, 0, 14))).toBeLessThan(1e-3);
    expect(new THREE.Vector3().fromBufferAttribute(end, 0).distanceTo(toScene(100, 40, 60))).toBeLessThan(1e-3);
    const mat = lines[0].material as LineMaterial;
    expect(mat.dashed).toBe(true);
    expect(mat.linewidth).toBeGreaterThan(1);
  });

  it('go to every drone a node detects', () => {
    const two = { ...truthOn, drones: [...truthOn.drones, { id: 6, x: -50, y: 20, alt: 40 }] };
    expect(linesFor([{ id: 1, targetIds: [5, 6] }], two)).toHaveLength(2);
  });

  it('are gone when the drone is gone', () => {
    expect(linesFor([{ id: 1, targetIds: [9] }])).toHaveLength(0);
  });
});

describe('manual flying follows the camera', () => {
  const forward = { x: 0, y: 1, z: 0 };
  const right = { x: 1, y: 0, z: 0 };

  it('facing north, the stick is unchanged', () => {
    expect(cameraStick(forward, { x: 0, y: 1 })).toEqual({ x: 0, y: 1, z: 0 });
    expect(cameraStick(right, { x: 0, y: 1 })).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('facing east, forward flies east and right flies south', () => {
    const h = { x: 1, y: 0 };
    expect(cameraStick(forward, h)).toEqual({ x: 1, y: 0, z: 0 });
    expect(cameraStick(right, h)).toEqual({ x: 0, y: -1, z: 0 });
  });

  it('facing south, forward flies south and up stays up', () => {
    expect(cameraStick({ x: 0, y: 1, z: 0.5 }, { x: 0, y: -1 })).toEqual({ x: 0, y: -1, z: 0.5 });
  });
});
