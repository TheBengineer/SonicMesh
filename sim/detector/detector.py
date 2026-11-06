"""Harmonic-comb detector, baseline (Phase 1), with the frame length as a parameter.

Input: pressure in Pa at 16 kS/s. Frame: n_fft samples (default 1024 = 64 ms), Hann window, hop n_fft/2 (default 512 =
32 ms). Per frame:
  1. Power per bin up to 4 kHz (dB SPL), smoothed over about four frames (exponential, 0.75 per 32 ms).
  2. Noise floor per bin: median over the first start-up frames, then a slow-up / fast-down tracker. The floor rises
     only while a bin is within GATE dB of it, so a line well above the floor does not raise its own floor.
  3. Whitened power W = power / floor, divided by its median over 80 Hz to 4 kHz (so a broadband rise, such as
     a gust, scores as flat).
  4. Comb: for each f0 on a 0.5 % log grid from 80 to 1200 Hz, and each of its first N harmonics (N = 4 kHz / f0,
     at most 16), the log ratio of the mean of W over a window of +-3 % around the harmonic (at least +-15.6 Hz) to
     the mean over flanking bins of the same width, clipped at 0. Flanks remove a smooth slope, such as wind.
  5. Track: a candidate is acquired at the best score above the threshold and followed for as long as its score
     stays above hold_ratio x threshold within 3 % per 32 ms (hold_ratio 1.0 by default). Persistence counts up on
     a hit and down on a miss. A candidate with a sub-harmonic at least SUB_RATIO times as strong takes over (octave
     errors). On after K_ON persistence, off after HOLD frames with no hit.
  Output per frame: score = (persistence / M) x comb score, f0, harmonic count, band level, floor, detected.

Time constants in Params are given in baseline hops (512 samples, 32 ms) and converted for the frame in use, by
to_frames(): a count of hops n becomes n x 512 / hop frames, a per-hop rate (dB) is multiplied by 512 / hop, and the
smoothing weight becomes smooth ** (hop / 512). So a setting keeps its meaning in seconds whatever the frame length.
Frequency-based settings keep their Hz meaning: the minimum comb half-width (15.6 Hz) and flank width (47 Hz), and
the start-up envelope half-width, scale with the bin width. The 3 % tolerances are relative and are unchanged.

State is a fixed set of arrays (state_bytes()); the tables are read-only (ROM). The CNN hook is combine_cnn().
"""

import dataclasses
import functools
import math
from dataclasses import dataclass

import numpy as np

FS = 16_000
REF_PA = 20e-6  # reference pressure for dB SPL
N = 1024  # baseline frame (samples), the default for Params.n_fft
HOP = 512  # baseline hop (samples, 32 ms); the time constants in Params are counted in these hops
REF_HOP = 512
F_HARM_LIMIT_HZ = 4000.0
F0_MIN, F0_MAX, F0_RATIO = 80.0, 1200.0, 1.005
N_HARM_MAX = 16
TOL = 0.03
SUB_RATIO = 0.85
GATE_LOG = math.log10(2.0)  # a candidate needs its fundamental at twice the median level (sub-multiples fail)
FINE_STEPS = 30  # fine f0 search: +-3 % around the track in 0.1 % steps
FINE_REL = 0.001
INIT_FRAMES = 8  # baseline start-up frames (256 ms) for the median floor
INIT_MIN_FRAMES = 3  # the start-up median never uses fewer frames than this (matters for long frames)
REF_FRAMES = 31  # baseline frames (1 s) before the track's reference f0 is refreshed
MIN_HALF_HZ = FS / 1024  # minimum comb half-width: one baseline bin (15.6 Hz)
MIN_FLANK_HZ = 3 * FS / 1024  # minimum flank width: three baseline bins (47 Hz)


