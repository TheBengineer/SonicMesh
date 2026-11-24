"""Measurement on synthetic captures: sweep response through a known FIR (with rate offset and noise),
the level ladder through a soft clipper, and room noise with an injected tone. No hardware."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import numpy as np

from smtool import measure, response
from smtool.measure import RATE, sample_at

FULL_SCALE = 120.0


class FakeCapture:
    def __init__(self, samples, rate_hz, gaps=None):
        self.samples = np.asarray(samples)
        self.rate_hz = rate_hz
        self.gaps = gaps or []


def fake_board(y16, rate_hz, delay_s=0.0, noise=0.0, seed=3, pad_s=0.1):
    """Board samples of the played-grid signal y16 (unit scale): sample k of the board is at k/rate_hz s
    of host time, the signal is delayed by delay_s, and counts are unit * 32767 plus white noise."""
    rng = np.random.default_rng(seed)
    pad = int(round(pad_s * RATE))
    yp = np.concatenate((np.zeros(pad), y16, np.zeros(RATE)))
    n = int((len(yp) - 1 - pad) * rate_hz / RATE)
    pos = np.arange(n) * (RATE / rate_hz) + pad - delay_s * RATE
    board = sample_at(yp, pos) + noise * rng.standard_normal(n)
    return FakeCapture(np.clip(np.round(board * 32767), -32768, 32767).astype(np.int16), rate_hz)


def peaking_ir(f0, gain_db, Q, fs, n=2000):
    """RBJ peaking EQ impulse response (a resonance of gain_db at f0)."""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / fs
    alpha = math.sin(w0) / (2 * Q)
    b = np.array([1 + alpha * A, -2 * math.cos(w0), 1 - alpha * A]) / (1 + alpha / A)
    a = np.array([1, -2 * math.cos(w0), 1 - alpha / A]) / (1 + alpha / A)
    x = np.zeros(n)
    x[0] = 1.0
    y = np.zeros(n)
    for i in range(n):
        y[i] = b[0] * x[i] + (b[1] * x[i - 1] if i >= 1 else 0) + (b[2] * x[i - 2] if i >= 2 else 0) \
            - (a[1] * y[i - 1] if i >= 1 else 0) - (a[2] * y[i - 2] if i >= 2 else 0)
    return y


def lowpass_fir(fc, fs, taps=255):
    n = np.arange(taps) - (taps - 1) / 2
    return np.sinc(2 * fc / fs * n) * np.hamming(taps) * (2 * fc / fs)


def truth_band_db(h, fs=RATE, nfft=65536):
    spec = np.abs(np.fft.rfft(h, nfft)) ** 2
    f = np.fft.rfftfreq(nfft, 1.0 / fs)
    means = {}
    for fc, lo, hi in response.measurement_bands(fs):
        m = (f >= lo) & (f < hi)
        means[fc] = float(np.mean(spec[m]))
    return {fc: 10 * math.log10(p / means[1000.0]) for fc, p in means.items()}


def counts_from_pa(pa):
    return np.round(np.asarray(pa) * 32768 / measure.audio.pa_factor(FULL_SCALE)).astype(np.int16)


class SignalTests(unittest.TestCase):
    def test_sweep_has_lead_tail_and_level(self):
        played, meta = measure.make_sweep(-12.0)
        self.assertEqual(len(played), int(round((1 + 10 + 1) * RATE)))
        self.assertAlmostEqual(float(np.max(np.abs(played))), 10 ** (-12 / 20), places=3)
        self.assertTrue(np.all(played[:RATE] == 0))
        self.assertEqual(meta["n_sweep"], 10 * RATE)

    def test_ladder_steps_and_levels(self):
        played, meta = measure.make_ladder()
        self.assertEqual(meta["levels"], list(range(-60, 1, 6)))
        n_step = RATE
        start = int(0.5 * RATE) + 10 * n_step
        self.assertAlmostEqual(float(np.max(np.abs(played[start:start + n_step]))), 1.0, places=3)
        self.assertAlmostEqual(float(np.max(np.abs(played[int(0.5 * RATE):int(0.5 * RATE) + n_step]))),
                               10 ** (-60 / 20), places=6)

    def test_sample_at_is_accurate_in_band(self):
        t = np.arange(4000)
        x = np.sin(2 * np.pi * 5000 * t / RATE)
        pos = np.arange(1000, 2000) * 1.00003 + 0.37
        want = np.sin(2 * np.pi * 5000 * pos / RATE)
        self.assertLess(float(np.max(np.abs(sample_at(x, pos) - want))), 2e-3)


class ResponseTests(unittest.TestCase):
    def test_sweep_response_matches_fir_within_1db_with_rate_offset(self):
        played, meta = measure.make_sweep(-12.0)
        h = np.convolve(lowpass_fir(6000, RATE), peaking_ir(2000, 6.0, 2.0, RATE))
        y16 = response.fir_filter(played, h)
        rate = RATE * (1 - 30e-6)
        cap = fake_board(y16, rate, delay_s=0.0373, noise=1e-4)
        res = measure.analyse_response([cap], meta)
        truth = truth_band_db(h)
        errs = []
        for b in res["bands"]:
            if 100 <= b["fc"] <= 5000:
                errs.append(abs(b["db"] - truth[b["fc"]]))
        self.assertTrue(errs)
        self.assertLess(max(errs), 1.0, msg=f"max error {max(errs):.3f} dB")
        mid = [b for b in res["bands"] if b["fc"] == 6300.0][0]
        print(f"\n  response: max |error| 100 Hz - 5 kHz {max(errs):.3f} dB; "
              f"6.3 kHz band {mid['db']:.2f} vs truth {truth[6300.0]:.2f} dB")
        self.assertLess(abs(res["rate_ppm"] + 30), 1.0)
        self.assertAlmostEqual(res["latency_ms"], 37.3 + 1000 * int(np.argmax(np.abs(h))) / RATE, delta=1.0)
        self.assertEqual(res["gap_samples"], 0)

    def test_ladder_linear_range_and_clip_point_through_soft_clipper(self):
        T = 0.5

        def clipper(x):
            return T * np.tanh(x / T)

        def describing_gain_db(A):
            theta = np.linspace(0, 2 * np.pi, 4096, endpoint=False)
            fund = 2 * np.mean(clipper(A * np.sin(theta)) * np.sin(theta))
            return 20 * math.log10(fund / A)

        played, meta = measure.make_ladder()
        y16 = clipper(played)
        cap = fake_board(y16, RATE * (1 - 30e-6), delay_s=0.03, noise=3e-5)
        res = measure.analyse_levels(cap, meta, FULL_SCALE)
        expected = None
        for level in meta["levels"]:
            if describing_gain_db(10 ** (level / 20)) < -1.0:
                expected = level
                break
        self.assertIsNotNone(expected)
        self.assertEqual(res["clip_onset_dbfs"], expected)
        self.assertLess(res["linear_top_dbfs"], expected)
        self.assertAlmostEqual(res["fit"]["slope"], 1.0, delta=0.02)
        self.assertAlmostEqual(res["fit"]["spl_at_0dbfs"], FULL_SCALE, delta=0.3)
        self.assertLess(res["noise_floor_spl_db"], FULL_SCALE - 60)
        self.assertAlmostEqual(res["ladder_shift_ms"], 30.0, delta=10.0)
        print(f"\n  levels: clip onset {res['clip_onset_dbfs']} dBFS (expected {expected}); "
              f"linear range {res['linear_range_db']} dB; slope {res['fit']['slope']}")

    def test_ladder_clean_has_no_clip(self):
        played, meta = measure.make_ladder()
        cap = fake_board(played * 0.5, RATE, noise=1e-5)
        res = measure.analyse_levels(cap, meta, FULL_SCALE)
        self.assertIsNone(res["clip_onset_dbfs"])
        self.assertEqual(res["linear_top_dbfs"], 0)

    def test_noise_finds_injected_1100hz_tone(self):
        rng = np.random.default_rng(5)
        n = 10 * RATE
        t = np.arange(n) / RATE
        pa = 0.026 * rng.standard_normal(n) + 0.26 * np.sin(2 * np.pi * 1100 * t)
        cap = FakeCapture(counts_from_pa(pa), RATE)
        res = measure.analyse_noise(cap, FULL_SCALE)
        self.assertTrue(res["tones"], "no tone found")
        top = res["tones"][0]
        print(f"\n  noise: tone {top['hz']} Hz {top['spl_db']} dB SPL, +{top['excess_db']} dB, "
              f"stationary {top['stationary_frac']}; overall {res['overall_spl_db']} dB SPL")
        self.assertAlmostEqual(top["hz"], 1100.0, delta=2.0)
        self.assertGreater(top["excess_db"], 10.0)
        self.assertEqual(top["stationary_frac"], 1.0)
        self.assertAlmostEqual(top["spl_db"], 79.2, delta=0.5)

    def test_add_parser_registers_three_commands(self):
        import argparse
        parser = argparse.ArgumentParser()
        sub = parser.add_subparsers(dest="cmd")
        measure.add_parser(sub)
        args = parser.parse_args(["measure", "noise", "--port", "/dev/x", "--seconds", "5"])
        self.assertIs(args.func, measure.cmd_noise)
        self.assertEqual(args.seconds, 5.0)
        args = parser.parse_args(["measure", "response", "--port", "/dev/x"])
        self.assertEqual(args.level_dbfs, -12.0)
        self.assertEqual(args.repeat, 2)
        self.assertIs(args.func, measure.cmd_response)


if __name__ == "__main__":
    unittest.main()
