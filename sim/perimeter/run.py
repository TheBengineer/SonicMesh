# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Perimeter scenario runner: 13 detector nodes 350 m apart, random crossings, background false alarms.

Crossings: class, altitude 10-120 m, speed 5-25 m/s, crossing angle 40-140 deg, crossing point along the line, and
wind 0-8 m/s. A node renders the drone while it is within 600 m (plus 10 s warm-up). A crossing is detected when the
gateway alarms while the drone is within 400 m of the line (node-level Pd is reported too).

Controllers: nodes 1-4 (A), 5-9 (B), 10-13 (C). Pairs across A|B (nodes 4-5) and B|C (nodes 9-10) cross a boundary.
Confirmation latency with and without node-to-node is a timing model (ASSUMED, see CONFIRM_*), not a network stack.

Modes:
  default   held-out evaluation (folds 4-5) with the chosen setting CHOSEN; false alarms in rural and dense beds,
            crossings, node-to-node confirmation across the boundary.
  --tune    folds 1-3 only: threshold grid, for both gateway rules (the old one and the current one).
  --ablate  folds 1-3 only: each rejection step switched off one at a time.

Run:  uv run sim/perimeter/run.py --quick           (about 2 min)
      uv run sim/perimeter/run.py --tune            (folds 1-3, about 15 min)
      uv run sim/perimeter/run.py --ablate          (folds 1-3)
      uv run sim/perimeter/run.py                   (held-out, see docs/research/07 for the sizes used)
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
from scipy import stats

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
LINE_KM = LINE_LEN_M / 1000.0
FA_TARGET_PER_KM_DAY = 1.0
# Chosen on folds 1-3 (--tune): the highest gateway Pd below 100 m with no more than 1 per km per day in the 39
# node-hour dev bed (point estimate). Grid edge: 0.10 is the lowest theta tried.
CHOSEN = Params(theta=0.10)
THETAS = [0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.23, 0.26, 0.30]
# Node-to-node timing model (ASSUMED, from docs/protocol-v0.md 3a). Event superframe 500 ms, idle 4 s, backbone 500 ms
# with a 38.5 ms message; AIR_S is an assumed DETECT airtime and CTRL_S an assumed controller processing time.
CONFIRM_EVENT_SF_S = 0.5
CONFIRM_IDLE_SF_S = 4.0
CONFIRM_AIR_S = 0.05
CONFIRM_BB_SF_S = 0.5
CONFIRM_BB_AIR_S = 0.0385
CONFIRM_CTRL_S = 0.05
SUBSECTION = {"A": range(0, 4), "B": range(4, 9), "C": range(9, 13)}


MASTER = None  # background bed for the crossing workers (set by the pool initializer)


def _init_worker(master):
    global MASTER
    MASTER = master


def _crossing_job(args):
    c, params_list = args
    return run_crossing(c, MASTER, params_list)


def map_crossings(crossings, master, params_list, procs=6):
    """run_crossing over a list of crossings in worker processes (each worker one BLAS thread)."""
    from multiprocessing import Pool

    with Pool(procs, initializer=_init_worker, initargs=(master,)) as pool:
        return pool.map(_crossing_job, [(c, params_list) for c in crossings], chunksize=1)


def both_pairs_in(node_onsets, span):
    """Adjacent node pairs where both nodes have an onset in span (f0 not checked): (i, j, t_i, t_j) first onsets."""
    out = []
    for i in sorted(node_onsets):
        j = i + 1
        if j not in node_onsets:
            continue
        a = [t for t, _, _ in node_onsets[i] if span[0] <= t <= span[1]]
        b = [t for t, _, _ in node_onsets[j] if span[0] <= t <= span[1]]
        if a and b:
            out.append((i, j, a[0], b[0]))
    return out


def controller_of(node):
    for name, rng in SUBSECTION.items():
        if node in rng:
            return name
    raise ValueError(node)


