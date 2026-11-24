"""The replay check: a run's capture.wav through the offline detectors, against the node's own events.

The capture is the audio the captured node's detectors received, so replaying it with the node's
parameters should give the node's SHOT and DRONE events again. The replay steps the comb every 512 samples
from its first sample, so the capture is first trimmed to the board's own 512-sample grid (first_sample % 512
samples are dropped; a capture normally starts on a block boundary, so this is usually 0).

Times: the replay's event times (sample index / 16000) become board local times through the capture's
t0_local_us and rate_hz, then host times through the run's node clock fit (the same fit run.py uses for the
node events). Both sides are then host times and can be compared directly.

check.json in the run directory holds the result. Verdict: "replay matches the board" when every SHOT and
DRONE start and end pairs up, else what differs. SHOT pairs must lie within 5 ms, DRONE starts and ends
within 100 ms. A shift is estimated from nearest neighbours within 0.5 s, so a whole-run offset is reported
even when no pair falls inside the tolerance.
"""

import json
import os

import numpy as np

from . import audio, capture, clock, replay, tuning
from .device import parse_json

SHOT_TOL_S = 0.005
DRONE_TOL_S = 0.100
SHIFT_WINDOW_S = 0.5
LIST_LIMIT = 50
CHECK_FILE = "check.json"
REPLAY_NAMES_PREFIXES = ("gunshot.", "drone_comb.")
FULL_SCALE_NAME = "audio.full_scale_db"
DEFAULT_FULL_SCALE_DB = 120.0


