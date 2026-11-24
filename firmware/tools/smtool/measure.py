"""Measures the bench chain (laptop, headphones, air, board mic) and the room noise, for replay and simulation.

  sm measure response --port P [--level-dbfs -12] [--repeat 2]   exponential sweep, magnitude response
  sm measure levels --port P                                      1 kHz ladder, linear range and clip point
  sm measure noise --port P [--seconds 60]                        room noise: level, bands, stationary tones

Each writes data/bench/profiles/<UTC stamp>-<node>-<kind>.json (read by response.py) and prints a table.
Board samples are the capture's int16 counts. Counts become pascals with audio.pa_factor(full_scale_db)/32768,
the same scaling the node uses. The capture module (capture.record) is imported only inside the handlers.

Method notes:
- Sweep: exponential sine 50 Hz to 7.5 kHz, Farina inverse filter. The recording is resampled from the
  board's measured rate to the 16 kHz grid of the played file, so the 50 ppm clock difference is removed.
  The response is the band-mean power of a 120 ms window of the impulse response, relative to 1 kHz.
- Latency: from the start of the sweep to the impulse-response peak. Informational only.
"""

import hashlib
import json
import math
import os
import subprocess
import sys
import threading
import wave
from datetime import datetime, timezone

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from . import BENCH_DIR, audio, response
from .device import Board, DeviceError

RATE = audio.RATE
REF_PA = audio.REF_PA
SWEEP_F1 = 50.0
SWEEP_F2 = 7500.0
SWEEP_S = 10.0
SWEEP_LEAD_S = 1.0
SWEEP_TAIL_S = 1.0
LADDER_LEVELS = tuple(range(-60, 1, 6))
LADDER_STEP_S = 1.0
LADDER_FREQ = 1000.0
LADDER_LEAD_S = 0.5
LADDER_TAIL_S = 0.5
IR_PRE_S = 0.02
IR_POST_S = 0.10
IR_FADE_S = 0.025
IR_FFT = 65536
DEFAULT_CHAIN = "laptop headphones on the bench"
FULL_SCALE_DEFAULT = 120.0
SINC_HALF = 64
WELCH_N = 8192
TONE_MIN_EXCESS_DB = 10.0
TONE_STATIONARY_DB = 6.0
MEDIAN_HALF_BINS = 40
MAX_TONES = 20
CLIP_LEVEL = 32000  # counts; a step at or above this is saturated


# ---- signals ----------------------------------------------------------------------------------

def _sweep_unit(n, fs, f1, f2, seconds):
    t = np.arange(n) / fs
    L = seconds / math.log(f2 / f1)
    return np.sin(2 * np.pi * f1 * L * (np.exp(t / L) - 1)), L


def make_sweep(level_dbfs=-12.0, fs=RATE, f1=SWEEP_F1, f2=SWEEP_F2, seconds=SWEEP_S,
               lead_s=SWEEP_LEAD_S, tail_s=SWEEP_TAIL_S):
    """Played file (float, peak 10**(level/20)) and its meta. Silence of lead_s and tail_s surrounds it."""
    n = int(round(seconds * fs))
    sweep, _ = _sweep_unit(n, fs, f1, f2, seconds)
    played = np.concatenate((np.zeros(int(round(lead_s * fs))), sweep * 10 ** (level_dbfs / 20),
                             np.zeros(int(round(tail_s * fs)))))
    meta = {"kind": "sweep", "fs": fs, "f1": f1, "f2": f2, "sweep_s": seconds, "n_sweep": n,
            "lead_s": lead_s, "tail_s": tail_s, "level_dbfs": level_dbfs}
    return played, meta


def make_ladder(levels=LADDER_LEVELS, fs=RATE, step_s=LADDER_STEP_S, freq=LADDER_FREQ,
                lead_s=LADDER_LEAD_S, tail_s=LADDER_TAIL_S):
    """1 kHz tone steps, one per level in dBFS (peak amplitude 10**(level/20)), with silence around."""
    n_step = int(round(step_s * fs))
    parts = [np.zeros(int(round(lead_s * fs)))]
    for i, level in enumerate(levels):
        t = (int(round(lead_s * fs)) + i * n_step + np.arange(n_step)) / fs
        parts.append(10 ** (level / 20) * np.sin(2 * np.pi * freq * t))
    parts.append(np.zeros(int(round(tail_s * fs))))
    meta = {"kind": "ladder", "fs": fs, "levels": list(levels), "step_s": step_s, "freq": freq,
            "lead_s": lead_s, "tail_s": tail_s}
    return np.concatenate(parts), meta


