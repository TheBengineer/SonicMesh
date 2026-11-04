"""Background false-alarm evaluation: node alarms and gateway (perimeter) alarms.

Scenes: "rural" (continuous pink and wind plus sparse ESC events, acoustics.background.rural_scene) and "dense"
(back-to-back ESC-50 clips at 50 dB, the stress bed). Each node gets its own seeded scene. Node alarms are onsets of
the detector's on state, with the coarse f0 of the track at onset. The gateway rule counts an alarm when two adjacent
nodes have onsets within GATE_WINDOW_S with f0 within GATE_F0_TOL (Doppler allowance); the gateway event time is the
later onset.
"""

import os
import resource
import sys
from pathlib import Path

# One BLAS thread per worker: the workers are the parallelism.
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))

from acoustics.background import bed, category_at, manifest, rural_scene  # noqa: E402
from acoustics.model import FS, SELF_NOISE_DB  # noqa: E402
from acoustics.noise import white  # noqa: E402
from detector.detector import F0, HOP, N, Detector, Track  # noqa: E402

GATE_WINDOW_S = 10.0
GATE_F0_TOL = 0.12
DENSE_LEVEL_DB = 50.0
# Memory: render long backgrounds in segments, so a worker holds ~SEGMENT_H of audio whatever the run length.
# 2 h of float64 at 16 kS/s is 0.9 GB per array; whole-run renders across 13 workers exhausted a 30 GB machine.
SEGMENT_H = 5.0 / 60.0
WORKER_MEM_BYTES = 3 << 30  # a worker over this fails with MemoryError, instead of taking the machine down
MAX_PROCS = 6


def detector_flags(x, params_list):
    """On flags and coarse f0 per frame, for each parameter set in params_list.

    The sets share one comb (the floor and impulse settings of the first set); they differ in the track settings
    (threshold, age, harmonics, slew). Returns (on, f0) lists in the order of params_list.
    """
    det = Detector(params_list[0])
    frames = np.lib.stride_tricks.sliding_window_view(x, N)[::HOP]
    tracks = [Track() for _ in params_list]
    on = np.zeros((len(params_list), len(frames)), bool)
    f0 = np.zeros((len(params_list), len(frames)))
    for c0 in range(0, len(frames), 512):
        S, W, ok = det.comb_batch(det.power_frames(frames[c0 : c0 + 512]))
        for j in np.flatnonzero(ok):
            i = c0 + j
            for k, (tr, p) in enumerate(zip(tracks, params_list)):
                on[k, i] = tr.update(S[j], W[j], p)
                if on[k, i] and tr.q > 0:
                    f0[k, i] = F0[tr.index]
    return on, f0


def onsets_of(on, f0, t_frame, labels=None):
    """Onset list of (time s, f0 Hz, category or None) for the rising edges of on."""
    edges = np.flatnonzero(np.diff(np.concatenate([[0], on.astype(np.int8)])) == 1)
    out = []
    for e in edges:
        cat = category_at(labels, int(t_frame[e] * FS)) if labels else None
        out.append((float(t_frame[e]), float(f0[e]), cat))
    return out


def node_scene(kind, seed, hours, folds):
    """Samples of one node's background (with self noise) and its labels."""
    if kind == "rural":
        x, events = rural_scene(seed, hours, folds)
        labels = [(s, c) for s, c, _ in events]
    else:
        rows = manifest(folds=set(folds))
        x, labels = bed(seed, rows, hours * 3600.0, DENSE_LEVEL_DB)
    x = x + white(np.random.default_rng(seed + 9001), len(x), SELF_NOISE_DB)
    return x, labels


def _limit_memory():
    resource.setrlimit(resource.RLIMIT_AS, (WORKER_MEM_BYTES, WORKER_MEM_BYTES))


def _node_worker(args):
    kind, params_list, hours, folds, seed = args
    n_seg = max(1, int(np.ceil(hours / SEGMENT_H - 1e-9)))
    seg_h = hours / n_seg
    out = [[] for _ in params_list]
    for k in range(n_seg):
        # Each segment is an independent scene with a fresh detector, which loses a few seconds of track at each join.
        x, labels = node_scene(kind, seed * 100_000 + k, seg_h, folds)
        t_frame = (np.arange(max(0, (len(x) - N) // HOP + 1)) * HOP + N / 2) / FS
        on, f0 = detector_flags(x, params_list)
        offset = k * seg_h * 3600.0
        for j in range(len(params_list)):
            out[j].extend((t + offset, f, c) for t, f, c in onsets_of(on[j], f0[j], t_frame, labels))
    return out


def scene_alarms(kind, params_list, hours, folds, seed, nodes, procs=MAX_PROCS):
    """Per parameter set: onsets for each node, as a dict node -> list of (time, f0, category)."""
    from multiprocessing import Pool

    jobs = [(kind, params_list, hours, folds, seed + i) for i in range(nodes)]
    with Pool(min(procs, nodes), initializer=_limit_memory) as pool:
        out = pool.map(_node_worker, jobs)
    return [{i: out[i][k] for i in range(nodes)} for k in range(len(params_list))]


def gateway_events(node_onsets):
    """Gateway events from adjacent-node onset pairs: list of event times."""
    ev = []
    nodes = sorted(node_onsets)
    for i in nodes:
        j = i + 1
        if j not in node_onsets:
            continue
        for t1, f1, _ in node_onsets[i]:
            for t2, f2, _ in node_onsets[j]:
                if abs(t1 - t2) <= GATE_WINDOW_S and abs(f1 / f2 - 1) <= GATE_F0_TOL and f1 > 0 and f2 > 0:
                    ev.append(max(t1, t2))
    return ev
