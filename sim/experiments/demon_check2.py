# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""A stricter test of demon_check.py: is the envelope result real, and how does it compare with the real detector?

Differences: more mics around each hover, a third aircraft, a longer bed so a threshold of 0.1 % of 2 s windows can be set, the
actual comb detector (detector.py at theta 0.10) as the control, and the pitch each method reports, so a mic artefact shows up as a
pitch that disagrees across mics or with the rotor lines. Local audio; only aggregates are printed.

Detector Pd is the share of trials, 8 s of bed then 20 s of drone, with the detector on in the last 14 s, and its false rate is the same on bed-only trials. These
are not the same test as a window threshold: compare them as rough scales only.

Run:  uv run sim/experiments/demon_check2.py
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
sys.path.insert(0, str(ROOT / "sim" / "experiments"))

from acoustics.background import rural_scene  # noqa: E402
from acoustics.model import FS, SELF_NOISE_DB  # noqa: E402
from acoustics.noise import white  # noqa: E402
from acoustics.recording import read_mono, resample_to_fs  # noqa: E402
from demon_check import BANDS, ENV_FS, F0_GRID, MAX_HARM_HZ, WIN_S, Comb, env_spectrum, plain_spectrum, to_range  # noqa: E402
from detector.detector import Detector, Params  # noqa: E402

CLIPS = {"Matrice 300": "Ed_M3_10_H00_N_C_nw_ev1", "Mini 3 Pro": "Ed_3p_10_H00_N_C_nw_ev1", "Third type (Yn)": "Ed_Yn_10_H00_Y_C_nw_ev1"}
# Mic and its distance from the drone (10 m below it, lateral angles from doc 03).
LOOKS = {"M1": 20.0, "M3": 11.5, "M5": 10.0, "M7": 11.5, "M9": 20.0}
RANGES_M = [25, 50, 100, 150, 200, 300]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--windows", type=int, default=40)
    ap.add_argument("--null", type=int, default=3000)
    ap.add_argument("--det-trials", type=int, default=6)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    rng = np.random.default_rng(2612)
    n = int(WIN_S * FS)
    bed, _ = rural_scene(1235, 1.0, (1, 2, 3))
    sos = {b: signal.butter(4, b, btype="band", fs=FS, output="sos") for b in BANDS}
    comb_p = Comb(FS / 1024, len(plain_spectrum(np.zeros(n))), MAX_HARM_HZ["plain"])
    comb_e = Comb(ENV_FS / (ENV_FS // 2), len(env_spectrum(np.zeros(n), sos[BANDS[0]])), MAX_HARM_HZ["env"])

    def raw(x):
        out = {"plain": comb_p.scores(plain_spectrum(x))}
        for b in BANDS:
            out[b] = comb_e.scores(env_spectrum(x, sos[b]))
        return out

    methods = ["plain", *BANDS]
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

    thr = {m: {q: float(np.percentile([best(m, v)[0] for v in held[m]], q)) for q in (99, 99.9)} for m in methods}
    name = lambda m: "plain" if m == "plain" else f"env {m[0] / 1000:g}-{m[1] / 1000:g}"

    def detector_on(x):
        d = Detector(Params(theta=0.10, sub_guard=True))
        d.reset()
        out = d.run(x)
        on = np.asarray(out["on"] if isinstance(out, dict) else out[0], dtype=bool)
        return bool(on[len(on) // 2 :].any())

    # The detector hears bed alone first, since a source present from start-up is learned into its floor (doc 07 section 7).
    lead = 8 * FS
    m_det = 20 * FS
    false_on = sum(detector_on(bed[o : o + lead + m_det] + white(rng, lead + m_det, SELF_NOISE_DB)) for o in rng.integers(0, len(bed) - lead - m_det, 24))
    print(f"detector on, bed only: {false_on} of 24 trials", flush=True)

    rows = []
    data = ROOT / "data" / "dronenoise"
    for label, stem in CLIPS.items():
        for mic, dist in LOOKS.items():
            x, sr = read_mono(data / f"{stem}_{mic}.wav")
            src = resample_to_fs(x, sr) * dist
            for r in RANGES_M:
                far = to_range(src, r)
                hit = {m: {99: 0, 99.9: 0} for m in methods}
                pitches = {m: [] for m in methods}
                for _ in range(args.windows):
                    a = int(rng.integers(0, len(far) - n))
                    off = int(rng.integers(0, len(bed) - n))
                    s = raw(far[a : a + n] + bed[off : off + n] + white(rng, n, SELF_NOISE_DB))
                    for m in methods:
                        z, f = best(m, s[m])
                        for q in (99, 99.9):
                            if z >= thr[m][q]:
                                hit[m][q] += 1
                        if z >= thr[m][99.9]:
                            pitches[m].append(f)
                on = 0
                m_clip = min(len(far), m_det)
                for _ in range(args.det_trials):
                    off = int(rng.integers(0, len(bed) - lead - m_clip))
                    y = bed[off : off + lead + m_clip] + white(rng, lead + m_clip, SELF_NOISE_DB)
                    y[lead:] += far[: m_clip]
                    on += detector_on(y)
                row = dict(clip=label, mic=mic, range_m=r, detector=on / args.det_trials,
                           pd={name(m): {str(q): hit[m][q] / args.windows for q in (99, 99.9)} for m in methods},
                           median_pitch={name(m): float(np.median(pitches[m])) if pitches[m] else None for m in methods})
                rows.append(row)
                cells = "  ".join(f"{name(m)} {hit[m][99.9] / args.windows:.2f}" + (f"@{np.median(pitches[m]):.0f}" if pitches[m] else "") for m in methods)
                print(f"{label:16s} {mic} {r:4d} m  detector {on}/{args.det_trials}  {cells}", flush=True)
    print("Cells: Pd at 0.1 % of bed windows @ median pitch of hits (Hz).")
    if args.json:
        Path(args.json).write_text(json.dumps(dict(false_on=false_on, thresholds={name(m): thr[m] for m in methods}, rows=rows), indent=1))


if __name__ == "__main__":
    main()
