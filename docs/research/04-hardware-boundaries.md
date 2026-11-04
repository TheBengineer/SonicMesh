# Research 04 — Hardware boundaries: worst-case array node vs minimal single-mic node

Date: 2026-11-04

Script: [`sim/experiments/hw_budget.py`](../../sim/experiments/hw_budget.py) (`uv run sim/experiments/hw_budget.py`).

**Method:**
- Each processing stage is counted in DSP MFLOP/s and neural-network int8 MMAC/s.
- Those totals are mapped onto MCUs using sustained-throughput anchors:
  - *ESP32-S3:* ESP-DSP 1024-point FFT ≈ 64.5k cycles; DS-CNN ≈ 30 ms with ESP-NN.
  - *Cortex-M4:* CMSIS 1024-point complex FFT ≈ 98.6k cycles.
  - *nRF52840:* 52 µA/MHz.
- Throughput and current figures marked *est* are engineering estimates. Phase 2 must measure them.

## Answers in brief

| | Minimal single-mic node | Practical array node | Worst case, "everything on" |
|---|---|---|---|
| Sensing | 1 mic, 8 kS/s | 4 mics, 16 kS/s, 8 beams | 8 mics, 24 kS/s, 16 beams |
| Algorithms | Harmonic comb + tiny NN | + SRP-PHAT bearing, CNN on best beam | + MUSIC, harmonic comb per beam, CNN on 4 beams |
| Compute | **1.7 MFLOP/s + 0.4 MMAC/s** | 18 MFLOP/s + 10 MMAC/s | **190 MFLOP/s + 160 MMAC/s** |
| Working RAM | **~66 KB** | ~450 KB | **~730 KB** (+1.5 MB if raw TDOA audio is buffered) |
| MCU that fits | Anything, even an RP2040 (5%) | ESP32-S3 (8%), RP2350 (17%); nRF54L15 CPU-OK but RAM-tight | **Only ESP32-P4** (~50%); S3 at 103% does not fit |
| Best chip | **nRF52840 / nRF54L15**, for power | ESP32-S3 N16R8 | ESP32-P4 + ESP32-C6 radio companion |
| Node current @ 3.3 V | **~2 mA** (0.16 Wh/day) | ~45–63 mA (3.6–5 Wh/day) | ~85–100 mA (6.7–7.8 Wh/day) |
| Power supply (2 sun-h winter, 3-day autonomy) | One 18650 lasts ~2 months; 0.15 W panel sustains it | 2.5–3.5 W panel, 2× 18650 | 5–6 W panel, 3× 18650 |
| BOM (dev-module level) | **~$20–35** | ~$65–90 | ~$100–140 |

**Takeaways:**
1. **CPU only becomes the limit in the "everything" case.** Running MUSIC, plus a detector and CNN on
   every beam, needs ~2 S3 cores, so only the ESP32-P4 fits. Drop MUSIC (SRP-PHAT is enough) and
   run the CNN on the top 2 beams, and an S3 manages it at ~60%.
2. **Peripherals, not the CPU, dominate power on the bigger nodes.** On a trimmed S3 node:
   GNSS 9 mA, Wi-Fi Remote ID scanning 9 mA, continuous LoRa RX 4.6 mA, PSRAM 5 mA, the MCU's
   idle floor ~20 mA. Duty-cycling those is the main power lever.
3. **The minimal node is set by sleep behaviour, not compute.**
   - It needs < 6% of even a 64 MHz Cortex-M4.
   - Nordic parts keep PDM + DMA running while the CPU sleeps, so the node averages **~2 mA**.
   - ESP32-C3/S3 can't keep I²S sampling in light sleep, so they idle at ~20–25 mA: 10× more.
4. **Buffer TDOA clips as 1-bit 4 kS/s, not raw audio.** Doc 02 showed that's all the gateway needs.
   4 s × 8 mics shrinks from 1.5 MB to **16 KB**, so PSRAM is only needed for R&D raw capture.
