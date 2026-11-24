"""Radio range walk: one sensor node on a power bank sends HEALTH records; the gateway board is on USB in a
laptop, and the operator walks away typing a mark (the distance) at each stop.

  sm range [--port P] [--node fb98] [--out FILE] [--duration S] [--window S]

Every 2 s a status line shows the followed node over the last --window seconds: records heard against
expected (expected = heard + record id gaps), rssi, copies per record, the node's sync state and battery.
Typing a line makes it the current mark; "q", Ctrl-C or --duration ends the walk and prints one row per mark.
Every gateway rec and gw line and every mark is written to --out as JSONL, with the current mark added.

The statistics live in LinkStats and take host times and parsed lines, so they can be tested without
hardware. RangeSession joins them to the output file; the serial and stdin glue is in cmd_range.
"""

import json
import os
import statistics
import struct
import sys
import threading
import time
from collections import namedtuple
from datetime import datetime

from . import DATA_DIR
from . import device
from .device import Board, DeviceError
import smlog  # the one HEALTH decoder (smlog.dec_health); importing it keeps the two in step

STATUS_PERIOD_S = 2.0
SILENCE_S = 5.0  # no record for longer than this is NO SIGNAL
REPEATS = 5  # radio.repeats: the node sends each record this many times
SPACING_WARN_S = 2.0  # a median record spacing above this suggests a slow test rate
SPACING_SAMPLE = 50  # records used for the spacing median
HEALTH_TYPE = 2
HEALTH_LEN = struct.calcsize("<IhhHHHHH")  # the bytes smlog.dec_health reads
ID_MOD = 1 << 16  # record ids are uint16 and wrap
RESTART_JUMP = 1000  # an id step above this (mod 2**16) is a node restart, not lost records

Rec = namedtuple("Rec", "wall rid rssi rtype health lost")


# ---- pure helpers ------------------------------------------------------------------------------

def id_gap(prev, cur):
    """Records missed between two consecutive record ids of one node. Returns (lost, restarted)."""
    step = (cur - prev) % ID_MOD
    if step <= 1:
        return 0, False  # the next record (step 1), or the same id again
    if step > RESTART_JUMP:
        return 0, True  # the node rebooted and its counter jumped; not countable as loss
    return step - 1, False


def decode_health(payload):
    """Fields of a HEALTH payload (sync_age_s is None when the node is not synced), or None if short."""
    if len(payload) < HEALTH_LEN:
        return None
    fields, _ = smlog.dec_health(payload)
    return fields


def _median(values):
    return statistics.median(values) if values else None


def _summarise(recs):
    """Counts and rssi of a list of Rec (in time order)."""
    received = len(recs)
    lost = sum(r.lost for r in recs)
    expected = received + lost
    rssi = [r.rssi for r in recs]
    healths = [r.health for r in recs if r.health is not None]
    synced = sum(1 for h in healths if h["sync_age_s"] is not None)
    return {
        "received": received,
        "lost": lost,
        "expected": expected,
        "lost_pct": 100.0 * lost / expected if expected else None,
        "rssi_med": _median(rssi),
        "rssi_min": min(rssi) if rssi else None,
        "rssi_max": max(rssi) if rssi else None,
        "health": healths[-1] if healths else None,
        "sync_ok": synced / len(healths) if healths else None,
    }


def _fmt(value, spec, none="-"):
    return none if value is None else format(value, spec)


def _sync_text(sync_s):
    return "sync none" if sync_s is None else f"sync {sync_s:.1f}s"


# ---- statistics --------------------------------------------------------------------------------

