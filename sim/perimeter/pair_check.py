# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Why node detections at +12 dB do not become gateway pairs (doc 07 section 4 follow-up).

For each mini and matrice crossing below 100 m (folds 1-3 bed, theta 0.10, the scenario's crossing seeds shifted
so they are new to the report), every adjacent node pair in which both nodes switch on within the crossing window is
classified:
  window   the two onsets are within the 30 s gateway window;
  f0       the two coarse f0 estimates agree directly, or an octave apart, within 12 % (the gateway rule);
  ratio    the f0 ratio of the two nodes, rounded to the nearest of 1/3, 1/2, 2/3, 1, 3/2, 2, 3 (or 'other').
The output counts how many both-detect pairs fail each test. Diagnostic only: the classification uses the
detectors' outputs and the rule in fa.py, and nothing from the truth.

Run:  uv run sim/perimeter/pair_check.py --crossings 40
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))
sys.path.insert(0, str(ROOT / "sim" / "perimeter"))

import fa  # noqa: E402
import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402

GAINS = (0.0, 12.0)
CLASSES = ("mini", "matrice")
CROSS_SEED = 6060  # not used by any earlier run
RATIOS = {"1/3": 1 / 3, "1/2": 0.5, "2/3": 2 / 3, "1": 1.0, "3/2": 1.5, "2": 2.0, "3": 3.0}


def ratio_label(f_a, f_b):
    if f_a <= 0 or f_b <= 0:
        return "none"
    r = f_a / f_b
    for name, v in RATIOS.items():
        if abs(r / v - 1) <= fa.GATE_F0_TOL:
            return name
    return "other"


_MASTER = None


def _init(master):
    global _MASTER
    _MASTER = master


def doppler_ratio(c, i, j, t):
    """Doppler ratio f_i / f_j expected for the drone's blade-pass tone at time t, seen by nodes i and j (ASSUMED
    straight-line motion from track_of; the source moves at the crossing speed)."""
    tr = R.track_of(c)
    k = min(int(round(t / R.TICK_S)), len(tr["t"]) - 1)
    k0, k1 = max(0, k - 1), min(len(tr["t"]) - 1, k + 1)
    v = np.array([(tr["x"][k1] - tr["x"][k0]), (tr["y"][k1] - tr["y"][k0]), 0.0]) / max(
        (tr["t"][k1] - tr["t"][k0]), 1e-9)
    s_pos = np.array([tr["x"][k], tr["y"][k], tr["z"][k]])
    out = []
    for n in (i, j):
        o = np.array([n * R.SPACING_M, 0.0, R.DETECTOR_MIC_H_M])
        d = o - s_pos
        v_toward = float(v @ d) / max(float(np.linalg.norm(d)), 1e-9)
        out.append(v_toward)
    c_snd = 343.0
    return (c_snd - out[1]) / (c_snd - out[0])  # f_i / f_j: observer i hears f_s c/(c - v_i)


def _job(args):
    c, gain = args
    c = dict(c, gain_db=gain)
    r = R.run_crossing(c, _MASTER, [R.CHOSEN])
    if not r:
        return gain, c["cls"], None
    x = r[0]
    pairs = []  # the first in-window onset of node i with an in-window onset of node i+1 (one pair per onset of i)
    on = x["onsets"]
    for i in sorted(on):
        j = i + 1
        if j not in on:
            continue
        for t1, f1, _ in on[i]:
            if not (x["t_in"] <= t1 <= x["t_out"]):
                continue
            for t2, f2, _ in on[j]:
                if not (x["t_in"] <= t2 <= x["t_out"]):
                    continue
                dop = doppler_ratio(c, i, j, 0.5 * (t1 + t2))
                pairs.append(dict(gap=abs(t1 - t2), f1=f1, f2=f2, ratio=ratio_label(f1, f2),
                                  speed=c["speed"], doppler=dop, obs=(f1 / f2 if f2 > 0 else 0.0),
                                  doppler_ok=bool(f2 > 0 and abs((f1 / f2) / dop - 1) <= fa.GATE_F0_TOL)))
                break
            break
    return gain, c["cls"], dict(pairs=pairs, detected=bool(x["detected"]))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--crossings", type=int, default=40, help="per class")
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    t0 = time.time()
    master, _ = rural_scene(1234, 0.25, (1, 2, 3))
    from multiprocessing import Pool

    jobs = []
    for cls in CLASSES:
        rng = np.random.default_rng(CROSS_SEED)
        cross = R.sample_crossings(args.crossings, CROSS_SEED)
        for c in cross:
            c["cls"] = cls
            c["alt"] = float(rng.uniform(10.0, 100.0))
            for g in GAINS:
                jobs.append((c, g))
    out = {}
    with Pool(args.procs, initializer=_init, initargs=(master,)) as pool:
        res = pool.map(_job, jobs, chunksize=2)
    for cls in CLASSES:
        for g in GAINS:
            rs = [r for (gg, cc, r) in res if cc == cls and gg == g and r is not None]
            pairs = [p for r in rs for p in r["pairs"]]
            n_pairs = len(pairs)
            win_ok = [p for p in pairs if p["gap"] <= fa.GATE_WINDOW_S]
            f0_ok = [p for p in pairs if p["ratio"] in ("1", "2", "1/2")]
            both_ok = [p for p in win_ok if p["ratio"] in ("1", "2", "1/2")]
            rat = Counter(p["ratio"] for p in pairs)
            other = [p for p in pairs if p["ratio"] == "other"]
            dop_ok_other = sum(p["doppler_ok"] for p in other)
            key = f"{cls} {g:+.0f} dB"
            out[key] = dict(crossings=len(rs), gateway_detected=sum(r["detected"] for r in rs), both_detect_pairs=n_pairs,
                            within_window=len(win_ok), f0_octave_ok=len(f0_ok), both_rules=len(both_ok),
                            ratio_counts=dict(rat), other_pairs=len(other), other_explained_by_doppler=dop_ok_other,
                            doppler_ok_all=sum(p["doppler_ok"] for p in pairs), median_gap_s=float(np.median([p["gap"] for p in pairs]))
                            if pairs else None)
            print(f"{key}: crossings {len(rs)}, gateway detected {out[key]['gateway_detected']}, both-detect pairs "
                  f"{n_pairs}, within 30 s {len(win_ok)}, f0 ok (1, 2, 1/2) {len(f0_ok)}, both {len(both_ok)}; "
                  f"ratios {dict(rat)}; 'other' pairs {len(other)}, of which Doppler-explained {dop_ok_other}",
                  flush=True)
    out["seconds"] = time.time() - t0
    print(f"total {out['seconds'] / 60:.1f} min", flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
