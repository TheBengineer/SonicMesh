import { describe, expect, it } from 'vitest';
import { snippetSpectrogram, SNIP_FS } from '../src/audio/analysis';
import { NODE_COMB_PARAMS } from '../src/detector/comb';
import { MAX_DETECT_SPANS, NodeStub } from '../src/lora/nodeStub';
import type { DetectState } from '../src/lora/types';
import { hzRow, LevelHistory, METER_TICK, meterFraction, pitchTrace, spanAt, spanColumns, type LevelSample } from '../src/ui/detectMarks';

const SEC_PER_COL = 0.032;

describe('detection spans at a node', () => {
  function run(stub: NodeStub, from: number, to: number, on: boolean, f0Hz = 600): void {
    for (let t = from; t < to; t += 0.1) stub.update(t, { bandDb: 60, ambientDb: 40, comb: { on, tracking: on, f0Hz: on ? f0Hz : 0, peak: 0.3 } });
  }

  it('open when the detection starts and close when it ends', () => {
    const stub = new NodeStub(1, 'detector', 7);
    run(stub, 0, 2, true);
    expect(stub.spans).toHaveLength(1);
    expect(stub.spans[0].startS).toBe(stub.lastDetectionS);
    expect(stub.spans[0].endS).toBeNull();
    run(stub, 2, 4, false);
    expect(stub.detecting).toBe(false);
    expect(stub.spans[0].endS).toBeGreaterThan(stub.spans[0].startS);
  });

  it('keep the pitch the detector measured, and only while running', () => {
    const stub = new NodeStub(1, 'detector', 7);
    run(stub, 0, 2, true, 612);
    expect(stub.spans[0].lineHz).toBe(612);
    expect(stub.detection(null).lineHz).toBe(612);
    run(stub, 2, 4, false);
    expect(stub.spans[0].lineHz).toBe(612);
  });

  it('stop growing at the cap', () => {
    const stub = new NodeStub(1, 'detector', 7);
    for (let i = 0; i < MAX_DETECT_SPANS + 3; i++) {
      run(stub, i * 4, i * 4 + 2, true);
      run(stub, i * 4 + 2, i * 4 + 4, false);
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

describe('the detector meter', () => {
  const theta = NODE_COMB_PARAMS.theta!;

  it('puts the threshold at the tick, stretching the low end', () => {
    expect(meterFraction(theta)).toBeCloseTo(METER_TICK, 9);
    expect(meterFraction(0)).toBe(0);
    expect(meterFraction(theta / 2)).toBeCloseTo(METER_TICK / 2, 9);
    expect(meterFraction(0.8)).toBe(1);
    expect(meterFraction(3)).toBe(1);
  });

  it('follows the detector: quiet, then following a pitch, then detecting, then quiet', () => {
    const stub = new NodeStub(1, 'detector', 7);
    const feed = (t: number, tracking: boolean, on: boolean): void => {
      stub.update(t, { bandDb: 60, ambientDb: 40, comb: { on, tracking, f0Hz: tracking ? 600 : 0, peak: tracking ? 0.3 : 0 } });
    };
    feed(0, false, false);
    expect(stub.state).toBe('quiet');
    expect(stub.peak).toBe(0);
    feed(1, true, false);
    expect(stub.state).toBe('arming');
    expect(stub.peak).toBe(0.3);
    feed(3, true, true);
    expect(stub.state).toBe('detecting');
    feed(5, false, false);
    expect(stub.state).toBe('quiet');
  });
});

describe('the pitch line', () => {
  const at = (t: number, trackHz: number): LevelSample => ({ t, peak: 0.3, state: 'detecting', trackHz });

  it('fills the columns of matched samples and leaves the rest empty', () => {
    const trace = pitchTrace([at(0, 0), at(1, 600), at(2, 0)], 3, 100, 0.032);
    const col = (t: number): number => Math.round(99 - (3 - t) / 0.032);
    expect(trace[col(0.5)]).toBe(0);
    expect(trace[col(1.5)]).toBe(600);
    expect(trace[col(2.5)]).toBe(0);
  });
});

describe('level history', () => {
  const sample = (t: number, state: DetectState = 'quiet'): LevelSample => ({ t, peak: 0.3, state, trackHz: 0 });

  it('keeps one sample per step, and does not lose a brief change of state', () => {
    const h = new LevelHistory();
    h.push(sample(1));
    h.push(sample(1.05, 'arming'));
    h.push(sample(1.2));
    expect(h.samples.map((s) => [s.t, s.state])).toEqual([[1, 'arming'], [1.2, 'quiet']]);
  });

  it('stops growing at its cap', () => {
    const h = new LevelHistory();
    for (let i = 0; i < LevelHistory.MAX + 20; i++) h.push(sample(i));
    expect(h.samples).toHaveLength(LevelHistory.MAX);
  });

  it('restarts when sim time goes back, as on a reset', () => {
    const h = new LevelHistory();
    h.push(sample(50));
    h.push(sample(0));
    expect(h.samples.map((s) => s.t)).toEqual([0]);
  });
});
