# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Two-stage TDOA test driven by a real drone recording instead of the synthetic rotor model.

By default the source waveform is the centre-mic hover recording (10 m under
the drone, DroneNoise Database). With --wav, any recording can be used
instead, e.g. onboard FPV audio; --start/--end pick a stretch of it and
--band limits it to where the drone's own lines dominate. Each trial starts
at a random point in the recording, and the sound is propagated to two nodes
300 m apart exactly as in tdoa_two_stage.py.

Whatever else is in the recording travels as if the drone emitted it:
ambient noise for the hover data (~10 m away and far below the drone), and
wind and frame noise for onboard audio. Both can make results optimistic.

Run:  uv run sim/experiments/real_source_tdoa.py [--drone M3|3p] [--trials N]
      uv run sim/experiments/real_source_tdoa.py --wav data/user/fpv_dam_001.wav \
          --start 21.5 --end 33.5 --band 300,3000
"""
import argparse

import numpy as np
from scipy import signal
from scipy.io import wavfile

import tdoa_two_stage
from real_hover_analysis import load


def recorded_source(x, fs, band=(60, 6000)):
    sos = signal.butter(4, band, btype="band", fs=fs, output="sos")
    wave = signal.sosfiltfilt(sos, x)
    t = np.arange(len(wave)) / fs

    def make_source(rng, n, jitter):
        offset = rng.uniform(4.0, t[-1] - 4.0)
        return lambda te: np.interp(te + offset, t, wave)
    return make_source


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--drone", default="M3", choices=["M3", "3p"])
    ap.add_argument("--trials", type=int, default=10)
    ap.add_argument("--seed", type=int, default=4)
    ap.add_argument("--wav", help="use this recording as the source instead")
    ap.add_argument("--start", type=float, default=0.0, help="s, with --wav")
    ap.add_argument("--end", type=float, help="s, with --wav")
    ap.add_argument("--band", default="60,6000", help="source passband, Hz")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    band = tuple(map(float, args.band.split(",")))
    if args.wav:
        fs, x = wavfile.read(args.wav)
        x = x.astype(np.float64)
        x = x.mean(axis=1) if x.ndim == 2 else x
        x = x[int(args.start * fs): int(args.end * fs) if args.end else None]
        label = f"{args.wav} {args.start:g}-{args.end or len(x) / fs:g} s"
    else:
        fs, chans = load(args.drone)
        x, label = chans[4], f"{args.drone} hover recording"
    make_source = recorded_source(x, fs, band)
    names = ["lines", "lines -> fine", "1-bit 1k", "1-bit 1k -> fine", "bearing -> fine"]

    print(f"source: {label}, {band[0]:g}-{band[1]:g} Hz; nodes 300 m apart; {args.trials} trials per row")
    print("each cell: TDOA median |err| ms, share within 5 ms, FDOA median |err| m/s\n")
    print(f"{'speed':>5} {'fine s':>6} {'SNR':>4} | " + " | ".join(f"{n:^22}" for n in names))
    for speed in (0, 10, 50):
        vel = speed * np.array([0.8, 0.6, 0.0])
        fine_win = 1.0 if speed < 50 else 0.5
        for snr in (10, 0, -5, -10):
            res = [tdoa_two_stage.trial(rng, vel, snr, fine_win, make_source)[0]
                   for _ in range(args.trials)]
            cells = []
            for n in names:
                e_t = np.abs([r[n][0] for r in res]) * 1e3
                e_v = np.abs([r[n][1] for r in res])
                cells.append(f"{np.median(e_t):6.1f} {np.mean(e_t < 5) * 100:4.0f}% {np.median(e_v):6.2f}")
            print(f"{speed:>5} {fine_win:>6} {snr:>4} | " + " | ".join(f"{c:^22}" for c in cells))
        print()


if __name__ == "__main__":
    main()
