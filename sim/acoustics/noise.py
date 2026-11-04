"""Self noise, diffuse ambient noise and wind at the microphone. Pressure in Pa."""

import math

import numpy as np
from scipy import signal

from .model import FS, REF_PA
from .source import ar1

WIND_BAND_HZ = 200.0  # wind energy sits below this
WIND_DB_BASE = 30.0  # ASSUMED: overall wind noise, dB SPL = base + slope * speed
WIND_DB_SLOPE = 5.0
GUST_HZ = 0.2  # ASSUMED gust envelope bandwidth
GUST_DEPTH = 0.4  # relative std of the gust envelope


def pa(db_spl):
    return REF_PA * 10 ** (db_spl / 20)


def white(rng, n, db_spl):
    return pa(db_spl) * rng.standard_normal(n)


def pink(rng, n, db_spl, lo=100.0, hi=4000.0):
    """Pink noise shaped in the FFT, band-limited to lo..hi Hz, with the rms set by db_spl."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / FS)
    spec[(f < lo) | (f > hi)] = 0
    spec[1:] /= np.sqrt(f[1:])
    x = np.fft.irfft(spec, n)
    return x * (pa(db_spl) / x.std())


def wind_db(speed_ms):
    return WIND_DB_BASE + WIND_DB_SLOPE * speed_ms


def wind(rng, n, speed_ms, fs=FS):
    """Gusty low-frequency noise at the mic: 4th-order low-pass at 200 Hz times a slow gust envelope.

    The overall level follows wind_db(); zero wind gives silence.
    """
    if speed_ms <= 0:
        return np.zeros(n)
    sos = signal.butter(4, WIND_BAND_HZ, btype="low", fs=fs, output="sos")
    x = signal.sosfilt(sos, rng.standard_normal(n))
    m = int(math.ceil(n / fs / 0.1)) + 2  # gust envelope every 100 ms
    env = 1 + GUST_DEPTH * ar1(rng, m, GUST_HZ, 1.0, fs=10.0)
    env = np.maximum(env, 0.1)
    t = np.arange(n) / fs
    x = x * np.interp(t, np.arange(m) * 0.1, env)
    return x * (pa(wind_db(speed_ms)) / x.std())
