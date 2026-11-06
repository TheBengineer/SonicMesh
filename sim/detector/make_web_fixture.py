# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Writes web/tests/fixtures/comb_parity.json: what detector.py decides, frame by frame, on deterministic signals.
web/tests/comb.test.ts builds the same signals and holds the browser port to these decisions."""

import json
import math
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from detector import FS, Detector, Params

SECONDS = 14
AMBIENT_PA = 20e-6 * 10 ** (40 / 20)
OUT = Path(__file__).resolve().parents[2] / "web" / "tests" / "fixtures" / "comb_parity.json"


def noise(n, seed):
    """Uniform noise from a 32-bit LCG, the same in the test, through one pole for a falling spectrum."""
    out = np.empty(n)
    state = seed
    y = 0.0
    for i in range(n):
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        y = 0.9 * y + (state / 2**32 - 0.5)
        out[i] = y
    return out * AMBIENT_PA * 6


def harmonics(n, f0, amp, count, drift=0.0):
    """A harmonic stack whose f0 drifts by a fraction of itself over the signal, active in the middle 10 s."""
    t = np.arange(n) / FS
    phase = 2 * np.pi * f0 * (t + drift * t * t / (2 * SECONDS))
    x = sum(math.sqrt(2) * amp / k * np.sin(k * phase) for k in range(1, count + 1))
    return x * ((t >= 2) & (t < 12))


def signal(name):
    n = SECONDS * FS
    x = noise(n, 12345)
    t = np.arange(n) / FS
    if name == "drone_250":
        x = x + harmonics(n, 250.0, AMBIENT_PA * 2, 8, 0.02)
    elif name == "drone_100_weak":
        x = x + harmonics(n, 100.0, AMBIENT_PA * 0.6, 12)
    elif name == "drone_600_fading":
        x = x + harmonics(n, 600.0, AMBIENT_PA * 1.5, 5) * (1 - t / SECONDS)
    elif name == "vehicle_broadband":
        # A loud passing vehicle with no harmonic stack: the same noise, 20 dB louder at the pass.
        x = x * (1 + 9 * np.exp(-(((t - 7) / 3) ** 2)))
    elif name == "clicks":
        for i in range(2 * FS, 12 * FS, 11200):
            x[i : i + 40] += AMBIENT_PA * 40 * np.exp(-np.arange(40) / 8)
    elif name != "noise":
        raise ValueError(name)
    return x.astype(np.float32).astype(float)


CASES = [
    ("noise", {}),
    ("drone_250", {}),
    ("drone_100_weak", {}),
    ("drone_600_fading", {}),
    ("vehicle_broadband", {}),
    ("clicks", {}),
    ("drone_250", {"n_fft": 4096, "hop": 2048}),
    ("drone_100_weak", {"n_fft": 8192, "hop": 4096, "floor_up_db": 0.05, "gate_harm": 2}),
    ("drone_600_fading", {"gap_frames": 16, "init_env_bins": 8, "hold_ratio": 0.5}),
]


def main():
    out = []
    for name, overrides in CASES:
        d = Detector(replace(Params(), **overrides))
        d.reset()
        g = d.geom
        x = signal(name)
        rows = {k: [] for k in ("on", "q", "index", "f0", "score", "band", "floor", "peak")}
        for start in range(0, len(x) - g.N + 1, g.HOP):
            P = d.frame_power(x[start : start + g.N])
            S, W, ok = d.comb_batch(P[None, :])
            if ok[0]:
                on = d.track.update(S[0], W[0], d.p)
                score, f0, _, band, floor, on = d._outputs(on, S[0], W[0], P)
                peak = float(S[0].max())
            else:
                score, f0, band, floor, on, peak = 0.0, 0.0, 0.0, 0.0, False, 0.0
            rows["on"].append(int(on))
            rows["q"].append(d.track.q)
            rows["index"].append(d.track.index)
            rows["f0"].append(round(f0, 4))
            rows["score"].append(round(float(score), 5))
            rows["band"].append(round(band, 3))
            rows["floor"].append(round(floor, 3))
            rows["peak"].append(round(peak, 5))
        out.append({"signal": name, "params": overrides, **rows})
        print(name, overrides, "frames", len(rows["on"]), "on", sum(rows["on"]), "tracked", sum(q > 0 for q in rows["q"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"seconds": SECONDS, "cases": out}, separators=(",", ":")))
    print(OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
