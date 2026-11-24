"""deploy against fake boards: no serial port is opened. Board, list_ports, the flash step and the clock
are replaced for each test, and the command runs through the real argument parser."""
import argparse
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from smtool import deploy
from smtool.device import DeviceError

BOARDS = {}  # port -> fake board configuration


def status(**over):
    """A sm status answer as a healthy, synced node reports it."""
    s = {"k": "status", "up_ms": 2343183, "node": "fb98", "synced": 1, "sync_age_ms": 880,
         "drift_ppm": -4.5, "fit": 9, "level_db": 65.0, "max_db": 68.0, "rate_hz": 15999.17,
         "batt_mv": 4156, "pending": 1, "dropped": 0, "block_drops": 0}
    s.update(over)
    return s


def node(node_id="fb98", built="Nov 23 2026 21:19:50", **over):
    cfg = {"role": "node", "node": node_id, "built": built,
           # A real node knows every parameter; these are the firmware defaults of the field ones.
           "params": {"drone_comb.enable": 1, "gunshot.enable": 1, "drone_comb.hold_ratio": 1.0,
                      "health.period_s": 10, "radio.repeats": 5},
           "stuck": {}, "status": [status()], "broken": False}
    cfg.update(over)
    return cfg


def gateway():
    return {"role": "gateway", "node": "0001", "built": "Nov 20 2026 10:00:00",
            "params": {}, "stuck": {}, "status": [], "broken": False}


class FakeBoard:
    """Stands in for device.Board. A stuck parameter reads back its stuck value whatever was set."""

    def __init__(self, port, serial_factory=None):
        if port not in BOARDS:
            raise OSError(f"{port}: no such port")
        self.port = port
        self.cfg = BOARDS[port]
        self.node_id = None
        self.role = None

    def open(self):
        return self

    def close(self):
        pass

    def info(self):
        self.role = self.cfg["role"]
        self.node_id = int(self.cfg["node"], 16)
        return {"k": "info", "role": self.role, "node": self.cfg["node"], "built": self.cfg["built"],
                "up_ms": 1, "params": 2, "traces": 2}

    def call(self, text):
        if self.cfg["broken"]:
            raise DeviceError(f"{self.port}: no answer to '{text}' within 5 s")
        if text != "sm status":
            raise DeviceError(f"unexpected command {text}")
        return [dict(self.cfg["status"][0])]

    def set(self, values):
        self.cfg["params"].update(values)

    def save(self):
        self.cfg["saved"] = True

    def get(self, names):
        out = {}
        for name in names:
            if name in self.cfg["stuck"]:
                out[name] = self.cfg["stuck"][name]
            elif name in self.cfg["params"]:
                out[name] = self.cfg["params"][name]
            else:
                raise DeviceError(f"unknown parameter {name}")
        return out


