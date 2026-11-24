#!/usr/bin/env python3
"""smlog: log and decode SonicMesh gateway output on USB serial.

Live:    smlog.py --port /dev/ttyACM1 [--out data/field/x.jsonl] [--names nodes.json] [--quiet]
Replay:  smlog.py --replay data/field/x.jsonl
Checks:  smlog.py --selftest

The gateway prints one JSON object per line. Lines that do not start with '{' or do not parse are
ignored. Each "rec" line is a radio record; it is checked against a window of recent ids per node
(the id wraps at 65536) and duplicates are marked "dup": true and not printed. Every line is written
to the output with a decoded "d" field, plus "w" (host receive time, unix seconds).

Adding a record type (the spec is firmware/include/sonicmesh/records.h):
  1. Document the payload in records.h.
  2. Add one entry to RECORD_TYPES: code -> (name, decoder). A decoder takes the payload bytes,
     after the 5-byte timed header if the type is in TIMED, and returns (fields, text): fields is a
     dict of JSON-friendly values with units applied, text is the human summary. Use
     struct.unpack_from so bytes added by newer firmware are ignored.
  3. If the record is timed (starts with t_us and tflags), add its code to TIMED.
  4. Add a hand-built payload to selftest().

Unknown types are shown as hex. A timed record whose tflags bit 0 is set gets "t_net_us": t_us
unwrapped to 64-bit network time, nearest to the gateway clock g of the same line.
"""

import argparse
import collections
import contextlib
import datetime
import io
import json
import os
import struct
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIELD_DIR = os.path.join(ROOT, "data", "field")
SEEN_PER_NODE = 256
STATUS_PERIOD_S = 10.0
TIME_WRAP = 1 << 32
NO_SYNC_AGE = 0xFFFF
TFLAG_NET = 0x01
DRONE_STATES = {1: "start", 2: "update", 3: "end"}


def dec_sync(b):
    label, period = struct.unpack_from("<IH", b)
    return {"label_us": label, "period_ms": period}, f"label {label}us  period {period}ms"


def dec_health(b):
    up, level, peak, clips, drops, batt, sync_age, build = struct.unpack_from("<IhhHHHHH", b)
    sync_s = None if sync_age == NO_SYNC_AGE else sync_age / 10
    fields = {"uptime_s": up, "level_db": level / 10, "max_db": peak / 10, "clips": clips,
              "drops": drops, "batt_mv": batt, "sync_age_s": sync_s, "build": build}
    sync_txt = "none" if sync_s is None else f"{sync_s:.1f}s"
    text = (f"uptime {up}s  level {level / 10:.1f} dB  max {peak / 10:.1f} dB  clips {clips}"
            f"  drops {drops}  batt {batt}mV  sync {sync_txt}  build {build}")
    return fields, text


def dec_drone(b):
    state, f0, nharm, score, band = struct.unpack_from("<BHBHh", b)
    name = DRONE_STATES.get(state, str(state))
    fields = {"state": name, "f0_hz": f0 / 10, "nharm": nharm, "score": score / 1000,
              "band_db": band / 10}
    text = (f"{name}  f0 {f0 / 10:.1f} Hz  nharm {nharm}  score {score / 1000:.3f}"
            f"  band {band / 10:.1f} dB")
    return fields, text


def dec_shot(b):
    peak, rise = struct.unpack_from("<hh", b)
    return {"peak_db": peak / 10, "rise_db": rise / 10}, \
        f"peak {peak / 10:.1f} dB  rise {rise / 10:.1f} dB"


def dec_tone(b):
    word, level, ratio = struct.unpack_from("<Hhh", b)
    cmd, arg = word >> 12, word & 0xFFF
    fields = {"word": word, "cmd": cmd, "arg": arg, "level_db": level / 10, "ratio_db": ratio / 10}
    return fields, f"word 0x{word:04x} (cmd {cmd} arg {arg})  level {level / 10:.1f} dB SPL" \
        f"  dominance {ratio / 10:.1f} dB"


def dec_unknown(b):
    return {"hex": b.hex()}, f"len {len(b)}  {b.hex()}"


# hwinfo RESET_* bits (zephyr/drivers/hwinfo.h) that the firmware reports as "cause".
RESET_BITS = [
    (0x001, "reset pin"),
    (0x002, "software"),
    (0x004, "brownout"),
    (0x008, "power-on"),
    (0x010, "watchdog"),
    (0x020, "debug"),
    (0x100, "cpu lockup"),
]