def run_params(run_dir, port):
    """Parameters of one node at the run start: those before the run, with the run's set values applied."""
    with open(os.path.join(run_dir, "params.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    ports = data.get("ports", {})
    if port not in ports:
        raise ValueError(f"params.json has no node {port}")
    values = {p["n"]: p["v"] for p in ports[port]["params"]}
    for name, value in (data.get("set") or {}).items():
        if name in values:
            values[name] = value
    return values


def node_clock(run_dir, port):
    """The node's clock fit, from its trace lines in lines.jsonl, as run.py fits it."""
    samples = []
    with open(os.path.join(run_dir, "lines.jsonl"), encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("port") != port or '"tr"' not in row.get("raw", ""):
                continue
            obj = parse_json(row["raw"])
            if obj is not None and obj.get("k") == "tr" and isinstance(obj.get("t"), int):
                samples.append((row["w"], obj["t"]))
    if not samples:
        raise ValueError(f"{port}: no timed trace lines in lines.jsonl; was the rec trace on?")
    return clock.fit_clock(samples)


def node_events(run_dir, port):
    """The node's own SHOT and DRONE events (source node, not merged), from events.jsonl."""
    out = []
    with open(os.path.join(run_dir, "events.jsonl"), encoding="utf-8") as fh:
        for line in fh:
            e = json.loads(line)
            if e.get("source") == "node" and e.get("port") == port:
                out.append(e)
    return out


def _nearest_pairs(a, b, tol):
    """Greedy one-to-one pairing of sorted-by-distance candidates. Returns (pairs, unmatched_a, unmatched_b)."""
    cands = []
    for i, ta in enumerate(a):
        for j, tb in enumerate(b):
            d = tb - ta
            if abs(d) <= tol:
                cands.append((abs(d), i, j))
    cands.sort()
    used_a, used_b, pairs = set(), set(), []
    for _, i, j in cands:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        pairs.append((i, j, b[j] - a[i]))
    un_a = [i for i in range(len(a)) if i not in used_a]
    un_b = [j for j in range(len(b)) if j not in used_b]
    return pairs, un_a, un_b


def _shift(a, b, window):
    """Median of the board-minus-replay gaps to the nearest neighbour within window, or None."""
    if not a or not b:
        return None
    diffs = []
    arr = np.asarray(sorted(b))
    for ta in a:
        k = int(np.searchsorted(arr, ta))
        cands = [arr[j] for j in (k - 1, k) if 0 <= j < len(arr)]
        best = min(cands, key=lambda tb: abs(tb - ta))
        if abs(best - ta) <= window:
            diffs.append(best - ta)
    return float(np.median(diffs)) if diffs else None


def _compare(replay_times, board_times, tol):
    pairs, un_r, un_b = _nearest_pairs(replay_times, board_times, tol)
    diffs = [d for _, _, d in pairs]
    stats = None
    if diffs:
        arr = np.asarray(diffs) * 1000.0
        stats = {"median_ms": round(float(np.median(arr)), 2), "max_abs_ms": round(float(np.max(np.abs(arr))), 2),
                 "mean_ms": round(float(np.mean(arr)), 2)}
    shift = _shift(replay_times, board_times, SHIFT_WINDOW_S)  # board minus replay, as diff
    return {
        "replay": len(replay_times), "board": len(board_times), "matched": len(pairs),
        "replay_only": [round(replay_times[i], 4) for i in un_r][:LIST_LIMIT],
        "board_only": [round(board_times[j], 4) for j in un_b][:LIST_LIMIT],
        "replay_only_count": len(un_r), "board_only_count": len(un_b),
        "diff": stats,
        "shift_ms": None if shift is None else round(shift * 1000.0, 2),
    }


def replay_host_times(samples, meta, values, clk):
    """Runs the detectors on the capture; returns (SHOT host times, {state: DRONE host times}, full scale dB)."""
    rate = float(meta["rate_hz"])
    split = tuning.split_tuning(values)
    fs = float(values.get(FULL_SCALE_NAME, DEFAULT_FULL_SCALE_DB))
    pa = samples.astype(np.float64) / 32768.0 * audio.pa_factor(fs)
    chunks = (pa[i:i + replay.CHUNK].astype(np.float32) for i in range(0, len(pa), replay.CHUNK))
    try:
        if not split.options["gunshot_enabled"]:
            raise ValueError("the gunshot detector was off on the board; the replay check needs it on")
        det = replay.Detectors(split.comb, split.impulse, split.options["update_ms"],
                               split.options["shot_mask_ms"], bool(split.options["comb_enabled"]))
    except KeyError as exc:
        raise ValueError(f"the replay library does not take {exc}") from exc
    try:
        events = replay.run_chunks(chunks, det)
    finally:
        det.close()
    t0 = float(meta["t0_local_us"])

    def host(t_rep):
        local = t0 + t_rep * replay.RATE * 1e6 / rate  # sample index * board sample period
        return clk.to_host(local)

    shots = [host(e["t"]) for e in events if e["type"] == "SHOT"]
    drones = {"start": [], "end": []}
    for e in events:
        if e["type"] == "DRONE" and e["state"] in drones:
            drones[e["state"]].append(host(e["t"]))
    return shots, drones, fs, split


def check(run_dir):
    """Runs the replay check on a run directory. Writes check.json and returns the result dict."""
    samples, meta = capture.load_wav(os.path.join(run_dir, "capture.wav"))
    port = meta["port"]
    first = meta["first_sample"]
    if first is None:
        raise ValueError("capture.wav has no samples")
    trim = (-int(first)) % capture.BLOCK  # samples to drop so that the board's block grid starts at 0
    if trim >= len(samples):
        raise ValueError("the capture is shorter than one block")
    trimmed = samples[trim:]
    meta = dict(meta, t0_local_us=meta["t0_local_us"] + trim * 1e6 / meta["rate_hz"])

    values = run_params(run_dir, port)
    clk = node_clock(run_dir, port)
    shots, drones, fs, split = replay_host_times(trimmed, meta, values, clk)
    own = node_events(run_dir, port)

    board_shots = [e["t"] for e in own if e["type"] == "SHOT"]
    board_drones = {"start": [], "end": []}
    for e in own:
        if e["type"] == "DRONE" and e.get("state") in board_drones:
            board_drones[e["state"]].append(e["t"])

    result_shot = _compare(sorted(shots), sorted(board_shots), SHOT_TOL_S)
    result_drone = {state: _compare(sorted(drones[state]), sorted(board_drones[state]), DRONE_TOL_S)
                    for state in ("start", "end")}

    issues = []
    if result_shot["replay_only_count"] or result_shot["board_only_count"]:
        issues.append(f"SHOT: {result_shot['replay_only_count']} only in replay, "
                      f"{result_shot['board_only_count']} only on the board")
    for state, r in result_drone.items():
        if r["replay_only_count"] or r["board_only_count"]:
            issues.append(f"DRONE {state}: {r['replay_only_count']} only in replay, "
                          f"{r['board_only_count']} only on the board")
    for name, r in [("SHOT", result_shot)] + [(f"DRONE {s}", r) for s, r in result_drone.items()]:
        if r["shift_ms"] is not None and abs(r["shift_ms"]) > (SHOT_TOL_S if name == "SHOT" else DRONE_TOL_S) * 1000:
            issues.append(f"{name}: replay is {r['shift_ms']:+.1f} ms from the board")
    notes = []
    if trim:
        notes.append(f"trimmed {trim} samples to start on the board's 512-sample grid")
    if meta.get("gaps"):
        missing = sum(n for _, n in meta["gaps"])
        notes.append(f"capture has {len(meta['gaps'])} gap(s), {missing} samples zero-filled; "
                     "events near them may differ")
    if meta.get("board_gaps"):
        notes.append(f"the board reported {meta['board_gaps']} block(s) not queued")
    verdict = "replay matches the board" if not issues else "replay differs: " + "; ".join(issues)

    result = {
        "run_dir": run_dir,
        "port": port,
        "capture": {"samples": int(trimmed.size), "seconds": round(trimmed.size / float(meta["rate_hz"]), 3),
                    "first_sample": int(first) + trim, "trimmed": trim, "rate_hz": meta["rate_hz"],
                    "t0_local_us": meta["t0_local_us"], "gaps": meta.get("gaps", [])},
        "full_scale_db": fs,
        "values": {n: v for n, v in values.items() if n.startswith(REPLAY_NAMES_PREFIXES) or n == FULL_SCALE_NAME},
        "clock_drift_ppm": clk.drift_ppm,
        "SHOT": result_shot,
        "DRONE": result_drone,
        "notes": notes,
        "verdict": verdict,
    }
    with open(os.path.join(run_dir, CHECK_FILE), "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1)
    return result


def summary_lines(result):
    shot = result["SHOT"]
    lines = [f"check {result['run_dir']}  node {result['port']}  "
             f"capture {result['capture']['seconds']} s, full scale {result['full_scale_db']:g} dB"]
    d = shot["diff"]
    lines.append(f"  SHOT   replay {shot['replay']}  board {shot['board']}  matched {shot['matched']}  "
                 + (f"median {d['median_ms']:+.2f} ms  max {d['max_abs_ms']:.2f} ms" if d else "no pairs")
                 + (f"  shift {shot['shift_ms']:+.1f} ms" if shot["shift_ms"] is not None else ""))
    for state, r in result["DRONE"].items():
        d = r["diff"]
        lines.append(f"  DRONE {state:<5} replay {r['replay']}  board {r['board']}  matched {r['matched']}  "
                     + (f"median {d['median_ms']:+.1f} ms  max {d['max_abs_ms']:.1f} ms" if d else "no pairs")
                     + (f"  shift {r['shift_ms']:+.1f} ms" if r["shift_ms"] is not None else ""))
    for note in result["notes"]:
        lines.append(f"  note: {note}")
    lines.append(f"verdict: {result['verdict']}")
    return lines
