"""Range walk statistics on synthetic gateway lines and fake times. No hardware."""
import io
import json
import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from smtool import rangetest
from smtool.rangetest import LinkStats, RangeSession, id_gap, decode_health, status_line

NODE = 0xFB98


def rec(node, rid, rssi=-78, rtype=1, payload=""):
    return {"k": "rec", "g": 0, "n": node, "f": 1, "rssi": rssi, "t": rtype, "i": rid, "p": payload}


def health_hex(sync_age=0xFFFF, batt=4012, level=-123, peak=-45, clips=0, drops=0, uptime=3600):
    return struct.pack("<IhhHHHHH", uptime, level, peak, clips, drops, batt, sync_age, 7).hex()


def gw(frames, recs):
    return {"k": "gw", "g": 0, "up": 0, "frames": frames, "recs": recs, "dups": 0, "lost": 0}


class IdGapTest(unittest.TestCase):
    def test_missing_ids_are_counted(self):
        stats = LinkStats(start=0.0)
        for t, rid in enumerate([10, 11, 13, 16]):
            stats.feed(float(t), rec(NODE, rid))
        self.assertEqual([r.lost for r in stats.recs], [0, 0, 1, 2])
        self.assertEqual(sum(r.lost for r in stats.recs), 3)

    def test_wrap_at_uint16(self):
        self.assertEqual(id_gap(65534, 65535), (0, False))
        self.assertEqual(id_gap(65535, 0), (0, False))
        self.assertEqual(id_gap(65535, 2), (2, False))  # ids 0 and 1 missing
        self.assertEqual(id_gap(65534, 1), (2, False))

    def test_restart_jump_is_not_loss(self):
        self.assertEqual(id_gap(40211, 5), (0, True))
        stats = LinkStats(start=0.0)
        stats.feed(0.0, rec(NODE, 40211))
        stats.feed(1.0, rec(NODE, 5))
        stats.feed(2.0, rec(NODE, 6))
        self.assertEqual(stats.restarts, 1)
        self.assertEqual([r.lost for r in stats.recs], [0, 0, 0])

    def test_jump_at_limit(self):
        self.assertEqual(id_gap(0, 1000), (999, False))
        self.assertEqual(id_gap(0, 1001), (0, True))


class CopiesTest(unittest.TestCase):
    def test_copies_from_gateway_deltas(self):
        stats = LinkStats(start=0.0)
        stats.feed(0.0, gw(100, 20))
        stats.feed(10.0, gw(130, 30))
        for t in range(1, 11):
            stats.feed(float(t), rec(NODE, t))
        w = stats.window(10.0, 10.0)
        self.assertAlmostEqual(w["copies"], 3.0)
        self.assertEqual(w["received"], 10)

    def test_no_copies_without_two_gateway_lines(self):
        stats = LinkStats(start=0.0)
        stats.feed(10.0, gw(130, 30))
        self.assertIsNone(stats.window(10.0, 10.0)["copies"])

    def test_gateway_reboot_gives_no_copies(self):
        stats = LinkStats(start=0.0)
        stats.feed(0.0, gw(500, 100))
        stats.feed(10.0, gw(20, 4))
        self.assertIsNone(stats.window(10.0, 10.0)["copies"])


class MarkRowsTest(unittest.TestCase):
    def test_per_mark_summary(self):
        stats = LinkStats(start=0.0)
        stats.feed(0.0, gw(0, 0))
        stats.mark(0.0, "50m")
        stats.feed(0.0, gw(0, 0))
        # 50 m: ids 1..10 heard once each, rssi -70
        for i in range(10):
            stats.feed(1.0 + i, rec(NODE, 1 + i, rssi=-70))
        stats.feed(10.0, gw(50, 10))
        stats.mark(20.0, "100m")
        # 100 m: ids 11..20 with 2 missing (13 and 16 skipped), rssi -80 and -90
        heard = [11, 12, 14, 15, 17, 18, 19, 20]
        for i, rid in enumerate(heard):
            stats.feed(21.0 + i, rec(NODE, rid, rssi=-80 if i % 2 else -90, rtype=2,
                                     payload=health_hex(sync_age=4 if i < 6 else 0xFFFF)))
        stats.feed(30.0, gw(50 + 40, 10 + 10))
        rows = stats.mark_rows(end=40.0)
        self.assertEqual([r["mark"] for r in rows], ["50m", "100m"])
        self.assertEqual(rows[0]["received"], 10)
        self.assertEqual(rows[0]["lost"], 0)
        self.assertEqual(rows[0]["rssi_med"], -70)
        self.assertAlmostEqual(rows[0]["copies"], 5.0)
        self.assertEqual(rows[1]["received"], 8)
        # id 13 (before 14) and 16 (before 17) are missing: 2 lost
        self.assertEqual(rows[1]["lost"], 2)
        self.assertEqual(rows[1]["rssi_min"], -90)
        self.assertEqual(rows[1]["rssi_max"], -80)
        self.assertAlmostEqual(rows[1]["sync_ok"], 6 / 8)

    def test_gap_at_mark_boundary_counts_for_later_mark(self):
        stats = LinkStats(start=0.0)
        stats.mark(0.0, "a")
        stats.feed(1.0, rec(NODE, 1))
        stats.mark(2.0, "b")
        stats.feed(3.0, rec(NODE, 4))  # ids 2 and 3 missing
        rows = stats.mark_rows(end=5.0)
        self.assertEqual(rows[0]["lost"], 0)
        self.assertEqual(rows[1]["lost"], 2)
        self.assertAlmostEqual(rows[1]["lost_pct"], 100.0 * 2 / 3)


