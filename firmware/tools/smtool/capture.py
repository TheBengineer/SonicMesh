"""Audio capture from a board: `sm capture` streams the audio the detectors receive (firmware/lib/capture.c).

The board answers {"k":"ok","c":"capture","blocks":B,"n":512,"rate":16000} at once, then sends B lines
{"k":"pcm","s":<first sample>,"t":<board local us of that sample>,"n":512,"d":"<base64 int16 LE>"} and
finally {"k":"capture","blocks":<sent>,"gaps":<blocks dropped on the board>,"rate_hz":<measured>}.
A block the shell dropped leaves a jump in s, which is a gap. Trust s, not counts.

record() runs one capture and returns the audio with gaps zero-filled and listed. save_wav() writes it as a
16-bit mono WAV at the nominal rate, with a JSON sidecar (path + ".json"); load_wav() reads both back.
"""

import base64
import json
import os
import threading
import time
import wave

import numpy as np

from .device import DeviceError

MAX_SECONDS = 600
BLOCK = 512
NOMINAL_RATE = 16000
DEFAULT_GRACE_S = 15.0  # on top of the capture length, before the capture is stopped
STOP_WAIT_MAX_S = 5.0  # how long to wait for the final line after a stop
OK_WAIT_S = 5.0


class CaptureError(DeviceError):
    """The board refused the capture, or it timed out (after sm capture stop), or it had no audio."""


class Capture:
    """One capture. samples is np.int16; gaps is a list of (index into samples, length in samples)."""

    def __init__(self):
        self.samples = np.zeros(0, np.int16)
        self.first_sample = None  # board sample index of samples[0]
        self.t0_local_us = None  # board local time of samples[0]
        self.rate_hz = float(NOMINAL_RATE)  # the board's measured rate
        self.gaps = []
        self.blocks_expected = 0
        self.blocks_received = 0
        self.board_gaps = 0  # blocks the board itself did not queue
        self.host_times = []  # (host wall time the pcm line arrived, board local us), arrival order
        self.port = None
        self.node_id = None
        self.start_wall = None  # host time of the ok line (on_started is called then)
        self.end_wall = None


def assemble(blocks):
    """blocks: (first sample s, local us t, int16 array) in arrival order. A repeated s is kept once; a block
    that overlaps the one before it is skipped; a jump in s is a gap, filled with zeros.

    Returns (samples, first_sample, t0_local_us, gaps) with gaps as (index, length) pairs.
    """
    seen = {}
    for s, t, pcm in blocks:
        seen.setdefault(s, (t, pcm))
    if not seen:
        return np.zeros(0, np.int16), None, None, []
    order = sorted(seen)
    first = order[0]
    parts, gaps, length, prev_end = [], [], 0, None
    for s in order:
        t, pcm = seen[s]
        if prev_end is not None:
            if s < prev_end:
                continue
            if s > prev_end:
                gap = s - prev_end
                gaps.append((length, gap))
                parts.append(np.zeros(gap, np.int16))
                length += gap
        parts.append(np.asarray(pcm, np.int16))
        length += len(pcm)
        prev_end = s + len(pcm)
    samples = np.concatenate(parts) if parts else np.zeros(0, np.int16)
    return samples, first, seen[first][0], gaps


class _Collector:
    """Board listener: the ok line, the pcm lines and the final line of one capture."""

    def __init__(self):
        self.lock = threading.Lock()
        self.ok = None
        self.ok_seen = threading.Event()
        self.final = None
        self.done = threading.Event()
        self.pcm = []  # (wall, obj)

    def __call__(self, board, wall, raw, obj):
        if obj is None:
            return
        kind = obj.get("k")
        if kind == "pcm":
            with self.lock:
                self.pcm.append((wall, obj))
        elif kind == "ok" and obj.get("c") == "capture" and "blocks" in obj:
            self.ok = obj
            self.ok_seen.set()
        elif kind == "capture":
            self.final = obj
            self.done.set()


def _stop_quietly(board, col):
    """sm capture stop, then wait a little for the final line. Errors are not raised: this runs on failure."""
    if col.done.is_set():
        return
    try:
        board.command("sm capture stop")
    except DeviceError:
        return
    col.done.wait(STOP_WAIT_MAX_S)