5. **Microphone supply is a design input.** The ICS-43434 I²S mic used in the plan has gone
   **Last Time Buy**. TDK's **T5838** is a PDM mic with an acoustic-activity-detect wake mode
   at ~20 µA. Plan around PDM (or TDM) mic families.

## 1. Compute per stage (worst case)

| Stage | MFLOP/s | MMAC/s | Notes |
|---|---|---|---|
| STFT, 8 mics × 2048 pt @ 50 fps | 27 | | ~68k flop per real FFT |
| Beamforming, 16 beams × 8 mics × 683 bins | 35 | | Frequency-domain delay-and-sum, up to 8 kHz |
| SRP-PHAT bearing, 28 pairs @ 10 Hz, 3600 directions | 23 | | One inverse FFT per pair + a lag lookup |
| MUSIC bearing, 32 bins, 720 directions @ 5 Hz | 48 | | Covariance + 8×8 eigen + scan. **Optional** |
| Harmonic comb per beam, 80–1000 Hz @ 0.5 Hz, 10 harmonics | 44 | | Adaptive band covering 80 Hz camera drones to 1 kHz FPV |
| CNN, 10 MMAC × 4 Hz × 4 beams (+ log-mel) | 21 | 160 | A medium keyword-spotting-class model |
| **Total** | **~190** | **160** | |

The trimmed version (no MUSIC, CNN on 2 beams) is 136 MFLOP/s + 80 MMAC/s.

## 2. MCU fit (share of total CPU; "/PSRAM" means buffers must live in PSRAM)

| MCU | Minimal | 4-mic array | Worst, trimmed | Worst case |
|---|---|---|---|---|
| ESP32-P4 (400 MHz ×2, SIMD; *est* 2× S3) | 0% | 4% | 31% | **52%** ✓ (PSRAM) |
| ESP32-S3 (240 MHz ×2) | 1% | 8% ✓ (PSRAM) | 62% (tight, PSRAM) | 103% ✗ |
| RP2350 (150 MHz ×2 M33; *est*) | 1% | 17% ✓ (PSRAM) | 131% ✗ | 206% ✗ |
| nRF54L15 (128 MHz M33) | 3% | 43%, RAM too small for a 200 KB CNN | ✗ | ✗ |
| nRF52840 (64 MHz M4F) | 6% ✓ | 87% ✗ | ✗ | ✗ |
| ESP32-C3 (160 MHz, no FPU) | 5% ✓ | 64% (tight, RAM) | ✗ | ✗ |
| RP2040 (133 MHz ×2 M0+, no FPU) | 5% ✓ | 78% (tight, RAM) | ✗ | ✗ |

**Mic-interface limits matter as much as MIPS:**
- *nRF52840 / nRF54L:* hardware PDM for **2 mics**. Fine for minimal, too few for an 8-mic array.
- *ESP32-S3:* 2× I²S with TDM, and hardware PDM→PCM conversion. Enough for 8 mics in principle;
  verify the PDM line count.
- *RP2040 / RP2350:* PIO captures many PDM mics. PDM decimation then runs in software at roughly
  4 MOPS per mic, which matters for 8 mics.

## 3. Power

**Assumptions:**
- Currents at 3.3 V, with 15% conversion loss.
- Mic ~0.55 mA (ICS-43434: 490–550 µA).
- GNSS MAX-M10S: ~25–28 mW continuous.
- SX1262: RX 4.6 mA; TX 118 mA at 22 dBm.
- Wi-Fi scanning for Remote ID: *est* ~90 mA while active.

