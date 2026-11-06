"""Background false-alarm evaluation: node alarms and gateway (perimeter) alarms.

Scenes: "rural" (continuous pink and wind plus sparse ESC events, acoustics.background.rural_scene) and "dense"
(back-to-back ESC-50 clips at 50 dB, the stress bed). Each node gets its own seeded scene. Node alarms are onsets of
the detector's on state, with the coarse f0 of the track at onset. The gateway rule counts an alarm when two adjacent
nodes have onsets within GATE_WINDOW_S with f0 within GATE_F0_TOL (Doppler allowance), or an octave apart (a track
can lock onto the second harmonic at one node and the fundamental at the other); the gateway event time is the later
onset. GATE_WINDOW_S is 30 s because adjacent-node onsets of one drone are 3 to 35 s apart (median 15 s, folds 1-3).
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
from detector.detector import Detector, Track, geometry, harmonic_bits  # noqa: E402

GATE_WINDOW_S = 30.0
GATE_F0_TOL = 0.12
GATE_OCTAVE = (1.0, 2.0, 0.5)  # f0 ratios accepted as the same source (mode "f0")
# Gateway match mode. "f0": the coarse f0 agrees, directly or at an octave (rounds 1-2). "lines": each node reports
# f0 and a 6-bit presence mask of harmonics 1-6 (doc 07, round 3). The pair matches when the f0 ratio is within
# GATE_F0_TOL of a small-integer ratio rho (LINE_RATIOS), and at least LINE_MIN_SHARED harmonics are heard by both
# nodes at that ratio: harmonic k of one node and harmonic m of the other are the same line when k x rho = m (within
# GATE_F0_TOL). So a node locked on the 2nd or 3rd harmonic still matches, but only on shared lines.
GATE_MODE = "f0"
LINE_KMAX = 6
LINE_RATIOS = (1.0, 2.0, 0.5, 1.5, 2.0 / 3.0, 3.0, 1.0 / 3.0)
LINE_MIN_SHARED = 2
DENSE_LEVEL_DB = 50.0
# Memory: render long backgrounds in segments, so a worker holds ~SEGMENT_H of audio whatever the run length.
# 2 h of float64 at 16 kS/s is 0.9 GB per array; whole-run renders across 13 workers exhausted a 30 GB machine.
SEGMENT_H = 5.0 / 60.0
WORKER_MEM_BYTES = 3 << 30  # a worker over this fails with MemoryError, instead of taking the machine down
MAX_PROCS = 6


def detector_flags(x, params_list):
    """On flags, coarse f0 and harmonic presence mask per frame, for each parameter set in params_list.

    The sets share one comb (the floor and impulse settings of the first set); they differ in the track settings
    (threshold, age, harmonics, slew). Returns (on, f0, mask) arrays in the order of params_list; mask is the 6-bit
    harmonic presence of the track's candidate (zero when off).
    """
    det = Detector(params_list[0])
    g = det.geom
    frames = np.lib.stride_tricks.sliding_window_view(x, g.N)[:: g.HOP]
    tracks = [Track(g) for _ in params_list]
    on = np.zeros((len(params_list), len(frames)), bool)
    f0 = np.zeros((len(params_list), len(frames)))
    mask = np.zeros((len(params_list), len(frames)), np.int64)
    for c0 in range(0, len(frames), 512):
        S, W, ok = det.comb_batch(det.power_frames(frames[c0 : c0 + 512]))
        for j in np.flatnonzero(ok):
            i = c0 + j
            for k, (tr, p) in enumerate(zip(tracks, params_list)):
                on[k, i] = tr.update(S[j], W[j], p)
                if on[k, i] and tr.q > 0:
                    f0[k, i] = g.F0[tr.index]
                    mask[k, i] = harmonic_bits(W[j], tr.index, g, LINE_KMAX)
    return on, f0, mask


def onsets_of(on, f0, t_frame, labels=None, mask=None):
    """Onset list of (time s, f0 Hz, category or None, harmonic mask) for the rising edges of on."""
    edges = np.flatnonzero(np.diff(np.concatenate([[0], on.astype(np.int8)])) == 1)
    out = []
    for e in edges:
        cat = category_at(labels, int(t_frame[e] * FS)) if labels else None
        out.append((float(t_frame[e]), float(f0[e]), cat, int(mask[e]) if mask is not None else 0))
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
        g = geometry(params_list[0].n_fft, params_list[0].hop)
        t_frame = (np.arange(max(0, (len(x) - g.N) // g.HOP + 1)) * g.HOP + g.N / 2) / FS
        on, f0, mask = detector_flags(x, params_list)
        offset = k * seg_h * 3600.0
        for j in range(len(params_list)):
            out[j].extend((t + offset, f, c, m) for t, f, c, m in onsets_of(on[j], f0[j], t_frame, labels, mask[j]))
    return out


def _segment_worker(args):
    """One 5-minute segment of one node (the unit of work and of the checkpoint). Same scene and detector as
    _node_worker, so a node's segments give the same onsets whether run whole or one at a time."""
    kind, params_list, seg_h, folds, node_seed, k = args
    x, labels = node_scene(kind, node_seed * 100_000 + k, seg_h, folds)
    g = geometry(params_list[0].n_fft, params_list[0].hop)
    t_frame = (np.arange(max(0, (len(x) - g.N) // g.HOP + 1)) * g.HOP + g.N / 2) / FS
    on, f0, mask = detector_flags(x, params_list)
    offset = k * seg_h * 3600.0
    out = []
    for j in range(len(params_list)):
        out.append([(t + offset, f, c, m) for t, f, c, m in onsets_of(on[j], f0[j], t_frame, labels, mask[j])])
    return k, out


def _save_pickle(path, obj):
    import pickle

    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        pickle.dump(obj, fh)
    os.replace(tmp, path)  # a file is either complete or absent, so an outage never leaves a half-written result


def scene_alarms(kind, params_list, hours, folds, seed, nodes, procs=MAX_PROCS, ckpt=None):
    """Per parameter set: onsets for each node, as a dict node -> list of (time, f0, category, harmonic mask).

    With ckpt (a directory), every (node, segment) result is written there when it finishes, and a rerun with the same
    directory computes only the missing ones. Results are the same with or without ckpt."""
    import pickle
    from multiprocessing import Pool

    n_seg = max(1, int(np.ceil(hours / SEGMENT_H - 1e-9)))
    seg_h = hours / n_seg
    if ckpt:
        os.makedirs(ckpt, exist_ok=True)
    jobs, parts = [], {}
    for i in range(nodes):
        for k in range(n_seg):
            path = os.path.join(ckpt, f"n{i:02d}_s{k:04d}.pkl") if ckpt else None
            if path and os.path.exists(path):
                with open(path, "rb") as fh:
                    parts[(i, k)] = pickle.load(fh)
            else:
                jobs.append((i, k, (kind, params_list, seg_h, folds, seed + i, k), path))
    with Pool(min(procs, max(1, len(jobs))), initializer=_limit_memory) as pool:
        for (i, k, _, path), (_, res) in zip(jobs, pool.imap(_segment_worker, [j[2] for j in jobs]) if jobs else []):
            parts[(i, k)] = res
            if path:
                _save_pickle(path, res)
    out = [{i: [] for i in range(nodes)} for _ in params_list]
    for i in range(nodes):
        for k in range(n_seg):
            for j in range(len(params_list)):
                out[j][i].extend(parts[(i, k)][j])
    return out


def f0_match(f1, f2):
    """True when two f0 estimates agree within GATE_F0_TOL, directly or an octave apart."""
    if f1 <= 0 or f2 <= 0:
        return False
    return any(abs(f1 / (f2 * r) - 1) <= GATE_F0_TOL for r in GATE_OCTAVE)


def harmonic_lines(f0, mask, kmax=LINE_KMAX):
    """Absolute frequencies (Hz) of the harmonics whose bit is set in mask (bit k-1 for harmonic k)."""
    return [k * f0 for k in range(1, kmax + 1) if (mask >> (k - 1)) & 1]


def shared_harmonics(f1, m1, f2, m2, rho):
    """Harmonics k of node 1 that node 2 also hears as the same line, at f0 ratio rho (f1 / f2 about rho).

    Harmonic k of node 1 is at k f1, harmonic m of node 2 at m f2, and they are the same line when k f1 = m f2 rho'
    with rho' = f1 / f2 ~ rho, so m / k = rho. The test uses GATE_F0_TOL, which also allows for Doppler."""
    ks = set()
    for k in range(1, LINE_KMAX + 1):
        if not (m1 >> (k - 1)) & 1:
            continue
        for m in range(1, LINE_KMAX + 1):
            if (m2 >> (m - 1)) & 1 and abs(k * rho / m - 1.0) <= GATE_F0_TOL:
                ks.add(k)
                break
    return len(ks)


def ratio_lines_ok(f1, m1, f2, m2):
    """True when the f0 ratio is within GATE_F0_TOL of a small-integer ratio and at least LINE_MIN_SHARED harmonic
    lines are shared at that ratio (mode "lines")."""
    if f1 <= 0 or f2 <= 0 or m1 == 0 or m2 == 0:
        return False
    u = f1 / f2
    for rho in LINE_RATIOS:
        if abs(u / rho - 1.0) <= GATE_F0_TOL and shared_harmonics(f1, m1, f2, m2, rho) >= LINE_MIN_SHARED:
            return True
    return False


def pair_ok(a, b, mode=None):
    """Whether two onsets (t, f0, cat, mask) are the same source under the gateway match mode."""
    mode = mode or GATE_MODE
    if mode == "lines":
        return ratio_lines_ok(a[1], a[3], b[1], b[3])
    return f0_match(a[1], b[1])


def gateway_pairs(node_onsets, max_gap=1, mode=None):
    """Gateway pairs from onsets of nodes up to max_gap apart: list of (i, j, t_i, t_j), j > i."""
    out = []
    for i in sorted(node_onsets):
        for j in range(i + 1, i + 1 + max_gap):
            if j not in node_onsets:
                continue
            for a in node_onsets[i]:
                for b in node_onsets[j]:
                    if abs(a[0] - b[0]) <= GATE_WINDOW_S and pair_ok(a, b, mode):
                        out.append((i, j, a[0], b[0]))
    return out


def gateway_events(node_onsets, mode=None):
    """Gateway events from adjacent-node onset pairs: list of event times (the later onset of each pair)."""
    return [max(t1, t2) for _, _, t1, t2 in gateway_pairs(node_onsets, mode=mode)]