class LinkStats:
    """Records of the followed node, gateway counters and marks, all keyed by host time (seconds).

    Copies per record come from the gateway counters: delta(frames) / delta(recs) between two gw lines.
    That is only right while one node is on air; the counters include every node's records, so other
    nodes heard are listed in `others` and the caller should warn about them.
    """

    def __init__(self, node=None, start=0.0):
        self.node = node  # node id (int) being followed; None until the first record
        self.start = start
        self.recs = []  # Rec, followed node only, in arrival order
        self.gw = []  # (wall, frames, recs) from gw lines
        self.marks = []  # (wall, text)
        self.others = set()  # other node ids heard
        self.restarts = 0
        self._last_id = None

    def feed(self, wall, obj):
        kind = obj.get("k")
        if kind == "gw":
            self.gw.append((wall, int(obj["frames"]), int(obj["recs"])))
        elif kind == "rec":
            self._rec(wall, obj)

    def _rec(self, wall, obj):
        node = int(obj["n"])
        if self.node is None:
            self.node = node
        if node != self.node:
            self.others.add(node)
            return
        rid = int(obj["i"])
        lost = 0
        if self._last_id is not None:
            lost, restarted = id_gap(self._last_id, rid)
            if restarted:
                self.restarts += 1
        self._last_id = rid
        rtype = int(obj["t"])
        health = decode_health(bytes.fromhex(obj.get("p", ""))) if rtype == HEALTH_TYPE else None
        self.recs.append(Rec(wall, rid, int(obj["rssi"]), rtype, health, lost))

    def mark(self, wall, text):
        self.marks.append((wall, text))

    def silence(self, now):
        """Seconds since the followed node was last heard (since the start if it never was)."""
        if self.recs:
            return now - self.recs[-1].wall
        return now - self.start

    def spacing_s(self):
        """Median time between the last records of the followed node, or None with too few."""
        walls = [r.wall for r in self.recs[-SPACING_SAMPLE:]]
        diffs = [b - a for a, b in zip(walls, walls[1:])]
        return statistics.median(diffs) if len(diffs) >= 2 else None

    def _copies_between(self, t0, t1):
        """Copies per record between the gw lines at or before t0 and at or before t1, or None."""
        base = last = None
        for sample in self.gw:
            if sample[0] <= t0:
                base = sample
            if sample[0] <= t1:
                last = sample
        if base is None or last is None or last is base:
            return None
        d_frames = last[1] - base[1]
        d_recs = last[2] - base[2]
        if d_frames < 0 or d_recs <= 0:  # the gateway rebooted between the two lines
            return None
        return d_frames / d_recs

    def window(self, now, window_s):
        """Statistics of the last window_s seconds, plus copies and the age of the last record."""
        lo = now - window_s
        recs = [r for r in self.recs if lo < r.wall <= now]
        d = _summarise(recs)
        d["copies"] = self._copies_between(lo, now)
        d["age"] = now - self.recs[-1].wall if self.recs else None
        return d

    def mark_rows(self, end):
        """One summary per mark: each mark covers the records from its time up to the next mark (or end)."""
        rows = []
        for i, (t0, text) in enumerate(self.marks):
            t1 = self.marks[i + 1][0] if i + 1 < len(self.marks) else end
            recs = [r for r in self.recs if t0 <= r.wall < t1]
            row = _summarise(recs)
            row.update(mark=text, at_s=t0 - self.start, copies=self._copies_between(t0, t1))
            rows.append(row)
        return rows


def status_line(stats, now, window_s, mark_text):
    """The status line, or the NO SIGNAL line when the followed node has been silent too long."""
    head = f"[{mark_text or '-'}] {datetime.fromtimestamp(now).strftime('%H:%M:%S')}"
    silence = stats.silence(now)
    if silence > SILENCE_S:
        return f"{head}  NO SIGNAL for {silence:.0f}s"
    w = stats.window(now, window_s)
    recv = f"recv {w['received']}/{w['expected']}"
    if w["lost_pct"] is not None:
        recv += f" ({w['lost_pct']:.0f}% lost)"
    parts = [recv]
    if w["rssi_med"] is not None:
        parts.append(f"rssi {w['rssi_med']:.0f} med / {w['rssi_min']} min")
    else:
        parts.append("rssi -")
    if w["copies"] is None:
        parts.append("copies -")
    else:
        parts.append(f"copies {w['copies']:.1f}/{REPEATS}")
    h = w["health"]
    if h is None:
        parts += ["sync -", "batt -"]
    else:
        parts += [_sync_text(h["sync_age_s"]), f"batt {h['batt_mv']}mV"]
    if w["age"] is not None:
        parts.append(f"last {w['age']:.1f}s ago")
    return head + "  " + "  ".join(parts)


def spacing_note(stats):
    """The advice to speed the node up when its records are far apart, or None."""
    s = stats.spacing_s()
    if s is None or s <= SPACING_WARN_S:
        return None
    return (f"node sends every {s:.0f} s; set health.period_s 1 on it for a finer test "
            "(tools/sm set --port P health.period_s=1)")


def summary_lines(rows):
    """The table printed at the end: one row per mark."""
    if not rows:
        return ["no marks typed; nothing to summarise"]
    lines = [f"{'mark':<18} {'at':>7}  {'recv':>5} {'lost':>6}  {'rssi med / min / max':<22} "
             f"{'copies':>7}  {'sync ok':>7}"]
    for r in rows:
        lost = "-" if r["lost_pct"] is None else f"{r['lost_pct']:.0f}%"
        if r["rssi_med"] is None:
            rssi = "-"
        else:
            rssi = f"{r['rssi_med']:.0f} / {r['rssi_min']} / {r['rssi_max']}"
        copies = _fmt(r["copies"], ".1f")
        sync = "-" if r["sync_ok"] is None else f"{100 * r['sync_ok']:.0f}%"
        lines.append(f"{r['mark']:<18} {r['at_s']:>6.0f}s  {r['received']:>5} {lost:>6}  "
                     f"{rssi:<22} {copies:>7}  {sync:>7}")
    return lines


# ---- session: lines and marks in, file and status text out -------------------------------------

