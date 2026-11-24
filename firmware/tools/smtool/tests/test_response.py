"""Profiles applied to audio: the response filter, the noise synthesis, and the profile file format."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

from smtool import measure, response
from smtool.measure import RATE

from test_measure import FakeCapture, counts_from_pa, fake_board, FULL_SCALE, lowpass_fir, peaking_ir


def band_levels_db(x, fs=RATE, relative=True):
    """Band-mean power of x in the measurement bands, dB (relative to 1 kHz if asked)."""
    x = np.asarray(x, float)
    nfft = 1 << int(np.ceil(np.log2(len(x))))
    spec = np.abs(np.fft.rfft(x, nfft)) ** 2
    f = np.fft.rfftfreq(nfft, 1.0 / fs)
    out = {}
    for fc, lo, hi in response.measurement_bands(fs):
        m = (f >= lo) & (f < hi)
        out[fc] = float(np.mean(spec[m]))
    ref = out[1000.0] if relative else 1.0
    return {fc: 10 * np.log10(p / ref) for fc, p in out.items()}


def response_profile(bands):
    return {"schema": response.SCHEMA, "kind": "response", "results": {"bands": bands}}


class ProfileFormatTests(unittest.TestCase):
    def test_band_bounds_are_contiguous_and_measurement_bands_exclude_nyquist(self):
        lo, hi = response.band_bounds(response.PREFERRED_HZ)
        np.testing.assert_allclose(lo[1:], hi[:-1])
        bands = response.measurement_bands(RATE)
        self.assertEqual(bands[0][0], 25.0)
        self.assertEqual(bands[-1][0], 6300.0)

    def test_load_profile_rejects_other_files(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "x.json")
            with open(path, "w") as fh:
                json.dump({"schema": "other"}, fh)
            with self.assertRaises(ValueError):
                response.load_profile(path)
            good = response_profile([{"fc": 1000.0, "db": 0.0, "valid": True}])
            with open(path, "w") as fh:
                json.dump(good, fh)
            self.assertEqual(response.load_profile(path)["kind"], "response")

    def test_wrong_kind_is_refused(self):
        with self.assertRaises(ValueError):
            response.apply_response(np.zeros(10), RATE, {"schema": response.SCHEMA, "kind": "noise"})
        with self.assertRaises(ValueError):
            response.noise_from_profile(response_profile([]), 1.0, RATE)

    def test_fir_filter_matches_convolution(self):
        rng = np.random.default_rng(0)
        x = rng.standard_normal(70000)
        h = rng.standard_normal(301)
        np.testing.assert_allclose(response.fir_filter(x, h), np.convolve(x, h)[:len(x)], atol=1e-9)


class ApplyResponseTests(unittest.TestCase):
    def test_flat_profile_is_near_identity(self):
        bands = [{"fc": fc, "lo_hz": lo, "hi_hz": hi, "db": 0.0, "valid": True}
                 for fc, lo, hi in response.measurement_bands(RATE)]
        h = response.response_fir(response_profile(bands), RATE)
        self.assertAlmostEqual(float(h[0]), 1.0, places=2)
        self.assertLess(float(np.max(np.abs(h[1:]))), 1e-2)

    def test_resonance_and_lowpass_are_applied(self):
        bands = []
        for fc in (250.0, 1000.0, 2000.0, 4000.0):
            db = 6.0 if fc == 2000.0 else 0.0
            bands.append({"fc": fc, "db": db, "valid": True})
        h = response.response_fir(response_profile(bands), RATE)
        spec = np.abs(np.fft.rfft(h, 65536))
        f = np.fft.rfftfreq(65536, 1 / RATE)
        at = lambda hz: 20 * np.log10(spec[np.argmin(np.abs(f - hz))] / spec[np.argmin(np.abs(f - 1000))])
        self.assertAlmostEqual(at(2000), 6.0, delta=0.5)
        self.assertAlmostEqual(at(250), 0.0, delta=0.5)

    def test_white_noise_reproduces_band_levels_within_1db(self):
        rng = np.random.default_rng(11)
        # measured bands from a sweep through a known chain (the same path measure.py takes)
        played, meta = measure.make_sweep(-12.0)
        h = np.convolve(lowpass_fir(6000, RATE), peaking_ir(2000, 6.0, 2.0, RATE))
        y16 = response.fir_filter(played, h)
        res = measure.analyse_response([fake_board(y16, RATE * (1 - 30e-6), 0.02, noise=1e-4)], meta)
        profile = response_profile(res["bands"])
        white = rng.standard_normal(10 * RATE)
        out = response.apply_response(white, RATE, profile)
        got = band_levels_db(out)
        errs = []
        for b in profile["results"]["bands"]:
            if b["valid"]:
                errs.append(abs(got[b["fc"]] - b["db"]))
        print(f"\n  apply_response: max band error on white noise {max(errs):.3f} dB over {len(errs)} bands")
        self.assertLess(max(errs), 1.0)


class NoiseTests(unittest.TestCase):
    def _coloured(self, n, rng, slope):
        X = np.fft.rfft(rng.standard_normal(n))
        f = np.fft.rfftfreq(n, 1 / RATE)
        X[1:] *= (f[1:] / f[1]) ** (-slope / 2)
        x = np.fft.irfft(X, n)
        x = x / np.sqrt(np.mean(x ** 2)) * 0.5  # high enough that int16 counts do not set the floor
        t = np.arange(n) / RATE
        return x + 0.2 * np.sin(2 * np.pi * 1100 * t)

    def test_noise_from_profile_matches_level_and_spectrum_within_1_5db(self):
        rng = np.random.default_rng(7)
        n = 20 * RATE
        cap = FakeCapture(counts_from_pa(self._coloured(n, rng, 2.0)), RATE)
        measured = measure.analyse_noise(cap, FULL_SCALE)
        profile = {"schema": response.SCHEMA, "kind": "noise", "results": measured}
        synth_pa = response.noise_from_profile(profile, 20.0, RATE, np.random.default_rng(8))
        self.assertEqual(len(synth_pa), n)
        again = measure.analyse_noise(FakeCapture(counts_from_pa(synth_pa), RATE), FULL_SCALE)
        self.assertLess(abs(again["overall_spl_db"] - measured["overall_spl_db"]), 1.5)
        worst = 0.0
        for a, b in zip(measured["bands"], again["bands"]):
            # below 50 Hz the bands hold a few Welch bins, and in one realisation measure.analyse_noise masks
            # them (a random low-frequency peak is taken for a tone), so they are not compared here
            if a["fc"] < 50:
                continue
            worst = max(worst, abs(a["spl_db"] - b["spl_db"]))
        self.assertLess(worst, 1.5, msg=f"worst band error {worst:.2f} dB")
        tone_want = [t for t in measured["tones"] if abs(t["hz"] - 1100) < 5]
        tone_got = [t for t in again["tones"] if abs(t["hz"] - 1100) < 5]
        self.assertTrue(tone_want and tone_got)
        self.assertLess(abs(tone_got[0]["spl_db"] - tone_want[0]["spl_db"]), 1.5)
        print(f"\n  noise_from_profile: overall {measured['overall_spl_db']} vs {again['overall_spl_db']} dB SPL; "
              f"worst band error {worst:.2f} dB; tone {tone_want[0]['spl_db']} vs {tone_got[0]['spl_db']} dB")


if __name__ == "__main__":
    unittest.main()
