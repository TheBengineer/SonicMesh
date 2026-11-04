import type { Stick } from '../sim/world';
import { clamp } from '../sim/math';

const GAMEPAD_DEADZONE = 0.12;

export function zeroStick(): Stick {
  return { x: 0, y: 0, z: 0 };
}

// WASD or arrows for x and y. E up, Q down.
export function keyboardStick(down: ReadonlySet<string>): Stick {
  const axis = (plus: string[], minus: string[]): number =>
    (plus.some((k) => down.has(k)) ? 1 : 0) - (minus.some((k) => down.has(k)) ? 1 : 0);
  return {
    x: axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']),
    y: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
    z: axis(['KeyE'], ['KeyQ']),
  };
}

function deadzone(v: number): number {
  if (Math.abs(v) < GAMEPAD_DEADZONE) return 0;
  return (v - Math.sign(v) * GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE);
}

// Left stick: x and up/down. Right stick: y.
export function gamepadStick(): Stick {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return zeroStick();
  const pad = Array.from(navigator.getGamepads()).find((p): p is Gamepad => p !== null && p.connected);
  if (!pad) return zeroStick();
  const axis = (i: number): number => deadzone(pad.axes[i] ?? 0);
  return { x: axis(0), y: -axis(3), z: -axis(1) };
}

export function combineSticks(a: Stick, b: Stick): Stick {
  return { x: clamp(a.x + b.x, -1, 1), y: clamp(a.y + b.y, -1, 1), z: clamp(a.z + b.z, -1, 1) };
}

// Round to 0.01 so the log stays small and the same stick gives the same value.
export function quantizeStick(s: Stick): Stick {
  const q = (v: number): number => Math.round(v * 100) / 100;
  return { x: q(s.x), y: q(s.y), z: q(s.z) };
}

export function sameStick(a: Stick, b: Stick): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
