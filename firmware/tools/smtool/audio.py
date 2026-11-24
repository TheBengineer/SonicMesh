"""Audio for the tuning tool: WAV reading (PCM and IEEE float), resampling to the node rate, cached
clips, and playback with paplay.

A file sample x in [-1, 1] is read as x * 32768 counts. The node turns counts into pascals with
pa_per_count = 20e-6 * 10^(full_scale_db/20) * sqrt(2) / 32768 (firmware/lib/audio.c), so
pa_factor() gives x -> pascals directly.
"""

import hashlib
import math
import os
import struct
import subprocess
import sys
import time

import numpy as np

from . import BENCH_DIR

RATE = 16000
REF_PA = 20e-6
HALF_TAPS = 128  # resampler filter half length, in input samples
CUTOFF = 0.45  # low-pass edge as a fraction of the lower sample rate
CHUNK = 8192  # output samples per resampler step, bounds memory
MAX_PLAY_VOLUME = 65536  # paplay volume 65536 is 100 %


class WavInfo:
    def __init__(self, tag, channels, rate, bits, data_offset, data_size):
        self.tag = tag
        self.channels = channels
        self.rate = rate
        self.bits = bits
        self.data_offset = data_offset
        self.data_size = data_size

    @property
    def frames(self):
        return self.data_size // (self.channels * (self.bits // 8))


def scan_wav(path):
    """Header of a RIFF WAVE file: PCM (tag 1) or IEEE float (tag 3), including WAVE_FORMAT_EXTENSIBLE."""
    with open(path, "rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise ValueError(f"{path}: not a RIFF/WAVE file")
        file_size = os.fstat(f.fileno()).st_size
        fmt = data = None
        while fmt is None or data is None:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            cid, size = struct.unpack("<4sI", hdr)
            pos = f.tell()
            if cid == b"fmt ":
                body = f.read(size)
                tag, channels, rate, _, _, bits = struct.unpack_from("<HHIIHH", body)
                if tag == 0xFFFE and size >= 26:
                    tag = struct.unpack_from("<H", body, 24)[0]
                fmt = (tag, channels, rate, bits)
            elif cid == b"data":
                size = min(size, file_size - pos)
                data = (pos, size)
                f.seek(size, 1)
            else:
                f.seek(size, 1)
            if size & 1:
                f.seek(1, 1)
    if fmt is None or data is None:
        raise ValueError(f"{path}: no fmt or data chunk")
    tag, channels, rate, bits = fmt
    return WavInfo(tag, channels, rate, bits, data[0], data[1])


def _decode(raw, tag, bits, path):
    if tag == 3 and bits in (32, 64):
        return np.frombuffer(raw, dtype="<f4" if bits == 32 else "<f8").astype(np.float64)
    if tag == 1 and bits == 8:
        return (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    if tag == 1 and bits == 16:
        return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if tag == 1 and bits == 24:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= (1 << 23), v - (1 << 24), v)
        return v.astype(np.float64) / 8388608.0
    if tag == 1 and bits == 32:
        return np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    raise ValueError(f"{path}: unsupported WAV format tag {tag} with {bits} bits")


def read_wav(path, channel=None):
    """(rate, mono float64 samples in [-1, 1]). Channels are averaged unless channel is given."""
    info = scan_wav(path)
    with open(path, "rb") as f:
        f.seek(info.data_offset)
        raw = f.read(info.data_size)
    usable = info.frames * info.channels * (info.bits // 8)
    samples = _decode(raw[:usable], info.tag, info.bits, path).reshape(-1, info.channels)
    if channel is None:
        mono = samples.mean(axis=1)
    else:
        if not 0 <= channel < info.channels:
            raise ValueError(f"{path} has {info.channels} channel(s); channel {channel} is out of range")
        mono = samples[:, channel]
    return info.rate, mono


def pa_factor(full_scale_db, gain_db=0.0):
    """Multiplies a file sample in [-1, 1] to give pascals at the mic."""
    return REF_PA * 10 ** (full_scale_db / 20) * math.sqrt(2) * 10 ** (gain_db / 20)


def resampled_length(n_in, fs_in, fs_out):
    g = math.gcd(fs_in, fs_out)
    return (n_in * (fs_out // g)) // (fs_in // g)


def resample(x, fs_in, fs_out, half_taps=HALF_TAPS):
    """Band-limited resampling with a Blackman-windowed sinc, phase table per output phase."""
    x = np.asarray(x, dtype=np.float64)
    if fs_in == fs_out:
        return x.copy()
    g = math.gcd(fs_in, fs_out)
    up, down = fs_out // g, fs_in // g
    n_out = resampled_length(len(x), fs_in, fs_out)
    cutoff = CUTOFF * min(fs_in, fs_out) / fs_in  # cycles per input sample
    taps = np.arange(-half_taps + 1, half_taps + 1)
    frac = np.arange(up) / up
    dist = taps[None, :] - frac[:, None]
    u = dist / half_taps
    window = np.where(np.abs(u) < 1, 0.42 + 0.5 * np.cos(np.pi * u) + 0.08 * np.cos(2 * np.pi * u), 0.0)
    kernel = 2 * cutoff * np.sinc(2 * cutoff * dist) * window
    kernel /= kernel.sum(axis=1, keepdims=True)
    padded = np.concatenate((np.zeros(half_taps), x, np.zeros(half_taps)))
    out = np.empty(n_out)
    for start in range(0, n_out, CHUNK):
        n = np.arange(start, min(start + CHUNK, n_out), dtype=np.int64)
        pos = n * down
        idx = (pos // up)[:, None] + (half_taps + taps)[None, :]
        out[start:start + len(n)] = np.einsum("ij,ij->i", padded[idx], kernel[pos % up])
    return out


def load_clip(path, channel=None):
    """A file as 16 kHz mono float32 in the file's [-1, 1] scale."""
    rate, mono = read_wav(path, channel)
    return resample(mono, rate, RATE).astype(np.float32)


def cached_clip(path, channel=None, cache_dir=None):
    """load_clip, kept as a .npy under data/bench/cache. Returns a read-only memory map."""
    cache_dir = cache_dir or os.path.join(BENCH_DIR, "cache")
    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}|{channel}|{RATE}".encode())
    target = os.path.join(cache_dir, key.hexdigest()[:20] + ".npy")
    if not os.path.exists(target):
        os.makedirs(cache_dir, exist_ok=True)
        tmp = target + ".tmp.npy"
        np.save(tmp, load_clip(path, channel))
        os.replace(tmp, target)
    return np.load(target, mmap_mode="r")


def clip_samples(path):
    """Length of the clip at 16 kHz, from the header only."""
    info = scan_wav(path)
    return resampled_length(info.frames, info.rate, RATE)


def play_volume(gain_db=0.0):
    """paplay --volume for a gain in dB, clamped at 100 %. The volume scale is cubic (amplitude is
    (volume / 65536) ** 3), so a gain of g dB is 10 ** (g / 60) of full volume."""
    volume = int(round(MAX_PLAY_VOLUME * 10 ** (gain_db / 60)))
    if volume > MAX_PLAY_VOLUME:
        print(f"smtool: gain {gain_db} dB clipped at paplay's 100 % volume", file=sys.stderr)
        volume = MAX_PLAY_VOLUME
    return volume


def play_clip(path, gain_db=0.0):
    """Plays a file with paplay and waits. Returns (host time before start, host time after end)."""
    t0 = time.time()
    subprocess.run(["paplay", f"--volume={play_volume(gain_db)}", path], check=True, timeout=600)
    return t0, time.time()
