"""Maps a board's local clock (microseconds since boot) onto host time (unix seconds).

The host receive time of a trace line is the local time of that line plus a delay that is never
negative, so the lower envelope of (host - local) is the true offset. Per window of 10 s the smallest
offset is kept; a straight line through those minima gives offset and drift (ppm). A local clock that
steps back (a reboot) starts a new segment.
"""

import numpy as np

WINDOW_S = 10.0
RESET_US = 1_000_000
# Drift is fitted only over enough time and windows to mean something, and believed only within the
# range of real crystals; otherwise the offset alone is used. Sparse lines (only records) give few,
# noisy minima.
MIN_DRIFT_SPAN_S = 40.0
MIN_DRIFT_WINDOWS = 5
MAX_DRIFT_PPM = 200.0


class Segment:
    def __init__(self, lo_us, hi_us, c0, c1, wall_lo, wall_hi):
        self.lo_us, self.hi_us, self.c0, self.c1 = lo_us, hi_us, c0, c1
        self.wall_lo, self.wall_hi = wall_lo, wall_hi

    def to_host(self, local_us):
        t = local_us / 1e6
        return t + self.c0 + self.c1 * t


class Clock:
    def __init__(self, segments):
        self.segments = segments

    @property
    def drift_ppm(self):
        return [round(s.c1 * 1e6, 2) for s in self.segments]

    def to_host(self, local_us, wall=None):
        """Host time of a local time. After a reboot two segments can cover the same local times, so
        pass wall (the host receive time of the line the time came from) to pick the right one."""
        cands = [s for s in self.segments if s.lo_us <= local_us <= s.hi_us] or self.segments
        if wall is None or len(cands) == 1:
            return cands[0].to_host(local_us)

        def wall_gap(s):
            if s.wall_lo <= wall <= s.wall_hi:
                return 0.0
            return min(abs(wall - s.wall_lo), abs(wall - s.wall_hi))
        return min(cands, key=wall_gap).to_host(local_us)


def _fit_segment(points, window_s):
    """points: (host_wall, local_us) in order. Returns Segment."""
    local = np.array([p[1] for p in points], dtype=np.float64) / 1e6
    wall = np.array([p[0] for p in points], dtype=np.float64)
    off = wall - local
    lo, hi = int(points[0][1]), int(points[-1][1])
    bins = np.floor((local - local[0]) / window_s).astype(np.int64)
    mids, minima = [], []
    for b in np.unique(bins):
        sel = bins == b
        mids.append(float(local[sel].mean()))
        minima.append(float(off[sel].min()))
    wall_lo, wall_hi = float(wall.min()), float(wall.max())
    if len(mids) >= MIN_DRIFT_WINDOWS and mids[-1] - mids[0] >= MIN_DRIFT_SPAN_S:
        c1, c0 = np.polyfit(mids, minima, 1)
        if abs(c1) * 1e6 <= MAX_DRIFT_PPM:
            return Segment(lo, hi, float(c0), float(c1), wall_lo, wall_hi)
    return Segment(lo, hi, float(off.min()), 0.0, wall_lo, wall_hi)


def fit_clock(samples, window_s=WINDOW_S):
    """samples: (host_wall_seconds, local_us) pairs in the order they arrived. Returns a Clock."""
    if not samples:
        raise ValueError("no timed lines to fit a clock to")
    groups, current = [], [samples[0]]
    for prev, cur in zip(samples, samples[1:]):
        if cur[1] < prev[1] - RESET_US:
            groups.append(current)
            current = []
        current.append(cur)
    groups.append(current)
    segments = [_fit_segment(g, window_s) for g in groups]
    return Clock(segments)