class RangeSession:
    """Joins the statistics to the JSONL output. Called from the reader thread and the main loop."""

    def __init__(self, out, node=None, window_s=10.0, start=0.0):
        self.out = out
        self.window_s = window_s
        self.stats = LinkStats(node=node, start=start)
        self.mark_text = None
        self.notes = []
        self._lock = threading.Lock()
        self._announced = False
        self._others_seen = set()
        self._reminded = False

    def _write(self, obj):
        self.out.write(json.dumps(obj, separators=(",", ":")) + "\n")
        self.out.flush()

    def handle(self, wall, obj):
        """One parsed gateway line. Only rec and gw lines are kept."""
        if obj.get("k") not in ("rec", "gw"):
            return
        with self._lock:
            self._write({**obj, "mark": self.mark_text})
            self.stats.feed(wall, obj)
            self._check_nodes()

    def set_mark(self, wall, text):
        with self._lock:
            self.mark_text = text
            self.stats.mark(wall, text)
            self._write({"k": "mark", "w": round(wall, 3), "text": text, "mark": text})

    def _check_nodes(self):
        st = self.stats
        if st.node is not None and not self._announced:
            self._announced = True
            self.notes.append(f"following node {st.node:04x}")
        for n in sorted(st.others - self._others_seen):
            self._others_seen.add(n)
            self.notes.append(f"also heard node {n:04x}; copies per record are only valid "
                              "while one node is on air")

    def status(self, now):
        with self._lock:
            return status_line(self.stats, now, self.window_s, self.mark_text)

    def drain_notes(self):
        with self._lock:
            notes, self.notes = self.notes, []
            return notes

    def period_note(self):
        """The spacing advice, given once per run."""
        with self._lock:
            if self._reminded:
                return None
            note = spacing_note(self.stats)
            if note:
                self._reminded = True
            return note

    def summary(self, now):
        with self._lock:
            return summary_lines(self.stats.mark_rows(now))


# ---- command -----------------------------------------------------------------------------------

def default_out_path(when):
    stamp = datetime.fromtimestamp(when).strftime("%Y%m%d-%H%M%S")
    return os.path.join(DATA_DIR, "field", f"range-{stamp}.jsonl")


def _role(port):
    """The role a board reports on its port, or None if it does not answer."""
    board = None
    try:
        board = Board(port).open()
        return board.info()["role"]
    except Exception:
        return None
    finally:
        if board is not None:
            board.close()


def _pick_gateway():
    for port in device.list_ports():
        if _role(port) == "gateway":
            return port
    return None


def _read_marks(session, quit_flag):
    """Each typed line is a mark; "q" ends the walk. End of input just stops reading."""
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        if text == "q":
            quit_flag.set()
            return
        session.set_mark(time.time(), text)


def cmd_range(args):
    port = args.port or _pick_gateway()
    if port is None:
        print("sm range: no gateway board found (use --port)", file=sys.stderr)
        return 2
    node = None
    if args.node:
        try:
            node = int(args.node, 16)
        except ValueError:
            print(f"sm range: --node {args.node!r} is not a hex node id", file=sys.stderr)
            return 2
    out_path = args.out or default_out_path(time.time())
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    start = time.time()
    board = Board(port)
    with open(out_path, "a", encoding="utf-8") as out:
        session = RangeSession(out, node=node, window_s=args.window, start=start)
        try:
            board.open()
            info = board.info()
        except DeviceError as exc:
            board.close()
            print(f"sm range: {exc}", file=sys.stderr)
            return 1
        if info.get("role") != "gateway":
            print(f"sm range: {port} is a {info.get('role')} board, not a gateway; no records will come",
                  file=sys.stderr)
        board.add_listener(lambda b, wall, raw, obj: obj is not None and session.handle(wall, obj))

        print(f"range walk on {port}, writing {out_path}")
        print("type a mark (the distance) and press Enter; q quits, Ctrl-C also ends the walk")
        quit_flag = threading.Event()
        threading.Thread(target=_read_marks, args=(session, quit_flag), daemon=True).start()
        end_at = start + args.duration if args.duration else None
        next_status = 0.0
        try:
            while not quit_flag.is_set():
                now = time.time()
                for note in session.drain_notes():
                    print(note)
                if now >= next_status:
                    print(session.status(now))
                    note = session.period_note()
                    if note:
                        print(note)
                    next_status = now + STATUS_PERIOD_S
                if end_at is not None and now >= end_at:
                    break
                quit_flag.wait(0.2)
        except KeyboardInterrupt:
            pass
        finally:
            board.close()
        print()
        print("\n".join(session.summary(time.time())))
    return 0


def add_parser(subparsers):
    q = subparsers.add_parser("range", help="radio range walk: follow a node's records while walking away")
    q.add_argument("--port", help="gateway port (default: the first gateway board found)")
    q.add_argument("--node", metavar="HEX", help="node id to follow, e.g. fb98 (default: the first node heard)")
    q.add_argument("--out", metavar="FILE", help="JSONL file (default: data/field/range-<time>.jsonl)")
    q.add_argument("--duration", type=float, metavar="SECONDS", help="stop after this long")
    q.add_argument("--window", type=float, default=10.0, metavar="SECONDS",
                   help="status window in seconds (default 10)")
    q.set_defaults(func=cmd_range)