def boundary(i, j):
    """True when the pair's two nodes have different primary controllers."""
    return controller_of(i) != controller_of(j)


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
    """Per parameter set: gateway detection, node detection, gateway pairs in the window, and node onset distances.

    The parameter sets must share the impulse setting (they share one comb in fa.detector_flags).
    """
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
    node_dist = [dict() for _ in params_list]
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
            for t, _, _ in node_onsets[k][i]:
                if t_in <= t <= t_out:
                    node_dist[k].setdefault(i, float(d3[min(int(round(t / TICK_S)), len(d3) - 1)]))
                    break
    out = []
    for k in range(len(params_list)):
        pairs = gateway_pairs_in(node_onsets[k], (t_in, t_out), NEW_RULE)
        node_hit = any(any(t_in <= t <= t_out for t, _, _ in v) for v in node_onsets[k].values())
        out.append(dict(cls=c["cls"], alt=c["alt"], wind=c["wind"], detected=bool(pairs), node_detected=node_hit,
                        pairs=pairs, t_in=float(t_in), t_out=float(t_out), onsets=node_onsets[k],
                        node_dist=node_dist[k]))
    return out


def gateway_pairs_in(node_onsets, span, rule):
    """Gateway pairs under a rule (window s, f0 ratios) whose later onset falls in span. Rule is applied by value."""
    old = (fa.GATE_WINDOW_S, fa.GATE_OCTAVE)
    try:
        fa.GATE_WINDOW_S, fa.GATE_OCTAVE = rule
        pairs = fa.gateway_pairs(node_onsets)
    finally:
        fa.GATE_WINDOW_S, fa.GATE_OCTAVE = old
    return [p for p in pairs if span[0] <= max(p[2], p[3]) <= span[1]]


def confirm_latency(pairs_list, node_to_node, rng, mode="event"):
    """Confirmation time after the later onset of each gateway pair, under the timing model above.

    Without node-to-node a boundary pair waits for the backbone as well: the controller of the earlier node must
    forward its report over the backbone superframe. With node-to-node the boundary node hears its neighbour's DETECT
    in the neighbour's own slot, so the wait is the same as inside a cluster.
    """
    sf = CONFIRM_EVENT_SF_S if mode == "event" else CONFIRM_IDLE_SF_S
    lat = []
    for pair, t_in in pairs_list:
        i, j, t1, t2 = pair
        w = rng.uniform(0.0, sf) + CONFIRM_AIR_S
        if boundary(i, j) and not node_to_node:
            w += rng.uniform(0.0, CONFIRM_BB_SF_S) + CONFIRM_BB_AIR_S + CONFIRM_CTRL_S
        lat.append(dict(wait=w, t_conf=max(t1, t2) + w, from_entry=max(t1, t2) + w - t_in, boundary=boundary(i, j)))
    return lat


def fa_rates(onsets_by_node, hours):
    """Node-level alarms per node-day, and gateway alarms per km per day (pairs as in the gateway rule)."""
    node_alarms = sum(len(v) for v in onsets_by_node.values())
    node_hours = hours * NODES
    gw = len(fa.gateway_events(onsets_by_node))
    return dict(node_alarms=node_alarms, node_per_node_day=node_alarms / node_hours * 24.0,
                gateway_alarms=gw, per_km_day=gw / (hours * LINE_KM) * 24.0)


def upper_bound_per_km_day(events, hours, conf=0.95):
    """One-sided Poisson upper bound on gateway alarms per km per day, from events in hours of whole-line time."""
    u = stats.chi2.ppf(conf, 2 * events + 2) / 2.0
    return u / (hours / 24.0 * LINE_KM)


def hours_for_bound(target=FA_TARGET_PER_KM_DAY, events=0, conf=0.95):
    """Line-hours needed for the upper bound to reach target with the given number of events."""
    u = stats.chi2.ppf(conf, 2 * events + 2) / 2.0
    return u / (target * LINE_KM) * 24.0


def pd_by(res, key, lo=0.0, hi=1e9):
    sel = [r for r in res if lo <= r["alt"] < hi]
    d = sum(r[key] for r in sel)
    return d, len(sel)


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


