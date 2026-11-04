export interface Trace {
  label: string;
  color: string;
  values: ArrayLike<number>;
  dashed?: boolean;
}

const PAD_L = 46;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 18;

// Line chart on a 2D canvas. Values are auto-ranged unless yRange is given. Non-finite values leave a gap.
export function drawTraces(
  canvas: HTMLCanvasElement,
  traces: Trace[],
  opts: { unit: string; xLabel: string; yRange?: [number, number] },
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0b1016';
  ctx.fillRect(0, 0, w, h);

  let n = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const tr of traces) {
    n = Math.max(n, tr.values.length);
    for (let i = 0; i < tr.values.length; i++) {
      const v = tr.values[i];
      if (Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (opts.yRange) {
    [lo, hi] = opts.yRange;
  } else {
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.05;
    lo -= pad;
    hi += pad;
  }

  const x = (i: number): number => PAD_L + (n > 1 ? i / (n - 1) : 0) * (w - PAD_L - PAD_R);
  const y = (v: number): number => PAD_T + (1 - (v - lo) / (hi - lo)) * (h - PAD_T - PAD_B);

  ctx.strokeStyle = '#2a3541';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_L, PAD_T);
  ctx.lineTo(PAD_L, h - PAD_B);
  ctx.lineTo(w - PAD_R, h - PAD_B);
  ctx.stroke();

  ctx.fillStyle = '#8a98a8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${hi.toFixed(0)} ${opts.unit}`, PAD_L - 4, PAD_T + 9);
  ctx.fillText(`${lo.toFixed(0)} ${opts.unit}`, PAD_L - 4, h - PAD_B);
  ctx.textAlign = 'right';
  ctx.fillText(opts.xLabel, w - PAD_R, h - 4);

  for (const tr of traces) {
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(tr.dashed ? [4, 3] : []);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < tr.values.length; i++) {
      const v = tr.values[i];
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x(i), y(v));
      else ctx.moveTo(x(i), y(v));
      pen = true;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.textAlign = 'left';
  let lx = PAD_L + 6;
  for (const tr of traces) {
    ctx.fillStyle = tr.color;
    ctx.fillText(tr.label, lx, PAD_T + 11);
    lx += ctx.measureText(tr.label).width + 14;
  }
}
