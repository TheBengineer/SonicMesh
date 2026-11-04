export const TICK_MS = 10;
export const TICK_S = TICK_MS / 1000;
export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

const MAX_TICKS_PER_CALL = 100;

// Turns wall-clock time into a whole number of 10 ms ticks. The world never sees wall time.
export class SimClock {
  playing = false;
  speed = 1;
  private carry = 0;

  setSpeed(speed: number): void {
    this.speed = Math.min(4, Math.max(0.25, speed));
  }

  ticksFor(wallMs: number): number {
    if (!this.playing) return 0;
    this.carry += wallMs * this.speed;
    const n = Math.floor(this.carry / TICK_MS);
    if (n > MAX_TICKS_PER_CALL) {
      this.carry = 0;
      return MAX_TICKS_PER_CALL;
    }
    this.carry -= n * TICK_MS;
    return n;
  }
}
