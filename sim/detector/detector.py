"""Harmonic-comb detector, baseline (Phase 1).

Input: pressure in Pa at 16 kS/s. Frame: 1024 samples (64 ms), Hann window, hop 512 (32 ms). Per frame:
  1. Power per bin up to 4 kHz (dB SPL), smoothed over about four frames (exponential, 0.75).
  2. Noise floor per bin: median over the first 8 frames, then a slow-up / fast-down tracker. The floor rises
     only while a bin is within GATE dB of it, so a line well above the floor does not raise its own floor.
  3. Whitened power W = power / floor, divided by its median over 80 Hz to 4 kHz (so a broadband rise, such as
     a gust, scores as flat).
  4. Comb: for each f0 on a 0.5 % log grid from 80 to 1200 Hz, and each of its first N harmonics (N = 4 kHz / f0,
     at most 16), the log ratio of the mean of W over a window of +-3 % around the harmonic (at least +-1 bin) to
     the mean over flanking bins of the same width, clipped at 0. Flanks remove a smooth slope, such as wind.
  5. Track: a candidate is acquired at the best score above the threshold and followed for as long as its score
     stays above the threshold within 3 % per frame. Persistence counts up on a hit and down on a miss. A candidate
     with a sub-harmonic at least SUB_RATIO times as strong takes over (octave errors). On after K_ON persistence,
     off after HOLD frames with no hit.
  Output per frame: score = (persistence / M) x comb score, f0, harmonic count, band level, floor, detected.

State is a fixed set of arrays (state_bytes()); the tables are read-only (ROM). The CNN hook is combine_cnn().
"""

import math
from dataclasses import dataclass

import numpy as np

FS = 16_000
N = 1024
HOP = 512
NB = 257  # bins 0..4 kHz
DF = FS / N
REF_PA = 20e-6
F_HARM_LIMIT_HZ = 4000.0
F0_MIN, F0_MAX, F0_RATIO = 80.0, 1200.0, 1.005
N_HARM_MAX = 16
TOL = 0.03
SUB_RATIO = 0.85
GATE_LOG = math.log10(2.0)  # a candidate needs its fundamental at twice the median level (sub-multiples fail)
FINE_STEPS = 30  # fine f0 search: +-3 % around the track in 0.1 % steps
FINE_REL = 0.001
INIT_FRAMES = 8
LO_BIN = int(math.ceil(F0_MIN / DF))
HANN = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N)
HANN_POW = float(np.sum(HANN**2))


@dataclass(frozen=True)
class Params:
    theta: float = 0.16  # comb score (excess whitened power, ratio to the median) for a hit
    k_on: int = 6  # persistence needed to switch on
    m_win: int = 16  # persistence cap (about 0.5 s)
    hold_frames: int = 32  # off after this many frames with no hit (about 1 s)
    smooth: float = 0.75  # weight of the previous smoothed power
    floor_up_db: float = 0.1  # per frame, while a bin is within the gate of the floor
    floor_down_db: float = 0.5  # per frame, while a bin is below the floor
    floor_gate_db: float = 6.0
    # rejection (steps can be switched off for the ablation)
    use_age: bool = True
    age_min: int = 62  # frames (about 2 s) of continuous track before on
    good_frac: float = 0.7  # share of track frames with enough harmonics in place
    use_harm: bool = True
    harm_min: int = 2  # harmonics whose peak sits on k x f0 (within harm_tol) for a frame to count
    harm_tol: float = 0.04
    use_impulse: bool = True
    jump_db: float = 6.0  # broadband level above its running mean that marks an impulsive frame
    impulse_hold: int = 4  # frames after an impulsive one that are also treated as impulsive
    use_slew: bool = False  # tested: coarse track jumps by octaves within 1 s, so the gate kills real tracks
    slew_ratio: float = 1.3  # max f0 change within one second of the track


def _tables():
    n = int(math.floor(math.log(F0_MAX / F0_MIN) / math.log(F0_RATIO))) + 1
    f0 = F0_MIN * F0_RATIO ** np.arange(n)
    k = np.arange(1, N_HARM_MAX + 1)
    nh = np.minimum(N_HARM_MAX, np.floor(F_HARM_LIMIT_HZ / f0)).astype(int)
    c = np.rint(f0[:, None] * k[None, :] / DF).astype(int)
    half = np.maximum(1, np.rint(TOL * c).astype(int))
    valid = (k[None, :] <= nh[:, None]) & (c < NB)
    lo = np.clip(c - half, LO_BIN, NB)  # window bins, [lo, hi1); invalid entries are clipped and masked
    hi1 = np.clip(c + half + 1, LO_BIN, NB)
    width = np.maximum(hi1 - lo, 1)
    # flanks of the same width on each side, for the local baseline (removes a smooth spectral slope)
    fl = np.maximum(3, 2 * half)
    a = np.clip(lo - fl, LO_BIN, NB)
    b = np.clip(hi1 + fl, LO_BIN, NB)
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
    return f0, nh, tables, sub


