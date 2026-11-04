export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Move v towards target by at most maxDelta.
export function approach(v: number, target: number, maxDelta: number): number {
  return v + clamp(target - v, -maxDelta, maxDelta);
}
