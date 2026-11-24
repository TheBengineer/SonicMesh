"""One SonicMesh board over its USB shell. The shell protocol is in firmware/lib/shell_cmds.c.

A command is sent as text ending in CRLF. Its answer is JSON lines and ends with exactly one
{"k":"ok","c":"<command>"} or {"k":"err","c":"<command>","e":<errno>,"m":"<message>"}. Between answers the
board also sends unsolicited lines: trace lines ("tr"), radio records ("rec" from a gateway, or "tr" with
s "rec" from a node), gateway lines ("gw", "sync", "boot") and human log text. Each JSON object is found
by searching its line for the text {"k"; the shell prompt and terminal escapes before it are ignored.

A Board runs one reader thread. Every line goes to the listeners with its host receive time. Lines that
answer the pending command are also collected for it. Commands are serialised. If the serial port fails
the reader closes it and retries once a second; a command in flight then times out.
"""

import glob
import json
import sys
import threading
import time
from dataclasses import dataclass

BAUD = 115200
JSON_START = '{"k"'
ANSWER_KINDS = frozenset(("info", "status", "param", "trace", "send", "ok", "err"))
MAX_PARTIAL = 65536
VALUE_CHUNK = 14  # sm param set takes up to 30 arguments: 14 name and value pairs
SET_TOLERANCE = 1e-5
EAGAIN = -11
BOOT_WAIT_S = 10.0
CLEAR_LINE ="\x15"  # Ctrl-U: the shell empties its input line
WRITE_PIECE = 32
WRITE_GAP_S = 0.003
RETRY_SAFE =frozenset(("info", "status", "param", "trace"))  # commands that give the same result if run twice


class DeviceError(RuntimeError):
    """The board did not answer as expected."""


class CommandError(DeviceError):
    """The board answered a command with an err line."""

    def __init__(self, command, errno, message):
        super().__init__(f"{command}: error {errno}: {message}")
        self.command = command
        self.errno = errno
        self.message = message


class CommandTimeout(DeviceError):
    """No ok or err line came for a command in time."""


@dataclass
class Reply:
    lines: list
    ok: bool
    error: dict = None


@dataclass
class RecordLine:
    """One radio record seen on a line: from a gateway "rec" line or a node's "rec" trace."""

    source: str  # "gateway" or "node"
    node: int
    rid: int
    rtype: int
    payload: bytes
    local_us: int = None  # node clock, node trace only
    gateway_us: int = None  # gateway clock, gateway lines only


def parse_json(text):
    """The JSON object in one raw shell line, or None. Anything before {"k" is ignored."""
    start = text.find(JSON_START)
    if start < 0:
        return None
    try:
        obj = json.loads(text[start:].strip())
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def record_line(obj):
    """RecordLine for a gateway rec line or a node rec trace line, else None."""
    kind = obj.get("k")
    if kind == "rec":
        return RecordLine("gateway", int(obj["n"]), int(obj["i"]), int(obj["t"]),
                          bytes.fromhex(obj.get("p", "")), gateway_us=obj.get("g"))
    if kind == "tr" and obj.get("s") == "rec" and "ty" in obj:
        # Node trace: "t" is the trace's local time, so the record type is "ty".
        return RecordLine("node", int(obj["n"]), int(obj["i"]), int(obj["ty"]),
                          bytes.fromhex(obj.get("p", "")), local_us=int(obj["t"]))
    return None


def command_name(text):
    """The name a command answers with: "param set", "trace", "info" ..."""
    words = text.split()
    if words and words[0] == "sm":
        words = words[1:]
    if not words:
        return ""
    if words[0] == "param" and len(words) > 1:
        return "param " + words[1]
    return words[0]


def fmt_value(value):
    """A value as the shell takes it: integers without a decimal point."""
    number = float(value)
    return str(int(number)) if number.is_integer() else repr(number)


def list_ports():
    return sorted(glob.glob("/dev/ttyACM*"))