def write_wav(path, x, fs=RATE):
    """16-bit mono PCM. x is float in [-1, 1]."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pcm = np.clip(np.round(np.asarray(x, float) * 32767), -32768, 32767).astype("<i2")
    tmp = path + ".tmp"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)
    return path


def cached_wav(name, meta, x):
    key = hashlib.sha1(json.dumps(meta, sort_keys=True).encode()).hexdigest()[:12]
    path = os.path.join(BENCH_DIR, "cache", f"measure-{name}-{key}.wav")
    if not os.path.exists(path):
        write_wav(path, x, meta["fs"])
    return path


# ---- resampling to the played grid -----------------------------------------------------------

def sample_at(x, pos, half=SINC_HALF):
    """Band-limited value of x at fractional sample positions (Blackman-windowed sinc, 2*half taps)."""
    x = np.asarray(x, float)
    pos = np.minimum(np.asarray(pos, float), len(x) - 1)
    xp = np.concatenate((np.zeros(half), x, np.zeros(half)))
    taps = np.arange(-half + 1, half + 1)
    out = np.empty(len(pos))
    for s in range(0, len(pos), 4096):
        p = pos[s:s + 4096]
        i0 = np.floor(p).astype(np.int64)
        dist = (p - i0)[:, None] - taps[None, :]
        u = dist / half
        w = np.where(np.abs(u) < 1, 0.42 + 0.5 * np.cos(np.pi * u) + 0.08 * np.cos(2 * np.pi * u), 0.0)
        k = np.sinc(dist) * w
        k /= k.sum(axis=1, keepdims=True)
        idx = i0[:, None] + taps[None, :] + half
        out[s:s + len(p)] = np.einsum("ij,ij->i", xp[idx], k)
    return out


def resample_to_grid(samples, rate_hz, fs=RATE):
    """The board's samples on the fs grid of the played file: sample n of the output is at n / fs seconds."""
    ratio = rate_hz / fs
    x = np.asarray(samples, float)
    n_out = int(math.floor((len(x) - 1) / ratio)) + 1
    return sample_at(x, np.arange(n_out) * ratio)


def ppm_offset(rate_hz, fs=RATE):
    return (rate_hz / fs - 1.0) * 1e6


# ---- analysis helpers -------------------------------------------------------------------------

def _spl(pa_rms):
    return 20 * math.log10(max(pa_rms, 1e-12) / REF_PA)


def to_pascals(counts, full_scale_db):
    return np.asarray(counts, float) / 32768.0 * audio.pa_factor(full_scale_db)


def _welch(x, M=WELCH_N):
    """Per-bin power, averaged over Hann frames with 50 % overlap. Sum over bins divided by M is the
    mean square, so a sinusoid of RMS r contributes r**2."""
    win = np.hanning(M)
    s1 = np.sum(win ** 2)
    x = np.asarray(x, float)
    if len(x) < M:
        x = np.concatenate((x, np.zeros(M - len(x))))
    hop = M // 2
    nf = 1 + (len(x) - M) // hop
    idx = np.arange(M)[None, :] + hop * np.arange(nf)[:, None]
    X = np.fft.rfft(x[idx] * win, axis=1)
    P = 2 * np.mean(np.abs(X) ** 2, axis=0) / s1
    P[0] /= 2
    P[-1] /= 2
    return P


def _running_median(values, half):
    padded = np.concatenate((np.full(half, values[0]), values, np.full(half, values[-1])))
    return np.median(sliding_window_view(padded, 2 * half + 1), axis=1)


def _fft_conv(a, b):
    n = len(a) + len(b) - 1
    nf = 1 << int(math.ceil(math.log2(n)))
    return np.fft.irfft(np.fft.rfft(a, nf) * np.fft.rfft(b, nf), nf)[:n]


def _capture_module():
    from . import capture  # the capture module is written alongside this one; import only when recording
    return capture


# ---- sweep response ---------------------------------------------------------------------------

