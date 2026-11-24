"""smtool: tuning and test tool for SonicMesh node firmware. Run it through firmware/tools/sm.

Modules:
  device    one board over its USB shell (commands, parameters, traces, reader thread)
  audio     WAV reading, resampling to the node rate, cached clips, paplay
  replay    offline run of the node's detectors (ctypes binding of firmware/tests/host/smdet.c)
  score     matches SHOT and DRONE events to scenario clips and computes the cost
  scenario  scenario files and the timeline they produce
  tuning    tuning files ("gunshot.ratio_db" style keys) and how they split for replay
  clock     board clock to host clock fits
  run       hardware runs (play clips, record every board)
  sweep     parameter grids, replay or hardware
  cli       argument parsing and the subcommands

See README.md in this directory for the workflow and the file formats.
"""

import os
import sys

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.dirname(PACKAGE_DIR)
REPO_ROOT = os.path.abspath(os.path.join(TOOLS_DIR, "..", ".."))
DATA_DIR = os.path.join(REPO_ROOT, "data")
BENCH_DIR = os.path.join(DATA_DIR, "bench")

# smlog (the gateway log decoder) is the one record decoder; import it, do not copy it.
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)
