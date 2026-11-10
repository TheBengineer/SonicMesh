# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""How close must nodes be for a crossing to reach at least two, and hopefully three, of them?

Runs the perimeter runner's tuning crossings on a line of the same length at several spacings, so each spacing sees the
same flights. For crossings below 100 m it reports the share where at least 1, 2 and 3 nodes detect while the drone is
within the runner's truth window, and gateway Pd, per class. Nodes per km sets the cost.

No false-alarm run: each node's bed is drawn independently, so a real sound reaching two close nodes is not modelled, and
closer spacing would flatter the pair rule. False alarms per km also scale with nodes per km. Measure both before choosing.
The runner's crossings cut every node's bed from one 0.25 h recording, so an event clip can reach several nodes at the
same pitch and pair at the gateway. The default is now run.CROSS_BED_H (2 h); compare with silent_check.py (the same
crossings, no drone).

Run:  uv run sim/experiments/spacing_check.py --procs 12
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import sys
from multiprocessing import Pool
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))
sys.path.insert(0, str(ROOT / "sim" / "perimeter"))

import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402
from detector.detector import Params  # noqa: E402

LINE_M = R.LINE_LEN_M
SPACINGS_M = [350.0, 250.0, 175.0, 120.0, 80.0]
COST_PER_NODE = 30


def summary(res):
    sel = [r for r in res if r["alt"] < 100]
    n = max(len(sel), 1)
    return dict(n=len(sel), at_least={k: sum(len(r["node_dist"]) >= k for r in sel) / n for k in (1, 2, 3)},
                gw=sum(r["detected"] for r in sel) / n)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--crossings", type=int, default=120)
    ap.add_argument("--procs", type=int, default=12)
    ap.add_argument("--bed-hours", type=float, default=R.CROSS_BED_H, help="length of the shared bed (0.25 reproduces 12.4d)")
    ap.add_argument("--spacings", default=",".join(str(int(x)) for x in SPACINGS_M))
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    master, _ = rural_scene(1234, args.bed_hours, (1, 2, 3))
    labels = ["baseline", "sub guard"]
    params = [Params(theta=0.10), Params(theta=0.10, sub_guard=True)]
    cross = R.sample_crossings(args.crossings, seed=2026)  # the same flights at every spacing
    result = {}
    for spacing in [float(x) for x in args.spacings.split(",")]:
        # Module globals change before the pool forks, so the workers inherit them.
        R.SPACING_M = spacing
        R.NODES = int(round(LINE_M / spacing)) + 1
        out = [[] for _ in params]
        with Pool(args.procs, initializer=R._init_worker, initargs=(master,)) as pool:
            for r in pool.imap_unordered(R._crossing_job, [(c, params) for c in cross], chunksize=1):
                if r:
                    for k, x in enumerate(r):
                        out[k].append(x)
        per_km = 1000.0 / spacing
        result[spacing] = {}
        print(f"spacing {spacing:.0f} m: {per_km:.1f} nodes per km, about ${per_km * COST_PER_NODE:.0f} per km in detector nodes", flush=True)
        for label, res in zip(labels, out):
            row = {c: summary([r for r in res if r["cls"] == c]) for c in ("fpv", "mini", "matrice")}
            row["all"] = summary(res)
            result[spacing][label] = row
            for c, s in row.items():
                a = s["at_least"]
                print(f"  {label:10s} {c:8s} n={s['n']:3d}  1+ {a[1]:.2f}  2+ {a[2]:.2f}  3+ {a[3]:.2f}  gateway {s['gw']:.2f}", flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