def _band_powers(ir, fs):
    spec = np.abs(np.fft.rfft(ir, IR_FFT)) ** 2
    f = np.fft.rfftfreq(IR_FFT, 1.0 / fs)
    out = []
    for fc, lo, hi in response.measurement_bands(fs):
        m = (f >= lo) & (f < hi)
        out.append((fc, lo, hi, float(np.mean(spec[m])) if np.any(m) else 0.0))
    return out


def analyse_response(captures, meta):
    """captures: objects with .samples (int16 counts), .rate_hz, .gaps. meta: from make_sweep."""
    fs = meta["fs"]
    n = meta["n_sweep"]
    lead = int(round(meta["lead_s"] * fs))
    sweep, L = _sweep_unit(n, fs, meta["f1"], meta["f2"], meta["sweep_s"])
    inv = sweep[::-1] * np.exp(-np.arange(n) / fs / L)  # Farina inverse: time-reversed, 6 dB/oct ramp
    pre, post = int(round(IR_PRE_S * fs)), int(round(IR_POST_S * fs))
    fade = int(round(IR_FADE_S * fs))
    fade_w = 0.5 * (1 + np.cos(np.pi * np.arange(fade) / fade))
    per_capture = []
    latencies = []
    ratios = []
    gap_total = 0
    rates = []
    for cap in captures:
        rec = resample_to_grid(cap.samples, cap.rate_hz, fs)
        ir_full = _fft_conv(rec, inv)
        peak = int(np.argmax(np.abs(ir_full)))
        latencies.append((peak - (n - 1) - lead) / fs * 1000)
        ir = np.zeros(pre + post)
        a = max(peak - pre, 0)
        seg = ir_full[a:peak + post]
        ir[pre - (peak - a):pre - (peak - a) + len(seg)] = seg
        ir[-fade:] *= fade_w
        bands = _band_powers(ir, fs)
        p1k = next(p for fc, _, _, p in bands if fc == 1000.0)
        ratios.append([p / p1k for _, _, _, p in bands])
        gap_total += sum(length for _, length in (getattr(cap, "gaps", None) or []))
        rates.append(cap.rate_hz)
    avg = np.mean(np.array(ratios), axis=0)
    bands = []
    for (fc, lo, hi), r in zip(response.measurement_bands(fs), avg):
        bands.append({"fc": fc, "lo_hz": round(lo, 3), "hi_hz": round(hi, 3),
                      "db": round(10 * math.log10(max(r, 1e-30)), 3),
                      "valid": bool(lo >= meta["f1"] and hi <= meta["f2"])})
    return {"bands": bands,
            "latency_ms": round(float(np.mean(latencies)), 3),
            "latency_ms_each": [round(v, 3) for v in latencies],
            "ir_window_ms": round((pre + post) / fs * 1000, 1),
            "repeats": len(captures),
            "board_rate_hz": round(float(np.mean(rates)), 4),
            "rate_ppm": round(ppm_offset(float(np.mean(rates)), fs), 2),
            "gap_samples": int(gap_total)}


# ---- levels -----------------------------------------------------------------------------------

def _block_db(x, block):
    n = len(x) // block
    p = np.mean(np.asarray(x[:n * block]).reshape(n, block) ** 2, axis=1)
    return 10 * np.log10(np.maximum(p, 1e-12))


def _ladder_shift(rec, played, max_shift_s=0.5):
    """Delay in samples between the played ladder and the recording, from the block-power envelopes."""
    block = 160
    ep = _block_db(played, block)
    er = _block_db(rec, block)
    a = ep - ep.mean()
    best_score, best_s = -np.inf, 0
    for s in range(0, int(max_shift_s * RATE / block) + 1):
        seg = er[s:s + len(a)]
        if len(seg) < len(a):
            break
        c = seg - seg.mean()
        score = float(a @ c / (np.linalg.norm(a) * np.linalg.norm(c) + 1e-12))
        if score > best_score:
            best_score, best_s = score, s
    return best_s * block


