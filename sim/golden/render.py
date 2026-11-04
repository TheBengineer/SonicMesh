# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "jsonschema"]
# ///
"""Golden renderer: the acoustic models of web/src/acoustics, in numpy.

Reads web/scenarios/golden-*.json (validated against web/scenarios/schema.json) and writes
web/tests/golden/<name>.json with, per mic: the direct-path delay at checkpoints, the mean received
blade-pass frequency over 1 s around each checkpoint (analytic, from the delay), and 100 ms band levels.
web/tests/golden.test.ts requires the TypeScript engine to agree within 20 us and 0.5 dB, and to
measure the blade-pass frequency from its audio within 0.1 %.

Only the deterministic part is implemented: tonal source with fixed rotor speeds, direct and ground-image
paths, spreading, air absorption (the same minimum-phase FIR as propagate.ts), flat terrain. Anything random,
or terrain-dependent, raises NotImplementedError rather than quietly differing from the TypeScript engine.

Run:  uv run sim/golden/render.py
"""

import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
sys.path.insert(0, str(ROOT / "sim"))

from acoustics.model import (  # noqa: E402
    ARRAY_HALF_M,
    ARRAY_MIC_H_M,
    ARRAY_OFFSETS,
    BLOCK,
    C,
    CLASS,
    DETECTOR_MIC_H_M,
    FS,
    GROUND_GAMMA,
    REF_PA,
    ROTOR_OFFSETS,
    TICK_S,
)
from acoustics.paths import new_air, path_block, solve_delay  # noqa: E402
from acoustics.source import drone_source as tonal_source  # noqa: E402

DURATION_S = 36.0
CHECK_S = [3.0 + 3.0 * k for k in range(10)]  # 3–30 s: sound has arrived, and every 1 s window ends before the path does (30 s)
WINDOW = 1600  # 100 ms
BPF_WINDOW_S = 0.25  # must match BPF_WINDOW_S in web/tests/golden.test.ts
BAND_NFFT = 2048
BAND_HZ = (100.0, 4000.0)
PAD = 1 << 19  # zeros before sample 0, matching the unwritten part of the TypeScript source ring


def load(path):
    scn = json.loads(path.read_text())
    try:  # schema check when jsonschema is installed; the web tests validate the same files
        from jsonschema import Draft7Validator
    except ImportError:
        return scn
    schema = json.loads((WEB / "scenarios" / "schema.json").read_text())
    Draft7Validator(schema).validate(scn)
    return scn


def check_supported(scn):
    ac = scn.get("acoustics", {"self_noise": True, "ambient_db_spl": 40, "wobble": True, "broadband": True})
    if scn["terrain"]["amplitude_m"] != 0:
        raise NotImplementedError("terrain relief and barriers are not in the Python renderer yet")
    if ac["self_noise"] or ac["ambient_db_spl"] is not None or ac["wobble"] or ac["broadband"]:
        raise NotImplementedError("noise, wobble and broadband are not in the Python renderer yet")
    if len(scn["drones"]) != 1:
        raise NotImplementedError("the golden renderer expects exactly one drone")
    for d in scn["drones"]:
        if d["path"]["kind"] not in ("hover", "crossing"):
            raise NotImplementedError(f"path kind {d['path']['kind']} is not in the Python renderer yet")


def track(drone, n_ticks):
    t = np.arange(n_ticks + 1) * TICK_S
    p = drone["path"]
    z = np.full_like(t, float(p["altitude_m"]))
    if p["kind"] == "hover":
        x = np.full_like(t, float(p["at"]["x"]))
        y = np.full_like(t, float(p["at"]["y"]))
    else:
        fx, fy = float(p["from"]["x"]), float(p["from"]["y"])
        tx, ty = float(p["to"]["x"]), float(p["to"]["y"])
        length = math.hypot(tx - fx, ty - fy) or 1.0
        ux, uy = (tx - fx) / length, (ty - fy) / length
        s = np.minimum(p["speed_mps"] * np.maximum(t, 0.0), length)
        x = fx + ux * s
        y = fy + uy * s
    # Level flight: vertical speed is zero, so thrust and rotor speed stay at hover.
    rotor = np.ones_like(t)
    return {"t": t, "x": x, "y": y, "z": z, "rotor": rotor}


def band_db(seg):
    spec = np.fft.rfft(seg, n=BAND_NFFT)
    f = np.arange(spec.size) * FS / BAND_NFFT
    m = (f >= BAND_HZ[0]) & (f <= BAND_HZ[1])
    p = 2.0 * np.sum(np.abs(spec[m]) ** 2) / (BAND_NFFT * seg.size)
    return 10 * math.log10(max(p, 1e-30) / REF_PA**2)


def mics_of(scn):
    mics = []
    for node in scn["nodes"]:
        array = node["kind"] == "array"
        h = ARRAY_MIC_H_M if array else DETECTOR_MIC_H_M
        offsets = [(dx * ARRAY_HALF_M, dy * ARRAY_HALF_M) for dx, dy in ARRAY_OFFSETS] if array else [(0.0, 0.0)]
        for j, (dx, dy) in enumerate(offsets):
            pos = np.array([node["x"] + dx, node["y"] + dy, 0.0 + h])
            mics.append((f"{node['id']}.{j}", pos))
    return mics


def render(scn):
    check_supported(scn)
    drone = scn["drones"][0]
    n_ticks = round(DURATION_S / TICK_S)
    total = n_ticks * BLOCK
    tr = track(drone, n_ticks)
    factor = np.interp(np.arange(total) / FS, tr["t"], tr["rotor"])
    src = tonal_source(drone["class"], factor)
    src_pad = np.concatenate([np.zeros(PAD), src, np.zeros(4)])
    mics = mics_of(scn)

    result = []
    cps = np.array(CHECK_S)
    bpf_mean = CLASS[drone["class"]][0] * (1 + np.mean(ROTOR_OFFSETS))
    for key, rx in mics:
        out = np.zeros(total)
        direct, image = new_air(), new_air()
        for blk in range(n_ticks):
            n0 = blk * BLOCK
            path_block(out, n0, src_pad, tr, rx, None, 1.0, direct, PAD)
            path_block(out, n0, src_pad, tr, rx, 0.0, GROUND_GAMMA, image, PAD)

        delay = solve_delay(tr, cps, rx, None)
        # mean received frequency over the window the test measures in: f·(1 − Δτ/W)
        w = BPF_WINDOW_S
        rate = (solve_delay(tr, cps + w / 2, rx, None) - solve_delay(tr, cps - w / 2, rx, None)) / w
        result.append(
            {
                "key": key,
                "pos": rx.tolist(),
                "delay_s": delay.tolist(),
                "bpf_hz": (bpf_mean * (1 - rate)).tolist(),
                "band_db": [band_db(out[k * WINDOW : (k + 1) * WINDOW]) for k in range(total // WINDOW)],
            }
        )
    return {
        "scenario": scn["name"],
        "duration_s": DURATION_S,
        "fs": FS,
        "checkpoints_s": CHECK_S,
        "mics": result,
    }


def main():
    out_dir = WEB / "tests" / "golden"
    out_dir.mkdir(parents=True, exist_ok=True)
    for path in sorted((WEB / "scenarios").glob("golden-*.json")):
        doc = render(load(path))
        dest = out_dir / f"{path.stem}.json"
        dest.write_text(json.dumps(doc, indent=1) + "\n")
        print(f"{path.name}: {len(doc['mics'])} mics -> {dest.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
