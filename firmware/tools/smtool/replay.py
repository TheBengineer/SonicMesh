"""Offline run of the node's detectors on audio, for tuning without hardware.

The detector cores are firmware/tests/host/smdet.c (built to build/libsmdet.so). The glue here copies
detectors/gunshot_impulse/gunshot.c and detectors/drone_comb/drone_comb.c, block by block:

  block = 512 samples (32 ms). Per block, the impulse test runs on its 32 windows of 16 samples (1 ms).
  gunshot: an onset window opens a shot at its start time, with peak and rise from that window. Each
    later window (not an onset) raises the peak; after hold_windows such windows the SHOT is emitted
    with the onset time. An onset while a shot is open replaces it (as the board does).
  drone: from the second block on, the comb steps once per block on the last 1024 samples (frame
    start = 512 * (block - 1)). A frame is skipped when its start is less than shot_mask_ms after the
    latest onset (and not more than 1024 samples before it). The onsets of a block are known before
    that block's frame, as the board runs the gunshot detector first. An event is START when on rises,
    UPDATE every update_ms while on and tracking, END when on falls. Event time is the frame's last sample.

Times are sample index / 16000, measured from the start of the input. Pressure is in pascals.
"""

import ctypes
import json
import math
import os
import re
from dataclasses import dataclass, field

import numpy as np

from . import BENCH_DIR, REPO_ROOT, audio, response, tuning
from .scenario import windows as scenario_windows, plan as scenario_plan

RATE = audio.RATE
BLOCK = 512
FRAME = 1024
WIN = 16
REF_PA2 = (20e-6) ** 2
COMB_OUT = 9  # on, tracking, f0, score, peak, nharm, band_db, floor_db, q
CHUNK = 16000  # samples per generated chunk for quiet noise
LIB_PATH = os.path.join(REPO_ROOT, "firmware", "tests", "host", "build", "libsmdet.so")

_lib = None


def load_library(path=LIB_PATH):
    """The ctypes binding, loaded once per process."""
    global _lib
    if _lib is not None:
        return _lib
    if not os.path.exists(path):
        raise FileNotFoundError(f"{path} is missing; build it with: make -C firmware/tests/host lib")
    lib = ctypes.CDLL(path)
    vp, cc, cd, cf = ctypes.c_void_p, ctypes.c_char_p, ctypes.c_double, ctypes.c_float
    pf, pd, pu8 = ctypes.POINTER(cf), ctypes.POINTER(cd), ctypes.POINTER(ctypes.c_ubyte)
    sigs = {
        "smd_comb_new": (vp, []), "smd_comb_set": (ctypes.c_int, [vp, cc, cd]),
        "smd_comb_reset": (ctypes.c_int, [vp]),
        "smd_comb_run": (ctypes.c_int, [vp, pf, ctypes.c_long, pd]),
        "smd_impulse_new": (vp, []), "smd_impulse_set": (ctypes.c_int, [vp, cc, cd]),
        "smd_impulse_reset": (None, [vp]), "smd_impulse_hold_windows": (ctypes.c_int, [vp]),
        "smd_impulse_run": (ctypes.c_long, [vp, pf, ctypes.c_long, pu8, pf, pf]),
        "smd_free": (None, [vp]),
    }
    for name, (res, args) in sigs.items():
        fn = getattr(lib, name)
        fn.restype = res
        fn.argtypes = args
    _lib = lib
    return lib


def _ptr(arr, ctype):
    return arr.ctypes.data_as(ctypes.POINTER(ctype))


def _set(fn, handle, name, value, kind):
    rc = fn(handle, name.encode(), float(value))
    if rc == -1:
        raise KeyError(f"no {kind} parameter named {name}")
    if rc == -2:
        raise ValueError(f"{kind} parameter {name}={value} is out of range")


def _log10(x):
    return 10.0 * math.log10(max(x, 1e-30))