def score(res, lo=0.0, hi=1e9):
    """Gateway and node Pd for crossings with alt in [lo, hi). Default: all altitudes."""
    sel = [r for r in res if lo <= r["alt"] < hi]
    n = len(sel)
    return dict(n=n, gateway=(sum(r["detected"] for r in sel) / n if n else None),
                node=(sum(r["node_detected"] for r in sel) / n if n else None))


OLD_RULE = (10.0, (1.0,))  # the rule before this change: 10 s window, f0 within 12 % without octave allowance
NEW_RULE = (30.0, (1.0, 2.0, 0.5))  # current: 30 s window, f0 within 12 % directly or an octave apart


def tune(args, master):
    n_cross, hours = args.crossings or 120, args.hours or 3.0
    params = [Params(theta=th) for th in THETAS]
    print(f"TUNE folds 1-3: {n_cross} crossings, bed {hours} h per node, thetas {THETAS}", flush=True)
    res_by = {th: [] for th in THETAS}
    t0 = time.time()
    for r in map_crossings(sample_crossings(n_cross, seed=2026), master, params):
        if r:
            for th, x in zip(THETAS, r):
                res_by[th].append(x)
    print(f"crossings done in {time.time() - t0:.0f} s", flush=True)
    bed = fa.scene_alarms("rural", params, hours, (1, 2, 3), seed=6000, nodes=NODES)
    print("theta | node Pd<100 | gateway Pd<100 old / new | node FA per node-day | gateway FA per km-day old / new")
    table = {}
    for th, onsets in zip(THETAS, bed):
        sel = [r for r in res_by[th] if r["alt"] < 100]
        n = len(sel)
        old_pd = sum(bool(gateway_pairs_in_span(r, OLD_RULE)) for r in sel) / n
        new_pd = sum(r["detected"] for r in sel) / n
        node_pd = sum(r["node_detected"] for r in sel) / n
        fa_new = fa_rates(onsets, hours)
        old_ev = len(gateway_events_rule(onsets, OLD_RULE))
        table[th] = dict(n_below100=n, node_pd=node_pd, gw_pd_old=old_pd, gw_pd_new=new_pd,
                         node_alarms=fa_new["node_alarms"], node_per_node_day=fa_new["node_per_node_day"],
                         gw_old_events=old_ev, gw_old_per_km_day=old_ev / (hours * LINE_KM) * 24.0,
                         gw_new_events=fa_new["gateway_alarms"], gw_new_per_km_day=fa_new["per_km_day"])
        print(f"{th:5.2f} | {node_pd:11.2f} | {old_pd:9.2f} / {new_pd:5.2f} | {fa_new['node_per_node_day']:20.1f} | "
              f"{table[th]['gw_old_per_km_day']:8.2f} / {fa_new['per_km_day']:6.2f}", flush=True)
    return table


def gateway_pairs_in_span(r, rule):
    return gateway_pairs_in(r["onsets"], (r["t_in"], r["t_out"]), rule)


def gateway_events_rule(onsets, rule):
    return gateway_pairs_in(onsets, (-1e18, 1e18), rule)


