"""Parameter sweeps. Every combination of the --vary values is run on the scenario and scored.

Replay mode runs each point offline (up to 4 worker processes; each reads the cached 16 kHz clips
one block at a time). Hardware mode sets the values on every node (verified by echo), runs the
scenario (its own run directory per point), and at the end restores the values the boards had before.
Results go to data/bench/<stamp>-sweep/results.jsonl and a table sorted by cost is printed.
"""

import itertools
import json
import multiprocessing
import os
from datetime import datetime, timezone

from . import BENCH_DIR, audio, replay, run, score, scenario as scen, tuning
from .device import Board

MAX_WORKERS = 4


def parse_vary(specs):
    """["gunshot.ratio_db=12,15"] -> [("gunshot.ratio_db", [12.0, 15.0])]."""
    out = []
    for spec in specs:
        if "=" not in spec:
            raise ValueError(f"--vary needs name=v1,v2,...: {spec}")
        name, _, values = spec.partition("=")
        nums = [float(v) for v in values.split(",") if v.strip()]
        if not nums:
            raise ValueError(f"--vary {name} has no values")
        out.append((name.strip(), nums))
    return out


def grid(vary):
    names = [n for n, _ in vary]
    for combo in itertools.product(*[v for _, v in vary]):
        yield dict(zip(names, combo))


def _replay_point(args):
    scenario, overrides, base, tolerance, quiet_spl, chain = args
    values = tuning.merge(base, overrides)
    run_out = replay.replay_scenario(scenario, values, quiet_spl_db=quiet_spl, chain=chain)
    result = score.score_run(run_out.windows, run_out.events, run_out.span, tolerance, offset=0.0)
    result["chain"] = chain.describe() if chain is not None else None
    return overrides, result


def _format_row(overrides, result):
    t = result["totals"]
    lat = t["drone_mean_latency_s"]
    return (f"{result['cost']:9.2f}  {t['misses']:>6}  {t['extra_shots']:>5}  {t['quiet_shots']:>5}  "
            f"{t['drone_detected']:>3}/{t['drone_clips']:<3}  "
            f"{'-' if lat is None else f'{lat:.2f}':>7}  {t['drone_false_on_s']:>8.1f}   "
            + ", ".join(f"{k}={v:g}" for k, v in overrides.items()))


def table(rows):
    head = ("   cost  misses  extra  quiet  drone    lat_s  false_on_s   settings")
    lines = [head] + [_format_row(o, r) for o, r in sorted(rows, key=lambda x: x[1]["cost"])]
    return "\n".join(lines)


def _sweep_dir(label):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(BENCH_DIR, f"{stamp}-{label}")
    os.makedirs(path, exist_ok=True)
    return path


def replay_sweep(scenario, vary, base, tolerance=0.03, quiet_spl=40.0, workers=MAX_WORKERS, chain=None):
    """Offline sweep. chain: a replay.Chain (the measured bench chain) or None for the plain model. Every
    result line records the chain's profiles in its "chain" key."""
    out_dir = _sweep_dir(f"{scenario.name}-sweep")
    for seg in scen.plan(scenario):  # cache the clips once, before the workers start
        if seg.kind in scen.CLIP_KINDS:
            audio.cached_clip(seg.path)
    jobs = [(scenario, o, base, tolerance, quiet_spl, chain) for o in grid(vary)]
    rows = []
    n = min(workers, max(1, os.cpu_count() or 1), MAX_WORKERS)
    with multiprocessing.Pool(n) as pool:
        for overrides, result in pool.imap_unordered(_replay_point, jobs):
            rows.append((overrides, result))
    _write_results(out_dir, rows)
    return out_dir, rows


def hardware_sweep(scenario, nodes, gateway, vary, base, max_s=None, tolerance=0.03):
    out_dir = _sweep_dir(f"{scenario.name}-sweep")
    rows, restore = [], None
    try:
        for i, overrides in enumerate(grid(vary), 1):
            values = tuning.merge(base, overrides)
            sub = os.path.join(out_dir, f"run-{i:02d}")
            os.makedirs(sub, exist_ok=True)
            summary = run.run_scenario(scenario, nodes, gateway, values, {}, sub, max_s=max_s,
                                       tolerance=tolerance)
            if restore is None:
                restore = summary["before"]
            result = summary["scores"].get("node") or next(iter(summary["scores"].values()))
            result = dict(result, run_dir=summary["run_dir"])
            rows.append((overrides, result))
    finally:
        if restore:
            _restore(nodes, restore)
    _write_results(out_dir, rows)
    return out_dir, rows


def _restore(nodes, before):
    for port in nodes:
        if before.get(port):
            b = Board(port).open()
            try:
                b.set(before[port])
            finally:
                b.close()


def _write_results(out_dir, rows):
    with open(os.path.join(out_dir, "results.jsonl"), "w", encoding="utf-8") as fh:
        for overrides, result in rows:
            fh.write(json.dumps({"overrides": overrides, **result}) + "\n")
