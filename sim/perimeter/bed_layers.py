# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Layer test for the rural bed: which part of the background costs the mini and matrice comb score.

One node, one pass per row, folds 1-3 only (the diagnosis folds). Each row adds one layer to a clean propagated pass:
propagation only, turbulence, pink ambient alone, ESC events alone, pink and events together, the full rural scene
(pink, events and 2 m/s wind), and wind alone. Geometries cover altitudes, speeds and crossing offsets from the node.
Every pass uses its own seed, so the rows share the drone, the turbulence and the crossing offset for a given pass.

Per pass, measured within 300 m of the node (the same window as the earlier layer test):
  age       longest continuous track age (frames; the gate is 62)
  on        share of frames with the track on
  node      whether the track switched on at any time within 300 m (node Pd for this geometry)
  comb      median over frames of the best comb score (theta 0.10 is the threshold)
  comb_src  median over frames of the comb score at the class's true blade-pass frequency (diagnostic: uses truth,
            never fed back into the detector)
  line_db   median over frames of the line-to-floor ratio (whitened power at the true harmonics, dB; diagnostic)
  floor_db  mean rise of the noise floor at the true harmonic bins between the start of the pass and closest
            approach (dB; a rise means the tracker is absorbing the line)

Run:  uv run sim/perimeter/bed_layers.py --quick
      uv run sim/perimeter/bed_layers.py --passes 20 --json <path>
