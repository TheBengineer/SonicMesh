# /// script
# requires-python = ">=3.11"
# dependencies = ["cryptography"]
# ///
"""Write web/tests/golden/protocol_v0.json from the Python reference codec.

Covers every message type, edge values and maximum sizes under the fixed test site key.
Run:  uv run sim/golden/protocol_vectors.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim" / "protocol"))

import v0  # noqa: E402


def health(values: list[int]) -> dict:
    return {"type": "HEALTH", "fields": values}


def beacon(**kw) -> dict:
    msg = {
        "type": "BEACON",
        "counter": 0,
        "gnssMs": 0,
        "mode": 0,
        "nextPhy": {"sf": 9, "bw": 125_000},
        "slotMap": [],
        "track": None,
        "snippets": [],
        "commands": [],
    }
    msg.update(kw)
    return msg


def detect_start(**kw) -> dict:
    msg = {"type": "DETECT_START", "confidence": 0, "level": 0, "cls": 0, "az": 0, "el": 0, "lineHz": 0}
    msg.update(kw)
    return msg


def detect(**kw) -> dict:
    msg = {
        "type": "DETECT",
        "confidence": 0,
        "level": 0,
        "az": 0,
        "el": 0,
        "bearingSigma": 0,
        "line1Hz": 0,
        "line2Delta": 0,
        "cls": 0,
        "clipReady": 0,
    }
    msg.update(kw)
    return msg


def snippet(data: list[int], **kw) -> dict:
    msg = {"type": "SNIPPET", "requestId": 0, "chunk": 0, "chunks": 1, "startSample": 0, "data": data}
    msg.update(kw)
    return msg


def ranging(results: list[dict]) -> dict:
    return {"type": "RANGING_RESULT", "results": results}


def join(**kw) -> dict:
    msg = {
        "type": "JOIN",
        "lat": 0,
        "lon": 0,
        "altDm": 0,
        "accuracyDm": 0,
        "confident": 0,
        "nodeType": 0,
        "provSeq": 0,
        "provTime": 0,
        "provMac": 0,
    }
    msg.update(kw)
    return msg


def ack(**kw) -> dict:
    msg = {"type": "ACK", "commandId": 0, "result": 0}
    msg.update(kw)
    return msg


def main() -> None:
    sites = 0x534D
    key = v0.TEST_SITE_KEY
    messages: list[dict] = []
    counter = 1

    def add(msg: dict, src: int, full_counter: int) -> None:
        frame = v0.encode_frame(msg, src, full_counter, key, sites)
        decoded = v0.decode_frame(frame, full_counter, key, sites, expected_ctr=full_counter)
        assert decoded["message"] == msg, (msg, decoded["message"])
        messages.append(
            {
                "name": msg["type"],
                "src": src,
                "full_counter": full_counter,
                "fields": msg,
                "frame_hex": frame.hex(),
            }
        )

    # BEACON: idle and event, empty and full, track state and snippet requests.
    add(beacon(), 0, counter)
    counter += 1
    slots = [{"node": i + 1, "action": i % 6, "arg": i} for i in range(14)]
    add(beacon(counter=1234, gnssMs=660_000_000_123, nextPhy={"sf": 9, "bw": 125_000}, slotMap=slots), 0, counter)
    counter += 1
    track = {"id": 7, "x": 120, "y": -84, "z": 40, "vx": 12.5, "vy": -3.0, "vz": 0.5, "time": 4321}
    snippets = [
        {"node": 4 + i, "requestId": 90 + i, "startSample": 400_000 + i * 4000, "lengthMs": 250}
        for i in range(4)
    ]
    add(
        beacon(
            counter=4294967295,
            gnssMs=2**40 - 1,
            mode=1,
            nextPhy={"sf": 7, "bw": 500_000},
            slotMap=[{"node": i + 1, "action": 2, "arg": 31 - i} for i in range(16)],
            track=track,
            snippets=snippets,
            commands=[{"id": 1, "arg": 0}, {"id": 2, "arg": 255}, {"id": 3, "arg": 17}, {"id": 4, "arg": 9}],
        ),
        0,
        counter,
    )
    counter += 1
    add(beacon(counter=1, mode=1, nextPhy={"sf": 7, "bw": 500_000}, track=track), 0, counter)
    counter += 1
    add(beacon(counter=256, slotMap=[{"node": 255, "action": 7, "arg": 31}]), 0, counter)
    counter += 1

    # DETECT_START: zero, typical, maxima.
    add(detect_start(), 1, counter)
    counter += 1
    add(detect_start(confidence=11, level=47, cls=5, az=183, el=17, lineHz=612), 13, counter)
    counter += 1
    add(detect_start(confidence=15, level=63, cls=7, az=511, el=31, lineHz=2047), 254, counter)
    counter += 1

    # DETECT: zero, typical, maxima.
    add(detect(), 2, counter)
    counter += 1
    add(
        detect(
            confidence=9,
            level=51,
            az=274,
            el=12,
            bearingSigma=5,
            line1Hz=603,
            line2Delta=25,
            cls=2,
            clipReady=1,
        ),
        7,
        counter,
    )
    counter += 1
    add(
        detect(
            confidence=15,
            level=63,
            az=511,
            el=31,
            bearingSigma=15,
            line1Hz=2047,
            line2Delta=63,
            cls=7,
            clipReady=1,
        ),
        254,
        counter,
    )
    counter += 1

    # SNIPPET: one bit, one byte, and the maximum 240 B of data.
    add(snippet([1, 0, 0, 0, 0, 0, 0, 0]), 3, counter)
    counter += 1
    add(snippet([1, 0, 1, 1, 0, 0, 1, 0], requestId=255, chunk=3, chunks=5, startSample=123456), 4, counter)
    counter += 1
    add(
        snippet(
            [(i * 7 + 3) % 2 for i in range(240 * 8)],
            requestId=200,
            chunk=15,
            chunks=15,
            startSample=2**32 - 1,
        ),
        5,
        counter,
    )
    counter += 1

    # HEALTH: zero, typical, maxima. 152 bits exactly.
    add(health([0] * 15), 1, counter)
    counter += 1
    add(health([119, 40, 48, 0x1A2B, 31, 0b0101, 38, 0x0ABC, 2, 0b0011, 0xA55A, 0x8123, 0x456, 0x8C, 0xBEEF]), 6, counter)
    counter += 1
    add(health([255, 255, 255, 65535, 255, 15, 255, 4095, 255, 15, 65535, 65535, 4095, 255, 65535]), 254, counter)
    counter += 1

    # RANGING_RESULT: empty, typical, maximum eight neighbours.
    add(ranging([]), 1, counter)
    counter += 1
    add(
        ranging(
            [
                {"id": 2, "rangeDm": 3500, "rssi": 170, "snr": 45},
                {"id": 3, "rangeDm": 3487, "rssi": 164, "snr": 41},
            ]
        ),
        1,
        counter,
    )
    counter += 1
    add(
        ranging([{"id": i + 2, "rangeDm": 3000 + i, "rssi": 255 - i, "snr": 255 - 2 * i} for i in range(8)]),
        13,
        counter,
    )
    counter += 1

    # JOIN: zero, typical, maxima.
    add(join(), 1, counter)
    counter += 1
    add(
        join(
            lat=515_000_000,
            lon=-1_250_000,
            altDm=1234,
            accuracyDm=25,
            confident=1,
            nodeType=2,
            provSeq=77,
            provTime=660_000_000_000,
            provMac=0xDEADBEEF,
        ),
        9,
        counter,
    )
    counter += 1
    add(
        join(
            lat=2**31 - 1,
            lon=-(2**31),
            altDm=65535,
            accuracyDm=255,
            confident=1,
            nodeType=3,
            provSeq=255,
            provTime=2**40 - 1,
            provMac=2**32 - 1,
        ),
        254,
        counter,
    )
    counter += 1

    # ACK: zero, typical, maxima.
    add(ack(), 5, counter)
    counter += 1
    add(ack(commandId=12, result=0), 6, counter)
    counter += 1
    add(ack(commandId=255, result=255), 254, counter)
    counter += 1

    # More edge cases, to exercise every field width and the full slot map.
    add(beacon(counter=2**32 - 1, slotMap=[{"node": 255, "action": 7, "arg": 31} for _ in range(63)]), 0, counter)
    counter += 1
    add(
        beacon(
            counter=4096,
            mode=1,
            nextPhy={"sf": 12, "bw": 500_000},
            slotMap=[{"node": 0, "action": 0, "arg": 0}],
            commands=[{"id": i, "arg": 255 - i} for i in range(8)],
        ),
        0,
        counter,
    )
    counter += 1
    add(detect_start(confidence=1, level=1, cls=1, az=1, el=1, lineHz=1), 2, counter)
    counter += 1
    add(detect_start(confidence=8, level=32, cls=3, az=256, el=16, lineHz=1024), 128, counter)
    counter += 1
    add(detect(confidence=1, level=1, az=1, el=1, bearingSigma=1, line1Hz=1, line2Delta=1, cls=1, clipReady=0), 3, counter)
    counter += 1
    add(detect(confidence=8, level=32, az=256, el=16, bearingSigma=8, line1Hz=1024, line2Delta=32, cls=4, clipReady=1), 129, counter)
    counter += 1
    add(snippet([1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1]), 6, counter)
    counter += 1
    add(snippet([1] * (240 * 8), requestId=1, chunk=0, chunks=15, startSample=1), 7, counter)
    counter += 1
    add(health([(i * 17) % (2 ** min(width, 8)) for i, (_, width) in enumerate(v0.HEALTH_FIELDS)]), 8, counter)
    counter += 1
    add(ranging([{"id": 1, "rangeDm": 0, "rssi": 0, "snr": 0}]), 9, counter)
    counter += 1
    add(ranging([{"id": i + 1, "rangeDm": i, "rssi": 2 * i, "snr": 3 * i} for i in range(4)]), 10, counter)
    counter += 1
    add(join(lat=-(2**31), lon=2**31 - 1, altDm=0, accuracyDm=0, confident=1, nodeType=0), 11, counter)
    counter += 1
    add(join(lat=0, lon=0, altDm=65535, accuracyDm=255, confident=0, nodeType=3, provSeq=1), 12, counter)
    counter += 1
    add(ack(commandId=1, result=1), 13, counter)
    counter += 1

    out = {
        "site_id": sites,
        "site_key_hex": key.hex(),
        "messages": messages,
    }
    path = ROOT / "web" / "tests" / "golden" / "protocol_v0.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {len(messages)} vectors to {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
