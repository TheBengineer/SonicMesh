# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Does rotor modulation of broadband noise carry a detectable blade rate at range, on real recordings?

Sonar calls this DEMON: take the envelope of a higher band and look for the blade rate in its spectrum. The simulator's
broadband modulation is assumed, so this runs on the DroneNoise hover clips (local only; only aggregate numbers are printed).

Each clip is taken back to 1 m, scaled and absorbed to a range, and mixed into the rural tuning bed (pink ambient, wind and
ESC-50 events, folds 1-3) with mic self-noise. Over 2 s windows it scores a harmonic comb on the plain spectrum and on the
envelope spectrum, with one comb function for both, and sets each threshold at 1 % of bed-only windows. Pd is the share of
drone windows above it. Pitch ok is the share of those whose pitch relates to what the same method finds on the clean clip.
Each candidate pitch is scored against its own mean and spread on the bed. The plain tone at 10 and 25 m is the control: if it does
not detect there, the test is broken and says nothing about the envelope.

ASSUMED: the DroneNoise calibration (see acoustics/recording.py), a hover at one look angle, no ground image, no turbulence.
M1 and M9 look 60 degrees off vertical, which is the nearest these clips come to how a far node sees a drone.

Run:  uv run sim/experiments/demon_check.py
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))

from acoustics.background import rural_scene  # noqa: E402
from acoustics.model import FS, SELF_NOISE_DB  # noqa: E402
from acoustics.noise import white  # noqa: E402
from acoustics.paths import absorption_db_per_km  # noqa: E402
from acoustics.recording import read_mono, resample_to_fs  # noqa: E402

WIN_S = 2.0
RANGES_M = [10, 25, 50, 100, 150, 200, 300, 400]
CLIPS = {"Matrice 300": "M3", "Mini 3 Pro": "3p"}
# Mic, and its distance from the drone in metres (10 m below it, at the lateral angles in doc 03).
LOOKS = {"below (M5)": ("M5", 10.0), "side (M1)": ("M1", 20.0), "side (M9)": ("M9", 20.0)}
BANDS = [(500.0, 2000.0), (1000.0, 3000.0), (2000.0, 6000.0)]
ENV_FS = 4000
F0_GRID = 80.0 * 1.005 ** np.arange(0, int(np.log(1000.0 / 80.0) / np.log(1.005)) + 1)
MAX_HARM = 16
MAX_HARM_HZ = {"plain": 4000.0, "env": 1600.0}


class Comb:
    """Harmonic comb on a power spectrum: mean log ratio of each harmonic's peak to its flanks, best pitch."""

    def __init__(self, df, nb, limit_hz):
        rows = []
        for f0 in F0_GRID:
            row = [int(round(h * f0 / df)) for h in range(1, MAX_HARM + 1) if h * f0 <= limit_hz]
            rows.append([k for k in row if 6 <= k < nb - 7])
        self.rows = rows

    def scores(self, p):
        """The comb score of every candidate pitch."""
        cs = np.concatenate([[0.0], np.cumsum(p)])
        out = np.zeros(len(self.rows))
        for i, row in enumerate(self.rows):
            if row:
                k = np.array(row)
                win = np.maximum(np.maximum(p[k - 1], p[k]), p[k + 1])
                flank = (cs[k - 1] - cs[k - 6] + cs[k + 7] - cs[k + 2]) / 10.0
                out[i] = np.mean(np.maximum(0.0, np.log10(win / np.maximum(flank, 1e-30))))
        return out


def plain_spectrum(x):
    return signal.welch(x, FS, window="hann", nperseg=1024, noverlap=512, detrend=False)[1]