@dataclass(frozen=True)
class Params:
    """Detector settings. Time constants (counts of frames, rates per frame) are in baseline hops of 512 samples;
    to_frames() converts them to the frame in use (n_fft, hop)."""

    theta: float = 0.16  # comb score (excess whitened power, ratio to the median) for a hit
    hold_ratio: float = 1.0  # an acquired track stays alive on scores >= hold_ratio x theta (0.5 tested: see report)
    k_on: int = 6  # persistence needed to switch on (baseline hops, about 0.19 s)
    m_win: int = 16  # persistence cap (baseline hops, about 0.5 s)
    hold_frames: int = 32  # off after this many hops with no hit (about 1 s)
    smooth: float = 0.75  # weight of the previous smoothed power, per baseline hop
    floor_up_db: float = 0.1  # per baseline hop, while a bin is within the gate of the floor
    floor_down_db: float = 0.5  # per baseline hop, while a bin is below the floor
    floor_gate_db: float = 6.0
    # rejection (steps can be switched off for the ablation)
    use_age: bool = True
    age_min: int = 62  # baseline hops (about 2 s) of continuous track before on
    good_frac: float = 0.7  # share of track frames with enough harmonics in place
    use_harm: bool = True
    harm_min: int = 2  # harmonics whose peak sits on k x f0 (within harm_tol) for a frame to count
    harm_tol: float = 0.04
    use_impulse: bool = True
    jump_db: float = 6.0  # broadband level above its running mean that marks an impulsive frame (dB, per frame)
    impulse_hold: int = 4  # baseline hops after an impulsive one that are also treated as impulsive (about 128 ms)
    use_slew: bool = False  # tested: coarse track jumps by octaves within 1 s, so the gate kills real tracks
    slew_ratio: float = 1.3  # max f0 change within one second of the track
    gap_frames: int = 0  # 0: a lost track resets its age (baseline). >0: a track re-found within this many hops
    #                      near its last f0 keeps its age and harmonic count (a short dropout does not restart the gate)
    gate_harm: int = 1  # the comb is kept only if one of the first gate_harm harmonics stands GATE_LOG above its flanks
    #                     (1: the fundamental alone, the baseline). With pink ambient the fundamental is buried first.
    init_frames: int = INIT_FRAMES  # baseline hops of start-up for the median floor (256 ms)
    ref_frames: int = REF_FRAMES  # baseline hops before the track's reference f0 is refreshed (1 s)
    init_env_bins: int = 0  # 0: start-up floor is the median over the start-up frames (baseline). >0: it is also capped
    #                         at the median over +-init_env_bins bins (at 1024 samples), so a line present at start-up
    #                         is not learned; the width scales with the bin width
    # frame
    n_fft: int = N  # frame length in samples (1024 baseline, 64 ms)
    hop: int = HOP  # hop in samples (512 baseline, 32 ms)


def _limits(n_fft, hop):
    if n_fft < 256 or n_fft > 16384 or hop <= 0 or hop > n_fft:
        raise ValueError(f"unsupported frame n_fft={n_fft} hop={hop}")


def to_frames(p):
    """Params with its time constants converted to the frame of p (n_fft, hop). Counts become frames and per-hop
    rates per frame; the result is what the tracker and the floor use. Idempotent only for hop = 512 (baseline)."""
    _limits(p.n_fft, p.hop)
    k = p.hop / REF_HOP  # frames per baseline hop = hop / 512 (time per frame in baseline hops)

    def count(x, floor_one=True):
        if x == 0:
            return 0
        v = int(round(x / k))
        return max(1, v) if floor_one else v

    fscale = p.n_fft / N  # bins per baseline bin
    return dataclasses.replace(
        p,
        smooth=p.smooth**k,
        floor_up_db=p.floor_up_db * k,
        floor_down_db=p.floor_down_db * k,
        k_on=count(p.k_on),
        m_win=count(p.m_win),
        hold_frames=count(p.hold_frames),
        age_min=count(p.age_min),
        impulse_hold=count(p.impulse_hold, floor_one=False),
        gap_frames=count(p.gap_frames, floor_one=False),
        init_env_bins=int(round(p.init_env_bins * fscale)),
        ref_frames=count(p.ref_frames),
        init_frames=max(INIT_MIN_FRAMES, int(round(p.init_frames / k))),
    )


