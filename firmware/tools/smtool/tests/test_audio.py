"""WAV reading (PCM, float, extensible), mixing, and the resampler accuracy."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import math
import os
import struct
import tempfile
import unittest
import wave

import numpy as np

from smtool import audio


def write_float_wav(path, data, rate, channels=1):
    body = np.asarray(data, dtype="<f4").tobytes()
    fmt = struct.pack("<HHIIHH", 3, channels, rate, rate * channels * 4, channels * 4, 32)
    riff = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(body)) + body
    with open(path, "wb") as fh:
        fh.write(b"RIFF" + struct.pack("<I", len(riff)) + riff)


class WavTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_float_wav_header_and_samples(self):
        path = os.path.join(self.dir, "f.wav")
        write_float_wav(path, [0.25, -0.5, 0.75, 0.0], 50000)
        info = audio.scan_wav(path)
        self.assertEqual((info.tag, info.rate, info.frames), (3, 50000, 4))
        rate, x = audio.read_wav(path)
        self.assertEqual(rate, 50000)
        np.testing.assert_allclose(x, [0.25, -0.5, 0.75, 0.0])

    def test_stereo_pcm16_is_averaged_or_picked(self):
        path = os.path.join(self.dir, "s.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(48000)
            frames = np.array([[16384, -16384], [8192, 0]], dtype="<i2").tobytes()
            w.writeframes(frames)
        _, mean = audio.read_wav(path)
        np.testing.assert_allclose(mean, [0.0, 0.125])
        _, left = audio.read_wav(path, channel=0)
        np.testing.assert_allclose(left, [0.5, 0.25])
        with self.assertRaises(ValueError):
            audio.read_wav(path, channel=2)

    def test_clip_samples_matches_resampled_length(self):
        path = os.path.join(self.dir, "c.wav")
        write_float_wav(path, np.zeros(50000), 50000)
        self.assertEqual(audio.clip_samples(path), 16000)

    def test_pa_factor_matches_board_scaling(self):
        # 1.0 full scale at 120 dB: 20e-6 * 1e6 * sqrt(2) Pa, the board's pa_per_count times 32768
        self.assertAlmostEqual(audio.pa_factor(120.0), 20e-6 * 1e6 * math.sqrt(2))
        self.assertAlmostEqual(audio.pa_factor(120.0, 6.0) / audio.pa_factor(120.0), 10 ** (6 / 20))


class ResampleTests(unittest.TestCase):
    def test_1khz_tone_44k1_to_16k(self):
        fs_in, fs_out = 44100, 16000
        t = np.arange(44100 * 2) / fs_in
        x = np.sin(2 * np.pi * 1000 * t)
        y = audio.resample(x, fs_in, fs_out)
        self.assertEqual(len(y), audio.resampled_length(len(x), fs_in, fs_out))
        tn = np.arange(len(y)) / fs_out
        ideal = np.sin(2 * np.pi * 1000 * tn)
        core = slice(4000, len(y) - 4000)  # away from the edges
        self.assertLess(np.max(np.abs(y[core] - ideal[core])), 1e-3)

    def test_50k_to_16k_keeps_gain_and_rejects_alias_band(self):
        fs_in = 50000
        t = np.arange(fs_in) / fs_in
        tone = np.sin(2 * np.pi * 1000 * t)
        y = audio.resample(tone, fs_in, 16000)
        core = y[2000:-2000]
        self.assertAlmostEqual(float(np.max(np.abs(core))), 1.0, delta=2e-3)
        # 12 kHz is above the 16 kHz output's band and must be removed, not folded in
        hi = audio.resample(np.sin(2 * np.pi * 12000 * t), fs_in, 16000)[2000:-2000]
        self.assertLess(float(np.max(np.abs(hi))), 1e-3)

    def test_same_rate_is_a_copy(self):
        x = np.arange(10.0)
        y = audio.resample(x, 16000, 16000)
        np.testing.assert_array_equal(x, y)
        self.assertIsNot(x, y)


if __name__ == "__main__":
    unittest.main()
