import { zeroStick } from '../input/sticks';
import type { Stick } from '../sim/world';
import { clamp } from '../sim/math';

// Phones, upright or on their side. The same widths and heights as the phone section of style.css.
export const NARROW_QUERY = '(max-width: 820px), (max-height: 500px) and (orientation: landscape)';
export const COARSE_QUERY = '(pointer: coarse)';

// How far from a touch a marker can be and still be picked, since a finger hides what it presses.
export const TOUCH_PICK_PX = 28;
export const TOUCH_CLICK_PX = 12;

const DEADZONE = 0.08;

// A thumb's offset from the centre of a stick, in pixels, as -1 to 1 on each axis with up positive. Beyond the rim it
// keeps its direction at full deflection, and near the centre it is zero so a resting thumb does not drift.
export function stickFromOffset(dx: number, dy: number, radius: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (radius <= 0 || len / radius < DEADZONE) return { x: 0, y: 0 };
  const scale = Math.min(1, radius / len) / radius;
  return { x: clamp(dx * scale, -1, 1), y: clamp(-dy * scale, -1, 1) };
}

interface Pad {
  el: HTMLElement;
  knob: HTMLElement;
  apply(v: { x: number; y: number }): void;
}

// On-screen sticks for flying with thumbs. Left: up and down. Right: move, relative to the camera, as WASD does. Each
// tracks its own finger, and both spring back to centre on release.
export class TouchSticks {
  private readonly root: HTMLElement;
  private value: Stick = zeroStick();
  private visible = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-sticks';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="touch-stick vertical" role="slider" aria-label="Climb and descend"><span class="knob"></span></div>
      <div class="touch-stick" role="slider" aria-label="Fly, relative to the camera"><span class="knob"></span></div>`;
    container.append(this.root);
    const [climb, move] = Array.from(this.root.querySelectorAll<HTMLElement>('.touch-stick'));
    this.bind({
      el: climb,
      knob: climb.querySelector('.knob') as HTMLElement,
      apply: (v) => (this.value = { ...this.value, z: v.y }),
    });
    this.bind({
      el: move,
      knob: move.querySelector('.knob') as HTMLElement,
      apply: (v) => (this.value = { ...this.value, x: v.x, y: v.y }),
    });
  }

  get stick(): Stick {
    return this.value;
  }

  // Hiding also centres the sticks, so a drone does not keep flying with no sticks on screen.
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.root.hidden = !on;
    if (on) return;
    this.value = zeroStick();
    this.root.querySelectorAll<HTMLElement>('.knob').forEach((k) => (k.style.transform = ''));
  }

  private bind(pad: Pad): void {
    const vertical = pad.el.classList.contains('vertical');
    let active: number | null = null;
    const move = (e: PointerEvent): void => {
      const r = pad.el.getBoundingClientRect();
      const radius = (vertical ? r.height : r.width) / 2;
      const dx = vertical ? 0 : e.clientX - (r.left + r.width / 2);
      const v = stickFromOffset(dx, e.clientY - (r.top + r.height / 2), radius);
      pad.apply(v);
      pad.knob.style.transform = `translate(${v.x * radius * 0.6}px, ${-v.y * radius * 0.6}px)`;
    };
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== active) return;
      active = null;
      pad.apply({ x: 0, y: 0 });
      pad.knob.style.transform = '';
    };
    pad.el.addEventListener('pointerdown', (e) => {
      active = e.pointerId;
      pad.el.setPointerCapture(e.pointerId);
      move(e);
    });
    pad.el.addEventListener('pointermove', (e) => {
      if (e.pointerId === active) move(e);
    });
    pad.el.addEventListener('pointerup', end);
    pad.el.addEventListener('pointercancel', end);
  }
}
