"""Scene rendering: one drone source, one microphone, flat ground, optional turbulence.

render_mic() is the general form of the golden renderer's loop, in blocks longer than a tick for speed.
"""

import numpy as np

from .model import FS, GROUND_GAMMA
from .paths import new_air, path_block


def padded(src, pad):
    """Source with pad zeros before sample 0 (emission before the scene starts is silent)."""
    return np.concatenate([np.zeros(pad), src, np.zeros(4)])


def render_mic(src, pad, tr, rx, n_start, n_end, block=1600, delay_fn=None, gain_fn=None):
    """Direct and ground-image paths of the drone at mic rx for scene samples [n_start, n_end).

    src is the emitted pressure at 1 m from scene sample 0, already passed through padded(src, pad).
    tr is a track dict on the tick grid (keys t, x, y, z, rotor). delay_fn and gain_fn apply to the direct path.
    """
    out = np.zeros(n_end - n_start)
    direct, image = new_air(), new_air()
    for n0 in range(n_start, n_end, block):
        size = min(block, n_end - n0)
        path_block(out, n0, src, tr, rx, None, 1.0, direct, pad, base=n_start, size=size,
                   delay_fn=delay_fn, gain_fn=gain_fn)
        path_block(out, n0, src, tr, rx, 0.0, GROUND_GAMMA, image, pad, base=n_start, size=size)
    return out
