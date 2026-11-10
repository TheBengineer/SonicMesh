import { describe, expect, it } from 'vitest';
import { estimateShotBearing } from '../src/detector/bearing';
import { renderShot, shotRng } from '../src/acoustics/shot';
import { ARRAY_HALF_M, FS, SOUND_SPEED_MPS } from '../src/acoustics/model';
import { ARRAY_OFFSETS } from '../src/acoustics/engine';
import { clusterShots, locateShot, type ShotReport } from '../src/lora/shotLocate';

const OFFSETS = ARRAY_OFFSETS.map(([dx, dy]) => [dx * ARRAY_HALF_M, dy * ARRAY_HALF_M] as const);

// The bearing a source at this azimuth (clockwise from +y) presents to an array.
function angleDiff(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

// Reports a shot as the network would hear it, with no noise: onset = fire time + travel, bearing from the true spot.
function reportsFor(shot: { x: number; y: number; tFireS: number }, nodes: { id: number; x: number; y: number; array: boolean }[]): ShotReport[] {
  return nodes.map((n) => {
    const d = Math.hypot(shot.x - n.x, shot.y - n.y);
    const az = (Math.atan2(shot.x - n.x, shot.y - n.y) * 180) / Math.PI;
    return { id: n.id, x: n.x, y: n.y, tS: shot.tFireS + d / SOUND_SPEED_MPS, azDeg: n.array ? (az + 360) % 360 : null };
  });
}

describe('shot bearing from an array', () => {
  it('points at a crack from a range of azimuths, within about 10 degrees', () => {
    const wave = renderShot(shotRng(3, 1, 0));
    for (const trueAz of [30, 120, 250]) {
      const u = [Math.sin((trueAz * Math.PI) / 180), Math.cos((trueAz * Math.PI) / 180)];
      const lead = 10;
      // A mic nearer the source hears the crack earlier, as in the engine.
      const frames = OFFSETS.map(([ox, oy]) => {
        const tau = Math.round(lead - ((ox * u[0] + oy * u[1]) * FS) / SOUND_SPEED_MPS);
        const f = new Float32Array(512);
        for (let i = 0; i < f.length; i++) f[i] = i - tau >= 0 ? wave[i - tau] : 0;
        return f;
      });
      const az = estimateShotBearing(frames, OFFSETS);
      expect(az).not.toBeNull();
      expect(angleDiff(az!, trueAz)).toBeLessThan(10);
    }
  });
});

describe('shot fix', () => {
  // A line of nodes like the demo's, with arrays at some of them, and a range well off to one side.
  const nodes = [-600, -360, -120, 120, 360, 600].map((x, i) => ({ id: i + 1, x, y: i % 2 === 0 ? 30 : -30, array: i % 3 === 2 }));

  it('places a shot to within a few metres from exact onsets and bearings', () => {
    const truth = { x: 420, y: -200, tFireS: 12.3 };
    const fix = locateShot(reportsFor(truth, nodes), [2000, 1400]);
    expect(fix).not.toBeNull();
    expect(Math.hypot(fix!.x - truth.x, fix!.y - truth.y)).toBeLessThan(5);
    expect(fix!.tFireS).toBeCloseTo(truth.tFireS, 2);
  });

  it('needs a bearing to pick the side of the line', () => {
    const truth = { x: 420, y: -200, tFireS: 12.3 };
    const timesOnly = reportsFor(truth, nodes).map((r) => ({ ...r, azDeg: null }));
    expect(locateShot(timesOnly, [2000, 1400])).toBeNull();
  });

  it('keeps shots that are apart in time as separate clusters', () => {
    const a = reportsFor({ x: 420, y: -200, tFireS: 12.3 }, nodes);
    const b = reportsFor({ x: 420, y: -200, tFireS: 20.3 }, nodes);
    expect(clusterShots([...a, ...b]).length).toBe(2);
  });
});
