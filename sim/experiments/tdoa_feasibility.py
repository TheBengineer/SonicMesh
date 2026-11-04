# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""TDOA feasibility for continuous drone sound between widely spaced nodes.

Question: drone noise has no crisp onset, so can two time-synced nodes a few
hundred metres apart still measure the time difference of arrival?

Synthesises a quadcopter (4 rotors with harmonics, rotor-speed jitter from the
flight controller, blade-modulated broadband noise), propagates it to two nodes
(moving-source delay, air absorption, turbulence travel-time jitter,
independent pink background noise), then compares three delay estimators:

  gcc       GCC-PHAT on raw audio. Needs both raw streams in one place.
  gcc+dop   GCC-PHAT after undoing the TDOA drift (differential Doppler) of a
            moving drone, with the drift rate seeded by the spectrogram method.
  spectro   Correlation of each node's high-passed log spectrogram, searched
            jointly over lag and drift rate. Works on per-node features
            (~50 frames/s), which compress far better than raw audio.

An earlier version tracked a single blade-pass "f0" per node and correlated
those tracks. It failed: with four rotors at slightly different speeds the f0
estimate hops between rotors, and that noise swamps the speed jitter it needs.

Run:  uv run sim/experiments/tdoa_feasibility.py [--trials N] [--seed S]
"""
import argparse

import numpy as np
from scipy import signal

FS = 16_000
C = 343.0
T_WIN = 4.0          # analysis window at the receivers, s
T_PRE = 2.0          # source history before the window (covers max delay)
SIGMA_TURB = 0.2e-3  # per-path turbulence travel-time jitter, s (~300 m path)
BASE_BPF = 180.0     # blade-pass frequency, Hz (2 blades @ 5400 rpm)
N_HARM = 10

NODES = np.array([[0.0, 0.0, 1.5], [300.0, 0.0, 1.5]])
DRONE_P0 = np.array([100.0, 120.0, 60.0])

# ISO 9613-1 absorption, roughly 20 C / 70 % RH, dB/km
_ABS_F = np.array([0, 125, 250, 500, 1000, 2000, 4000, 8000])
_ABS_DB_KM = np.array([0, 0.4, 1.0, 1.9, 3.7, 9.7, 32.8, 117.0])


def lowpass_noise(rng, n, cutoff, std):
    sos = signal.butter(2, cutoff, fs=FS, output="sos")
    x = signal.sosfiltfilt(sos, rng.standard_normal(n))
    return x / x.std() * std


def pink_noise(rng, n):
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / FS)
    spec[1:] /= np.sqrt(f[1:])
    spec[0] = 0
    return np.fft.irfft(spec, n)


def band_power(x, lo=100, hi=2000):
    spec = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / FS)
    return spec[(f >= lo) & (f <= hi)].sum()


def synth_source(rng, n, jitter):
    """Per-rotor blade-pass phase (cycles) and broadband noise, sampled at FS."""
    bpf = BASE_BPF * (1 + 0.03 * rng.standard_normal(4))
    common = lowpass_noise(rng, n, 0.3, jitter)          # slow thrust changes
    phases = np.array([
        np.cumsum(bpf[i] * (1 + common + lowpass_noise(rng, n, 6.0, jitter))) / FS
        for i in range(4)                                 # + attitude control
    ])
    sos = signal.butter(4, [150, 3000], btype="band", fs=FS, output="sos")
    broadband = signal.sosfilt(sos, rng.standard_normal(n))
    harm_amp = 1.0 / np.arange(1, N_HARM + 1) ** 0.7
    harm_phase = rng.uniform(0, 2 * np.pi, (4, N_HARM))
    return phases, broadband, harm_amp, harm_phase


def path_delay(t, node, velocity):
    """Retarded-time delay from a constant-velocity drone to a node."""
    tau = np.linalg.norm(DRONE_P0 + np.outer(t, velocity) - node, axis=1) / C
    for _ in range(3):
        tau = np.linalg.norm(DRONE_P0 + np.outer(t - tau, velocity) - node, axis=1) / C
    return tau


def receive(rng, src, t_src, t, node, velocity, snr_db):
    """src is synth_source() output, or a callable giving a recorded waveform at emission times."""
    tau = path_delay(t, node, velocity) + lowpass_noise(rng, len(t), 1.0, SIGMA_TURB)
    te = t - tau
    if callable(src):
        x = src(te)
    else:
        x = _synth_at(src, t_src, te)

    # air absorption for the mean path length
    r = tau.mean() * C
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / FS)
    spec *= 10 ** (-np.interp(f, _ABS_F, _ABS_DB_KM) * r / 1000 / 20)
    x = np.fft.irfft(spec, len(x))

    noise = pink_noise(rng, len(x))
    noise *= np.sqrt(band_power(x) / band_power(noise) / 10 ** (snr_db / 10))
    return x + noise, tau


def _synth_at(src, t_src, te):
    phases, broadband, harm_amp, harm_phase = src
    x = np.zeros_like(te)
    blade_mod = np.zeros_like(te)
    for i in range(4):
        ph = 2 * np.pi * np.interp(te, t_src, phases[i])
        blade_mod += np.sin(ph)
        for h in range(N_HARM):
            x += harm_amp[h] * np.sin((h + 1) * ph + harm_phase[i, h])
    bb = np.interp(te, t_src, broadband)
    return x + 0.5 * bb / bb.std() * (1 + 0.25 * blade_mod)


def gcc_phat(x1, x2, max_lag, interp=8):
    n = len(x1) + len(x2)
    r = np.fft.rfft(x2, n) * np.conj(np.fft.rfft(x1, n))
    r /= np.abs(r) + 1e-12
    f = np.fft.rfftfreq(n, 1 / FS)
    r[(f < 80) | (f > 3000)] = 0
    cc = np.fft.irfft(r, n * interp)
    m = int(max_lag * FS * interp)
    cc = np.concatenate((cc[-m:], cc[: m + 1]))
    return (np.argmax(cc) - m) / (FS * interp)


def warp(x, t, rho, tc):
    """Undo a linear TDOA drift: resample x at tc + (t - tc)(1 + rho)."""
    return np.interp(tc + (t - tc) * (1 + rho), t, x)


def gcc_doppler(x1, x2, t, max_lag, rho0, span=3e-3, step=1e-4):
    """GCC-PHAT with a fine time-scale search around zero and a coarse drift rate."""
    tc = t[len(t) // 2]
    rhos = np.concatenate([np.arange(c - span, c + span + step / 2, step) for c in (0.0, rho0)])
    best = max(rhos, key=lambda r: _gcc_peak(x1, warp(x2, t, r, tc), max_lag))
    return gcc_phat(x1, warp(x2, t, best, tc), max_lag)


def _gcc_peak(x1, x2, max_lag):
    n = len(x1) + len(x2)
    r = np.fft.rfft(x2, n) * np.conj(np.fft.rfft(x1, n))
    r /= np.abs(r) + 1e-12
    f = np.fft.rfftfreq(n, 1 / FS)
    r[(f < 80) | (f > 3000)] = 0
    cc = np.fft.irfft(r, n)
    m = int(max_lag * FS)
    return max(cc[: m + 1].max(), cc[-m:].max())


def spectro_features(x, hop, nfft=2048, fmin=100, fmax=1500):
    """Per-node feature: temporally high-passed log spectrogram of the drone band."""
    f, _, z = signal.stft(x, FS, nperseg=nfft, noverlap=nfft - hop,
                          boundary=None, padded=False)
    band = (f >= fmin) & (f <= fmax)
    s = np.log(np.abs(z[band]) ** 2 + 1e-12)
    k = int(FS / hop) | 1                              # ~1 s moving average
    s -= np.apply_along_axis(lambda r: np.convolve(r, np.ones(k) / k, "same"), 1, s)
    s = s[:, k // 2: -(k // 2)]
    return f[band], s / (s.std(axis=1, keepdims=True) + 1e-12)


def spectro_tdoa(x1, x2, hop, max_lag, rho_max=0.07, rho_step=2.5e-3):
    """Joint search over lag and drift rate on spectrogram features.

    A drift rate rho both stretches node 2's time axis and shifts its
    frequencies (differential Doppler), so each candidate warps both axes.
    Returns (tdoa at window centre, rho).
    """
    f, a = spectro_features(x1, hop)
    _, b = spectro_features(x2, hop)
    n_t = a.shape[1]
    frames = np.arange(n_t)
    tc = n_t / 2
    n = 2 * n_t
    fa = np.conj(np.fft.rfft(a, n, axis=1))
    max_k = int(max_lag * FS / hop)
    best = (-np.inf, 0.0, 0.0)
    for rho in np.arange(-rho_max, rho_max + rho_step / 2, rho_step):
        bw = np.array([np.interp(f / (1 + rho), f, row) for row in b.T]).T
        bw = np.array([np.interp(tc + (frames - tc) * (1 + rho), frames, row) for row in bw])
        cc = np.fft.irfft((np.fft.rfft(bw, n, axis=1) * fa).sum(axis=0), n)
        cc = np.concatenate((cc[-max_k:], cc[: max_k + 1]))
        i = int(np.argmax(cc))
        if cc[i] > best[0]:
            d = 0.0
            if 0 < i < len(cc) - 1:
                y0, y1, y2 = cc[i - 1: i + 2]
                den = y0 - 2 * y1 + y2
                d = 0.5 * (y0 - y2) / den if den else 0.0
            best = (cc[i], (i - max_k + d) * hop / FS, rho)
    return best[1], best[2]


def trial(rng, velocity, jitter, snr_db, hop):
    t_src = np.arange(-T_PRE * FS, T_WIN * FS) / FS
    t = np.arange(int(T_WIN * FS)) / FS
    src = synth_source(rng, len(t_src), jitter)
    x1, tau1 = receive(rng, src, t_src, t, NODES[0], velocity, snr_db)
    x2, tau2 = receive(rng, src, t_src, t, NODES[1], velocity, snr_db)
    # TDOA of one emitted wavefront: the one reaching node 2 at window centre
    tc = t[len(t) // 2]
    t_emit = tc - tau2[len(t) // 2]
    truth = tc - np.interp(t_emit, t - tau1, t)
    max_lag = np.linalg.norm(NODES[1] - NODES[0]) / C
    est_gcc = gcc_phat(x1, x2, max_lag)
    est_spec, rho = spectro_tdoa(x1, x2, hop, max_lag)
    est_dop = gcc_doppler(x1, x2, t, max_lag, rho)
    return est_gcc - truth, est_dop - truth, est_spec - truth


def summarise(errs):
    e = np.abs(np.asarray(errs)) * 1e3
    return f"{np.median(e):7.1f} {np.mean(e < 5) * 100:5.0f}% {np.mean(e < 20) * 100:5.0f}%"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--trials", type=int, default=12)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--hop", type=int, default=320, help="feature frame hop, samples")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    print(f"nodes 300 m apart, drone ~160 m / ~250 m away, {T_WIN:.0f} s window, "
          f"feature frame rate {FS / args.hop:.0f}/s, {args.trials} trials per row")
    print("error columns: median |err| ms, share within 5 ms, share within 20 ms\n")
    print(f"{'':>22} | {'raw audio':^43} | {'features':^20}")
    print(f"{'motion':>8} {'jitter':>6} {'SNR dB':>6} | {'gcc-phat':>20} | {'gcc-phat + doppler':>20} | {'spectrogram':>20}")
    for name, vel in (("hover", np.zeros(3)), ("10 m/s", np.array([8.0, 6.0, 0.0]))):
        for jitter in (0.005, 0.02):
            for snr in (10, 0, -5, -10, -15):
                errs = [trial(rng, vel, jitter, snr, args.hop) for _ in range(args.trials)]
                g, d, sp = zip(*errs)
                print(f"{name:>8} {jitter * 100:5.1f}% {snr:6d} | {summarise(g):>20} | "
                      f"{summarise(d):>20} | {summarise(sp):>20}")


if __name__ == "__main__":
    main()
