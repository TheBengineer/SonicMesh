"""Real recordings used as the emitted source: DroneNoise hover clips and the user's onboard FPV clip.

DroneNoise (University of Salford, CC BY 4.0): centre mic M5 is 10 m below the hovering drone. Its samples are
taken as pressure in Pa at 10 m (ASSUMED calibration), so the 1 m source is 10 times larger (1/r spreading).
The onboard FPV clip has no known calibration: its 100 Hz to 4 kHz rms is set to a class level at 1 m (ASSUMED).
"""

import math
from fractions import Fraction

import numpy as np
from scipy import signal
from scipy.io import wavfile

from .model import FS, REF_PA

DRONENOISE_HEIGHT_M = 10.0


def read_mono(path, channel=None):
    """(samples as float64, sample rate). Integer files are scaled to full scale. Multichannel files use channel
    (0-based) or the mean."""
    sr, raw = wavfile.read(path)
    x = raw.astype(np.float64)
    if raw.dtype.kind == "i":
        x = x / float(np.iinfo(raw.dtype).max + 1)
    if x.ndim > 1:
        x = x[:, channel] if channel is not None else x.mean(axis=1)
    return x, sr


def resample_to_fs(x, sr):
    ratio = Fraction(FS, sr).limit_denominator(1000)
    return signal.resample_poly(x, ratio.numerator, ratio.denominator)


def dronenoise_source(path, channel=None):
    """Emitted pressure at 1 m (Pa) from a DroneNoise centre-mic clip."""
    x, sr = read_mono(path, channel)
    return resample_to_fs(x, sr) * DRONENOISE_HEIGHT_M


_BAND = signal.butter(4, (100.0, 4000.0), btype="band", fs=FS, output="sos")


def onboard_source(path, start_s, end_s, level_db_1m):
    """Emitted pressure at 1 m from an onboard clip between start_s and end_s, band rms set to level_db_1m."""
    x, sr = read_mono(path)
    x = resample_to_fs(x[int(start_s * sr) : int(end_s * sr)], sr)
    rms = np.sqrt(np.mean(signal.sosfilt(_BAND, x) ** 2))
    return x * (REF_PA * 10 ** (level_db_1m / 20) / rms)


def loop(x, n, xf_s=0.1):
    """x repeated to n samples, with equal-power crossfades of xf_s at each join."""
    xf = int(round(xf_s * FS))
    period = len(x) - xf
    out = np.zeros(n + len(x))
    fade_in = np.sin(np.linspace(0, math.pi / 2, xf)) ** 2
    w = np.ones(len(x))
    w[:xf] = fade_in
    w[-xf:] = 1 - fade_in
    k = 0
    while k * period < n:
        s = k * period
        out[s : s + len(x)] += x * w
        k += 1
    return out[:n]