def reset_names(cause):
    """Names for the set bits of a hwinfo reset cause. Bits not listed above are shown as hex."""
    names = [name for bit, name in RESET_BITS if cause & bit]
    known = sum(bit for bit, _ in RESET_BITS)
    if cause & ~known:
        names.append(f"other 0x{cause & ~known:x}")
    return names or ["none"]


def boot_text(cause, crashes):
    return (f"GATEWAY BOOT cause=0x{cause:x} ({'+'.join(reset_names(cause))})"
            f" crashes={crashes}")


# type code -> (name, decoder). See the module docstring to add one.
RECORD_TYPES = {
    0x01: ("SYNC", dec_sync),
    0x02: ("HEALTH", dec_health),
    0x10: ("DRONE", dec_drone),
    0x11: ("SHOT", dec_shot),
    0x12: ("TONE", dec_tone),
}
TIMED = {0x10, 0x11, 0x12}


def unwrap_time(t, g):
    """Nearest 64-bit time to gateway clock g that has the 32-bit low part t. Never negative."""
    k = max(0, (g - t + TIME_WRAP // 2) // TIME_WRAP)
    return t + k * TIME_WRAP


def decode_record(rtype, payload, g=None):
    """Returns (name, fields, text) for one record payload (the bytes after the record header)."""
    name, dec = RECORD_TYPES.get(rtype, (f"T{rtype:02X}", dec_unknown))
    fields, prefix, body = {}, "", payload
    try:
        if rtype in TIMED:
            t_us, tflags = struct.unpack_from("<IB", payload)
            body = payload[5:]
            fields.update(t_us=t_us, tflags=tflags)
            net = bool(tflags & TFLAG_NET)
            if net and g is not None:
                fields["t_net_us"] = unwrap_time(t_us, g)
            prefix = f"t={t_us}us {'net' if net else 'own'}  "
        extra, text = dec(body)
        fields.update(extra)
    except struct.error:
        text = f"short payload  {payload.hex()}"
        fields["error"] = "short payload"
    return name, fields, prefix + text


class Dedup:
    """Remembers the last SEEN_PER_NODE record ids of each node."""

    def __init__(self):
        self.per_node = {}

    def is_new(self, node, rid):
        order, ids = self.per_node.setdefault(node, (collections.deque(), set()))
        if rid in ids:
            return False
        order.append(rid)
        ids.add(rid)
        if len(order) > SEEN_PER_NODE:
            ids.discard(order.popleft())
        return True


def fmt_time(wall):
    if wall is None:
        return "--:--:--.---"
    stamp = datetime.datetime.fromtimestamp(wall)
    return stamp.strftime("%H:%M:%S.") + f"{stamp.microsecond // 1000:03d}"


class Status:
    def __init__(self, names):
        self.names = names
        self.nodes = {}

    def label(self, node):
        return self.names.get(str(node), f"{node:04x}")

    def see(self, node, rssi, wall, health=None):
        s = self.nodes.setdefault(node, {"count": 0, "health": None})
        s["count"] += 1
        s.update(wall=wall, rssi=rssi)
        if health and "uptime_s" in health:
            s["health"] = health

    def report(self):
        lines = [f"--- status {fmt_time(time.time())} ---"]
        for node, s in sorted(self.nodes.items()):
            line = (f"node {node} ({self.label(node)})  last {fmt_time(s['wall'])}"
                    f"  rssi {s['rssi']}  records {s['count']}")
            if s["health"]:
                h = s["health"]
                age = h["sync_age_s"]
                sync = "none" if age is None else f"{age:.1f}s"
                line += f"  | up {h['uptime_s']}s  level {h['level_db']:.1f} dB  sync {sync}"
            lines.append(line)
        print("\n".join(lines if self.nodes else lines + ["(no records yet)"]), flush=True)


class Logger:
    def __init__(self, names, out=None, quiet=False):
        self.names = names
        self.status = Status(names)
        self.dedup = Dedup()
        self.out = out
        self.quiet = quiet

    def handle(self, obj):
        kind = obj.get("k")
        wall = obj.get("w")
        text = None
        if kind == "rec":
            text = self._rec(obj, wall)
        elif kind == "sync":
            beacon, g = obj.get("b"), obj.get("g")
            obj["d"] = {"type": "GW_SYNC", "beacon": beacon, "g_us": g}
            text = f"{fmt_time(wall)}  gateway sync: {beacon} labels  gateway clock {g}us"
        elif kind == "boot":
            # Always shown, even with --quiet: a reboot of the gateway matters for the run.
            cause, crashes = int(obj.get("cause", 0)), int(obj.get("crashes", 0))
            obj["d"] = {"type": "GW_BOOT", "cause": cause, "cause_names": reset_names(cause),
                        "crashes": crashes}
            bar = "=" * 72
            banner = f"{bar}\n{boot_text(cause, crashes)}\n{bar}"
            if self.out:
                self.out.write(json.dumps(obj, separators=(",", ":")) + "\n")
                self.out.flush()
            print(banner, flush=True)
            return
        elif kind == "gw":
            fields = " ".join(f"{k}={v}" for k, v in obj.items() if k not in ("k", "w"))
            text = f"{fmt_time(wall)}  gw {fields}"
        if self.out:
            self.out.write(json.dumps(obj, separators=(",", ":")) + "\n")
            self.out.flush()
        if text and not self.quiet:
            print(text, flush=True)

    def _rec(self, obj, wall):
        node, rid, rtype = int(obj["n"]), int(obj["i"]), int(obj["t"])
        if not self.dedup.is_new(node, rid):
            obj["dup"] = True
            return None
        name, fields, text = decode_record(rtype, bytes.fromhex(obj.get("p", "")), int(obj["g"]))
        obj["d"] = dict(fields, type=name)
        self.status.see(node, obj.get("rssi"), wall, fields if rtype == 0x02 else None)
        return (f"{fmt_time(wall)}  node {node} ({self.status.label(node)})  {name:<6} {text}"
                f"  rssi {obj.get('rssi')}")


def parse_line(line):
    # The USB shell may put its prompt and terminal escapes before a line ("sm> \x1b[4D\x1b[J{...").
    start = line.find('{"k"')
    if start < 0:
        return None
    line = line[start:].strip()
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def parse_frame(hexstr):
    """Splits a raw BLE frame (the AD bytes from the length byte on) into its header and records."""
    b = bytes.fromhex(hexstr)
    if len(b) != b[0] + 1 or b[1] != 0xFF or struct.unpack_from("<H", b, 2)[0] != 0xFFFF:
        raise ValueError("not a SonicMesh manufacturer data frame")
    if b[4] != 0x53 or b[5] != 1:
        raise ValueError("bad magic or version")
    node, flags = struct.unpack_from("<HB", b, 6)
    records, pos = [], 9
    while pos < len(b):
        rtype, rlen, rid = b[pos], b[pos + 1], struct.unpack_from("<H", b, pos + 2)[0]
        if pos + 4 + rlen > len(b):
            raise ValueError("truncated record")
        records.append((rtype, rid, b[pos + 4:pos + 4 + rlen]))
        pos += 4 + rlen
    return node, flags, records


def selftest():
    def check(cond, what):
        if not cond:
            raise AssertionError(what)

    # Records, one per type, hand-built as firmware/include/sonicmesh/records.h describes.
    _, f, text = decode_record(0x01, struct.pack("<IH", 123456, 1000))
    check(f == {"label_us": 123456, "period_ms": 1000}, f"SYNC {f}")
    check(text == "label 123456us  period 1000ms", f"SYNC text {text!r}")
    _, f, _ = decode_record(0x01, struct.pack("<IH", 9, 1000) + b"\xAA\xBB")
    check(f == {"label_us": 9, "period_ms": 1000}, f"SYNC with extra bytes {f}")
    _, f, _ = decode_record(0x01, b"\x01\x02\x03")
    check(f.get("error") == "short payload", f"SYNC short {f}")

    health = struct.pack("<IhhHHHHH", 3600, -523, 812, 2, 5, 3970, 0xFFFF, 42)
    _, f, text = decode_record(0x02, health)
    check(f["uptime_s"] == 3600 and f["level_db"] == -52.3 and f["max_db"] == 81.2, f"HEALTH {f}")
    check(f["sync_age_s"] is None and f["build"] == 42 and f["clips"] == 2, f"HEALTH {f}")
    _, f, _ = decode_record(0x02, struct.pack("<IhhHHHHH", 1, 0, 0, 0, 0, 0, 25, 1))
    check(f["sync_age_s"] == 2.5, f"HEALTH sync {f}")

    drone = struct.pack("<IB", 123456789, 0) + struct.pack("<BHBHh", 2, 1234, 5, 812, -45)
    name, f, _ = decode_record(0x10, drone, g=123456790)
    check(name == "DRONE" and f["t_us"] == 123456789 and "t_net_us" not in f, f"DRONE {f}")
    check(f["state"] == "update" and f["f0_hz"] == 123.4 and f["nharm"] == 5, f"DRONE {f}")
    check(f["score"] == 0.812 and f["band_db"] == -4.5, f"DRONE {f}")

    shot = struct.pack("<IB", 0x12345678, TFLAG_NET) + struct.pack("<hh", 1321, 243)
    name, f, text = decode_record(0x11, shot, g=0x12345678 + 2 * TIME_WRAP)
    check(name == "SHOT" and f["peak_db"] == 132.1 and f["rise_db"] == 24.3, f"SHOT {f}")
    check(f["t_net_us"] == 0x12345678 + 2 * TIME_WRAP, f"SHOT net time {f}")
    check("peak 132.1 dB  rise 24.3 dB" in text and text.startswith("t=305419896us net"), text)

    tone = struct.pack("<IB", 0x2000, 0) + struct.pack("<Hhh", 0x1000 | 7, 512, 78)
    name, f, text = decode_record(0x12, tone)
    check(name == "TONE" and f["t_us"] == 0x2000 and f["word"] == 0x1007, f"TONE {f}")
    check(f["cmd"] == 1 and f["arg"] == 7 and f["level_db"] == 51.2 and f["ratio_db"] == 7.8, f"TONE {f}")
    check("dominance 7.8 dB" in text and "word 0x1007 (cmd 1 arg 7)" in text, f"TONE text {text!r}")

    name, f, _ = decode_record(0x55, b"\x01\x02")
    check(name == "T55" and f == {"hex": "0102"}, f"unknown {f}")
    _, f, _ = decode_record(0x11, b"\x00\x00")
    check(f.get("error") == "short payload", f"truncated {f}")

    check(unwrap_time(10, TIME_WRAP + 5) == TIME_WRAP + 10, "unwrap forward")
    check(unwrap_time(TIME_WRAP - 16, 3 * TIME_WRAP + 7) == 3 * TIME_WRAP - 16, "unwrap back")
    check(unwrap_time(0xFFFFFFF0, 0x10) == 0xFFFFFFF0, "unwrap near zero")

    dedup = Dedup()
    check(dedup.is_new(1, 5) and not dedup.is_new(1, 5) and dedup.is_new(2, 5), "dedup")
    for rid in range(300):
        dedup.is_new(1, 1000 + rid)
    check(dedup.is_new(1, 5), "dedup forgets after 256 ids")

    check(parse_line("boot banner") is None and parse_line('{"k":"gw"') is None, "junk lines")
    check(parse_line('{"k":"sync","g":1,"b":2}') == {"k": "sync", "g": 1, "b": 2}, "json line")

    check(reset_names(0x1) == ["reset pin"], "reset pin")
    check(reset_names(0x101) == ["reset pin", "cpu lockup"], "two bits")
    check(reset_names(0) == ["none"], "no bits")
    check(reset_names(0x4000) == ["other 0x4000"], "unlisted bit")
    check(boot_text(0x1, 0) == "GATEWAY BOOT cause=0x1 (reset pin) crashes=0", boot_text(0x1, 0))

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        Logger({}, quiet=True).handle(parse_line('{"k":"boot","cause":1,"crashes":0}'))
    shown = out.getvalue()
    check("GATEWAY BOOT cause=0x1 (reset pin) crashes=0" in shown, f"boot line shown with quiet: {shown!r}")
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        Logger({}, quiet=False).handle(parse_line('{"k":"sync","g":5000000,"b":10}'))
    check("gateway sync: 10 labels  gateway clock 5000000us" in out.getvalue(), f"sync line {out.getvalue()!r}")
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        Logger({}, quiet=True).handle(parse_line('{"k":"sync","g":5000000,"b":10}'))
    check(out.getvalue() == "", "sync line is not printed under quiet")

    # Cross-check: one frame built by firmware/tests/host/test_wire.c (its "frame:" line).
    frame_hex = (
        "7affffff5301ab000211090201785634120185fff3000108010007000000f0debc0a42000300100dfe7f40"
        "420f000002d204052c03d3ff80401111a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9ba"
        "bbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf")
    node, flags, records = parse_frame(frame_hex)
    check(node == 0xAB and flags == 0x02, f"frame header {node} {flags}")
    check([(t, i, len(p)) for t, i, p in records] ==
          [(0x11, 0x0102, 9), (0x01, 0x0001, 8), (0x42, 0x0003, 0),
           (0x10, 0x7FFE, 13), (0x80, 0x1111, 64)], f"frame records {records}")
    decoded = {t: decode_record(t, p, g=None)[1] for t, _, p in records if t in RECORD_TYPES}
    check(decoded[0x11]["peak_db"] == -12.3 and decoded[0x11]["t_us"] == 0x12345678,
          f"C shot {decoded[0x11]}")
    # test_wire.c writes an 8-byte SYNC payload: 7, then 0x0ABCDEF0 (the old beacon and prev_us). Under
    # the current layout the label is the first word and the period the next 16 bits, 0xDEF0.
    check(decoded[0x01] == {"label_us": 7, "period_ms": 0xDEF0}, f"C sync {decoded[0x01]}")
    check(decoded[0x10]["f0_hz"] == 123.4 and decoded[0x10]["band_db"] == -4.5,
          f"C drone {decoded[0x10]}")
    check(decode_record(0x42, records[2][2])[1] == {"hex": ""}, "C unknown")

    print("smlog: selftest ok")
    return 0


def open_serial(port, wait=False):
    """Opens the gateway port. With wait, retries until it is back (gateway unplugged or reset)."""
    try:
        import serial
    except ImportError:
        sys.exit("smlog: --port needs pyserial. Install it with: pip install pyserial")
    while True:
        try:
            ser = serial.Serial(port, 115200, timeout=1)
            ser.dtr = True
            return ser
        except (serial.SerialException, OSError) as exc:
            if not wait:
                sys.exit(f"smlog: cannot open {port}: {exc}")
            time.sleep(1)


def load_names(path):
    if not path:
        return {}
    with open(path, encoding="utf-8") as fh:
        names = json.load(fh)
    if not isinstance(names, dict):
        sys.exit(f"smlog: {path} must be a JSON object mapping node id to name")
    return names


def run_replay(path, names, quiet):
    logger = Logger(names, quiet=quiet)
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            obj = parse_line(line)
            if obj is not None:
                logger.handle(obj)
    logger.status.report()


def run_live(args, names):
    path = args.out or os.path.join(FIELD_DIR, time.strftime("smlog-%Y%m%d-%H%M%S.jsonl"))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    ser = open_serial(args.port)
    print(f"smlog: {args.port} -> {path}", flush=True)
    last_report = time.monotonic()
    with open(path, "a", encoding="utf-8") as out:
        logger = Logger(names, out=out, quiet=args.quiet)
        try:
            while True:
                try:
                    raw = ser.readline()
                except Exception as exc:  # serial.SerialException or OSError: keep the log going
                    print(f"smlog: {args.port}: {exc}; reopening", flush=True)
                    try:
                        ser.close()
                    except Exception:
                        pass
                    time.sleep(1)
                    ser = open_serial(args.port, wait=True)
                    print(f"smlog: {args.port} reopened", flush=True)
                    continue
                if raw:
                    obj = parse_line(raw.decode("utf-8", errors="replace"))
                    if obj is not None:
                        obj["w"] = round(time.time(), 3)
                        logger.handle(obj)
                if time.monotonic() - last_report >= STATUS_PERIOD_S:
                    logger.status.report()
                    last_report = time.monotonic()
        except KeyboardInterrupt:
            print("\nsmlog: stopped", flush=True)
            logger.status.report()


def main(argv=None):
    p = argparse.ArgumentParser(description="Log and decode SonicMesh gateway serial output.")
    p.add_argument("--port", help="gateway serial port, e.g. /dev/ttyACM1")
    p.add_argument("--out", help="output JSONL (default data/field/smlog-YYYYmmdd-HHMMSS.jsonl)")
    p.add_argument("--names", help="JSON file mapping decimal node id to a friendly name")
    p.add_argument("--quiet", action="store_true", help="do not print lines, only the status")
    p.add_argument("--replay", metavar="FILE", help="decode and print an existing raw log")
    p.add_argument("--selftest", action="store_true", help="run the decoder self-test")
    args = p.parse_args(argv)

    if args.selftest:
        return selftest()
    names = load_names(args.names)
    if args.replay:
        run_replay(args.replay, names, args.quiet)
    elif args.port:
        run_live(args, names)
    else:
        p.error("give --port, --replay or --selftest")
    return 0


if __name__ == "__main__":
    sys.exit(main())
