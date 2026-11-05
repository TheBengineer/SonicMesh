import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WorldView, toScene } from '../src/scene/worldView';

const terrain = { height: () => 10 };
const state = {
  gateway: { x: 0, y: -250 },
  nodes: [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 350, y: 0 },
  ],
  drones: [{ id: 5, x: 100, y: 40, alt: 60 }],
};

// The renderer needs WebGL, so this runs the drawing step alone on a real scene group.
function linesFor(nodes: { id: number; targetId: number | null }[]): THREE.Line[] {
  const proto = WorldView.prototype as unknown as Record<string, (...a: unknown[]) => void>;
  const self = { detectGroup: new THREE.Group(), packetPos: proto.packetPos };
  proto.updateDetections.call(self, { terrain }, state, { nodes });
  return self.detectGroup.children as THREE.Line[];
}

describe('detection lines in the 3D view', () => {
  it('run from the detecting node to the drone, in the accent blue', () => {
    const lines = linesFor([
      { id: 1, targetId: 5 },
      { id: 2, targetId: null },
    ]);
    expect(lines).toHaveLength(1);
    const pos = lines[0].geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(new THREE.Vector3().fromBufferAttribute(pos, 0).distanceTo(toScene(0, 0, 14))).toBeLessThan(1e-3);
    expect(new THREE.Vector3().fromBufferAttribute(pos, 1).distanceTo(toScene(100, 40, 60))).toBeLessThan(1e-3);
    expect((lines[0].material as THREE.LineBasicMaterial).color.getHex()).toBe(0x5fb4ff);
  });

  it('are gone when the drone is gone', () => {
    expect(linesFor([{ id: 1, targetId: 9 }])).toHaveLength(0);
  });
});
