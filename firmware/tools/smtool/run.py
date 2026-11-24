"""Hardware runs: play a scenario through the speakers and record every board.

A run directory data/bench/<UTC timestamp>-<scenario name>/ holds:
  lines.jsonl   every line from every port: {"port", "w" (host receive time), "raw" (the line as sent)}
  play.jsonl    one line per timeline item: index, kind, path, shots, start, end (host seconds)
  events.jsonl  decoded SHOT and DRONE events with host time. "source" is "node" (from a node's rec
                trace, clocked with its own time) or "gateway" (from the gateway's rec line, host receive time)
  params.json   every parameter of every board before the run, plus the values the run set
  summary.json  the scores, one per source, and the clock drift of each node
  capture.wav   with --capture: the first node's audio for the whole run (+ capture.wav.json); pcm lines
                go here and are not in lines.jsonl
A run stops after max_s (default: scenario length + 120 s): traces are turned off, paplay is killed,
and RunAborted is raised.
"""

import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone

from . import audio, capture, scenario as scen, score, clock
from .device import Board, DeviceError, record_line

import smlog

DEFAULT_TAIL_S = 120.0
CAPTURE_TAIL_S = 5.0  # a --capture run records the timeline plus this much
CAPTURE_START_WAIT_S = 10.0
MERGE_SHOT_S = 0.05  # one gunshot heard by several nodes is one SHOT
SHOT_TYPE, DRONE_TYPE = 0x11, 0x10


class RunAborted(RuntimeError):
    """The run passed its max duration, or was interrupted."""


class Watchdog:
    """Stops a run: sleeps and paplay are interrupted, and the run must check it between steps."""

    def __init__(self, seconds):
        self.seconds = seconds
        self.expired = threading.Event()
        self.proc = None
        self._timer = threading.Timer(seconds, self._fire)
        self._timer.daemon = True

    def start(self):
        self._timer.start()

    def stop(self):
        self._timer.cancel()

    def _fire(self):
        self.expired.set()
        proc = self.proc
        if proc is not None and proc.poll() is None:
            proc.kill()

    def check(self):
        if self.expired.is_set():
            raise RunAborted(f"run passed its {self.seconds:.0f} s limit")

    def sleep(self, seconds):
        self.expired.wait(seconds)
        self.check()

    def play(self, path, gain_db):
        """paplay, killable by the watchdog. Returns (host time before start, host time after end)."""
        cmd = ["paplay", f"--volume={audio.play_volume(gain_db)}", path]
        t0 = time.time()
        proc = subprocess.Popen(cmd)
        self.proc = proc
        try:
            while proc.poll() is None:
                self.check()
                time.sleep(0.05)
        finally:
            self.proc = None
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        self.check()
        if proc.returncode:
            raise RunAborted(f"paplay failed on {path} (exit {proc.returncode})")
        return t0, time.time()


class _CaptureJob:
    """A capture on one board in its own thread, so the timeline can play while it records."""

    def __init__(self, board, seconds):
        self.board = board
        self.seconds = seconds
        self.started = threading.Event()
        self.result = None
        self.error = None
        self.thread = threading.Thread(target=self._run, name=f"capture {board.port}", daemon=True)

    def _run(self):
        try:
            self.result = capture.record(self.board, self.seconds, on_started=self.started.set)
        except BaseException as exc:  # reported by start() or finish()
            self.error = exc
        finally:
            self.started.set()

    def start(self):
        self.thread.start()
        if not self.started.wait(CAPTURE_START_WAIT_S) and self.error is None:
            raise DeviceError(f"{self.board.port}: capture did not start")
        if self.error is not None:
            raise self.error

    def finish(self):
        self.thread.join(self.seconds + capture.DEFAULT_GRACE_S + 5.0)
        if self.thread.is_alive():
            raise DeviceError(f"{self.board.port}: capture still running after the run")
        if self.error is not None:
            raise self.error
        return self.result

    def abort(self):
        """Stops the board's capture (best effort) and waits for the thread to end."""
        try:
            self.board.command("sm capture stop")
        except DeviceError:
            pass
        self.thread.join(CAPTURE_START_WAIT_S)


class Recorder:
    """Writes every line of every board to lines.jsonl and keeps the parsed objects for analysis."""

    def __init__(self, path):
        self._fh = open(path, "w", encoding="utf-8")
        self._lock = threading.Lock()
        self.objects = {}  # port -> [(wall, obj)]

    def __call__(self, board, wall, raw, obj):
        if obj is not None and obj.get("k") == "pcm":
            return  # audio goes to capture.wav, not here
        with self._lock:
            self._fh.write(json.dumps({"port": board.port, "w": round(wall, 3), "raw": raw}) + "\n")
            if obj is not None:
                self.objects.setdefault(board.port, []).append((wall, obj))

    def close(self):
        self._fh.close()


