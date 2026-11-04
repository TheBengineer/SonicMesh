# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Perimeter scenario runner: 13 detector nodes 350 m apart, random crossings, background false alarms.

Crossings: class, altitude 10-120 m, speed 5-25 m/s, crossing angle 40-140 deg, crossing point along the line, and
wind 0-8 m/s. A node renders the drone while it is within 600 m (plus 10 s warm-up). A crossing is detected if the
gateway alarms while the drone is within 400 m of the line (node-level Pd is reported too).

Threshold: tuned on folds 1-3 (rural scene), lowest threshold with perimeter false alarms <= 1 per km per day.
Reported on folds 4-5. Rejection ablation on the dense stress bed, folds 1-3.

Run:  uv run sim/perimeter/run.py --quick        (about 2 min)
      uv run sim/perimeter/run.py                (full run)
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")  # before numpy loads

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))
sys.path.insert(0, str(ROOT / "sim" / "perimeter"))

import fa  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402
from acoustics.model import BLOCK, CLASS, DETECTOR_MIC_H_M, FS, SELF_NOISE_DB, TICK_S  # noqa: E402
from acoustics.noise import white, wind  # noqa: E402
from acoustics.scene import padded, render_mic  # noqa: E402
from acoustics.source import drone_source  # noqa: E402
from acoustics.turbulence import turbulence  # noqa: E402
from detector.detector import HOP, N, Params  # noqa: E402

NODES = 13
SPACING_M = 350.0
LINE_LEN_M = (NODES - 1) * SPACING_M
ENTRY_M = 1000.0
WINDOW_M = 600.0
TRUTH_M = 400.0
WARM_S = 10.0
PAD_S = 6.0
TICK_SAMPLES = int(round(TICK_S * FS))
ALT_BANDS = [("<50 m", 10.0, 50.0), ("50-100 m", 50.0, 100.0), ("100-120 m", 100.0, 120.0)]
WIND_BINS = [("0-2 m/s", 0.0, 2.0), ("2-5 m/s", 2.0, 5.0), ("5-8 m/s", 5.0, 8.0)]
CLASSES = list(CLASS)
NODES_PER_KM = 1000.0 / SPACING_M
LINE_KM = LINE_LEN_M / 1000.0
THETAS = [0.12, 0.14, 0.16, 0.18, 0.20, 0.23, 0.26, 0.30, 0.35, 0.40, 0.50, 0.60, 0.80, 1.00]
FA_TARGET_PER_KM_DAY = 1.0


def sample_crossings(n, seed):
    rng = np.random.default_rng(seed)
    out = []
    for c in range(n):
        out.append(dict(
            id=c,
            cls=CLASSES[rng.integers(len(CLASSES))],
            alt=float(rng.uniform(10.0, 120.0)),
            speed=float(rng.uniform(5.0, 25.0)),
            angle=float(np.deg2rad(rng.uniform(40.0, 140.0))),
            xc=float(rng.uniform(0.0, LINE_LEN_M)),
            wind=float(rng.uniform(0.0, 8.0)),
            seed=int(seed * 100003 + c),
        ))
    return out


def track_of(c):
    total = 2 * ENTRY_M / c["speed"]
    ticks = int(round(total / TICK_S)) + 1
    t = np.arange(ticks) * TICK_S
    s = np.minimum(-ENTRY_M + c["speed"] * t, ENTRY_M)
    x = c["xc"] + s * math.cos(c["angle"])
    y = s * math.sin(c["angle"])
    return {"t": t, "x": x, "y": y, "z": np.full(ticks, c["alt"]), "rotor": np.ones(ticks)}


def lateral(tr):
    dx = np.clip(tr["x"], 0.0, LINE_LEN_M) - tr["x"]
    return np.hypot(dx, tr["y"])


