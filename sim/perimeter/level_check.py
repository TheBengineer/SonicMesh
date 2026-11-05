# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Why +6 dB on mini and matrice moves gateway Pd so little (doc 07 section 2, open item).

Mini and matrice crossings below 100 m on the diagnosis bed (folds 1-3), at source levels 0, +6 and +12 dB
(ASSUMED levels; only the change is meaningful). Same crossings, seeds and bed at each level, so the comparison is
paired. Reports:
  gateway Pd and node Pd below 100 m, from the full perimeter scene (run.run_crossing, theta 0.10, the 30 s octave rule);
  comb score, track age and the fraction of frames on, from the single-node layer test (bed_layers.one_pass) on the
  same geometries as the layer split.

Run:  uv run sim/perimeter/level_check.py --crossings 48
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

import bed_layers as B  # noqa: E402
import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402

GAINS = (0.0, 6.0, 12.0)
CLASSES = ("mini", "matrice")
CROSS_SEED = 3030  # not used by any earlier run
ALT_MAX = 100.0


def sample_low(n, seed, cls):
    """Crossings below 100 m for one class, from the same sampler as the scenario (only the altitude is redrawn)."""
    rng = np.random.default_rng(seed)
    out = R.sample_crossings(n, seed)
    for c in out:
        c["cls"] = cls
        c["alt"] = float(rng.uniform(10.0, ALT_MAX))
    return out


def crossing_job(args):
    c, gain = args
    c = dict(c, gain_db=gain)
    return gain, R.run_crossing(c, R_MASTER, [R.CHOSEN])


R_MASTER = None


def _init(master, pink_bed, ev):
    global R_MASTER
    R_MASTER = master
    B.MASTERS["pink"] = pink_bed  # the layer rows use the same pink and event beds as bed_layers.py
    B.MASTERS["events"] = ev


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--crossings", type=int, default=48, help="per class")
    ap.add_argument("--passes", type=int, default=4, help="layer-test passes per geometry")
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    t0 = time.time()
    master, _ = rural_scene(1234, 0.25, (1, 2, 3))  # the tuning bed of run.py --tune
    pink_bed, ev, _ = B.build_masters()
    from multiprocessing import Pool

    out = {}
    with Pool(args.procs, initializer=_init, initargs=(master, pink_bed, ev)) as pool:
        for cls in CLASSES:
            cross = sample_low(args.crossings, CROSS_SEED + (0 if cls == "mini" else 1), cls)
            jobs = [(c, g) for c in cross for g in GAINS]
            res = {g: [] for g in GAINS}
            for gain, r in pool.imap_unordered(crossing_job, jobs, chunksize=1):
                if r:
                    res[gain].append((r[0]["detected"], r[0]["node_detected"]))
            for g in GAINS:
                pairs = res[g]
                n = len(pairs)
                out.setdefault(cls, {})[f"{g:+.0f} dB"] = dict(
                    n=n, gateway_pd=float(np.mean([p[0] for p in pairs])) if n else None,
                    node_pd=float(np.mean([p[1] for p in pairs])) if n else None)
            print(f"{cls}: " + ", ".join(f"{k} gw {v['gateway_pd']:.2f} node {v['node_pd']:.2f} (n={v['n']})"
                                       for k, v in out[cls].items()), flush=True)
        print(f"crossings done in {time.time() - t0:.0f} s", flush=True)
        # layer test rows at each gain, same geometries and passes as bed_layers.py
        geo = [(a, s) for a in B.ALTS for s in B.SPEEDS]
        rows = ["full, source +6 dB", "full, source +12 dB", "+ pink + events + wind 2"]
        jobs = []
        for alt, spd in geo:
            for cls in CLASSES:
                for p in range(args.passes):
                    for row in rows:
                        jobs.append((cls, alt, spd, 5000 + 100 * p + int(alt) + int(spd), row))
        lay = pool.map(B.one_pass, jobs, chunksize=4)
    names = {"full, source +6 dB": "+6", "full, source +12 dB": "+12", "+ pink + events + wind 2": "0"}
    for cls in CLASSES:
        for row in rows:
            r = [x for x in lay if x["cls"] == cls and x["row"] == row]
            out.setdefault("layer", {}).setdefault(cls, {})[names[row]] = dict(
                n=len(r), age_med=float(np.median([x["age"] for x in r])),
                node_pd=float(np.mean([x["node"] for x in r])),
                on=float(np.mean([x["on"] for x in r])),
                comb_med=float(np.median([x["comb"] for x in r])),
                comb_src_med=float(np.median([x["comb_src"] for x in r])))
            s = out["layer"][cls][names[row]]
            print(f"layer {cls:8s} {names[row]:>3s} dB: age {s['age_med']:.0f}, node Pd {s['node_pd']:.2f}, "
                  f"on {s['on']:.2f}, comb {s['comb_med']:.3f}, comb at bpf {s['comb_src_med']:.3f} (n={s['n']})",
                  flush=True)
    out["seconds"] = time.time() - t0
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1, default=float))
    print(f"total {out['seconds'] / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