def _gain_fit(steps, full_scale_db):
    floor = min(s["noise_spl_db"] for s in steps)
    valid = sorted((s for s in steps if s["tone_spl_db"] - floor >= 10.0), key=lambda s: s["dbfs"])
    out = {"noise_floor_spl_db": round(floor, 2), "lowest_valid_dbfs": None, "clip_onset_dbfs": None,
           "linear_top_dbfs": None, "linear_range_db": None, "fit": None}
    if len(valid) < 2:
        out["error"] = "fewer than two steps above the noise floor"
        return out
    out["lowest_valid_dbfs"] = valid[0]["dbfs"]
    gain0 = float(np.median([s["tone_spl_db"] - s["dbfs"] for s in valid[:3]]))
    onset = None
    for s in valid:
        err = (s["tone_spl_db"] - s["dbfs"]) - gain0
        if err < -1.0 or s["saturated"]:
            onset = s["dbfs"]
            break
    linear = [s for s in valid if onset is None or s["dbfs"] < onset]
    if len(linear) < 2:
        linear = valid[:2]
    # steps just under the onset can already be a few tenths of a dB low: fit only those within 0.5 dB
    close = [s for s in linear if (s["tone_spl_db"] - s["dbfs"]) - gain0 >= -0.5]
    fit_steps = close if len(close) >= 2 else linear
    slope, intercept = np.polyfit([s["dbfs"] for s in fit_steps], [s["tone_spl_db"] for s in fit_steps], 1)
    top = linear[-1]
    out["clip_onset_dbfs"] = onset
    out["linear_top_dbfs"] = top["dbfs"]
    out["linear_range_db"] = round(top["tone_spl_db"] - floor, 2)
    out["fit"] = {"slope": round(float(slope), 4), "spl_at_0dbfs": round(float(intercept), 2),
                  "gain_vs_full_scale_db": round(float(intercept) - full_scale_db, 2),
                  "steps_used": [s["dbfs"] for s in fit_steps]}
    return out


def analyse_levels(capture, meta, full_scale_db=FULL_SCALE_DEFAULT):
    fs = meta["fs"]
    counts = np.asarray(capture.samples, float)
    rec = resample_to_grid(counts, capture.rate_hz, fs) / 32768.0
    played, _ = make_ladder(tuple(meta["levels"]), fs, meta["step_s"], meta["freq"], meta["lead_s"],
                            meta["tail_s"])
    shift = _ladder_shift(rec, played)
    pa = audio.pa_factor(full_scale_db)
    w1 = 2 * np.pi * meta["freq"]
    nseg = int(round(0.5 * fs))
    t = np.arange(nseg) / fs
    design = np.column_stack((np.cos(w1 * t), np.sin(w1 * t), np.cos(2 * w1 * t), np.sin(2 * w1 * t),
                              np.cos(3 * w1 * t), np.sin(3 * w1 * t), np.ones(nseg)))
    steps = []
    for i, level in enumerate(meta["levels"]):
        start = int(round((meta["lead_s"] + i * meta["step_s"] + 0.25) * fs)) + shift
        if start + nseg > len(rec):
            raise ValueError("recording is too short for the ladder (the board stopped early?)")
        seg = rec[start:start + nseg]
        coef = np.linalg.lstsq(design, seg, rcond=None)[0]
        amp1 = math.hypot(coef[0], coef[1])
        amp2 = math.hypot(coef[2], coef[3])
        amp3 = math.hypot(coef[4], coef[5])
        resid = seg - design @ coef
        steps.append({
            "dbfs": level,
            "tone_spl_db": round(_spl(amp1 * pa / math.sqrt(2)), 2),
            "noise_spl_db": round(_spl(float(np.sqrt(np.mean(resid ** 2))) * pa), 2),
            "thd_pct": round(100 * math.sqrt(amp2 ** 2 + amp3 ** 2) / max(amp1, 1e-12), 3),
            "peak_counts": int(np.max(np.abs(counts[start:start + nseg]))),
        })
    for s in steps:
        s["saturated"] = s["peak_counts"] >= CLIP_LEVEL
    result = _gain_fit(steps, full_scale_db)
    result["steps"] = steps
    result["ladder_shift_ms"] = round(shift / fs * 1000, 2)
    result["board_rate_hz"] = round(float(capture.rate_hz), 4)
    result["rate_ppm"] = round(ppm_offset(float(capture.rate_hz), fs), 2)
    return result


# ---- room noise -------------------------------------------------------------------------------

