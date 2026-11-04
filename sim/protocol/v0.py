# /// script
# requires-python = ">=3.11"
# dependencies = ["cryptography"]
# ///
"""Protocol v0 reference codec, the same pack/unpack as web/src/protocol.

Bit-packed payloads are LSB first; multi-byte fields are little-endian. The frame MIC is the
first four bytes of AES-CMAC over site id (2 B LE), full superframe counter (4 B LE) and the
frame from hdr through payload. This module becomes the gateway decoder in M4.

Run a self-check:  uv run sim/protocol/v0.py
"""
from __future__ import annotations

from cryptography.hazmat.primitives import cmac
from cryptography.hazmat.primitives.ciphers import algorithms

MESSAGE_TYPES = (
    "BEACON",
    "DETECT_START",
    "DETECT",
    "SNIPPET",
    "HEALTH",
    "RANGING_RESULT",
    "JOIN",
    "ACK",
)

TEST_SITE_KEY = bytes([0x53, 0x6F, 0x6E, 0x69, 0x63, 0x4D, 0x65, 0x73, 0x68, 0x2D, 0x74, 0x65, 0x73, 0x74, 0x30, 0x31])
TEST_SITE_ID = 0x534D

HEALTH_FIELDS = (
    ("battery", 8),
    ("solar", 8),
    ("temperature", 8),
    ("uptime", 16),
    ("micFloor", 8),
    ("micFlags", 4),
    ("wind", 8),
    ("detections", 12),
    ("tilt", 8),
    ("tamper", 4),
    ("beaconLink", 16),
    ("clock", 16),
    ("mesh", 12),
    ("gnss", 8),
    ("build", 16),
)


class BitWriter:
    def __init__(self) -> None:
        self.data = bytearray()
        self.bit = 0

    def u(self, value: int, width: int) -> None:
        v = max(0, int(value))
        for _ in range(width):
            if self.bit == 0:
                self.data.append(0)
            if v % 2:
                self.data[-1] |= 1 << self.bit
            v //= 2
            self.bit = (self.bit + 1) % 8

    def signed(self, value: int, width: int) -> None:
        self.u(int(value) & (2**width - 1), width)

    def bits(self, values) -> None:
        for b in values:
            self.u(1 if b else 0, 1)

    def finish(self) -> bytes:
        return bytes(self.data)


class BitReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.bit = 0

    @property
    def remaining(self) -> int:
        return len(self.data) * 8 - self.bit

    def signed(self, width: int) -> int:
        v = self.u(width)
        sign = 2 ** (width - 1)
        return v - 2**width if v >= sign else v

    def u(self, width: int) -> int:
        v = 0
        scale = 1
        for _ in range(width):
            byte = self.data[self.bit // 8]
            b = (byte >> (self.bit % 8)) & 1
            v += b * scale
            scale *= 2
            self.bit += 1
        return v


def encode_phy(phy: dict) -> int:
    return ((int(phy["sf"]) - 5) & 7) * 2 + (1 if int(phy["bw"]) == 500_000 else 0)


def decode_phy(v: int) -> dict:
    return {"sf": ((v >> 1) & 7) + 5, "bw": 500_000 if v & 1 else 125_000}


def _write_track(w: BitWriter, t: dict) -> None:
    w.u(t["id"], 8)
    w.u(int(round(t["x"] / 2)) + 2048, 12)
    w.u(int(round(t["y"] / 2)) + 2048, 12)
    w.u(int(round(t["z"] / 2)) + 2048, 12)
    w.u(int(round(t["vx"] / 0.5)) + 128, 8)
    w.u(int(round(t["vy"] / 0.5)) + 128, 8)
    w.u(int(round(t["vz"] / 0.5)) + 128, 8)
    w.u(t["time"], 16)
    # 84 listed bits; four reserved bits make the 11 B track state in the spec.
    w.u(0, 4)


def _read_track(r: BitReader) -> dict:
    track = {
        "id": r.u(8),
        "x": (r.u(12) - 2048) * 2,
        "y": (r.u(12) - 2048) * 2,
        "z": (r.u(12) - 2048) * 2,
        "vx": (r.u(8) - 128) * 0.5,
        "vy": (r.u(8) - 128) * 0.5,
        "vz": (r.u(8) - 128) * 0.5,
        "time": r.u(16),
    }
    r.u(4)
    return track


def encode_payload(msg: dict) -> bytes:
    w = BitWriter()
    kind = msg["type"]
    if kind == "BEACON":
        w.u(msg["counter"], 32)
        w.u(msg["gnssMs"], 40)
        w.u(msg["mode"], 1)
        w.u(encode_phy(msg["nextPhy"]), 4)
        w.u(len(msg["slotMap"]), 6)
        for s in msg["slotMap"]:
            w.u(s["node"], 8)
            w.u(s["action"], 3)
            w.u(s["arg"], 5)
        w.u(1 if msg.get("track") is not None else 0, 1)
        if msg.get("track") is not None:
            _write_track(w, msg["track"])
        w.u(len(msg["snippets"]), 3)
        for s in msg["snippets"]:
            w.u(s["node"], 8)
            w.u(s["requestId"], 8)
            w.u(s["startSample"], 32)
            w.u(s["lengthMs"], 8)
        w.u(len(msg["commands"]), 4)
        for c in msg["commands"]:
            w.u(c["id"], 8)
            w.u(c["arg"], 8)
    elif kind == "DETECT_START":
        w.u(msg["confidence"], 4)
        w.u(msg["level"], 6)
        w.u(msg["cls"], 3)
        w.u(msg["az"], 9)
        w.u(msg["el"], 5)
        w.u(msg["lineHz"], 11)
    elif kind == "DETECT":
        w.u(msg["confidence"], 4)
        w.u(msg["level"], 6)
        w.u(msg["az"], 9)
        w.u(msg["el"], 5)
        w.u(msg["bearingSigma"], 4)
        w.u(msg["line1Hz"], 11)
        w.u(msg["line2Delta"], 6)
        w.u(msg["cls"], 3)
        w.u(msg["clipReady"], 1)
        w.u(0, 7)
    elif kind == "SNIPPET":
        w.u(msg["requestId"], 8)
        w.u(msg["chunk"], 4)
        w.u(msg["chunks"], 4)
        w.u(msg["startSample"], 32)
        w.bits(msg["data"])
    elif kind == "HEALTH":
        for i, (_, width) in enumerate(HEALTH_FIELDS):
            w.u(msg["fields"][i] if i < len(msg["fields"]) else 0, width)
    elif kind == "RANGING_RESULT":
        w.u(len(msg["results"]), 4)
        for r in msg["results"]:
            w.u(r["id"], 8)
            w.u(r["rangeDm"], 16)
            w.u(r["rssi"], 8)
            w.u(r["snr"], 8)
    elif kind == "JOIN":
        w.signed(msg["lat"], 32)
        w.signed(msg["lon"], 32)
        w.u(msg["altDm"], 16)
        w.u(msg["accuracyDm"], 8)
        w.u(msg["confident"], 1)
        w.u(msg["nodeType"], 2)
        w.u(msg["provSeq"], 8)
        w.u(msg["provTime"], 40)
        w.u(msg["provMac"], 32)
    elif kind == "ACK":
        w.u(msg["commandId"], 8)
        w.u(msg["result"], 8)
    else:
        raise ValueError(f"unknown message type {kind}")
    return w.finish()


def decode_payload(kind: str, payload: bytes) -> dict:
    r = BitReader(payload)
    if kind == "BEACON":
        counter = r.u(32)
        gnss_ms = r.u(40)
        mode = r.u(1)
        next_phy = decode_phy(r.u(4))
        slots = [{"node": r.u(8), "action": r.u(3), "arg": r.u(5)} for _ in range(r.u(6))]
        track = _read_track(r) if r.u(1) else None
        snippets = [
            {"node": r.u(8), "requestId": r.u(8), "startSample": r.u(32), "lengthMs": r.u(8)}
            for _ in range(r.u(3))
        ]
        commands = [{"id": r.u(8), "arg": r.u(8)} for _ in range(r.u(4))]
        return {
            "type": kind,
            "counter": counter,
            "gnssMs": gnss_ms,
            "mode": mode,
            "nextPhy": next_phy,
            "slotMap": slots,
            "track": track,
            "snippets": snippets,
            "commands": commands,
        }
    if kind == "DETECT_START":
        return {
            "type": kind,
            "confidence": r.u(4),
            "level": r.u(6),
            "cls": r.u(3),
            "az": r.u(9),
            "el": r.u(5),
            "lineHz": r.u(11),
        }
    if kind == "DETECT":
        return {
            "type": kind,
            "confidence": r.u(4),
            "level": r.u(6),
            "az": r.u(9),
            "el": r.u(5),
            "bearingSigma": r.u(4),
            "line1Hz": r.u(11),
            "line2Delta": r.u(6),
            "cls": r.u(3),
            "clipReady": r.u(1),
        }
    if kind == "SNIPPET":
        request_id = r.u(8)
        chunk = r.u(4)
        chunks = r.u(4)
        start = r.u(32)
        data = []
        while r.remaining > 0:
            data.append(r.u(1))
        return {
            "type": kind,
            "requestId": request_id,
            "chunk": chunk,
            "chunks": chunks,
            "startSample": start,
            "data": data,
        }
    if kind == "HEALTH":
        return {"type": kind, "fields": [r.u(width) for _, width in HEALTH_FIELDS]}
    if kind == "RANGING_RESULT":
        results = [
            {"id": r.u(8), "rangeDm": r.u(16), "rssi": r.u(8), "snr": r.u(8)}
            for _ in range(r.u(4))
        ]
        return {"type": kind, "results": results}
    if kind == "JOIN":
        return {
            "type": kind,
            "lat": r.signed(32),
            "lon": r.signed(32),
            "altDm": r.u(16),
            "accuracyDm": r.u(8),
            "confident": r.u(1),
            "nodeType": r.u(2),
            "provSeq": r.u(8),
            "provTime": r.u(40),
            "provMac": r.u(32),
        }
    if kind == "ACK":
        return {"type": kind, "commandId": r.u(8), "result": r.u(8)}
    raise ValueError(f"unknown message type {kind}")


def _le(value: int, n: int) -> bytes:
    return int(value).to_bytes(n, "little", signed=False)


def cmac_input(site_id: int, full_counter: int, head: bytes) -> bytes:
    return _le(site_id, 2) + _le(full_counter, 4) + head


def mic32(key: bytes, site_id: int, full_counter: int, head: bytes) -> bytes:
    c = cmac.CMAC(algorithms.AES(key))
    c.update(cmac_input(site_id, full_counter, head))
    return c.finalize()[:4]


def encode_frame(msg: dict, src: int, full_counter: int, key: bytes = TEST_SITE_KEY, site_id: int = TEST_SITE_ID) -> bytes:
    payload = encode_payload(msg)
    if len(payload) > 247:
        raise ValueError("payload exceeds 247 bytes")
    head = bytes([MESSAGE_TYPES.index(msg["type"]), src & 0xFF, full_counter & 0xFF]) + payload
    return head + mic32(key, site_id, full_counter, head)


def decode_frame(
    data: bytes,
    full_counter: int,
    key: bytes = TEST_SITE_KEY,
    site_id: int = TEST_SITE_ID,
    expected_ctr: int | None = None,
) -> dict:
    if len(data) < 7:
        raise ValueError("frame too short")
    hdr, src, ctr = data[0], data[1], data[2]
    version = (hdr >> 4) & 3
    if version != 0:
        raise ValueError(f"unsupported version {version}")
    kind = MESSAGE_TYPES[hdr & 0x0F]
    if expected_ctr is not None and ctr != (expected_ctr & 0xFF):
        raise ValueError("counter mismatch")
    head = data[:-4]
    if data[-4:] != mic32(key, site_id, full_counter, head):
        raise ValueError("bad MIC")
    return {
        "type": kind,
        "src": src,
        "ctr": ctr,
        "version": version,
        "relayed": bool(hdr & 0x40),
        "encrypted": bool(hdr & 0x80),
        "payload": head[3:],
        "mic": int.from_bytes(data[-4:], "big"),
        "message": decode_payload(kind, head[3:]),
    }


if __name__ == "__main__":
    ack = {"type": "ACK", "commandId": 7, "result": 0}
    raw = encode_frame(ack, 3, 42)
    print(raw.hex())
    decoded = decode_frame(raw, 42, expected_ctr=42)
    assert decoded["message"] == ack
    print("protocol v0 self-check ok")