def _tables(df, nb, lo_bin, min_half, min_flank, track_step_base):
    n = int(math.floor(math.log(F0_MAX / F0_MIN) / math.log(F0_RATIO))) + 1
    f0 = F0_MIN * F0_RATIO ** np.arange(n)
    k = np.arange(1, N_HARM_MAX + 1)
    nh = np.minimum(N_HARM_MAX, np.floor(F_HARM_LIMIT_HZ / f0)).astype(int)
    c = np.rint(f0[:, None] * k[None, :] / df).astype(int)
    half = np.maximum(min_half, np.rint(TOL * c).astype(int))
    valid = (k[None, :] <= nh[:, None]) & (c < nb)
    lo = np.clip(c - half, lo_bin, nb)  # window bins, [lo, hi1); invalid entries are clipped and masked
    hi1 = np.clip(c + half + 1, lo_bin, nb)
    width = np.maximum(hi1 - lo, 1)
    # flanks of the same width on each side, for the local baseline (removes a smooth spectral slope)
    fl = np.maximum(min_flank, 2 * half)
    a = np.clip(lo - fl, lo_bin, nb)
    b = np.clip(hi1 + fl, lo_bin, nb)
    flank = np.maximum((lo - a) + (b - hi1), 0)
    tables = dict(
        lo=lo, hi1=hi1, a=a, b=b,
        inv_win=np.where(valid, 1.0 / width, 0.0),
        inv_flank=np.where(valid & (flank > 0), 1.0 / np.maximum(flank, 1), 0.0),
        has_flank=valid & (flank > 0),
        valid=valid.astype(float),
    )
    # index of the grid entry nearest f0/m for m = 2, 3, 4, or -1 if none is within half a step
    sub = np.full((n, 4), -1, dtype=np.int16)
    for m in (2, 3, 4):
        target = f0 / m
        j = np.clip(np.rint(np.log(target / F0_MIN) / math.log(F0_RATIO)).astype(int), 0, n - 1)
        ok = np.abs(f0[j] / target - 1) < 0.5 * (F0_RATIO - 1)
        sub[:, m - 1] = np.where(ok & (target >= F0_MIN * 0.99), j, -1)
    track_step = int(round(TOL * track_step_base / math.log(F0_RATIO)))  # grid cells per 3 % of drift per frame
    return f0, nh, tables, sub, track_step


@dataclass(frozen=True, eq=False)
class Geometry:
    """Everything that depends on the frame length and hop (the read-only tables)."""

    n_fft: int
    hop: int
    N: int
    HOP: int
    NB: int  # bins 0..4 kHz
    DF: float
    LO_BIN: int
    HANN: np.ndarray
    HANN_POW: float
    F0: np.ndarray
    NH: np.ndarray
    TAB: dict
    SUB: np.ndarray
    VALID: np.ndarray
    GRID: int
    TRACK_STEP: int
    LOG_NH: np.ndarray


@functools.lru_cache(maxsize=None)
def geometry(n_fft=N, hop=HOP):
    _limits(n_fft, hop)
    df = FS / n_fft
    nb = int(round(F_HARM_LIMIT_HZ / df)) + 1
    lo_bin = int(math.ceil(F0_MIN / df))
    min_half = max(1, int(round(MIN_HALF_HZ / df)))
    min_flank = max(3, int(round(MIN_FLANK_HZ / df)))
    f0, nh, tab, sub, track_step = _tables(df, nb, lo_bin, min_half, min_flank, hop / REF_HOP)
    hann = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n_fft) / n_fft)
    valid = tab["valid"]
    return Geometry(
        n_fft=n_fft, hop=hop, N=n_fft, HOP=hop, NB=nb, DF=df, LO_BIN=lo_bin, HANN=hann,
        HANN_POW=float(np.sum(hann**2)), F0=f0, NH=nh, TAB=tab, SUB=sub, VALID=valid, GRID=len(f0),
        TRACK_STEP=track_step, LOG_NH=nh.astype(float),
    )


