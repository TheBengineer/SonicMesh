# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Acoustic provisioning prototype: phone plays its signed GPS fix, node latches its position.

Scenarios (each run over several random seeds: GPS error, noise):
  A  accelerometer, operator lingers 10 s by the node, then walks away
  B  same, no accelerometer: "carried" inferred from moving fixes at steady level
  C  no accelerometer and no lingering: set down and walk straight off
  D  as A at a noisy site (60 dB ambient)
  E  a phone without the site key: frames must never be accepted
plus a range test with the phone held still at increasing distance.

Run:  uv run sim/provisioning/run.py [--seeds N]
"""
import argparse

import numpy as np
from scipy import signal

import channel
import modem
from frame import latlon_to_enu, unpack
from placement import Heard, Latch


def receive_frames(rng, sc):
    """Simulate a scenario. Returns (x, accepted frames, reject counts, frames sent)."""
    tx, starts = channel.phone_waveform(rng, sc)
    x = channel.node_recording(rng, sc, tx)
    rx = modem.Receiver()
    y = rx.baseband(x)
    sos = signal.butter(4, modem.BAND, btype="band", fs=modem.FS, output="sos")
    xb = signal.sosfilt(sos, x)
    frame_n = int(modem.FRAME_SECONDS * modem.FS)
    heard, rejects = [], {}
    for start, alpha, _ in rx.detect(y):
        data, alpha = rx.demodulate(y, start, alpha)
        if data is None:
            continue
        fix, why = unpack(data, channel_key(sc))
        if fix is None:
            rejects[why] = rejects.get(why, 0) + 1
            continue
        seg = xb[start: start + frame_n]
        level = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) / 20e-6)
        e, n = latlon_to_enu(fix.lat, fix.lon, channel.ORIGIN)
        heard.append(Heard((start + frame_n) / modem.FS, level, alpha * channel.C, e, n,
                           fix.accuracy, fix.seq, fix.unix_time))
    return x, heard, rejects, len(starts)


def channel_key(sc):
    return b"site-key"      # what the node was loaded with; scenario E's phone uses another


def run_latch(sc, x, heard):
    t_fine, fine = modem.band_level_db(x, hop_s=0.05)
    t_lvl = t_fine[4::5]                                   # latch ticks every 0.25 s
    lvl = np.array([np.median(fine[max(0, i - 19): i + 1]) for i in range(4, len(fine), 5)])
    floor = np.array([fine[max(0, i - 199): i + 1].min() for i in range(4, len(fine), 5)])
    moving = channel.node_moving(sc, t_lvl) if sc.accelerometer else np.zeros(len(t_lvl), bool)
    latch = Latch(sc.accelerometer)
    dt = t_lvl[1] - t_lvl[0]
    i = 0
    for t, level, nf, mv in zip(t_lvl, lvl, floor, moving):
        new = []
        while i < len(heard) and heard[i].t <= t:
            new.append(heard[i])
            i += 1
        latch.step(t, dt, level, nf, bool(mv), new)
        if latch.commit:
            break
    return latch.commit


def placement_runs(seeds):
    cases = [
        ("A  accelerometer, 10 s linger", dict(dwell=10, accelerometer=True)),
        ("B  no accelerometer, 10 s linger", dict(dwell=10, accelerometer=False)),
        ("C  no accelerometer, no linger", dict(dwell=0, accelerometer=False)),
        ("D  as A, 60 dB ambient", dict(dwell=10, accelerometer=True, ambient_db=60)),
        ("E  phone without the site key", dict(dwell=10, accelerometer=True)),
    ]
    print(f"{'scenario':<34} {'commits':>7} {'confident':>9} {'err median':>10} {'err max':>8} "
          f"{'commit after leaving':>20} {'frames ok/sent':>14}  rejects")
    for name, kw in cases:
        errs, delays, conf, n_ok, n_sent, commits = [], [], 0, 0, 0, 0
        rej = {}
        for s in range(seeds):
            rng = np.random.default_rng(100 + s)
            sc = channel.placement_scenario(name, **kw)
            if name.startswith("E"):
                sc.key = b"not-the-site-key"
            x, heard, rejects, sent = receive_frames(rng, sc)
            n_ok += len(heard)
            n_sent += sent
            for k, v in rejects.items():
                rej[k] = rej.get(k, 0) + v
            c = run_latch(sc, x, heard)
            if c:
                commits += 1
                conf += c.confident
                errs.append(np.hypot(c.east, c.north))      # node truly at the origin
                delays.append(c.t - sc.walk_away_start)
        e = f"{np.median(errs):8.1f} m {np.max(errs):6.1f} m" if errs else f"{'-':>10} {'-':>8}"
        d = f"{np.median(delays):6.1f} s (max {np.max(delays):4.1f})" if delays else "-"
        print(f"{name:<34} {commits:>4}/{seeds:<2} {conf:>9} {e} {d:>20} {n_ok:>6}/{n_sent:<6}  "
              + (", ".join(f"{k} {v}" for k, v in rej.items()) or "none"))


def range_test(seeds):
    print("\nrange test: phone held still 1.2 m up, node on the ground; share of frames decoded")
    dists = (0.5, 1, 2, 4, 8, 16)
    print(f"{'ambient':>8} | " + " ".join(f"{d:>6g} m" for d in dists))
    for amb in (45.0, 60.0):
        cells = []
        for d in dists:
            ok = sent = 0
            for s in range(seeds):
                rng = np.random.default_rng(500 + s)
                sc = channel.standoff_scenario(d, amb)
                _, heard, _, n = receive_frames(rng, sc)
                ok, sent = ok + len(heard), sent + n
            cells.append(f"{ok / max(sent, 1) * 100:6.0f}%")
        print(f"{amb:>6.0f}dB | " + " ".join(cells))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seeds", type=int, default=8)
    args = ap.parse_args()
    print(f"modem: {modem.FC:g} Hz carrier, {modem.BAUD} baud DBPSK, rate-1/2 K=7, "
          f"{modem.FRAME_SECONDS:.2f} s per frame; phone {channel.PHONE_SPL_AT_10CM:g} dB SPL at 10 cm\n")
    placement_runs(args.seeds)
    range_test(max(2, args.seeds // 3))


if __name__ == "__main__":
    main()