def _open_serial(port):
    import serial  # pyserial, imported here so the tests need not have it

    ser = serial.Serial(port, BAUD, timeout=0.05)
    ser.dtr = True
    return ser


def _find(lines, kind):
    for obj in lines:
        if obj.get("k") == kind:
            return obj
    raise DeviceError(f"no {kind!r} line in the answer")


class Board:
    """A board on one serial port. Create with a serial_factory(port) in tests."""

    def __init__(self, port, serial_factory=None):
        self.port = port
        self._factory = serial_factory or _open_serial
        self._ser = None
        self._stop = threading.Event()
        self._thread = None
        self._write_lock = threading.Lock()
        self._cmd_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._pending = None
        self._answer = []
        self._final = None
        self._done = None
        self._listeners = []
        self.connected = False
        self.node_id = None
        self.role = None

    # ---- connection ------------------------------------------------------------------------

    def open(self):
        """Opens the port now (raises if it fails) and starts the reader thread."""
        self._connect()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name=f"reader {self.port}", daemon=True)
        self._thread.start()
        return self

    def close(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(2.0)
        self._drop()

    def add_listener(self, fn):
        """fn(board, wall, raw_line, obj) is called for every line; obj is None for non-JSON text."""
        self._listeners.append(fn)

    def remove_listener(self, fn):
        if fn in self._listeners:
            self._listeners.remove(fn)

    def _connect(self):
        self._ser = self._factory(self.port)
        self.connected = True

    def _drop(self):
        ser, self._ser = self._ser, None
        self.connected = False
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass

    def _run(self):
        buf = b""
        while not self._stop.is_set():
            if self._ser is None:
                try:
                    self._connect()
                except Exception:
                    self._stop.wait(1.0)
                continue
            try:
                data = self._ser.read(4096)
            except Exception:  # serial errors: close, then reopen in the loop above
                self._drop()
                buf = b""
                self._stop.wait(0.5)
                continue
            if not data:
                continue
            buf += data
            while True:
                end = buf.find(b"\n")
                if end < 0:
                    break
                raw, buf = buf[:end], buf[end + 1:]
                self._line(raw.decode("utf-8", "replace").rstrip("\r"))
            if len(buf) > MAX_PARTIAL:
                buf = b""

    def _line(self, raw):
        wall = time.time()
        obj = parse_json(raw)
        if obj is not None:
            obj["w"] = round(wall, 3)
            self._route(obj)
        for fn in list(self._listeners):
            try:
                fn(self, wall, raw, obj)
            except Exception as exc:  # a listener must not stop the reader
                print(f"smtool: {self.port}: listener failed: {exc}", file=sys.stderr)

    def _route(self, obj):
        kind = obj.get("k")
        with self._state_lock:
            if self._pending is None:
                return
            if kind in ("ok", "err") and obj.get("c") == self._pending:
                self._final = obj
                self._pending = None
                self._done.set()
            elif kind in ANSWER_KINDS:
                self._answer.append(obj)

    def _write(self, text):
        with self._write_lock:
            ser = self._ser
            if ser is None:
                raise DeviceError(f"{self.port} is not connected")
            # Ctrl-U first clears anything left in the shell's line from an earlier, damaged command.
            # Long lines go in pieces: the shell drops input bytes while it redraws the line around
            # log output, and the remains of a line then prefix the next command.
            data = (CLEAR_LINE + text + "\r\n").encode("ascii")
            try:
                for i in range(0, len(data), WRITE_PIECE):
                    ser.write(data[i:i + WRITE_PIECE])
                    if i + WRITE_PIECE < len(data):
                        time.sleep(WRITE_GAP_S)
            except Exception as exc:
                self._drop()
                raise DeviceError(f"{self.port}: write failed: {exc}") from exc

    # ---- commands --------------------------------------------------------------------------

    def command(self, text, timeout=5.0):
        """Sends one shell line and returns its Reply. Raises DeviceError if the port is down."""
        name = command_name(text)
        with self._cmd_lock:
            done = threading.Event()
            with self._state_lock:
                self._pending, self._answer, self._final, self._done = name, [], None, done
            try:
                self._write(text)
                finished = done.wait(timeout)
            finally:
                with self._state_lock:
                    answer, final = self._answer, self._final
                    self._pending, self._answer, self._final, self._done = None, [], None, None
            if not finished or final is None:
                raise CommandTimeout(f"{self.port}: no answer to '{text}' within {timeout} s")
            if final["k"] == "err":
                return Reply(answer, False, final)
            return Reply(answer, True)

    def call(self, text, timeout=5.0):
        """Like command, but raises CommandError on an err line and returns the answer lines.
        A command that is safe to run twice is sent once more if no answer came: now and then the
        board gives no answer to a line (seen while it was printing its status block every second)."""
        # Right after a reset the board refuses param commands with EAGAIN until its saved values
        # are loaded (about 1.8 s), then prints a burst of start-up logs in which a command can be
        # lost. Once it has said it is starting, keep asking until BOOT_WAIT_S has passed.
        safe = command_name(text).split()[0] in RETRY_SAFE
        timeouts = 0
        booting_until = None
        while True:
            try:
                reply = self.command(text, timeout)
            except CommandTimeout:
                timeouts += 1
                booting = booting_until is not None and time.monotonic() < booting_until
                if not safe or (timeouts > 1 and not booting):
                    raise
                continue
            if reply.ok or reply.error.get("e") != EAGAIN:
                break
            if booting_until is None:
                booting_until = time.monotonic() + BOOT_WAIT_S
            if time.monotonic() >= booting_until:
                break
            time.sleep(0.25)
        if not reply.ok:
            raise CommandError(text, reply.error.get("e"), reply.error.get("m"))
        return reply.lines

    def info(self):
        info = _find(self.call("sm info"), "info")
        self.node_id = int(info["node"], 16)
        self.role = info["role"]
        return info

    def params(self, prefix=""):
        """Every parameter: dicts with n, type, v, def, min, max, help."""
        cmd = "sm param list" + (f" {prefix}" if prefix else "")
        return [p for p in self.call(cmd) if p.get("k") == "param"]

    def get(self, names):
        values = {}
        names = list(names)
        for i in range(0, len(names), 16):
            for p in self.call("sm param get " + " ".join(names[i:i + 16])):
                if p.get("k") == "param":
                    values[p["n"]] = p["v"]
        return values

    def set(self, values, verify=True):
        """Sets RAM values and checks each echo. The board sets a command's pairs all or none, but
        more than VALUE_CHUNK pairs take several commands, and a failure leaves earlier ones set."""
        items = list(values.items())
        echoed = {}
        for i in range(0, len(items), VALUE_CHUNK):
            chunk = items[i:i + VALUE_CHUNK]
            args = " ".join(f"{n} {fmt_value(v)}" for n, v in chunk)
            try:
                lines = self.call("sm param set " + args)
            except CommandError as exc:
                if i == 0:
                    raise
                raise CommandError(exc.command, exc.errno,
                                   f"{exc.message} (the first {i} values were already set)") from exc
            echo = {p["n"]: p["v"] for p in lines if p.get("k") == "param"}
            echoed.update(echo)
            if verify:
                for n, v in chunk:
                    got = echo.get(n)
                    if got is None or abs(got - float(v)) > SET_TOLERANCE * max(1.0, abs(float(v))):
                        raise DeviceError(f"{self.port}: {n} set to {v} but the board says {got}")
        return echoed

    def save(self):
        self.call("sm param save", timeout=15.0)

    def reset(self, name=None):
        self.call("sm param reset" + (f" {name}" if name else ""))

    def traces(self):
        return [t for t in self.call("sm trace") if t.get("k") == "trace"]

    def trace_set(self, levels):
        """levels: {stream: level}. Streams not named keep their level."""
        if levels:
            self.call("sm trace " + " ".join(f"{n} {int(v)}" for n, v in levels.items()))

    def trace_off(self):
        self.call("sm trace off")
