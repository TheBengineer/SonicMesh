# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Write web/tests/golden/lora_airtime.json from the LoRa budget script.

The TypeScript channel must reproduce airtime and sensitivity to 1e-9 s / 1e-9 dB.
Run:  uv run sim/golden/lora_airtime.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sim" / "experiments"))

from lora_budget import airtime, sensitivity  # noqa: E402

SFS = tuple(range(5, 13))
BWS = (125e3, 250e3, 500e3)
BYTES = (1, 2, 3, 7, 11, 15, 19, 26, 31, 64, 100, 127, 128, 200, 240, 247, 255)


def main() -> None:
    air = []
    for sf in SFS:
        for bw in BWS:
            for n in BYTES:
                air.append({"sf": sf, "bw": bw, "bytes": n, "seconds": airtime(sf, bw, n)})
    sens = [{"sf": sf, "bw": bw, "dbm": sensitivity(sf, bw)} for sf in SFS for bw in BWS]
    out = {"constants": {"preamble": 8, "coding_rate": 1}, "airtime": air, "sensitivity": sens}
    path = ROOT / "web" / "tests" / "golden" / "lora_airtime.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {len(air)} airtimes and {len(sens)} sensitivities to {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