DEFAULT = geometry(N, HOP)
# Module-level names for the baseline frame (imported by the perimeter scripts and the tests).
NB = DEFAULT.NB
DF = DEFAULT.DF
LO_BIN = DEFAULT.LO_BIN
HANN = DEFAULT.HANN
HANN_POW = DEFAULT.HANN_POW
F0, NH, TAB, SUB = DEFAULT.F0, DEFAULT.NH, DEFAULT.TAB, DEFAULT.SUB
VALID = DEFAULT.VALID
GRID = DEFAULT.GRID
TRACK_STEP = DEFAULT.TRACK_STEP
LOG_NH = DEFAULT.LOG_NH


def ops_per_frame(geom=DEFAULT):
    """Approximate operation count per frame for an MCU port (multiply-add counts as one)."""
    nb, grid = geom.NB, geom.GRID
    fft = int(2.5 * geom.N * math.log2(geom.N))  # real FFT of N points
    window = geom.N
    power = 4 * nb
    floor = 6 * nb
    exp = 6 * nb  # whitened power, linear
    median = 5 * nb  # median by selection
    cumsum = nb
    comb = 4 * grid * N_HARM_MAX  # two gathers, one multiply, one excess
    tracker = 2 * geom.TRACK_STEP * 2 + 4 * grid + 30  # window search in the track, argmax over the grid
    return fft + window + power + floor + exp + median + cumsum + comb + tracker


def state_bytes(geom=DEFAULT):
    """RAM for the per-frame state at float32 (the port's type), and ROM for the tables."""
    nb, grid = geom.NB, geom.GRID
    ram = {
        "input frame (N)": 4 * geom.N,
        "smoothed power (NB)": 4 * nb,
        "noise floor (NB)": 4 * nb,
        "start-up frames for the median floor (8 NB)": 4 * INIT_FRAMES * nb,
        "prefix sums (NB+1)": 4 * (nb + 1),
        "comb scores (grid)": 4 * grid,
        "tracker (candidate, persistence, last hit, on)": 16,
    }
    rom = {
        "Hann window (N)": 4 * geom.N,
        "window bounds, lo and hi (grid x 16, int16)": 2 * 2 * grid * N_HARM_MAX,
        "window inverse counts and validity (grid x 16, float32)": 2 * 4 * grid * N_HARM_MAX,
        "sub-harmonic index table (grid x 3, int16)": 2 * grid * 3,
        "harmonic counts (grid, uint8)": grid,
    }
    return sum(ram.values()), ram, sum(rom.values()), rom


def harmonic_hits(W, c, tol, max_h=6, geom=DEFAULT):
    """Per harmonic k = 1..max_h of grid candidate c: True when its window peak sits on k x f0 (within tol) and stands
    at least 2x above its flanks. Measured on the whitened power W, so a bell or a bird with inharmonic partials
    scores low. Harmonics above the 4 kHz limit are False."""
    tab = geom.TAB
    hits = []
    for k in range(1, max_h + 1):
        if k > int(geom.NH[c]):
            hits.append(False)
            continue
        lo, hi1 = int(tab["lo"][c, k - 1]), int(tab["hi1"][c, k - 1])
        if hi1 <= lo:
            hits.append(False)
            continue
        b = lo + int(np.argmax(W[lo:hi1]))
        fa, fb = int(tab["a"][c, k - 1]), int(tab["b"][c, k - 1])
        flank = np.concatenate([W[fa:lo], W[hi1:fb]])
        if flank.size == 0 or W[b] < 2.0 * max(float(flank.mean()), 1e-30):
            hits.append(False)
            continue
        hits.append(abs(b * geom.DF / (geom.F0[c] * k) - 1) <= tol)
    return hits


def harmonic_count(W, c, tol, max_h=6, geom=DEFAULT):
    """Number of harmonics k = 1..max_h of grid candidate c that pass harmonic_hits."""
    return sum(harmonic_hits(W, c, tol, max_h, geom))


def harmonic_bits(W, c, geom=DEFAULT, max_h=6, tol=0.04):
    """Presence mask of harmonics 1..max_h of the candidate, one bit per harmonic (bit k-1 for harmonic k). This is
    what a node reports with its f0 for the gateway line match (6 bits, doc 07 section 11)."""
    return sum(1 << i for i, h in enumerate(harmonic_hits(W, c, tol, max_h, geom)) if h)