def run_crossing(c, master, params_list):
    """Per parameter set: dict with detected (gateway), node_detected, and the gateway events."""
    tr = track_of(c)
    tk = tr["t"]
    src = drone_source(c["cls"], np.ones(len(tk) * TICK_SAMPLES), rng=np.random.default_rng(c["seed"]),
                       wobble=True, broadband=True)
    src_pad = padded(src, int(PAD_S * FS))
    truth = np.flatnonzero(lateral(tr) <= TRUTH_M)
    if truth.size == 0:
        return None
    t_in, t_out = tk[truth[0]], tk[truth[-1]]
    rng_bed = np.random.default_rng(c["seed"] + 1)
    node_onsets = [dict() for _ in params_list]
    for i in range(NODES):
        node_x = i * SPACING_M
        d3 = np.sqrt((tr["x"] - node_x) ** 2 + tr["y"] ** 2 + (tr["z"] - DETECTOR_MIC_H_M) ** 2)
        inside = np.flatnonzero(d3 < WINDOW_M)
        if inside.size == 0:
            continue
        n_a = max(0, inside[0] * TICK_SAMPLES - int(WARM_S * FS))
        n_b = min((inside[-1] + 1) * TICK_SAMPLES, len(tk) * TICK_SAMPLES)
        off = int(rng_bed.integers(0, len(master) - (n_b - n_a)))
        rng = np.random.default_rng(c["seed"] * 31 + i)
        dfn, gfn = turbulence(rng, tk, d3)
        sig = render_mic(src_pad, int(PAD_S * FS), tr, (node_x, 0.0, DETECTOR_MIC_H_M), n_a, n_b,
                         block=BLOCK * 10, delay_fn=dfn, gain_fn=gfn)
        m = n_b - n_a
        sig = sig + master[off : off + m] + wind(rng, m, c["wind"]) + white(rng, m, SELF_NOISE_DB)
        on, f0 = fa.detector_flags(sig, params_list)
        t_frame = (n_a + np.arange(on.shape[1]) * HOP + N / 2) / FS
        for k in range(len(params_list)):
            node_onsets[k][i] = fa.onsets_of(on[k], f0[k], t_frame)
    out = []
    for k in range(len(params_list)):
        ev = fa.gateway_events(node_onsets[k])
        gw = [t for t in ev if t_in <= t <= t_out]
        node_hit = any(any(t_in <= t <= t_out for t, _, _ in v) for v in node_onsets[k].values())
        out.append(dict(cls=c["cls"], alt=c["alt"], wind=c["wind"], detected=bool(gw), node_detected=node_hit))
    return out


def pd_table(res):
    rows = []
    for cls in CLASSES:
        for ab, a0, a1 in ALT_BANDS:
            for wb, w0, w1 in WIND_BINS:
                sel = [r for r in res if r["cls"] == cls and a0 <= r["alt"] < a1 and w0 <= r["wind"] < w1]
                d = sum(r["detected"] for r in sel)
                rows.append(dict(cls=cls, alt=ab, wind=wb, n=len(sel), detected=d,
                                 pd=(d / len(sel) if sel else None)))
    return rows


def pd_by_alt(res, key):
    out = {}
    for ab, a0, a1 in ALT_BANDS + [("below 100 m", 0.0, 100.0)]:
        sel = [r for r in res if a0 <= r["alt"] < a1]
        d = sum(r[key] for r in sel)
        out[ab] = dict(n=len(sel), detected=d, pd=(d / len(sel) if sel else None))
    return out


