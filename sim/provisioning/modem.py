"""Acoustic DBPSK modem: phone speaker -> node microphone.

  carrier 2.5 kHz, 200 baud, root-raised-cosine pulses (beta 0.5), so the
  signal occupies ~2.35-2.65 kHz, well inside an 8 kS/s node's band
  63-symbol m-sequence preamble (BPSK) for frame sync, Doppler and phase
  differential BPSK payload: rate-1/2 K=7 convolutional code + interleaver

A walking phone compresses or stretches the whole waveform in time by
alpha = v/c, so the receiver searches the preamble over alpha, which fixes
both carrier offset and symbol timing. alpha's sign also says whether the
phone is approaching (> 0) or walking away (< 0).
"""
import numpy as np
from scipy import signal

import fec
from frame import FRAME_BYTES, bits_to_bytes, bytes_to_bits

FS = 8000
FC = 2500.0
BAUD = 200
SPS = FS // BAUD
BETA, SPAN = 0.5, 6
BAND = (2200.0, 2800.0)

N_INFO = FRAME_BYTES * 8
N_CODED = 2 * (N_INFO + fec.TAIL)
_PERM = fec.interleaver(N_CODED)


def _mseq63():
    reg, out = 0b111111, []
    for _ in range(63):
        out.append(reg & 1)
        fb = (reg ^ (reg >> 1)) & 1          # x^6 + x + 1
        reg = (reg >> 1) | (fb << 5)
    return 1.0 - 2.0 * np.array(out)


PREAMBLE = _mseq63()
N_SYMBOLS = len(PREAMBLE) + N_CODED
FRAME_SECONDS = (N_SYMBOLS + SPAN) / BAUD


