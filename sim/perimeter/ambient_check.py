# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Compare the rural ambient assumption with quiet sections of local outdoor recordings (aggregate numbers only).

What the local data can and cannot say. ESC-50 clips are normalised recordings with no calibration, so their absolute
level is not an SPL. The checks below therefore use only quantities that do not need a calibration:
  1. Spectral slope of the quietest 2 s of each outdoor clip (100 Hz to 4 kHz): dB per octave of power density.
     Pink noise is -3 dB per octave. Wind-dominated or traffic-dominated quiet sections are often steeper or flat.
  2. Quiet-to-loud ratio: the quietest 2 s band level against the clip's median 2 s band level, in dB. This is the
     dynamic range a quiet site has above its own floor.
  3. Event-to-quiet ratio the simulation implies, against the measured ratio: a 1 m event at 80 dB SPL, from
     20 to 300 m, against a 40 dB SPL ambient. The sim's ratio is compared with the data's ratio between the
     quietest and the loudest 2 s of each clip. This is the only absolute check possible, and it is relative.

Only the ESC-50 outdoor clips in data/backgrounds/esc50 are used (CC BY-NC 3.0, local use only; nothing is written
to the repo except the numbers printed here).

Run:  uv run sim/perimeter/ambient_check.py
"""

import sys
from pathlib import Path

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim"))

from acoustics.background import band_rms, load_clip, manifest  # noqa: E402
from acoustics.model import FS  # noqa: E402

WIN_S = 2.0
HOP_S = 0.5
BAND = (100.0, 4000.0)
SIM_AMBIENT_DB = 40.0  # ASSUMED, as in acoustics/background.py
SIM_EVENT_1M_DB = 80.0  # ASSUMED
SIM_RANGE_M = (20.0, 300.0)


def windows_levels(x):
    n, hop = int(WIN_S * FS), int(HOP_S * FS)
    starts = np.arange(0, max(1, len(x) - n + 1), hop)
    lev = np.array([band_rms(x[s : s + n]) for s in starts])
    return starts, lev


def slope_db_per_oct(seg):
    f, pxx = signal.welch(seg, FS, nperseg=4096)
    m = (f >= BAND[0]) & (f <= BAND[1])
    p = 10 * np.log10(pxx[m] + 1e-30)
    x = np.log2(f[m])
    return float(np.polyfit(x, p, 1)[0])


def main():
    rows = manifest(folds=None, outdoor_only=True)
    quiet_db, loud_db, slopes, qrat, quiet_levels = [], [], [], [], []
    sel = rows
    for r in sel:
        x = load_clip(r["file"])
        if len(x) < int(WIN_S * FS) * 2:
            continue
        starts, lev = windows_levels(x)
        lev = np.maximum(lev, 1e-12)
        db = 20 * np.log10(lev)
        q = int(np.argmin(db))
        quiet_db.append(float(db[q]))
        loud_db.append(float(np.max(db)))
        med = float(np.median(db))
        qrat.append(float(db[q] - med))
        slopes.append(slope_db_per_oct(x[starts[q] : starts[q] + int(WIN_S * FS)]))
        quiet_levels.append(r["category"])
    quiet_db = np.array(quiet_db)
    loud_db = np.array(loud_db)
    slopes = np.array(slopes)
    qrat = np.array(qrat)
    n = len(quiet_db)
    print(f"outdoor clips used: {n} (ESC-50 manifest, all folds). Levels are dBFS (uncalibrated).")
    print(f"quietest 2 s band level (100 Hz-4 kHz), dBFS: median {np.median(quiet_db):.1f}, "
          f"10th-90th pct {np.percentile(quiet_db, 10):.1f} to {np.percentile(quiet_db, 90):.1f}")
    print(f"loudest 2 s band level, dBFS: median {np.median(loud_db):.1f}")
    print(f"quiet-to-loud range, dB: median {np.median(loud_db - quiet_db):.1f}, "
          f"10th-90th pct {np.percentile(loud_db - quiet_db, 10):.1f} to {np.percentile(loud_db - quiet_db, 90):.1f}")
    print(f"quietest 2 s relative to the clip's median, dB: median {np.median(qrat):.1f}")
    print(f"spectral slope of quietest 2 s, dB per octave: median {np.median(slopes):.2f}, "
          f"10th-90th pct {np.percentile(slopes, 10):.2f} to {np.percentile(slopes, 90):.2f} "
          f"(pink = -3.0; white = 0.0)")
    share_pink = float(np.mean((slopes > -4.5) & (slopes < -1.5)))
    print(f"share of quiet sections with slope between -4.5 and -1.5 dB/oct: {share_pink:.2f}")
    # the sim's implied event-to-ambient ratio at the quietest band of a clip: 80 dB at 1 m minus 20 log10(range)
    ev_lo = SIM_EVENT_1M_DB - 20 * np.log10(SIM_RANGE_M[1])
    ev_hi = SIM_EVENT_1M_DB - 20 * np.log10(SIM_RANGE_M[0])
    print(f"simulation: ambient {SIM_AMBIENT_DB} dB SPL (ASSUMED, band level); events {ev_lo:.0f} to {ev_hi:.0f} dB SPL "
          f"at the node (ASSUMED); event-to-ambient {ev_lo - SIM_AMBIENT_DB:.0f} to {ev_hi - SIM_AMBIENT_DB:.0f} dB")
    print("data: no SPL calibration in the local clips, so the sim's absolute ambient is not tested by these numbers.")


if __name__ == "__main__":
    main()