def fa_rates(onsets_by_node, hours):
    """Node-level alarms per node-day, and perimeter (gateway) alarms per km per day."""
    node_alarms = sum(len(v) for v in onsets_by_node.values())
    node_hours = hours * NODES
    gw = len(fa.gateway_events(onsets_by_node))
    return dict(node_alarms=node_alarms, node_per_node_day=node_alarms / node_hours * 24.0,
                gateway_alarms=gw, per_km_day=gw / (hours * LINE_KM) * 24.0)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--crossings", type=int, default=None)
    ap.add_argument("--hours", type=float, default=None, help="report background hours per node (folds 4-5)")
    ap.add_argument("--tune-hours", type=float, default=None)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    n_cross = args.crossings or (12 if args.quick else 120)
    hours = args.hours or (0.25 if args.quick else 2.0)
    tune_h = args.tune_hours or (0.25 if args.quick else 1.0)
    t_all = time.time()
    print(f"{NODES} nodes at {SPACING_M:.0f} m; crossings {n_cross}; report background {hours} h per node")

    # 1. threshold on folds 1-3, rural scene, gateway rule
    t0 = time.time()
    params = [Params(theta=th) for th in THETAS]
    tune = fa.scene_alarms("rural", params, tune_h, (1, 2, 3), seed=1000, nodes=NODES)
    tune_fa = {}
    for th, d in zip(THETAS, tune):
        tune_fa[th] = fa_rates(d, tune_h)
    print(f"threshold sweep, folds 1-3 rural ({time.time() - t0:.0f} s):")
    for th in THETAS:
        r = tune_fa[th]
        print(f"  theta {th:.2f}: node alarms {r['node_alarms']}, per node-day {r['node_per_node_day']:.2f}, "
              f"gateway {r['gateway_alarms']}, per km-day {r['per_km_day']:.2f}")
    ok = [th for th in THETAS if tune_fa[th]["per_km_day"] <= FA_TARGET_PER_KM_DAY]
    chosen = min(ok) if ok else max(THETAS)
    print(f"chosen theta {chosen:.2f} (lowest with <= {FA_TARGET_PER_KM_DAY} per km per day, folds 1-3)")

    # 2. report folds 4-5: rural and dense, node and gateway
    t0 = time.time()
    rep_rural = fa.scene_alarms("rural", [Params(theta=chosen)], hours, (4, 5), seed=4000, nodes=NODES)[0]
    rep_dense = fa.scene_alarms("dense", [Params(theta=chosen)], hours, (4, 5), seed=5000, nodes=NODES)[0]
    rural_fa = fa_rates(rep_rural, hours)
    dense_fa = fa_rates(rep_dense, hours)
    print(f"folds 4-5 false alarms ({time.time() - t0:.0f} s):")
    print(f"  rural: node alarms {rural_fa['node_alarms']} ({rural_fa['node_per_node_day']:.3f} per node-day), "
          f"gateway {rural_fa['gateway_alarms']} ({rural_fa['per_km_day']:.3f} per km-day)")
    print(f"  dense stress: node alarms {dense_fa['node_alarms']} ({dense_fa['node_per_node_day']:.2f} per node-day), "
          f"gateway {dense_fa['gateway_alarms']} ({dense_fa['per_km_day']:.2f} per km-day)")

    # 3. crossings on folds 4-5 background
    t0 = time.time()
    master, _ = rural_scene(7777, 1.0, (4, 5))
    res = []
    for c in sample_crossings(n_cross, seed=2026):
        r = run_crossing(c, master, [Params(theta=chosen)])
        if r:
            res.append(r[0])
    print(f"crossings: {len(res)} scored in {time.time() - t0:.0f} s")
    table = pd_table(res)
    for row in table:
        if row["n"]:
            print(f"  {row['cls']:8s} {row['alt']:10s} {row['wind']:9s} n={row['n']:3d} "
                  f"detected={row['detected']:3d} Pd={row['pd']:.2f}")
    byalt = pd_by_alt(res, "detected")
    print("gateway Pd by altitude:", {k: (v["detected"], v["n"]) for k, v in byalt.items()})
    print("node-level Pd by altitude:", {k: (v["detected"], v["n"]) for k, v in pd_by_alt(res, "node_detected").items()})
    total = time.time() - t_all
    print(f"total run time {total / 60:.1f} min")
    if args.json:
        Path(args.json).write_text(json.dumps(dict(chosen=chosen, tune=tune_fa, rural=rural_fa, dense=dense_fa,
                                                   pd=table, pd_alt=byalt, runtime_s=total), indent=1,
                                              default=float))


if __name__ == "__main__":
    main()