F0, NH, TAB, SUB = _tables()
VALID = TAB["valid"]
GRID = len(F0)
TRACK_STEP = int(round(TOL / math.log(F0_RATIO)))  # grid cells per 3 % of drift
LOG_NH = NH.astype(float)


def ops_per_frame():
    """Approximate operation count per frame for an MCU port (multiply-add counts as one)."""
    fft = int(2.5 * N * math.log2(N))  # real FFT of N points
    window = N
    power = 4 * NB
    floor = 6 * NB
    exp = 6 * NB  # whitened power, linear
    median = 5 * NB  # median by selection
    cumsum = NB
    comb = 4 * GRID * N_HARM_MAX  # two gathers, one multiply, one excess
    tracker = 2 * TRACK_STEP * 2 + 4 * GRID + 30  # window search in the track, argmax over the grid
    return fft + window + power + floor + exp + median + cumsum + comb + tracker


def state_bytes():
    """RAM for the per-frame state at float32 (the port's type), and ROM for the tables."""
    ram = {
        "input frame (N)": 4 * N,
        "smoothed power (NB)": 4 * NB,
        "noise floor (NB)": 4 * NB,
        "start-up frames for the median floor (8 NB)": 4 * INIT_FRAMES * NB,
        "prefix sums (NB+1)": 4 * (NB + 1),
        "comb scores (grid)": 4 * GRID,
        "tracker (candidate, persistence, last hit, on)": 16,
    }
    rom = {
        "Hann window (N)": 4 * N,
        "window bounds, lo and hi (grid x 16, int16)": 2 * 2 * GRID * N_HARM_MAX,
        "window inverse counts and validity (grid x 16, float32)": 2 * 4 * GRID * N_HARM_MAX,
        "sub-harmonic index table (grid x 3, int16)": 2 * GRID * 3,
        "harmonic counts (grid, uint8)": GRID,
    }
    return sum(ram.values()), ram, sum(rom.values()), rom


def harmonic_count(W, c, tol, max_h=6):
    """Harmonics k = 1..max_h of grid candidate c whose window peak sits on k x f0 (within tol) and stands at least
    2x above its flanks. Measured on the whitened power W, so a bell or a bird with inharmonic partials scores low."""
    cnt = 0
    for k in range(1, min(max_h, int(NH[c])) + 1):
        lo, hi1 = int(TAB["lo"][c, k - 1]), int(TAB["hi1"][c, k - 1])
        if hi1 <= lo:
            continue
        b = lo + int(np.argmax(W[lo:hi1]))
        fa, fb = int(TAB["a"][c, k - 1]), int(TAB["b"][c, k - 1])
        flank = np.concatenate([W[fa:lo], W[hi1:fb]])
        if flank.size == 0 or W[b] < 2.0 * max(float(flank.mean()), 1e-30):
            continue
        if abs(b * DF / (F0[c] * k) - 1) <= tol:
            cnt += 1
    return cnt


