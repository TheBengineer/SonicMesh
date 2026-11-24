"""Scores SHOT and DRONE events against the clips of a scenario (the same code for replay and hardware).

Inputs: the scoring windows (scenario.windows), the events with times on one clock, the time span of the
run, a match tolerance and a latency offset (seconds, subtracted from every event time before matching).

Per gunshot clip with labels: a label is hit if a SHOT lies within tol of it (greedy, nearest first),
otherwise a miss. A SHOT inside a labelled gunshot clip that matches no label is an extra. Unlabelled
gunshot clips report their SHOT count and cost nothing.
Per drone clip: detected if a DRONE START comes between the clip start and 2 s after its end; latency is
that START minus the clip start. If a detection that started before the clip is still on when it begins,
the clip cannot show whether it would be detected: it is "already_on", neither detected nor missed (leave
longer gaps between clips, or fix the tail that carried over); tail is how long the detection stays on after the clip ends (END time
minus clip end). A SHOT inside a drone clip is an extra.
A SHOT within 20 ms of a clip edge counts as inside that clip (onsets are stamped on a 1 ms grid).
Quiet time (everything outside gunshot and drone clips, including the gaps) reports SHOTs as quiet shots
and DRONE-on time that no drone clip explains as false drone seconds.

Cost (lower is better), weights in COST:
  5 per missed label
  2 per extra SHOT (unmatched SHOT inside a labelled gunshot or drone clip)
  5 per quiet SHOT (SHOT in quiet time)
  0.2 per second of drone tail after a drone clip
  10 per drone clip not detected
  0.5 per second of mean drone latency over the detected clips
  0.2 per second of DRONE-on outside drone clips that no drone clip explains
"""

import statistics
from dataclasses import dataclass, field

COST = {"miss": 5.0, "extra_shot": 2.0, "quiet_shot": 5.0, "drone_tail_s": 0.2,
        "drone_missed": 10.0, "drone_latency_s": 0.5, "drone_false_on_s": 0.2}
DRONE_GRACE_S = 2.0
# Onsets are found on a 1 ms window grid, so a transient at a clip's first sample can be stamped up to
# a window early. A SHOT within this margin of a clip edge belongs to that clip.
EDGE_PAD_S = 0.02


def _in_window(w, t):
    return w.start - EDGE_PAD_S <= t <= w.end + EDGE_PAD_S


@dataclass
class Interval:
    start: float
    end: float = None
    f0: list = field(default_factory=list)


def drone_intervals(events):
    """DRONE on intervals from START, UPDATE and END events in time order. end None means still on."""
    ivs, cur = [], None
    for e in sorted((e for e in events if e["type"] == "DRONE"), key=lambda e: e["t"]):
        state, t = e["state"], e["t"]
        if state == "start":
            if cur is not None:
                cur.end = t
            cur = Interval(t, None, [e["f0_hz"]])
            ivs.append(cur)
        elif state == "update":
            if cur is None:
                cur = Interval(t, None, [])
                ivs.append(cur)
            cur.f0.append(e["f0_hz"])
        elif state == "end":
            if cur is not None:
                cur.end = t
                cur = None
    return ivs


def estimate_offset(windows, shot_times, search_s=0.3):
    """Median of (SHOT - label) for each label's nearest SHOT within search_s. 0 if there is none."""
    diffs = []
    for w in windows:
        for label in (w.shots or []):
            near = min(shot_times, key=lambda s: abs(s - label), default=None)
            if near is not None and abs(near - label) <= search_s:
                diffs.append(near - label)
    return statistics.median(diffs) if diffs else 0.0


def _overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def _match(windows, shots, tol):
    """Greedy nearest matching of labels to shots. Returns (hit per label as a set of (window, label), used shots)."""
    pairs = []
    for wi, w in enumerate(windows):
        for li, label in enumerate(w.shots or []):
            for sj, s in enumerate(shots):
                d = abs(s - label)
                if d <= tol:
                    pairs.append((d, wi, li, sj))
    pairs.sort()
    used_labels, used_shots, hit = set(), set(), set()
    for _, wi, li, sj in pairs:
        if (wi, li) in used_labels or sj in used_shots:
            continue
        used_labels.add((wi, li))
        used_shots.add(sj)
        hit.add((wi, li))
    return hit, used_shots


