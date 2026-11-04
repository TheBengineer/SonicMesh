# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""How few bits can a node send and still support TDOA (and FDOA)?

Each node band-limits its audio, decimates it, and keeps only the sign
(1 bit/sample). The gateway asks each node for a snippet whose start is
offset by the TDOA predicted from a coarse position (e.g. bearing
intersection), so the snippets hold the same emitted sound and the lag
search only spans the prior's uncertainty. The gateway runs GCC-PHAT with a search over the TDOA drift
rate (differential Doppler). The same search yields FDOA, the difference in
range rate between the two nodes, which feeds velocity estimation.

Payloads compared (per node, per window):
  raw 16k    16 kHz audio (reference; can't fit a LoRa mesh)
  1-bit 4k   100-1800 Hz, 4 kS/s sign  -> 4 kbit/s
  1-bit 2k   100-900 Hz,  2 kS/s sign  -> 2 kbit/s
  1-bit 1k   100-450 Hz,  1 kS/s sign  -> 1 kbit/s

Run:  uv run sim/experiments/tdoa_compression.py [--trials N]
"""
import argparse

import numpy as np
from scipy import signal

from tdoa_feasibility import C, FS, NODES, T_PRE, path_delay, receive, synth_source, warp

COMPRESSED = {
    "1-bit 4k": (4000, (100, 1800)),
    "1-bit 2k": (2000, (100, 900)),
    "1-bit 1k": (1000, (100, 450)),
}


def compress(x, fs_c, band):
    sos = signal.butter(6, band, btype="band", fs=FS, output="sos")
    return np.sign(signal.resample_poly(signal.sosfiltfilt(sos, x), 1, FS // fs_c))


def doppler_gcc(x1, x2, fs, band, max_lag, rhos, interp=8):
    """GCC-PHAT maximised over drift rate. Returns (tdoa at window centre, rho)."""
    n_s = len(x1)
    t = np.arange(n_s) / fs
    tc = t[n_s // 2]
    n = 2 * n_s
    x1c = np.conj(np.fft.rfft(x1, n))
    f = np.fft.rfftfreq(n, 1 / fs)
    out_band = (f < band[0]) | (f > band[1])
    max_k = int(max_lag * fs)

    def cc(rho, up):
        r = np.fft.rfft(warp(x2, t, rho, tc), n) * x1c
        r /= np.abs(r) + 1e-12
        r[out_band] = 0
        c = np.fft.irfft(r, n * up)
        m = max_k * up
        return np.concatenate((c[-m:], c[: m + 1])), m

    rho = max(rhos, key=lambda r: cc(r, 1)[0].max())
    c, m = cc(rho, interp)
    return (np.argmax(c) - m) / (fs * interp), rho


def arrival_times(node, vel, t_emit):
    """Noise-free arrival time at a node of wavefronts emitted at t_emit."""
    grid = np.arange(-T_PRE, 4.0, 1e-4)
    return np.interp(t_emit, grid - path_delay(grid, node, vel), grid)


def trial(rng, vel, t_win, snr_db, sigma_prior, sigma_v):
    """One pair of snippets. Node 2's window is offset by the TDOA predicted
    from a coarse (bearing-based) position, wrong by N(0, sigma_prior).
    With sigma_v > 0 the drift-rate search is narrowed by a cheap FDOA prior
    (the ratio of the two nodes' reported harmonic frequencies), good to
    sigma_v m/s of range-rate difference; otherwise every rate a drone could
    produce is searched."""
    t1 = np.arange(int(t_win * FS)) / FS
    t_emit = t1[len(t1) // 2] - np.interp(t1[len(t1) // 2], t1, path_delay(t1, NODES[0], vel))
    true_tdoa = arrival_times(NODES[1], vel, t_emit) - arrival_times(NODES[0], vel, t_emit)
    offset = round((true_tdoa + rng.normal(0, sigma_prior)) * FS) / FS
    t2 = t1 + offset

    t_src = np.arange(-T_PRE * FS, (t_win + 1.5) * FS) / FS
    src = synth_source(rng, len(t_src), 0.01)
    x1, _ = receive(rng, src, t_src, t1, NODES[0], vel, snr_db)
    x2, _ = receive(rng, src, t_src, t2, NODES[1], vel, snr_db)

    # truth for the wavefront reaching node 2 at its window centre, and its rate
    def tdoa_at(t2c):
        te = t2c - path_delay(np.array([t2c]), NODES[1], vel)[0]
        return t2c - arrival_times(NODES[0], vel, te)
    t2c = t2[len(t2) // 2]
    truth = tdoa_at(t2c)
    dt = 0.01
    truth_rate = (tdoa_at(t2c + dt) - tdoa_at(t2c - dt)) / (2 * dt)

    max_lag = max(4 * sigma_prior, 0.01)
    if sigma_v > 0:
        rate = truth_rate + rng.normal(0, sigma_v / C)
        lo_rate, hi_rate = rate - 4 * sigma_v / C, rate + 4 * sigma_v / C
    else:
        r = 2 * np.linalg.norm(vel) / C
        lo_rate, hi_rate = -r - 0.005, r + 0.005
    lo, hi = lo_rate / (1 - lo_rate), hi_rate / (1 - hi_rate)   # TDOA rate -> warp rate
    est = {}
    for name, (fs_c, band) in COMPRESSED.items():
        step = 0.25 / (band[1] * t_win)          # residual drift < 1/4 cycle at band top
        rhos = np.arange(lo, hi + step / 2, step)
        est[name] = doppler_gcc(compress(x1, fs_c, band), compress(x2, fs_c, band),
                                fs_c, band, max_lag, rhos)
    rho0 = est["1-bit 4k"][1]
    coarse, fine = 0.25 / (1800 * t_win), 0.25 / (3000 * t_win)
    est["raw 16k"] = doppler_gcc(x1, x2, FS, (80, 3000), max_lag,
                                 np.arange(rho0 - 2 * coarse, rho0 + 2 * coarse, fine))
    # warp rate rho relates to the TDOA rate as rate = rho / (1 + rho)
    return {k: (lag + offset - truth, (rho / (1 + rho) - truth_rate) * C)
            for k, (lag, rho) in est.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--trials", type=int, default=8)
    ap.add_argument("--seed", type=int, default=2)
    ap.add_argument("--prior-ms", type=float, default=20.0,
                    help="1-sigma error of the predicted TDOA used to align windows")
    ap.add_argument("--fdoa-prior", type=float, default=1.0,
                    help="1-sigma m/s of the cheap FDOA prior; 0 searches all drift rates")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    names = ["raw 16k", *COMPRESSED]

    print("each cell: TDOA median |err| ms, share within 5 ms, FDOA median |range-rate diff err| m/s")
    print(f"{args.trials} trials per row, nodes 300 m apart, rotor jitter 1%, "
          f"windows aligned by a prior good to {args.prior_ms:.0f} ms, "
          f"FDOA prior {args.fdoa_prior or 'off'} m/s\n")
    print(f"{'speed':>6} {'win s':>5} {'SNR':>4} | " + " | ".join(f"{n:^22}" for n in names))
    for speed, dirn in ((0, (0.8, 0.6, 0)), (10, (0.8, 0.6, 0)), (50, (0.8, 0.6, 0))):
        vel = speed * np.array(dirn)
        for t_win in ((2.0, 1.0) if speed < 50 else (1.0, 0.5)):
            for snr in (10, 0, -5, -10):
                res = [trial(rng, vel, t_win, snr, args.prior_ms / 1e3, args.fdoa_prior) for _ in range(args.trials)]
                cells = []
                for n in names:
                    e_t = np.abs([r[n][0] for r in res]) * 1e3
                    e_v = np.abs([r[n][1] for r in res])
                    cells.append(f"{np.median(e_t):6.1f} {np.mean(e_t < 5) * 100:4.0f}% {np.median(e_v):6.2f}")
                print(f"{speed:>6} {t_win:>5} {snr:>4} | " + " | ".join(f"{c:^22}" for c in cells))


if __name__ == "__main__":
    main()
