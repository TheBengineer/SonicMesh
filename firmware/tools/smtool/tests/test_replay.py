"""Replay on synthetic signals: click times, a harmonic drone with its start and end."""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import numpy as np

from smtool import replay

RATE = 16000
REF = 20e-6


def spl_rms(db):
    return REF * 10 ** (db / 20)


def clicks_signal(seconds, click_times, bg_db=50.0, click_db=130.0, seed=3):
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    x = rng.standard_normal(n) * spl_rms(bg_db)
    t_click = np.arange(int(0.005 * RATE)) / RATE
    burst = rng.standard_normal(len(t_click)) * np.exp(-t_click / 0.0015)
    burst *= spl_rms(click_db) / np.sqrt(np.mean(burst ** 2))
    for t0 in click_times:
        i = int(round(t0 * RATE))
        x[i:i + len(burst)] += burst
    return x.astype(np.float32)


def drone_signal(seconds, tone_until, f0=300.0, harmonics=8, total_db=70.0, bg_db=40.0, seed=5,
                 fade_from=0.5, fade_s=1.0):
    """Harmonic tone from fade_from, fading in over fade_s, until tone_until; noise all the time.

    The tone is faded in because the comb's start-up treats a tone already present at the first sample as a
    jump (its score is zero until the level settles), while real recordings begin with the noise floor.
    """
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * RATE)) / RATE
    amp = spl_rms(total_db) / np.sqrt(harmonics / 2.0)  # sum of N sines of amplitude a has rms a*sqrt(N/2)
    tone = sum(amp * np.sin(2 * np.pi * f0 * h * t + 0.3 * h) for h in range(1, harmonics + 1))
    env = np.clip((t - fade_from) / fade_s, 0.0, 1.0) * (t < tone_until)
    tone = tone * env
    return (tone + rng.standard_normal(len(t)) * spl_rms(bg_db)).astype(np.float32)


class ReplayTests(unittest.TestCase):
    def test_clicks_give_shots_within_2_ms(self):
        times = [0.2, 0.5, 0.8]
        x = clicks_signal(1.0, times)
        events = replay.run_chunks([x], replay.Detectors(comb_enabled=False))
        shots = [e for e in events if e["type"] == "SHOT"]
        self.assertEqual(len(shots), len(times), shots)
        for shot, t in zip(shots, times):
            self.assertLess(abs(shot["t"] - t), 0.002, (shot["t"], t))
            self.assertGreater(shot["peak_db"], 120.0)

    def test_quiet_noise_gives_no_shots_or_drone(self):
        rng = np.random.default_rng(9)
        x = (rng.standard_normal(RATE * 4) * spl_rms(40.0)).astype(np.float32)
        events = replay.run_chunks([x], replay.Detectors())
        self.assertEqual(events, [])

    def test_harmonic_drone_starts_and_ends_after_tone_stops(self):
        # 20 s: the comb keeps the track on for about 13 s after this tone stops, on white noise (see the
        # report on the tail). The test checks only that the END comes after the tone stops.
        x = drone_signal(20.0, tone_until=6.0)
        det = replay.Detectors()
        events = replay.run_chunks([x], det)
        drones = [e for e in events if e["type"] == "DRONE"]
        starts = [e for e in drones if e["state"] == "start"]
        ends = [e for e in drones if e["state"] == "end"]
        self.assertTrue(starts, "no DRONE start")
        self.assertLess(starts[0]["t"], 6.0)
        self.assertTrue(ends, "no DRONE end")
        self.assertGreater(ends[-1]["t"], 6.0)
        self.assertLess(ends[-1]["t"], 20.0)
        self.assertLess(abs(starts[0]["f0_hz"] - 300.0), 5.0)

    def test_shot_masks_drone_frames(self):
        # A click at 3 s with the tone on. A frame starting after the onset and before shot_mask_ms is
        # skipped, so no comb row (taken at the frame's last sample) falls in (3.0 s, 3.6 s).
        x = drone_signal(6.0, tone_until=6.0) + clicks_signal(6.0, [3.0], bg_db=0.0)
        rows = []
        replay.run_chunks([x], replay.Detectors(shot_mask_ms=600), on_row=rows.append)
        comb_times = [r["t"] / 1e6 for r in rows if r["s"] == "comb"]
        self.assertTrue(comb_times)
        gap = [t for t in comb_times if 3.0 < t < 3.6]
        self.assertFalse(gap, "comb stepped inside the shot mask")

    def test_unknown_parameter_raises(self):
        with self.assertRaises(KeyError):
            replay.Detectors(impulse={"nope": 1.0})


if __name__ == "__main__":
    unittest.main()
