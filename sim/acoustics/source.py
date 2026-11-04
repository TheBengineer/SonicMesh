"""Quadrotor source: four rotors with ten harmonics, optional wobble and blade-modulated broadband.

Emitted pressure in Pa at 1 m. Ported from web/src/acoustics/sources.ts and tdoa_feasibility.py, vectorised.
"""

import math

import numpy as np
from scipy import signal

from .model import CLASS, FS, N_HARM, PHASE_STEP, REF_PA, ROTOR_OFFSETS, WOBBLE

COMMON_HZ = 0.3  # slow thrust changes, shared by the four rotors
ATTITUDE_HZ = 6.0  # per-rotor attitude control
BB_REL = 0.5  # broadband weight relative to unit harmonics
BB_BAND = (150.0, 3000.0)


def ar1(rng, n, hz, sigma, fs=FS):
    """Zero-mean noise with std sigma and a one-pole low-pass at hz, sampled at fs."""
    a = math.exp(-2 * math.pi * hz / fs)
    w = rng.standard_normal(n) * (sigma * math.sqrt(1 - a * a))
    return signal.lfilter([1.0], [1.0, -a], w)


def drone_source(cls, factor, rng=None, wobble=False, broadband=False):
    """Pressure at 1 m for a drone of class cls. factor[s] is the rotor speed factor at sample s.

    With wobble or broadband set, rng supplies the random terms. The deterministic branch is the one the golden
    renderer checks against the TypeScript engine, so it keeps its operation order.
    """
    bpf, level = CLASS[cls]
    h = np.arange(1, N_HARM + 1, dtype=float)
    amp = h**-0.7
    gain = REF_PA * 10 ** (level / 20) / math.sqrt(2 * np.sum(h**-1.4))
    n = factor.size
    sigma = WOBBLE[cls]
    common = ar1(rng, n, COMMON_HZ, sigma) if wobble else None
    out = np.zeros(n)
    blade = np.zeros(n)
    for i in range(4):
        if wobble:
            rate = 1 + common + ar1(rng, n, ATTITUDE_HZ, sigma)
            phase = np.cumsum(bpf * (1 + ROTOR_OFFSETS[i]) * factor * rate / FS)
        else:
            phase = np.cumsum(bpf * (1 + ROTOR_OFFSETS[i]) * factor / FS)
        if broadband:
            blade += np.sin(2 * math.pi * phase)
        for k in range(N_HARM):
            phi = 2 * math.pi * (((i * N_HARM + k) * PHASE_STEP) % 1.0)
            out += amp[k] * np.sin(2 * math.pi * (k + 1) * phase + phi)
    if broadband:
        sos = signal.butter(4, BB_BAND, btype="band", fs=FS, output="sos")
        w = signal.sosfilt(sos, rng.standard_normal(n))
        out += BB_REL * (w / w.std()) * (1 + 0.25 * blade)
    return gain * out
