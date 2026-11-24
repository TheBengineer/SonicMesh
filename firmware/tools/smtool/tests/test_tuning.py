"""Tuning files split into comb, impulse and glue values."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import unittest

from smtool import tuning


class TuningTests(unittest.TestCase):
    def test_split(self):
        s = tuning.split_tuning({"gunshot.ratio_db": 15, "drone_comb.theta": 0.12,
                                 "drone_comb.update_ms": 500, "drone_comb.shot_mask_ms": 400,
                                 "audio.full_scale_db": 110, "radio.repeats": 2})
        self.assertEqual(s.impulse, {"ratio_db": 15.0})
        self.assertEqual(s.comb, {"theta": 0.12})
        self.assertEqual(s.options["update_ms"], 500.0)
        self.assertEqual(s.options["shot_mask_ms"], 400.0)
        self.assertEqual(s.options["full_scale_db"], 110.0)
        self.assertEqual(s.ignored, ["radio.repeats"])

    def test_defaults_and_merge(self):
        s = tuning.split_tuning({})
        self.assertEqual(s.options["update_ms"], 1000)
        self.assertEqual(tuning.merge({"a": 1}, {"a": 2, "b": 3}), {"a": 2, "b": 3})


if __name__ == "__main__":
    unittest.main()
