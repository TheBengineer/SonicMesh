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
from pathlib import Path

import numpy as np
from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"

FS = 16_000
TICK_S = 0.01
BLOCK = 160
C = 343.0
REF_PA = 20e-6
GROUND_GAMMA = 0.7
N_HARM = 10
ROTOR_OFFSETS = [-0.006, 0.004, -0.002, 0.008]
PHASE_STEP = 0.6180339887498949
ARRAY_HALF_M = 0.06
ARRAY_MIC_H_M = 1.5
DETECTOR_MIC_H_M = 0.3
ARRAY_OFFSETS = [(-1, -1), (1, -1), (-1, 1), (1, 1)]
CLASS = {"fpv": (600.0, 85.0), "mini": (250.0, 80.0), "matrice": (100.0, 80.0)}  # BPF Hz, dB SPL at 1 m
ABS_F = [0, 125, 250, 500, 1000, 2000, 4000, 8000]
ABS_DB_KM = [0, 0.4, 1.0, 1.9, 3.7, 9.7, 32.8, 117.0]
AIR_TAPS = 32
AIR_GRID_M = 20.0
AIR_MAX_M = 8000.0
AIR_DESIGN_N = 512
DURATION_S = 36.0
CHECK_S = [3.0 + 3.0 * k for k in range(10)]  # 3–30 s: sound has arrived, and every 1 s window ends before the path does (30 s)
WINDOW = 1600  # 100 ms
BPF_WINDOW_S = 0.25  # must match BPF_WINDOW_S in web/tests/golden.test.ts
BAND_NFFT = 2048
BAND_HZ = (100.0, 4000.0)
PAD = 1 << 19  # zeros before sample 0, matching the unwritten part of the TypeScript source ring


def load(path):
    scn = json.loads(path.read_text())
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


def pose(tr, tt, mirror_z):
    x = np.interp(tt, tr["t"], tr["x"])
    y = np.interp(tt, tr["t"], tr["y"])
    z = np.interp(tt, tr["t"], tr["z"])
    if mirror_z is not None:
        z = mirror_z - z
    return x, y, z


def dist(tr, tt, rx, mirror_z):
    x, y, z = pose(tr, tt, mirror_z)
    return np.sqrt((x - rx[0]) ** 2 + (y - rx[1]) ** 2 + (z - rx[2]) ** 2)


def solve_delay(tr, tt, rx, mirror_z):
    tau = dist(tr, tt, rx, mirror_z) / C
    for _ in range(3):
        tau = dist(tr, tt - tau, rx, mirror_z) / C
    return np.maximum(tau, 1.0 / C)


def absorption_db_per_km(f):
    return np.interp(f, ABS_F, ABS_DB_KM)


def air_fir(r):
    """Minimum-phase FIR of the ISO attenuation over distance r, as airFir() in propagate.ts."""
    n = AIR_DESIGN_N
    f = np.arange(n // 2 + 1) * FS / n
    half = -absorption_db_per_km(f) * (r / 1000.0) * math.log(10) / 20
    full = np.concatenate([half, half[-2:0:-1]])
    c = np.real(np.fft.ifft(full))
    cf = np.zeros(n)
    cf[0] = c[0]
    cf[1 : n // 2] = 2 * c[1 : n // 2]
    cf[n // 2] = c[n // 2]
    h = np.real(np.fft.ifft(np.exp(np.fft.fft(cf))))
    return h[:AIR_TAPS]


AIR_GRID_N = round(AIR_MAX_M / AIR_GRID_M)
AIR_TABLE = np.array([air_fir(g * AIR_GRID_M) for g in range(AIR_GRID_N + 1)])


def air_taps(r):
    """Taps for distance r, linear between grid points, as AirFilter.setDistance() in propagate.ts."""
    g = min(max(r / AIR_GRID_M, 0.0), float(AIR_GRID_N))
    i0 = min(int(math.floor(g)), AIR_GRID_N - 1)
    t = g - i0
    return (1 - t) * AIR_TABLE[i0] + t * AIR_TABLE[i0 + 1]


def interp4(buf, pos):
    k = np.floor(pos).astype(np.int64)
    f = pos - k
    i = k + PAD
    cm1 = -f * (f - 1) * (f - 2) / 6
    c0 = (f + 1) * (f - 1) * (f - 2) / 2
    c1 = -(f + 1) * f * (f - 2) / 2
    c2 = (f + 1) * f * (f - 1) / 6
    return cm1 * buf[i - 1] + c0 * buf[i] + c1 * buf[i + 1] + c2 * buf[i + 2]


def new_air():
    return {"hist": np.zeros(AIR_TAPS - 1)}


def path_block(out, n0, src, tr, rx, mirror_z, gain, air):
    # Delay solved at the first and last sample of the block, interpolated between them.
    t_a = float(solve_delay(tr, np.array([n0 / FS]), rx, mirror_z)[0])
    t_b = float(solve_delay(tr, np.array([(n0 + BLOCK - 1) / FS]), rx, mirror_z)[0])
    tau = t_a + (t_b - t_a) * np.arange(BLOCK) / (BLOCK - 1)
    v = interp4(src, n0 + np.arange(BLOCK) - tau * FS) / (C * tau) * gain
    x = np.concatenate([air["hist"], v])
    out[n0 : n0 + BLOCK] += np.convolve(x, air_taps(C * t_a))[AIR_TAPS - 1 : AIR_TAPS - 1 + BLOCK]
    air["hist"] = x[-(AIR_TAPS - 1) :]


def drone_source(cls, factor):
    bpf, level = CLASS[cls]
    h = np.arange(1, N_HARM + 1, dtype=float)
    amp = h**-0.7
    gain = REF_PA * 10 ** (level / 20) / math.sqrt(2 * np.sum(h**-1.4))
    out = np.zeros(factor.size)
    for i in range(4):
        phase = np.cumsum(bpf * (1 + ROTOR_OFFSETS[i]) * factor / FS)
        for k in range(N_HARM):
            phi = 2 * math.pi * (((i * N_HARM + k) * PHASE_STEP) % 1.0)
            out += amp[k] * np.sin(2 * math.pi * (k + 1) * phase + phi)
    return gain * out


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
    src = drone_source(drone["class"], factor)
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
            path_block(out, n0, src_pad, tr, rx, None, 1.0, direct)
            path_block(out, n0, src_pad, tr, rx, 0.0, GROUND_GAMMA, image)

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
