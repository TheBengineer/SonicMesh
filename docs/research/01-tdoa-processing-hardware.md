# Research 01 — TDOA without a crisp event, processing budget, boards, emulation

Date: 2026-11-04

## Answers in brief

1. **TDOA does not need a crisp event.** A drone's sound is not a pure tone. Its rotor speeds wobble
   constantly under flight control, and blade passage modulates broadband noise. That random
   modulation is the "event". Correlating it between two time-synced nodes 300 m apart gives
   **0.1 ms (raw audio)** or **1–3 ms (compact spectrogram features)** of TDOA error, down to about
   0 dB band SNR. 1 ms of timing error is only 0.34 m of range difference, so accuracy is not the bottleneck.
2. **The real constraints are elsewhere:**
   - *SNR threshold.* TDOA fails below about −5 dB (features) or −10 dB (raw audio). The detector
     itself can work at lower SNR, so TDOA coverage is smaller than detection coverage.
   - *Moving drones* make the TDOA drift within a window (differential Doppler). This is solved by
     searching over drift rate. As a bonus, the drift rate is a measurement in its own right
     (frequency difference of arrival, FDOA), which gives velocity information.
   - *Data transport.* The audio or features must reach one place. That is far beyond what LoRa can
     carry routinely, and it is the biggest hardware-driving finding (see §3).
3. **Per-node bearing (a small mic array) and TDOA both look feasible.** Recommended: bearings as
   the always-on baseline (tiny messages), with TDOA as a precision layer where the backhaul allows.
   The simulator should evaluate both.
4. **Processing is cheap.** Detection plus feature extraction plus bearing estimation uses well under
   one core of an ESP32-S3. **RAM is the real need.** Buffering a few seconds of multi-mic audio for
   TDOA requires PSRAM.
5. **No emulator models a microcontroller's I²S audio peripheral** (QEMU-Espressif, Wokwi and Renode
   all lack it for the chips we care about). So simulate at the firmware/HAL boundary instead:
   compile the node's processing core natively, feed it simulated audio, and use emulators and real
   boards only for ISA, memory and timing checks.

---

## 1. TDOA experiment

Script: [`sim/experiments/tdoa_feasibility.py`](../../sim/experiments/tdoa_feasibility.py)
(`uv run sim/experiments/tdoa_feasibility.py`; takes about 3 min).

**Model:**
- *Drone:* 4 rotors, blade-pass ~180 Hz ±3% per rotor, 10 harmonics. Rotor speed jitter is
  0.5% or 2% (attitude control, ~6 Hz bandwidth), plus slow thrust drift. Blade passage
  amplitude-modulates broadband noise.
- *Propagation:* retarded-time delay to each node (hovering, or moving at 10 m/s), ISO 9613-1 air
  absorption, 0.2 ms rms turbulence travel-time jitter per path, and independent pink background noise.
  SNR is measured in the 100–2000 Hz band at each node.
- *Geometry:* nodes 300 m apart, drone at ~160 m and ~250 m, 4 s window, 12 trials per cell.
- *Truth:* the arrival-time difference of the *same emitted wavefront*.

Results are the median |error| and the share of trials within 5 ms (5 ms ≈ 1.7 m of range difference):

| Case | SNR | GCC-PHAT, raw audio | GCC-PHAT + Doppler search, raw audio | Spectrogram features + Doppler search |
|---|---|---|---|---|
| hover, 0.5% jitter | 0 dB | 0.0 ms / 100% | 0.0 ms / 100% | 1.9 ms / 83% |
| hover, 0.5% jitter | −5 dB | 0.1 ms / 75% | 0.1 ms / 83% | 22 ms / 25% |
| hover, 2% jitter | −5 dB | 0.0 ms / 100% | 0.0 ms / 100% | 4.0 ms / 58% |
| hover, 2% jitter | −10 dB | 0.1 ms / 67% | fails | fails |
| 10 m/s, 0.5% jitter | 0 dB | **fails (drift)** | 0.1 ms / 100% | 3.2 ms / 75% |
| 10 m/s, 2% jitter | 0 dB | **fails (drift)** | 0.0 ms / 100% | 2.8 ms / 75% |
| 10 m/s, any | ≤ −5 dB | fails | fails | mostly fails |

**Takeaways:**
- **Harmonic ambiguity was not a problem.** PHAT whitening plus broadband noise and rotor jitter
  produce a single, sharp correlation peak.
