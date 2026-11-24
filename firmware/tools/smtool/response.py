"""Applying a measured bench chain to audio, and synthesising the measured room noise.

Profiles are written by `sm measure` (measure.py) under data/bench/profiles/. Two kinds:

  response: results.bands = [{"fc", "lo_hz", "hi_hz", "db", "valid"}]. db is the magnitude in dB relative
            to 1 kHz. valid is False for bands outside the sweep (they are kept for the table only).
  noise:    results.bands = [{"fc", "lo_hz", "hi_hz", "spl_db"}] and results.tones = [{"hz", "spl_db", ...}].
            spl_db is the RMS level in dB SPL re 20 uPa. Tones are kept out of the bands.

Units: apply_response is scale-free (it normalises at 1 kHz). noise_from_profile returns PASCALS, the same
units replay uses for its quiet noise (replay.quiet_chunks).
"""

import json
import math

import numpy as np

SCHEMA = "smtool.measure/1"
RATE = 16000
REF_PA = 20e-6
PREFERRED_HZ = (25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0,
                500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0, 5000.0,
                6300.0, 8000.0)
RESPONSE_TAPS = 1024
DESIGN_N = 8192
FADE_TAPS = 128
BLOCK = 1 << 15


def band_bounds(centres, extend=False):
    """Lower and upper edges of 1/3-octave bands. Edges fall at the geometric midpoints between centres.
    extend=True makes the first lower edge 0 and the last upper edge infinite."""
    fc = np.asarray(centres, float)
    mids = np.sqrt(fc[:-1] * fc[1:])
    lo = np.concatenate(([fc[0] * 2 ** (-1 / 6)], mids))
    hi = np.concatenate((mids, [fc[-1] * 2 ** (1 / 6)]))
    if extend:
        lo[0] = 0.0
        hi[-1] = np.inf
    return lo, hi


def measurement_bands(fs):
    """Preferred 1/3-octave centres whose upper edge lies below the Nyquist frequency fs/2."""
    lo, hi = band_bounds(PREFERRED_HZ)
    keep = [i for i in range(len(PREFERRED_HZ)) if hi[i] <= fs / 2 + 1e-9]
    return [(PREFERRED_HZ[i], lo[i], hi[i]) for i in keep]


def load_profile(path):
    with open(path, encoding="utf-8") as fh:
        profile = json.load(fh)
    if profile.get("schema") != SCHEMA:
        raise ValueError(f"{path}: not an smtool measure profile (schema {profile.get('schema')!r})")
    return profile


def _require(profile, kind):
    if profile.get("schema") != SCHEMA or profile.get("kind") != kind:
        raise ValueError(f"expected a {kind!r} profile, got {profile.get('kind')!r}")


def _curve(f, centres, values):
    """Catmull-Rom spline over log frequency through (centre, value) points. Held flat outside the centres."""
    fc = np.asarray(centres, float)
    v = np.asarray(values, float)
    if len(fc) == 1:
        return np.full(np.shape(f), v[0])
    x = np.log(fc)
    q = np.clip(np.log(np.maximum(np.asarray(f, float), 1e-6)), x[0], x[-1])
    i = np.clip(np.searchsorted(x, q, side="right") - 1, 0, len(x) - 2)
    t = (q - x[i]) / (x[i + 1] - x[i])
    p0 = v[np.maximum(i - 1, 0)]
    p1 = v[i]
    p2 = v[i + 1]
    p3 = v[np.minimum(i + 2, len(v) - 1)]
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                  + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)


def magnitude_db(profile, freqs):
    """Measured magnitude in dB at the given frequencies, relative to 1 kHz."""
    _require(profile, "response")
    bands = [b for b in profile["results"]["bands"] if b.get("valid", True)]
    fc = [b["fc"] for b in bands]
    db = [b["db"] for b in bands]
    return _curve(freqs, fc, db) - _curve(np.array([1000.0]), fc, db)[0]


