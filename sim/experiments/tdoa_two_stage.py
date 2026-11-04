# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Two-stage TDOA/FDOA: cheap feature match for the shifts, then a narrow fine search.

Coarse stage, no bearings needed. Over a 2 s window, each node finds its
12 strongest spectral lines in 500-2000 Hz (individual rotor harmonics,
which separate at higher harmonics) and tracks each frame by frame, following
Doppler drift. Then:
  1. Every node announces its 12 line frequencies at the window centre
     (192 bits).
  2. The gateway registers two nodes' line sets by a common frequency ratio,
     like keypoint matching under scale. The ratio is the Doppler,
     f2/f1 = 1 - dTDOA/dt.
  3. Each node sends wobble tracks (25 frames/s, 5 bits) for up to 4 matched
     lines.
  4. The gateway undoes the time stretch and correlates the matched wobbles
     to get a coarse TDOA. A few scale hypotheses are tried and the best
     correlation wins, like RANSAC verification.

Fine stage. The gateway requests 1-bit 4 kS/s audio windows aligned by the
coarse TDOA and runs GCC-PHAT over a narrow lag and drift-rate range.

Alternative coarse stage. 1-bit audio at 1 kS/s (100-450 Hz) over the same
window, with a full lag and drift-rate search. Too blurry for precise
timing, but robust to noise.

Baseline. The same fine stage aligned by a bearing prior (20 ms, 1 m/s),
as in tdoa_compression.py.