def score_run(windows, events, span, tol=0.03, offset=0.0):
    t0, t1 = span
    corrected = [dict(e, t=e["t"] - offset) for e in events]
    shots = sorted(e["t"] for e in corrected if e["type"] == "SHOT")
    ivs = drone_intervals(corrected)
    hit, used = _match(windows, shots, tol)
    rows = []
    totals = {"labels": 0, "hits": 0, "misses": 0, "extra_shots": 0, "unlabelled_shots": 0,
              "quiet_shots": 0, "drone_clips": 0, "drone_detected": 0, "drone_tail_s": 0.0,
              "drone_latencies": [], "drone_f0": [], "drone_already_on": 0}
    clip_s = 0.0
    for wi, w in enumerate(windows):
        clip_s += w.end - w.start
        inside = [j for j, s in enumerate(shots) if _in_window(w, s)]
        row = {"kind": w.kind, "index": w.index, "start": round(w.start, 3), "end": round(w.end, 3),
               "shots_inside": len(inside)}
        if w.kind == "gunshot":
            labels = w.shots or []
            row["labels"] = len(labels)
            row["hits"] = sum(1 for li in range(len(labels)) if (wi, li) in hit)
            row["misses"] = len(labels) - row["hits"]
            totals["labels"] += len(labels)
            totals["hits"] += row["hits"]
            totals["misses"] += row["misses"]
            if w.shots is None:
                totals["unlabelled_shots"] += len(inside)
            row["extra"] = 0 if w.shots is None else sum(1 for j in inside if j not in used)
            totals["extra_shots"] += row["extra"]
        else:
            row.update(_drone_window(w, ivs, t1, totals))
            row["extra"] = sum(1 for j in inside if j not in used)
            totals["extra_shots"] += row["extra"]
        row["drone_on_s"] = round(sum(_overlap(w.start, w.end, iv.start, iv.end or t1) for iv in ivs), 3)
        rows.append(row)
    for j, s in enumerate(shots):
        if j not in used and not any(_in_window(w, s) for w in windows):
            totals["quiet_shots"] += 1
    explained = [iv for iv in ivs if any(w.kind == "drone" and w.start <= iv.start <= w.end + DRONE_GRACE_S
                                         for w in windows)]
    drone_ws = [w for w in windows if w.kind == "drone"]
    false_on = sum(_false_on(iv, drone_ws, t0, t1) for iv in ivs if iv not in explained)
    quiet_s = max(0.0, (t1 - t0) - clip_s)
    latencies = totals["drone_latencies"]
    mean_latency = statistics.mean(latencies) if latencies else 0.0
    missed = totals["drone_clips"] - totals["drone_detected"] - totals["drone_already_on"]
    cost = (totals["misses"] * COST["miss"] + totals["extra_shots"] * COST["extra_shot"]
            + totals["quiet_shots"] * COST["quiet_shot"] + totals["drone_tail_s"] * COST["drone_tail_s"]
            + missed * COST["drone_missed"] + mean_latency * COST["drone_latency_s"]
            + false_on * COST["drone_false_on_s"])
    return {
        "offset_s": round(offset, 4),
        "cost": round(cost, 3),
        "totals": {
            "labels": totals["labels"], "hits": totals["hits"], "misses": totals["misses"],
            "extra_shots": totals["extra_shots"], "unlabelled_shots": totals["unlabelled_shots"],
            "quiet_shots": totals["quiet_shots"],
            "quiet_min": round(quiet_s / 60, 3),
            "quiet_shots_per_min": round(totals["quiet_shots"] / (quiet_s / 60), 3) if quiet_s > 0 else 0.0,
            "drone_clips": totals["drone_clips"], "drone_detected": totals["drone_detected"],
            "drone_already_on": totals["drone_already_on"],
            "drone_mean_latency_s": round(mean_latency, 3) if latencies else None,
            "drone_mean_tail_s": round(totals["drone_tail_s"] / totals["drone_clips"], 3)
            if totals["drone_clips"] else None,
            "drone_false_on_s": round(false_on, 3),
            "drone_f0_hz": round(statistics.median(totals["drone_f0"]), 1) if totals["drone_f0"] else None,
        },
        "windows": rows,
    }


def _false_on(iv, drone_ws, t0, t1):
    """On time of a detection no clip explains, minus time inside drone clips and the tail after a clip
    it ran through (the tail is costed per clip)."""
    end = iv.end or t1
    covered = 0.0
    for w in drone_ws:
        if iv.start <= w.end and end > w.start:
            covered += _overlap(iv.start, end, w.start, end)
            break
    return max(0.0, _overlap(iv.start, end, t0, t1) - covered)


def _drone_window(w, ivs, t1, totals):
    totals["drone_clips"] += 1
    starts = [iv.start for iv in ivs if w.start <= iv.start <= w.end + DRONE_GRACE_S]
    row = {"detected": bool(starts), "latency_s": None, "tail_s": 0.0, "tail_open": False, "f0_hz": None}
    if starts:
        totals["drone_detected"] += 1
        latency = min(starts) - w.start
        row["latency_s"] = round(latency, 3)
        totals["drone_latencies"].append(latency)
    elif any(iv.start < w.start and (iv.end is None or iv.end > w.start) for iv in ivs):
        row["detected"] = None
        row["already_on"] = True
        totals["drone_already_on"] += 1
    tails = []
    for iv in ivs:
        if iv.start <= w.end and (iv.end is None or iv.end > w.end):
            tails.append(None if iv.end is None else iv.end - w.end)
    if tails:
        if None in tails:
            row["tail_open"] = True
            tail = max(0.0, t1 - w.end)
        else:
            tail = max(tails)
        row["tail_s"] = round(tail, 3)
        totals["drone_tail_s"] += tail
    f0 = [f for iv in ivs if w.start <= iv.start <= w.end + DRONE_GRACE_S + row["tail_s"] for f in iv.f0]
    if f0:
        row["f0_hz"] = round(statistics.median(f0), 1)
        totals["drone_f0"].extend(f0)
    return row
