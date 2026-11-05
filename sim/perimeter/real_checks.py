# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Real-audio checks for the detector.

1. DroneNoise hover clips (Matrice 300, Mini 3 Pro; all nine mics, 10 m hover): the detector must be on for each mic,
   and its f0 must match a harmonic peak of the centre mic (peaks from sim/experiments/real_hover_analysis.py).
2. The same clips as emitted sources (centre mic, back-propagated to 1 m), propagated to a stationary node 50 to
   400 m away at 30 m altitude, over ESC-50 folds 4-5 background at 50 dB SPL with self noise: Pd vs range.
3. The user's onboard FPV clip (21.5-33.5 s), as an emitted source at 85 dB SPL at 1 m (ASSUMED calibration),
   checked directly and propagated the same way.

Run:  uv run sim/perimeter/real_checks.py [--trials N]
"""

import argparse
import importlib.util
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))

from acoustics.background import bed, manifest  # noqa: E402
from acoustics.model import BLOCK, DETECTOR_MIC_H_M, FS, SELF_NOISE_DB  # noqa: E402
from acoustics.noise import white  # noqa: E402
from acoustics.recording import dronenoise_source, loop, onboard_source, read_mono, resample_to_fs  # noqa: E402
from acoustics.scene import padded, render_mic  # noqa: E402
from detector.detector import HOP, Detector  # noqa: E402

DATA = ROOT / "data"
HOVER_M = 30.0
RANGES_M = [50, 100, 200, 300, 400]
TRIAL_S = 60.0
WARM_S = 10.0
PAD_S = 6.0
BED_LEVEL_DB = 50.0
FPV_LEVEL_DB = 85.0
FPV_SPAN = (21.5, 33.5)
DRONES = {"Matrice 300": "M3", "Mini 3 Pro": "3p"}
F0_TOL = 0.05  # a detection must report the source's own f0 to within 5 %


def load_peaks():
    spec = importlib.util.spec_from_file_location("hover", ROOT / "sim" / "experiments" / "real_hover_analysis.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def detect_on(x):
    """(share of frames on after warm-up, median f0 over the on frames, on flags, f0 per frame) for 16 kS/s."""
    r = Detector().run(x)
    start = int(WARM_S * FS / HOP)
    on = r["on"][start:]
    f0 = r["f0"][start:][on]
    return on.mean(), (float(np.median(f0)) if f0.size else None), r["on"], r["f0"]


def propagate(src_1m, rng, r_m, bed_x, n):
    """Stationary hover at (r, 0, HOVER_M) seen by a node at the origin, plus the bed and self noise."""
    t = np.arange(0, n / FS + 0.02, 0.01)
    tr = {"t": t, "x": np.full(t.size, float(r_m)), "y": np.zeros(t.size), "z": np.full(t.size, HOVER_M),
          "rotor": np.ones(t.size)}
    sig = render_mic(padded(src_1m, int(PAD_S * FS)), int(PAD_S * FS), tr, (0.0, 0.0, DETECTOR_MIC_H_M), 0, n,
                     block=BLOCK * 10)
    return sig + bed_x[:n] + white(rng, n, SELF_NOISE_DB)


def trial_pd(src_1m, rows, trials, seed, f0_ref):
    """Share of trials that detect the source, per range. A trial is a 60 s loop of the source over the bed. It is a
    hit when some frame after warm-up is on with f0 within F0_TOL of the source's own f0 (f0_ref, measured on the
    source alone). Any-on-frame counts would include the bed's false alarms, so they are not used."""
    n = int(TRIAL_S * FS)
    start_frame = int(WARM_S * FS / HOP)
    out = {}
    for r_m in RANGES_M:
        hits = 0
        for k in range(trials):
            rng = np.random.default_rng(seed + 1000 * r_m + k)
            bed_x, _ = bed(seed + 7 * r_m + k, rows, TRIAL_S + 2.0, BED_LEVEL_DB)
            start = int(rng.integers(0, max(1, src_1m.size - FS)))
            src = loop(np.roll(src_1m, -start), n, xf_s=0.1)
            _, _, on, f0 = detect_on(propagate(src, rng, r_m, bed_x, n))
            on, f0 = on[start_frame:], f0[start_frame:]
            hits += int(np.any(on & (np.abs(f0 / f0_ref - 1) <= F0_TOL)))
        out[r_m] = hits / trials
    return out


