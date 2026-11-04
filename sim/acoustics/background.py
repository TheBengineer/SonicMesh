"""Background beds from ESC-50 outdoor clips (CC BY-NC 3.0, local use only, see data/backgrounds/esc50).

Clips are resampled to 16 kS/s, each set to the same band level (100 Hz to 4 kHz), and joined with short
equal-power crossfades in a seeded random order. A joined bed is not a continuous scene: every 5 s clip
boundary is a change of source. Read the report's caveats before using the numbers.
"""

import csv
import math
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

from .model import FS, REF_PA

ROOT = Path(__file__).resolve().parents[2]
ESC_DIR = ROOT / "data" / "backgrounds" / "esc50"
ESC_SR = 44_100
FADE_S = 0.05


def manifest(folds=None, outdoor_only=True, exclude=()):
    """Rows of data/backgrounds/esc50/manifest.csv as dicts, filtered by fold number and category."""
    rows = []
    with open(ESC_DIR / "manifest.csv", newline="") as f:
        for r in csv.DictReader(f):
            if outdoor_only and r["outdoor"] != "1":
                continue
            if folds is not None and int(r["fold"]) not in folds:
                continue
            if r["category"] in exclude:
                continue
            rows.append(r)
    return rows


def load_clip(rel_path):
    """One clip as float64 in full scale units at FS, from a manifest path."""
    sr, raw = wavfile.read(ESC_DIR / rel_path)
    x = raw.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)
    if raw.dtype.kind == "i":
        x = x / float(np.iinfo(raw.dtype).max + 1)
    return signal.resample_poly(x, FS, sr)


_BAND = signal.butter(4, (100.0, 4000.0), btype="band", fs=FS, output="sos")


def band_rms(x):
    return float(np.sqrt(np.mean(signal.sosfilt(_BAND, x) ** 2)))


def bed(seed, rows, length_s, level_db_spl, fade_s=FADE_S):
    """Joined bed of length_s seconds at FS.

    Returns (samples, labels) where labels is a list of (start_sample, category) for each clip.
    Clips are drawn in a seeded random order and reused if the pool runs out.
    """
    rng = np.random.default_rng(seed)
    n_total = int(round(length_s * FS))
    out = np.zeros(n_total + 6 * FS)  # room for the last clip
    target = REF_PA * 10 ** (level_db_spl / 20)
    labels = []
    fade = int(round(fade_s * FS))
    win_in = np.sin(np.linspace(0, math.pi / 2, fade)) ** 2
    win_out = 1 - win_in
    pos = 0
    order = rng.permutation(len(rows))
    k = 0
    while pos < n_total:
        r = rows[order[k % len(rows)]]
        k += 1
        x = load_clip(r["file"])
        rms = band_rms(x)
        if rms == 0:
            continue
        x = x * (target / rms)
        w = np.ones(len(x))
        w[:fade] = win_in
        w[-fade:] = win_out
        out[pos : pos + len(x)] += x * w
        labels.append((pos, r["category"]))
        pos += len(x) - fade
    return out[:n_total], labels


def category_at(labels, sample):
    """Category of the clip playing at a sample index (labels as returned by bed())."""
    starts = np.array([s for s, _ in labels])
    i = np.searchsorted(starts, sample, side="right") - 1
    return labels[max(i, 0)][1]


# Rural scene: sparse events per hour per class (ASSUMED, a judgement for a quiet farm or forest edge; not measured).
RURAL_RATE_PER_H = {
    "chirping_birds": 20.0, "insects": 10.0, "crickets": 6.0, "frog": 4.0, "crow": 3.0, "rooster": 2.0,
    "hen": 2.0, "dog": 4.0, "cat": 0.5, "cow": 1.0, "sheep": 1.0, "pig": 0.5,
    "car_horn": 2.0, "engine": 3.0, "train": 0.2, "airplane": 0.12, "helicopter": 0.04,
    "chainsaw": 0.1, "hand_saw": 0.1, "siren": 0.1, "church_bells": 0.1, "vacuum_cleaner": 0.05,
    "fireworks": 0.01, "thunderstorm": 0.02, "rain": 0.2, "sea_waves": 0.01, "water_drops": 0.1,
    "pouring_water": 0.05, "footsteps": 0.1, "crackling_fire": 0.05,
}
RURAL_AMBIENT_DB = 40.0  # ASSUMED site ambient, band level (pink), dB SPL
RURAL_WIND_MS = 2.0  # ASSUMED steady wind for the rural scene
EVENT_LEVEL_1M_DB = 80.0  # ASSUMED band level of an event clip at 1 m
EVENT_RANGE_M = (20.0, 300.0)  # ASSUMED distance of an event from the node, uniform
EVENT_FADE_S = 0.5


def _faded(x, fade_s=EVENT_FADE_S):
    n = int(round(fade_s * FS))
    ramp = np.sin(np.linspace(0, math.pi / 2, n)) ** 2
    w = np.ones(len(x))
    w[:n] = ramp
    w[-n:] = ramp[::-1]
    return x * w


def rural_scene(seed, hours, folds, ambient_db=RURAL_AMBIENT_DB, wind_ms=RURAL_WIND_MS):
    """Rural node scene: continuous pink ambient and wind, plus Poisson events of outdoor ESC-50 classes.

    Each event is an ESC clip at EVENT_LEVEL_1M_DB at 1 m, attenuated by 20 log10(range) with range uniform in
    EVENT_RANGE_M, faded in and out. Returns (samples, events) with events as (start_sample, category, level_db).
    Seeded; the wind and the ambient are separate draws from the same seed.
    """
    from .noise import pink, wind as wind_noise

    rng = np.random.default_rng(seed)
    n = int(round(hours * 3600 * FS))
    x = pink(rng, n, ambient_db) + wind_noise(rng, n, wind_ms)
    all_rows = manifest(folds=folds, exclude=("wind",))
    events = []
    for cat, per_h in RURAL_RATE_PER_H.items():
        rows = [r for r in all_rows if r["category"] == cat]
        if not rows:
            continue
        for _ in range(rng.poisson(per_h * hours)):
            r = rows[rng.integers(len(rows))]
            dist = rng.uniform(*EVENT_RANGE_M)
            level = EVENT_LEVEL_1M_DB - 20 * math.log10(dist)
            clip = load_clip(r["file"])
            rms = band_rms(clip)
            if rms == 0:
                continue
            clip = _faded(clip * (REF_PA * 10 ** (level / 20) / rms))
            start = int(rng.integers(0, max(1, n - len(clip))))
            x[start : start + len(clip)] += clip[: n - start]
            events.append((start, cat, level))
    events.sort()
    return x, events