class Track:
    """Candidate track over frames, given comb scores S and whitened power W. The only part that depends on the
    threshold. A hit is a comb score above theta, with the harmonicity check and the slew gate passed. A track is
    on after k_on persistence and, with use_age, after age_min frames with harmonics present for good_frac of them.

    update() takes the Params as given (baseline hop units); they are converted to the frame once and cached.
    """

    def __init__(self, geom=DEFAULT):
        self.geom = geom
        self._src = None
        self._pf = None
        self.reset()

    def _frames(self, p):
        if p is not self._src:
            self._src, self._pf = p, to_frames(p)
        return self._pf

    def reset(self):
        self.q = 0
        self.index = -1
        self.last_hit = -10**9
        self.on = False
        self.t = -1
        self.age = 0
        self.good = 0
        self.ref = -1
        self.ref_t = 0
        self.dormant = None  # (index, age, good, frame of last hit) of the last track that lost its hits (gap_frames)

    def _hit_ok(self, S, W, c, p):
        if p.use_slew and self.ref >= 0 and abs(math.log(self.geom.F0[c] / self.geom.F0[self.ref])) > math.log(p.slew_ratio):
            return False, 0
        h = harmonic_count(W, c, p.harm_tol, geom=self.geom) if (p.use_harm or p.use_age) else 0
        return (not p.use_harm or h >= p.harm_min), h

    def update(self, S, W, params):
        p = self._frames(params)
        g = self.geom
        self.t += 1
        if self.q == 0:
            c = int(np.argmax(S))
            if S[c] >= p.theta:
                ok, h = self._hit_ok(S, W, c, p)
                if ok:
                    age, good = 1, int(h >= p.harm_min)
                    d = self.dormant
                    if p.gap_frames > 0 and d is not None and self.t - d[3] <= p.gap_frames and abs(c - d[0]) <= g.TRACK_STEP:
                        age, good = d[1] + 1, d[2] + int(h >= p.harm_min)  # the same source, after a short dropout
                    self.dormant = None
                    self.index, self.q, self.last_hit = c, 1, self.t
                    self.age, self.good = age, good
                    self.ref, self.ref_t = c, self.t
        else:
            lo = max(0, self.index - g.TRACK_STEP)
            hi = min(g.GRID - 1, self.index + g.TRACK_STEP)
            c = lo + int(np.argmax(S[lo : hi + 1]))
            ok, h = self._hit_ok(S, W, c, p) if S[c] >= p.theta * p.hold_ratio else (False, 0)
            if ok:
                self.index = c
                self.q = min(p.m_win, self.q + 1)
                self.last_hit = self.t
                self.age += 1
                self.good += int(h >= p.harm_min)
            else:
                self.q -= 1
                if self.q == 0:
                    if p.gap_frames > 0 and self.age > 0:
                        self.dormant = (self.index, self.age, self.good, self.last_hit)
                    self.index, self.age, self.good = -1, 0, 0
            if self.q > 0 and self.t - self.ref_t >= p.ref_frames:
                self.ref, self.ref_t = self.index, self.t
        if self.q > 0:
            for m in (3, 2, 1):  # sub-harmonic takeover: the lowest candidate that is nearly as strong
                j = g.SUB[self.index, m]
                if j >= 0 and S[j] >= SUB_RATIO * S[self.index]:
                    self.index = int(j)
                    break
            if self.q >= p.k_on:
                if not p.use_age or (self.age >= p.age_min and self.good >= p.good_frac * self.age):
                    self.on = True
        if self.on and self.t - self.last_hit > p.hold_frames:
            self.on = False
        return self.on