Run:  uv run sim/experiments/tdoa_two_stage.py [--trials N]
"""
import argparse

import numpy as np
from scipy import signal

from tdoa_compression import COMPRESSED, arrival_times, compress, doppler_gcc
from tdoa_feasibility import C, FS, NODES, T_PRE, path_delay, receive, synth_source

FEAT_WIN = 2.0          # coarse feature window, s (must exceed the max TDOA)
NFFT, HOP = 2048, 640   # 128 ms frames at 25 frames/s
N_CAND = 12             # line frequencies every node announces
N_LINES = 4             # matched lines whose wobble tracks are then requested
BITS_PER_SAMPLE = 5
DEV_STEP = 0.002        # log-frequency quantisation step (0.2 %)
LINE_BAND = (500, 2000)


def line_features(x):
    """Strongest lines at the window centre, each tracked frame by frame.

    Returns (centre frequencies, log-frequency tracks with each track's own
    quadratic drift removed and the wobble quantised).
    """
    f, _, z = signal.stft(x, FS, nperseg=NFFT, noverlap=NFFT - HOP, boundary=None, padded=False)
    logm = np.log(np.abs(z) + 1e-9)
    n = logm.shape[1]
    c = n // 2
    lo, hi = np.searchsorted(f, LINE_BAND)
    centre_spec = logm[lo:hi, c - 3: c + 4].mean(axis=1)
    peaks, _ = signal.find_peaks(centre_spec, distance=3)
    peaks = peaks[np.argsort(centre_spec[peaks])[::-1][:N_CAND]] + lo
    df = f[1]
    frames = np.arange(n)
    centres, tracks = [], []
    for b0 in peaks:
        bins = np.zeros(n, int)
        bins[c] = b0
        for step in (1, -1):                    # follow the line out from the centre
            j = c + step
            while 0 <= j < n:
                prev = bins[j - step]
                bins[j] = prev - 1 + np.argmax(logm[prev - 1: prev + 2, j])
                j += step
        y0, y1, y2 = logm[bins - 1, frames], logm[bins, frames], logm[bins + 1, frames]
        den = np.where(y0 - 2 * y1 + y2 == 0, -1e-9, y0 - 2 * y1 + y2)
        lf = np.log((bins + np.clip(0.5 * (y0 - y2) / den, -0.5, 0.5)) * df)
        trend = np.polyval(np.polyfit(frames, lf, 2), frames)
        centres.append(np.exp(trend[c]))
        q_max = 2 ** (BITS_PER_SAMPLE - 1) - 1
        tracks.append(np.clip(np.round((lf - trend) / DEV_STEP), -q_max, q_max) * DEV_STEP)
    return np.array(centres), np.array(tracks)


def feature_bits(n_frames):
    return N_CAND * 16 + N_LINES * n_frames * BITS_PER_SAMPLE


def scale_hypotheses(fa, fb, s_lo, s_hi, tol=0.006, keep=5):
    """Candidate f2/f1 ratios that register many lines, best first."""
    hyps = []
    for i in range(len(fa)):
        for j in range(len(fb)):
            s = fb[j] / fa[i]
            if not s_lo <= s <= s_hi:
                continue
            d = np.abs(np.log(fb[None, :] / (fa[:, None] * s)))
            pairs = [(a, int(np.argmin(d[a]))) for a in range(len(fa)) if d[a].min() < tol]
            if len({p[1] for p in pairs}) < len(pairs) or len(pairs) < 2:
                continue
            s_fit = np.exp(np.mean([np.log(fb[b] / fa[a]) for a, b in pairs]))
            hyps.append((len(pairs), -np.mean(d[[a for a, _ in pairs], [b for _, b in pairs]]), s_fit, pairs))
    hyps.sort(key=lambda h: (h[0], h[1]), reverse=True)
    out = []
    for h in hyps:
        if all(abs(np.log(h[2] / o[0])) > tol / 2 for o in out):
            out.append((h[2], h[3][:N_LINES]))
        if len(out) == keep:
            break
    return out


def coarse_match(feat1, feat2, max_lag, s_lo, s_hi):
    """Returns (tdoa for the wavefront at node 2's window centre, TDOA rate)."""
    (fa, ta), (fb, tb) = feat1, feat2
    n = ta.shape[1]
    frames = np.arange(n)
    tc = n / 2
    max_k = int(max_lag * FS / HOP)

    def detrend(v):
        v = v - v.mean()
        return v / (v.std() + 1e-12)

    best = (-np.inf, 0.0, 0.0)
    for s, pairs in scale_hypotheses(fa, fb, s_lo, s_hi):
        rate = 1 - s
        rho = rate / (1 - rate)
        total = np.zeros(2 * n - 1)
        for a, b in pairs:
            bw = np.interp(tc + (frames - tc) * (1 + rho), frames, tb[b])
            total += signal.correlate(detrend(bw), detrend(ta[a]), mode="full")
        lags = signal.correlation_lags(n, n, mode="full")
        keep = np.abs(lags) <= max_k
        cc, lg = total[keep] / len(pairs), lags[keep]
        i = int(np.argmax(cc))
        if cc[i] > best[0]:
            d = 0.0
            if 0 < i < len(cc) - 1:
                y0, y1, y2 = cc[i - 1: i + 2]
                den = y0 - 2 * y1 + y2
                d = 0.5 * (y0 - y2) / den if den else 0.0
            best = (cc[i], (lg[i] + d) * HOP / FS, rate)
    return best[1], best[2]


def fine_match(x1_all, x2_all, t_all, t2c, tdoa_guess, rate_guess, win, lag_tol, rate_tol):
    """1-bit 4k GCC on windows aligned by a guessed TDOA; returns (tdoa, rate)."""
    fs_c, band = COMPRESSED["1-bit 4k"]
    n = int(win * FS)
    i2 = int(round((t2c - t_all[0]) * FS)) - n // 2
    shift = int(round(tdoa_guess * FS))
    x1, x2 = x1_all[i2 - shift: i2 - shift + n], x2_all[i2: i2 + n]
    step = 0.25 / (band[1] * win)
    lo, hi = rate_guess - rate_tol, rate_guess + rate_tol
    rhos = np.arange(lo / (1 - lo), hi / (1 - hi) + step / 2, step)
    lag, rho = doppler_gcc(compress(x1, fs_c, band), compress(x2, fs_c, band),
                           fs_c, band, lag_tol, rhos)
    return lag + shift / FS, rho / (1 + rho)


def trial(rng, vel, snr_db, fine_win, make_source=synth_source):
    t_all = np.arange(int(-1.0 * FS), int((FEAT_WIN + 1.0) * FS)) / FS
    t_src = np.arange(int(-(T_PRE + 1.0) * FS), int((FEAT_WIN + 1.0) * FS)) / FS
    src = make_source(rng, len(t_src), 0.01)
    x1, _ = receive(rng, src, t_src, t_all, NODES[0], vel, snr_db)
    x2, _ = receive(rng, src, t_src, t_all, NODES[1], vel, snr_db)

    i0 = int(round(-t_all[0] * FS))
    feat_n = int(FEAT_WIN * FS)
    f1 = line_features(x1[i0: i0 + feat_n])
    f2 = line_features(x2[i0: i0 + feat_n])
    n_frames = f1[1].shape[1]
    t2c = (n_frames / 2) * HOP / FS + NFFT / 2 / FS      # node-2 time of the coarse reference

    def tdoa_at(t2):
        te = t2 - path_delay(np.array([t2]), NODES[1], vel)[0]
        return t2 - arrival_times(NODES[0], vel, te)
    truth = tdoa_at(t2c)
    truth_rate = (tdoa_at(t2c + 0.01) - tdoa_at(t2c - 0.01)) / 0.02

    max_lag = np.linalg.norm(NODES[1] - NODES[0]) / C
    r = 2 * np.linalg.norm(vel) / C + 0.01
    c_tdoa, c_rate = coarse_match(f1, f2, max_lag, 1 - r, 1 + r)
    ft, fr = fine_match(x1, x2, t_all, t2c, c_tdoa, c_rate, fine_win,
                        lag_tol=0.015, rate_tol=8.0 / C)

    # coarse alternative: 1-bit 1 kS/s audio over the same window, full search
    fs_c, band = COMPRESSED["1-bit 1k"]
    t2c_a = FEAT_WIN / 2
    truth_a = tdoa_at(t2c_a)
    truth_rate_a = (tdoa_at(t2c_a + 0.01) - tdoa_at(t2c_a - 0.01)) / 0.02
    step = 0.25 / (band[1] * FEAT_WIN)
    rhos = np.arange(-r / (1 + r), r / (1 - r) + step / 2, step)
    a_lag, a_rho = doppler_gcc(compress(x1[i0: i0 + feat_n], fs_c, band),
                               compress(x2[i0: i0 + feat_n], fs_c, band),
                               fs_c, band, max_lag, rhos)
    a_rate = a_rho / (1 + a_rho)
    at, ar = fine_match(x1, x2, t_all, t2c_a, a_lag, a_rate, fine_win,
                        lag_tol=0.015, rate_tol=8.0 / C)

    bt, br = fine_match(x1, x2, t_all, t2c, truth + rng.normal(0, 0.02),
                        truth_rate + rng.normal(0, 1.0 / C), fine_win,
                        lag_tol=0.08, rate_tol=4.0 / C)
    return {
        "lines": (c_tdoa - truth, (c_rate - truth_rate) * C),
        "lines -> fine": (ft - truth, (fr - truth_rate) * C),
        "1-bit 1k": (a_lag - truth_a, (a_rate - truth_rate_a) * C),
        "1-bit 1k -> fine": (at - truth_a, (ar - truth_rate_a) * C),
        "bearing -> fine": (bt - truth, (br - truth_rate) * C),
    }, feature_bits(n_frames)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--trials", type=int, default=10)
    ap.add_argument("--seed", type=int, default=3)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    names = ["lines", "lines -> fine", "1-bit 1k", "1-bit 1k -> fine", "bearing -> fine"]

    bits = None
    rows = []
    for speed in (0, 10, 50):
        vel = speed * np.array([0.8, 0.6, 0.0])
        fine_win = 1.0 if speed < 50 else 0.5
        for snr in (10, 0, -5):
            res = []
            for _ in range(args.trials):
                r, bits = trial(rng, vel, snr, fine_win)
                res.append(r)
            rows.append((speed, fine_win, snr, res))

    fine_bits = int(COMPRESSED["1-bit 4k"][0])
    print(f"coarse 'lines': {bits} bits per node per {FEAT_WIN:.0f} s window; "
          f"coarse '1-bit 1k': {int(FEAT_WIN * 1000)} bits (neither needs a bearing)")
    print(f"fine stage: 1-bit 4k audio, {fine_bits} bit/s x fine window\n")
    print("each cell: TDOA median |err| ms, share within 5 ms, FDOA median |err| m/s")
    print(f"{args.trials} trials per row, nodes 300 m apart, rotor jitter 1%\n")
    print(f"{'speed':>5} {'fine s':>6} {'SNR':>4} | " + " | ".join(f"{n:^22}" for n in names))
    for speed, fine_win, snr, res in rows:
        cells = []
        for n in names:
            e_t = np.abs([r[n][0] for r in res]) * 1e3
            e_v = np.abs([r[n][1] for r in res])
            cells.append(f"{np.median(e_t):6.1f} {np.mean(e_t < 5) * 100:4.0f}% {np.median(e_v):6.2f}")
        print(f"{speed:>5} {fine_win:>6} {snr:>4} | " + " | ".join(f"{c:^22}" for c in cells))
        if snr == -5:
            print()


if __name__ == "__main__":
    main()