def analyse_noise(capture, full_scale_db=FULL_SCALE_DEFAULT, seconds_per_block=2.0):
    fs = float(capture.rate_hz)
    x = to_pascals(capture.samples, full_scale_db)
    M = WELCH_N
    P = _welch(x, M)
    f = np.fft.rfftfreq(M, 1.0 / fs)
    Pdb = 10 * np.log10(P + 1e-30)
    med = _running_median(Pdb, MEDIAN_HALF_BINS)
    excess = Pdb - med
    local_max = np.ones(len(P), bool)
    local_max[1:] &= P[1:] >= P[:-1]
    local_max[:-1] &= P[:-1] >= P[1:]
    cand = np.where((excess > TONE_MIN_EXCESS_DB) & local_max)[0]
    cand = cand[(cand > 2) & (cand < len(P) - 3)]
    peaks = _group_peaks(cand, excess)
    block = int(seconds_per_block * fs)
    blocks = [x[i:i + block] for i in range(0, len(x) - block + 1, block)] or [x]
    block_excess = []
    for b in blocks:
        Pb = _welch(b, M)
        block_excess.append(10 * np.log10(Pb + 1e-30) - _running_median(10 * np.log10(Pb + 1e-30), MEDIAN_HALF_BINS))
    block_excess = np.array(block_excess)
    tones = []
    for k0 in sorted(peaks, key=lambda k: -excess[k])[:MAX_TONES]:
        a, b_, c = Pdb[k0 - 1], Pdb[k0], Pdb[k0 + 1]
        delta = 0.5 * (a - c) / (a - 2 * b_ + c) if (a - 2 * b_ + c) != 0 else 0.0
        hz = (k0 + delta) * fs / M
        tone_ms = np.sum(P[k0 - 2:k0 + 3]) / M
        tones.append({"hz": round(float(hz), 2), "spl_db": round(_spl(math.sqrt(tone_ms)), 2),
                      "excess_db": round(float(excess[k0]), 2),
                      "stationary_frac": round(float(np.mean(block_excess[:, k0] > TONE_STATIONARY_DB)), 3)})
    masked = np.zeros(len(P), bool)
    for k0 in peaks:
        masked[max(k0 - 3, 0):k0 + 4] = True
    bands = []
    for fc, lo, hi in response.measurement_bands(fs):
        m = (f >= lo) & (f < hi) & ~masked
        ms = float(np.sum(P[m]) / M) if np.any(m) else 0.0
        bands.append({"fc": fc, "lo_hz": round(lo, 3), "hi_hz": round(hi, 3),
                      "spl_db": round(_spl(math.sqrt(ms)), 2)})
    in_range = (f >= bands[0]["lo_hz"]) & (f < bands[-1]["hi_hz"])
    overall = _spl(math.sqrt(float(np.sum(P[in_range]) / M)))
    return {"duration_s": round(len(x) / fs, 2), "overall_spl_db": round(overall, 2),
            "overall_range_hz": [bands[0]["lo_hz"], bands[-1]["hi_hz"]],
            "bands": bands, "tones": tones, "tone_min_excess_db": TONE_MIN_EXCESS_DB,
            "fft_n": M, "board_rate_hz": round(fs, 4), "rate_ppm": round(ppm_offset(fs), 2)}


def _group_peaks(cand, excess):
    """One peak per run of adjacent candidate bins: the one with the largest excess."""
    peaks = []
    run = []
    for k in cand:
        if run and k != run[-1] + 1:
            peaks.append(max(run, key=lambda j: excess[j]))
            run = []
        run.append(int(k))
    if run:
        peaks.append(max(run, key=lambda j: excess[j]))
    return peaks


# ---- profiles ---------------------------------------------------------------------------------

def make_profile(kind, node_id, chain, params, full_scale_db, rate_hz, meta, results):
    return {
        "schema": response.SCHEMA,
        "kind": kind,
        "node": None if node_id is None else f"{node_id:04x}",
        "chain": chain,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rate_hz": round(float(rate_hz), 4),
        "full_scale_db": full_scale_db,
        "board_params": params,
        "signal": meta,
        "results": results,
    }


def write_profile(profile, kind):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    node = profile["node"] or "unknown"
    directory = os.path.join(BENCH_DIR, "profiles")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"{stamp}-{node}-{kind}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(profile, fh, indent=1)
        fh.write("\n")
    return path


# ---- hardware handlers ------------------------------------------------------------------------

