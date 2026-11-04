# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Diagnose background false alarms on ESC-50 clips (folds 1-3 by default).

Each outdoor clip is set to the bed level and played alone over quiet pink ambient. Alarm onsets are counted per
class and turned into alarms per node-hour of that class. A dense bed (clips joined back to back) is also run, and
the alarms are split by whether they start within 1 s after a clip join.

Run:  uv run sim/perimeter/esc_diag.py [--folds 1,2,3]
"""

import argparse
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))

from acoustics.background import FS, bed, load_clip, manifest, band_rms  # noqa: E402
from acoustics.model import REF_PA  # noqa: E402
from acoustics.noise import pink  # noqa: E402
from detector.detector import HOP, N, Detector  # noqa: E402

BED_LEVEL_DB = 50.0
AMBIENT_DB = 35.0


def onsets(flags):
    f = flags.astype(np.int8)
    return np.flatnonzero(np.diff(np.concatenate([[0], f])) == 1)


def faded(x, fade_s=0.5):
    """Raised-cosine fades at both ends, so the clip has no level step on its own."""
    n = int(fade_s * FS)
    w = np.ones(x.size)
    ramp = np.sin(np.linspace(0, np.pi / 2, n)) ** 2
    w[:n] = ramp
    w[-n:] = ramp[::-1]
    return x * w


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--folds", default="1,2,3")
    ap.add_argument("--faded", action="store_true", help="10 s ambient pre-roll and 0.5 s fades on each clip")
    args = ap.parse_args()
    folds = {int(f) for f in args.folds.split(",")}
    rows = manifest(folds=folds)
    per_class_alarms = defaultdict(int)
    per_class_seconds = defaultdict(float)
    rng = np.random.default_rng(1)
    target = REF_PA * 10 ** (BED_LEVEL_DB / 20)
    for r in rows:
        x = load_clip(r["file"])
        x = x * (target / band_rms(x))
        if args.faded:
            x = faded(x)
            pre = pink(rng, 10 * FS, AMBIENT_DB)
            x = np.concatenate([pre, x, pink(rng, 2 * FS, AMBIENT_DB)])
            seconds = x.size / FS - 12.0
        else:
            seconds = x.size / FS
        amb = pink(rng, x.size, AMBIENT_DB)
        flags = Detector().run(x + amb)["on"]
        per_class_alarms[r["category"]] += onsets(flags).size
        per_class_seconds[r["category"]] += seconds
    kind = "faded, 10 s pre-roll" if args.faded else "abrupt edges"
    print(f"clips alone over pink ambient {AMBIENT_DB:.0f} dB, clip at {BED_LEVEL_DB:.0f} dB, {kind}, folds {sorted(folds)}")
    print(f"{'class':18s} {'alarms':>6s} {'hours':>7s} {'per node-hour':>13s}")
    total_a = total_s = 0
    rates = []
    for cat in sorted(per_class_seconds, key=lambda c: -per_class_alarms[c] / per_class_seconds[c]):
        a, s = per_class_alarms[cat], per_class_seconds[cat]
        total_a += a
        total_s += s
        rates.append((cat, a / s * 3600))
        print(f"{cat:18s} {a:6d} {s / 3600:7.2f} {a / s * 3600:13.1f}")
    print(f"{'all':18s} {total_a:6d} {total_s / 3600:7.2f} {total_a / total_s * 3600:13.1f}")
    print("top 5 classes by alarm rate:", ", ".join(f"{c} {v:.0f}/h" for c, v in rates[:5]))

    # dense bed: joins
    join_alarms = other_alarms = 0
    for node in range(3):
        x, labels = bed(500 + node, rows, 600.0, BED_LEVEL_DB)
        flags = Detector().run(x)["on"]
        starts = np.array([s for s, _ in labels])
        t_on = onsets(flags) * HOP + N // 2
        for s in t_on:
            i = np.searchsorted(starts, s, side="right") - 1
            d = s - starts[max(i, 0)]
            if d <= 1.0 * FS:
                join_alarms += 1
            else:
                other_alarms += 1
    tot = join_alarms + other_alarms
    print(f"dense bed (3 x 10 min): {tot} alarms, {join_alarms} within 1 s of a clip join "
          f"({100 * join_alarms / max(tot, 1):.0f} %)")


if __name__ == "__main__":
    main()
