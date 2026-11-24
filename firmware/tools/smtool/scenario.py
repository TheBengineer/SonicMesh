"""Scenario files: what gets played, in what order, with the labels for scoring.

A scenario is a JSON file:

  {
    "name": "bench_mixed",            required; used in run directory names
    "gap_s": 4,                       silence before the first item, between items and after the last
    "clips": [
      {"kind": "gunshot", "path": "data/gunshots/.../cz.wav", "shots": [0.52, 1.83], "gain_db": 0},
      {"kind": "drone",   "path": "data/dronenoise/....wav"},
      {"kind": "quiet",   "silence_s": 60}
    ]
  }

kind is gunshot, drone or quiet. Paths are relative to the repository root. "shots" are times in
seconds from the start of the clip; leave it out to count SHOTs inside the clip without labels.
gain_db defaults to 0. A quiet item has no file: it is silence_s seconds of nothing (in replay, the
quiet noise level; on hardware, whatever the room makes).

The timeline is the list of items with the gaps between them. Replay and hardware runs both follow it,
so the scoring windows are the same in both.
"""

import json
import os
from dataclasses import dataclass

from . import REPO_ROOT, audio

KINDS = ("gunshot", "drone", "quiet")
CLIP_KINDS = ("gunshot", "drone")
RATE = audio.RATE


class ScenarioError(ValueError):
    pass


@dataclass
class Clip:
    kind: str
    path: str = None
    shots: list = None
    gain_db: float = 0.0
    silence_s: float = 0.0


@dataclass
class Scenario:
    name: str
    gap_s: float
    clips: list
    source: str = ""


@dataclass
class Segment:
    """One item on the timeline, in samples at 16 kHz. kind "gap" is quiet time between items."""

    kind: str
    start: int
    n_samples: int
    index: int
    path: str = None
    shots: list = None
    gain_db: float = 0.0

    @property
    def start_s(self):
        return self.start / RATE

    @property
    def end_s(self):
        return (self.start + self.n_samples) / RATE


@dataclass
class Window:
    """A clip's place on the timeline, for scoring. shots are absolute times, or None if unlabelled."""

    kind: str
    index: int
    start: float
    end: float
    shots: list = None


def resolve_path(path):
    return path if os.path.isabs(path) else os.path.join(REPO_ROOT, path)


def load_scenario(path):
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    return parse_scenario(raw, source=path)


def parse_scenario(raw, source=""):
    if not isinstance(raw, dict):
        raise ScenarioError("a scenario is a JSON object")
    name = raw.get("name")
    if not isinstance(name, str) or not name:
        raise ScenarioError("scenario needs a non-empty name")
    gap_s = float(raw.get("gap_s", 4.0))
    if gap_s < 0:
        raise ScenarioError("gap_s must not be negative")
    clips = raw.get("clips")
    if not isinstance(clips, list) or not clips:
        raise ScenarioError("scenario needs a non-empty clips list")
    parsed = [_parse_clip(i, c) for i, c in enumerate(clips)]
    return Scenario(name=name, gap_s=gap_s, clips=parsed, source=source)


def _parse_clip(i, c):
    where = f"clip {i}"
    if not isinstance(c, dict):
        raise ScenarioError(f"{where} must be an object")
    kind = c.get("kind")
    if kind not in KINDS:
        raise ScenarioError(f"{where}: kind must be one of {', '.join(KINDS)}")
    gain_db = float(c.get("gain_db", 0.0))
    if kind == "quiet":
        silence = float(c.get("silence_s", 0))
        if silence <= 0:
            raise ScenarioError(f"{where}: a quiet item needs silence_s > 0")
        return Clip(kind=kind, silence_s=silence)
    path = c.get("path")
    if not isinstance(path, str):
        raise ScenarioError(f"{where}: {kind} needs a path")
    if not os.path.isfile(resolve_path(path)):
        raise ScenarioError(f"{where}: no file {path}")
    shots = c.get("shots")
    if shots is not None:
        if not isinstance(shots, list) or not all(isinstance(s, (int, float)) for s in shots):
            raise ScenarioError(f"{where}: shots must be a list of times in seconds")
        shots = sorted(float(s) for s in shots)
    return Clip(kind=kind, path=path, shots=shots, gain_db=gain_db)


def plan(scenario, lengths=None):
    """Timeline segments. lengths(path) -> samples at 16 kHz; defaults to the file headers."""
    lengths = lengths or (lambda p: audio.clip_samples(resolve_path(p)))
    gap = int(round(scenario.gap_s * RATE))
    segments, cursor = [], 0

    def add(kind, n, index, **extra):
        nonlocal cursor
        segments.append(Segment(kind=kind, start=cursor, n_samples=n, index=index, **extra))
        cursor += n

    add("gap", gap, -1)
    for i, clip in enumerate(scenario.clips):
        if clip.kind == "quiet":
            add("quiet", int(round(clip.silence_s * RATE)), i)
        else:
            add(clip.kind, lengths(clip.path), i, path=resolve_path(clip.path),
                shots=clip.shots, gain_db=clip.gain_db)
        add("gap", gap, -1)
    return segments


def windows(segments):
    """Scoring windows: gunshot and drone clips, with absolute shot times."""
    out = []
    for seg in segments:
        if seg.kind in CLIP_KINDS:
            shots = None if seg.shots is None else [seg.start_s + s for s in seg.shots]
            out.append(Window(seg.kind, seg.index, seg.start_s, seg.end_s, shots))
    return out


def timeline_end(segments):
    return segments[-1].end_s if segments else 0.0
