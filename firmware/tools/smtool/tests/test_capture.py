"""sm capture against a fake board: reassembly with a gap, prefixes and interleaved lines, the stop on timeout,
and the WAV and sidecar round trip."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import json
import tempfile
import time
import unittest

import numpy as np

from fakes import FakeCaptureNode, FakeSerial
from smtool import capture
from smtool.device import Board


def open_fake(fake):
    return Board("/dev/fakeCap", serial_factory=lambda port: fake).open()


def sine(n_blocks, freq=440.0, amp=1000):
    n = np.arange(n_blocks * capture.BLOCK)
    return np.round(amp * np.sin(2 * np.pi * freq * n / 16000)).astype("<i2")


class AssembleTests(unittest.TestCase):
    def test_gap_is_zero_filled_and_listed(self):
        x = np.arange(1536, dtype=np.int16)
        blocks = [(100, 1, x[0:512]), (612, 2, x[512:1024]), (1636, 3, x[1024:1536])]  # 1124 is missing
        samples, first, t0, gaps = capture.assemble(blocks)
        self.assertEqual((first, t0), (100, 1))
        self.assertEqual(gaps, [(1024, 512)])
        self.assertEqual(len(samples), 1536 + 512)
        np.testing.assert_array_equal(samples[:1024], x[:1024])
        np.testing.assert_array_equal(samples[1024:1536], np.zeros(512, np.int16))
        np.testing.assert_array_equal(samples[1536:], x[1024:])

    def test_duplicate_is_kept_once(self):
        x = np.arange(512, dtype=np.int16)
        samples, _, _, gaps = capture.assemble([(0, 0, x), (0, 0, x), (512, 1, x)])
        self.assertEqual(len(samples), 1024)
        self.assertEqual(gaps, [])


class RecordTests(unittest.TestCase):
    def test_record_reassembles_the_sine_with_one_dropped_block(self):
        fake = FakeCaptureNode(drop=5, freq=440.0, amp=1000, first_sample=10240)
        board = open_fake(fake)
        try:
            started = []
            cap = capture.record(board, 16 * 512 / 16000, on_started=lambda: started.append(True))
        finally:
            board.close()
        self.assertEqual(started, [True])
        self.assertEqual(cap.first_sample, 10240)
        self.assertEqual(cap.t0_local_us, 7_000_000)
        self.assertEqual(cap.gaps, [(5 * 512, 512)])
        self.assertEqual(cap.board_gaps, 1)
        self.assertAlmostEqual(cap.rate_hz, 15999.25)
        self.assertEqual(cap.blocks_expected, 16)
        self.assertEqual(cap.blocks_received, 15)
        self.assertEqual(cap.samples.size, 16 * 512)
        expected = sine(16)
        expected[5 * 512:6 * 512] = 0
        np.testing.assert_array_equal(cap.samples, expected)
        self.assertEqual(len(cap.host_times), 15)
        self.assertEqual(cap.port, "/dev/fakeCap")

    def test_record_sends_stop_when_the_stream_never_finishes(self):
        fake = FakeCaptureNode(finish=False)
        board = open_fake(fake)
        try:
            with self.assertRaises(capture.CaptureError):
                capture.record(board, 0.2, grace_s=0.3)
        finally:
            board.close()
        self.assertIn("sm capture stop", fake.written)
        self.assertTrue(fake.cap_stop.is_set())

    def test_refused_capture_raises_and_sends_no_stop(self):
        def refuse(text):
            return b'{"k":"err","c":"capture","e":-16,"m":"a capture is running"}\r\n'
        fake = FakeSerial(refuse)
        board = Board("/dev/fakeCap", serial_factory=lambda port: fake).open()
        try:
            with self.assertRaises(capture.CaptureError) as ctx:
                capture.record(board, 0.5)
        finally:
            board.close()
        self.assertIn("a capture is running", str(ctx.exception))
        self.assertEqual(fake.written, ["sm capture 0.5"])


class FileTests(unittest.TestCase):
    def test_save_and_load_round_trip(self):
        cap = capture.Capture()
        cap.samples = sine(2)
        cap.first_sample = 1024
        cap.t0_local_us = 99
        cap.rate_hz = 15999.25
        cap.gaps = [(512, 0)]
        cap.node_id = 0xAB
        cap.port = "/dev/fakeCap"
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "c.wav")
        capture.save_wav(cap, path, params={"gunshot.ratio_db": 12.0}, extra={"play": {"path": "x.wav"}})
        samples, meta = capture.load_wav(path)
        np.testing.assert_array_equal(samples, cap.samples)
        self.assertEqual(meta["node"], "00ab")
        self.assertEqual(meta["first_sample"], 1024)
        self.assertEqual(meta["t0_local_us"], 99)
        self.assertEqual(meta["rate_hz"], 15999.25)
        self.assertEqual(meta["wav_rate_hz"], 16000)
        self.assertEqual(meta["gaps"], [[512, 0]])
        self.assertEqual(meta["params"], {"gunshot.ratio_db": 12.0})
        self.assertEqual(meta["play"], {"path": "x.wav"})
        with open(path + ".json") as fh:
            self.assertEqual(json.load(fh)["samples"], 1024)


def fake_play(self, path, gain_db):
    t0 = time.time()
    self.sleep(0.3)
    return t0, time.time()


class RunCaptureTests(unittest.TestCase):
    """sm run --capture on fake boards: capture.wav and its sidecar are written, and the node events still decode."""

    def setUp(self):
        import struct
        import wave
        from smtool import run
        self.tmp = tempfile.mkdtemp()
        self.clip = os.path.join(self.tmp, "clip.wav")
        with wave.open(self.clip, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(struct.pack("<h", 1000) * int(0.2 * 16000))
        self.run = run
        self.orig_play = run.Watchdog.play
        run.Watchdog.play = fake_play
        self.nodes = {}

    def tearDown(self):
        self.run.Watchdog.play = self.orig_play

    def factory(self, port):
        node = FakeCaptureNode()
        self.nodes[port] = node
        return node

    def test_run_with_capture_writes_capture_and_keeps_node_events(self):
        from smtool import scenario as scen
        sc = scen.parse_scenario({"name": "cap", "gap_s": 0.05, "clips": [
            {"kind": "drone", "path": self.clip}, {"kind": "quiet", "silence_s": 1.0}]})
        summary = self.run.run_scenario(sc, ["/dev/fakeA"], None, {"gunshot.ratio_db": 15.0}, {"comb": 1},
                                        self.tmp, serial_factory=self.factory, tail_s=5, capture_audio=True)
        self.assertEqual(summary["capture"], "capture.wav")
        wav = os.path.join(summary["run_dir"], "capture.wav")
        samples, meta = capture.load_wav(wav)
        self.assertEqual(meta["port"], "/dev/fakeA")
        self.assertEqual(meta["node"], "00ab")
        self.assertEqual(meta["gaps"], [])
        self.assertGreater(len(samples), 5 * 16000)
        self.assertGreater(np.abs(samples.astype(np.int32)).max(), 500)
        self.assertEqual(meta["params"]["gunshot.ratio_db"], 15.0)
        self.assertEqual(self.nodes["/dev/fakeA"].streams, 1)
        with open(os.path.join(summary["run_dir"], "lines.jsonl")) as fh:
            raw = fh.read()
        self.assertNotIn('"k":"pcm"', raw)  # audio is in the wav, not in lines.jsonl
        with open(os.path.join(summary["run_dir"], "events.jsonl")) as fh:
            shots = [json.loads(line) for line in fh if '"SHOT"' in line]
        self.assertEqual(len(shots), 1)


if __name__ == "__main__":
    unittest.main()
