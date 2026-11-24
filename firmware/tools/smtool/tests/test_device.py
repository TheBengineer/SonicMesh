"""Board protocol against a fake serial port: prompts, escapes, echo, unsolicited lines, errors, timeouts."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import threading
import time
import unittest

from fakes import FakeSerial
from smtool import device
from smtool.device import Board, CommandError, CommandTimeout, DeviceError


def shell(responses):
    """responder that echoes the command, then the canned lines for it (prompt and escapes first)."""
    def respond(text):
        body = responses.get(text, '{"k":"err","c":"?","e":-2,"m":"unknown"}\r\n')
        return (b"\r\n" + text.encode() + b"\r\n" + body.encode())
    return respond


def open_board(responder):
    fake = FakeSerial(responder)
    board = Board("/dev/fake", serial_factory=lambda port: fake).open()
    return board, fake


class ParseTests(unittest.TestCase):
    def test_prompt_and_escapes_are_ignored(self):
        obj = device.parse_json('sm> \x1b[4D\x1b[J{"k":"tr","s":"audio","t":5,"db":40.1}')
        self.assertEqual(obj, {"k": "tr", "s": "audio", "t": 5, "db": 40.1})

    def test_text_without_json_and_broken_json(self):
        self.assertIsNone(device.parse_json("DRONE on  f0 300.0 Hz"))
        self.assertIsNone(device.parse_json('{"k":"ok","c":'))

    def test_command_names(self):
        self.assertEqual(device.command_name("sm info"), "info")
        self.assertEqual(device.command_name("sm param set a 1"), "param set")
        self.assertEqual(device.command_name("sm trace comb 1"), "trace")

    def test_rec_trace_time_and_type(self):
        obj = device.parse_json('{"k":"tr","s":"rec","t":123456,"n":171,"ty":16,"i":9,"p":"0102"}')
        rec = device.record_line(obj)
        self.assertEqual(rec.source, "node")
        self.assertEqual((rec.local_us, rec.rtype, rec.node, rec.rid), (123456, 0x10, 171, 9))
        self.assertEqual(rec.payload, b"\x01\x02")

    def test_gateway_rec_line(self):
        rec = device.record_line({"k": "rec", "g": 7, "n": 3, "f": 1, "rssi": -60, "t": 17, "i": 4, "p": "ff"})
        self.assertEqual((rec.source, rec.node, rec.rtype, rec.gateway_us), ("gateway", 3, 17, 7))


class CommandTests(unittest.TestCase):
    def test_reply_lines_exclude_unsolicited_and_prompt_junk(self):
        info = '{"k":"info","role":"node","node":"00ab","up_ms":5,"params":3,"traces":2}\r\n'
        ok = '{"k":"ok","c":"info"}\r\n'
        noise = ('{"k":"tr","s":"comb","t":1,"on":0}\r\n'
                 'DRONE on  f0 300.0 Hz\r\n'
                 '{"k":"rec","g":9,"n":5,"t":17,"i":2,"p":""}\r\n')
        board, fake = open_board(lambda text: (b"sm> " + noise.encode() + info.encode() + ok.encode()
                                               + b"\r\n" if text == "sm info" else b""))
        try:
            lines = board.call("sm info")
            self.assertEqual([x["k"] for x in lines], ["info"])
            board.info()
            self.assertEqual(board.node_id, 0xAB)
            self.assertEqual(board.role, "node")
            self.assertEqual(fake.written, ["sm info", "sm info"])
        finally:
            board.close()

    def test_unsolicited_lines_reach_listeners_with_host_time(self):
        seen = []
        board, _ = open_board(lambda text: b'{"k":"tr","s":"audio","t":7}\r\nlog text\r\n'
                              b'{"k":"ok","c":"trace"}\r\n')
        board.add_listener(lambda b, wall, raw, obj: seen.append((raw, obj)))
        try:
            board.call("sm trace")
            deadline = time.time() + 2
            while len(seen) < 3 and time.time() < deadline:
                time.sleep(0.01)
            raws = [r for r, _ in seen]
            self.assertIn("log text", raws)
            tr = [o for _, o in seen if o and o.get("s") == "audio"][0]
            self.assertIn("w", tr)
        finally:
            board.close()

    def test_err_line_becomes_command_error(self):
        err = '{"k":"err","c":"param set","e":-2,"m":"out of range"}\r\n'
        board, _ = open_board(lambda text: err.encode() if text.startswith("sm param set") else b"")
        try:
            reply = board.command("sm param set drone_comb.theta 9")
            self.assertFalse(reply.ok)
            self.assertEqual(reply.error["e"], -2)
            with self.assertRaises(CommandError) as ctx:
                board.call("sm param set drone_comb.theta 9")
            self.assertEqual(ctx.exception.errno, -2)
            self.assertEqual(ctx.exception.message, "out of range")
        finally:
            board.close()

    def test_no_answer_times_out(self):
        board, _ = open_board(lambda text: b"")
        try:
            with self.assertRaises(CommandTimeout):
                board.command("sm info", timeout=0.2)
        finally:
            board.close()

    def test_set_verifies_echo_and_chunks_long_lists(self):
        values = {f"gunshot.p{i}": i * 0.5 for i in range(20)}

        def respond(text):
            if not text.startswith("sm param set "):
                return b""
            parts = text.split()[3:]
            out = "".join('{"k":"param","n":"%s","v":%s}\r\n' % (parts[i], parts[i + 1])
                          for i in range(0, len(parts), 2))
            return (out + '{"k":"ok","c":"param set"}\r\n').encode()

        board, fake = open_board(respond)
        try:
            echoed = board.set(values)
            self.assertEqual(len(fake.written), 2)
            self.assertEqual(echoed["gunshot.p3"], 1.5)
        finally:
            board.close()

    def test_set_detects_a_board_that_did_not_take_the_value(self):
        def respond(text):
            if text.startswith("sm param set"):
                return b'{"k":"param","n":"gunshot.ratio_db","v":12}\r\n{"k":"ok","c":"param set"}\r\n'
            return b""

        board, _ = open_board(respond)
        try:
            with self.assertRaises(DeviceError):
                board.set({"gunshot.ratio_db": 15})
        finally:
            board.close()

    def test_fmt_value(self):
        self.assertEqual(device.fmt_value(3.0), "3")
        self.assertEqual(device.fmt_value(0.12), "0.12")


if __name__ == "__main__":
    unittest.main()
