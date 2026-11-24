"""Clock fitting: offset and drift from receive times, with delay jitter and a reboot."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import random
import unittest

from smtool import clock


class ClockTests(unittest.TestCase):
    def test_offset_and_drift_recovered_through_jitter(self):
        rng = random.Random(4)
        a, drift = 1_700_000_000.0, 3e-6
        samples = []
        for k in range(600):  # one line every 0.1 s for 60 s
            local_us = k * 100_000 + 12_345
            wall = a + (local_us / 1e6) * (1 + drift) + rng.random() * 0.004  # delay is never negative
            samples.append((wall, local_us))
        fit = clock.fit_clock(samples)
        self.assertEqual(len(fit.segments), 1)
        self.assertAlmostEqual(fit.drift_ppm[0], 3.0, delta=1.5)
        t_test = 30_000_000 + 12_345
        true = a + (t_test / 1e6) * (1 + drift)
        self.assertLess(abs(fit.to_host(t_test) - true), 0.002)

    def test_reboot_starts_a_new_segment(self):
        first = [(1000.0 + k * 0.1, k * 100_000) for k in range(100)]
        second = [(2000.0 + k * 0.1, k * 100_000) for k in range(100)]  # local clock restarts at 0
        fit = clock.fit_clock(first + second)
        self.assertEqual(len(fit.segments), 2)
        self.assertAlmostEqual(fit.to_host(500_000, wall=1000.5), 1000.5, delta=0.01)
        self.assertAlmostEqual(fit.to_host(0, wall=2000.0), 2000.0, delta=0.01)
        self.assertAlmostEqual(fit.to_host(0, wall=1000.0), 1000.0, delta=0.01)

    def test_short_input_still_fits(self):
        fit = clock.fit_clock([(100.0, 1_000_000), (101.0, 2_000_000)])
        # two points: a constant offset (no drift), so local 1.5 s is host 100.5 s
        self.assertAlmostEqual(fit.to_host(1_500_000), 100.5, delta=0.01)

    def test_sparse_lines_give_offset_only(self):
        # A few record lines with large delays: a fitted slope would be nonsense, so drift is 0.
        samples = [(500.0 + t + d, int(t * 1e6)) for t, d in [(0, 0.0), (12, 0.3), (25, 0.0), (31, 0.4), (47, 0.0), (52, 0.2)]]
        fit = clock.fit_clock(samples)
        self.assertEqual(fit.drift_ppm, [0.0])
        self.assertAlmostEqual(fit.to_host(25_000_000), 525.0, delta=0.01)

    def test_no_samples_is_an_error(self):
        with self.assertRaises(ValueError):
            clock.fit_clock([])


if __name__ == "__main__":
    unittest.main()