def bed_only_alarms(rows, trials, seed, f0_refs):
    """Control, no drone: share of bed-only trials with any on frame after warm-up (any f0), and, for each reference
    f0, with an on frame within F0_TOL of it. The same trial length and bed level as the propagated checks."""
    n = int(TRIAL_S * FS)
    start_frame = int(WARM_S * FS / HOP)
    any_hits, f0_hits = 0, {f: 0 for f in f0_refs}
    for k in range(trials):
        bed_x, _ = bed(seed + 99 + k, rows, TRIAL_S + 2.0, BED_LEVEL_DB)
        rng = np.random.default_rng(seed + k)
        sig = bed_x[:n] + white(rng, n, SELF_NOISE_DB)
        _, _, on, f0 = detect_on(sig)
        on, f0 = on[start_frame:], f0[start_frame:]
        any_hits += int(on.any())
        for f in f0_refs:
            f0_hits[f] += int(np.any(on & (np.abs(f0 / f - 1) <= F0_TOL)))
    return any_hits / trials, {f: h / trials for f, h in f0_hits.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--trials", type=int, default=10)
    args = ap.parse_args()
    peaks_mod = load_peaks()
    rows = manifest(folds={4, 5}, exclude=("wind",))

    any_on, per_f0 = bed_only_alarms(rows, args.trials, seed=3, f0_refs=[88.0, 226.0, 257.0, 124.5])
    print(f"0. Control, no drone: share of {args.trials} bed-only trials (folds 4-5 bed at 50 dB SPL) with any on "
          f"frame {any_on:.2f}; with an on frame within 5 % of a reference f0 (88, 226, 257, 124.5 Hz): "
          + ", ".join(f"{f:g} Hz {v:.2f}" for f, v in per_f0.items()))
    print("1. DroneNoise hover clips at 10 m, direct (all nine mics)")
    for name, tag in DRONES.items():
        path = DATA / "dronenoise" / f"Ed_{tag}_10_H00_N_C_nw_ev1_M{{}}.wav"
        centre_raw, sr = read_mono(str(path).format(5))
        top = sorted(peaks_mod.harmonic_peaks(centre_raw, sr), key=lambda p: -p[1])[:6]
        print(f"  {name}: centre-mic harmonic peaks (Hz): {', '.join(f'{f:.0f}' for f, _ in top)}")
        for m in range(1, 10):
            raw, _ = read_mono(str(path).format(m))
            on_frac, f0, _, _ = detect_on(resample_to_fs(raw, sr))
            if f0 is None:
                print(f"    M{m}: on {on_frac:.2f}, no f0")
                continue
            near = min(top, key=lambda p: abs(p[0] - f0))
            print(f"    M{m}: on {on_frac:.2f}, f0 {f0:.1f} Hz, nearest peak {near[0]:.0f} Hz "
                  f"({abs(near[0] - f0) / near[0] * 100:.1f} %)")

    print("2. DroneNoise centre mic as emitted source (x10 to 1 m, ASSUMED calibration), propagated; Pd vs range "
          "(folds 4-5 bed; hit = on with the source's own f0 within 5 %)")
    for name, tag in DRONES.items():
        src = dronenoise_source(DATA / "dronenoise" / f"Ed_{tag}_10_H00_N_C_nw_ev1_M5.wav")
        _, f0_ref, _, _ = detect_on(loop(src, int(TRIAL_S * FS), xf_s=0.1))
        pd = trial_pd(src, rows, args.trials, seed=11 if tag == "M3" else 13, f0_ref=f0_ref)
        print(f"  {name}: " + ", ".join(f"{r} m {v:.1f}" for r, v in pd.items()))

    print("3. Onboard FPV clip (21.5-33.5 s), 85 dB at 1 m (ASSUMED calibration)")
    x = onboard_source(DATA / "user" / "fpv_dam_001.wav", *FPV_SPAN, FPV_LEVEL_DB)
    on_frac, f0, _, _ = detect_on(loop(x, int(TRIAL_S * FS), xf_s=0.1))
    print(f"  direct: on {on_frac:.2f}, median f0 {'none' if f0 is None else f'{f0:.1f} Hz'}")
    pd = trial_pd(x, rows, args.trials, seed=17, f0_ref=f0)
    print("  propagated: " + ", ".join(f"{r} m {v:.1f}" for r, v in pd.items()))


if __name__ == "__main__":
    main()
