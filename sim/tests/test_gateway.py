# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pytest"]
# ///
"""Gateway rule (sim/perimeter/fa.py) and the detector's hold threshold."""

import importlib.util
import sys
from pathlib import Path

import numpy as np

from detector.detector import GRID, Params, Track

ROOT = Path(__file__).resolve().parents[2]


def _fa():
    spec = importlib.util.spec_from_file_location("fa", ROOT / "sim" / "perimeter" / "fa.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("fa", mod)
    spec.loader.exec_module(mod)
    return mod


fa = _fa()


def test_adjacent_pair_within_window_same_f0_is_an_event():
    ev = fa.gateway_events({0: [(100.0, 250.0, None)], 1: [(115.0, 252.0, None)]})
    assert ev == [115.0]


def test_pair_beyond_window_is_not_an_event():
    assert fa.gateway_events({0: [(100.0, 250.0, None)], 1: [(100.0 + fa.GATE_WINDOW_S + 1, 250.0, None)]}) == []


def test_octave_apart_f0_is_an_event():
    # one node locks on the second harmonic, the other on the fundamental
    assert len(fa.gateway_events({2: [(10.0, 300.0, None)], 3: [(12.0, 150.0, None)]})) == 1


def test_f0_mismatch_is_not_an_event():
    assert fa.gateway_events({0: [(10.0, 250.0, None)], 1: [(12.0, 250.0 * 1.2, None)]}) == []


def test_non_adjacent_nodes_need_max_gap_two():
    on = {0: [(10.0, 250.0, None)], 2: [(12.0, 250.0, None)]}
    assert fa.gateway_events(on) == []
    assert len(fa.gateway_pairs(on, max_gap=2)) == 1


def test_hold_threshold_keeps_an_acquired_track_alive():
    def run(hold):
        p = Params(theta=0.16, hold_ratio=hold, use_age=False, use_harm=False)
        tr = Track()
        S = np.zeros(GRID, np.float32)
        W = np.zeros(257)
        S[100] = 0.3
        for _ in range(6):
            tr.update(S, W, p)
        S[100] = 0.10  # between hold (0.08 at 0.5) and theta (0.16)
        for _ in range(10):
            tr.update(S, W, p)
        return tr.q

    assert run(0.5) > 0
    assert run(1.0) == 0


def test_ratio_lines_accepts_an_octave_lock_backed_by_shared_lines():
    # node A locked on 2 x f0 (lines 2, 4, 6 of 250 Hz); node B on the fundamental, all six harmonics present
    assert fa.ratio_lines_ok(500.0, 0b111, 250.0, 0b111111)
    # the same pair with only one shared line is not enough
    assert not fa.ratio_lines_ok(500.0, 0b001, 250.0, 0b000010)


def test_ratio_lines_accepts_a_third_harmonic_lock_and_rejects_an_unrelated_pair():
    # node A on 3/2 of node B's f0: harmonic 2 of A is harmonic 3 of B, and harmonic 4 of A is harmonic 6 of B
    assert fa.ratio_lines_ok(375.0, 0b1111, 250.0, 0b111111)
    # f0 ratio 1.16 is not near a small-integer ratio within 12 % (1 is 16 % away): rejected
    assert not fa.ratio_lines_ok(290.0, 0b111111, 250.0, 0b111111)


def test_lines_mode_gateway_pair_uses_the_masks():
    on = {0: [(10.0, 500.0, None, 0b111)], 1: [(12.0, 250.0, None, 0b111111)]}
    assert len(fa.gateway_events(on, mode="lines")) == 1
    assert len(fa.gateway_events(on, mode="f0")) == 1  # an octave apart is accepted by the f0 rule too