def rrc(sps, beta=BETA, span=SPAN):
    t = np.arange(-span * sps // 2, span * sps // 2 + 1) / sps
    h = np.empty_like(t)
    for i, ti in enumerate(t):
        if ti == 0:
            h[i] = 1 - beta + 4 * beta / np.pi
        elif abs(abs(ti) - 1 / (4 * beta)) < 1e-9:
            h[i] = beta / np.sqrt(2) * ((1 + 2 / np.pi) * np.sin(np.pi / (4 * beta))
                                        + (1 - 2 / np.pi) * np.cos(np.pi / (4 * beta)))
        else:
            h[i] = (np.sin(np.pi * ti * (1 - beta)) + 4 * beta * ti * np.cos(np.pi * ti * (1 + beta))) \
                / (np.pi * ti * (1 - (4 * beta * ti) ** 2))
    return h / np.sqrt(np.sum(h ** 2))


def modulate(frame_bytes, fs):
    """Passband waveform at sample rate fs (unit peak-ish amplitude)."""
    coded = fec.encode(bytes_to_bits(frame_bytes))[_PERM]
    syms = [PREAMBLE[-1]]
    for b in coded:
        syms.append(syms[-1] * (1 - 2 * b))
    syms = np.concatenate([PREAMBLE, syms[1:]])
    sps = int(round(fs / BAUD))
    up = np.zeros(len(syms) * sps)
    up[::sps] = syms
    bb = np.convolve(up, rrc(sps))
    t = np.arange(len(bb)) / fs
    return np.real(bb * np.exp(2j * np.pi * FC * t)) * np.sqrt(2) / np.sqrt(sps)


class Receiver:
    """Batch receiver over a node recording at FS (pressure in Pa)."""

    def __init__(self, alpha_max=0.012, alpha_step=0.0015):
        self.h = rrc(SPS)
        rc = np.convolve(self.h, self.h)
        up = np.zeros(len(PREAMBLE) * SPS)
        up[::SPS] = PREAMBLE
        d = (len(rc) - 1) // 2
        self.template = np.convolve(up, rc)[d: d + len(up)]
        self.alphas = np.arange(-alpha_max, alpha_max + alpha_step / 2, alpha_step)

    def baseband(self, x):
        n = np.arange(len(x))
        return np.convolve(x * np.exp(-2j * np.pi * FC * n / FS) * np.sqrt(2), self.h, "same")

    def _template(self, alpha):
        m = np.arange(int(len(self.template) / (1 + alpha)))
        tpl = np.interp(m * (1 + alpha), np.arange(len(self.template)), self.template)
        return tpl * np.exp(2j * np.pi * FC * alpha * m / FS)

    def _ncorr(self, y, tpl):
        c = signal.fftconvolve(y, np.conj(tpl[::-1]), "valid")
        cs = np.concatenate([[0.0], np.cumsum(np.abs(y) ** 2)])
        e = cs[len(tpl):] - cs[: len(cs) - len(tpl)]          # moving energy over the template
        return np.abs(c) / (np.linalg.norm(tpl) * np.sqrt(e) + 1e-30)

    def detect(self, y, threshold=0.45):
        """Preamble detections as (start index, alpha, score)."""
        rows = [self._ncorr(y, self._template(a)) for a in self.alphas]
        n = min(len(r) for r in rows)            # template length varies with alpha
        scores = np.array([r[:n] for r in rows])
        best = scores.max(axis=0)
        frame_len = int(FRAME_SECONDS * FS)
        peaks, _ = signal.find_peaks(best, height=threshold, distance=int(0.8 * frame_len))
        out = []
        for p in peaks:
            a0 = self.alphas[int(np.argmax(scores[:, p]))]
            out.append(self._refine(y, p, a0))
        return out

    def _refine(self, y, p, a0):
        lo, hi = max(p - 3 * SPS, 0), p + 3 * SPS + len(self.template)
        best = (0.0, p, a0)
        for a in np.arange(a0 - 0.0015, a0 + 0.0016, 0.00025):
            tpl = self._template(a)
            seg = y[lo: hi + len(tpl)]
            if len(seg) < len(tpl):
                continue
            s = self._ncorr(seg, tpl)
            i = int(np.argmax(s))
            if s[i] > best[0]:
                best = (s[i], lo + i, a)
        return best[1], best[2], best[0]

    def demodulate(self, y, start, alpha):
        """Returns (frame bytes or None, alpha refined by the preamble's residual phase)."""
        def sample(alpha):
            k = np.arange(N_SYMBOLS)
            pos = start + k * SPS / (1 + alpha)
            if pos[-1] >= len(y) - 1:
                return None, pos
            z = np.interp(pos, np.arange(len(y)), y.real) + 1j * np.interp(pos, np.arange(len(y)), y.imag)
            return z * np.exp(-2j * np.pi * FC * alpha * pos / FS), pos

        z, pos = sample(alpha)
        if z is None:
            return None, alpha
        # maximum-likelihood residual frequency over the whole preamble
        w = z[: len(PREAMBLE)] * PREAMBLE
        k = np.arange(len(w))
        freqs = np.arange(-6.0, 6.0, 0.02)
        f_res = freqs[np.argmax(np.abs(np.exp(-2j * np.pi * np.outer(freqs, k) / BAUD) @ w))]
        alpha = alpha + f_res / FC
        z, pos = sample(alpha)
        w = z[: len(PREAMBLE)] * PREAMBLE
        z = z * np.exp(-1j * np.angle(np.sum(w)))
        d = z[len(PREAMBLE):] * np.conj(z[len(PREAMBLE) - 1: -1])
        soft_tx = np.real(d) / (np.mean(np.abs(z) ** 2) + 1e-30)
        soft = np.empty(N_CODED)
        soft[_PERM] = soft_tx
        bits = fec.decode(soft)
        return bits_to_bytes(bits[:N_INFO]), alpha


def band_level_db(x, hop_s=0.25):
    """Carrier-band SPL (dB re 20 uPa) every hop_s seconds."""
    sos = signal.butter(4, BAND, btype="band", fs=FS, output="sos")
    xb = signal.sosfilt(sos, x)
    hop = int(hop_s * FS)
    n = len(xb) // hop
    rms = np.sqrt(np.mean(xb[: n * hop].reshape(n, hop) ** 2, axis=1))
    return np.arange(n) * hop_s + hop_s / 2, 20 * np.log10(rms / 20e-6 + 1e-12)
