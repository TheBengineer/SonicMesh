# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Does reporting the fundamental, rather than the line the track locked, let neighbouring nodes pair? (doc 07 12.4f)

Section 12.4e found that a node often locks one upper harmonic as f0 (a matrice at 700 Hz instead of 100 Hz), so two
nodes report pitches no gateway rule can join. Here detection is unchanged; only the f0 a node reports at an onset is
re-estimated:
  1. average the whitened power over the last second of the track;
  2. take its lines: local peaks at least LINE_MIN above the floor and LINE_FLANK above their flanks, the strongest
     MAX_LINES of them, with parabolic interpolation;
  3. if the locked f0 puts fewer than EXPLAIN of those lines on its harmonics, report the locked f0 / k for the smallest
     k up to K_MAX (searched within +-FINE) that does, with at least MIN_LINES lines; otherwise the locked f0.
So a drone locked at harmonic 7 and also heard at 5 and 9 reports harmonic 1. A first version took the highest f0 on
the whole grid that explained the lines; it moved FPV reports to sub-harmonics when noise lines were present.

Each crossing gives two rows from the same detector run: the locked f0 (as now) and the re-estimated one, scored with
the same gateway rule. --fa also runs the rural false-alarm scene on folds 1-3 for both rows. Not a default: the
detector, comb.ts and the radio report are unchanged.

Run:  uv run sim/experiments/low_f0_check.py --procs 20 [--spacings 350,175,80] [--fa 39]
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import math
import sys
from collections import Counter
from multiprocessing import Pool
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gap_check as G  # noqa: E402  (also installs the onset list with lock medians)

fa, R = G.fa, G.R
from acoustics.model import CLASS  # noqa: E402
from detector.detector import F0_MIN, Detector, Params, Track, geometry, harmonic_bits  # noqa: E402

AVG_HOPS = 31  # frames averaged before the estimate (1 s at the 512 hop)
LINE_MIN = 2.0  # line peak at least 3 dB above the floor, averaged
LINE_FLANK = 2.0  # and 3 dB above the mean of its flanks
FLANK_BINS = (3, 8)  # flank bins either side of the peak
MAX_LINES = 8
EXPLAIN = 0.75
LINE_TOL_HZ = 8.0
LINE_TOL_REL = 0.012
MIN_LINES = 3
K_MAX = 10
FINE = 0.015


def lines_of(Wa, g):
    """Frequencies (Hz) of the strongest lines in an averaged whitened spectrum."""
    out = []
    a, b = FLANK_BINS
    for k in range(max(g.LO_BIN, b + 1), g.NB - b - 1):
        v = Wa[k]
        if v < LINE_MIN or v < Wa[k - 1] or v < Wa[k + 1]:
            continue
        flank = np.concatenate([Wa[k - b : k - a + 1], Wa[k + a : k + b + 1]]).mean()
        if v < LINE_FLANK * max(flank, 1e-12):
            continue
        y0, y1, y2 = (math.log(max(Wa[k + d], 1e-12)) for d in (-1, 0, 1))
        den = y0 - 2 * y1 + y2
        off = 0.5 * (y0 - y2) / den if den < 0 else 0.0
        out.append((v, (k + off) * g.DF))
    out.sort(reverse=True)
    return [f for _, f in out[:MAX_LINES]]


def explained(lines, f):
    """Number of lines on a harmonic of f, within max(LINE_TOL_HZ, LINE_TOL_REL of the line)."""
    L = np.array(lines)
    h = np.rint(L / f)
    return int(np.sum((h >= 1) & (np.abs(L - h * f) <= np.maximum(LINE_TOL_HZ, LINE_TOL_REL * L))))


def fundamental(lines, f_lock):
    """The locked line divided by the smallest k (1 to K_MAX) whose f0 puts at least EXPLAIN of the lines, and at least
    MIN_LINES, on its harmonics, searched within +-FINE of f_lock / k. f_lock when the lock already explains them or
    nothing does: the locked line is the one the track trusts, so the fundamental must divide it."""
    if len(lines) < MIN_LINES:
        return f_lock
    need = max(MIN_LINES, math.ceil(EXPLAIN * len(lines)))
    base = explained(lines, f_lock)
    if base >= need:
        return f_lock
    for k in range(2, K_MAX + 1):
        f_c = f_lock / k
        if f_c < F0_MIN * 0.99:
            break
        best = max(((explained(lines, f), -abs(f / f_c - 1), f) for f in f_c * (1 + FINE * np.linspace(-1, 1, 31))))
        if best[0] >= need and best[0] > base:
            return float(best[2])
    return f_lock