class DeployTest(unittest.TestCase):
    def setUp(self):
        BOARDS.clear()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.now = [0.0]
        self.flash_calls = []
        self.on_flash = lambda port: 0
        self.tuning = os.path.join(self.dir, "tuning.json")
        with open(self.tuning, "w", encoding="utf-8") as fh:
            json.dump({"drone_comb.hold_ratio": 2.0, "radio.repeats": 5}, fh)
        self.log = os.path.join(self.dir, "logs", "deploy.jsonl")
        patches = [
            mock.patch.object(deploy, "Board", FakeBoard),
            mock.patch.object(deploy, "list_ports", lambda: sorted(BOARDS)),
            mock.patch.object(deploy, "CLOCK", lambda: self.now[0]),
            mock.patch.object(deploy, "SLEEP", self._sleep),
            mock.patch.object(deploy, "flash_node", self._flash),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _sleep(self, seconds):
        self.now[0] += seconds

    def _flash(self, port):
        self.flash_calls.append(port)
        return self.on_flash(port)

    def run_deploy(self, *ports, extra=()):
        parser = argparse.ArgumentParser()
        subs = parser.add_subparsers(dest="cmd")
        deploy.add_parser(subs)
        argv = ["deploy", *ports, "--tuning", self.tuning, "--log", self.log, "--sync-wait", "4", *extra]
        args = parser.parse_args(argv)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = args.func(args)
        return rc, out.getvalue()

    def log_records(self):
        with open(self.log, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]


class CheckTests(DeployTest):
    def test_passing_node(self):
        BOARDS["/dev/ttyACM0"] = node()
        rc, out = self.run_deploy("/dev/ttyACM0")
        self.assertEqual(rc, 0)
        self.assertIn("fb98", out)
        self.assertIn("PASS", out)
        self.assertIn("build Nov 23 2026 21:19:50", out)
        self.assertIn("sync ok -4.5 ppm", out)
        self.assertIn("tuning tuning.json", out)
        self.assertIn("1 PASS, 0 FAIL", out)
        params = BOARDS["/dev/ttyACM0"]["params"]
        self.assertEqual(params["radio.repeats"], 5)
        self.assertEqual(params["drone_comb.hold_ratio"], 2.0)
        self.assertTrue(BOARDS["/dev/ttyACM0"].get("saved"))

    def test_gateway_is_skipped(self):
        BOARDS["/dev/ttyACM0"] = gateway()
        BOARDS["/dev/ttyACM1"] = node()
        rc, out = self.run_deploy("/dev/ttyACM0", "/dev/ttyACM1")
        self.assertEqual(rc, 0)
        self.assertIn("/dev/ttyACM0  skipped (gateway)", out)
        self.assertIn("1 PASS, 0 FAIL", out)

    def test_not_synced_fails(self):
        BOARDS["/dev/ttyACM0"] = node(status=[status(synced=0)])
        rc, out = self.run_deploy("/dev/ttyACM0")
        self.assertEqual(rc, 1)
        self.assertIn("FAIL: not synced", out)
        self.assertIn("0 PASS, 1 FAIL", out)

    def test_no_sync_passes_unsynced_node(self):
        BOARDS["/dev/ttyACM0"] = node(status=[status(synced=0)])
        rc, out = self.run_deploy("/dev/ttyACM0", extra=["--no-sync"])
        self.assertEqual(rc, 0)
        self.assertIn("sync off", out)
        self.assertIn("1 PASS, 0 FAIL", out)

    def test_low_level_fails(self):
        BOARDS["/dev/ttyACM0"] = node(status=[status(level_db=10.0)])
        rc, out = self.run_deploy("/dev/ttyACM0")
        self.assertEqual(rc, 1)
        self.assertIn("FAIL: mic level 10.0 dB", out)

    def test_tuning_readback_mismatch_fails(self):
        BOARDS["/dev/ttyACM0"] = node(stuck={"radio.repeats": 3.0})
        rc, out = self.run_deploy("/dev/ttyACM0")
        self.assertEqual(rc, 1)
        self.assertIn("FAIL: tuning radio.repeats", out)

    def test_param_off_fails(self):
        BOARDS["/dev/ttyACM0"] = node()
        BOARDS["/dev/ttyACM0"]["params"]["gunshot.enable"] = 0
        rc, out = self.run_deploy("/dev/ttyACM0")
        self.assertEqual(rc, 1)
        self.assertIn("gunshot.enable is 0, not 1", out)

    def test_low_battery_warns_but_passes(self):
        BOARDS["/dev/ttyACM0"] = node(status=[status(batt_mv=3300)])
        rc, out = self.run_deploy("/dev/ttyACM0")
        self.assertEqual(rc, 0)
        self.assertIn("WARN: battery low 3300 mV", out)

    def test_one_board_error_does_not_stop_the_rest(self):
        BOARDS["/dev/ttyACM0"] = node(broken=True)
        BOARDS["/dev/ttyACM1"] = node(node_id="00ab")
        rc, out = self.run_deploy("/dev/ttyACM0", "/dev/ttyACM1")
        self.assertEqual(rc, 1)
        self.assertIn("no answer to 'sm status'", out)
        self.assertIn("1 PASS, 1 FAIL", out)

    def test_mixed_builds_warned(self):
        BOARDS["/dev/ttyACM0"] = node(built="Nov 23 2026 21:19:50")
        BOARDS["/dev/ttyACM1"] = node(node_id="00ab", built="Nov 24 2026 09:00:00")
        rc, out = self.run_deploy("/dev/ttyACM0", "/dev/ttyACM1")
        self.assertEqual(rc, 0)
        self.assertIn("mixed builds:", out)

    def test_names_file_gives_the_label(self):
        BOARDS["/dev/ttyACM0"] = node()
        names = os.path.join(self.dir, "names.json")
        with open(names, "w", encoding="utf-8") as fh:
            json.dump({str(0xfb98): "north-oak"}, fh)
        rc, out = self.run_deploy("/dev/ttyACM0", extra=["--names", names])
        self.assertIn("north-oak", out)

    def test_log_record_written(self):
        BOARDS["/dev/ttyACM0"] = node()
        self.run_deploy("/dev/ttyACM0")
        records = self.log_records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["node"], "fb98")
        self.assertEqual(records[0]["status"], "PASS")
        self.assertEqual(records[0]["port"], "/dev/ttyACM0")
        self.assertEqual(records[0]["tuning"], "tuning.json")
        self.assertIn("time", records[0])


class FlashTests(DeployTest):
    def test_board_back_on_another_port(self):
        BOARDS["/dev/ttyACM0"] = node()

        def move(port):
            BOARDS["/dev/ttyACM3"] = BOARDS.pop(port)
            return 0

        self.on_flash = move
        rc, out = self.run_deploy("/dev/ttyACM0", extra=["--flash"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.flash_calls, ["/dev/ttyACM0"])
        self.assertEqual(self.log_records()[0]["port"], "/dev/ttyACM3")
        self.assertIn("1 PASS, 0 FAIL", out)

    def test_flash_exit_status_fails(self):
        BOARDS["/dev/ttyACM0"] = node()
        self.on_flash = lambda port: 1
        rc, out = self.run_deploy("/dev/ttyACM0", extra=["--flash"])
        self.assertEqual(rc, 1)
        self.assertIn("FAIL: flash failed", out)

    def test_board_does_not_come_back(self):
        BOARDS["/dev/ttyACM0"] = node()

        def vanish(port):
            BOARDS.pop(port)
            return 0

        self.on_flash = vanish
        rc, out = self.run_deploy("/dev/ttyACM0", extra=["--flash"])
        self.assertEqual(rc, 1)
        self.assertIn("FAIL: did not come back after flashing", out)


class ConfigTests(DeployTest):
    def test_default_tuning_file(self):
        values = deploy.load_tuning(deploy.DEFAULT_TUNING)
        self.assertEqual(values, {"drone_comb.hold_ratio": 2.0, "health.period_s": 10, "radio.repeats": 5})

    def test_exit_code_zero_only_when_all_pass(self):
        BOARDS["/dev/ttyACM0"] = node()
        BOARDS["/dev/ttyACM1"] = node(node_id="00ab", status=[status(synced=0)])
        rc, _ = self.run_deploy("/dev/ttyACM0", "/dev/ttyACM1")
        self.assertEqual(rc, 1)
        rc, _ = self.run_deploy("/dev/ttyACM0", "/dev/ttyACM1", extra=["--no-sync"])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
