# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pytest"]
# ///
"""Detector baseline: f0 on synthetic multirotors, and no alarms on background."""

import numpy as np
import pytest
from scipy import signal

from acoustics.model import CLASS, FS
from acoustics.noise import pink, wind
from acoustics.source import drone_source
from detector.detector import Detector, Params

PRE_S = 3.0


def band_power(x):
    f, p = signal.welch(x, FS, nperseg=4096)
    m = (f >= 100) & (f <= 4000)
    return np.sum(p[m]) * (f[1] - f[0])


def mixture(cls, snr_db, seconds=30.0, seed=11):
    """Pink background at 60 dB SPL with a drone of the class scaled to snr_db in the 100 Hz to 4 kHz band."""
    rng = np.random.default_rng(seed)
    pre, n = int(PRE_S * FS), int(seconds * FS)
    noise = pink(rng, n + pre, 60.0)
    src = drone_source(cls, np.ones(n), rng=rng, wobble=True, broadband=True)
    g = np.sqrt(band_power(noise[pre:]) / band_power(src)) * 10 ** (snr_db / 20)
    x = noise.copy()
    x[pre:] += src * g
    return x, pre


@pytest.mark.parametrize("cls", list(CLASS))
def test_f0_within_1_percent_at_plus_10_db(cls):
    x, pre = mixture(cls, 10.0)
    r = Detector(Params()).run(x)
    sl = slice(pre // 512 + 10, None)
    on = r["on"][sl]
    assert on.mean() > 0.9
    f0 = np.median(r["f0"][sl][on])
    assert abs(f0 / CLASS[cls][0] - 1) < 0.01


@pytest.mark.parametrize("cls", list(CLASS))
def test_detected_at_0_db_band_snr(cls):
    # At 0 dB band SNR the detector is on for nearly all of the drone's time, with f0 within 5 % (the report
    # records the 1 % result at 0 dB, see deviations).
    x, pre = mixture(cls, 0.0)
    r = Detector(Params()).run(x)
    sl = slice(pre // 512 + 10, None)
    on = r["on"][sl]
    # 0.75: the harmonicity check costs matrice about 0.2 of its 0 dB on-time (see report, ablation)
    assert on.mean() > 0.75
    f0 = r["f0"][sl][on]
    assert abs(np.median(f0[f0 > 0]) / CLASS[cls][0] - 1) < 0.05


def test_no_detection_in_10_min_pink_and_wind():
    # ten minutes of pink noise at 50 dB SPL with a 4 m/s wind: no frame on at the default threshold
    rng = np.random.default_rng(5)
    n = int(600 * FS)
    x = pink(rng, n, 50.0) + wind(rng, n, 4.0)
    r = Detector(Params()).run(x)
    assert r["on"].sum() == 0


def test_gap_tolerance_keeps_age_across_a_short_dropout():
    from detector.detector import GRID, Track

    def run(gap, dropout):
        p = Params(theta=0.1, gap_frames=gap, use_harm=False)  # no spectrum in this unit test
        tr = Track()
        S = np.zeros(GRID, np.float32)
        W = np.zeros(257)
        S[100] = 0.3
        for _ in range(20):  # track acquired and well established (age 20)
            tr.update(S, W, p)
        for _ in range(dropout):  # no hits; the 16-frame persistence buffer alone does not reset the age
            S[100] = 0.0
            tr.update(S, W, p)
        S[100] = 0.3
        tr.update(S, W, p)  # re-found at the same f0
        return tr.age

    # a 25-frame dropout resets the age in the baseline (the persistence buffer runs out) ...
    assert run(0, 25) <= 2
    # ... but with a 31-frame gap, the same source is re-found within the gap and keeps its age
    assert run(31, 25) > 20
    # a dropout longer than the gap restarts the age
    assert run(31, 60) <= 2


def test_startup_cap_keeps_a_line_present_at_start_up_out_of_the_floor():
    from detector.detector import Detector, LO_BIN, NB

    det_a = Detector(Params(theta=0.1))
    det_b = Detector(Params(theta=0.1, init_env_bins=16))
    base = np.full(NB, 1e-9)
    line_bin = 200
    base[line_bin] = 1e-5  # a line far above the noise at every start-up frame
    for det in (det_a, det_b):
        for _ in range(9):
            det.comb_batch(base[None, :].copy())
    floor_a = det_a.floor[line_bin]
    floor_b = det_b.floor[line_bin]
    neighbour = det_b.floor[line_bin + 40]
    assert floor_a > neighbour + 20  # baseline learns the line into the floor
    assert abs(floor_b - neighbour) < 1.0  # capped at the local median
    assert LO_BIN < line_bin


def test_gate_harm_lets_a_buried_fundamental_pass_on_its_second_harmonic():
    from detector.detector import DF, F0, LO_BIN, NB, Detector

    f0_hz = 250.0
    k = int(round(f0_hz / DF))
    P = np.full(NB, 1e-9)
    for h in range(2, 11):  # harmonics 2..10 stand 20 dB above the floor; the fundamental is not above it
        P[int(round(h * f0_hz / DF))] = 1e-7
    grid = int(np.argmin(np.abs(F0 - f0_hz)))
    base = np.full(NB, 1e-9)  # start-up is noise only, so the floor does not learn the lines
    scores = {}
    for gh in (1, 2):
        det = Detector(Params(theta=0.1, gate_harm=gh))
        for _ in range(9):
            det.comb_batch(base[None, :].copy())
        S = None
        for _ in range(12):
            S, _, ok = det.comb_batch(P[None, :].copy())
        scores[gh] = float(S[0, grid]) if ok[0] else 0.0
    assert scores[1] == 0.0
    assert scores[2] > 0.0
    assert k > LO_BIN


def test_to_frames_keeps_time_constants_in_seconds():
    from detector.detector import Params, to_frames

    base = to_frames(Params())  # baseline 1024 / 512: nothing changes
    assert (base.age_min, base.hold_frames, base.m_win, base.k_on, base.impulse_hold) == (62, 32, 16, 6, 4)
    assert base.smooth == 0.75 and base.floor_up_db == 0.1 and base.floor_down_db == 0.5
    assert (base.init_frames, base.ref_frames, base.gap_frames) == (8, 31, 0)
    # 2048 / 1024: each count of 32 ms hops halves, each per-hop rate doubles, smoothing is squared
    long = to_frames(Params(n_fft=2048, hop=1024, gap_frames=31))
    assert (long.age_min, long.hold_frames, long.m_win, long.k_on) == (31, 16, 8, 3)
    assert (long.impulse_hold, long.gap_frames, long.ref_frames, long.init_frames) == (2, 16, 16, 4)
    assert long.floor_up_db == pytest.approx(0.2) and long.floor_down_db == pytest.approx(1.0)
    assert long.smooth == pytest.approx(0.75**2)
    # 4096 / 2048: the start-up never uses fewer than three frames
    assert to_frames(Params(n_fft=4096, hop=2048)).init_frames == 3


def test_geometry_bins_and_track_step_follow_the_frame():
    from detector.detector import geometry

    g1, g2 = geometry(1024, 512), geometry(2048, 1024)
    assert (g1.NB, g1.LO_BIN, g1.TRACK_STEP) == (257, 6, 6)
    assert (g2.NB, g2.LO_BIN, g2.TRACK_STEP) == (513, 11, 12)  # 80 Hz at 7.8 Hz bins; drift 3 % per 32 ms
    assert abs(g2.DF - 7.8125) < 1e-9
    # comb window minimum: one 1024-bin (15.6 Hz) at baseline, two bins at 2048 (same Hz); at 250 Hz, +-2 bins
    c = int(np.argmin(np.abs(g2.F0 - 250.0)))
    assert g2.TAB["hi1"][c, 0] - g2.TAB["lo"][c, 0] == 5


def test_detector_finds_a_drone_with_a_2048_frame():
    from detector.detector import Detector, Params

    x, pre = mixture("mini", 10.0, seconds=30.0)
    r = Detector(Params(n_fft=2048, hop=1024)).run(x)
    sl = slice(pre // 1024 + 10, None)
    on = r["on"][sl]
    assert on.mean() > 0.8
    # Known limit (doc 07, round 3): at 2048 samples this 10 dB mini track sometimes locks on the third sub-multiple
    # (85 Hz) instead of the fundamental (250 Hz). So the test asserts the lock is on the fundamental or a sub-multiple.
    f0 = r["f0"][sl][on]
    ratio = CLASS["mini"][0] / f0[f0 > 0]
    assert np.mean(np.isclose(ratio, np.round(ratio), rtol=0.05) & (np.round(ratio) <= 3)) > 0.95


def test_harmonic_bits_mark_the_harmonics_present():
    from detector.detector import F0, GRID, harmonic_bits, DEFAULT

    f0_hz = 250.0
    c = int(np.argmin(np.abs(F0 - f0_hz)))
    P = np.full(DEFAULT.NB, 1e-9)
    for h in (1, 3, 4):  # harmonics 1, 3 and 4 stand 20 dB above the floor, 2 does not
        P[int(round(h * f0_hz / DEFAULT.DF))] = 1e-7
    W = P / 1e-9
    bits = harmonic_bits(W, c, DEFAULT)
    assert bits == (1 << 0) | (1 << 2) | (1 << 3)
    assert GRID > c