def record(board, seconds, on_started=None, grace_s=DEFAULT_GRACE_S):
    """Records `seconds` of the board's audio and returns a Capture.

    on_started() is called right after the ok line, when the blocks start to come (a caller can start
    playback then). If the stream does not finish within grace_s after the capture length, or the call is
    interrupted, `sm capture stop` is sent and CaptureError is raised (KeyboardInterrupt is re-raised).
    """
    seconds = float(seconds)
    if not 0 < seconds <= MAX_SECONDS:
        raise ValueError(f"capture length must be more than 0 and at most {MAX_SECONDS} s")
    col = _Collector()
    board.add_listener(col)
    started = False
    try:
        reply = board.command(f"sm capture {seconds:g}")
        if not reply.ok:
            raise CaptureError(f"{board.port}: sm capture refused: {reply.error.get('m')}")
        if not col.ok_seen.wait(OK_WAIT_S):
            raise CaptureError(f"{board.port}: no ok line for sm capture")
        started = True
        cap = Capture()
        cap.start_wall = time.time()
        if on_started is not None:
            on_started()
        finished = col.done.wait(seconds + grace_s)
    except BaseException:
        if started:
            _stop_quietly(board, col)
        board.remove_listener(col)
        raise
    if not finished:
        _stop_quietly(board, col)
        board.remove_listener(col)
        raise CaptureError(f"{board.port}: capture of {seconds:g} s did not finish within {grace_s:g} s; "
                           "sent sm capture stop")
    board.remove_listener(col)
    return _build(board, col, cap)


def _build(board, col, cap):
    cap.end_wall = time.time()
    cap.port = board.port
    cap.node_id = board.node_id
    blocks = []
    with col.lock:
        pcm_lines = list(col.pcm)
    for wall, obj in pcm_lines:
        pcm = np.frombuffer(base64.b64decode(obj["d"]), dtype="<i2")
        blocks.append((int(obj["s"]), int(obj["t"]), pcm))
        cap.host_times.append((wall, int(obj["t"])))
    if not blocks:
        raise CaptureError(f"{board.port}: the capture had no audio blocks")
    cap.samples, cap.first_sample, cap.t0_local_us, cap.gaps = assemble(blocks)
    final = col.final or {}
    ok = col.ok or {}
    cap.blocks_expected = int(ok.get("blocks", 0))
    cap.blocks_received = len(blocks)
    cap.board_gaps = int(final.get("gaps", 0))
    measured = float(final.get("rate_hz") or 0.0)
    cap.rate_hz = measured if measured > 0 else float(ok.get("rate", NOMINAL_RATE))
    return cap


def save_wav(cap, path, params=None, extra=None):
    """Writes cap as 16-bit mono WAV at the nominal rate, and path + ".json" with its metadata.

    params: a dict of board parameters to keep with the audio. extra: more keys for the sidecar.
    """
    if cap.samples.size == 0:
        raise ValueError("no samples to save")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(NOMINAL_RATE)
        w.writeframes(np.asarray(cap.samples, dtype="<i2").tobytes())
    meta = {
        "port": cap.port,
        "node": None if cap.node_id is None else f"{cap.node_id:04x}",
        "wav_rate_hz": NOMINAL_RATE,
        "samples": int(cap.samples.size),
        "first_sample": cap.first_sample,
        "t0_local_us": cap.t0_local_us,
        "rate_hz": cap.rate_hz,
        "gaps": [[int(i), int(n)] for i, n in cap.gaps],
        "blocks_expected": cap.blocks_expected,
        "blocks_received": cap.blocks_received,
        "board_gaps": cap.board_gaps,
        "start_host": cap.start_wall,
        "params": params,
    }
    meta.update(extra or {})
    with open(path + ".json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1)
    return meta


def load_wav(path):
    """(int16 samples, sidecar metadata dict) of a file written by save_wav."""
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"{path}: expected 16-bit mono")
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").copy()
    with open(path + ".json", encoding="utf-8") as fh:
        meta = json.load(fh)
    return samples, meta
