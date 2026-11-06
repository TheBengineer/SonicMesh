import { describe, expect, it } from 'vitest';
import { ARRAY_OFFSETS } from '../src/acoustics/engine';
import { ARRAY_HALF_M, FS, SOUND_SPEED_MPS } from '../src/acoustics/model';
import { NodeStub, TARGET_HOLD_S, pitchFits, type CombReading } from '../src/lora/nodeStub';

const OFFSETS = ARRAY_OFFSETS.map(([a, b]) => [a * ARRAY_HALF_M, b * ARRAY_HALF_M] as const);

const ON: CombReading = { on: true, tracking: true, f0Hz: 250, peak: 0.3 };
const OFF: CombReading = { on: false, tracking: false, f0Hz: 0, peak: 0 };

function feed(stub: NodeStub, t: number, comb: CombReading, heardId: number | null = null): void {
  stub.update(t, { bandDb: 90, ambientDb: 40, comb, heardId });
}

describe('node detection', () => {
  it('ignores loudness: only the detector turns it on', () => {
    const stub = new NodeStub(1, 'detector', 1);
    for (let t = 0; t < 5; t += 0.01) stub.update(t, { bandDb: 110, ambientDb: 40 });
    expect(stub.detecting).toBe(false);
    feed(stub, 5, ON);
    expect(stub.detecting).toBe(true);
    expect(stub.detections).toBe(1);
    feed(stub, 6, OFF);
    expect(stub.detecting).toBe(false);
  });

  it('names no drone until the pitch fits one', () => {
    const stub = new NodeStub(1, 'detector', 1);
    feed(stub, 1, ON);
    expect(stub.detecting).toBe(true);
    expect(stub.targetId).toBeNull();
    feed(stub, 1.1, ON, 4);
    expect(stub.targetId).toBe(4);
  });

  it('keeps the drone through a short dropout, then lets go', () => {
    const stub = new NodeStub(1, 'detector', 1);
    feed(stub, 1, ON, 4);
    feed(stub, 1 + TARGET_HOLD_S - 0.1, ON);
    expect(stub.targetId).toBe(4);
    feed(stub, 1 + TARGET_HOLD_S + 0.1, ON);
    expect(stub.targetId).toBeNull();
  });

  it('lets go as soon as the detection ends', () => {
    const stub = new NodeStub(1, 'detector', 1);
    feed(stub, 1, ON, 4);
    feed(stub, 1.1, OFF);
    expect(stub.targetId).toBeNull();
    expect(stub.trackHz).toBe(0);
  });

  it('reports the measured pitch, and no class or bearing without a matched drone', () => {
    const stub = new NodeStub(1, 'array', 1);
    feed(stub, 1, { ...ON, f0Hz: 612.4 });
    const det = stub.detection(null);
    expect(det.lineHz).toBe(612);
    expect(det.cls).toBe(0);
    expect(det.az).toBe(0);
  });
});

describe('node pitch', () => {
  it('shows the detector pitch with or without a matched drone, and none once it stops', () => {
    const stub = new NodeStub(1, 'detector', 1);
    feed(stub, 1, ON);
    expect(stub.trackHz).toBe(250);
    expect(stub.pitchHz).toBe(250);
    feed(stub, 2, OFF);
    expect(stub.trackHz).toBe(0);
    expect(stub.pitchHz).toBe(0);
  });

  it('steadies over brief jumps', () => {
    const stub = new NodeStub(1, 'detector', 1);
    for (let i = 0; i < 20; i++) feed(stub, 1 + i * 0.01, ON);
    feed(stub, 1.2, { ...ON, f0Hz: 1100 });
    expect(stub.trackHz).toBe(1100);
    expect(stub.pitchHz).toBe(250);
  });
});

describe('pitch fit', () => {
  it('takes the fundamental, its sub-harmonics and its harmonics', () => {
    expect(pitchFits(590, 600)).toBe(true);
    expect(pitchFits(125, 250)).toBe(true);
    expect(pitchFits(1000, 250)).toBe(true);
  });

  it('rejects a pitch unrelated to the drone', () => {
    expect(pitchFits(380, 250)).toBe(false);
    expect(pitchFits(70, 600)).toBe(false);
  });
});

describe('bearing arrow', () => {
  // A plane wave along +x, so a true bearing of 90 degrees, as four mic rings.
  function rings(azDeg: number): { written: number; capacity: number; read(start: number, out: Float32Array): boolean }[] {
    return OFFSETS.map(([x, y]) => {
      const a = (azDeg * Math.PI) / 180;
      const lead = (x * Math.sin(a) + y * Math.cos(a)) / SOUND_SPEED_MPS;
      return {
        written: 8000,
        capacity: 16000,
        read(start: number, out: Float32Array): boolean {
          for (let i = 0; i < out.length; i++) out[i] = Math.sin(2 * Math.PI * 250 * ((start + i) / FS + lead));
          return true;
        },
      };
    });
  }

  it('comes from the mics of a detecting array, and goes when the detection ends', () => {
    const stub = new NodeStub(1, 'array', 1);
    feed(stub, 1, ON);
    stub.listenForBearing(1, rings(90), OFFSETS);
    expect(stub.bearingDeg).toBeNull();
    stub.listenForBearing(1.6, rings(90), OFFSETS);
    expect(Math.abs(stub.bearingDeg! - 90)).toBeLessThan(6);
    const det = stub.detection(null);
    expect(Math.abs(det.az - 90)).toBeLessThan(6);
    expect(det.bearingSigma).toBeLessThan(15);
    feed(stub, 2, OFF);
    expect(stub.bearingDeg).toBeNull();
  });

  it('claims no direction while its estimates disagree', () => {
    const stub = new NodeStub(1, 'array', 1);
    feed(stub, 1, ON);
    stub.listenForBearing(1, rings(90), OFFSETS);
    stub.listenForBearing(1.6, rings(270), OFFSETS);
    expect(stub.bearingDeg).toBeNull();
    expect(stub.detection(null).bearingSigma).toBe(15);
  });

  it('never shows on a single-mic node, or before a detection', () => {
    const single = new NodeStub(1, 'detector', 1);
    feed(single, 1, ON);
    single.listenForBearing(1, rings(90), OFFSETS);
    single.listenForBearing(1.6, rings(90), OFFSETS);
    expect(single.bearingDeg).toBeNull();
    const idle = new NodeStub(1, 'array', 1);
    idle.listenForBearing(1, rings(90), OFFSETS);
    idle.listenForBearing(1.6, rings(90), OFFSETS);
    expect(idle.bearingDeg).toBeNull();
  });
});
