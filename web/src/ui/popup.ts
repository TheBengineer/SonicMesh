import { clamp } from '../sim/math';

// Floating object window over the world view. The pure geometry (clamping, default placement, tail) is kept apart
// from the DOM so it can be tested without a browser.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

// Where an object is on screen, in view pixels. visible is false when it is off the view or behind the camera.
export interface ScreenPos extends Point {
  visible: boolean;
}

export interface Tail {
  from: Point;
  to: Point;
  onScreen: boolean;
}

export const WINDOW_MIN: Size = { w: 260, h: 180 };
export const WINDOW_DEFAULT: Size = { w: 460, h: 460 };
const GAP_PX = 40;
const MARGIN_PX = 12;
const TAIL_WIDTH_PX = 10;

// Keeps the window inside the view. Size is capped by the view, so a window is never fully off screen.
export function clampRect(r: Rect, view: Size, min: Size = WINDOW_MIN): Rect {
  const w = clamp(r.w, Math.min(min.w, view.w), view.w);
  const h = clamp(r.h, Math.min(min.h, view.h), view.h);
  return { x: clamp(r.x, 0, view.w - w), y: clamp(r.y, 0, view.h - h), w, h };
}

// Opening position: beside the object, on whichever side fits, else the top right corner of the view.
export function defaultRect(anchor: ScreenPos | null, view: Size, size: Size = WINDOW_DEFAULT): Rect {
  const w = Math.min(size.w, view.w);
  const h = Math.min(size.h, view.h);
  if (!anchor) return clampRect({ x: view.w - w - MARGIN_PX, y: MARGIN_PX, w, h }, view);
  const right = anchor.x + GAP_PX;
  const left = anchor.x - GAP_PX - w;
  const x = right + w <= view.w || left < 0 ? right : left;
  return clampRect({ x, y: anchor.y - GAP_PX, w, h }, view);
}

// The point on the window's outline nearest to p. For a point inside the window, the nearest side.
export function nearestEdgePoint(r: Rect, p: Point): Point {
  const cx = clamp(p.x, r.x, r.x + r.w);
  const cy = clamp(p.y, r.y, r.y + r.h);
  if (cx !== p.x || cy !== p.y) return { x: cx, y: cy };
  const sides: [number, Point][] = [
    [p.x - r.x, { x: r.x, y: p.y }],
    [r.x + r.w - p.x, { x: r.x + r.w, y: p.y }],
    [p.y - r.y, { x: p.x, y: r.y }],
    [r.y + r.h - p.y, { x: p.x, y: r.y + r.h }],
  ];
  return sides.reduce((best, s) => (s[0] < best[0] ? s : best))[1];
}

// Fraction of the segment from -> to (with `from` inside the view) that stays inside the view.
function exitFraction(from: Point, to: Point, view: Size): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let t = 1;
  if (dx > 0) t = Math.min(t, (view.w - from.x) / dx);
  else if (dx < 0) t = Math.min(t, -from.x / dx);
  if (dy > 0) t = Math.min(t, (view.h - from.y) / dy);
  else if (dy < 0) t = Math.min(t, -from.y / dy);
  return clamp(t, 0, 1);
}

// The tail runs from the nearest window edge to the object. Off screen, it stops at the view's edge and points at
// the object. Null when the object is under the window, since there is nothing to show.
export function tailGeometry(win: Rect, target: ScreenPos, view: Size): Tail | null {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  const covered = target.x >= win.x && target.x <= win.x + win.w && target.y >= win.y && target.y <= win.y + win.h;
  if (covered) return null;
  const from = nearestEdgePoint(win, target);
  if (target.visible) return { from, to: { x: target.x, y: target.y }, onScreen: true };
  const t = exitFraction(from, target, view);
  return {
    from,
    to: { x: from.x + t * (target.x - from.x), y: from.y + t * (target.y - from.y) },
    onScreen: false,
  };
}