def ablate(args, master):
    """Each rejection step off one at a time (folds 1-3). Impulse needs its own comb, so it runs separately."""
    n_cross = args.crossings or 120
    sets = {
        "all on (CHOSEN)": CHOSEN,
        "no track age": Params(theta=CHOSEN.theta, use_age=False),
        "age 1 s (16 frames)": Params(theta=CHOSEN.theta, age_min=16),
        "good_frac 0": Params(theta=CHOSEN.theta, good_frac=0.0),
        "no harmonicity": Params(theta=CHOSEN.theta, use_harm=False),
        "slew on (for reference)": Params(theta=CHOSEN.theta, use_slew=True),
    }
    no_imp = {"no impulse rejection": Params(theta=CHOSEN.theta, use_impulse=False)}
    names = list(sets) + list(no_imp)
    res = {k: [] for k in names}
    cross = sample_crossings(n_cross, seed=2026)
    for r in map_crossings(cross, master, list(sets.values())):
        if r:
            for k, x in zip(sets, r):
                res[k].append(x)
    for r in map_crossings(cross, master, list(no_imp.values())):  # impulse needs its own comb
        if r:
            res["no impulse rejection"].append(r[0])
    # false-alarm cost of the settings that remove or relax the track-age gate (rural bed, folds 1-3)
    fa_sets = {k: sets[k] for k in ("all on (CHOSEN)", "no track age", "age 1 s (16 frames)")}
    bed = fa.scene_alarms("rural", list(fa_sets.values()), args.hours or 1.0, (1, 2, 3), seed=7300, nodes=NODES)
    print(f"ABLATE folds 1-3, {n_cross} crossings, theta {CHOSEN.theta}; false alarms: rural bed folds 1-3, "
          f"{args.hours or 1.0} h per node")
    print(f"{'setting':26s} {'node Pd<100':>12s} {'gw Pd<100':>10s} {'gw Pd all':>10s} {'node FA/nd':>11s} "
          f"{'gw FA/km-d':>11s}")
    out = {}
    fa_out = dict(zip(fa_sets, bed))
    for k in names:
        s = score(res[k], 0, 100)
        allp = score(res[k], 0, 1e9)
        out[k] = dict(below100=s, all=allp)
        f = fa_rates(fa_out[k], args.hours or 1.0) if k in fa_out else None
        if f:
            out[k]["fa"] = f
        print(f"{k:26s} {s['node']:12.2f} {s['gateway']:10.2f} {allp['gateway']:10.2f} "
              f"{f['node_per_node_day'] if f else float('nan'):11.1f} {f['per_km_day'] if f else float('nan'):11.2f}")
    return out


def held_out_crossings(args, master):
    """Crossings on the held-out background (folds 4-5), gateway and node Pd, and the node-to-node timing."""
    n_cross = args.crossings or 240
    t0 = time.time()
    print(f"HELD-OUT folds 4-5, chosen theta {CHOSEN.theta}: {n_cross} crossings", flush=True)
    res = []
    lat_event, lat_idle = [], []
    rng_lat = np.random.default_rng(99)
    for r in map_crossings(sample_crossings(n_cross, seed=4040), master, [CHOSEN]):
        if r:
            x = r[0]
            res.append(x)
            # latency: every adjacent pair where both nodes detect in the window (gateway rule not applied, so the
            # comparison has enough pairs); both arms share random draws
            pl = [((i, j, t1, t2), x["t_in"]) for i, j, t1, t2 in both_pairs_in(x["onsets"], (x["t_in"], x["t_out"]))]
            seed_state = int(rng_lat.integers(0, 2**31))
            for mode, bucket in (("event", lat_event), ("idle", lat_idle)):
                for n2n in (False, True):
                    lat = confirm_latency(pl, n2n, np.random.default_rng(seed_state), mode)
                    bucket.append((n2n, lat))
    print(f"crossings: {len(res)} scored in {time.time() - t0:.0f} s", flush=True)
    for row in pd_table(res):
        if row["n"]:
            print(f"  {row['cls']:8s} {row['alt']:10s} {row['wind']:9s} n={row['n']:3d} "
                  f"detected={row['detected']:3d} Pd={row['pd']:.2f}")
    print("gateway Pd by altitude:", {ab: score(res, a0, a1)["gateway"] for ab, a0, a1 in ALT_BANDS + [("<100", 0, 100)]})
    print("node Pd by altitude:", {ab: score(res, a0, a1)["node"] for ab, a0, a1 in ALT_BANDS + [("<100", 0, 100)]})
    print("confirmation latency after the later onset (ASSUMED timing model; s), pairs where both nodes detect:")
    lat_out = {}
    for mode, bucket in (("event", lat_event), ("idle", lat_idle)):
        for n2n in (False, True):
            ws = [w for flag, lat in bucket if flag == n2n for w in lat]
            bw = [w for w in ws if w["boundary"]]
            key = f"{mode} n2n={n2n}"
            lat_out[key] = dict(
                boundary_n=len(bw),
                boundary_wait_med=float(np.median([w["wait"] for w in bw])) if bw else None,
                boundary_from_entry_med=float(np.median([w["from_entry"] for w in bw])) if bw else None,
                boundary_from_entry_p90=float(np.percentile([w["from_entry"] for w in bw], 90)) if bw else None,
                all_n=len(ws),
                all_from_entry_med=float(np.median([w["from_entry"] for w in ws])) if ws else None,
            )
            print(f"  {key:18s} boundary pairs {len(bw):3d}: wait med {lat_out[key]['boundary_wait_med']}, "
                  f"from entry med {lat_out[key]['boundary_from_entry_med']}, p90 {lat_out[key]['boundary_from_entry_p90']}",
                  flush=True)
    return dict(crossings=len(res), pd_below100=score(res, 0, 100), pd_all=score(res, 0, 1e9), latency=lat_out,
                seconds=time.time() - t0)


