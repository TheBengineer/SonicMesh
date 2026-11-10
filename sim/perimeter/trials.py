# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Detector trials on the diagnosis folds (1-3): node Pd, gateway Pd and false alarms, scored together.

Each group is one set of parameter variants that share a comb (the floor, frame and impulse settings of the first
variant), so one crossing run and one false-alarm run score the whole group. Variants that change the floor or the
frame must therefore be run as their own group, with their own baseline (group "base"). Crossings are the --tune
crossings (seed 2026, 120 crossings, altitude 10-120 m, folds 1-3 bed of run.CROSS_BED_H hours; 0.25 h in rounds 1-4), so the baseline row can be compared with the
tuning table in doc 07. Pd is taken below 100 m. The false-alarm bed is the rural scene on folds 1-3 at --hours per
node (13 nodes), seed 7300 for every group.

Round 3 options: --n-fft / --hop (frame), --theta (threshold of the baseline and of the group's variants without a
threshold of their own), --gate (gateway match rule used for the gateway columns: f0 or lines).

Run:  uv run sim/perimeter/trials.py --group track --hours 3
      uv run sim/perimeter/trials.py --group base --n-fft 2048 --hop 1024 --theta 0.12 --hours 3
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))
sys.path.insert(0, str(ROOT / "sim" / "perimeter"))

import fa  # noqa: E402
import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402
from detector.detector import Params  # noqa: E402


def groups(theta):
    """Groups of variants. The threshold of a variant without its own threshold is theta."""
    base = dict(theta=theta, sub_guard=False)  # the rounds 1-4 baseline; sub_guard became the default after 12.4g
    return {
        "base": {"baseline": Params(**base)},
        # track-level changes: share the baseline comb (the threshold is the only change that needs no new comb)
        "track": {
            "baseline": Params(**base),
            "theta 0.09": Params(theta=0.09),
            "theta 0.08": Params(theta=0.08),
            "gap 1 s (31 hops)": Params(**base, gap_frames=31),
            "gap 2 s (62 hops)": Params(**base, gap_frames=62),
        },
        # floor and comb changes: each has its own comb, so the baseline runs as group "base"
        "floor-gate3": {"floor gate 3 dB": Params(**base, floor_gate_db=3.0)},
        "floor-up05": {"floor rise 0.05 dB per hop": Params(**base, floor_up_db=0.05)},
        "startup-cap16": {"start-up cap +-16 bins": Params(**base, init_env_bins=16)},
        "gate2": {"fundamental or 2nd harmonic gate": Params(**base, gate_harm=2)},
        "combo": {"floor rise 0.05 + gate 2": Params(**base, floor_up_db=0.05, gate_harm=2)},
        # exploration only (round 3, after the freeze): at 8192 the converted impulse hold rounds to 0 frames; this row
        # gives it one 256 ms frame (impulse_hold 8 baseline hops), to see whether the rounding matters
        "gate2": {"gate 2": Params(**base, gate_harm=2), "gate 2 + guard": Params(**base, gate_harm=2, sub_guard=True)},
        "guard": {"baseline": Params(**base), "sub guard": Params(**base, sub_guard=True)},
        "lock": {
            "baseline": Params(**base),
            "sub guard": Params(**base, sub_guard=True),
            "guard + gap 1 s": Params(**base, sub_guard=True, gap_frames=31),
            "guard + gap + harm 4": Params(**base, sub_guard=True, gap_frames=31, gap_harm=4),
            "guard + gap + harm 6": Params(**base, sub_guard=True, gap_frames=31, gap_harm=6),
            "gap + harm 4": Params(**base, gap_frames=31, gap_harm=4),
        },
        "explore impulse 1 frame": {"floor 0.05 + impulse hold 1 frame": Params(**base, floor_up_db=0.05, impulse_hold=8)},
    }


