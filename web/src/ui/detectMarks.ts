import type { DetectSpan } from '../lora/types';

// The band the detector adds up, the same one the band level uses.
export const BAND_LO_HZ = 100;
export const BAND_HI_HZ = 4000;

const SPAN_FILL = 'rgba(95, 180, 255, 0.14)';
const SPAN_EDGE = '#5fb4ff';
const LINE_COLOR = '#3ddc84';
const TRACE_EDGE = 'rgba(0, 0, 0, 0.7)';
const BAND_COLOR = 'rgba(255, 255, 255, 0.6)';

export interface MarkLayout {
  maxHz: number;
  lineWidth: number;
  spans: DetectSpan[];
  // Sim time of the rightmost column, and seconds from one column to the next.
  tNewest: number;
  secPerCol: number;
  // Draws only the reported line and the band edges, for a plot too short to show a span's ends.
  lineOnly?: boolean;
  // One trace per drone: Hz per column, 0 where no band is locked. Drawn only while the node detects.
  traces?: ArrayLike<number>[];
}

export interface SpanColumns {
  x0: number;
  x1: number;
  // False when that end of the span is off the plot or still to come.
  start: boolean;
  end: boolean;
  lineHz: number | null;
}

// The span that was running at time t, or the one that last ended before it.
export function spanAt(spans: DetectSpan[], t: number): DetectSpan | undefined {
  return spans.filter((s) => s.startS <= t).at(-1);
}

// Where each span falls on a plot `cols` wide, newest column on the right. Spans wholly off the plot are left out.
export function spanColumns(spans: DetectSpan[], tNewest: number, cols: number, secPerCol: number): SpanColumns[] {
  const out: SpanColumns[] = [];
  const x = (t: number): number => cols - 1 - (tNewest - t) / secPerCol;
  for (const s of spans) {
    const x0 = x(s.startS);
    const x1 = s.endS === null ? cols - 1 : x(s.endS);
    if (x1 < 0 || x0 > cols - 1) continue;
    out.push({
      x0: Math.max(0, x0),
      x1: Math.min(cols - 1, x1),
      start: x0 >= 0,
      end: s.endS !== null && x1 <= cols - 1,
      lineHz: s.lineHz,
    });
  }
  return out;
}

// The runs of columns where a traced band should show: locked, and inside a detection.
export function traceRuns(trace: ArrayLike<number>, spans: SpanColumns[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let c = 0; c <= trace.length; c++) {
    const on = c < trace.length && trace[c] > 0 && spans.some((s) => c >= s.x0 && c <= s.x1);
    if (on && start < 0) start = c;
    if (!on && start >= 0) {
      runs.push([start, c - 1]);
      start = -1;
    }
  }
  return runs;
}

// Canvas row of a frequency on a plot with 0 Hz at the bottom.
export function hzRow(hz: number, height: number, maxHz: number): number {
  return height - (hz / maxHz) * height;
}

export function drawDetectionMarks(ctx: CanvasRenderingContext2D, w: number, h: number, m: MarkLayout): void {
  const left = ctx.canvas.width - w;
  ctx.save();
  ctx.translate(left, 0);
  ctx.lineWidth = m.lineWidth;

  const hLine = (y: number, x0: number, x1: number): void => {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  };

  const spans: SpanColumns[] = m.lineOnly
    ? m.spans.map((s) => ({ x0: 0, x1: w, start: false, end: false, lineHz: s.lineHz }))
    : spanColumns(m.spans, m.tNewest, w, m.secPerCol);
  for (const s of spans) {
    if (!m.lineOnly) {
      ctx.fillStyle = SPAN_FILL;
      ctx.fillRect(s.x0, 0, Math.max(1, s.x1 - s.x0), h);
      ctx.strokeStyle = SPAN_EDGE;
      for (const [on, x] of [[s.start, s.x0], [s.end, s.x1]] as const) {
        if (!on) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }
    if (m.lineOnly && s.lineHz !== null) {
      ctx.strokeStyle = LINE_COLOR;
      hLine(hzRow(s.lineHz, h, m.maxHz), s.x0, s.x1);
    }
  }

  // A dark edge keeps the line readable over the bright bands.
  for (const trace of m.traces ?? []) {
    const runs = traceRuns(trace, spans);
    for (const [color, width] of [[TRACE_EDGE, m.lineWidth + 2], [LINE_COLOR, m.lineWidth]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      for (const [a, b] of runs) {
        ctx.beginPath();
        for (let c = a; c <= b; c++) ctx.lineTo(c, hzRow(trace[c], h, m.maxHz));
        ctx.stroke();
      }
    }
    ctx.lineWidth = m.lineWidth;
  }

  ctx.strokeStyle = BAND_COLOR;
  ctx.setLineDash([m.lineWidth * 3, m.lineWidth * 3]);
  for (const hz of [BAND_LO_HZ, BAND_HI_HZ]) {
    if (hz < m.maxHz) hLine(hzRow(hz, h, m.maxHz), 0, w);
  }
  ctx.restore();
}
