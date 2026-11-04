# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Rotor-speed wobble of an FPV quad in (mostly) manual mode, from onboard GoPro audio.

The camera rides on the drone, so there is no propagation or Doppler: the
lines are the motors/props as the frame hears them. The audio has been
through AAC (YouTube, 128 kbit/s), which keeps tonal lines but may soften
fine detail.

For each clip, the dominant line in 350-1100 Hz is tracked frame by frame,
gated to +-3 % per frame so it follows throttle sweeps. Then:
  fast wobble   rms of the track minus its 1 s moving average, % of the line
  bandwidth     rms frequency of that fast wobble
  quietest 2 s  the lowest fast wobble in any 2 s stretch (closest to steady stick)

Extract the audio first:
  ffmpeg -i <video.mp4> -vn -acodec pcm_s16le data/user/fpv_dam_001.wav
Run:
  uv run sim/experiments/fpv_onboard_analysis.py [--wav PATH] [--cuts 8.3,14.8,21.2]
"""
import argparse
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parents[2]
FRAME_S, HOP_S = 0.1, 0.01


def track_line(x, fs, band=(350, 1100), gate=0.03):
    nfft = int(FRAME_S * fs)
    hop = int(HOP_S * fs)
    f, t, z = signal.stft(x, fs, nperseg=nfft, noverlap=nfft - hop, nfft=8 * nfft)
    mag = np.log(np.abs(z) + 1e-12)
    df = f[1]
    lo, hi = np.searchsorted(f, band)
    start = lo + np.argmax(mag[lo:hi, :50].mean(axis=1))
    bins = np.zeros(mag.shape[1], int)
    prev = start
    for j in range(mag.shape[1]):
        w = max(1, int(prev * gate))
        a, b = max(prev - w, 1), min(prev + w + 1, len(f) - 1)
        prev = bins[j] = a + int(np.argmax(mag[a:b, j]))
    cols = np.arange(mag.shape[1])
    y0, y1, y2 = mag[bins - 1, cols], mag[bins, cols], mag[bins + 1, cols]
    den = np.where(y0 - 2 * y1 + y2 == 0, -1e-9, y0 - 2 * y1 + y2)
    return t, (bins + np.clip(0.5 * (y0 - y2) / den, -0.5, 0.5)) * df


def wobble_stats(track, rate):
    k = int(1.0 * rate) | 1
    slow = np.convolve(track, np.ones(k) / k, "same")
    fast = ((track - slow) / slow)[k: -k]
    f, p = signal.welch(fast, rate, nperseg=min(256, len(fast)))
    bw = np.sqrt(np.sum(f ** 2 * p) / np.sum(p))
    w2 = int(2.0 * rate)
    rolling = [fast[i: i + w2].std() for i in range(0, len(fast) - w2, int(rate / 4))]
    return fast.std() * 100, bw, min(rolling) * 100, slow[k: -k]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--wav", default=str(ROOT / "data" / "user" / "fpv_dam_001.wav"))
    ap.add_argument("--cuts", default="8.3,14.8,21.2", help="clip boundaries, s")
    args = ap.parse_args()
    fs, x = wavfile.read(args.wav)
    x = x.astype(np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    edges = [0.0, *map(float, args.cuts.split(",")), len(x) / fs]

    print(f"{Path(args.wav).name}: {len(x) / fs:.1f} s at {fs} Hz, {len(edges) - 1} clips\n")
    print(f"{'clip':>4} {'span s':>11} {'line Hz (range)':>18} {'fast wobble':>11} {'bandwidth':>9} "
          f"{'quietest 2 s':>12}")
    for i, (a, b) in enumerate(zip(edges[:-1], edges[1:])):
        seg = x[int((a + 0.15) * fs): int((b - 0.15) * fs)]     # skip the cut itself
        t, tr = track_line(seg, fs)
        fast, bw, quiet, slow = wobble_stats(tr, 1 / HOP_S)
        print(f"{i + 1:>4} {a:5.1f}-{b:5.1f} {np.median(tr):7.0f} ({slow.min():4.0f}-{slow.max():4.0f}) "
              f"{fast:10.2f}% {bw:7.1f} Hz {quiet:11.2f}%")
    print("\nfor comparison, GPS hover (doc 03): Matrice 300 0.55-0.66 %, Mini 3 Pro 0.95-3 %")


if __name__ == "__main__":
    main()