- **Moving targets need the Doppler search.** A 10 m/s drone changes the TDOA by up to ~6% of
  elapsed time, roughly 100 ms over a 4 s window. Without compensation, raw GCC fails completely.
  The spectrogram method finds a coarse drift rate cheaply, and that seeds the fine raw-audio search.
- **Tracking a single "f0" (blade-pass frequency) per node does not work.** This was tried first and
  failed: with 4 rotors at different speeds, the f0 estimate jumps between rotors. Keep the whole
  spectrum as the feature.
- **The SNR threshold matters most.** TDOA works roughly where band SNR ≥ 0 dB (features) or
  ≥ −5…−10 dB (raw audio). That covers the inner part of each node's detection radius.

**Not yet modelled (all need checking with real recordings):**
- Rotor noise directivity: each node hears a different "side" of the drone, which lowers correlation.
- The ground-reflection multipath.
- Real turbulence coherence loss, which grows with frequency and distance.
- Wind bias: 5 m/s of wind along a 300 m path shifts the travel time by ~13 ms (~4 m). Tolerable,
  or can be estimated as an extra unknown when there are enough nodes.
- Multiple simultaneous drones.

**Accuracy budget:**
- Position error ≈ GDOP × c × σ_τ, where GDOP (geometric dilution of precision) is about 1–3
  inside a well-shaped node grid.
- 3 ms of timing error gives 1 m × GDOP, which is far inside the 30 m goal.
- So TDOA's limit is availability (SNR, transport), not precision.
- Timing needs are loose: GNSS PPS (~50 ns) is overkill, but needed anyway for self-location.
  Sample-clock drift (±20 ppm → 80 µs over 4 s) is negligible if each DMA buffer is timestamped
  against PPS.

## 2. Processing budget (ESP32-S3 @ 240 MHz)

| Task | Load | Basis |
|---|---|---|
| 2048-pt real FFT, 50 frames/s × 4 mics | ~7% of one core | ESP-DSP `fft4r_fc32` 1024 complex ≈ 64k cycles (~0.27 ms), plus real-FFT post-processing |
| Harmonic detector / spectrogram features | < 2% | ~10⁵ multiply-accumulates (MACs) per frame |
| Bearing: GCC-PHAT on 6 mic pairs, 10 Hz | ~3% | 6 × 1024 inverse FFTs |
| Small CNN classifier, 2 inferences/s | ~5–10% (estimate) | 1–5 M MACs per inference with ESP-NN; **measure on the board** |
| **Total** | **≲ 25% of one core** | The second core stays free for radio, GNSS and the mesh |
| **RAM** | **≥ 512 KB** for a 4 s × 4-mic × 16-bit audio buffer | **Needs PSRAM.** Pick modules with 8 MB PSRAM (e.g. N16R8) |

So any modern 150 MHz+ MCU with an FPU and DSP instructions is enough: ESP32-S3, RP2350 or nRF52840
(the last is tight). Choose on PSRAM, the radio options, and multi-mic capture instead.

## 3. Data transport decides the radio

| Payload per TDOA event (4 s, one node) | Size | LoRa SF7 airtime | EU868 1% duty-cycle limit |
|---|---|---|---|
| Detection/bearing message | 30–50 B | ~70 ms | fine (dozens per hour) |
| Spectrogram features (~180 bins × 50 fps, 1-bit sign) | ~4.5 KB | ~7 s | one per ~12 min, so **not viable** |
| Raw audio, 8 kHz ADPCM | ~16 KB | ~25 s | no |

**Options:**
1. **LoRa for detections and bearings only.** TDOA computed only between nodes on a faster link.
2. **Wi-Fi HaLow (802.11ah)** on an ESP32-S3 board: Heltec HT-HC32/33 and LilyGO T-Halow claim
   1–2 km at Mbps rates, for about $25–65. This would make on-demand TDOA snippets easy, and
   **it's the backhaul worth testing.**
3. **ESP-NOW / Wi-Fi long-range (LR) mode** for short-baseline clusters (~200 m–1 km line of sight).
4. **SX1280 (2.4 GHz LoRa/FLRC)**, at up to ~1 Mbps but shorter range.

**Proposed design:** each node keeps a rolling PSRAM audio buffer and sends small detection and
bearing messages over LoRa. The gateway then *requests* compressed features or audio from the 2–4
best nodes over the faster link. This needs a protocol where the gateway pulls data from nodes,
not just a flood of messages.

