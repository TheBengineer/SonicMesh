import * as THREE from 'three';
import type { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { describe, expect, it } from 'vitest';
import { cameraStick } from '../src/input/sticks';
import { WorldView, toScene } from '../src/scene/worldView';

const terrain = { height: () => 10 };
const state = {
  gateway: { x: 0, y: -90 },
  nodes: [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 120, y: 0 },
  ],
  drones: [{ id: 5, x: 100, y: 40, alt: 60 }],
};

// The renderer needs WebGL, so this runs the drawing step alone on a real scene group.
function linesFor(nodes: { id: number; targetId: number | null }[]): Line2[] {
  const proto = WorldView.prototype as unknown as Record<string, (...a: unknown[]) => void>;
  const self = { detectGroup: new THREE.Group(), packetPos: proto.packetPos };
  proto.updateDetections.call(self, { terrain }, state, { nodes });
  return self.detectGroup.children as Line2[];
}

describe('detection lines in the 3D view', () => {
  it('run from the detecting node to the drone, thick and in the accent blue', () => {
    const lines = linesFor([
      { id: 1, targetId: 5 },
      { id: 2, targetId: null },
    ]);
    expect(lines).toHaveLength(1);
    const geo = lines[0].geometry;
    const start = geo.getAttribute('instanceStart') as unknown as THREE.BufferAttribute;
    const end = geo.getAttribute('instanceEnd') as unknown as THREE.BufferAttribute;
    expect(new THREE.Vector3().fromBufferAttribute(start, 0).distanceTo(toScene(0, 0, 14))).toBeLessThan(1e-3);
    expect(new THREE.Vector3().fromBufferAttribute(end, 0).distanceTo(toScene(100, 40, 60))).toBeLessThan(1e-3);
    const mat = lines[0].material as LineMaterial;
    expect(mat.color.getHex()).toBe(0x5fb4ff);
    expect(mat.linewidth).toBeGreaterThan(1);
  });

  it('are gone when the drone is gone', () => {
    expect(linesFor([{ id: 1, targetId: 9 }])).toHaveLength(0);
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
