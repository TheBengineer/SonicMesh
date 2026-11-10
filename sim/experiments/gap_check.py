# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Why do crossings heard by two or more nodes not reach the gateway? (doc 07 section 12.4d follow-up)

Same crossings and spacings as spacing_check.py, with sub_guard. For each crossing below 100 m with at least two nodes
detecting in the truth window and no gateway pair, the first cause that applies:
  apart     no two detecting nodes are neighbours (the gateway pairs adjacent nodes only);
  time      neighbours both detect, but no onset pair is within the 30 s gateway window;
  f0        onsets within 30 s, but no pair's f0 agrees within 12 %, directly or an octave apart.
For f0 failures it also reports whether the lines rule would pass, whether the median f0 over each lock would pass
instead of the onset f0, whether two lines match at the same absolute frequency at any f0 ratio, and the harmonic each node locked (f0 / blade-pass frequency, from the class table; truth used
only for this label). Diagnostic only, no false-alarm run.

Run:  uv run sim/experiments/gap_check.py --procs 12
"""

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import sys
from collections import Counter
from multiprocessing import Pool
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))
sys.path.insert(0, str(ROOT / "sim" / "perimeter"))

import fa  # noqa: E402
import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402
from acoustics.model import CLASS  # noqa: E402
from detector.detector import Params  # noqa: E402

LINE_M = R.LINE_LEN_M
SPACINGS_M = [350.0, 250.0, 175.0, 120.0, 80.0]


def onsets_with_median(on, f0, t_frame, labels=None, mask=None):
    """As fa.onsets_of, with the median f0 over each lock and the lock length (s) appended."""
    on8 = on.astype(np.int8)
    d = np.diff(np.concatenate([[0], on8, [0]]))
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    out = []
    for s, e in zip(starts, ends):
        f = f0[s:e]
        f = f[f > 0]
        med = float(np.median(f)) if f.size else 0.0
        out.append((float(t_frame[s]), float(f0[s]), None, int(mask[s]) if mask is not None else 0, med,
                    float(t_frame[e - 1] - t_frame[s])))
    return out


fa.onsets_of = onsets_with_median  # run_crossing calls fa.onsets_of; workers fork after this


def in_span(onsets, span):
    return [o for o in onsets if span[0] <= o[0] <= span[1]]


def classify(r):
    span = (r["t_in"], r["t_out"])
    ons = r["onsets"]
    det = sorted(i for i, v in ons.items() if in_span(v, span))
    adj = [(i, i + 1) for i in det if i + 1 in det]
    if not adj:
        return "apart", None
    near = []
    for i, j in adj:
        for a in ons[i]:
            for b in ons[j]:
                if abs(a[0] - b[0]) <= fa.GATE_WINDOW_S and span[0] <= max(a[0], b[0]) <= span[1]:
                    near.append((a, b))
    if not near:
        return "time", None
    bpf = CLASS[r["cls"]][0]
    info = dict(
        lines=any(fa.ratio_lines_ok(a[1], a[3], b[1], b[3]) for a, b in near),
        shared2=any(shared_abs(a, b) >= 2 for a, b in near),
        median=any(fa.f0_match(a[4], b[4]) for a, b in near),
        harm=[(round(a[1] / bpf, 2), round(b[1] / bpf, 2)) for a, b in near[:4]],
        lock_s=[(round(a[5], 1), round(b[5], 1)) for a, b in near[:4]],
    )
    return "f0", info


def shared_abs(a, b, tol=0.03):
    """Lines in a's harmonic mask that b also has at the same absolute frequency, whatever the f0 ratio."""
    la, lb = fa.harmonic_lines(a[1], a[3]), fa.harmonic_lines(b[1], b[3])
    return sum(any(abs(x / y - 1) <= tol for y in lb) for x in la)


def harm_label(f, bpf):
    """The onset f0 as a harmonic k of the blade-pass frequency, or 1/k of it, within 8 %; else 'other'."""
    if f <= 0:
        return "none"
    h = f / bpf
    for k in range(1, 11):
        if abs(h / k - 1) <= 0.08:
            return str(k)
        if k > 1 and abs(h * k - 1) <= 0.08:
            return f"1/{k}"
    return "other"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--crossings", type=int, default=120)
    ap.add_argument("--procs", type=int, default=12)
    ap.add_argument("--spacings", default=",".join(str(int(s)) for s in SPACINGS_M))
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    master, _ = rural_scene(1234, 0.25, (1, 2, 3))
    params = [Params(theta=0.10, sub_guard=True)]
    cross = R.sample_crossings(args.crossings, seed=2026)  # the same flights as spacing_check.py
    result = {}
    for spacing in [float(s) for s in args.spacings.split(",")]:
        R.SPACING_M = spacing
        R.NODES = int(round(LINE_M / spacing)) + 1
        res = []
        with Pool(args.procs, initializer=R._init_worker, initargs=(master,)) as pool:
            for r in pool.imap_unordered(R._crossing_job, [(c, params) for c in cross], chunksize=1):
                if r:
                    res.append(r[0])
        res = [r for r in res if r["alt"] < 100]
        print(f"spacing {spacing:.0f} m", flush=True)
        result[spacing] = {}
        for c in ("fpv", "mini", "matrice"):
            sel = [r for r in res if r["cls"] == c]
            two = [r for r in sel if len(r["node_dist"]) >= 2]
            miss = [r for r in two if not r["detected"]]
            causes = Counter()
            f0info = []
            for r in miss:
                cause, info = classify(r)
                causes[cause] += 1
                if info:
                    f0info.append(info)
            bpf = CLASS[c][0]
            harms = Counter(harm_label(o[1], bpf) for r in sel for v in r["onsets"].values()
                            for o in in_span(v, (r["t_in"], r["t_out"])))
            row = dict(n=len(sel), two=len(two), gw=sum(r["detected"] for r in sel), miss=len(miss),
                       causes=dict(causes), f0_lines_would_pass=sum(i["lines"] for i in f0info),
                       f0_median_would_pass=sum(i["median"] for i in f0info),
                       f0_two_shared_lines=sum(i["shared2"] for i in f0info),
                       onset_harmonics=dict(harms.most_common()), f0_examples=f0info[:6])
            result[spacing][c] = row
            print(f"  {c:8s} n={row['n']:3d} 2+={row['two']:3d} gw={row['gw']:3d} miss={row['miss']:3d} "
                  f"causes={row['causes']} f0: lines pass {row['f0_lines_would_pass']}, median pass "
                  f"{row['f0_median_would_pass']}, 2 shared lines {row['f0_two_shared_lines']}", flush=True)
            print(f"           onset harmonic (f0 / bpf {bpf:.0f} Hz): {row['onset_harmonics']}", flush=True)
            for i in row["f0_examples"][:3]:
                print(f"           e.g. harmonics {i['harm']} lock s {i['lock_s']}", flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
