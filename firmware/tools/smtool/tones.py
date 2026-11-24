"""Deploy tones: the phone plays a short 8-FSK frame, the node decodes it and reports it over the radio.

Reference for docs/deploy-tones.md. The phone page, this module and the node detector
(firmware/detectors/deploy_tones/) must all agree on the constants below.

  sm tones wav --mark N [--rate 48000] OUT.wav    write one send (3 frames) as 16-bit WAV
  sm tones decode IN.wav                          run the decoder on a WAV file and print the reports
  sm tones merge --phone marks.json --log LOG.jsonl [--log ...] [--out nodes.json]
                                                  join TONE records to the phone's marks by mark number

Signal: tone k (0..7) is 1500 + 250 k Hz, 48 ms symbols with 4 ms raised-cosine ramps. A frame is 12
symbols: the preamble 0,7,0,7, then the 16-bit word and its CRC-8 as 8 symbols of 3 bits, MSB first.
"""

import argparse
import json
import math
import struct
import sys
import wave
from collections import namedtuple
from datetime import datetime, timezone

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from . import audio

# ---- signal constants (must match the phone page and the firmware detector) -----------------------

TONE_BASE_HZ = 1500.0
TONE_STEP_HZ = 250.0
TONE_COUNT = 8
TONE_FREQS = np.array([TONE_BASE_HZ + TONE_STEP_HZ * k for k in range(TONE_COUNT)])
SYMBOL_S = 0.048
RAMP_S = 0.004
PREAMBLE = (0, 7, 0, 7)
FRAME_SYMBOLS = 12
GAP_S = 0.250
REPEATS = 3

# ---- decoder constants -------------------------------------------------------------------------------

RATE = 16000  # decoder rate; other rates are resampled to this
WIN = 256  # analysis window, samples (16 ms)
HOP = 128  # hop, samples (8 ms)
HOPS_PER_SYMBOL = 6
HISTORY_HOPS = FRAME_SYMBOLS * HOPS_PER_SYMBOL  # 72 hops, one frame
MID_FIRST = 1  # a symbol's decision uses hops 1..4 of its 6
MID_LAST = 4
MIN_RATIO = 6.0  # power ratio, 7.8 dB
REPEAT_S = 5.0

CMD_MARK = 1
CMD_SHIFT = 12
ARG_MASK = 0x0FFF
TONE_TYPE = 0x12
TONE_FMT = "<IBHhh"  # u32 time, u8 tflags, u16 word, i16 level_db10, i16 ratio_db10

Report = namedtuple("Report", "word start_sample level_dbfs min_ratio_db")


# ---- framing -----------------------------------------------------------------------------------------

def crc8(data):
    """CRC-8/SMBUS: polynomial 0x07, initial 0, no reflection, no final XOR. crc8(b"123456789") == 0xF4."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def mark_word(n):
    """Word for a MARK command with mark number n (0..4095)."""
    if not 0 <= n <= ARG_MASK:
        raise ValueError(f"mark number {n} out of range 0..{ARG_MASK}")
    return (CMD_MARK << CMD_SHIFT) | n


def word_symbols(word):
    """The 12 tone indexes of a frame carrying word: preamble, then word and CRC-8 in 3-bit groups."""
    if not 0 <= word <= 0xFFFF:
        raise ValueError(f"word {word} out of range")
    bits = (word << 8) | crc8(bytes([word >> 8, word & 0xFF]))  # 24 bits
    data = [(bits >> (3 * (7 - j))) & 0x7 for j in range(8)]
    return list(PREAMBLE) + data


def _ramp(n_ramp):
    """Rising raised-cosine ramp of n_ramp samples, from 0 up to (not including) 1."""
    return 0.5 - 0.5 * np.cos(np.pi * np.arange(n_ramp) / n_ramp)


def synth_symbols(symbols, rate=48000, repeats=REPEATS, amplitude=0.9):
    """The send for a list of tone indexes: the frame played `repeats` times with gaps. float32, [-1, 1]."""
    sym_n = int(round(SYMBOL_S * rate))
    ramp_n = int(round(RAMP_S * rate))
    gap_n = int(round(GAP_S * rate))
    env = np.ones(sym_n)
    env[:ramp_n] = _ramp(ramp_n)
    env[-ramp_n:] = _ramp(ramp_n)[::-1]
    pieces = []
    base = 0  # sample index of the current symbol, so the sine is phase continuous
    for rep in range(repeats):
        for k in symbols:
            t = (base + np.arange(sym_n)) / rate
            pieces.append(amplitude * env * np.sin(2 * np.pi * TONE_FREQS[k] * t))
            base += sym_n
        if rep < repeats - 1:
            pieces.append(np.zeros(gap_n))
            base += gap_n
    return np.concatenate(pieces).astype(np.float32)


def synth(word, rate=48000, repeats=REPEATS, amplitude=0.9):
    """The full send of one word: 3 frames with 250 ms gaps, about 2.2 s."""
    return synth_symbols(word_symbols(word), rate=rate, repeats=repeats, amplitude=amplitude)


# ---- decoder -----------------------------------------------------------------------------------------

_HANN = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(WIN) / WIN)  # periodic Hann, sum 128
_BASIS = np.exp(-2j * np.pi * TONE_FREQS[None, :] * np.arange(WIN)[:, None] / RATE) * _HANN[:, None]


def _tone_powers(windows):
    """Power at each tone frequency for rows of windows (n, WIN). Goertzel-equivalent at exact frequencies."""
    return np.abs(windows @ _BASIS) ** 2


def _full_scale_reference():
    """Sum over hops 1..4 of the tone power for a full-scale sine at each tone, the analysis' 0 dB point."""
    n = HOP * (MID_LAST + 1) + WIN - HOP  # hops 0..4 fully inside the signal
    t = np.arange(n) / RATE
    refs = []
    for k in range(TONE_COUNT):
        x = np.sin(2 * np.pi * TONE_FREQS[k] * t)
        windows = sliding_window_view(x, WIN)[::HOP][:MID_LAST + 1]
        p = _tone_powers(windows)
        refs.append(p[MID_FIRST:MID_LAST + 1, k].sum())
    return float(np.mean(refs))