class _Playback:
    """paplay of one WAV, started from the capture's on_started callback and killed by its deadline."""

    def __init__(self, path, deadline_s):
        self.path = path
        self.deadline_s = deadline_s
        self.proc = None
        self.timer = None

    def start(self):
        self.proc = subprocess.Popen(["paplay", f"--volume={audio.play_volume(0.0)}", self.path])
        self.timer = threading.Timer(self.deadline_s, self.kill)
        self.timer.daemon = True
        self.timer.start()

    def kill(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()

    def finish(self):
        if self.timer is not None:
            self.timer.cancel()
        if self.proc is not None:
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.kill()
                self.proc.wait()


def _record_played(board, x, meta, name):
    capture = _capture_module()
    path = cached_wav(name, meta, x)
    seconds = len(x) / meta["fs"] + 0.5
    pb = _Playback(path, deadline_s=seconds + 5.0)
    try:
        return capture.record(board, seconds, on_started=pb.start)
    finally:
        pb.finish()


# Streaming audio over USB uses the CPU the drone comb leaves, and the comb uses more while a sound
# is playing, so a capture with the comb on has gaps. The measurements do not need the comb: it is
# switched off for the measurement and restored after (in RAM; nothing is saved).
COMB_ENABLE = "drone_comb.enable"


def _open_board(port):
    board = Board(port).open()
    try:
        board.info()
        board.comb_was = board.get([COMB_ENABLE]).get(COMB_ENABLE)
        if board.comb_was:
            board.set({COMB_ENABLE: 0})
    except DeviceError:
        board.close()
        raise
    return board


def _close_board(board):
    try:
        if getattr(board, "comb_was", None):
            board.set({COMB_ENABLE: 1})
    except DeviceError as exc:
        print(f"sm measure: could not switch the drone comb back on ({exc}); run "
              f"`sm set --port {board.port} {COMB_ENABLE}=1`", file=sys.stderr)
    finally:
        board.close()


def _snapshot(board):
    try:
        return {p["n"]: p["v"] for p in board.params()}
    except DeviceError:
        return {}


def _rate_warning(rate_hz):
    ppm = ppm_offset(rate_hz)
    if abs(ppm) > 500:
        print(f"sm measure: board rate {rate_hz:.2f} Hz is {ppm:+.0f} ppm from 16 kHz; check the board clock",
              file=sys.stderr)


def _print_bands(bands, key="db", label="dB rel 1 kHz"):
    print(f"{'band Hz':>9}  {label:>12}  valid")
    for b in bands:
        valid = b.get("valid", True)
        print(f"{b['fc']:>9g}  {b[key]:>12.2f}  {'yes' if valid else 'no'}")


def _finish(profile, kind):
    print(f"profile: {write_profile(profile, kind)}")


def cmd_response(args):
    try:
        played, meta = make_sweep(args.level_dbfs)
        board = _open_board(args.port)
    except (DeviceError, OSError, ValueError) as exc:
        print(f"sm: {exc}", file=sys.stderr)
        return 1
    try:
        params = _snapshot(board)
        caps = [_record_played(board, played, meta, "sweep") for _ in range(args.repeat)]
        for cap in caps:
            _rate_warning(cap.rate_hz)
            if getattr(cap, "gaps", None):
                print(f"sm measure: {len(cap.gaps)} gap(s) in a capture; the response may be wrong",
                      file=sys.stderr)
        results = analyse_response(caps, meta)
        profile = make_profile("response", board.node_id, args.chain, params, params.get(
            "audio.full_scale_db", FULL_SCALE_DEFAULT), caps[0].rate_hz, meta, results)
        print(f"node {profile['node']}  rate {caps[0].rate_hz:.2f} Hz ({results['rate_ppm']:+.1f} ppm)  "
              f"latency {results['latency_ms']:.1f} ms (info)  repeats {results['repeats']}")
        _print_bands(results["bands"])
        _finish(profile, "response")
        return 0
    except (DeviceError, OSError, ValueError, ImportError) as exc:
        print(f"sm: {exc}", file=sys.stderr)
        return 1
    finally:
        _close_board(board)


def cmd_levels(args):
    try:
        played, meta = make_ladder()
        board = _open_board(args.port)
    except (DeviceError, OSError, ValueError) as exc:
        print(f"sm: {exc}", file=sys.stderr)
        return 1
    try:
        params = _snapshot(board)
        full_scale = params.get("audio.full_scale_db", FULL_SCALE_DEFAULT)
        cap = _record_played(board, played, meta, "ladder")
        _rate_warning(cap.rate_hz)
        results = analyse_levels(cap, meta, full_scale)
        profile = make_profile("levels", board.node_id, args.chain, params, full_scale, cap.rate_hz, meta,
                               results)
        print(f"node {profile['node']}  full scale {full_scale:g} dB  noise floor {results['noise_floor_spl_db']:.1f} dB SPL")
        print(f"{'dBFS':>6}  {'board dB SPL':>12}  {'noise dB':>9}  {'THD %':>7}  sat")
        for s in results["steps"]:
            print(f"{s['dbfs']:>6g}  {s['tone_spl_db']:>12.2f}  {s['noise_spl_db']:>9.2f}  {s['thd_pct']:>7.2f}  "
                  f"{'yes' if s['saturated'] else ''}")
        if results.get("error"):
            print(f"fit: {results['error']}")
        else:
            fit = results["fit"]
            print(f"fit over {fit['steps_used']} dBFS: slope {fit['slope']}, {fit['spl_at_0dbfs']} dB SPL at 0 dBFS "
                  f"(gain {fit['gain_vs_full_scale_db']:+.2f} dB vs full scale)")
            print(f"linear range {results['linear_range_db']} dB; clip onset "
                  f"{results['clip_onset_dbfs'] if results['clip_onset_dbfs'] is not None else 'none in ladder'} dBFS")
        _finish(profile, "levels")
        return 0
    except (DeviceError, OSError, ValueError, ImportError) as exc:
        print(f"sm: {exc}", file=sys.stderr)
        return 1
    finally:
        _close_board(board)


def cmd_noise(args):
    try:
        board = _open_board(args.port)
    except (DeviceError, OSError, ValueError) as exc:
        print(f"sm: {exc}", file=sys.stderr)
        return 1
    try:
        params = _snapshot(board)
        full_scale = params.get("audio.full_scale_db", FULL_SCALE_DEFAULT)
        capture = _capture_module()
        cap = capture.record(board, args.seconds)
        _rate_warning(cap.rate_hz)
        results = analyse_noise(cap, full_scale)
        meta = {"kind": "noise", "seconds": args.seconds}
        profile = make_profile("noise", board.node_id, args.chain, params, full_scale, cap.rate_hz, meta, results)
        print(f"node {profile['node']}  overall {results['overall_spl_db']:.1f} dB SPL over {results['duration_s']} s")
        _print_bands(results["bands"], key="spl_db", label="dB SPL")
        print("tones (excess over local median, stationary fraction):")
        for t in results["tones"]:
            print(f"  {t['hz']:>9.2f} Hz  {t['spl_db']:>7.2f} dB SPL  +{t['excess_db']:.1f} dB  "
                  f"stationary {t['stationary_frac']:.2f}")
        if not results["tones"]:
            print("  none above the threshold")
        _finish(profile, "noise")
        return 0
    except (DeviceError, OSError, ValueError, ImportError) as exc:
        print(f"sm: {exc}", file=sys.stderr)
        return 1
    finally:
        _close_board(board)


def add_parser(subparsers):
    top = subparsers.add_parser("measure", help="measure the bench chain or room noise (writes a profile)")
    msub = top.add_subparsers(dest="measure_cmd", metavar="{response,levels,noise}")

    def chain(q):
        q.add_argument("--chain", default=DEFAULT_CHAIN, help="what the chain is (stored in the profile)")

    q = msub.add_parser("response", help="sweep: magnitude response in 1/3-octave bands")
    q.add_argument("--port", required=True)
    q.add_argument("--level-dbfs", type=float, default=-12.0, dest="level_dbfs")
    q.add_argument("--repeat", type=int, default=2)
    chain(q)
    q.set_defaults(func=cmd_response)

    q = msub.add_parser("levels", help="1 kHz ladder: linear range, noise floor, clip point")
    q.add_argument("--port", required=True)
    chain(q)
    q.set_defaults(func=cmd_levels)

    q = msub.add_parser("noise", help="room noise: level, 1/3-octave spectrum, stationary tones")
    q.add_argument("--port", required=True)
    q.add_argument("--seconds", type=float, default=60.0)
    chain(q)
    q.set_defaults(func=cmd_noise)

    top.set_defaults(func=lambda args: (top.print_help(), 1)[1])
    return top