def env_spectrum(x, sos):
    e = signal.sosfilt(sos, x) ** 2
    e = signal.resample_poly(e, 1, FS // ENV_FS)
    # 0.5 s segments give 2 Hz bins, wide enough for the rotor wobble in doc 03.
    return signal.welch(e - e.mean(), ENV_FS, window="hann", nperseg=ENV_FS // 2, noverlap=ENV_FS // 4, detrend=False)[1]


def to_range(src_1m, r):
    """A 1 m source at range r: spreading and air absorption."""
    spec = np.fft.rfft(src_1m)
    f = np.fft.rfftfreq(len(src_1m), 1 / FS)
    spec *= 10 ** (-absorption_db_per_km(np.maximum(f, 1.0)) * (r / 1000.0) / 20)
    return np.fft.irfft(spec, len(src_1m)) / r


def related(f, base):
    return any(abs(f / base * b / a - 1) < 0.04 for a in range(1, 5) for b in range(1, 5))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--windows", type=int, default=60, help="drone windows per clip, look and range")
    ap.add_argument("--null", type=int, default=600, help="bed-only windows for each threshold")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    rng = np.random.default_rng(2611)
    n = int(WIN_S * FS)
    bed, _ = rural_scene(1234, 0.25, (1, 2, 3))
    sos = {b: signal.butter(4, b, btype="band", fs=FS, output="sos") for b in BANDS}
    df_p = FS / 1024
    probe = plain_spectrum(np.zeros(n))
    comb_p = Comb(df_p, len(probe), MAX_HARM_HZ["plain"])
    probe_e = env_spectrum(np.zeros(n), sos[BANDS[0]])
    comb_e = Comb(ENV_FS / (ENV_FS // 2), len(probe_e), MAX_HARM_HZ["env"])

    def raw(x):
        out = {"plain": comb_p.scores(plain_spectrum(x))}
        for b in BANDS:
            out[b] = comb_e.scores(env_spectrum(x, sos[b]))
        return out

    methods = ["plain", *BANDS]
    # A candidate with few harmonics swings more by chance, so each pitch is scored against its own spread on the bed.
    # Half the bed windows set those statistics, and the other half set the thresholds.
    fit = {m: [] for m in methods}
    held = {m: [] for m in methods}
    for i in range(args.null):
        off = int(rng.integers(0, len(bed) - n))
        s = raw(bed[off : off + n] + white(rng, n, SELF_NOISE_DB))
        for m in methods:
            (fit if i % 2 == 0 else held)[m].append(s[m])
    mean = {m: np.mean(fit[m], axis=0) for m in methods}
    std = {m: np.maximum(np.std(fit[m], axis=0), 1e-6) for m in methods}

    def best(m, v):
        z = (v - mean[m]) / std[m]
        i = int(np.argmax(z))
        return float(z[i]), float(F0_GRID[i])

    def scores(x):
        s = raw(x)
        return {m: best(m, s[m]) for m in methods}

    thr = {m: float(np.percentile([best(m, v)[0] for v in held[m]], 99)) for m in methods}
    thr_half = {m: float(np.percentile([best(m, v)[0] for v in held[m]], 99.5)) for m in methods}

    name = lambda m: "plain tone" if m == "plain" else f"envelope {m[0] / 1000:g}-{m[1] / 1000:g} kHz"
    results = []
    data = ROOT / "data" / "dronenoise"
    for label, tag in CLIPS.items():
        for look, (mic, dist) in LOOKS.items():
            x, sr = read_mono(data / f"Ed_{tag}_10_H00_N_C_nw_ev1_{mic}.wav")
            src = resample_to_fs(x, sr) * dist
            clean = scores(src[: int(WIN_S * FS) * 4] / 10.0)
            for r in RANGES_M:
                far = to_range(src, r)
                hits = {m: 0 for m in methods}
                ok = {m: 0 for m in methods}
                either = {m: 0 for m in BANDS}
                for _ in range(args.windows):
                    a = int(rng.integers(0, len(far) - n))
                    off = int(rng.integers(0, len(bed) - n))
                    s = scores(far[a : a + n] + bed[off : off + n] + white(rng, n, SELF_NOISE_DB))
                    for m in methods:
                        if s[m][0] >= thr[m]:
                            hits[m] += 1
                            ok[m] += related(s[m][1], clean[m][1])
                    for m in BANDS:
                        either[m] += s["plain"][0] >= thr_half["plain"] or s[m][0] >= thr_half[m]
                row = dict(clip=label, look=look, range_m=r,
                           pd={name(m): hits[m] / args.windows for m in methods},
                           pitch_ok={name(m): ok[m] / max(hits[m], 1) for m in methods},
                           either={name(m): either[m] / args.windows for m in BANDS})
                results.append(row)
                print(f"{label:12s} {look:11s} {r:4d} m  " + "  ".join(
                    f"{name(m).replace('envelope ', 'env ')} {hits[m] / args.windows:.2f}/{ok[m] / max(hits[m], 1):.2f}" for m in methods), flush=True)
    print("Each cell: Pd at 1 % of bed windows / pitch ok among hits.")
    if args.json:
        Path(args.json).write_text(json.dumps(dict(thresholds={name(m): thr[m] for m in methods}, rows=results), indent=1))


if __name__ == "__main__":
    main()