// A tapered wedge: wide at the window edge, a point at the object. Empty when the tail has no length.
export function tailPolygon(tail: Tail, width = TAIL_WIDTH_PX): string {
  const dx = tail.to.x - tail.from.x;
  const dy = tail.to.y - tail.from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return '';
  const nx = ((-dy / len) * width) / 2;
  const ny = ((dx / len) * width) / 2;
  const pt = (p: Point): string => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  return [
    pt({ x: tail.from.x + nx, y: tail.from.y + ny }),
    pt({ x: tail.from.x - nx, y: tail.from.y - ny }),
    pt(tail.to),
  ].join(' ');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface PopupOptions {
  // The world view. The window and tail are positioned relative to it.
  container: HTMLElement;
  onClose(): void;
}

// The window itself: title bar to drag, close button, corner handle to resize, body for the inspector tabs.
// Pointer events stay on the window and tail. They never reach the scene canvas, so they do not orbit the camera.
export class Popup {
  readonly body: HTMLElement;
  private readonly root: HTMLElement;
  private readonly titleText: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly tailShape: SVGPolygonElement;
  private rect: Rect = { x: 0, y: 0, w: WINDOW_DEFAULT.w, h: WINDOW_DEFAULT.h };
  private open = false;
  private drag: { dx: number; dy: number } | null = null;
  private grip: { x: number; y: number; w: number; h: number } | null = null;

  constructor(private readonly opts: PopupOptions) {
    const container = opts.container;
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'popup-tail');
    this.svg.setAttribute('aria-hidden', 'true');
    this.hideTail();
    this.tailShape = document.createElementNS(SVG_NS, 'polygon');
    this.svg.append(this.tailShape);

    this.root = document.createElement('div');
    this.root.className = 'panel popup';
    this.root.setAttribute('role', 'dialog');
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="popup-title"><span></span><button type="button" class="popup-close" aria-label="Close (Esc)">×</button></div>
      <div class="popup-body"></div>
      <div class="popup-grip" aria-hidden="true"></div>`;
    this.titleText = this.root.querySelector<HTMLElement>('.popup-title span') as HTMLElement;
    this.body = this.root.querySelector<HTMLElement>('.popup-body') as HTMLElement;
    const titleBar = this.root.querySelector<HTMLElement>('.popup-title') as HTMLElement;
    const grip = this.root.querySelector<HTMLElement>('.popup-grip') as HTMLElement;
    container.append(this.svg, this.root);

    this.root.querySelector('.popup-close')?.addEventListener('click', () => opts.onClose());
    titleBar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      const p = this.local(e);
      this.drag = { dx: p.x - this.rect.x, dy: p.y - this.rect.y };
      titleBar.setPointerCapture(e.pointerId);
    });
    titleBar.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = this.local(e);
      this.rect = clampRect({ ...this.rect, x: p.x - this.drag.dx, y: p.y - this.drag.dy }, this.viewSize());
      this.apply();
    });
    const endDrag = (): void => {
      this.drag = null;
    };
    titleBar.addEventListener('pointerup', endDrag);
    titleBar.addEventListener('pointercancel', endDrag);

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = this.local(e);
      this.grip = { x: p.x, y: p.y, w: this.rect.w, h: this.rect.h };
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!this.grip) return;
      const p = this.local(e);
      const w = this.grip.w + (p.x - this.grip.x);
      const h = this.grip.h + (p.y - this.grip.y);
      this.rect = clampRect({ ...this.rect, w, h }, this.viewSize());
      this.apply();
    });
    const endGrip = (): void => {
      this.grip = null;
    };
    grip.addEventListener('pointerup', endGrip);
    grip.addEventListener('pointercancel', endGrip);

    new ResizeObserver(() => {
      this.rect = clampRect(this.rect, this.viewSize());
      this.apply();
    }).observe(container);
  }

  get isOpen(): boolean {
    return this.open;
  }

  // Shows the window. Placed beside the object only on opening, so a window the user moved stays where it is.
  show(anchor: ScreenPos | null): void {
    if (!this.open) {
      this.rect = defaultRect(anchor, this.viewSize());
      this.open = true;
    }
    this.root.hidden = false;
    this.apply();
  }

  close(): void {
    this.open = false;
    this.drag = null;
    this.grip = null;
    this.root.hidden = true;
    this.hideTail();
  }

  setTitle(text: string): void {
    if (this.titleText.textContent !== text) this.titleText.textContent = text;
  }

  // Redraws the tail. Called every frame so it tracks a flying drone and camera moves.
  update(anchor: ScreenPos | null): void {
    if (!this.open) return;
    const tail = anchor ? tailGeometry(this.rect, anchor, this.viewSize()) : null;
    const points = tail ? tailPolygon(tail) : '';
    if (points === '') {
      this.hideTail();
      return;
    }
    this.svg.style.display = '';
    this.tailShape.setAttribute('points', points);
  }

  private hideTail(): void {
    this.svg.style.display = 'none';
  }

  private viewSize(): Size {
    return { w: this.opts.container.clientWidth, h: this.opts.container.clientHeight };
  }

  private local(e: PointerEvent): Point {
    const r = this.opts.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private apply(): void {
    const s = this.root.style;
    s.left = `${this.rect.x}px`;
    s.top = `${this.rect.y}px`;
    s.width = `${this.rect.w}px`;
    s.height = `${this.rect.h}px`;
  }
}