class Detectors:
    """The gunshot onset test and the drone comb, stepped one block at a time."""

    def __init__(self, comb=None, impulse=None, update_ms=1000, shot_mask_ms=600, comb_enabled=True):
        self.lib = load_library()
        self.imp = self.lib.smd_impulse_new()
        for k, v in (impulse or {}).items():
            _set(self.lib.smd_impulse_set, self.imp, k, v, "gunshot")
        self.lib.smd_impulse_reset(self.imp)
        self.hold = self.lib.smd_impulse_hold_windows(self.imp)
        self.comb = None
        if comb_enabled:
            self.comb = self.lib.smd_comb_new()
            for k, v in (comb or {}).items():
                _set(self.lib.smd_comb_set, self.comb, k, v, "drone_comb")
            if self.lib.smd_comb_reset(self.comb) != 0:
                raise ValueError("comb parameters are not supported")
        self.update_us = int(update_ms * 1000)
        self.shot_mask = int(shot_mask_ms * RATE // 1000)
        self._onset = np.zeros(BLOCK // WIN, np.uint8)
        self._power = np.zeros(BLOCK // WIN, np.float32)
        self._floor = np.zeros(BLOCK // WIN, np.float32)
        self._out = np.zeros(COMB_OUT, np.float64)
        self._prev = None
        self._shot = None  # [windows left, onset sample, peak Pa^2, rise dB]
        self._last_onset = None
        self._was_on = False
        self._next_update_us = 0

    def close(self):
        if self.imp:
            self.lib.smd_free(self.imp)
            self.imp = None
        if self.comb:
            self.lib.smd_free(self.comb)
            self.comb = None

    def process_block(self, index, x, on_row=None):
        """x: BLOCK float32 pascals, the index-th block of the input. Returns the events of this block."""
        events = []
        base = index * BLOCK
        self.lib.smd_impulse_run(self.imp, _ptr(x, ctypes.c_float), BLOCK, _ptr(self._onset, ctypes.c_ubyte),
                                 _ptr(self._power, ctypes.c_float), _ptr(self._floor, ctypes.c_float))
        self._gunshot(base, events)
        if on_row is not None:
            on_row({"k": "tr", "s": "impulse", "t": int(base * 1_000_000 // RATE),
                    "max_db": round(_log10(float(self._power.max()) / REF_PA2 + 1e-12), 1),
                    "rise_db": round(_log10(float((self._power / np.maximum(self._floor, 1e-12)).max()) + 1e-12), 1)})
        if self.comb is not None and index >= 1:
            frame_start = BLOCK * (index - 1)
            if not self._masked(frame_start):
                frame = np.ascontiguousarray(np.concatenate((self._prev, x)), dtype=np.float32)
                self.lib.smd_comb_run(self.comb, _ptr(frame, ctypes.c_float), FRAME, _ptr(self._out, ctypes.c_double))
                self._drone(frame_start + FRAME - 1, events, on_row)
        self._prev = x
        return events

    def _gunshot(self, base, events):
        for i in range(BLOCK // WIN):
            s = base + WIN * i
            power = float(self._power[i])
            if self._onset[i]:
                self._last_onset = s
                rise = 10.0 * math.log10(max(power / max(float(self._floor[i]), 1e-30), 1e-30))
                self._shot = [self.hold, s, power, rise]
            elif self._shot is not None:
                self._shot[2] = max(self._shot[2], power)
                self._shot[0] -= 1
                if self._shot[0] <= 0:
                    _, onset, peak, rise = self._shot
                    events.append({"type": "SHOT", "t": onset / RATE,
                                   "peak_db": round(_log10(peak / REF_PA2), 1), "rise_db": round(rise, 1)})
                    self._shot = None

    def _masked(self, frame_start):
        if self._last_onset is None:
            return False
        d = frame_start - self._last_onset
        return d < self.shot_mask and d > -FRAME

    def _drone(self, last_sample, events, on_row):
        o = self._out
        on, trk = int(o[0]), int(o[1])
        t_us = last_sample * 1_000_000 // RATE
        if on_row is not None:
            on_row({"k": "tr", "s": "comb", "t": t_us, "on": on, "trk": trk, "f0": round(float(o[2]), 1),
                    "score": round(float(o[3]), 3), "peak": round(float(o[4]), 3), "nh": int(o[5]),
                    "band": round(float(o[6]), 1), "floor": round(float(o[7]), 1), "q": int(o[8])})
        state = None
        if on and not self._was_on:
            state = "start"
            self._next_update_us = t_us + self.update_us
        elif on and trk and t_us >= self._next_update_us:
            state = "update"
            self._next_update_us += self.update_us
        elif not on and self._was_on:
            state = "end"
        self._was_on = bool(on)
        if state is not None:
            events.append({"type": "DRONE", "state": state, "t": t_us / 1e6,
                           "f0_hz": round(float(o[2]), 1), "nharm": int(o[5]),
                           "score": round(float(o[3]), 3), "band_db": round(float(o[6]), 1)})



def blocks(chunks):
    """Yields BLOCK-sample float32 arrays from an iterable of float32 chunks. The tail is dropped."""
    buf = np.zeros(0, np.float32)
    for chunk in chunks:
        buf = np.concatenate((buf, np.asarray(chunk, dtype=np.float32)))
        while len(buf) >= BLOCK:
            yield buf[:BLOCK]
            buf = buf[BLOCK:]


def run_chunks(chunks, detectors, on_row=None):
    events = []
    for index, x in enumerate(blocks(chunks)):
        events.extend(detectors.process_block(index, x, on_row))
    return events


LEVELS_REF_DB = 120.0  # full scale of the levels profile when none is recorded


@dataclass
class Chain:
    """The measured bench chain, as replay applies it. None in place of a Chain is the old model: file samples
    scaled by the full-scale assumption, and 40 dB SPL white noise for quiet time.

    response: a response profile; clips are filtered by it before scaling (quiet noise is not).
    levels_offset_db: added to every clip's gain. It is spl_at_0dbfs - the levels profile's full scale, so a
        0 dBFS sine at the replay's full scale lands at spl_at_0dbfs at the mic (see clip_pa_factor).
    noise: a noise profile. Quiet time is its measured noise instead of 40 dB white noise.
    noise_bed: add the same noise under every clip (on the bench the room is always there).
    """
    response: dict = None
    response_path: str = None
    levels_path: str = None
    levels_spl_db: float = None
    levels_ref_db: float = None
    levels_offset_db: float = 0.0
    noise: dict = None
    noise_path: str = None
    noise_bed: bool = False
    node: str = None
    seed: int = 1
    _fir: object = field(default=None, repr=False, compare=False)

    def fir(self):
        if self._fir is None:
            self._fir = response.response_fir(self.response, RATE)
        return self._fir

    def describe(self):
        """The chain as plain data, for result files: the profile paths and the levels mapping used."""
        return {"node": self.node, "response": self.response_path, "levels": self.levels_path,
                "levels_spl_at_0dbfs": self.levels_spl_db, "levels_ref_full_scale_db": self.levels_ref_db,
                "levels_offset_db": round(self.levels_offset_db, 3), "noise": self.noise_path,
                "noise_bed": self.noise_bed}

    def header(self):
        parts = []
        if self.response_path:
            parts.append(f"response {os.path.basename(self.response_path)}")
        if self.levels_path:
            parts.append(f"levels {os.path.basename(self.levels_path)} (0 dBFS = {self.levels_spl_db:g} dB SPL "
                         f"at full scale {self.levels_ref_db:g}, clip offset {self.levels_offset_db:+.2f} dB)")
        if self.noise_path:
            parts.append(f"noise {os.path.basename(self.noise_path)}"
                         + (" (bed under clips)" if self.noise_bed else " (quiet only)"))
        return "chain: " + ("; ".join(parts) if parts else "response off")


def load_levels(path):
    """(spl_at_0dbfs, full scale of the profile) from a levels profile written by sm measure levels."""
    with open(path, encoding="utf-8") as fh:
        profile = json.load(fh)
    if profile.get("schema") != response.SCHEMA or profile.get("kind") != "levels":
        raise ValueError(f"{path}: not a levels profile")
    fit = profile["results"].get("fit") or {}
    if "spl_at_0dbfs" not in fit:
        raise ValueError(f"{path}: the levels profile has no fit (no linear steps)")
    return float(fit["spl_at_0dbfs"]), float(profile.get("full_scale_db", LEVELS_REF_DB))


PROFILE_RE = re.compile(r"^(\d{8}T\d{6}Z)-(.+)-(response|levels|noise)\.json$")
PROFILE_KINDS = ("response", "levels", "noise")


def find_bench(spec, profiles_dir=None):
    """The newest response, levels and noise profile of a node.

    spec is a node name (for example fb98), looked up in profiles_dir (default data/bench/profiles), or a
    directory holding the profiles (then it must hold one node). File names start with the UTC stamp, so
    the last match in sorted order is the newest. Returns (node, {kind: path}); kinds with no profile are
    left out.
    """
    if os.path.isdir(spec):
        directory, node = spec, None
    else:
        directory, node = profiles_dir or os.path.join(BENCH_DIR, "profiles"), spec
    if not os.path.isdir(directory):
        raise ValueError(f"no profile directory {directory}")
    by_node = {}
    for name in sorted(os.listdir(directory)):
        m = PROFILE_RE.match(name)
        if not m:
            continue
        _, n, kind = m.groups()
        if node is not None and n != node:
            continue
        by_node.setdefault(n, {})[kind] = os.path.join(directory, name)
    if not by_node:
        raise ValueError(f"no profiles for {spec} in {directory}")
    if node is None:
        if len(by_node) > 1:
            raise ValueError(f"{directory} has profiles for several nodes ({', '.join(sorted(by_node))}); "
                             "name one with --bench NODE")
        node, found = next(iter(by_node.items()))
    else:
        found = by_node[node]
    return node, found


def chain_from_args(response_path=None, levels_path=None, noise_path=None, noise_bed=None, bench=None,
                    profiles_dir=None):
    """The Chain for the given options, or None when no bench option is set.

    bench picks the newest profile of each kind for a node; an explicit path for a kind overrides it.
    noise_bed None means on when a noise profile is given. Returns (chain or None, notes): notes name the
    kinds that the bench lookup did not find.
    """
    node, found, notes = None, {}, []
    if bench:
        node, found = find_bench(bench, profiles_dir)
        notes += [f"no {k} profile for {node}; that part of the chain is off"
                  for k in PROFILE_KINDS if k not in found]
    response_path = response_path or found.get("response")
    levels_path = levels_path or found.get("levels")
    noise_path = noise_path or found.get("noise")
    if noise_bed and noise_path is None:
        raise ValueError("--noise-bed needs a noise profile (--noise or --bench)")
    if response_path is None and levels_path is None and noise_path is None:
        return None, notes
    chain = Chain(node=node, noise_bed=(noise_path is not None) if noise_bed is None else bool(noise_bed))
    if response_path is not None:
        chain.response = response.load_profile(response_path)
        if chain.response.get("kind") != "response":
            raise ValueError(f"{response_path}: not a response profile")
        chain.response_path = response_path
    if levels_path is not None:
        spl, ref = load_levels(levels_path)
        chain.levels_path, chain.levels_spl_db, chain.levels_ref_db = levels_path, spl, ref
        chain.levels_offset_db = spl - ref
    if noise_path is not None:
        chain.noise = response.load_profile(noise_path)
        if chain.noise.get("kind") != "noise":
            raise ValueError(f"{noise_path}: not a noise profile")
        chain.noise_path = noise_path
    if node is None:
        chain.node = _node_of(response_path or levels_path or noise_path)
    return chain, notes


def _node_of(path):
    m = PROFILE_RE.match(os.path.basename(path)) if path else None
    return m.group(2) if m else None


def _bed(chain, rng=None):
    """A NoiseBed for the chain's noise profile, or None. Shares the scenario's random generator when given."""
    if chain is None or chain.noise is None:
        return None
    return response.NoiseBed(chain.noise, RATE, rng)


def clip_pa_factor(full_scale_db, gain_db=0.0, chain=None):
    """Multiplies a file sample in [-1, 1] to pascals at the mic.

    The detectors' full scale (full_scale_db, from --full-scale-db or the tuning) sets the counts-to-pascals
    scale, as on the board. The clip gain (gain_db) adds to it, and so does the levels offset of the chain
    (spl_at_0dbfs - the levels profile's full scale, -7.14 dB for fb98). With the defaults (full scale 120 and
    the fb98 levels profile) a full-scale sine at 0 dBFS arrives at 112.86 dB SPL, not 120 dB.
    """
    offset = chain.levels_offset_db if chain is not None else 0.0
    return audio.pa_factor(full_scale_db, gain_db + offset)


def _render(raw, full_scale_db, gain_db, chain, bed=None, under=False):
    """Pascal chunks from raw clip samples (float in [-1, 1]). The response filter runs before the scaling
    (it is scale-free). The room bed, when under is True, is added after the scaling: the room is not played
    through the chain. Without under, the bed's clock is still advanced so that its tones stay on the timeline."""
    factor = clip_pa_factor(full_scale_db, gain_db, chain)
    stream = response.FirStream(chain.fir()) if chain is not None and chain.response is not None else None
    for x in raw:
        x = np.asarray(x, float)
        if stream is not None:
            x = stream.process(x)
        y = x * factor
        if bed is not None:
            if under:
                y = y + bed.take(len(y))
            else:
                bed.advance(len(y))
        yield y.astype(np.float32)


def file_chunks(path, full_scale_db, gain_db=0.0, channel=None, chain=None):
    """Pascal chunks of one WAV file, with the chain applied. The chain's noise bed is added under it if set."""
    x = audio.load_clip(path, channel)
    raw = (x[i:i + CHUNK] for i in range(0, len(x), CHUNK))
    under = chain is not None and chain.noise_bed
    yield from _render(raw, full_scale_db, gain_db, chain, _bed(chain), under)


def replay_file(path, values, full_scale_db=None, gain_db=0.0, channel=None, on_row=None, comb=True, chain=None):
    """Events of one WAV file, times from its start. values: flat tuning dict. chain: a Chain or None."""
    split = tuning.split_tuning(values)
    fs = split.options["full_scale_db"] if full_scale_db is None else full_scale_db
    det = Detectors(split.comb, split.impulse, split.options["update_ms"], split.options["shot_mask_ms"], comb)
    try:
        return run_chunks(file_chunks(path, fs, gain_db, channel, chain), det, on_row)
    finally:
        det.close()


def quiet_chunks(n_samples, spl_db, rng):
    rms = REF_PA2 ** 0.5 * 10 ** (spl_db / 20)
    for i in range(0, n_samples, CHUNK):
        m = min(CHUNK, n_samples - i)
        yield (rng.standard_normal(m) * rms).astype(np.float32)


def scenario_chunks(segments, full_scale_db, quiet_spl_db, cache_dir=None, seed=1, chain=None):
    """The timeline as pascal chunks: clips from their cached 16 kHz copies, quiet noise elsewhere.

    With a chain, clips go through its response and levels offset, quiet time is the chain's measured noise
    (instead of quiet_spl_db white noise), and the noise bed runs on the same generator through the whole
    timeline, so its tones keep their phase across items."""
    rng = np.random.default_rng(seed)
    bed = _bed(chain, rng)
    under = chain is not None and chain.noise_bed
    for seg in segments:
        if seg.kind in ("gunshot", "drone"):
            clip = audio.cached_clip(seg.path, cache_dir=cache_dir)
            raw = (clip[i:i + CHUNK] for i in range(0, len(clip), CHUNK))
            yield from _render(raw, full_scale_db, seg.gain_db, chain, bed, under)
        elif bed is not None:
            for i in range(0, seg.n_samples, CHUNK):
                yield bed.take(min(CHUNK, seg.n_samples - i)).astype(np.float32)
        else:
            yield from quiet_chunks(seg.n_samples, quiet_spl_db, rng)


class ScenarioRun:
    def __init__(self, events, windows, span, segments):
        self.events = events
        self.windows = windows
        self.span = span
        self.segments = segments


def replay_scenario(scenario, values, quiet_spl_db=40.0, cache_dir=None, on_row=None, comb=True, chain=None):
    """Runs the whole timeline of a scenario through the detectors in one pass. chain: a Chain or None."""
    split = tuning.split_tuning(values)
    segments = scenario_plan(scenario)
    det = Detectors(split.comb, split.impulse, split.options["update_ms"], split.options["shot_mask_ms"], comb)
    try:
        chunks = scenario_chunks(segments, split.options["full_scale_db"], quiet_spl_db, cache_dir, chain=chain)
        events = run_chunks(chunks, det, on_row)
    finally:
        det.close()
    end = segments[-1].end_s if segments else 0.0
    return ScenarioRun(events, scenario_windows(segments), (0.0, end), segments)