| Item, mA | Minimal (nRF52840) | Worst trimmed (ESP32-S3) |
|---|---|---|
| MCU | 0.97 (6% duty, PDM/DMA in sleep) | 38.7 |
| Mics | 0.55 | 4.4 |
| PSRAM | — | 5.0 |
| GNSS | — (surveyed position; LoRa-beacon time sync) | 9.0 (continuous, PPS) |
| LoRa | 0.10 (TDMA beacon RX + heartbeat) | 5.6 (continuous RX + 1 h/day of events) |
| Remote ID scan | 0.12 (BLE, 2% duty) | 9.0 (Wi-Fi + BLE, 10% duty) |
| **Total incl. losses** | **~2.0 mA → 0.16 Wh/day** | **~84 mA → 6.7 Wh/day** |

**Levers for the bigger nodes:**
- **GNSS** only at install, plus occasional PPS discipline. Only the TDOA layer needs tight timing.
- **Remote ID scanning** only after an acoustic detection.
- **LoRa RX** duty-cycled to the TDMA schedule.
- **Avoid PSRAM**, per finding 4.

Together these cut a trimmed S3 node from ~84 mA to roughly 50 mA. The S3's own ~20 mA floor
(I²S running) is then the limit.

## 4. Range per dollar: does the array pay for itself?

**What array gain buys:**
- Delay-and-sum gain against *uncorrelated* noise (mic self-noise, wind turbulence at each port) is
  up to 10·log10(M): **6 dB for 4 mics, 9 dB for 8**.
- With spherical spreading (6 dB per doubling), 6–9 dB would mean 2–2.8× the range.

**What limits it:**
- Real ambient noise (traffic, wind in trees) is *correlated* across a small array at low frequency.
  A 5–15 cm aperture is a small fraction of a wavelength at 100–400 Hz (wavelengths 0.9–3.4 m).
- So for low-frequency drones like the Matrice class (80–400 Hz), array gain against ambient noise
  is small. Larger apertures (0.3–1 m) help there.
- **Estimate a realistic range factor of 1.4–2×.** This is a Phase 3 measurement.

**Cost per km of perimeter** (spacing = 1.5 × range):
- Array nodes cost 3.2× a minimal node.
- With a 1.4–2× range factor, a line of only array nodes costs **1.6–2.3× more per km** than a
  line of minimal nodes.

**So the planned mixed fleet holds up:** minimal nodes form the tripwire, and an array node every
2nd–3rd position adds bearings and direction of travel.

## 5. Recommended node builds

**Minimal detector node, the "floor"**
- **MCU + radio:** nRF52840 + SX1262. Dev: RAK4631 WisBlock (~$18, Meshtastic-supported).
  Later: nRF54L15 at 20 µA/MHz, or a custom PCB.
- **Mic:** 1 PDM mic, e.g. T5838. Its wake-on-sound mode is optional: it saves ~0.5 mA but only
  triggers on loud, close sounds, which costs range.
- **No GNSS.** Position is surveyed at install; time sync comes from gateway LoRa beacons, at the
  ~ms level that detection needs.
- **Remote ID** via BLE scanning.
- **Power:** ~2 mA, so a single 18650 lasts ~2 months, or a 0.15–0.5 W panel runs it indefinitely.
- **Cost:** ~$20–35 per node on dev modules; *est* ~$12–18 on a custom PCB at volume.
- **Simulation:** Renode supports the nRF52840 well, which makes full-firmware emulation of this
  node realistic.

**Array node, the practical "ceiling"**
- **MCU:** ESP32-S3 N16R8, with PSRAM for R&D capture.
- **Mics:** 4 PDM/TDM mics. Use a 10–15 cm aperture for FPV-class drones; consider 30–50 cm for
  low-frequency drones.
- **Radio and timing:** SX1262, plus GNSS with PPS for the optional TDOA layer.
- **Power:** ~45–63 mA, so a 2.5–3.5 W panel and 2× 18650.
- **Cost:** ~$65–90.

**Worst-case reference node, "everything on"**
- **MCU:** ESP32-P4 plus an ESP32-C6 companion for Wi-Fi/BLE, with 8 mics.
- **Use:** only for a research or reference node, or high-value segments, e.g. to generate labelled
  data or test MUSIC against SRP-PHAT.
