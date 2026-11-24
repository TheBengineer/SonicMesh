"""Scoring on hand-made events, latency offset estimation, and the scenario timeline."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import os
import unittest

from smtool import score, scenario as scen
from smtool.score import COST


def shot(t, peak=130.0):
    return {"type": "SHOT", "t": t, "peak_db": peak, "rise_db": 20.0}


def drone(state, t, f0=300.0):
    return {"type": "DRONE", "state": state, "t": t, "f0_hz": f0, "nharm": 5, "score": 0.5, "band_db": 60.0}


class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.windows = [
            scen.Window("gunshot", 0, 1.0, 3.0, [1.2, 1.8]),
            scen.Window("drone", 1, 5.0, 15.0, None),
            scen.Window("gunshot", 2, 20.0, 21.0, None),  # unlabelled
        ]

    def test_hits_misses_and_extras(self):
        events = [shot(1.21), shot(2.5), shot(20.5), drone("start", 5.8), drone("end", 17.0)]
        res = score.score_run(self.windows, events, (0.0, 60.0), tol=0.03)
        t = res["totals"]
        self.assertEqual((t["labels"], t["hits"], t["misses"]), (2, 1, 1))
        self.assertEqual(t["extra_shots"], 1)  # the SHOT at 2.5 inside the labelled clip
        self.assertEqual(t["unlabelled_shots"], 1)  # the one at 20.5 costs nothing
        self.assertEqual(t["quiet_shots"], 0)

    def test_drone_latency_and_tail(self):
        events = [drone("start", 5.8), drone("update", 6.9, 301.0), drone("end", 17.0)]
        res = score.score_run(self.windows, events, (0.0, 60.0))
        row = [r for r in res["windows"] if r["kind"] == "drone"][0]
        self.assertTrue(row["detected"])
        self.assertAlmostEqual(row["latency_s"], 0.8)
        self.assertAlmostEqual(row["tail_s"], 2.0)
        self.assertFalse(row["tail_open"])
        self.assertEqual(res["totals"]["drone_f0_hz"], 300.5)

    def test_missed_drone_and_quiet_false_alarms(self):
        events = [shot(30.0), shot(31.0), drone("start", 35.0), drone("end", 45.0)]
        res = score.score_run(self.windows, events, (0.0, 60.0))
        t = res["totals"]
        self.assertEqual(t["drone_detected"], 0)
        self.assertEqual(t["quiet_shots"], 2)
        # 10 s of drone on in quiet time that no drone clip explains
        self.assertAlmostEqual(t["drone_false_on_s"], 10.0)

    def test_detection_carried_into_a_drone_clip_is_neither_hit_nor_miss(self):
        # On from 4 s (before the clip at 5 s) to 16 s: the clip cannot show a detection of its own.
        events = [drone("start", 4.0), drone("end", 16.0)]
        res = score.score_run(self.windows, events, (0.0, 60.0))
        row = [r for r in res["windows"] if r["kind"] == "drone"][0]
        self.assertIsNone(row["detected"])
        self.assertTrue(row["already_on"])
        t = res["totals"]
        self.assertEqual((t["drone_detected"], t["drone_already_on"]), (0, 1))
        # The 1 s before the clip is false on; the time inside the clip is not.
        self.assertAlmostEqual(t["drone_false_on_s"], 1.0)
        self.assertNotIn(COST["drone_missed"], [res["cost"]])

    def test_cost_uses_documented_weights(self):
        events = [shot(1.21), shot(2.5), drone("start", 5.8), drone("end", 17.0)]
        res = score.score_run(self.windows, events, (0.0, 60.0))
        t = res["totals"]
        expected = (t["misses"] * COST["miss"] + t["extra_shots"] * COST["extra_shot"]
                    + t["quiet_shots"] * COST["quiet_shot"] + 2.0 * COST["drone_tail_s"]
                    + 0.8 * COST["drone_latency_s"] + t["drone_false_on_s"] * COST["drone_false_on_s"])
        self.assertAlmostEqual(res["cost"], round(expected, 3))
        self.assertEqual(COST["miss"], 5.0)

    def test_open_drone_interval_tail_uses_span_end(self):
        events = [drone("start", 5.8)]
        res = score.score_run(self.windows, events, (0.0, 30.0))
        row = [r for r in res["windows"] if r["kind"] == "drone"][0]
        self.assertTrue(row["tail_open"])
        self.assertAlmostEqual(row["tail_s"], 15.0)

    def test_offset_is_applied_before_matching(self):
        events = [shot(1.25), shot(1.83)]  # both 20 ms late
        off = score.estimate_offset(self.windows, [e["t"] for e in events])
        self.assertAlmostEqual(off, 0.0 + (0.05 + 0.03) / 2, places=6)
        res = score.score_run(self.windows, events, (0.0, 60.0), tol=0.03, offset=off)
        self.assertEqual(res["totals"]["hits"], 2)
        bare = score.score_run(self.windows, events, (0.0, 60.0), tol=0.03, offset=0.0)
        self.assertEqual(bare["totals"]["hits"], 0)

    def test_estimate_offset_without_labels_is_zero(self):
        self.assertEqual(score.estimate_offset([scen.Window("drone", 0, 0, 1, None)], [0.5]), 0.0)


class TimelineTests(unittest.TestCase):
    def test_plan_and_windows(self):
        sc = scen.parse_scenario({"name": "t", "gap_s": 1, "clips": [
            {"kind": "gunshot", "path": "data/gunshots/oga-gunshot-sounds/sounds/cz.wav", "shots": [0.5]},
            {"kind": "quiet", "silence_s": 2}]}, "x")
        segs = scen.plan(sc, lengths=lambda p: 16000 * 3)
        self.assertEqual([s.kind for s in segs], ["gap", "gunshot", "gap", "quiet", "gap"])
        self.assertAlmostEqual(segs[1].start_s, 1.0)
        wins = scen.windows(segs)
        self.assertEqual(len(wins), 1)
        self.assertAlmostEqual(wins[0].shots[0], 1.5)
        self.assertAlmostEqual(scen.timeline_end(segs), 1.0 + 3.0 + 1.0 + 2.0 + 1.0)

    def test_bad_scenarios_are_refused(self):
        with self.assertRaises(scen.ScenarioError):
            scen.parse_scenario({"name": "x", "clips": [{"kind": "bird", "path": "a.wav"}]})
        with self.assertRaises(scen.ScenarioError):
            scen.parse_scenario({"clips": [{"kind": "quiet", "silence_s": 3}]})
        with self.assertRaises(scen.ScenarioError):
            scen.parse_scenario({"name": "x", "clips": [{"kind": "quiet"}]})

    def test_shipped_scenarios_load(self):
        here = os.path.dirname(os.path.abspath(__file__))
        for name in ("bench_mixed.json", "quiet.json"):
            sc = scen.load_scenario(os.path.join(here, "..", "scenarios", name))
            self.assertTrue(sc.clips, name)


if __name__ == "__main__":
    unittest.main()
