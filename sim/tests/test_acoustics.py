# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "pytest"]
# ///
"""Acoustic package: golden agreement, seeded noise and turbulence, and the source model."""

import importlib.util
import json
from pathlib import Path

import numpy as np

from acoustics.model import FS
from acoustics.noise import wind
from acoustics.source import drone_source
from acoustics.turbulence import turbulence

ROOT = Path(__file__).resolve().parents[2]


def test_golden_json_is_byte_identical():
    spec = importlib.util.spec_from_file_location("render", ROOT / "sim" / "golden" / "render.py")
    render = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(render)
    doc = render.render(render.load(ROOT / "web" / "scenarios" / "golden-crossing.json"))
    text = json.dumps(doc, indent=1) + "\n"
    assert text == (ROOT / "web" / "tests" / "golden" / "golden-crossing.json").read_text()


def test_wind_is_seeded_and_scales_with_speed():
    a = wind(np.random.default_rng(3), FS * 5, 6.0)
    b = wind(np.random.default_rng(3), FS * 5, 6.0)
    c = wind(np.random.default_rng(4), FS * 5, 6.0)
    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)
    assert wind(np.random.default_rng(3), FS, 0.0).max() == 0.0
    assert wind(np.random.default_rng(3), FS * 5, 8.0).std() > wind(np.random.default_rng(3), FS * 5, 2.0).std()


def test_turbulence_is_seeded_and_grows_with_range():
    t = np.arange(0, 60, 0.01)
    rng_m = np.full(t.size, 300.0)
    d1, g1 = turbulence(np.random.default_rng(9), t, rng_m)
    d2, g2 = turbulence(np.random.default_rng(9), t, rng_m)
    probe = np.linspace(1, 59, 500)
    assert np.array_equal(d1(probe), d2(probe)) and np.array_equal(g1(probe), g2(probe))
    _, gn = turbulence(np.random.default_rng(9), t, np.full(t.size, 100.0))
    _, gf = turbulence(np.random.default_rng(9), t, np.full(t.size, 600.0))
    assert np.std(20 * np.log10(gf(probe))) > np.std(20 * np.log10(gn(probe)))


def test_source_wobble_and_broadband_are_seeded():
    n = FS * 2
    a = drone_source("mini", np.ones(n), rng=np.random.default_rng(1), wobble=True, broadband=True)
    b = drone_source("mini", np.ones(n), rng=np.random.default_rng(1), wobble=True, broadband=True)
    assert np.array_equal(a, b)
    plain = drone_source("mini", np.ones(n))
    assert np.std(a) > 0 and np.std(plain) > 0 and not np.array_equal(a, plain)
