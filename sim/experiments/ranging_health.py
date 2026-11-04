# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Periodic LoRa ranging and health telemetry on the perimeter mesh.

1. Airtime and energy: a health report riding every heartbeat, and a
   round-trip time-of-flight (RTToF) ranging sweep between neighbours.
2. Positioning: what ranging to neighbours adds to GNSS anchors (array
   nodes) and to the acoustic-provisioning fix, for a near-straight line.
3. Move detection: how far a node must be moved before a daily sweep
   notices. Static multipath bias cancels here, so it beats positioning.

Ranging accuracies are assumptions to be measured in Phase 2:
  sub-GHz RTToF (LR11xx / LR20xx, 500 kHz):  ~4 m per averaged sweep in the open
  2.4 GHz (SX1280 or LR2021, 1.6 MHz):       ~1.5 m per averaged sweep
  either: ~25% of links partly blocked, adding a static +0..12 m bias

Run:  uv run sim/experiments/ranging_health.py [--trials N]
"""
import argparse

import numpy as np

from lora_budget import airtime

SPACING = 350.0        # m between nodes along the line
N_NODES = 13
CROSS_JITTER = 15.0    # m: nodes sit off the ideal line by terrain and access
ANCHOR_EVERY = 3       # array nodes (GNSS) every 3rd position
GNSS_SIGMA = 2.0       # m per axis, averaged GNSS on an array node
PROVISION_SIGMA = 1.5  # m per axis, the phone fix from acoustic provisioning (doc 05)

RADIOS = {
    # name: (per-sweep range sigma m, max link m, day-to-day drift m)
    "sub-GHz RTToF": (4.0, 2.2 * SPACING, 1.0),
    "2.4 GHz RTToF": (1.5, 1.1 * SPACING, 0.5),
}
NLOS_P, NLOS_MAX = 0.25, 12.0

HEALTH_FIELDS = [   # (field, bits)
    ("battery voltage, 10 mV steps", 8),
    ("solar harvest today, Wh/50", 8),
    ("enclosure temperature, 0.5 °C", 8),
    ("uptime hours (wraps) + reset reason", 16),
    ("mic band noise floor, dB (min over interval)", 8),
    ("mic self-test flags: stuck PDM, clipping, DC, dead band", 4),
    ("wind / self-noise level, dB", 8),
    ("detections and rejected candidates since last report", 12),
    ("tilt from install orientation, degrees", 8),
    ("tamper / moved flags (accelerometer, ranging)", 4),
    ("beacon RSSI and SNR at this node", 16),
    ("clock offset to beacon, µs, and drift ppm", 16),
    ("neighbours heard, retries, queue depth", 12),
    ("GNSS sats + PPS lock (array nodes) or zero", 8),
    ("firmware build hash (every 12th report, else config CRC)", 16),
]


def health_budget():
    bits = sum(b for _, b in HEALTH_FIELDS)
    n_bytes = int(np.ceil(bits / 8)) + 4          # + 4 B framing (type, seq, MIC truncated)
    print(f"health report: {len(HEALTH_FIELDS)} fields, {bits} bits -> {n_bytes} B with framing")
    print(f"{'setting':>12} {'airtime ms':>11} {'duty @5 min':>12} {'13 nodes, channel busy':>23}")
    for sf in (7, 8, 9, 10):
        t = airtime(sf, 125e3, n_bytes)
        print(f"{f'SF{sf}/125k':>12} {t * 1e3:>11.0f} {t / 300 * 100:>11.3f}% "
              f"{N_NODES * t / 300 * 100:>22.2f}%")
    return n_bytes


def ranging_budget():
    """One RTToF measurement = request + response (short packets) + turnaround.
    A sweep averages 16 measurements per link across hopped channels."""
    print("\nranging sweep energy, per node (initiates to half its links, responds to the rest)")
    print(f"{'radio / setting':>24} {'one meas ms':>11} {'16 meas ms':>10} "
          f"{'links':>5} {'mAh/sweep':>9} {'hourly, % of 2 mA node':>23}")
    i_tx, i_rx = 0.110, 0.007            # A: +20 dBm transmit, receive
    for name, sf, bw, links in (("sub-GHz SF8/500k", 8, 500e3, 4), ("sub-GHz SF7/500k", 7, 500e3, 4),
                                ("2.4 GHz SF8/1600k", 8, 1625e3, 2), ("2.4 GHz SF6/1600k", 6, 1625e3, 2)):
        t_pkt = airtime(sf, bw, 4)
        t_meas = 2 * t_pkt + 0.002
        sweep = 16 * t_meas
        # each measurement: one side transmits a packet, receives one; ~half the time each
        q = links * sweep * (i_tx + i_rx) / 2 / 3600 * 1e3
        share = q * 24 / (2.0 * 24) * 100
        print(f"{name:>24} {t_meas * 1e3:>11.1f} {sweep * 1e3:>10.0f} {links:>5} {q:>9.4f} {share:>22.2f}%")


def layout(rng):
    x = np.arange(N_NODES) * SPACING
    y = rng.uniform(-CROSS_JITTER, CROSS_JITTER, N_NODES)
    return np.stack([x, y], axis=1)


def links_for(pos, max_link):
    d = np.linalg.norm(pos[:, None] - pos[None], axis=2)
    return [(i, j) for i in range(N_NODES) for j in range(i + 1, N_NODES) if d[i, j] <= max_link]


def solve(n, ranges, priors, init, iters=15):
    """Gauss-Newton with Huber reweighting on range residuals (NLOS outliers)."""
    p = init.copy()
    for _ in range(iters):
        rows, res, w = [], [], []
        for i, j, r, s in ranges:
            v = p[i] - p[j]
            d = np.linalg.norm(v) + 1e-9
            row = np.zeros(2 * n)
            row[2 * i: 2 * i + 2] = v / d
            row[2 * j: 2 * j + 2] = -v / d
            e = (r - d) / s
            rows.append(row / s)
            res.append(e)
            w.append(1.0 if abs(e) < 1.5 else 1.5 / abs(e))
        for i, xy, s in priors:
            for k in range(2):
                row = np.zeros(2 * n)
                row[2 * i + k] = 1 / s
                rows.append(row)
                res.append((xy[k] - p[i, k]) / s)
                w.append(1.0)
        a, b, sw = np.array(rows), np.array(res), np.sqrt(np.array(w))
        step = np.linalg.lstsq(a * sw[:, None], b * sw, rcond=None)[0]
        p = p + step.reshape(n, 2)
        if np.max(np.abs(step)) < 1e-3:
            break
    return p


def positioning(trials):
    print("\npositioning error of non-anchor nodes, RMS metres (along line / across line)")
    print(f"{'case':<46} " + " ".join(f"{r:>18}" for r in RADIOS))
    anchors = set(range(0, N_NODES, ANCHOR_EVERY)) | {N_NODES - 1}
    cases = [("provisioning fix only (no ranging)", False, True),
             ("anchors + ranging, no provisioning fix", True, False),
             ("anchors + ranging + provisioning fix", True, True)]
    for label, use_ranging, use_prov in cases:
        cells = []
        for name, (sigma, max_link, _) in RADIOS.items():
            err = []
            for t in range(trials):
                rng = np.random.default_rng(t)
                truth = layout(rng)
                priors = [(i, truth[i] + rng.normal(0, GNSS_SIGMA, 2), GNSS_SIGMA) for i in anchors]
                if use_prov:
                    priors += [(i, truth[i] + rng.normal(0, PROVISION_SIGMA, 2), PROVISION_SIGMA)
                               for i in range(N_NODES) if i not in anchors]
                ranges = []
                if use_ranging:
                    for i, j in links_for(truth, max_link):
                        bias = rng.uniform(0, NLOS_MAX) if rng.random() < NLOS_P else 0.0
                        r = np.linalg.norm(truth[i] - truth[j]) + bias + rng.normal(0, sigma)
                        ranges.append((i, j, r, sigma))
                # without a provisioning fix, the installer still knows the node order: start on the line
                init = np.stack([np.arange(N_NODES) * SPACING, np.zeros(N_NODES)], axis=1)
                est = solve(N_NODES, ranges, priors, init)
                for i in range(N_NODES):
                    if i not in anchors:
                        err.append(est[i] - truth[i])
            e = np.array(err)
            rms = np.sqrt(np.mean(e ** 2, axis=0))
            cells.append(f"{rms[0]:>7.1f} / {rms[1]:>6.1f}")
        print(f"{label:<46} " + " ".join(f"{c:>18}" for c in cells))


def move_detection(trials):
    """Baseline = mean of 7 daily sweeps. Alarm when the chi-square of today's range
    changes over the node's links exceeds the 1-false-alarm-per-node-year threshold."""
    print("\nmove detection by a daily sweep: P(detect), threshold set for 1 false alarm per node-year")
    moves = (2, 5, 10, 20, 40)
    print(f"{'radio':>15} {'direction':>13} " + " ".join(f"{f'{m} m':>6}" for m in moves))
    for name, (sigma, max_link, drift) in RADIOS.items():
        rng = np.random.default_rng(1)
        truth = layout(rng)
        node = N_NODES // 2
        nbrs = [j if i == node else i for i, j in links_for(truth, max_link) if node in (i, j)]
        k = len(nbrs)
        s_day = np.hypot(sigma, drift)
        s_delta = s_day * np.sqrt(1 + 1 / 7)
        null = np.sum(rng.normal(0, 1, (200_000, k)) ** 2, axis=1)
        thr = np.quantile(null, 1 - 1 / 365)
        for direction in ("along line", "across line", "random"):
            cells = []
            for m in moves:
                hits = 0
                for _ in range(trials * 4):
                    ang = {"along line": 0.0, "across line": np.pi / 2}.get(direction, rng.uniform(0, 2 * np.pi))
                    moved = truth[node] + m * np.array([np.cos(ang), np.sin(ang)])
                    dr = np.array([np.linalg.norm(moved - truth[j]) - np.linalg.norm(truth[node] - truth[j])
                                   for j in nbrs])
                    obs = dr + rng.normal(0, s_delta, k)
                    hits += np.sum((obs / s_delta) ** 2) > thr
                cells.append(f"{hits / (trials * 4) * 100:>5.0f}%")
            print(f"{name:>15} {direction:>13} " + " ".join(cells))
        print(f"{'':>15} ({k} links, per-link change sigma {s_delta:.1f} m)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--trials", type=int, default=200)
    args = ap.parse_args()
    health_budget()
    ranging_budget()
    positioning(args.trials)
    move_detection(args.trials)


if __name__ == "__main__":
    main()