def run_group(name, hours, n_cross, procs, master, frame, theta, bed="rural", cross_seed=2026, fa_seed=7300, folds=(1, 2, 3), ckpt=None):
    """With hours 0 the false-alarm run is skipped and its columns are 0 (crossings only)."""
    variants = {k: replace(v, n_fft=frame[0], hop=frame[1]) for k, v in groups(theta)[name].items()}
    labels = list(variants)
    params = list(variants.values())
    cross = R.sample_crossings(n_cross, seed=cross_seed)
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
    if hours > 0:
        onsets_all = fa.scene_alarms(bed, params, hours, folds, seed=fa_seed, nodes=R.NODES, procs=procs, ckpt=ckpt)
    else:
        onsets_all = [{i: [] for i in range(R.NODES)} for _ in params]
    t_fa = time.time() - t1
    out = {}
    for k, onsets in zip(labels, onsets_all):
        sel = [r for r in res[k] if r["alt"] < 100]
        n = len(sel)
        fr = R.fa_rates(onsets, hours) if hours > 0 else dict(node_alarms=0, node_per_node_day=0.0, gateway_alarms=0, per_km_day=0.0)
        out[k] = dict(n_below100=n, node_pd=sum(r["node_detected"] for r in sel) / n,
                      gw_pd=sum(r["detected"] for r in sel) / n, node_alarms=fr["node_alarms"],
                      node_per_node_day=fr["node_per_node_day"], gw_events=fr["gateway_alarms"],
                      gw_per_km_day=fr["per_km_day"],
                      by_class={c: dict(n=len(of), node_pd=sum(r["node_detected"] for r in of) / max(len(of), 1),
                                        gw_pd=sum(r["detected"] for r in of) / max(len(of), 1))
                                for c in sorted({r["cls"] for r in sel}) for of in [[r for r in sel if r["cls"] == c]]})
    print(f"group {name} frame {frame} theta {theta} gate {R.NEW_RULE[2]} bed {bed}: crossings {len(cross)} "
          f"({t_cross / 60:.1f} min), false alarms {hours} h per node ({t_fa / 60:.1f} min)", flush=True)
    print(f"{'variant':28s} {'n<100':>5s} {'node Pd':>8s} {'gw Pd':>7s} {'node alm':>9s} {'per nd-day':>10s} "
          f"{'gw ev':>5s} {'gw/km-d':>8s}")
    for k, v in out.items():
        print(f"{k:28s} {v['n_below100']:5d} {v['node_pd']:8.2f} {v['gw_pd']:7.2f} {v['node_alarms']:9d} "
              f"{v['node_per_node_day']:10.1f} {v['gw_events']:5d} {v['gw_per_km_day']:8.2f}", flush=True)
        print("    " + "  ".join(f"{c} n={x['n']} node {x['node_pd']:.2f} gw {x['gw_pd']:.2f}" for c, x in v["by_class"].items()), flush=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--group", required=True, choices=sorted(groups(0.10)))
    ap.add_argument("--hours", type=float, default=2.0, help="false-alarm hours per node; 0 runs the crossings only")
    ap.add_argument("--bed-hours", type=float, default=R.CROSS_BED_H,
                    help="hours of the shared crossing bed (0.25 reproduces rounds 1-4)")
    ap.add_argument("--crossings", type=int, default=120)
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--n-fft", type=int, default=1024)
    ap.add_argument("--hop", type=int, default=None, help="default n_fft / 2")
    ap.add_argument("--theta", type=float, default=0.10)
    ap.add_argument("--gate", default="f0", choices=["f0", "lines"])
    ap.add_argument("--bed", default="rural", choices=["rural", "dense"],
                    help="false-alarm bed (folds 1-3): rural, or the dense ESC stress bed at 50 dB")
    ap.add_argument("--seeds", default=None, choices=sorted(R.SEEDS),
                    help="score on these held-out seeds and folds 4-5 instead of the tuning crossings and folds 1-3")
    ap.add_argument("--ckpt", default=None, help="directory for the false-alarm run's checkpoints, to resume from")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    R.NEW_RULE = (R.NEW_RULE[0], R.NEW_RULE[1], args.gate)
    frame = (args.n_fft, args.hop or args.n_fft // 2)
    drawn = {}
    if args.seeds:
        seeds = R.SEEDS[args.seeds]
        master, _ = rural_scene(seeds["master"], args.bed_hours, (4, 5))
        fa_seed = seeds["fa_dense"] if args.bed == "dense" else seeds["fa_rural"]
        drawn = dict(cross_seed=seeds["cross"], fa_seed=fa_seed, folds=(4, 5))
    else:
        master, _ = rural_scene(1234, args.bed_hours, (1, 2, 3))  # the tuning bed of run.py --tune
    out = run_group(args.group, args.hours, args.crossings, args.procs, master, frame, args.theta, args.bed, ckpt=args.ckpt, **drawn)
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