"""

import os
import sys
from pathlib import Path

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import json
import math
import time

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))
sys.path.insert(0, str(ROOT / "sim" / "perimeter"))

import run as R  # noqa: E402
from acoustics.background import rural_scene  # noqa: E402
from acoustics.model import BLOCK, CLASS, DETECTOR_MIC_H_M, FS, SELF_NOISE_DB, TICK_S  # noqa: E402
from acoustics.noise import pink, white, wind  # noqa: E402
from acoustics.scene import padded, render_mic  # noqa: E402
from acoustics.source import drone_source  # noqa: E402
from acoustics.turbulence import turbulence  # noqa: E402
from detector.detector import Detector, Params, Track, geometry  # noqa: E402


MASTER_H = 0.25
MASTER_SEED = 1234
FOLDS = (1, 2, 3)
AMBIENT_DB = 40.0
ALTS = (20.0, 50.0, 90.0)
SPEEDS = (5.0, 15.0, 25.0)
OFFSETS_M = (-150.0, -50.0, 50.0, 150.0)  # closest-approach offset from the node (uniform choice per pass)
THETA = 0.10
WIN_M = 300.0
EVENTS_ONLY_DB = -200.0  # pink level that makes the ambient inaudible while keeping the event draws identical
ROWS = {
    "prop only": dict(turb=False, pink=False, events=False, wind=0.0),
    "+ turbulence": dict(turb=True, pink=False, events=False, wind=0.0),
    "+ pink": dict(turb=True, pink=True, events=False, wind=0.0),
    "+ events": dict(turb=True, pink=False, events=True, wind=0.0),
    "+ pink + events": dict(turb=True, pink=True, events=True, wind=0.0),
    "+ pink + events + wind 2": dict(turb=True, pink=True, events=True, wind=2.0),
    "+ wind 2 only": dict(turb=True, pink=False, events=False, wind=2.0),
}
GAIN_ROWS = {  # step 3: the full rural scene with the source level raised (ASSUMED levels; relative change only)
    "full, source +6 dB": dict(turb=True, pink=True, events=True, wind=2.0, gain=6.0),
    "full, source +12 dB": dict(turb=True, pink=True, events=True, wind=2.0, gain=12.0),
}
ROWS.update(GAIN_ROWS)
CLASSES = ("fpv", "mini", "matrice")

MASTERS = {}  # set by the pool initializer: "pink", "events" arrays (events includes no ambient)


def build_masters(seconds_h=MASTER_H, ambient_db=AMBIENT_DB):
    """Pink ambient alone, and the events alone (rural scene with the ambient at -200 dB and no wind). The events
    are the same draw as the rural scene with the same seed, so pink + events equals the rural scene without wind."""
    n = int(round(seconds_h * 3600 * FS))
    rng = np.random.default_rng(MASTER_SEED)
    pink_bed = pink(rng, n, ambient_db)  # same first draw as rural_scene, so the same pink
    ev, events = rural_scene(MASTER_SEED, seconds_h, FOLDS, ambient_db=EVENTS_ONLY_DB, wind_ms=0.0)
    return pink_bed, ev, len(events)


def _init(pink_bed, ev):
    from fa import _limit_memory  # 3 GB address space per worker

    _limit_memory()
    MASTERS["pink"] = pink_bed
    MASTERS["events"] = ev


def _geometry_list(quick):
    geo = []
    for alt in (ALTS[:1] if quick else ALTS):
        for spd in (SPEEDS[:1] if quick else SPEEDS):
            geo.append((alt, spd))
    return geo


def one_pass(job):
    """One node-pass for one row. job = (cls, alt, speed, seed, row name, n_fft, hop). Returns a dict of the metrics."""
    cls, alt, spd, seed, row_name, n_fft, hop = job
    row = ROWS[row_name]
    g = geometry(n_fft, hop)
    par = Params(theta=THETA, n_fft=n_fft, hop=hop)
    gain = 10 ** (row.get("gain", 0.0) / 20)
    rng_geo = np.random.default_rng(seed * 7919 + 13)
    node = 6 + int(rng_geo.integers(0, 2))
    nx = node * R.SPACING_M
    xc = nx + float(rng_geo.choice(OFFSETS_M))
    c = dict(cls=cls, alt=alt, speed=spd, angle=math.pi / 2, xc=xc, wind=row["wind"], seed=seed)
    tr = R.track_of(c)
    tk = tr["t"]
    src = drone_source(cls, np.ones(len(tk) * R.TICK_SAMPLES), rng=np.random.default_rng(seed),
                       wobble=True, broadband=True) * gain
    sp = padded(src, int(R.PAD_S * FS))
    d3 = np.sqrt((tr["x"] - nx) ** 2 + tr["y"] ** 2 + (tr["z"] - DETECTOR_MIC_H_M) ** 2)
    ins = np.flatnonzero(d3 < R.WINDOW_M)
    na = max(0, ins[0] * R.TICK_SAMPLES - int(R.WARM_S * FS))
    nb = min((ins[-1] + 1) * R.TICK_SAMPLES, len(tk) * R.TICK_SAMPLES)
    m = nb - na
    rng = np.random.default_rng(seed * 31 + node)
    kw = {}
    if row["turb"]:
        dfn, gfn = turbulence(rng, tk, d3)
        kw = dict(delay_fn=dfn, gain_fn=gfn)
    sig = render_mic(sp, int(R.PAD_S * FS), tr, (nx, 0.0, DETECTOR_MIC_H_M), na, nb, block=BLOCK * 10, **kw)
    off = int(np.random.default_rng(seed + 1).integers(0, len(MASTERS["pink"]) - m))
    if row["pink"]:
        sig = sig + MASTERS["pink"][off : off + m]
    if row["events"]:
        sig = sig + MASTERS["events"][off : off + m]
    if row["wind"] > 0:
        sig = sig + wind(rng, m, row["wind"])
    sig = sig + white(rng, m, SELF_NOISE_DB)

    bpf = CLASS[cls][0]
    k = np.arange(1, 5)
    true_bins = np.rint(bpf * k / g.DF).astype(int)  # the class's own harmonics (diagnostic only)
    true_idx = int(np.argmin(np.abs(g.F0 - bpf)))
    det = Detector(par)
    tracks = Track(g)
    fr = np.lib.stride_tricks.sliding_window_view(sig, g.N)[:: g.HOP]
    best_age, n_on, n_fr, S_best, S_src, lines = 0, 0, 0, [], [], []
    node_on = False
    floor_start, floor_close = None, None
    for c0 in range(0, len(fr), 512):
        S, W, ok = det.comb_batch(det.power_frames(fr[c0 : c0 + 512]))
        for j in np.flatnonzero(ok):
            i = c0 + j
            on = tracks.update(S[j], W[j], par)
            ts = (na + i * g.HOP + g.N / 2) / FS
            dd = d3[min(int(ts / TICK_S), len(d3) - 1)]
            if floor_start is None and det.floor is not None:
                floor_start = det.floor[true_bins[(true_bins > g.LO_BIN) & (true_bins < g.NB - 1)]].copy()
            if dd < WIN_M:
                n_fr += 1
                best_age = max(best_age, tracks.age if tracks.q > 0 else 0)
                n_on += bool(on)
                node_on = node_on or bool(on)
                S_best.append(float(S[j].max()))
                S_src.append(float(S[j][true_idx]))
                # line-to-floor ratio: whitened power at the true harmonic bins, relative to the floor (0 dB at floor)
                bins = true_bins[(true_bins > g.LO_BIN) & (true_bins < g.NB - 1)]
                lines.append(10 * math.log10(max(float(np.max(W[j][bins])), 1e-12)))
                floor_close = det.floor[bins].copy()
    floor_rise = float(np.mean(floor_close - floor_start)) if (floor_close is not None and floor_start is not None) else 0.0
    return dict(cls=cls, alt=alt, speed=spd, row=row_name, n_fft=n_fft, hop=hop, age=best_age, on=n_on / max(n_fr, 1), node=node_on,
                comb=float(np.median(S_best)) if S_best else 0.0,
                comb_src=float(np.median(S_src)) if S_src else 0.0,
                line_db=float(np.median(lines)) if lines else 0.0,
                floor_db=floor_rise)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--passes", type=int, default=20)
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--ambient-db", type=float, default=AMBIENT_DB,
                    help="pink ambient level (ASSUMED 40 dB SPL; sensitivity only)")
    ap.add_argument("--rows", default=None, help="'|'-separated row names to run (default: all)")
    ap.add_argument("--classes", default=None, help="comma-separated classes (default: all)")
    ap.add_argument("--frames", default="1024/512",
                    help="'|'-separated n_fft/hop pairs, e.g. 1024/512|2048/1024 (one run per pair)")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    frames = [tuple(int(v) for v in f.split("/")) for f in args.frames.split("|")]
    passes = 2 if args.quick else args.passes
    t0 = time.time()
    pink_bed, ev, n_events = build_masters(ambient_db=args.ambient_db)
    if args.rows:
        keep = args.rows.split("|")
        for name in list(ROWS):
            if name not in keep:
                del ROWS[name]
    if args.classes:
        CLASSES_RUN = tuple(args.classes.split(","))
    else:
        CLASSES_RUN = CLASSES
    print(f"masters: {MASTER_H} h, folds {FOLDS}, pink {args.ambient_db} dB SPL, events {n_events} clips, "
          f"{time.time() - t0:.0f} s", flush=True)
    from multiprocessing import Pool

    res, summary = [], {}
    for n_fft, hop in frames:
        jobs = []
        for alt, spd in _geometry_list(args.quick):
            for cls in (CLASSES_RUN[:1] if args.quick else CLASSES_RUN):
                for p in range(passes):
                    for row in ROWS:
                        jobs.append((cls, alt, spd, 5000 + 100 * p + int(alt) + int(spd), row, n_fft, hop))
        t1 = time.time()
        with Pool(args.procs, initializer=_init, initargs=(pink_bed, ev)) as pool:
            res_f = pool.map(one_pass, jobs, chunksize=4)
        res += res_f
        print(f"frame {n_fft}/{hop}: {len(jobs)} node-passes in {time.time() - t1:.0f} s with {args.procs} workers",
              flush=True)
        print("frame   class   row                       n   med age  node Pd  on  med comb  med comb@bpf  "
              "line dB  floor rise dB")
        for cls in (CLASSES_RUN[:1] if args.quick else CLASSES_RUN):
            for row in ROWS:
                r = [x for x in res_f if x["cls"] == cls and x["row"] == row]
                s = dict(n=len(r), age_med=float(np.median([x["age"] for x in r])),
                         node_pd=float(np.mean([x["node"] for x in r])), on=float(np.mean([x["on"] for x in r])),
                         comb_med=float(np.median([x["comb"] for x in r])),
                         comb_src_med=float(np.median([x["comb_src"] for x in r])),
                         line_db_med=float(np.median([x["line_db"] for x in r])),
                         floor_db_med=float(np.median([x["floor_db"] for x in r])))
                summary[f"{n_fft}|{cls}|{row}"] = s
                print(f"{n_fft:5d}   {cls:8s}{row:26s}{s['n']:4d}{s['age_med']:9.0f}{s['node_pd']:9.2f}{s['on']:5.2f}"
                      f"{s['comb_med']:10.3f}{s['comb_src_med']:14.3f}{s['line_db_med']:9.1f}{s['floor_db_med']:14.2f}",
                      flush=True)
    out = dict(rows=res, summary=summary, passes=passes, frames=frames, geometries=_geometry_list(args.quick),
               seconds=time.time() - t0)
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