def response_fir(profile, fs=RATE, taps=RESPONSE_TAPS, nfft=DESIGN_N):
    """Minimum-phase FIR (no delay) with the measured magnitude. Cepstral method on an nfft grid."""
    f = np.fft.rfftfreq(nfft, 1.0 / fs)
    logmag = magnitude_db(profile, f) * math.log(10) / 20
    c = np.fft.irfft(logmag, nfft)
    cm = np.zeros(nfft)
    cm[0] = c[0]
    cm[1:nfft // 2] = 2 * c[1:nfft // 2]
    cm[nfft // 2] = c[nfft // 2]
    h = np.fft.ifft(np.exp(np.fft.fft(cm))).real[:taps].copy()
    fade = min(FADE_TAPS, taps)
    h[-fade:] *= 0.5 * (1 + np.cos(np.pi * np.arange(fade) / fade))
    return h


class FirStream:
    """Causal FIR filter over a stream: process() takes chunks of any length and returns the same number
    of samples, with the filter tail carried into the next chunk. No delay, so the timeline is unchanged."""

    def __init__(self, h):
        self.m = len(h)
        self.nfft = 1 << int(math.ceil(math.log2(BLOCK + self.m - 1)))
        self.H = np.fft.rfft(h, self.nfft)
        self.carry = np.zeros(self.m - 1)

    def process(self, x):
        x = np.asarray(x, float)
        out = np.empty(len(x))
        for s in range(0, len(x), BLOCK):
            seg = x[s:s + BLOCK]
            y = np.fft.irfft(np.fft.rfft(seg, self.nfft) * self.H, self.nfft)[:len(seg) + self.m - 1]
            y[:len(self.carry)] += self.carry
            out[s:s + len(seg)] = y[:len(seg)]
            self.carry = y[len(seg):]
        return out


def fir_filter(x, h):
    """Causal FIR by overlap-add. Output has the length of x."""
    return FirStream(h).process(x)


def apply_response(x, fs, profile):
    """Filters audio by the measured chain response. x: float samples at fs (16 kHz for replay)."""
    _require(profile, "response")
    return fir_filter(x, response_fir(profile, fs))


class NoiseBed:
    """Measured room noise as a stream, in pascals at the mic.

    Each take(n) draws n samples of band-shaped random noise (each band's mean square set to its measured level;
    bins inside a band are equal on average; the realisation is random) and adds the measured tones as
    sinusoids of their measured RMS levels. A tone's phase is drawn once, and its sinusoid runs on the stream's
    own sample count, so consecutive takes join without a phase jump. Above the top band the top band's level
    is held; below the lowest band there is none. Band levels exclude the tone bins, so tones are not counted
    twice.
    """

    def __init__(self, profile, fs=RATE, rng=None):
        _require(profile, "noise")
        self.fs = fs
        self.rng = rng or np.random.default_rng()
        bands = profile["results"]["bands"]
        lo = np.array([b["lo_hz"] for b in bands], float)
        hi = np.array([b["hi_hz"] for b in bands], float)
        spl = np.array([b["spl_db"] for b in bands], float)
        order = np.argsort(lo)
        self.lo, hi, spl = lo[order], hi[order], spl[order]
        # each band is a density (mean square per Hz) over its measured width; the top band is held to Nyquist
        density = 10 ** (spl / 10) * REF_PA ** 2 / (hi - self.lo)
        hi_ext = hi.copy()
        hi_ext[-1] = fs / 2
        self.target = density * (hi_ext - self.lo)
        self.tones = []
        for tone in profile["results"].get("tones", []):
            if tone["hz"] < fs / 2:
                amp = math.sqrt(2) * REF_PA * 10 ** (tone["spl_db"] / 20)
                self.tones.append((tone["hz"], amp, self.rng.uniform(0, 2 * np.pi)))
        self.n_done = 0  # samples produced so far: the tones' time axis

    def take(self, n):
        n = int(n)
        x = self._band_noise(n)
        if self.tones:
            t = (self.n_done + np.arange(n)) / self.fs
            for hz, amp, phase in self.tones:
                x += amp * np.sin(2 * np.pi * hz * t + phase)
        self.n_done += n
        return x

    def advance(self, n):
        """Moves the tones' clock past n samples that the bed does not fill (a clip with no bed under it)."""
        self.n_done += int(n)

    def _band_noise(self, n):
        if n <= 0:
            return np.zeros(0)
        fs = self.fs
        freqs = np.fft.rfftfreq(n, 1.0 / fs)
        weight = np.full(freqs.size, 2.0)
        weight[0] = 1.0
        if n % 2 == 0:
            weight[-1] = 1.0
        weight[freqs < self.lo[0]] = 0.0  # below the lowest measured band: nothing (a board blocks DC)
        ids = np.clip(np.searchsorted(self.lo, freqs, side="right") - 1, 0, len(self.lo) - 1)
        X = np.fft.rfft(self.rng.standard_normal(n))
        base = weight * np.abs(X) ** 2 / n ** 2
        actual = np.bincount(ids, weights=base, minlength=len(self.lo))
        corr = np.where(actual > 0, self.target / np.maximum(actual, 1e-300), 1.0)
        # bins below the lowest band are removed from the output as well as from the power count
        return np.fft.irfft(X * np.sqrt(corr[ids]) * (weight > 0), n)


def noise_from_profile(profile, seconds, fs=RATE, rng=None):
    """Background noise with the measured band levels and tones, in pascals at the mic (one NoiseBed take)."""
    return NoiseBed(profile, fs, rng).take(int(round(seconds * fs)))
