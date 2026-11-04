"""Phone -> node acoustic channel and placement scenarios.

The phone loops provisioning frames, each carrying its latest GPS fix. Sound
reaches the node's ground-level mic directly and by a ground bounce, with
the time-varying delay that a walking phone or a carried node produces
(so Doppler is built in). Pink ambient noise and mic self-noise are added.
"""
from dataclasses import dataclass, field

import numpy as np
from scipy import signal

import modem
from frame import Fix, enu_to_latlon, pack

C = 343.0
FS_TX = 48_000
GAP_S = 0.15                  # silence between frames
PHONE_SPL_AT_10CM = 80.0      # dB SPL in the carrier band, loud phone speaker
GROUND_REFLECTION = 0.7
NODE_HEIGHT = 0.15
ORIGIN = (51.5, -1.0)         # arbitrary site origin for lat/lon


@dataclass
class Path:
    """Piecewise-linear 3-D trajectory."""
    times: list
    points: list

    def __call__(self, t):
        t = np.atleast_1d(t)
        p = np.asarray(self.points, float)
        return np.stack([np.interp(t, self.times, p[:, i]) for i in range(3)], axis=1)


@dataclass
class Scenario:
    name: str
    duration: float
    phone: Path
    node: Path
    walk_away_start: float     # when the operator leaves the node (for reporting)
    ambient_db: float = 45.0
    accelerometer: bool = True
    key: bytes = b"site-key"
    notes: str = ""
    extra_frames: list = field(default_factory=list)   # (start time, frame bytes), e.g. spoofing


def gps_track(rng, phone, duration, sigma_bias=2.0, tau=60.0, jitter=0.5):
    """Phone GPS fixes at 1 Hz: truth + slowly wandering bias + jitter."""
    t = np.arange(0, duration + 1)
    bias = np.zeros((len(t), 2))
    a = np.exp(-1 / tau)
    bias[0] = rng.normal(0, sigma_bias, 2)
    for i in range(1, len(t)):
        bias[i] = a * bias[i - 1] + np.sqrt(1 - a * a) * rng.normal(0, sigma_bias, 2)
    truth = phone(t)[:, :2]
    return t, truth + bias + rng.normal(0, jitter, (len(t), 2))


def phone_waveform(rng, sc, site_id=7, t0_unix=1_793_800_000):
    """The phone's looping transmission at FS_TX, starting at t=0."""
    gt, gxy = gps_track(rng, sc.phone, sc.duration)
    out = np.zeros(int(sc.duration * FS_TX))
    t, seq = 0.0, 0
    starts = []
    while t < sc.duration:
        i = int(min(t, gt[-1]))
        lat, lon = enu_to_latlon(gxy[i, 0], gxy[i, 1], ORIGIN)
        fb = pack(Fix(site_id, seq, t0_unix + int(t), lat, lon, 30.0, 4.0), sc.key)
        w = modem.modulate(fb, FS_TX)
        a = int(t * FS_TX)
        n = min(len(w), len(out) - a)
        out[a: a + n] += w[:n]
        starts.append(t)
        t += len(w) / FS_TX + GAP_S
        seq += 1
    for t_s, fb in sc.extra_frames:
        w = modem.modulate(fb, FS_TX)
        a = int(t_s * FS_TX)
        n = min(len(w), len(out) - a)
        out[a: a + n] += w[:n]
    sos = signal.butter(2, (700, 7000), btype="band", fs=FS_TX, output="sos")   # phone speaker
    out = signal.sosfilt(sos, out)
    ref = np.sqrt(np.mean(out[out != 0] ** 2))
    return out / ref * 20e-6 * 10 ** (PHONE_SPL_AT_10CM / 20), starts


def pink(rng, n, fs, lo=100, hi=4000):
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / fs)
    spec[1:] /= np.sqrt(f[1:])
    spec[(f < lo) | (f > hi)] = 0
    x = np.fft.irfft(spec, n)
    return x / np.sqrt(np.mean(x ** 2))


def node_recording(rng, sc, tx):
    """Pressure (Pa) at the node mic, sampled at modem.FS."""
    t_rx = np.arange(int(sc.duration * modem.FS)) / modem.FS
    t_tx = np.arange(len(tx)) / FS_TX
    pn = sc.node(t_rx)
    x = np.zeros_like(t_rx)
    for mirror, gain in ((1.0, 1.0), (-1.0, GROUND_REFLECTION)):
        te = t_rx.copy()
        for _ in range(3):
            pp = sc.phone(te) * np.array([1.0, 1.0, mirror])
            r = np.linalg.norm(pp - pn, axis=1)
            te = t_rx - r / C
        x += gain * np.interp(te, t_tx, tx, left=0, right=0) * 0.1 / np.maximum(r, 0.1)
    ambient = pink(rng, len(x), modem.FS) * 20e-6 * 10 ** (sc.ambient_db / 20)
    self_noise = rng.standard_normal(len(x)) * 20e-6 * 10 ** (29 / 20)   # ~65 dB-SNR MEMS mic
    return x + ambient + self_noise


def node_moving(sc, t, thresh=0.05):
    """What an accelerometer reports: is the node moving at time t?"""
    dt = 0.1
    v = np.linalg.norm(sc.node(t + dt) - sc.node(t - dt), axis=1) / (2 * dt)
    return v > thresh


def placement_scenario(name, dwell, accelerometer, ambient_db=45.0, walk=1.4):
    """Operator carries node + phone 40 m, sets the node down, lingers `dwell` s, walks off."""
    hand = 1.2
    carry_from = np.array([-40.0, 5.0])
    stop = np.array([-0.8, 0.0])            # operator stands 0.8 m from the drop point
    t_arrive = np.linalg.norm(stop - carry_from) / walk
    t_place = t_arrive + 2.0
    t_leave = t_place + dwell
    away = stop + np.array([30.0, 25.0])
    t_far = t_leave + np.linalg.norm(away - stop) / walk
    duration = t_far + 15.0
    phone = Path([0, t_arrive, t_place, t_leave, t_far, duration],
                 [[*carry_from, hand], [*stop, hand], [*stop, hand], [*stop, hand],
                  [*away, hand], [*away, hand]])
    node_carry = [*(carry_from + [0.3, -0.2]), 1.0]
    node = Path([0, t_arrive, t_place, duration],
                [node_carry, [stop[0] + 0.3, -0.2, 1.0], [0.0, 0.0, NODE_HEIGHT], [0.0, 0.0, NODE_HEIGHT]])
    return Scenario(name, duration, phone, node, walk_away_start=t_leave,
                    ambient_db=ambient_db, accelerometer=accelerometer)


def standoff_scenario(distance, ambient_db, duration=40.0):
    """Phone held still at a horizontal distance from an already-placed node."""
    p = [distance, 0.0, 1.2]
    n = [0.0, 0.0, NODE_HEIGHT]
    return Scenario(f"standoff {distance:g} m", duration, Path([0, duration], [p, p]),
                    Path([0, duration], [n, n]), walk_away_start=np.inf, ambient_db=ambient_db)