def held_out_fa(args):
    """Background-only false alarms on the held-out folds 4-5: rural bed and dense stress bed, chosen setting."""
    hours = args.hours or 6.0
    dense_hours = args.dense_hours or 0.5
    out = {}
    t0 = time.time()
    rural = fa.scene_alarms("rural", [CHOSEN], hours, (4, 5), seed=4000, nodes=NODES)[0]
    fr = fa_rates(rural, hours)
    fr["upper95_per_km_day"] = upper_bound_per_km_day(fr["gateway_alarms"], hours)
    cats = {}
    for lst in rural.values():
        for _, _, cat in lst:
            cats[cat] = cats.get(cat, 0) + 1
    fr["node_alarms_by_class"] = cats
    out["rural"] = fr
    print(f"rural bed {hours} h per node ({hours * NODES:.0f} node-h): node alarms {fr['node_alarms']} "
          f"({fr['node_per_node_day']:.3f} per node-day), gateway {fr['gateway_alarms']} "
          f"({fr['per_km_day']:.3f} per km-day; 95% upper {fr['upper95_per_km_day']:.2f}); {time.time() - t0:.0f} s",
          flush=True)
    print("  node alarms by sound class:", sorted(cats.items(), key=lambda kv: -kv[1]), flush=True)
    t0 = time.time()
    dense = fa.scene_alarms("dense", [CHOSEN], dense_hours, (4, 5), seed=5000, nodes=NODES)[0]
    fd = fa_rates(dense, dense_hours)
    fd["upper95_per_km_day"] = upper_bound_per_km_day(fd["gateway_alarms"], dense_hours)
    out["dense"] = fd
    print(f"dense stress bed {dense_hours} h per node: node alarms {fd['node_alarms']} "
          f"({fd['node_per_node_day']:.2f} per node-day), gateway {fd['gateway_alarms']} "
          f"({fd['per_km_day']:.2f} per km-day); {time.time() - t0:.0f} s", flush=True)
    return out


def held_out(args, master):
    t_all = time.time()
    out = dict(chosen=dict(theta=CHOSEN.theta))
    if args.part in ("all", "crossings"):
        out.update(held_out_crossings(args, master))
    if args.part in ("all", "fa"):
        out.update(held_out_fa(args))
    out["runtime_s"] = time.time() - t_all
    print(f"total run time {out['runtime_s'] / 60:.1f} min", flush=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--tune", action="store_true")
    ap.add_argument("--ablate", action="store_true")
    ap.add_argument("--crossings", type=int, default=None)
    ap.add_argument("--hours", type=float, default=None, help="background hours per node")
    ap.add_argument("--dense-hours", type=float, default=None)
    ap.add_argument("--part", default="all", choices=["all", "crossings", "fa"],
                    help="held-out mode only: crossings (Pd and timing) or fa (false alarms), separately")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    if args.quick:
        args.crossings = args.crossings or 12
        args.hours = args.hours or 0.25
        args.dense_hours = args.dense_hours or 0.1
    if args.tune or args.ablate:
        master, _ = rural_scene(1234, 0.25, (1, 2, 3))  # background events from folds 1-3 only
        out = tune(args, master) if args.tune else ablate(args, master)
    else:
        master, _ = rural_scene(7777, 0.25, (4, 5))
        out = held_out(args, master)
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