- **Power:** ~100 mA, so 5–6 W of panel and 3× 18650.
- **Cost:** ~$100–140.

## 6. Bench kit, revised

- **Minimal node:** 2× RAK4631 (nRF52840 + SX1262) + 2× PDM mic breakouts.
- **Array node:** 2× ESP32-S3 N16R8 DevKit + 8× PDM or TDM mics (not ICS-43434: Last Time Buy).
- **GNSS and all-in-one:** 1× LilyGO T-Beam Supreme.
- **Field recording:** 1× Raspberry Pi Zero 2 W + GNSS module, for synced recording.
- **Power:** a USB power meter (e.g. a Nordic PPK2) to replace every *est* in this doc with
  measurements.

## Sources

**DSP and NN throughput**
- [ESP-DSP benchmarks](https://docs.espressif.com/projects/esp-dsp/en/latest/esp-dsp-benchmarks.html)
- [ESP32-S3 DS-CNN ≈ 30 ms with ESP-NN](https://applied-ee.github.io/embedded/docs/edge-ai/tinyml/esp32-inference/)
- [NXP DS-CNN_S example (32 ms on its own Cortex-M board)](https://docs.mcuxpresso.nxp.com/mcuxsdk/24.12.00/html/examples/eiq_examples/tflm_kws/readme.html)
- [IAR CMSIS-DSP FFT cycles](https://github.com/IARSystems/IAR-CMSIS-DSP/wiki/Using-the-CMSIS%E2%80%90DSP-Library-in-IAR-Embedded-Workbench-for-Arm)
- [Arm forum on rfft cycles](https://community.arm.com/support-forums/f/keil-forum/35354/cmsis-dsp-rfft---too-much-cycles)

**MCU power**
- [nRF52840 PS (52 µA/MHz)](https://infocenter.nordicsemi.com/pdf/nRF52840_PS_v1.8.pdf)
- [Nordic nRF54L power blog (20 µA/MHz)](https://devzone.nordicsemi.com/nordic/nordic-blog/b/blog/posts/next-level-nrf54l-series-cutting-power-consumption-even-further)
- [ESP32-S3 power table (Deneyap)](https://docs.deneyapkart.org/en/Cards/Deneyap-Kart-v2/Power-Consumption-esp32-s3.md)
- [Pico 2 power (Jeff Geerling)](https://www.jeffgeerling.com/blog/2024/raspberry-pi-pico-2-rp2350-adds-more-pio-risc-v-cores)
- [Pico 2 power (Gigazine)](https://www.gigazine.net/news/20240906-raspberry-pi-pico-2-power-saving/)

**Radio and GNSS power**
- [SX1262 best-performance app note (118 mA @ 22 dBm)](https://cdn.sparkfun.com/assets/f/f/b/4/2/SX1262_AN-Recommendations_for_Best_Performance.pdf)
- [MAX-M10 product summary](https://content.u-blox.com/sites/default/files/MAX-M10_ProductSummary_UBX-20017987.pdf)

**Microphones**
- [ICS-43434 (DigiKey: Last Time Buy)](https://www.digikey.com/en/products/detail/tdk-invensense/ICS-43434/6140298)
- [ICS-43434 supply current](https://www.symmetryelectronics.com/products/invensense/ics-43434)
- [T5838 (TDK)](https://invensense.tdk.com/products/T5838)
- [T5838 announcement](https://www.yolegroup.com/industry-news/tdk-introduces-worlds-lowest-power-pdm-microphone-with-acoustic-activity-detect/)

**Boards**
- [RAK4631 price](https://store.rakwireless.com/products/rak4631-lpwan-node?h=wisblock-core&m=5)
- [Heltec HT-CT62](https://heltec.org/product-category/lrnode)
