# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Compute, memory and power bounds for a sensor node: worst case vs minimal.

Workloads are counted in float-equivalent DSP MFLOP/s and int8 NN MMAC/s,
then mapped onto MCUs using sustained throughput figures. Anchors:
  - ESP32-S3: ESP-DSP fft4r 1024-pt complex ~64.5k cycles; DS-CNN ~30 ms
    with ESP-NN.
  - Cortex-M4: CMSIS-DSP 1024-pt complex radix-4 f32 ~98.6k cycles.
  - nRF52840: 52 uA/MHz CoreMark.
Figures marked "est" are engineering estimates and must be measured on the
board in Phase 2.

"fits?" is CPU headroom (yes < 60 %, tight < 85 %), then "/PSRAM" if the
working set only fits with buffers in PSRAM, or "/RAM" if it doesn't fit.

Run:  uv run sim/experiments/hw_budget.py
"""
import math
from dataclasses import dataclass


def rfft_flops(n):
    """Real FFT ~ half a complex FFT (5 N log2 N) plus the split/post pass."""
    return 2.5 * n * math.log2(n) + 6 * n


@dataclass
class Profile:
    name: str
    mics: int
    fs: int
    nfft: int
    fps: float
    beams: int            # delay-and-sum beams the detector runs on (0 = raw channel)
    f0_range: tuple       # harmonic-comb fundamental search, Hz
    f0_step: float
    n_harm: int
    srp_rate: float       # SRP-PHAT bearing updates/s (0 = none)
    srp_dirs: int
    music_rate: float     # MUSIC updates/s (0 = none)
    cnn_mmac: float       # per inference
    cnn_rate: float       # inferences/s per channel run
    cnn_channels: int     # beams (or channels) the CNN runs on
    tdoa_buffer_s: float  # seconds of raw audio kept for TDOA clips
    pdm_soft_decim: bool = False

    def workload(self):
        """Returns dict of stage -> (MFLOP/s, MMAC/s int8)."""
        bins = int(self.nfft / 2 * min(1.0, 8000 / (self.fs / 2)))   # use up to 8 kHz
        w = {}
        w["STFT per mic"] = (self.mics * rfft_flops(self.nfft) * self.fps / 1e6, 0)
        if self.beams:
            w["beamforming"] = (self.beams * self.mics * bins * 8 * self.fps / 1e6, 0)
        if self.srp_rate:
            pairs = self.mics * (self.mics - 1) // 2
            w["SRP-PHAT bearing"] = (pairs * (rfft_flops(self.nfft) + 16 * bins) * self.srp_rate / 1e6
                                     + pairs * self.srp_dirs * self.srp_rate / 1e6, 0)
        if self.music_rate:
            m, nb, dirs = self.mics, 32, 720
            cov = nb * m * m * 8 * self.fps
            eig = nb * 30 * m ** 3 * self.music_rate
            scan = dirs * nb * m * (m - 2) * 8 * self.music_rate
            w["MUSIC bearing"] = ((cov + eig + scan) / 1e6, 0)
        chans = max(self.beams, 1)
        cands = (self.f0_range[1] - self.f0_range[0]) / self.f0_step
        w["harmonic comb"] = (chans * cands * self.n_harm * 3 * self.fps / 1e6, 0)
        w["line tracking / Doppler"] = (chans * 0.05, 0)
        if self.cnn_mmac:
            # 40-band log-mel input updated once per frame; the NN itself runs at cnn_rate
            w["CNN classifier"] = (self.cnn_channels * 40 * bins * 2 * self.fps / 1e6,
                                   self.cnn_mmac * self.cnn_rate * self.cnn_channels)
        if self.pdm_soft_decim:
            w["PDM decimation (software)"] = (self.mics * 2.048e6 * 2 / 1e6, 0)
        return w

    def memory_kb(self):
        bins = self.nfft // 2 + 1
        m = {
            "audio frames (double-buffered)": self.mics * self.nfft * 4 * 2 / 1024,
            "spectra": self.mics * bins * 8 / 1024,
            "beam spectra": self.beams * bins * 8 / 1024,
            "detector state / history": max(self.beams, 1) * 4 + 8,
            "CNN arena": 0 if not self.cnn_mmac else (200 if self.cnn_mmac >= 5 else 24),
            "1-bit 4 kS/s TDOA buffer": self.tdoa_buffer_s * self.mics * 4000 / 8 / 1024,
            "radio/mesh/RID stacks": 120 if self.mics > 1 else 24,
        }
        return m

    def raw_tdoa_kb(self):
        return self.tdoa_buffer_s * self.mics * self.fs * 2 / 1024


@dataclass
class MCU:
    name: str
    cores: int
    mflops_core: float     # sustained vectorised float (or fixed-point equivalent)
    mmac_core: float       # sustained int8 MAC
    sram_kb: int
    psram: str
    active_ma: float       # all cores loaded, radios off, at 3.3 V
    idle_ma: float         # CPU asleep, audio DMA still running
    radios: str
    mic_inputs: str
    chip_usd: str
    note: str


MCUS = [
    MCU("ESP32-P4 (400 MHz x2)", 2, 380, 300, 768, "32 MB in-package", 80, 20,
        "none (needs ESP32-C6 companion)", "I2S TDM / PDM", "~$5-8 + companion", "est: ~2x S3 per core"),
    MCU("ESP32-S3 (240 MHz x2)", 2, 190, 150, 512, "up to 8 MB octal", 50, 20,
        "Wi-Fi + BLE 5", "2x I2S, TDM, PDM->PCM hw", "~$2.5-3 (module $4-6)", "anchors: ESP-DSP, ESP-NN"),
    MCU("RP2350 (150 MHz x2 M33)", 2, 75, 100, 520, "optional QSPI", 25, 4,
        "none (Pico 2 W: CYW43)", "PIO: many PDM/I2S", "~$1", "est; PDM decimation in software"),
    MCU("nRF54L15 (128 MHz M33)", 1, 64, 64, 256, "none", 2.6, 0.6,
        "BLE 5 (coded PHY)", "PDM (2 ch), I2S", "~$2-3", "20 uA/MHz (Nordic); rates est"),
    MCU("nRF52840 (64 MHz M4F)", 1, 33, 30, 256, "none", 3.4, 0.8,
        "BLE 5 (coded PHY)", "PDM (2 ch), I2S", "~$3.5-5", "52 uA/MHz; CMSIS M4 FFT anchor"),
    MCU("ESP32-C3 (160 MHz RV32, no FPU)", 1, 40, 50, 400, "none", 22, 22,
        "Wi-Fi + BLE 5", "1x I2S", "~$1.2-1.5", "fixed-point only; I2S stops in light sleep"),
    MCU("RP2040 (133 MHz x2 M0+)", 2, 20, 15, 264, "none", 20, 6,
        "none", "PIO: many PDM/I2S", "~$0.70", "fixed-point only; est"),
]

WORST = Profile("worst case", mics=8, fs=24000, nfft=2048, fps=50, beams=16,
                f0_range=(80, 1000), f0_step=0.5, n_harm=10, srp_rate=10, srp_dirs=3600,
                music_rate=5, cnn_mmac=10, cnn_rate=4, cnn_channels=4, tdoa_buffer_s=4)
TRIMMED = Profile("worst, trimmed (SRP only, CNN on top 2 beams)", mics=8, fs=24000, nfft=2048,
                  fps=50, beams=16, f0_range=(80, 1000), f0_step=0.5, n_harm=10, srp_rate=10,
                  srp_dirs=3600, music_rate=0, cnn_mmac=10, cnn_rate=4, cnn_channels=2,
                  tdoa_buffer_s=4)
ARRAY4 = Profile("4-mic array node (SRP, 8 beams, CNN on best beam)", mics=4, fs=16000, nfft=1024,
                 fps=31.25, beams=8, f0_range=(80, 1000), f0_step=1, n_harm=8, srp_rate=10,
                 srp_dirs=720, music_rate=0, cnn_mmac=5, cnn_rate=2, cnn_channels=1, tdoa_buffer_s=4)
MINIMAL = Profile("minimal single mic", mics=1, fs=8000, nfft=512, fps=31.25, beams=0,
                  f0_range=(80, 1000), f0_step=1, n_harm=6, srp_rate=0, srp_dirs=0,
                  music_rate=0, cnn_mmac=0.2, cnn_rate=2, cnn_channels=1, tdoa_buffer_s=0)
PROFILES = [WORST, TRIMMED, ARRAY4, MINIMAL]

# peripheral currents at 3.3 V, mA (average)
MIC_MA = 0.55                 # ICS-43434 490-550 uA; PDM mics similar in normal mode
GNSS_MA = 9.0                 # MAX-M10S ~25-28 mW continuous at 3 V
LORA_RX_MA, LORA_TX_MA = 4.6, 118   # SX1262 RX; TX at 22 dBm
PSRAM_MA = 5.0                # est, while streaming
RID_WIFI_MA = 90.0            # est, Wi-Fi promiscuous RX on ESP32
EFFICIENCY = 0.85             # regulator + charger


def node_power(profile, mcu, load, minimal):
    p = {}
    duty = min(load, 1.0)
    p["MCU"] = mcu.idle_ma + (mcu.active_ma - mcu.idle_ma) * duty
    p["mics"] = profile.mics * MIC_MA
    if minimal:
        p["LoRa (TDMA beacon RX + heartbeat)"] = 0.1
        p["Remote ID (BLE scan 2 % duty)"] = 0.12
    else:
        p["PSRAM"] = PSRAM_MA if mcu.psram not in ("none",) else 0
        p["GNSS (continuous, PPS)"] = GNSS_MA
        p["LoRa (continuous RX + 1 h/day events)"] = LORA_RX_MA + LORA_TX_MA * 0.2 / 24
        p["Remote ID (Wi-Fi + BLE scan 10 % duty)"] = RID_WIFI_MA * 0.1
    total = sum(p.values()) / EFFICIENCY
    return p, total


def solar(total_ma, sun_h=2.0, autonomy_days=3, cell_wh=12.0, usable=0.8):
    wh_day = total_ma * 3.3 / 1000 * 24
    panel_w = wh_day / (sun_h * 0.7)
    cells = math.ceil(wh_day * autonomy_days / (cell_wh * usable))
    return wh_day, panel_w, cells


def main():
    for prof in PROFILES:
        w = prof.workload()
        dsp = sum(v[0] for v in w.values())
        nn = sum(v[1] for v in w.values())
        print(f"=== {prof.name}: {prof.mics} mic(s) @ {prof.fs / 1000:g} kHz, {prof.nfft}-pt @ {prof.fps:g} fps")
        for k, (f, m) in w.items():
            print(f"    {k:<30} {f:8.2f} MFLOP/s {m:8.1f} MMAC/s")
        print(f"    {'TOTAL':<30} {dsp:8.2f} MFLOP/s {nn:8.1f} MMAC/s")
        mem = prof.memory_kb()
        print(f"    RAM: {sum(mem.values()):.0f} KB working set "
              + ", ".join(f"{k} {v:.0f}" for k, v in mem.items() if v)
              + (f"; raw TDOA buffer instead would be {prof.raw_tdoa_kb():.0f} KB" if prof.tdoa_buffer_s else ""))
        print(f"    {'MCU':<34} {'load (cores)':>12} {'fits?':>12} {'node mA':>8} {'Wh/day':>7} {'panel W':>8} {'18650s':>7}")
        for mcu in MCUS:
            load_cores = dsp / mcu.mflops_core + nn / mcu.mmac_core
            share = load_cores / mcu.cores
            fits = "yes" if share < 0.6 else ("tight" if share < 0.85 else "NO")
            if sum(mem.values()) > mcu.sram_kb * 0.8:
                fits += "/PSRAM" if mcu.psram != "none" else "/RAM"
            _, total = node_power(prof, mcu, share, prof.mics == 1)
            wh, pw, cells = solar(total)
            print(f"    {mcu.name:<34} {load_cores:6.2f} ({share * 100:3.0f}%) {fits:>12} {total:8.1f} "
                  f"{wh:7.2f} {pw:8.2f} {cells:7d}")
        print()

    print("power breakdown, worst trimmed on ESP32-S3 and minimal on nRF52840 (mA at 3.3 V):")
    for prof, mcu in ((TRIMMED, MCUS[1]), (MINIMAL, MCUS[4])):
        w = prof.workload()
        load = (sum(v[0] for v in w.values()) / mcu.mflops_core
                + sum(v[1] for v in w.values()) / mcu.mmac_core) / mcu.cores
        parts, total = node_power(prof, mcu, load, prof.mics == 1)
        print(f"  {prof.name} on {mcu.name}: " + ", ".join(f"{k} {v:.2f}" for k, v in parts.items())
              + f" -> {total:.1f} mA incl. {int((1 - EFFICIENCY) * 100)} % conversion loss")


if __name__ == "__main__":
    main()
