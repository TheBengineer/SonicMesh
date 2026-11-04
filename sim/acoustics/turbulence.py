"""Atmospheric turbulence on each drone-to-mic path: slow delay jitter and log-amplitude scintillation.

ASSUMED parameters, scaled to the 300 m values of tdoa_feasibility.py (0.2 ms travel-time jitter) and to
1 to 3 dB scintillation at 300 m. Both grow with the square root of range. Seeded by the caller's rng.
"""

import numpy as np

from .model import TICK_S
from .source import ar1

SIGMA_TAU_300M_S = 0.2e-3
SIGMA_DB_300M = 2.0
TAU_HZ = 1.0
SCINT_HZ = 2.0


def turbulence(rng, tick_t, range_m, strength=1.0):
    """Returns (delay_fn, gain_fn) for one path. range_m is the path length at each tick, tick_t the tick times.

    delay_fn(t) is in s, gain_fn(t) is a linear multiplier, both per sample time t.
    strength 0 gives no turbulence.
    """
    rng_m = np.asarray(range_m, dtype=float)
    scale = np.sqrt(np.maximum(rng_m, 1.0) / 300.0) * strength
    tau_track = scale * SIGMA_TAU_300M_S * ar1(rng, len(tick_t), TAU_HZ, 1.0, fs=1 / TICK_S)
    db_track = SIGMA_DB_300M * scale * ar1(rng, len(tick_t), SCINT_HZ, 1.0, fs=1 / TICK_S)

    def delay_fn(t):
        return np.interp(t, tick_t, tau_track)

    def gain_fn(t):
        return 10 ** (np.interp(t, tick_t, db_track) / 20)

    return delay_fn, gain_fn