def detector_flags_low(x, params_list):
    """fa.detector_flags for one parameter set, returning two rows: the locked f0, and the re-estimated f0 at onsets."""
    p = params_list[0]
    det = Detector(p)
    g = det.geom
    frames = np.lib.stride_tricks.sliding_window_view(x, g.N)[:: g.HOP]
    tr = Track(g)
    n = len(frames)
    on = np.zeros((2, n), bool)
    f0 = np.zeros((2, n))
    mask = np.zeros((2, n), np.int64)
    ring = np.zeros((AVG_HOPS, g.NB))
    filled = 0
    for c0 in range(0, n, 512):
        S, W, ok = det.comb_batch(det.power_frames(frames[c0 : c0 + 512]))
        for j in np.flatnonzero(ok):
            i = c0 + j
            ring[filled % AVG_HOPS] = W[j]
            filled += 1
            on[0, i] = on[1, i] = tr.update(S[j], W[j], p)
            if on[0, i] and tr.q > 0:
                f0[0, i] = f0[1, i] = g.F0[tr.index]
                mask[0, i] = mask[1, i] = harmonic_bits(W[j], tr.index, g, fa.LINE_KMAX)
                if i == 0 or not on[0, i - 1]:
                    Wa = ring[: min(filled, AVG_HOPS)].mean(axis=0)
                    f0[1, i] = fundamental(lines_of(Wa, g), f0[0, i])
    return on, f0, mask


fa.detector_flags = detector_flags_low  # run_crossing and the false-alarm workers call fa.detector_flags


def crossing_rows(res, cls):
    sel = [r for r in res if r["cls"] == cls and r["alt"] < 100]
    two = [r for r in sel if len(r["node_dist"]) >= 2]
    miss = [r for r in two if not r["detected"]]
    causes = Counter(G.classify(r)[0] for r in miss)
    bpf = CLASS[cls][0]
    harms = Counter(G.harm_label(o[1], bpf) for r in sel for v in r["onsets"].values()
                    for o in G.in_span(v, (r["t_in"], r["t_out"])))
    return dict(n=len(sel), two=len(two), gw=sum(r["detected"] for r in sel), causes=dict(causes),
                harmonics=dict(harms.most_common()))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--crossings", type=int, default=120)
    ap.add_argument("--procs", type=int, default=20)
    ap.add_argument("--spacings", default="350,250,175,120,80")
    ap.add_argument("--fa", type=float, default=0.0, help="rural false-alarm node-hours on folds 1-3 (0: none)")
    ap.add_argument("--ckpt", default=None)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    master, _ = fa.rural_scene(1234, 0.25, (1, 2, 3))
    p = Params(theta=0.10, sub_guard=True)
    params = [p, p]  # two rows from one detector run (see detector_flags_low)
    labels = ["locked f0", "fundamental"]
    cross = R.sample_crossings(args.crossings, seed=2026)  # the same flights as spacing_check.py and gap_check.py
    result = {}
    for spacing in [float(s) for s in args.spacings.split(",")]:
        R.SPACING_M = spacing
        R.NODES = int(round(G.LINE_M / spacing)) + 1
        out = [[], []]
        with Pool(args.procs, initializer=R._init_worker, initargs=(master,)) as pool:
            for r in pool.imap_unordered(R._crossing_job, [(c, params) for c in cross], chunksize=1):
                if r:
                    out[0].append(r[0])
                    out[1].append(r[1])
        print(f"spacing {spacing:.0f} m", flush=True)
        result[spacing] = {}
        for label, res in zip(labels, out):
            result[spacing][label] = {}
            for c in ("fpv", "mini", "matrice"):
                row = crossing_rows(res, c)
                result[spacing][label][c] = row
                print(f"  {label:11s} {c:8s} n={row['n']:3d} 2+={row['two']:3d} gw={row['gw']:3d} "
                      f"misses {row['causes']}  onset harmonic {row['harmonics']}", flush=True)
    if args.fa > 0:
        R.SPACING_M, R.NODES = 350.0, 13
        hours = args.fa / R.NODES
        alarms = fa.scene_alarms("rural", params, hours, (1, 2, 3), 1234, R.NODES, procs=args.procs, ckpt=args.ckpt)
        result["fa"] = {}
        for label, ons in zip(labels, alarms):
            node = sum(len(v) for v in ons.values())
            gw = len(R.gateway_pairs_in(ons, (-1e18, 1e18), R.NEW_RULE))
            per_km_day = gw / (hours * R.LINE_LEN_M / 1000.0) * 24.0
            result["fa"][label] = dict(node_alarms=node, gateway_alarms=gw, per_km_day=per_km_day)
            print(f"false alarms {label:11s}: {args.fa:.0f} node-hours rural, node {node}, gateway {gw} "
                  f"({per_km_day:.2f} per km-day)", flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
