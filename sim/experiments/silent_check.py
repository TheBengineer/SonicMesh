# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Control for spacing_check.py: how many node detections in a crossing window come from the bed, not the drone?

Runs the same crossings at the same spacings with the drone's source turned down by 200 dB (gain_db), so everything a
node detects in the truth window is the bed, wind or self noise. Compare the 1+, 2+ and 3+ shares and gateway Pd with
spacing_check.py: where they are close, "heard by two nodes" is mostly not the drone. With sub_guard, below 100 m.

Every node in a crossing cuts its bed from one shared recording (0.25 h in the runner), so one event clip can reach
several nodes at the same pitch. --bed-hours lengthens that recording to test how much of the result comes from reuse.

Run:  uv run sim/experiments/silent_check.py --procs 20
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import sys

import numpy as np
from multiprocessing import Pool
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))
sys.path.insert(0, str(ROOT / "sim" / "perimeter"))

import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402
from detector.detector import Params  # noqa: E402

LINE_M = R.LINE_LEN_M


def node_start_s(c, i):
    """When node i's detector starts in run_crossing: WARM_S before the drone first comes within WINDOW_M."""
    tr = R.track_of(c)
    d3 = np.sqrt((tr["x"] - i * R.SPACING_M) ** 2 + tr["y"] ** 2 + (tr["z"] - R.DETECTOR_MIC_H_M) ** 2)
    inside = np.flatnonzero(d3 < R.WINDOW_M)
    return max(0.0, inside[0] * R.TICK_S - R.WARM_S) if inside.size else None


def onset_ages(res, cross):
    """Seconds from each node's start to each of its onsets inside the truth window."""
    by_id = {c["id"]: c for c in cross}
    ages = []
    for r in res:
        c = by_id[r["id"]]
        for i, v in r["onsets"].items():
            t0 = node_start_s(c, i)
            ages += [o[0] - t0 for o in v if r["t_in"] <= o[0] <= r["t_out"]]
    return np.array(ages)


def summary(res):
    sel = [r for r in res if r["alt"] < 100]
    n = max(len(sel), 1)
    return dict(n=len(sel), at_least={k: sum(len(r["node_dist"]) >= k for r in sel) / n for k in (1, 2, 3)},
                gw=sum(r["detected"] for r in sel) / n,
                window_s=sum(r["t_out"] - r["t_in"] for r in sel) / n)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--crossings", type=int, default=120)
    ap.add_argument("--procs", type=int, default=20)
    ap.add_argument("--spacings", default="350,175,80")
    ap.add_argument("--bed-hours", type=float, default=R.CROSS_BED_H, help="length of the shared bed (0.25 reproduces the first control)")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    master, events = rural_scene(1234, args.bed_hours, (1, 2, 3))
    print(f"bed {args.bed_hours:g} h with {len(events)} events", flush=True)
    params = [Params(theta=0.10, sub_guard=True)]
    cross = [dict(c, gain_db=-200.0) for c in R.sample_crossings(args.crossings, seed=2026)]
    result = {}
    for spacing in [float(s) for s in args.spacings.split(",")]:
        R.SPACING_M = spacing
        R.NODES = int(round(LINE_M / spacing)) + 1
        res = []
        with Pool(args.procs, initializer=R._init_worker, initargs=(master,)) as pool:
            for c, r in zip(cross, pool.imap(R._crossing_job, [(c, params) for c in cross], chunksize=1)):
                if r:
                    res.append(dict(r[0], id=c["id"]))
        print(f"spacing {spacing:.0f} m, drone silent", flush=True)
        result[spacing] = {}
        for c in ("fpv", "mini", "matrice"):
            s = summary([r for r in res if r["cls"] == c])
            result[spacing][c] = s
            a = s["at_least"]
            print(f"  {c:8s} n={s['n']:3d}  1+ {a[1]:.2f}  2+ {a[2]:.2f}  3+ {a[3]:.2f}  gateway {s['gw']:.2f}  "
                  f"mean window {s['window_s']:.0f} s", flush=True)
        ages = onset_ages([r for r in res if r["alt"] < 100], cross)
        if ages.size:
            edges = [0, 5, 10, 20, 40, 1e9]
            h = np.histogram(ages, edges)[0]
            print(f"  onsets in window: {ages.size}; seconds after node start 0-5 / 5-10 / 10-20 / 20-40 / 40+: "
                  + " / ".join(str(int(x)) for x in h), flush=True)
            result[spacing]["onset_age_hist"] = dict(edges=edges[:-1], counts=h.tolist())
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
