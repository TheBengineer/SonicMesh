# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""A detector mic at the ground against one at 0.3 m, on the perimeter runner's tuning crossings.

At the ground the direct and reflected paths arrive together and the reflection is taken as complete, so a tone gains up
to 6 dB against a free field and its dips disappear. Diffuse noise also gains, by 3 dB, so the bed is raised by 3 dB here.
Without that the test would flatter the idea. Wind and mic self-noise are unchanged. A real boundary mic may see less wind,
and grass, rain and mud are not modelled, so this bounds what the geometry gives and does not predict a field result.

Run:  uv run sim/experiments/ground_mic_check.py --crossings 120 --procs 4
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

import acoustics.scene as scene  # noqa: E402
import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402
from detector.detector import Params  # noqa: E402


def score(n_cross, procs, master, params):
    cross = R.sample_crossings(n_cross, seed=2026)
    out = [[] for _ in params]
    with Pool(procs, initializer=R._init_worker, initargs=(master,)) as pool:
        for r in pool.imap_unordered(R._crossing_job, [(c, params) for c in cross], chunksize=1):
            if r:
                for k, x in enumerate(r):
                    out[k].append(x)
    rows = []
    for res in out:
        sel = [r for r in res if r["alt"] < 100]
        row = dict(n=len(sel), node=sum(r["node_detected"] for r in sel) / len(sel), gw=sum(r["detected"] for r in sel) / len(sel))
        for c in sorted({r["cls"] for r in sel}):
            of = [r for r in sel if r["cls"] == c]
            row[c] = dict(n=len(of), node=sum(r["node_detected"] for r in of) / len(of), gw=sum(r["detected"] for r in of) / len(of))
        rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--crossings", type=int, default=120)
    ap.add_argument("--procs", type=int, default=4)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    master, _ = rural_scene(1234, 0.25, (1, 2, 3))
    params = [Params(theta=0.10), Params(theta=0.10, sub_guard=True)]
    labels = ["baseline", "sub guard"]
    result = {}
    # Each setting changes module globals before its pool forks, so the workers inherit them.
    for name, height, gamma, bed_gain in [("mic at 0.3 m", R.DETECTOR_MIC_H_M, scene.GROUND_GAMMA, 1.0), ("mic at the ground", 0.02, 1.0, 10 ** (3 / 20))]:
        R.DETECTOR_MIC_H_M = height
        scene.GROUND_GAMMA = gamma
        rows = score(args.crossings, args.procs, master * bed_gain, params)
        result[name] = dict(zip(labels, rows))
        for label, row in zip(labels, rows):
            per = "  ".join(f"{c} n={row[c]['n']} node {row[c]['node']:.2f} gw {row[c]['gw']:.2f}" for c in ("fpv", "mini", "matrice") if c in row)
            print(f"{name:18s} {label:10s} node {row['node']:.2f} gw {row['gw']:.2f}  {per}", flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
