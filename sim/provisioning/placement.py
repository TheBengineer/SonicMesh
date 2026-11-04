"""Node-side placement latch: decide where the node was put down.

Inputs, in time order:
  - decoded frames, each with its received level, Doppler (radial speed of
    the phone) and the phone's GPS fix
  - the carrier-band level (1 s median) and its noise floor (lowest 50 ms
    reading over 10 s, i.e. a gap between frames), which still work when
    frames stop decoding
  - optionally an accelerometer "moving" flag

Rules:
  carried   The accelerometer says moving; or, without one, the GPS fix moves
            > 0.6 m/s over two frame intervals (~6 s) while the level stays
            steady and high. Either way, nothing near the phone is kept.
  near      Frames within 6 dB of the loudest seen since the node stopped. A
            new near window only starts within 10 dB of that loudest frame,
            so frames from the operator walking off can't start one.
  walk-away The band level stays >= 12 dB below the near frames (or within
            4 dB of the noise floor, measured in the gaps between frames, if
            that is higher) for 3 s, with
            a decoded frame showing the phone receding (Doppler < -0.3 m/s),
            or for 6 s if nothing decodes any more. At noisy sites, where the
            level can't fall that far, a receding frame whose own GPS fix is
            > 8 m from the near frames (and >= 4 dB quieter) also counts.
  commit    Weighted mean of the near frames' fixes (outliers > 5 m dropped).
            With fewer than 2 near frames, fall back to the last frame from
            while the node was being carried, flagged low confidence.
"""
from dataclasses import dataclass

import numpy as np


@dataclass
class Heard:
    t: float           # when the frame finished arriving
    level: float       # dB SPL in the carrier band
    v_r: float         # phone's speed toward the node, m/s (from Doppler)
    east: float
    north: float
    accuracy: float
    seq: int
    unix_time: int


@dataclass
class Commit:
    t: float
    east: float
    north: float
    n_frames: int
    confident: bool


class Latch:
    def __init__(self, accelerometer):
        self.accel = accelerometer
        self.reset()
        self.commit = None
        self.rejected = 0

    def reset(self):
        self.near, self.peak, self.prev, self.prev2 = [], None, None, None
        self.loudest = None
        self.drop_s, self.last_carried = 0.0, getattr(self, "last_carried", None)

    def _consistent(self, f):
        """Within one session, frame times must advance with local time."""
        p = self.prev
        return p is None or abs((f.unix_time - p.unix_time) - (f.t - p.t)) < 3.0

    def _carried(self, f):
        """Fix moving at walking pace over two frame intervals (~6 s, so GPS
        jitter of a metre or two doesn't count) while the level stays steady."""
        p, p2 = self.prev, self.prev2
        if p is None or p2 is None or self.accel:
            return False
        speed = np.hypot(f.east - p2.east, f.north - p2.north) / max(f.t - p2.t, 1e-3)
        levels = (f.level, p.level, p2.level)
        steady = max(levels) - min(levels) < 4.0
        high = self.peak is None or f.level > self.peak - 8.0
        return speed > 0.6 and steady and high

    def step(self, t, dt, band_level, noise_floor, moving, frames):
        if self.commit:
            if moving:                       # picked up again: provision afresh
                self.commit = None
                self.reset()
            return
        if moving:
            self.near, self.peak, self.drop_s = [], None, 0.0
            for f in frames:
                self.last_carried = f
                self.prev2, self.prev = self.prev, f
            return
        for f in frames:
            if not self._consistent(f):
                self.rejected += 1
                continue
            if self._carried(f):
                self.last_carried = f
                self.near, self.peak, self.loudest = [], None, None
            elif self.peak is None or f.level > self.peak + 6.0:
                # a near window only starts close to the loudest frame since setting down
                if self.loudest is None or f.level > self.loudest - 10.0:
                    self.near, self.peak = [f], f.level
            elif f.level >= self.peak - 6.0:
                self.near.append(f)
                self.peak = max(self.peak, f.level)
            self.loudest = f.level if self.loudest is None else max(self.loudest, f.level)
            self.prev2, self.prev = self.prev, f
        if not self.near:
            return
        ref = np.median([f.level for f in self.near])
        # gone = 12 dB below the near frames, or, at noisy sites, down near the noise floor
        threshold = max(ref - 12.0, noise_floor + 4.0)
        self.drop_s = self.drop_s + dt if band_level < threshold else 0.0
        p = self.prev
        after = p is not None and p.t > self.near[-1].t
        receding = after and p.v_r < -0.3
        # at noisy sites the level can't fall 12 dB, but the phone still reports itself leaving
        centre = np.mean([[f.east, f.north] for f in self.near], axis=0)
        left = after and receding and p.level < ref - 4.0 and np.hypot(p.east - centre[0], p.north - centre[1]) > 8.0
        if (self.drop_s >= 3.0 and receding) or self.drop_s >= 6.0 or left:
            self.commit = self._solve(t)

    def _solve(self, t):
        pts = np.array([[f.east, f.north] for f in self.near])
        if len(pts) < 2 and self.last_carried is not None:
            f = self.last_carried
            return Commit(t, f.east, f.north, 1, confident=False)
        med = np.median(pts, axis=0)
        keep = np.linalg.norm(pts - med, axis=1) < 5.0
        w = np.array([1 / f.accuracy ** 2 for f in self.near])[keep]
        e, n = (pts[keep] * w[:, None]).sum(axis=0) / w.sum()
        return Commit(t, e, n, int(keep.sum()), confident=len(pts) >= 2)
