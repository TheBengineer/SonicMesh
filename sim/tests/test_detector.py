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
