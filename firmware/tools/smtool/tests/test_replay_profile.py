"""Replay through the measured bench chain: response filter, levels mapping, noise bed and --bench lookup.

Everything is synthetic: profiles are written into a temporary directory, and the WAV files are float32 written
here. Nothing touches data/ or a board.
"""
import json
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

from smtool import audio, replay, response
from smtool.scenario import Segment

RATE = 16000
REF = 20e-6
SCHEMA = response.SCHEMA


def band_levels_db(x, fs=RATE):
    """Band-mean power of x in the 1/3-octave measurement bands, dB relative to 1 kHz."""
    x = np.asarray(x, float)
    nfft = 1 << int(np.ceil(np.log2(len(x))))
    spec = np.abs(np.fft.rfft(x, nfft)) ** 2
    f = np.fft.rfftfreq(nfft, 1.0 / fs)
    out = {}
    for fc, lo, hi in response.measurement_bands(fs):
        m = (f >= lo) & (f < hi)
        out[fc] = float(np.mean(spec[m]))
    return {fc: 10 * np.log10(p / out[1000.0]) for fc, p in out.items()}


def write_f32_wav(path, x, rate=RATE):
    data = np.asarray(x, "<f4").tobytes()
    fmt = struct.pack("<HHIIHH", 3, 1, rate, rate * 4, 4, 32)
    with open(path, "wb") as fh:
        fh.write(b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(data)) + b"WAVE")
        fh.write(b"fmt " + struct.pack("<I", len(fmt)) + fmt)
        fh.write(b"data" + struct.pack("<I", len(data)) + data)


def dump(d, name, obj):
    path = os.path.join(d, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)
    return path


def levels_profile(spl_at_0dbfs, full_scale=120.0):
    return {"schema": SCHEMA, "kind": "levels", "full_scale_db": full_scale,
            "results": {"fit": {"slope": 1.0, "spl_at_0dbfs": spl_at_0dbfs,
                                "gain_vs_full_scale_db": spl_at_0dbfs - full_scale}}}


def noise_profile(spl_per_band, tones=()):
    bands = []
    for fc, lo, hi in response.measurement_bands(RATE):
        bands.append({"fc": fc, "lo_hz": lo, "hi_hz": hi, "spl_db": spl_per_band})
    return {"schema": SCHEMA, "kind": "noise",
            "results": {"bands": bands, "tones": [{"hz": hz, "spl_db": db} for hz, db in tones]}}


def response_profile():
    """A response with a peak at 2 kHz and a shelf below 300 Hz (dB relative to 1 kHz, not measured)."""
    bands = []
    for fc, lo, hi in response.measurement_bands(RATE):
        db = 4.0 * np.sin(np.log2(fc / 1000.0) * 1.3) if fc >= 63 else -8.0
        bands.append({"fc": fc, "lo_hz": lo, "hi_hz": hi, "db": float(db), "valid": fc >= 63})
    return {"schema": SCHEMA, "kind": "response", "results": {"bands": bands}}


def spl_of(pa):
    return 20 * np.log10(np.sqrt(np.mean(np.asarray(pa, float) ** 2)) / REF)


def pa_from_chunks(chunks):
    return np.concatenate([np.asarray(c, float) for c in chunks])


class ResponseFilterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_white_noise_through_replay_matches_profile_within_1db(self):
        rng = np.random.default_rng(21)
        path = os.path.join(self.dir, "white.wav")
        write_f32_wav(path, 0.1 * rng.standard_normal(10 * RATE))
        profile = response_profile()
        chain = replay.Chain(response=profile)
        pa = pa_from_chunks(replay.file_chunks(path, 120.0, 0.0, None, chain))
        raw = pa_from_chunks(replay.file_chunks(path, 120.0, 0.0, None, None))
        self.assertGreater(np.std(pa - raw), 0.1 * np.std(raw), "the response did not change the clip")
        # the chain filters the file; compare its band levels with the profile
        got = band_levels_db(pa)
        worst = max(abs(got[b["fc"]] - b["db"]) for b in profile["results"]["bands"] if b["valid"])
        print(f"\n  replay response filter: max band error {worst:.3f} dB")
        self.assertLess(worst, 1.0)

    def test_streamed_filter_equals_one_pass(self):
        rng = np.random.default_rng(4)
        x = rng.standard_normal(70000)
        h = response.response_fir(response_profile(), RATE)
        stream = response.FirStream(h)
        parts = [stream.process(x[i:i + k]) for i, k in ((0, 1000), (1000, 40000), (41000, 29000))]
        np.testing.assert_allclose(np.concatenate(parts), response.fir_filter(x, h), atol=1e-9)

    def test_response_is_not_applied_to_quiet_time(self):
        chain = replay.Chain(response=response_profile())
        segs = [Segment("quiet", 0, RATE, -1)]
        chunks = replay.scenario_chunks(segs, 120.0, 40.0, chain=chain, seed=3)
        plain = replay.scenario_chunks(segs, 120.0, 40.0, chain=None, seed=3)
        np.testing.assert_array_equal(pa_from_chunks(chunks), pa_from_chunks(plain))


class LevelsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def sine_chain(self, gain_db=0.0, full_scale=120.0, spl=112.86, ref=120.0):
        path = os.path.join(self.dir, "sine.wav")
        t = np.arange(2 * RATE) / RATE
        write_f32_wav(path, np.sin(2 * np.pi * 1000 * t))
        lp = dump(self.dir, "lv.json", levels_profile(spl, ref))
        chain, _ = replay.chain_from_args(levels_path=lp)
        pa = pa_from_chunks(replay.file_chunks(path, full_scale, gain_db, None, chain))
        return pa

    def test_zero_dbfs_sine_lands_at_spl_at_0dbfs(self):
        pa = self.sine_chain()
        self.assertAlmostEqual(spl_of(pa), 112.86, delta=0.2)

    def test_clip_gain_adds_in_db(self):
        pa = self.sine_chain(gain_db=-6.0)
        self.assertAlmostEqual(spl_of(pa), 112.86 - 6.0, delta=0.2)

    def test_full_scale_adds_to_the_levels_offset(self):
        # the detectors' full scale sets the counts scale as on the board: 100 dB gives 20 dB less
        pa = self.sine_chain(full_scale=100.0)
        self.assertAlmostEqual(spl_of(pa), 112.86 - 20.0, delta=0.2)

    def test_no_chain_keeps_full_scale_assumption(self):
        path = os.path.join(self.dir, "sine.wav")
        write_f32_wav(path, np.sin(2 * np.pi * 1000 * np.arange(RATE) / RATE))
        pa = pa_from_chunks(replay.file_chunks(path, 120.0, 0.0, None, None))
        self.assertAlmostEqual(spl_of(pa), 120.0, delta=0.2)

    def test_offset_is_spl_minus_profile_full_scale(self):
        lp = dump(self.dir, "lv.json", levels_profile(112.86, 120.0))
        chain, _ = replay.chain_from_args(levels_path=lp)
        self.assertAlmostEqual(chain.levels_offset_db, -7.14, places=6)


class NoiseBedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def expected_spl(self, profile):
        """Overall level of the profile: band powers (the top band held to Nyquist) plus the tones."""
        bands = profile["results"]["bands"]
        total = 0.0
        for b in bands:
            hi = b["hi_hz"] if b is not bands[-1] else RATE / 2
            total += 10 ** (b["spl_db"] / 10) * (hi - b["lo_hz"]) / (b["hi_hz"] - b["lo_hz"])
        for t in profile["results"]["tones"]:
            total += 10 ** (t["spl_db"] / 10)
        return 10 * np.log10(total)

    def test_quiet_time_level_matches_profile(self):
        profile = noise_profile(60.0, tones=[(1000.0, 50.0)])
        chain = replay.Chain(noise=profile)
        segs = [Segment("quiet", 0, 20 * RATE, -1)]
        pa = pa_from_chunks(replay.scenario_chunks(segs, 120.0, 40.0, chain=chain, seed=5))
        self.assertEqual(len(pa), 20 * RATE)
        self.assertAlmostEqual(spl_of(pa), self.expected_spl(profile), delta=0.5)

    def test_bed_under_a_silent_clip_matches_level_and_is_off_without_the_flag(self):
        profile = noise_profile(60.0, tones=[(1000.0, 50.0)])
        path = os.path.join(self.dir, "silence.wav")
        write_f32_wav(path, np.zeros(20 * RATE))
        on, _ = replay.chain_from_args(noise_path=dump(self.dir, "n.json", profile), noise_bed=True)
        off, _ = replay.chain_from_args(noise_path=dump(self.dir, "n.json", profile), noise_bed=False)
        self.assertTrue(on.noise_bed)
        pa_on = pa_from_chunks(replay.file_chunks(path, 120.0, 0.0, None, on))
        self.assertAlmostEqual(spl_of(pa_on), self.expected_spl(profile), delta=0.5)
        pa_off = pa_from_chunks(replay.file_chunks(path, 120.0, 0.0, None, off))
        self.assertEqual(float(np.max(np.abs(pa_off))), 0.0)

    def test_bed_is_added_under_clips_on_the_timeline(self):
        profile = noise_profile(60.0)
        path = os.path.join(self.dir, "tone.wav")
        write_f32_wav(path, np.zeros(RATE))
        chain = replay.Chain(noise=profile, noise_bed=True)
        segs = [Segment("gap", 0, RATE, -1), Segment("drone", RATE, RATE, 0, path=path)]
        chunks = replay.scenario_chunks(segs, 120.0, 40.0, cache_dir=self.dir, chain=chain, seed=2)
        pa = pa_from_chunks(chunks)
        self.assertEqual(len(pa), 2 * RATE)
        self.assertAlmostEqual(spl_of(pa[RATE:]), self.expected_spl(profile), delta=0.5)

    def test_noise_bed_needs_a_noise_profile(self):
        with self.assertRaises(ValueError):
            replay.chain_from_args(noise_bed=True)


class BenchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        names = {
            "20260101T000000Z-fb98-response.json": response_profile(),
            "20260301T000000Z-fb98-response.json": response_profile(),
            "20260201T000000Z-fb98-levels.json": levels_profile(112.86),
            "20260115T000000Z-fb98-noise.json": noise_profile(50.0),
            "20260401T000000Z-zz99-response.json": response_profile(),
            "20260402T000000Z-zz99-levels.json": levels_profile(100.0),
        }
        self.files = {}
        for name, obj in names.items():
            self.files[name] = dump(self.dir, name, obj)

    def tearDown(self):
        self.tmp.cleanup()

    def test_bench_picks_the_newest_profile_of_each_kind_for_the_node(self):
        node, found = replay.find_bench("fb98", self.dir)
        self.assertEqual(node, "fb98")
        self.assertEqual(found["response"], self.files["20260301T000000Z-fb98-response.json"])
        self.assertEqual(found["levels"], self.files["20260201T000000Z-fb98-levels.json"])
        self.assertEqual(found["noise"], self.files["20260115T000000Z-fb98-noise.json"])

    def test_bench_chain_records_the_chosen_files(self):
        chain, notes = replay.chain_from_args(bench="fb98", profiles_dir=self.dir)
        self.assertEqual(notes, [])
        self.assertEqual(chain.response_path, self.files["20260301T000000Z-fb98-response.json"])
        self.assertTrue(chain.noise_bed)
        info = chain.describe()
        self.assertEqual(info["node"], "fb98")
        self.assertAlmostEqual(info["levels_offset_db"], -7.14, places=6)
        self.assertIn("fb98", chain.header())

    def test_explicit_option_overrides_one_kind(self):
        other = self.files["20260101T000000Z-fb98-response.json"]
        chain, _ = replay.chain_from_args(response_path=other, bench="fb98", profiles_dir=self.dir)
        self.assertEqual(chain.response_path, other)
        self.assertIsNotNone(chain.levels_path)

    def test_a_directory_with_one_node_is_accepted_and_several_nodes_are_refused(self):
        single = os.path.join(self.dir, "single")
        os.makedirs(single)
        dump(single, "20260101T000000Z-ab12-noise.json", noise_profile(40.0))
        node, found = replay.find_bench(single)
        self.assertEqual(node, "ab12")
        with self.assertRaises(ValueError):
            replay.find_bench(self.dir)

    def test_missing_kinds_are_noted_and_unknown_node_fails(self):
        chain, notes = replay.chain_from_args(bench="zz99", profiles_dir=self.dir)
        self.assertEqual(len(notes), 1)
        self.assertIn("noise", notes[0])
        self.assertIsNone(chain.noise)
        with self.assertRaises(ValueError):
            replay.find_bench("nope", self.dir)

    def test_no_options_gives_no_chain(self):
        chain, notes = replay.chain_from_args()
        self.assertIsNone(chain)
        self.assertEqual(notes, [])


if __name__ == "__main__":
    unittest.main()