def _shell_values(values, board):
    """Only the names the board knows: a tuning file may hold replay-only names."""
    known = {p["n"] for p in board.params()}
    return {n: v for n, v in values.items() if n in known}


def run_scenario(scenario, nodes, gateway, values, traces, out_root, max_s=None, serial_factory=None,
                 tail_s=DEFAULT_TAIL_S, tolerance=0.03, capture_audio=False):
    """Runs one scenario on hardware. Returns the summary dict (its run_dir key names the directory).

    The run stops after max_s seconds (default: timeline length + tail_s). On any failure the traces
    are turned off and the boards closed before the exception goes up. capture_audio: the first node
    records its audio for the whole run into capture.wav.
    """
    segments = scen.plan(scenario)
    limit = max_s if max_s is not None else scen.timeline_end(segments) + tail_s
    cap_seconds = scen.timeline_end(segments) + CAPTURE_TAIL_S
    if capture_audio and cap_seconds > capture.MAX_SECONDS:
        raise ValueError(f"a capture run is at most {capture.MAX_SECONDS - CAPTURE_TAIL_S:g} s of timeline")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = os.path.join(out_root, f"{stamp}-{scenario.name}")
    os.makedirs(run_dir, exist_ok=True)
    wd = Watchdog(limit)
    boards, node_boards = [], []
    recorder = Recorder(os.path.join(run_dir, "lines.jsonl"))
    cap_job = None
    try:
        boards = [Board(p, serial_factory).open() for p in nodes + ([gateway] if gateway else [])]
        node_boards = boards[:len(nodes)]
        for b in boards:
            b.info()
        params_before, before = {}, {}
        for b in boards:
            params_before[b.port] = {"role": b.role, "node": b.node_id, "params": b.params()}
        for b in node_boards:
            names = _shell_values(values, b)
            before[b.port] = b.get(list(names))
            b.set(names)
            b.trace_set(dict(traces, rec=1))
        for b in boards:
            b.add_listener(recorder)
        if capture_audio:
            cap_job = _CaptureJob(node_boards[0], cap_seconds)
            cap_job.start()
        start = time.time()
        wd.start()
        play_rows = _play_timeline(segments, wd, run_dir)
        stop = time.time()
        for b in node_boards:
            b.trace_off()
        audio_cap = cap_job.finish() if cap_job is not None else None
    except BaseException:
        wd.stop()
        if cap_job is not None:
            cap_job.abort()
        _traces_off(node_boards)
        recorder.close()
        _close_all(boards)
        raise
    wd.stop()
    recorder.close()
    _close_all(boards)
    if audio_cap is not None:
        port = node_boards[0].port
        snapshot = {p["n"]: p["v"] for p in params_before[port]["params"]}
        snapshot.update({n: v for n, v in values.items() if n in snapshot})
        capture.save_wav(audio_cap, os.path.join(run_dir, "capture.wav"), params=snapshot,
                         extra={"scenario": scenario.name, "run_dir": run_dir})
    with open(os.path.join(run_dir, "params.json"), "w", encoding="utf-8") as fh:
        json.dump({"ports": params_before, "set": values, "before": before}, fh, indent=1)
    summary = analyse(run_dir, scenario, nodes, gateway, recorder, play_rows, (start, stop), tolerance)
    summary["run_dir"] = run_dir
    summary["before"] = before
    if audio_cap is not None:
        summary["capture"] = "capture.wav"
    with open(os.path.join(run_dir, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=1)
    return summary


def _play_timeline(segments, wd, run_dir):
    rows = []
    with open(os.path.join(run_dir, "play.jsonl"), "w", encoding="utf-8") as fh:
        for seg in segments:
            if seg.kind == "gap":
                wd.sleep(seg.n_samples / audio.RATE)
                continue
            if seg.kind == "quiet":
                t0 = time.time()
                wd.sleep(seg.n_samples / audio.RATE)
                t1 = time.time()
            else:
                t0, t1 = wd.play(seg.path, seg.gain_db)
            row = {"index": seg.index, "kind": seg.kind, "path": seg.path, "shots": seg.shots,
                   "gain_db": seg.gain_db, "start": t0, "end": t1}
            rows.append(row)
            fh.write(json.dumps(row) + "\n")
            fh.flush()
    return rows


def _traces_off(boards):
    for b in boards:
        try:
            b.trace_off()
        except DeviceError:
            pass


def _close_all(boards):
    for b in boards:
        b.close()


WRAP = 1 << 32


def _unwrap(ref_us, t_us32):
    """64-bit time near ref_us whose low 32 bits are t_us32 (record times wrap every 71.6 min)."""
    d = (ref_us - t_us32) % WRAP
    if d >= WRAP // 2:
        d -= WRAP
    return ref_us - d


def _record_local_us(obj, fields):
    """A timed record's time on the node's own clock, from a node rec trace line.

    The record carries network time when tflags bit 0 is set, else the node's clock, both 32-bit. The
    trace line has the node's clock "t" and its network time "nt" at one instant, which maps one to
    the other. None if the record is network time and the line has no mapping.
    """
    local_now = obj["t"]
    if fields["tflags"] & smlog.TFLAG_NET:
        nt = obj.get("nt", -1)
        if nt is None or nt < 0:
            return None
        return local_now + (_unwrap(nt, fields["t_us"]) - nt)
    return _unwrap(local_now, fields["t_us"])


def _node_events(recorder, port, clk):
    out, dedup = [], smlog.Dedup()
    for wall, obj in recorder.objects.get(port, []):
        rec = record_line(obj)
        if rec is None or rec.rtype not in (SHOT_TYPE, DRONE_TYPE):
            continue
        if not dedup.is_new(rec.node, rec.rid):
            continue
        name, fields, _ = smlog.decode_record(rec.rtype, rec.payload, None)
        local = _record_local_us(obj, fields)
        t = clk.to_host(local, wall) if local is not None else wall
        out.append(_event(name, fields, rec, port, t=t, local=local))
    return out


def _gateway_clock(recorder, port):
    """Host time of the gateway's clock, fitted to the "g" field of its lines, or None."""
    samples = [(w, obj["g"]) for w, obj in recorder.objects.get(port, []) if isinstance(obj.get("g"), int)]
    return clock.fit_clock(samples) if samples else None


def _gateway_events(recorder, port):
    """Records as the gateway heard them. A record in network time (the gateway's clock) is placed
    with the gateway clock fit; one a node sent before it synced has only its arrival time."""
    out, dedup = [], smlog.Dedup()
    gclk = _gateway_clock(recorder, port)
    for wall, obj in recorder.objects.get(port, []):
        rec = record_line(obj)
        if rec is None or rec.rtype not in (SHOT_TYPE, DRONE_TYPE):
            continue
        if not dedup.is_new(rec.node, rec.rid):
            continue
        name, fields, _ = smlog.decode_record(rec.rtype, rec.payload, rec.gateway_us)
        t = wall
        if gclk is not None and fields["tflags"] & smlog.TFLAG_NET and rec.gateway_us is not None:
            t = gclk.to_host(_unwrap(rec.gateway_us, fields["t_us"]), wall)
        out.append(_event(name, fields, rec, port, t=t, local=None))
    return out


def _event(name, fields, rec, port, t, local):
    e = dict(fields, type=name, t=t, port=port, node=rec.node, id=rec.rid, source=rec.source)
    if local is not None:
        e["t_local_us"] = local
    e.pop("hex", None)
    return e


def _merge_node_shots(events):
    """One gunshot heard by several nodes is one SHOT: keep the first of any SHOTs within MERGE_SHOT_S."""
    kept, last = [], None
    for e in sorted(events, key=lambda e: e["t"]):
        if e["type"] == "SHOT":
            if last is not None and e["t"] - last < MERGE_SHOT_S:
                continue
            last = e["t"]
        kept.append(e)
    return kept


def analyse(run_dir, scenario, nodes, gateway, recorder, play_rows, span, tolerance):
    windows = []
    for r in play_rows:
        if r["kind"] in scen.CLIP_KINDS:
            shots = None if r["shots"] is None else [r["start"] + s for s in r["shots"]]
            windows.append(scen.Window(r["kind"], r["index"], r["start"], r["end"], shots))
    clocks = {}
    node_events = []
    drift = {}
    for port in nodes:
        samples = [(w, obj["t"]) for w, obj in recorder.objects.get(port, [])
                   if obj.get("k") == "tr" and isinstance(obj.get("t"), int)]
        if not samples:
            raise DeviceError(f"{port}: no timed trace lines; was the rec trace on?")
        clocks[port] = clock.fit_clock(samples)
        drift[port] = clocks[port].drift_ppm
        node_events.extend(_node_events(recorder, port, clocks[port]))
    node_events = _merge_node_shots(node_events)
    gw_events = _gateway_events(recorder, gateway) if gateway else None
    sources = {"node": node_events}
    if gw_events is not None:
        sources["gateway"] = gw_events
    scores = {}
    for name, events in sources.items():
        shot_times = [e["t"] for e in events if e["type"] == "SHOT"]
        offset = score.estimate_offset(windows, shot_times)
        scores[name] = score.score_run(windows, events, span, tolerance, offset)
    with open(os.path.join(run_dir, "events.jsonl"), "w", encoding="utf-8") as fh:
        for name, events in sources.items():
            for e in sorted(events, key=lambda e: e["t"]):
                fh.write(json.dumps(e) + "\n")
    return {"name": scenario.name, "nodes": nodes, "gateway": gateway, "drift_ppm": drift,
            "span": [round(span[0], 3), round(span[1], 3)], "scores": scores}
