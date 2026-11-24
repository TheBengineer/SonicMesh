"""Hardware run path with fake boards: records, play and events files, and the max-duration abort.

paplay is replaced by a timed wait, so nothing plays and no serial port is opened.
"""
import json
import os
import struct
import sys
import tempfile
import time
import unittest
import wave

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from fakes import FakeNode
from smtool import run, scenario as scen


def write_clip(path, seconds=0.2):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(struct.pack("<h", 1000) * int(seconds * 16000))


def fake_play(self, path, gain_db):
    t0 = time.time()
    self.sleep(0.3)
    return t0, time.time()


class RunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.clip = os.path.join(self.tmp, "clip.wav")
        write_clip(self.clip)
        self.orig_play = run.Watchdog.play
        run.Watchdog.play = fake_play
        self.nodes = {}

    def tearDown(self):
        run.Watchdog.play = self.orig_play

    def factory(self, port):
        node = FakeNode()
        self.nodes[port] = node
        return node

    def scenario(self, clips):
        return scen.parse_scenario({"name": "unit", "gap_s": 0.05, "clips": clips})

    def test_full_run_writes_all_files_and_decodes_the_shot(self):
        sc = self.scenario([{"kind": "drone", "path": self.clip}, {"kind": "quiet", "silence_s": 1.0}])
        summary = run.run_scenario(sc, ["/dev/fakeA"], None, {"gunshot.ratio_db": 15.0},
                                   {"comb": 1}, self.tmp, serial_factory=self.factory, tail_s=5)
        for name in ("lines.jsonl", "play.jsonl", "events.jsonl", "params.json", "summary.json"):
            self.assertTrue(os.path.exists(os.path.join(summary["run_dir"], name)), name)
        with open(os.path.join(summary["run_dir"], "events.jsonl")) as fh:
            events = [json.loads(line) for line in fh]
        shots = [e for e in events if e["type"] == "SHOT"]
        self.assertEqual(len(shots), 1)
        self.assertEqual(shots[0]["source"], "node")
        self.assertAlmostEqual(shots[0]["peak_db"], 132.1)
        self.assertIn("node", summary["scores"])
        # the board got the value, and the old one was kept for restoring
        self.assertEqual(self.nodes["/dev/fakeA"].params["gunshot.ratio_db"], 15.0)
        self.assertEqual(summary["before"]["/dev/fakeA"], {"gunshot.ratio_db": 12.0})
        with open(os.path.join(summary["run_dir"], "play.jsonl")) as fh:
            plays = [json.loads(line) for line in fh]
        self.assertEqual([p["kind"] for p in plays], ["drone", "quiet"])
        self.assertTrue(all(p["end"] > p["start"] for p in plays))
        self.assertIn("sm trace off", self.nodes["/dev/fakeA"].written)

    def test_max_duration_aborts_and_turns_traces_off(self):
        sc = self.scenario([{"kind": "quiet", "silence_s": 30}])
        with self.assertRaises(run.RunAborted):
            run.run_scenario(sc, ["/dev/fakeB"], None, {}, {"comb": 1}, self.tmp,
                             max_s=0.5, serial_factory=self.factory)
        self.assertIn("sm trace off", self.nodes["/dev/fakeB"].written)

    def test_default_limit_is_timeline_plus_tail(self):
        sc = self.scenario([{"kind": "drone", "path": self.clip}])
        segs = scen.plan(sc)
        self.assertAlmostEqual(scen.timeline_end(segs), 0.05 + 0.2 + 0.05)


if __name__ == "__main__":
    unittest.main()