FULL_SCALE_POWER = _full_scale_reference()


LOOKAHEAD_HOPS = 5  # after a passing test, this many more hops are tested before one is chosen


class Decoder:
    """Streaming decoder. feed() takes 16 kHz samples (float in [-1, 1], or int16) in any chunk sizes.

    Sample indexes are absolute, counted from the first sample fed. Reports accumulate in self.reports
    and are also returned by feed() or flush(). A passing test is not reported at once: the next
    LOOKAHEAD_HOPS hops are tested too, and the passing test with the highest minimum dominance (the
    earliest on a tie) is the one reported. Call flush() at the end of a stream.
    """

    def __init__(self):
        self.reports = []
        self._pending = np.zeros(0)  # samples from absolute index _base on
        self._base = 0
        self._next_hop = 0  # next hop whose window is not yet analysed
        self._hops = 0  # hops analysed so far
        self._hist = np.zeros((HISTORY_HOPS, TONE_COUNT))  # tone powers, oldest row first
        self._skip_until = -1  # frame tests up to this hop are ignored after a report
        self._last_report = {}  # word -> start sample of its last report
        self._best = None  # best passing test in the current lookahead
        self._best_until = -1  # last hop of the lookahead

    def feed(self, samples):
        x = np.asarray(samples)
        if np.issubdtype(x.dtype, np.integer):
            x = x.astype(np.float64) / 32768.0
        else:
            x = x.astype(np.float64)
        self._pending = np.concatenate((self._pending, x))
        end = self._base + len(self._pending)
        n_ready = (end - WIN) // HOP + 1 if end >= WIN else 0  # hops with a complete window
        count = n_ready - self._next_hop
        out = []
        if count <= 0:
            return out
        offset = self._next_hop * HOP - self._base
        seg = self._pending[offset:offset + (count - 1) * HOP + WIN]
        powers = _tone_powers(sliding_window_view(seg, WIN)[::HOP])
        for row in powers:
            self._hist[:-1] = self._hist[1:]
            self._hist[-1] = row
            hop = self._hops
            self._hops += 1
            if self._hops >= HISTORY_HOPS:
                out.extend(self._step(hop))
        self._next_hop = n_ready
        new_base = self._next_hop * HOP
        self._pending = self._pending[new_base - self._base:]
        self._base = new_base
        return out

    def flush(self):
        """Ends the stream: reports a passing test still waiting for its lookahead."""
        return self._finish() if self._best is not None else []

    def _step(self, hop):
        """Handles the frame test at one hop. Returns the reports finished at this hop."""
        if self._best is None and hop <= self._skip_until:
            return []
        result = self._test_frame()
        if result is not None:
            word, ratios, s_max = result
            min_ratio = float(ratios.min())
            if self._best is None:
                self._best = (min_ratio, hop, word, ratios, s_max)
                self._best_until = hop + LOOKAHEAD_HOPS
            elif min_ratio > self._best[0]:
                self._best = (min_ratio, hop, word, ratios, s_max)
        if self._best is not None and hop >= self._best_until:
            return self._finish()
        return []

    def _finish(self):
        """Reports the chosen test of the lookahead (unless it repeats a recent report)."""
        _, hop, word, ratios, s_max = self._best
        self._best = None
        self._skip_until = hop + HISTORY_HOPS - 1
        start = (hop - (HISTORY_HOPS - 1)) * HOP  # hop 0 of the frame
        last = self._last_report.get(word)
        if last is not None and start - last < REPEAT_S * RATE:
            return []
        self._last_report[word] = start
        level = 10 * math.log10(max(float(np.mean(s_max)), 1e-30) / FULL_SCALE_POWER)
        rep = Report(word, start, level, 10 * math.log10(max(float(ratios.min()), 1e-30)))
        self.reports.append(rep)
        return [rep]

    def _test_frame(self):
        """Frame test for the 72 hops in the history. Returns (word, ratios, s_max) or None."""
        s = self._hist.reshape(FRAME_SYMBOLS, HOPS_PER_SYMBOL, TONE_COUNT)[:, MID_FIRST:MID_LAST + 1, :].sum(axis=1)
        d = s.argmax(axis=1)
        if tuple(int(v) for v in d[:4]) != PREAMBLE:
            return None
        rows = np.arange(FRAME_SYMBOLS)
        s_max = s[rows, d]
        others = (s.sum(axis=1) - s_max) / (TONE_COUNT - 1)
        ratios = s_max / np.maximum(others, 1e-300)
        if np.any(ratios < MIN_RATIO):
            return None
        bits = 0
        for v in d[4:]:
            bits = (bits << 3) | int(v)
        word, crc = bits >> 8, bits & 0xFF
        if crc8(bytes([word >> 8, word & 0xFF])) != crc:
            return None
        return word, ratios, s_max[4:]