class NoSignalTest(unittest.TestCase):
    def test_no_signal_after_five_seconds(self):
        stats = LinkStats(start=0.0)
        stats.feed(100.0, rec(NODE, 1))
        line = status_line(stats, 106.0, 10.0, "50m")
        self.assertIn("NO SIGNAL for 6s", line)
        self.assertNotIn("recv", line)

    def test_signal_within_five_seconds(self):
        stats = LinkStats(start=0.0)
        stats.feed(100.0, rec(NODE, 1))
        line = status_line(stats, 103.0, 10.0, None)
        self.assertNotIn("NO SIGNAL", line)
        self.assertIn("recv 1/1", line)
        self.assertIn("[-]", line)

    def test_never_heard_counts_from_start(self):
        stats = LinkStats(start=50.0)
        self.assertIn("NO SIGNAL for 9s", status_line(stats, 59.0, 10.0, "x"))


class HealthTest(unittest.TestCase):
    def test_sync_none(self):
        fields = decode_health(bytes.fromhex(health_hex(sync_age=0xFFFF, batt=4012, level=-123, peak=-45)))
        self.assertIsNone(fields["sync_age_s"])
        self.assertEqual(fields["batt_mv"], 4012)
        self.assertAlmostEqual(fields["level_db"], -12.3)
        self.assertAlmostEqual(fields["max_db"], -4.5)

    def test_sync_value(self):
        fields = decode_health(bytes.fromhex(health_hex(sync_age=4)))
        self.assertAlmostEqual(fields["sync_age_s"], 0.4)

    def test_short_payload_is_not_decoded(self):
        self.assertIsNone(decode_health(b"\x00\x01"))

    def test_sync_none_shows_in_status(self):
        stats = LinkStats(start=0.0)
        stats.feed(9.0, rec(NODE, 1, rtype=2, payload=health_hex(sync_age=0xFFFF)))
        line = status_line(stats, 10.0, 10.0, "5m")
        self.assertIn("sync none", line)
        self.assertIn("batt 4012mV", line)


class FollowAndSpacingTest(unittest.TestCase):
    def test_first_node_is_followed_others_listed(self):
        stats = LinkStats(start=0.0)
        stats.feed(1.0, rec(0x1111, 1))
        stats.feed(1.5, rec(NODE, 7))
        stats.feed(2.0, rec(0x1111, 2))
        self.assertEqual(stats.node, 0x1111)
        self.assertEqual(len(stats.recs), 2)
        self.assertEqual(stats.others, {NODE})

    def test_spacing_reminder_is_given_once(self):
        out = io.StringIO()
        session = RangeSession(out, start=0.0)
        for i in range(6):
            session.handle(5.0 * i, rec(NODE, i + 1))
        note = session.period_note()
        self.assertIn("node sends every 5 s", note)
        self.assertIn("health.period_s 1", note)
        self.assertIsNone(session.period_note())

    def test_no_reminder_for_one_second_node(self):
        out = io.StringIO()
        session = RangeSession(out, start=0.0)
        for i in range(10):
            session.handle(float(i), rec(NODE, i + 1))
        self.assertIsNone(session.period_note())


class SessionTest(unittest.TestCase):
    def test_writes_jsonl_with_marks(self):
        out = io.StringIO()
        session = RangeSession(out, window_s=10.0, start=0.0)
        session.handle(1.0, gw(10, 2))  # before any mark: mark is null
        session.set_mark(2.0, "50m")
        session.handle(3.0, rec(NODE, 1, payload=""))
        lines = [json.loads(x) for x in out.getvalue().splitlines()]
        self.assertEqual(len(lines), 3)
        self.assertIsNone(lines[0]["mark"])
        self.assertEqual(lines[1], {"k": "mark", "w": 2.0, "text": "50m", "mark": "50m"})
        self.assertEqual(lines[2]["mark"], "50m")
        self.assertEqual(lines[2]["i"], 1)

    def test_notes_and_summary(self):
        out = io.StringIO()
        session = RangeSession(out, start=0.0)
        session.set_mark(0.0, "10m")
        session.handle(1.0, rec(NODE, 1))
        session.handle(2.0, rec(0x2222, 9))
        notes = session.drain_notes()
        self.assertEqual(notes[0], f"following node {NODE:04x}")
        self.assertIn("also heard node 2222", notes[1])
        self.assertEqual(session.drain_notes(), [])
        table = session.summary(now=10.0)
        self.assertIn("10m", table[-1])
        self.assertEqual(table[0].split()[0], "mark")

    def test_empty_summary(self):
        session = RangeSession(io.StringIO(), start=0.0)
        self.assertEqual(session.summary(now=1.0), ["no marks typed; nothing to summarise"])

    def test_default_out_path_in_field_dir(self):
        path = rangetest.default_out_path(0.0)
        self.assertEqual(os.path.basename(os.path.dirname(path)), "field")
        self.assertTrue(os.path.basename(path).startswith("range-"))
        self.assertTrue(path.endswith(".jsonl"))


if __name__ == "__main__":
    unittest.main()
