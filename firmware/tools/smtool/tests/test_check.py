"""sm check on a synthetic run directory: a click train is captured, the node's events are the clicks at their
true times, and the replay must agree with them; a shifted set of node events must be reported as a shift."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import io
import contextlib
import json
import tempfile
import unittest

import numpy as np

from smtool import capture, check, cli

PORT = "/dev/fakeA"
RATE = 15999.25
CLICKS_S = (1.0, 3.0, 5.0)  # seconds into the capture
T0_LOCAL_US = 5_000_000  # board local time of the capture's first sample


def click_train(n_samples, clicks_at, seed=3):
    """Counts: low-level noise and a decaying burst at each click. Replay finds one SHOT per burst."""
    rng = np.random.default_rng(seed)
    x = np.round(rng.standard_normal(n_samples) * 3).astype(np.float64)
    for k in clicks_at:
        env = np.exp(-np.arange(800) / 120.0)
        x[k:k + 800] += 9000 * env * np.sign(np.sin(np.arange(800) * 0.9))
    return np.round(x).astype(np.int16)


def write_run(run_dir, first_sample, shift_s=0.0, clicks_s=CLICKS_S):
    """A run directory: capture.wav with its sidecar, lines.jsonl with the node's trace lines, params.json,
    and events.jsonl with the node's SHOT events at the clicks (shifted by shift_s)."""
    os.makedirs(run_dir, exist_ok=True)
    n = int(8 * 16000)
    # the capture starts at first_sample on the board; clicks are placed by their time in the capture
    clicks_idx = [int(round(t * 16000)) for t in clicks_s]
    samples = click_train(n, clicks_idx)
    cap = capture.Capture()
    cap.samples = samples
    cap.first_sample = first_sample
    cap.t0_local_us = T0_LOCAL_US
    cap.rate_hz = RATE
    cap.node_id = 0xAB
    cap.port = PORT
    capture.save_wav(cap, os.path.join(run_dir, "capture.wav"), params=None, extra={"port": PORT})

    lines = []
    for k in range(0, 200):  # trace lines every 0.1 s, local time 1 s .. 21 s, host = local + 1000 s
        t = 1_000_000 + k * 100_000
        raw = json.dumps({"k": "tr", "s": "comb", "t": t, "on": 0})
        lines.append({"port": PORT, "w": round(1000.0 + t / 1e6, 3), "raw": raw})
    with open(os.path.join(run_dir, "lines.jsonl"), "w", encoding="utf-8") as fh:
        for row in lines:
            fh.write(json.dumps(row) + "\n")

    with open(os.path.join(run_dir, "params.json"), "w", encoding="utf-8") as fh:
        json.dump({"ports": {PORT: {"role": "node", "node": 171, "params": [
            {"n": "gunshot.ratio_db", "v": 15.0}, {"n": "audio.full_scale_db", "v": 120.0},
            {"n": "drone_comb.theta", "v": 0.1}]}}, "set": {}, "before": {}}, fh)

    # the node saw each click at its sample: host = offset + (board local time of that sample) / 1e6
    host = []
    for k in clicks_idx:
        local = T0_LOCAL_US + k * 1e6 / RATE
        host.append(1000.0 + local / 1e6 + shift_s)
    with open(os.path.join(run_dir, "events.jsonl"), "w", encoding="utf-8") as fh:
        for t in host:
            fh.write(json.dumps({"type": "SHOT", "t": t, "port": PORT, "source": "node", "peak_db": 110.9,
                                 "rise_db": 67.5}) + "\n")
    return run_dir


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_replay_matches_the_board(self):
        run_dir = write_run(os.path.join(self.tmp, "match"), first_sample=10240)
        result = check.check(run_dir)
        self.assertEqual(result["verdict"], "replay matches the board")
        self.assertEqual(result["SHOT"]["matched"], 3)
        self.assertEqual(result["SHOT"]["replay_only_count"], 0)
        self.assertEqual(result["SHOT"]["board_only_count"], 0)
        self.assertLess(result["SHOT"]["diff"]["max_abs_ms"], 1.0)
        self.assertEqual(result["DRONE"]["start"]["replay"], 0)
        with open(os.path.join(run_dir, "check.json")) as fh:
            self.assertEqual(json.load(fh)["verdict"], "replay matches the board")

    def test_shifted_board_events_are_reported_as_a_shift(self):
        run_dir = write_run(os.path.join(self.tmp, "shift"), first_sample=10240, shift_s=0.020)
        result = check.check(run_dir)
        self.assertTrue(result["verdict"].startswith("replay differs"), result["verdict"])
        self.assertEqual(result["SHOT"]["matched"], 0)
        self.assertEqual(result["SHOT"]["replay_only_count"], 3)
        self.assertEqual(result["SHOT"]["board_only_count"], 3)
        self.assertAlmostEqual(result["SHOT"]["shift_ms"], 20.0, delta=0.5)
        self.assertIn("SHOT: replay is +20.0 ms from the board", result["verdict"])

    def test_misaligned_capture_start_is_trimmed_to_the_block_grid(self):
        run_dir = write_run(os.path.join(self.tmp, "trim"), first_sample=10240 + 100)
        result = check.check(run_dir)
        self.assertEqual(result["capture"]["trimmed"], 412)
        self.assertEqual(result["verdict"], "replay matches the board")
        self.assertEqual(result["SHOT"]["matched"], 3)

    def test_cli_check_prints_the_verdict(self):
        run_dir = write_run(os.path.join(self.tmp, "cli"), first_sample=10240)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(["check", run_dir])
        self.assertEqual(rc, 0)
        self.assertIn("verdict: replay matches the board", out.getvalue())


if __name__ == "__main__":
    unittest.main()
