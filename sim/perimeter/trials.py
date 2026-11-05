# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Detector trials on the diagnosis folds (1-3): node Pd, gateway Pd and false alarms, scored together.

Each group is one set of parameter variants that share a comb (the floor and impulse settings of the first variant),
so one crossing run and one false-alarm run score the whole group. Crossings are the --tune crossings (seed 2026, 120
crossings, altitude 10-120 m, folds 1-3 bed), so the baseline row can be compared with the tuning table in doc 07.
Pd is taken below 100 m. The false-alarm bed is the rural scene on folds 1-3 at --hours per node (13 nodes).

Run:  uv run sim/perimeter/trials.py --group track --hours 2
      uv run sim/perimeter/trials.py --group floor --hours 2
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))
sys.path.insert(0, str(ROOT / "sim" / "perimeter"))

import fa  # noqa: E402
import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402
from detector.detector import Params  # noqa: E402

BASE = dict(theta=0.10)
GROUPS = {
    # track-level changes: the baseline comb, so one run covers all of them
    "track": {
        "baseline theta 0.10": Params(**BASE),
        "theta 0.09": Params(theta=0.09),
        "theta 0.08": Params(theta=0.08),
        "gap 1 s (31 frames)": Params(**BASE, gap_frames=31),
        "gap 2 s (62 frames)": Params(**BASE, gap_frames=62),
    },
    # floor changes: each variant has its own comb, so each is run on its own (compare with the baseline row of track)
    "floor-gate3": {"floor gate 3 dB": Params(**BASE, floor_gate_db=3.0)},
    "floor-up05": {"floor rise 0.05 dB/frame": Params(**BASE, floor_up_db=0.05)},
    "startup-cap16": {"start-up cap +-16 bins": Params(**BASE, init_env_bins=16)},
    "gate2": {"fundamental or 2nd harmonic gate": Params(**BASE, gate_harm=2)},
}


def run_group(name, hours, n_cross, procs, master):
    variants = GROUPS[name]
    labels = list(variants)
    params = list(variants.values())
    cross = R.sample_crossings(n_cross, seed=2026)
    t0 = time.time()
    res = {k: [] for k in labels}
    from multiprocessing import Pool

    with Pool(procs, initializer=R._init_worker, initargs=(master,)) as pool:
        for r in pool.imap_unordered(R._crossing_job, [(c, params) for c in cross], chunksize=1):
            if r:
                for k, x in zip(labels, r):
                    res[k].append(x)
    t_cross = time.time() - t0
    t1 = time.time()
    bed = fa.scene_alarms("rural", params, hours, (1, 2, 3), seed=7300, nodes=R.NODES, procs=procs)
    t_fa = time.time() - t1
    out = {}
    for k, onsets in zip(labels, bed):
        sel = [r for r in res[k] if r["alt"] < 100]
        n = len(sel)
        fr = R.fa_rates(onsets, hours)
        out[k] = dict(n_below100=n, node_pd=sum(r["node_detected"] for r in sel) / n,
                      gw_pd=sum(r["detected"] for r in sel) / n, node_alarms=fr["node_alarms"],
                      node_per_node_day=fr["node_per_node_day"], gw_events=fr["gateway_alarms"],
                      gw_per_km_day=fr["per_km_day"])
    print(f"group {name}: crossings {len(cross)} ({t_cross / 60:.1f} min), false alarms {hours} h per node "
          f"({t_fa / 60:.1f} min)", flush=True)
    print(f"{'variant':28s} {'n<100':>5s} {'node Pd':>8s} {'gw Pd':>7s} {'node alm':>9s} {'per nd-day':>10s} "
          f"{'gw ev':>5s} {'gw/km-d':>8s}")
    for k, v in out.items():
        print(f"{k:28s} {v['n_below100']:5d} {v['node_pd']:8.2f} {v['gw_pd']:7.2f} {v['node_alarms']:9d} "
              f"{v['node_per_node_day']:10.1f} {v['gw_events']:5d} {v['gw_per_km_day']:8.2f}", flush=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--group", required=True, choices=sorted(GROUPS))
    ap.add_argument("--hours", type=float, default=2.0)
    ap.add_argument("--crossings", type=int, default=120)
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    master, _ = rural_scene(1234, 0.25, (1, 2, 3))  # the tuning bed of run.py --tune
    out = run_group(args.group, args.hours, args.crossings, args.procs, master)
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
