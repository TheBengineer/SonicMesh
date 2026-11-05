import { describe, expect, it } from 'vitest';
import { snippetSpectrogram, SNIP_FS } from '../src/audio/analysis';
import { MAX_DETECT_SPANS, NodeStub } from '../src/lora/nodeStub';
import { hzRow, spanAt, spanColumns } from '../src/ui/detectMarks';

const SEC_PER_COL = 0.032;

describe('detection spans at a node', () => {
  function run(stub: NodeStub, from: number, to: number, bandDb: number): void {
    for (let t = from; t < to; t += 0.1) stub.update(t, { bandDb, ambientDb: 40 });
  }

  it('open when the detection starts and close when it ends', () => {
    const stub = new NodeStub(1, 'detector', 7);
    run(stub, 0, 2, 60);
    expect(stub.spans).toHaveLength(1);
    expect(stub.spans[0].startS).toBe(stub.lastDetectionS);
    expect(stub.spans[0].endS).toBeNull();
    run(stub, 2, 4, 40);
    expect(stub.detecting).toBe(false);
    expect(stub.spans[0].endS).toBeGreaterThan(stub.spans[0].startS);
  });

  it('keep the line the node reported, and only while running', () => {
    const stub = new NodeStub(1, 'detector', 7);
    const target = { id: 1, class: 'fpv' as const, x: 10, y: 0, alt: 30 };
    run(stub, 0, 2, 60);
    const det = stub.detection(2, target, 0, 0, 0);
    expect(stub.spans[0].lineHz).toBe(det.lineHz);
    run(stub, 2, 4, 40);
    stub.detection(4, target, 0, 0, 0);
    expect(stub.spans[0].lineHz).toBe(det.lineHz);
  });

  it('stop growing at the cap', () => {
    const stub = new NodeStub(1, 'detector', 7);
    for (let i = 0; i < MAX_DETECT_SPANS + 3; i++) {
      run(stub, i * 4, i * 4 + 2, 60);
      run(stub, i * 4 + 2, i * 4 + 4, 40);
    }
    expect(stub.spans).toHaveLength(MAX_DETECT_SPANS);
  });
});

describe('detection marks on a waterfall', () => {
  const cols = 300;
  const newest = 100;
  const at = (seconds: number): number => cols - 1 - seconds / SEC_PER_COL;

  it('place a finished span by its age', () => {
    const [s] = spanColumns([{ startS: newest - 5, endS: newest - 2, lineHz: 600 }], newest, cols, SEC_PER_COL);
    expect(s.x0).toBeCloseTo(at(5), 6);
    expect(s.x1).toBeCloseTo(at(2), 6);
    expect(s.start && s.end).toBe(true);
  });

  it('run a live span to the newest column, with no end line', () => {
    const [s] = spanColumns([{ startS: newest - 1, endS: null, lineHz: null }], newest, cols, SEC_PER_COL);
    expect(s.x1).toBe(cols - 1);
    expect(s.start).toBe(true);
    expect(s.end).toBe(false);
  });

  it('clip a span that began off the plot, with no start line', () => {
    const [s] = spanColumns([{ startS: newest - 60, endS: newest - 1, lineHz: null }], newest, cols, SEC_PER_COL);
    expect(s.x0).toBe(0);
    expect(s.start).toBe(false);
    expect(s.end).toBe(true);
  });

  it('leave out a span that has scrolled away', () => {
    expect(spanColumns([{ startS: newest - 60, endS: newest - 50, lineHz: null }], newest, cols, SEC_PER_COL)).toHaveLength(0);
  });

  it('put frequencies on the right row, 0 Hz at the bottom', () => {
    expect(hzRow(0, 512, 8000)).toBe(512);
    expect(hzRow(4000, 512, 8000)).toBe(256);
    expect(hzRow(8000, 512, 8000)).toBe(0);
  });

  it('find the span a packet belongs to, even just after it ended', () => {
    const a = { startS: 5, endS: 8, lineHz: 100 };
    const b = { startS: 20, endS: 30, lineHz: 600 };
    expect(spanAt([a, b], 25)).toBe(b);
    expect(spanAt([a, b], 9)).toBe(a);
    expect(spanAt([a, b], 1)).toBeUndefined();
  });
});

describe('snippet clip spectrogram', () => {
  it('shows a clipped 600 Hz tone in the 600 Hz bins', () => {
    const bits = Array.from({ length: 960 }, (_, i) => (Math.sin((2 * Math.PI * 600 * i) / SNIP_FS) >= 0 ? 1 : 0));
    const spec = snippetSpectrogram(bits);
    expect(spec.cols).toBeGreaterThan(10);
    const column = spec.index.subarray(0, spec.bins);
    const peak = column.indexOf(Math.max(...column));
    expect(Math.abs((peak * (SNIP_FS / 2)) / spec.bins - 600)).toBeLessThan(40);
  });

  it('has no columns for a clip shorter than one window', () => {
    expect(snippetSpectrogram([1, 0, 1]).cols).toBe(0);
  });
});
