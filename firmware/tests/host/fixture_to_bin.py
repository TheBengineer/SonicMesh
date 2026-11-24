#!/usr/bin/env python3
"""Converts web/tests/fixtures/comb_parity.json into a plain-text file the C host tests read.

Format: a line "SECONDS <n>", then per case a line
  CASE <signal> <n_fft> <hop> <floor_up_db> <gate_harm> <gap_frames> <gap_harm> <sub_guard> <init_env_bins> <hold_ratio> <frames>
followed by <frames> lines "<q> <index> <on> <f0> <score> <band> <floor> <peak>". Params absent from the JSON
take the defaults of DEFAULT_COMB_PARAMS in web/src/detector/comb.ts.

Usage: fixture_to_bin.py <comb_parity.json> <out.txt>
"""

import json
import sys

DEFAULTS = {
    "n_fft": 1024,
    "hop": 512,
    "floor_up_db": 0.1,
    "gate_harm": 1,
    "gap_frames": 0,
    "gap_harm": 0,
    "sub_guard": 1,
    "init_env_bins": 0,
    "hold_ratio": 1.0,
}
ORDER = ["n_fft", "hop", "floor_up_db", "gate_harm", "gap_frames", "gap_harm", "sub_guard", "init_env_bins", "hold_ratio"]
KNOWN = set(DEFAULTS)


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8") as f:
        fixture = json.load(f)
    lines = [f"SECONDS {int(fixture['seconds'])}"]
    for case in fixture["cases"]:
        unknown = set(case["params"]) - KNOWN
        if unknown:
            raise SystemExit(f"fixture param not handled by the C test: {sorted(unknown)}")
        p = {**DEFAULTS, **case["params"]}
        vals = [p[k] for k in ORDER]
        vals = [int(v) if isinstance(v, bool) else v for v in vals]
        n = len(case["on"])
        lines.append(
            "CASE " + case["signal"] + " " + " ".join(repr(v) for v in vals) + f" {n}"
        )
        for i in range(n):
            lines.append(
                " ".join(
                    str(v)
                    for v in (
                        case["q"][i],
                        case["index"][i],
                        case["on"][i],
                        repr(float(case["f0"][i])),
                        repr(float(case["score"][i])),
                        repr(float(case["band"][i])),
                        repr(float(case["floor"][i])),
                        repr(float(case["peak"][i])),
                    )
                )
            )
    with open(dst, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