## 4. Low-cost boards worth considering

| Board | ≈ Price | What it brings | Fit |
|---|---|---|---|
| ESP32-S3-DevKitC-1 N16R8 | $10–15 | 8 MB PSRAM, 2× I²S, Wi-Fi/BLE (Remote ID) | **Main node MCU** |
| Seeed XIAO ESP32S3 Sense | $14–20 | Same S3 with 8 MB PSRAM, onboard PDM mic, tiny | First bench captures, cheap single-mic nodes |
| Heltec WiFi LoRa 32 V3/V4 | $18–22 | S3 + SX1262 + OLED. No GNSS (V3 also appears to lack PSRAM: verify) | Mesh/radio dev, gateway radio |
| LilyGO T-Beam Supreme | $45–60 | S3 + SX1262 + GNSS + battery/solar | **All-in-one dev node** (check PPS pin and PSRAM) |
| Heltec / LilyGO ESP32-S3 HaLow boards | $25–65 | S3 + 802.11ah, 1–2 km Mbps | Backhaul experiment for TDOA |
| Raspberry Pi Pico 2 / 2 W (RP2350) | $5–7 | 150 MHz M33 with DSP/FPU; PIO captures many PDM/I²S mics with deterministic timing | Cheap mic-array front end |
| ESP32-P4 (e.g. Waveshare) | ~$21 | 400 MHz RISC-V with SIMD, lots of RAM, no radio | Overkill now; future "fat node" |
| Teensy 4.1 | $32–50 | 600 MHz M7, mature audio library | Bench reference, not a low-cost node |
| ReSpeaker XVF3800 / 6-mic Pi HAT | $30–70 | Ready-made arrays. The XVF3800's onboard direction-of-arrival is speech-tuned | Quick multi-channel data capture only |
| Raspberry Pi Zero 2 W + USB mic array + GNSS | ~$60 | Linux; records raw, PPS-synced, multi-channel audio | **Phase 2 field recorder**, much faster than writing firmware first |

Prices are from mixed retailers and dates. Re-check them before ordering.

## 5. Emulation and simulation

| Tool | Chips | Audio (I²S) | Notes |
|---|---|---|---|
| Espressif QEMU fork | ESP32, ESP32-S3, C3 | ✗ | Emulates the CPU, flash, PSRAM, UART, DMA (GDMA), crypto blocks and a virtual Ethernet. "Not officially supported". Not cycle-accurate. |
| Wokwi (+ `wokwi-cli` for CI) | ESP32 family, RP2040, AVR, STM32 | ✗ (on the roadmap; analog mic via ADC only) | Easy CI with an API token. Not cycle-accurate. |
| Renode | nRF52840, many STM32, RP2040 (third-party) | ✗ in the mainline | Strong multi-node and simulated-radio support. No Xtensa/ESP32. |
| Meshtastic native (portduino) + Meshtasticator | Linux host | n/a | Runs the real mesh firmware with a simulated LoRa radio. Good for mesh behaviour. |

**Recommended simulator architecture:**

```
 scenario.yaml ─► Acoustic world (Python/numpy)           ─► per-node mic streams
                  drone source models / recordings             │
                  propagation: retarded delay, spreading,       ▼
                  ISO 9613-1 absorption, ground reflection,  Node firmware core (C/C++)
                  wind, turbulence jitter                    built natively behind a HAL:
                  noise scenes (wind, traffic)               audio_in / clock / radio_out
                                                                │ detection msgs
                                                                ▼
                                       Network model (airtime, loss, hops; later Meshtasticator)
                                                                │
                                                                ▼
                                       Gateway fusion + tracker (Python) ─► metrics vs ground truth
```

- The **same C/C++ core** gets built three ways:
  1. Natively, linked into the simulator: fast, deterministic, and dozens of nodes at once.
  2. For ESP32-S3 under QEMU in CI: catches ISA, alignment and memory-size problems.
  3. On a real $10 board, for cycle counts.

  Emulators are not cycle-accurate, so the CPU budget in §2 must be measured on hardware.
- Because audio enters through the HAL, the missing I²S emulation doesn't matter.
- Reuse `pyroomacoustics` for its mic-array direction-of-arrival algorithms (SRP-PHAT, MUSIC) as a
  baseline for bearing estimation. The outdoor propagation model is our own: grow it from
  `tdoa_feasibility.py`.

