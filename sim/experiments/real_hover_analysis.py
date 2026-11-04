# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Look at real hover recordings: harmonics, rotor-speed wobble, and TDOA between mics.

Data: DroneNoise Database (University of Salford, CC BY 4.0), Edzell 2022,
hover at 10 m over the centre of a 9-mic ground-plate line array. The mics
sit at lateral angles 0, +-15, +-30, +-45, +-60 degrees, so x = 10 tan(angle).
M1..M9 is assumed to run from -60 to +60 degrees, with M5 at the centre.

Download into data/dronenoise/ (see docs/research/03-real-hover-audio.md), then:
  uv run sim/experiments/real_hover_analysis.py [--drone M3|3p]
"""
import argparse
from pathlib import Path

import numpy as np
from scipy import optimize, signal
from scipy.io import wavfile

DATA = Path(__file__).resolve().parents[2] / "data" / "dronenoise"
C = 343.0
HEIGHT = 10.0
ANGLES = np.deg2rad(np.arange(-60, 61, 15))
MIC_X = HEIGHT * np.tan(ANGLES)


def load(drone):
    chans = []
    for m in range(1, 10):
        fs, x = wavfile.read(DATA / f"Ed_{drone}_10_H00_N_C_nw_ev1_M{m}.wav")
        chans.append(x.astype(np.float64))
    return fs, np.array(chans)


def harmonic_peaks(x, fs, n=12):
    f, p = signal.welch(x, fs, nperseg=fs)          # 1 Hz resolution
    band = (f > 40) & (f < 3000)
    lp = 10 * np.log10(p[band] + 1e-20)
    floor = signal.medfilt(lp, 51)
    peaks, _ = signal.find_peaks(lp - floor, height=6, distance=3)
    top = peaks[np.argsort((lp - floor)[peaks])[::-1][:n]]
    return sorted((f[band][i], (lp - floor)[i]) for i in top)


def line_wobble(x, fs, f_line, half_width=0.04, nfft_s=0.25, hop_s=0.02):
    """Frequency track of the strongest line within +-half_width of f_line."""
    nfft, hop = int(nfft_s * fs), int(hop_s * fs)
    f, t, z = signal.stft(x, fs, nperseg=nfft, noverlap=nfft - hop, nfft=4 * nfft)
    sel = np.flatnonzero((f > f_line * (1 - half_width)) & (f < f_line * (1 + half_width)))
    mag = np.log(np.abs(z[sel]) + 1e-12)
    k = np.clip(np.argmax(mag, axis=0), 1, len(sel) - 2)
    cols = np.arange(mag.shape[1])
    y0, y1, y2 = mag[k - 1, cols], mag[k, cols], mag[k + 1, cols]
    den = np.where(y0 - 2 * y1 + y2 == 0, -1e-9, y0 - 2 * y1 + y2)
    track = f[sel][k] + 0.5 * (y0 - y2) / den * (f[1] - f[0])
    return t, track


def gcc_phat_lag(a, b, fs, max_lag, band=(80, 3000), interp=16):
    n = len(a) + len(b)
    r = np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n))
    r /= np.abs(r) + 1e-12
    f = np.fft.rfftfreq(n, 1 / fs)
    r[(f < band[0]) | (f > band[1])] = 0
    cc = np.fft.irfft(r, n * interp)
    m = int(max_lag * fs * interp)
    cc = np.concatenate((cc[-m:], cc[: m + 1]))
    i = int(np.argmax(cc))
    return (i - m) / (fs * interp), cc[i] / (cc.std() + 1e-12)


def one_bit_4k(x, fs):
    sos = signal.butter(6, (100, 1800), btype="band", fs=fs, output="sos")
    y = signal.resample_poly(signal.sosfiltfilt(sos, x), 4000, fs)
    return np.sign(y)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--drone", default="M3", choices=["M3", "3p"])
    args = ap.parse_args()
    fs, x = load(args.drone)
    centre = x[4]
    print(f"{args.drone}: {x.shape[0]} mics, {fs} Hz, {x.shape[1] / fs:.1f} s")

    peaks = harmonic_peaks(centre, fs)
    print("\nstrongest tonal peaks under the drone (Hz, dB above local floor):")
    print("  " + ", ".join(f"{f:.0f} ({d:.0f})" for f, d in peaks))

    print("\nline wobble (centre mic, 0.25 s frames every 20 ms, 1 s trend removed):")
    for f_line, _ in sorted(peaks, key=lambda p: -p[1])[:4]:
        t, tr = line_wobble(centre, fs, f_line)
        k = int(1.0 / (t[1] - t[0])) | 1
        resid = (tr - np.convolve(tr, np.ones(k) / k, "same"))[k: -k]
        slow = np.convolve(tr, np.ones(k) / k, "same")[k: -k]
        spec_f, spec = signal.welch(resid, 1 / (t[1] - t[0]), nperseg=128)
        bw = np.sqrt(np.sum(spec_f ** 2 * spec) / np.sum(spec))
        print(f"  {f_line:7.1f} Hz: fast wobble {resid.std() / f_line * 100:5.2f}% rms "
              f"(rms bandwidth {bw:4.1f} Hz), slow drift {slow.std() / f_line * 100:5.2f}% rms")

    expected = (np.hypot(HEIGHT, MIC_X) - HEIGHT) / C
    measured = {}
    print("\nTDOA vs centre mic M5, 1 s windows (expected assumes drone exactly over M5):")
    print(f"  {'mic':>4} {'x m':>6} {'expected ms':>11} | {'raw 50k: mean ms':>16} {'std ms':>7} {'peak/rms':>9}"
          f" | {'1-bit 4k: mean ms':>17} {'std ms':>7}")
    win = fs
    n_win = x.shape[1] // win
    c4k = one_bit_4k(centre, fs)
    for m in range(9):
        if m == 4:
            continue
        lags, ratios, lags4 = [], [], []
        mk = one_bit_4k(x[m], fs)
        for w in range(n_win):
            seg = slice(w * win, (w + 1) * win)
            lag, ratio = gcc_phat_lag(centre[seg], x[m][seg], fs, 0.06)
            lags.append(lag)
            ratios.append(ratio)
            seg4 = slice(w * 4000, (w + 1) * 4000)
            lags4.append(gcc_phat_lag(c4k[seg4], mk[seg4], 4000, 0.06, band=(100, 1800))[0])
        lags, lags4 = np.array(lags) * 1e3, np.array(lags4) * 1e3
        measured[m] = lags.mean() / 1e3
        print(f"  M{m + 1:<3} {MIC_X[m]:6.1f} {expected[m] * 1e3:11.2f} | {lags.mean():16.2f} {lags.std():7.2f} "
              f"{np.median(ratios):9.1f} | {lags4.mean():17.2f} {lags4.std():7.2f}")

    def resid(p):
        x0, y0, h = p
        r = np.sqrt((MIC_X - x0) ** 2 + y0 ** 2 + h ** 2)
        return [(r[m] - r[4]) / C - measured[m] for m in measured]
    fit = optimize.least_squares(resid, [0.0, 0.5, HEIGHT])
    x0, y0, h = fit.x
    # a line array only sees the distance from the line, not how it splits into height/along-track
    print(f"\nfitted hover position: {x0:+.2f} m across, {np.hypot(y0, h):.2f} m from the array line; "
          f"TDOA residual rms {np.sqrt(np.mean(np.square(fit.fun))) * 1e3:.2f} ms "
          f"({np.sqrt(np.mean(np.square(fit.fun))) * C * 100:.0f} cm)")

    print("\nclosure check (M1->M5 + M5->M9 should equal M1->M9):")
    a = gcc_phat_lag(x[0], centre, fs, 0.06)[0] + gcc_phat_lag(centre, x[8], fs, 0.06)[0]
    b = gcc_phat_lag(x[0], x[8], fs, 0.06)[0]
    print(f"  sum {a * 1e3:.3f} ms vs direct {b * 1e3:.3f} ms (whole recording)")


if __name__ == "__main__":
    main()