class Track:
    """Candidate track over frames, given comb scores S and whitened power W. The only part that depends on the
    threshold. A hit is a comb score above theta, with the harmonicity check and the slew gate passed. A track is
    on after k_on persistence and, with use_age, after age_min frames with harmonics present for good_frac of them.
    """

    def __init__(self):
        self.reset()

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

    def _hit_ok(self, S, W, c, p):
        if p.use_slew and self.ref >= 0 and abs(math.log(F0[c] / F0[self.ref])) > math.log(p.slew_ratio):
            return False, 0
        h = harmonic_count(W, c, p.harm_tol) if (p.use_harm or p.use_age) else 0
        return (not p.use_harm or h >= p.harm_min), h

    def update(self, S, W, p):
        self.t += 1
        if self.q == 0:
            c = int(np.argmax(S))
            if S[c] >= p.theta:
                ok, h = self._hit_ok(S, W, c, p)
                if ok:
                    self.index, self.q, self.last_hit = c, 1, self.t
                    self.age, self.good = 1, int(h >= p.harm_min)
                    self.ref, self.ref_t = c, self.t
        else:
            lo = max(0, self.index - TRACK_STEP)
            hi = min(GRID - 1, self.index + TRACK_STEP)
            c = lo + int(np.argmax(S[lo : hi + 1]))
            ok, h = self._hit_ok(S, W, c, p) if S[c] >= p.theta else (False, 0)
            if ok:
                self.index = c
                self.q = min(p.m_win, self.q + 1)
                self.last_hit = self.t
                self.age += 1
                self.good += int(h >= p.harm_min)
            else:
                self.q -= 1
                if self.q == 0:
                    self.index, self.age, self.good = -1, 0, 0
            if self.q > 0 and self.t - self.ref_t >= 31:
                self.ref, self.ref_t = self.index, self.t
        if self.q > 0:
            for m in (3, 2, 1):  # sub-harmonic takeover: the lowest candidate that is nearly as strong
                j = SUB[self.index, m]
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
        self.reset()

    def reset(self):
        self.ps = None
        self.init_L = []
        self.floor = None
        self.n_seen = 0
        self.bb_prev = 0.0
        self.impulse_left = 0
        self.track = Track()
        self.s_max = 0.0

    def frame_power(self, x):
        """Calibrated power per bin of one frame (mean-square density, Pa^2 per bin)."""
        X = np.fft.rfft(x * HANN)[:NB]
        return 2.0 * (X.real**2 + X.imag**2) / (N * HANN_POW)

    def comb(self, P):
        """Comb scores S and whitened power W of one frame. (None, None) during start-up."""
        S, W, ok = self.comb_batch(P[None, :])
        return (S[0], W[0]) if ok[0] else (None, None)

    def comb_batch(self, P):
        """Smoothing, floor and comb for consecutive frames P (n, NB). The smoothing and the floor are sequential
        and carry state between calls; the comb is vectorised over the frames. Returns (S, W, ok): comb scores
        (n, GRID), whitened power (n, NB), and ok (n,) which is False during start-up (those rows are zero)."""
        p = self.p
        n = P.shape[0]
        Ls = np.empty((n, NB))
        for i in range(n):
            self.ps = P[i].copy() if self.ps is None else p.smooth * self.ps + (1 - p.smooth) * P[i]
            Ls[i] = 10 * np.log10(self.ps + 1e-20)
        W = np.zeros((n, NB))
        ok = np.zeros(n, bool)
        imp = np.zeros(n, bool)
        bb = 10 * np.log10(P[:, LO_BIN:].sum(axis=1) + 1e-20)
        for i in range(n):
            if self.n_seen + i < INIT_FRAMES:
                self.init_L.append(Ls[i])
                continue
            if self.floor is None:
                self.floor = np.median(np.array(self.init_L), axis=0)
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
        S = np.zeros((n, GRID), np.float32)
        if not ok.any():
            return S, W, ok
        Wk = W[ok]
        Wk[:, :LO_BIN] = 0.0  # bins below 94 Hz are not used: a high-pass edge must not whiten into lines
        W[ok] = Wk
        cs = np.concatenate([np.zeros((Wk.shape[0], 1)), np.cumsum(Wk, axis=1)], axis=1)
        win = (cs[:, TAB["hi1"]] - cs[:, TAB["lo"]]) * TAB["inv_win"]
        fl = (cs[:, TAB["lo"]] - cs[:, TAB["a"]] + cs[:, TAB["b"]] - cs[:, TAB["hi1"]]) * TAB["inv_flank"]
        ratio = np.where(TAB["has_flank"], win / np.maximum(fl, 1e-30), 1.0)
        E = np.log10(np.maximum(ratio, 1.0)) * VALID
        S[ok] = E.sum(axis=2) / NH * (E[:, :, 0] >= GATE_LOG)
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
        q, b = self.track.q, self.track.index
        score = (q / self.p.m_win) * float(S[b]) if q > 0 else 0.0
        f0 = float(F0[b]) if q > 0 else 0.0
        nharm = int(NH[b]) if q > 0 else 0
        if on and q > 0:
            f0, nharm = self.fine_f0(W, f0)
        if nharm:
            lo_b = int(math.ceil(0.5 * f0 / DF))
            hi_b = min(NB - 1, int(nharm * f0 / DF))
            band_db = 10 * math.log10(max(float(P[lo_b : hi_b + 1].sum()), 1e-30) / REF_PA**2)
            floor_db = float(np.mean(self.floor[lo_b : hi_b + 1]))
        else:
            band_db, floor_db = 10 * math.log10(max(float(P.sum()), 1e-30) / REF_PA**2), float(np.mean(self.floor))
        return score, f0, nharm, band_db, floor_db, on

    def fine_f0(self, W, f_coarse):
        """Sub-grid f0: the candidate within +-3 % of the track that maximises the log of W, sampled at each exact
        harmonic position by linear interpolation between bins."""
        f = f_coarse * (1 + FINE_REL * np.arange(-FINE_STEPS, FINE_STEPS + 1))
        nh = np.minimum(N_HARM_MAX, np.floor(F_HARM_LIMIT_HZ / f)).astype(int)
        k = np.arange(1, N_HARM_MAX + 1)
        x = f[:, None] * k[None, :] / DF
        ok = (k[None, :] <= nh[:, None]) & (x < NB - 1)
        xc = np.minimum(x, NB - 2)
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
        frames = np.lib.stride_tricks.sliding_window_view(x, N)[::HOP]
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
        out["t"] = (np.arange(n_frames) * HOP + N / 2) / FS
        return out

    def power_frames(self, frames):
        """Batch FFT of frames (n, N). Stateless, so it equals the per-frame power."""
        X = np.fft.rfft(frames * HANN)[:, :NB]
        return 2.0 * (X.real**2 + X.imag**2) / (N * HANN_POW)


def combine_cnn(score, cnn_probability=None):
    """Hook for the CNN stage: when a CNN exists, its probability multiplies the comb score here."""
    return score if cnn_probability is None else score * cnn_probability