def decode_wav(path):
    """Reports of a WAV file (any rate, resampled to 16 kHz; channels averaged)."""
    rate, x = audio.read_wav(path)
    if rate != RATE:
        x = audio.resample(x, rate, RATE)
    dec = Decoder()
    reports = dec.feed(x)
    return reports + dec.flush()


def write_wav(path, samples, rate):
    """16-bit mono WAV from float samples in [-1, 1]."""
    pcm = np.clip(np.round(np.asarray(samples, dtype=np.float64) * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


# ---- merge with the gateway log ----------------------------------------------------------------------

def parse_time(text):
    """ISO 8601 time as unix seconds. A time without a zone is taken as UTC (the phone page sends Z)."""
    s = text.strip()
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def load_marks(obj):
    """Phone entries from a marks file: a list, or an object with a "marks" list. Times become unix seconds."""
    entries = obj.get("marks", []) if isinstance(obj, dict) else obj
    marks = []
    for e in entries:
        marks.append({"mark": int(e["mark"]), "time": e["time"], "t": parse_time(e["time"]),
                      "lat": float(e["lat"]), "lon": float(e["lon"]), "acc": float(e["acc"])})
    return marks


def merge(phone_marks, gateway_lines, unmatched=None):
    """Node positions from TONE records. phone_marks are from load_marks(); gateway_lines are parsed
    JSON objects of the gateway log. Returns one dict per node, sorted by node id.

    A record matches the phone entry with the same mark number, the nearest in time to the record's
    wall time "w" when the number was used more than once. Records that match nothing are appended to
    `unmatched` when a list is given. A node with several marks keeps the one with the latest phone
    time; the others are listed under "other_marks".
    """
    by_mark = {}
    for m in phone_marks:
        by_mark.setdefault(m["mark"], []).append(m)
    seen = set()
    per_node = {}
    for obj in gateway_lines:
        if not isinstance(obj, dict) or obj.get("k") != "rec" or obj.get("dup"):
            continue
        if int(obj.get("t", -1)) != TONE_TYPE:
            continue
        node, rid, gw = int(obj["n"]), int(obj["i"]), obj.get("g")
        key = (node, rid, gw)
        if key in seen:  # the same record in two log files
            continue
        seen.add(key)
        payload = bytes.fromhex(obj.get("p", ""))
        if len(payload) < struct.calcsize(TONE_FMT):
            continue
        _, _, word, level10, ratio10 = struct.unpack_from(TONE_FMT, payload)
        if word >> CMD_SHIFT != CMD_MARK:
            continue
        mark = word & ARG_MASK
        candidates = by_mark.get(mark)
        if not candidates:
            if unmatched is not None:
                unmatched.append({"node": f"{node:04x}", "mark": mark, "w": obj.get("w")})
            continue
        wall = obj.get("w")
        if wall is None or len(candidates) == 1:
            phone = candidates[0]
        else:
            phone = min(candidates, key=lambda c: abs(c["t"] - float(wall)))
        per_node.setdefault(node, []).append(
            {"mark": mark, "lat": phone["lat"], "lon": phone["lon"], "acc": phone["acc"],
             "level_db_spl": level10 / 10.0, "ratio_db": ratio10 / 10.0, "time": phone["time"], "_t": phone["t"]})

    nodes = []
    for node in sorted(per_node):
        entries = sorted(per_node[node], key=lambda e: e["_t"])
        for e in entries:
            del e["_t"]
        latest = entries[-1]
        nodes.append({"node": f"{node:04x}", **latest, "other_marks": entries[:-1]})
    return nodes


# ---- command line ------------------------------------------------------------------------------------

def _read_log(path):
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue  # not a JSON line (smlog writes only JSON, but be tolerant)


def cmd_wav(args):
    write_wav(args.out, synth(mark_word(args.mark), rate=args.rate), args.rate)
    print(f"wrote mark {args.mark} ({args.rate} Hz, {REPEATS} frames) to {args.out}")
    return 0


def cmd_decode(args):
    reports = decode_wav(args.file)
    print(f"{'start s':>9}  {'word':>6}  {'mark':>5}  {'level dBFS':>10}  {'ratio dB':>8}")
    for r in reports:
        cmd = r.word >> CMD_SHIFT
        mark = str(r.word & ARG_MASK) if cmd == CMD_MARK else "-"
        print(f"{r.start_sample / RATE:9.3f}  {r.word:#06x}  {mark:>5}  {r.level_dbfs:10.1f}  {r.min_ratio_db:8.1f}")
    print(f"{len(reports)} report(s)")
    return 0


def cmd_merge(args):
    with open(args.phone, encoding="utf-8") as fh:
        marks = load_marks(json.load(fh))
    lines = []
    for path in args.log:
        lines.extend(_read_log(path))
    unmatched = []
    nodes = merge(marks, lines, unmatched)
    print(f"{'node':<6} {'mark':>5} {'lat':>11} {'lon':>11} {'acc m':>6} {'SPL dB':>7} {'ratio dB':>8}  time")
    for n in nodes:
        print(f"{n['node']:<6} {n['mark']:>5} {n['lat']:>11.6f} {n['lon']:>11.6f} {n['acc']:>6.1f} "
              f"{n['level_db_spl']:>7.1f} {n['ratio_db']:>8.1f}  {n['time']}"
              + (f"  (+{len(n['other_marks'])} other)" if n["other_marks"] else ""))
    print(f"{len(nodes)} node(s), {len(unmatched)} tone record(s) with no phone mark")
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(nodes, fh, indent=2)
        fh.write("\n")
    print(f"wrote {args.out}")
    return 0


def add_parser(subparsers):
    top = subparsers.add_parser("tones", help="deploy tones: make, decode and merge the phone's tone marks")
    tsub = top.add_subparsers(dest="tones_cmd", metavar="{wav,decode,merge}")

    q = tsub.add_parser("wav", help="write one send (MARK N) as a 16-bit WAV")
    q.add_argument("--mark", type=int, required=True, help="mark number 0..4095")
    q.add_argument("--rate", type=int, default=48000, help="sample rate of the WAV (default 48000)")
    q.add_argument("out", metavar="OUT.wav")
    q.set_defaults(func=cmd_wav)

    q = tsub.add_parser("decode", help="run the decoder on a WAV file and print the reports")
    q.add_argument("file", metavar="IN.wav")
    q.set_defaults(func=cmd_decode)

    q = tsub.add_parser("merge", help="join TONE records to the phone's marks by mark number")
    q.add_argument("--phone", required=True, metavar="marks.json", help="phone marks: a list or {\"marks\": [...]}")
    q.add_argument("--log", action="append", required=True, metavar="LOG.jsonl", help="gateway log (repeatable)")
    q.add_argument("--out", default="nodes.json", metavar="nodes.json")
    q.set_defaults(func=cmd_merge)

    top.set_defaults(func=lambda args: (top.print_help(), 1)[1])
    return top