class Detector:
    def __init__(self, params=Params()):
        self.p = params
        self.pf = to_frames(params)
        self.geom = geometry(params.n_fft, params.hop)
        self.reset()

    def reset(self):
        self.ps = None
        self.init_L = []
        self.floor = None
        self.n_seen = 0
        self.bb_prev = 0.0
        self.impulse_left = 0
        self.track = Track(self.geom)
        self.s_max = 0.0

    def frame_power(self, x):
        """Calibrated power per bin of one frame (mean-square density, Pa^2 per bin)."""
        g = self.geom
        X = np.fft.rfft(x * g.HANN)[: g.NB]
        return 2.0 * (X.real**2 + X.imag**2) / (g.N * g.HANN_POW)

    def comb(self, P):
        """Comb scores S and whitened power W of one frame. (None, None) during start-up."""
        S, W, ok = self.comb_batch(P[None, :])
        return (S[0], W[0]) if ok[0] else (None, None)

    def comb_batch(self, P):
        """Smoothing, floor and comb for consecutive frames P (n, NB). The smoothing and the floor are sequential
        and carry state between calls; the comb is vectorised over the frames. Returns (S, W, ok): comb scores
        (n, GRID), whitened power (n, NB), and ok (n,) which is False during start-up (those rows are zero)."""
        p = self.pf
        g = self.geom
        n = P.shape[0]
        Ls = np.empty((n, g.NB))
        for i in range(n):
            self.ps = P[i].copy() if self.ps is None else p.smooth * self.ps + (1 - p.smooth) * P[i]
            Ls[i] = 10 * np.log10(self.ps + 1e-20)
        W = np.zeros((n, g.NB))
        ok = np.zeros(n, bool)
        imp = np.zeros(n, bool)
        bb = 10 * np.log10(P[:, g.LO_BIN :].sum(axis=1) + 1e-20)
        for i in range(n):
            if self.n_seen + i < p.init_frames:
                self.init_L.append(Ls[i])
                continue
            if self.floor is None:
                self.floor = np.median(np.array(self.init_L), axis=0)
                if p.init_env_bins > 0:  # a narrow line at start-up is above its local median: cap the floor there
                    w = p.init_env_bins
                    padded_floor = np.pad(self.floor, w, mode="edge")
                    env = np.median(np.lib.stride_tricks.sliding_window_view(padded_floor, 2 * w + 1), axis=1)
                    self.floor = np.minimum(self.floor, env)
            # impulsive frame: broadband level jumps by jump_db from the previous frame, and the frames after it
            # for impulse_hold; no floor update and no hit. A sustained rise passes after the hold.
            jump = p.use_impulse and (bb[i] - self.bb_prev > p.jump_db or self.impulse_left > 0)
            if p.use_impulse:
                self.impulse_left = p.impulse_hold if bb[i] - self.bb_prev > p.jump_db else max(0, self.impulse_left - 1)
            self.bb_prev = bb[i]
            imp[i] = jump
            L = Ls[i]
            if not jump:
                below = L < self.floor
                inside = (~below) & (L <= self.floor + p.floor_gate_db)
                self.floor += np.where(below, -p.floor_down_db, np.where(inside, p.floor_up_db, 0.0))
            W[i] = np.power(10.0, (L - self.floor) / 10.0)
            ok[i] = True
        self.n_seen += n
        S = np.zeros((n, g.GRID), np.float32)
        if not ok.any():
            return S, W, ok
        Wk = W[ok]
        Wk[:, : g.LO_BIN] = 0.0  # bins below the comb's lowest f0 are not used: a high-pass edge must not whiten into lines
        W[ok] = Wk
        tab = g.TAB
        cs = np.concatenate([np.zeros((Wk.shape[0], 1)), np.cumsum(Wk, axis=1)], axis=1)
        win = (cs[:, tab["hi1"]] - cs[:, tab["lo"]]) * tab["inv_win"]
        fl = (cs[:, tab["lo"]] - cs[:, tab["a"]] + cs[:, tab["b"]] - cs[:, tab["hi1"]]) * tab["inv_flank"]
        ratio = np.where(tab["has_flank"], win / np.maximum(fl, 1e-30), 1.0)
        E = np.log10(np.maximum(ratio, 1.0)) * g.VALID
        gate = E[:, :, : p.gate_harm].max(axis=2) >= GATE_LOG
        S[ok] = E.sum(axis=2) / g.NH * gate
        S[imp] = 0.0
        self.s_max = float(S[ok][-1].max())
        return S, W, ok

    def step(self, P):
        """One frame from its bin powers P (length NB). Returns (score, f0, nharm, band_db, floor_db, on)."""
        S, W, ok = self.comb_batch(P[None, :])
        if not ok[0]:
            return 0.0, 0.0, 0, 0.0, 0.0, False
        return self._outputs(self.track.update(S[0], W[0], self.p), S[0], W[0], P)

    def _outputs(self, on, S, W, P):
        g = self.geom
        q, b = self.track.q, self.track.index
        score = (q / self.pf.m_win) * float(S[b]) if q > 0 else 0.0
        f0 = float(g.F0[b]) if q > 0 else 0.0
        nharm = int(g.NH[b]) if q > 0 else 0
        if on and q > 0:
            f0, nharm = self.fine_f0(W, f0)
        if nharm:
            lo_b = int(math.ceil(0.5 * f0 / g.DF))
            hi_b = min(g.NB - 1, int(nharm * f0 / g.DF))
            band_db = 10 * math.log10(max(float(P[lo_b : hi_b + 1].sum()), 1e-30) / REF_PA**2)
            floor_db = float(np.mean(self.floor[lo_b : hi_b + 1]))
        else:
            band_db, floor_db = 10 * math.log10(max(float(P.sum()), 1e-30) / REF_PA**2), float(np.mean(self.floor))
        return score, f0, nharm, band_db, floor_db, on

    def fine_f0(self, W, f_coarse):
        """Sub-grid f0: the candidate within +-3 % of the track that maximises the log of W, sampled at each exact
        harmonic position by linear interpolation between bins."""
        g = self.geom
        f = f_coarse * (1 + FINE_REL * np.arange(-FINE_STEPS, FINE_STEPS + 1))
        nh = np.minimum(N_HARM_MAX, np.floor(F_HARM_LIMIT_HZ / f)).astype(int)
        k = np.arange(1, N_HARM_MAX + 1)
        x = f[:, None] * k[None, :] / g.DF
        ok = (k[None, :] <= nh[:, None]) & (x < g.NB - 1)
        xc = np.minimum(x, g.NB - 2)
        i0 = np.floor(xc).astype(int)
        fr = xc - i0
        val = W[i0] * (1 - fr) + W[i0 + 1] * fr
        E = np.log10(np.maximum(val, 1.0)) * ok
        S = E.sum(axis=1) / np.maximum(nh, 1)
        j = int(np.argmax(S))
        return float(f[j]), int(nh[j])

    def run(self, x, chunk=512):
        """Whole signal: dict of per-frame arrays and the frame centre times (s)."""
        self.reset()
        g = self.geom
        frames = np.lib.stride_tricks.sliding_window_view(x, g.N)[:: g.HOP]
        n_frames = len(frames)
        out = {k: np.zeros(n_frames) for k in ("score", "f0", "nharm", "band_db", "floor_db")}
        out["on"] = np.zeros(n_frames, bool)
        for c0 in range(0, n_frames, chunk):
            P = self.power_frames(frames[c0 : c0 + chunk])
            S, W, ok = self.comb_batch(P)
            for j in np.flatnonzero(ok):
                i = c0 + j
                on = self.track.update(S[j], W[j], self.p)
                r = self._outputs(on, S[j], W[j], P[j])
                out["score"][i], out["f0"][i], out["nharm"][i], out["band_db"][i], out["floor_db"][i], out["on"][i] = r
        out["t"] = (np.arange(n_frames) * g.HOP + g.N / 2) / FS
        return out

    def power_frames(self, frames):
        """Batch FFT of frames (n, N). Stateless, so it equals the per-frame power."""
        g = self.geom
        X = np.fft.rfft(frames * g.HANN)[:, : g.NB]
        return 2.0 * (X.real**2 + X.imag**2) / (g.N * g.HANN_POW)


def combine_cnn(score, cnn_probability=None):
    """Hook for the CNN stage: when a CNN exists, its probability multiplies the comb score here."""
    return score if cnn_probability is None else score * cnn_probability
