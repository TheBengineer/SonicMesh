import { describe, expect, it } from 'vitest';
import { DETECTION_HOLD_S, NodeStub } from '../src/lora/nodeStub';

const AMBIENT = 40;

function run(stub: NodeStub, fromS: number, seconds: number, marginDb: number): number {
  let t = fromS;
  for (; t < fromS + seconds; t += 0.01) stub.update(t, { bandDb: AMBIENT + marginDb, ambientDb: AMBIENT });
  return t;
}

describe('node detection threshold', () => {
  it('stays off at a level the quiet background reaches', () => {
    const stub = new NodeStub(1, 'detector', 1);
    run(stub, 0, 5, 1.4);
    expect(stub.detecting).toBe(false);
  });

  it('switches on 2 dB over the ambient after the hold time', () => {
    const stub = new NodeStub(1, 'detector', 1);
    const t = run(stub, 0, DETECTION_HOLD_S - 0.1, 2.1);
    expect(stub.detecting).toBe(false);
    run(stub, t, 0.2, 2.1);
    expect(stub.detecting).toBe(true);
    expect(stub.detections).toBe(1);
  });

  it('holds through dips above the release level and short dips below it', () => {
    const stub = new NodeStub(1, 'detector', 1);
    let t = run(stub, 0, 1, 3);
    t = run(stub, t, 3, 1.5);
    t = run(stub, t, DETECTION_HOLD_S - 0.1, 0);
    run(stub, t, 1, 2);
    expect(stub.detecting).toBe(true);
    expect(stub.detections).toBe(1);
  });

  it('switches off once the level stays below the release level', () => {
    const stub = new NodeStub(1, 'detector', 1);
    const t = run(stub, 0, 1, 3);
    run(stub, t, DETECTION_HOLD_S + 0.1, 0);
    expect(stub.detecting).toBe(false);
  });
});
