"""Fake serial ports for the tests: a board that answers the shell, and a node that streams trace lines."""

import os
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))


class FakeSerial:
    """Answers each written line with the bytes responder(line) returns, delivered on read()."""

    def __init__(self, responder):
        self.responder = responder
        self.rx = bytearray()
        self.lock = threading.Lock()
        self.written = []
        self.closed = False

    def write(self, data):
        # Board._write sends Ctrl-U, then the command in pieces; answer once the line is complete.
        self.tx = getattr(self, "tx", "") + data.decode("ascii")
        if not self.tx.endswith("\r\n"):
            return len(data)
        text, self.tx = self.tx.replace("\x15", "").rstrip("\r\n"), ""
        self.written.append(text)
        out = self.responder(text)
        with self.lock:
            self.rx.extend(out)
        return len(data)

    def feed(self, data):
        with self.lock:
            self.rx.extend(data)

    def read(self, n):
        with self.lock:
            if self.rx:
                chunk = bytes(self.rx[:n])
                del self.rx[:n]
                return chunk
        time.sleep(0.005)
        return b""

    def close(self):
        self.closed = True


class FakeNode(FakeSerial):
    """A node shell: answers info, params and traces, and while tracing streams comb lines and one SHOT
    record (sent as a node rec trace line, as the firmware writes it)."""

    def __init__(self, node_id=0x00AB, params=None, shot_after_s=0.15):
        self.params = dict(params or {"gunshot.ratio_db": 12.0, "drone_comb.theta": 0.1})
        self.node_id = node_id
        self.shot_after_s = shot_after_s
        self.tracing_since = None
        self.stop = threading.Event()
        super().__init__(self._respond)
        self._feeder = threading.Thread(target=self._feed, daemon=True)
        self._feeder.start()

    def close(self):
        self.stop.set()
        super().close()

    def _respond(self, text):
        ok = lambda c: f'{{"k":"ok","c":"{c}"}}\r\n'
        if text == "sm info":
            return (f'{{"k":"info","role":"node","node":"{self.node_id:04x}","up_ms":1,"params":2,'
                    f'"traces":2}}\r\n' + ok("info")).encode()
        if text == "sm param list":
            body = "".join(f'{{"k":"param","n":"{n}","type":"float","v":{v},"def":{v},"min":0,"max":99,'
                           f'"help":"x"}}\r\n' for n, v in self.params.items())
            return (body + ok("param list")).encode()
        if text.startswith("sm param get "):
            body = "".join(f'{{"k":"param","n":"{n}","v":{self.params[n]}}}\r\n'
                           for n in text.split()[3:])
            return (body + ok("param get")).encode()
        if text.startswith("sm param set "):
            parts = text.split()[3:]
            body = ""
            for i in range(0, len(parts), 2):
                self.params[parts[i]] = float(parts[i + 1])
                body += f'{{"k":"param","n":"{parts[i]}","v":{parts[i + 1]}}}\r\n'
            return (body + ok("param set")).encode()
        if text.startswith("sm trace off"):
            self.tracing_since = None
            return ok("trace").encode()
        if text.startswith("sm trace "):
            if self.tracing_since is None:
                self.tracing_since = time.time()
            return ok("trace").encode()
        return f'{{"k":"err","c":"{text}","e":-2,"m":"unknown"}}\r\n'.encode()

    def _feed(self):
        t0 = time.time()
        shot_sent = False
        while not self.stop.is_set():
            time.sleep(0.02)
            if self.tracing_since is None:
                continue
            now = time.time()
            local = int((now - t0) * 1e6)
            self.feed(f'{{"k":"tr","s":"comb","t":{local},"on":0}}\r\n'.encode())
            if not shot_sent and now - self.tracing_since >= self.shot_after_s:
                shot_sent = True
                payload = struct.pack("<IB", local, 0) + struct.pack("<hh", 1321, 243)
                self.feed((f'{{"k":"tr","s":"rec","t":{local},"n":{self.node_id},"nt":-1,"ty":17,"i":9,'
                           f'"p":"{payload.hex()}"}}\r\n').encode())


class FakeCaptureNode(FakeNode):
    """A FakeNode that also answers `sm capture`: a sine streamed as pcm lines of 512 samples, with a prompt
    and escapes before some lines, comb trace lines and a text line between them, and one block (drop)
    never sent. finish=False never sends the final line (a dead stream). stop ends the stream early."""

    def __init__(self, drop=None, finish=True, freq=440.0, amp=1000, first_sample=10240, **kwargs):
        self.drop = drop
        self.finish = finish
        self.freq = freq
        self.amp = amp
        self.first_sample = first_sample
        self.cap_stop = threading.Event()
        self.streams = 0
        super().__init__(**kwargs)

    def _respond(self, text):
        if text.startswith("sm capture"):
            arg = text.split()[2]
            if arg == "stop":
                self.cap_stop.set()
                return b'{"k":"ok","c":"capture"}\r\n'
            seconds = float(arg)
            blocks = int(seconds * 16000 / 512 + 0.5)
            self.cap_stop.clear()
            self.streams += 1
            threading.Thread(target=self._stream, args=(blocks,), daemon=True).start()
            return (f'{{"k":"ok","c":"capture","blocks":{blocks},"n":512,"rate":16000}}\r\n').encode()
        return super()._respond(text)

    def _stream(self, blocks):
        import base64
        import numpy as np

        time.sleep(0.05)  # the ok line goes out first
        n = np.arange(blocks * 512)
        x = np.round(self.amp * np.sin(2 * np.pi * self.freq * n / 16000)).astype("<i2")
        sent = 0
        for i in range(blocks):
            if self.cap_stop.is_set() or self.stop.is_set():
                break
            if i == self.drop:
                continue
            d = base64.b64encode(x[i * 512:(i + 1) * 512].tobytes()).decode()
            s = self.first_sample + 512 * i
            t = 7_000_000 + int(i * 512 * 1e6 / 16000)
            prefix = "sm> \x1b[K" if i % 4 == 0 else ""
            self.feed((f'{prefix}{{"k":"pcm","s":{s},"t":{t},"n":512,"d":"{d}"}}\r\n').encode())
            if i % 5 == 2:
                self.feed((f'{{"k":"tr","s":"comb","t":{t},"on":0}}\r\n').encode())
                self.feed(b"DRONE on  f0 300.0 Hz\r\n")
            sent += 1
            time.sleep(0.002)
        if self.finish:
            gaps = 1 if (self.drop is not None and self.drop < blocks) else 0
            self.feed(f'sm> {{"k":"capture","blocks":{sent},"gaps":{gaps},"rate_hz":15999.25}}\r\n'.encode())