## 6. Suggested next steps

1. Turn the experiment's synthesis code into a `sim/acoustics` module. Add ground reflection, wind,
   per-direction source directivity, and mic-array nodes.
2. Add a bearing experiment: 4 mics, 5–15 cm aperture, bearing error vs SNR. Compare position error
   from bearing intersection, TDOA, and hybrid fusion.
3. Define the firmware HAL and build the detector core natively.
4. Buy a minimal bench kit:
   - 2× ESP32-S3 N16R8 DevKits
   - 8× ICS-43434 mics
   - 1× T-Beam Supreme
   - 2× Heltec HaLow S3 boards
   - 1× Pi Zero 2 W with GNSS for synced field recordings

   Real two-node recordings are what validate (or kill) the TDOA numbers above.

## Sources

**TDOA and acoustics**
- [Lim, Joo & Kim — drone source localization with distributed mic arrays (Sensors 2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11946234/)
- [Fernandes et al. — Optimized TDOA drone localization with distributed microphones (JCIS)](https://jcis.sbrt.org.br/jcis/article/view/947)
- [Ghouli — Real-time drone localization with distributed MEMS microphones (Acta Acustica 2026)](https://acta-acustica.edpsciences.org/articles/aacus/pdf/2026/01/aacus250134.pdf)
- [Indoor drone localization via acoustic measurement (arXiv 2504.00445)](https://arxiv.org/pdf/2504.00445)
- [Signal processing and propagation for aeroacoustic sensor networks (coherence vs separation)](https://typeset.io/pdf/signal-processing-and-propagation-for-aeroacoustic-sensor-47537jjsh8.pdf)
- [Harvey — harmonic source detection/localization thesis (MUN 2018)](https://research.library.mun.ca/13217)
- [Coherence-based drone detection (Drones 2(1):4)](https://www.doi.org/10.3390/DRONES2010004)
- [Tobin — smartphones as distributed acoustic UAV sensors (2021)](https://www.soest.hawaii.edu/earthsciences/academics/theses/Tobin_J_2021_Report.pdf)
- [sound-propagation (ISO 9613 in Python)](https://pypi.org/project/sound-propagation/)

**Processing budget**
- [ESP-DSP benchmarks](https://docs.espressif.com/projects/esp-dsp/en/latest/esp-dsp-benchmarks.html)

**Emulation**
- [Espressif QEMU README](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md)
- [Espressif QEMU issue thread on ESP32-S3 support](https://github.com/espressif/qemu/issues/42)
- [Wokwi ESP32 docs (peripheral table)](https://docs.wokwi.com/de-DE/guides/esp32)
- [Wokwi + ESP-IDF CLI/CI](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/third-party-tools/wokwi.html)
- [Renode supported boards](https://renode.readthedocs.io/en/latest/introduction/supported-boards.html)
- [Renode RP2040 simulation (third-party)](https://osrtos.com/projects/renode-rp2040-simulation)
- [Meshtastic Linux native](https://meshtastic.org/docs/software/linux-native)
- [Meshtasticator](https://meshtastic.org/docs/software/meshtasticator/)

**Boards and radios**
- [Heltec V3 vs T-Beam comparison](https://pamfinds.pages.dev/compare/heltec-v3-vs-t-beam/)
- [T-Beam Supreme listing](https://store.rokland.com/collections/vendors/products/lilygo-t-beam-supreme-esp32-s3-lora-development-board-sx1262-915mhz-gps-l76k-or-u-blox)
- [Heltec HaLow products](https://heltec.org/product-category/halow/)
- [Heltec HT-HC32 HaLow wiki](https://wiki.heltec.org/docs/devices/wifi-halow/ht-hc32/)
- [LilyGO T-Halow (CNX)](https://www.cnx-software.com/2024/07/24/lilygo-t-halow-esp32-s3-board-long-range-wifi-halow-ov2640-ov5640-camera/)
- [XIAO ESP32S3 Sense](https://core-electronics.com.au/seeed-studio-xiao-esp32s3-54467.html)
- [MCU-for-audio roundup (prices, low confidence)](https://pamfinds.pages.dev/best/best-microcontroller-for-audio/)
- [ESP32-P4 board pricing thread](https://esp32.com/viewtopic.php?p=136205)
- [ReSpeaker XVF3800 DOA](https://wiki.seeedstudio.com/respeaker_xvf3800_xiao_doa_vad/)
