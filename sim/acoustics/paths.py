"""Propagation: retarded delay, ground image, air absorption, and the per-block path sum.

Mirrors web/src/acoustics/propagate.ts. Flat ground only.
"""

import math
from functools import cache

import numpy as np

from .model import ABS_DB_KM, ABS_F, AIR_DESIGN_N, AIR_GRID_M, AIR_MAX_M, AIR_TAPS, BLOCK, C, FS


def pose(tr, tt, mirror_z):
    x = np.interp(tt, tr["t"], tr["x"])
    y = np.interp(tt, tr["t"], tr["y"])
    z = np.interp(tt, tr["t"], tr["z"])
    if mirror_z is not None:
        z = mirror_z - z
    return x, y, z


def dist(tr, tt, rx, mirror_z):
    x, y, z = pose(tr, tt, mirror_z)
    return np.sqrt((x - rx[0]) ** 2 + (y - rx[1]) ** 2 + (z - rx[2]) ** 2)


def solve_delay(tr, tt, rx, mirror_z):
    tau = dist(tr, tt, rx, mirror_z) / C
    for _ in range(3):
        tau = dist(tr, tt - tau, rx, mirror_z) / C
    return np.maximum(tau, 1.0 / C)


def absorption_db_per_km(f):
    return np.interp(f, ABS_F, ABS_DB_KM)


def air_fir(r):
    """Minimum-phase FIR of the ISO attenuation over distance r, as airFir() in propagate.ts."""
    n = AIR_DESIGN_N
    f = np.arange(n // 2 + 1) * FS / n
    half = -absorption_db_per_km(f) * (r / 1000.0) * math.log(10) / 20
    full = np.concatenate([half, half[-2:0:-1]])
    c = np.real(np.fft.ifft(full))
    cf = np.zeros(n)
    cf[0] = c[0]
    cf[1 : n // 2] = 2 * c[1 : n // 2]
    cf[n // 2] = c[n // 2]
    h = np.real(np.fft.ifft(np.exp(np.fft.fft(cf))))
    return h[:AIR_TAPS]


@cache
def air_table():
    return np.array([air_fir(g * AIR_GRID_M) for g in range(int(round(AIR_MAX_M / AIR_GRID_M)) + 1)])


def air_taps(r):
    """Taps for distance r, linear between grid points, as AirFilter.setDistance() in propagate.ts."""
    table = air_table()
    grid_n = len(table) - 1
    g = min(max(r / AIR_GRID_M, 0.0), float(grid_n))
    i0 = min(int(math.floor(g)), grid_n - 1)
    t = g - i0
    return (1 - t) * table[i0] + t * table[i0 + 1]


def interp4(buf, pos, pad):
    """4-tap Lagrange read of buf at fractional sample positions; buf starts pad samples before sample 0."""
    k = np.floor(pos).astype(np.int64)
    f = pos - k
    i = k + pad
    cm1 = -f * (f - 1) * (f - 2) / 6
    c0 = (f + 1) * (f - 1) * (f - 2) / 2
    c1 = -(f + 1) * f * (f - 2) / 2
    c2 = (f + 1) * f * (f - 1) / 6
    return cm1 * buf[i - 1] + c0 * buf[i] + c1 * buf[i + 1] + c2 * buf[i + 2]


def new_air():
    return {"hist": np.zeros(AIR_TAPS - 1)}


def path_block(out, n0, src, tr, rx, mirror_z, gain, air, pad, base=0, size=BLOCK, delay_fn=None, gain_fn=None):
    """Adds one block of one path. out holds samples from absolute index base; the block starts at n0.

    The delay is solved at the first and last sample and interpolated between them. delay_fn(t) adds a small
    delay in s and gain_fn(t) a multiplicative gain, both per sample (turbulence).
    """
    t_a = float(solve_delay(tr, np.array([n0 / FS]), rx, mirror_z)[0])
    t_b = float(solve_delay(tr, np.array([(n0 + size - 1) / FS]), rx, mirror_z)[0])
    tau = t_a + (t_b - t_a) * np.arange(size) / (size - 1)
    t_s = (n0 + np.arange(size)) / FS
    if delay_fn is not None:
        tau = tau + delay_fn(t_s)
    v = interp4(src, n0 + np.arange(size) - tau * FS, pad) / (C * tau) * gain
    if gain_fn is not None:
        v = v * gain_fn(t_s)
    x = np.concatenate([air["hist"], v])
    i0 = n0 - base
    out[i0 : i0 + size] += np.convolve(x, air_taps(C * t_a))[AIR_TAPS - 1 : AIR_TAPS - 1 + size]
    air["hist"] = x[-(AIR_TAPS - 1) :]
