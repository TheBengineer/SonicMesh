"""Tuning files: flat JSON objects such as {"gunshot.ratio_db": 15, "drone_comb.theta": 0.12}.

The same names are used on a board (sm param set) and in replay. split_tuning maps them onto what the
replay library takes: comb parameters, impulse parameters, and the few values the glue in Python owns.
"""

import json

COMB_PREFIX = "drone_comb."
IMPULSE_PREFIX = "gunshot."
# Board names the Python glue owns. "<detector>.enable" is the framework's on/off switch for a detector.
GLUE_NAMES = {"drone_comb.update_ms": "update_ms", "drone_comb.shot_mask_ms": "shot_mask_ms",
              "audio.full_scale_db": "full_scale_db", "drone_comb.enable": "comb_enabled",
              "gunshot.enable": "gunshot_enabled"}
DEFAULT_OPTIONS = {"update_ms": 1000, "shot_mask_ms": 600, "full_scale_db": 120.0, "comb_enabled": 1.0,
                   "gunshot_enabled": 1.0}


def load_tuning(path):
    with open(path, encoding="utf-8") as fh:
        values = json.load(fh)
    if not isinstance(values, dict):
        raise ValueError(f"{path} must be a JSON object of name: value")
    return values


class SplitTuning:
    def __init__(self, comb, impulse, options, ignored):
        self.comb = comb
        self.impulse = impulse
        self.options = options
        self.ignored = ignored  # board names replay does not model (for example radio.repeats)


def split_tuning(values):
    comb, impulse, options, ignored = {}, {}, dict(DEFAULT_OPTIONS), []
    for name, value in values.items():
        if name in GLUE_NAMES:
            options[GLUE_NAMES[name]] = float(value)
        elif name.startswith(COMB_PREFIX):
            comb[name[len(COMB_PREFIX):]] = float(value)
        elif name.startswith(IMPULSE_PREFIX):
            impulse[name[len(IMPULSE_PREFIX):]] = float(value)
        else:
            ignored.append(name)
    return SplitTuning(comb, impulse, options, ignored)


def merge(*tunings):
    out = {}
    for t in tunings:
        out.update(t or {})
    return out
