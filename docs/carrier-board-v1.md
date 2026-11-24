# Carrier board and mic pod — v1 spec

Date: 2026-11-06. Status: draft for schematic capture. Nothing here has been built or measured. Background and prices:
[doc 08](research/08-cheap-hardware.md).

**Purpose.** A research node for the five-node line. It adds what a stock fakeTec lacks: a mic that can sit away from the board, calibrated
capture to microSD, tamper sensing, field power and a current-measure point. **It does not save money.** A stock fakeTec or a XIAO kit is as cheap or cheaper (doc 08
section 10). Build this only when those features are needed.

**Scope.** Two boards: a carrier and a mic pod joined by a short cable. Single-mic detector node only. The 4-mic node (doc 08 section 8) is separate.

## 1. Requirements

| # | Requirement | Why |
|---|---|---|
| R1 | Stock Meshtastic `nrf52_promicro_diy_tcxo` and MeshCore `promicro` builds boot and use the radio with no change | Owner's requirement |
| R2 | 16 kS/s PDM capture on pins rated for it | Detector input (`sim/detector/detector.py`) |
| R3 | Mic self-noise no worse than the sim's 29 dB SPL | `sim/acoustics/model.py` |
| R4 | Response usable to 80 Hz | Plan finding 6: large drones near 80 Hz |
| R5 | Mic position free of the board; 0.3 m in the sim, ground mic still to test | `DETECTOR_MIC_H_M`, queued ground-mic check |
| R6 | At least 64 kB/s logged to microSD | Two channels at 16 kS/s, for ambient and crossing recordings (doc 08 section 7) |
| R7 | Accelerometer with a motion interrupt | Doc 06 tamper rule |
| R8 | Battery current measurable without rework | Replaces doc 04's estimates |
| R9 | No RF layout on the carrier | RF stays on the module |

## 2. Modules

**MCU: nRF52840 ProMicro, hand-soldered.**
- Clones vary. One published survey lists different regulators and chargers by batch, a bad 32 kHz crystal on many, and one type (52840nano V1) with **no LDO, so its VCC is unregulated**.
- Batch quality is reported both ways: a builder saw failures on red TenstarRobot boards, and the survey mentions faulty 2025 black ones. Colour is not a reliable guide.
- P1.01, P1.02 and P1.07 are mid-board pads, which only the 29-pin version in Meshtastic's schematic brings out. Confirm the purchased board has them.
- **Incoming check for each board:** flash the bootloader, confirm VCC is 3.3 V at 4.2 V input, confirm P0.13 switches it, and measure nRF VDD (section 6).

**Radio: Heltec HT-RA62-HF, hand-soldered.** SX1262, TCXO per Meshtastic's module table, 3V3 at 2.7-3.5 V and at least 150 mA.
- 16 x 17 x 0.8 mm. **The datasheet disagrees with itself on pitch:** its table says 1.27 mm, its drawing shows 2 x 8 with 1.2 x 0.6 mm pads. Measure a real module before drawing the footprint.
- The datasheet lists an IPEX connector. Use it with a pigtail to a bulkhead SMA. Confirm on a purchased module; if there's none, this breaks R9.

| Pin | Name | Net | Pin | Name | Net |
|---|---|---|---|---|---|
| 1 | ANT | No connect, see above | 9 | GND | GND |
| 2 | GND | GND | 10 | BUSY | P0.29 |
| 3 | 3V3 | VCC | 11 | RXEN | No connect |
| 4 | RST | P0.09 | 12 | SCK | P1.11 |
| 5 | TXEN | No connect | 13 | MISO | P0.02 |
| 6 | DIO1 | P0.10 | 14 | MOSI | P1.15 |
| 7 | DIO2 | No connect | 15 | NSS | P1.13 |
| 8 | DIO3 | No connect | 16 | GND | GND |

## 3. Microphone: IM69D130

**Not the T5838** named in earlier docs. Its High-Quality mode needs 2.0-3.7 MHz and its Low-Power mode 400-800 kHz, and nRF52840 PDM offers 1.000-1.333 MHz, in the gap. Listings also give it a 1.8 V supply, which would need level shifting.

| Parameter | IM69D130 datasheet | Need |
|---|---|---|
| Supply | 1.62-3.6 V | Runs from VCC directly |
| Clock mode | 1.05-1.9 MHz, typ 1.536 | 1.28 MHz fits |
| SNR | 66 dB(A) at 1.536 MHz; **not specified at 1.28** | Sim assumes 65 dB |
| Low-frequency -3 dB | 28 Hz | R4 |
| Sensitivity | -36 dBFS ±1 dB, in all modes | Calibration |
| Current | 620 µA typ at 1.536 MHz; 1 µA max clock off | Power budget |
| Clock duty | 40-60 % below 2.65 MHz | nRF52840 gives 40-60 % |
| Clock rise and fall | **13 ns max** | Sets the cable design |
| Logic | VIH 0.65 VDD, VIL 0.35 VDD | 3.3 V logic |
| DATA | Valid within 100 ns of clock edge; up to 200 pF | Half period is 390 ns |
| Package | LGA 4 x 3 x 1.2 mm, bottom port | PCB port 0.8 mm diameter |
| Price | $1.89-2.02 at quantity 1 | LCSC C536262 |

Pins: 1 DATA, 2 VDD, 3 CLOCK, 4 SELECT, 5 GND. The datasheet's ±2° phase match also suits the 4-mic node.

**PDM setting:** 1.280 MHz with ratio 80 gives exactly 16 kS/s, where 1.032 MHz with ratio 64 gives 16.125. Nordic recommends running HFCLK from the crystal, and the crystal's extra current is not in doc 04's budget.

## 4. Pin map

Meshtastic's nets are unchanged. Additions use pins that its default build leaves unused or uses only for GPS and Serial2. Set GPS to not present on stock firmware.

| Pin | Nordic usage note | Function | Stock firmware | Note |
|---|---|---|---|---|
| P1.11, P1.15, P0.02, P1.13 | Low frequency | Radio SPI | Same | Inherited, so keep these clear of the mic and module RF side |
| P0.10, P0.29, P0.09 | Low frequency | DIO1, BUSY, RST | Same | |
| P0.13 | None | VCC enable, on ProMicro | Same | |
| P0.15 | None | LED, on ProMicro | Same | |
| P0.31 | Low frequency | Battery sense | Same | 1 M to GND, 1.5 M to battery, 100 nF. Meshtastic's scale factor assumes these |
| P1.00 | None | User button | Same | |
| P0.11, P1.04 | None, low frequency | I2C SCL, SDA | Same | Accelerometer, 4-pin OLED header |
| **P0.20** | None | **PDM CLK** | GPS TX | Harmless: a slow clock holds the mic in standby |
| **P0.22** | QSPI, so fast | **PDM DATA** | GPS RX | Input only |
| **P0.06** | None | **SD SCK** | Serial2 RX, unused | |
| **P0.08** | None | **SD MOSI** | Serial2 TX, unused | |
| **P1.06** | Low frequency | **SD MISO** | Unused by default | Input only |
| **P1.01** | Low frequency | **SD CS** | Unused | Slow signal, pull-up to the SD rail |
| **P1.02** | Low frequency | **SD enable** | Unused | Pull-down, so off at reset |
| **P1.07** | Low frequency | **Accelerometer INT1** | Unused | Input only |
| **P0.24** | None | **PPS in, optional** | GPS enable, driven | 1 k series, so the firmware driving it does no harm |
| P0.17 | None | Test point | RXEN, driven | RA-62 doesn't use it |

MeshCore's `promicro` table maps its radio, I2C, battery, button and GPS functions to these same pins. It has no entry for P1.07, so SonicMesh firmware on that base needs one.

No GNSS UART: P0.20 and P0.22 are taken by the mic. PPS alone is enough to align recordings if the start time is known to within 0.5 s.

## 5. Mic pod

- **Board:** small 2-layer FR4, bottom-port mic over a 0.8 mm plated hole, assembled at JLCPCB.
- **Mics:** U1 populated with SELECT to GND. **U2 not fitted by default,** with SELECT to VDD and sharing clock and data. Fit it on one or two pods: side-by-side mics separate mic self-noise from real ambient by coherence, which helps the ambient measurement. Confirm the left and right assignment at bring-up.
- **Supply:** 100 nF at each mic (datasheet), and 10 Ω with 1 µF feeding the pod.
- **Clock:** 13 ns is tight on a cable for a standard-drive pin. Fit a Schmitt buffer (for example a 74LVC1G17) at the pod input, with a 0 Ω bypass, to compare both. At the carrier, 33 Ω series, and set the pin to high drive if the PDM driver allows it.
- **Data:** 33 Ω series at the mic, for edge control.
- **Cable:** 6 conductors, ordered GND, CLK, GND, DATA, GND, VDD. Start at 0.3 m. Test before going longer.
- **Connector:** locking, keyed, rated for field use. Part to be chosen at schematic.
- **Enclosure:** the port needs a hydrophobic membrane and windscreen. Each changes the response, so calibrate with them fitted. That design is Phase 3 work.

**Keep the option of the Adafruit MP34DT01-M breakout** (SNR 61 dB, 1-3 MHz clock per a listing) wired to the same connector, as a bench comparison.

## 6. Power

```
Solar in (optional) --> charger ----+
                                    |
18650 --> protection --> sense jumper --> BAT+ --+--> ProMicro BATIN --> ProMicro LDO --> VCC --> radio, mic pod, accelerometer
                                                 |                      (P0.13 enable)
                                                 +--> SD LDO --> SD rail (enable P1.02)
```

- **Cell:** one 18650 in a holder, with a low-loss reverse-polarity FET, because a cell in backwards is likely in the field.
- **Protection:** undervoltage and overcurrent IC (fakeTec v5 uses an XB8089D). Keep it fitted, as cells vary.
- **Sense jumper:** 2-pin header in series with a solder-bridge bypass (R8).
- **USB charging:** the ProMicro's own charger, 100 mA, or 300 mA with the jumper. Bridge the jumper for an 18650. A guide warns of instability above 450 mAh without it.
- **VCC bulk:** 100 µF, as in Meshtastic's schematic, plus 100 nF at the module.
- **SD rail:** a separate LDO, because the current limit on clone LDOs was not found and SD write peaks add to radio TX. Size it for 300 mA at schematic. Iq only matters when on.
- **SD back-feed:** an unpowered card can be fed through its I/O pins. Pins are unused on stock firmware; in SonicMesh firmware, disconnect them before removing power. The SD bus is deliberately **not** shared with the radio, so a dead card can't load radio SPI.
- **Solar:** footprint only on v1, fitted on one board. Candidate CN3791 (MPPT, 4 A chip rating, set far lower). fakeTec v6's version is marked untested, and the VIN limits were not confirmed. Do not connect USB and solar together until tested.

**Open: rail levels.** Pin voltage on the nRF is limited relative to its own VDD, set in UICR. A 3.3 V rail driving inputs with VDD at 3.0 V would sit at the limit. fakeTec builds already do this with the radio. Measure VDD on the purchased boards and set the bootloader's value before layout.

**Budget, all estimates until measured:** 2-3 mA on protocol v0 duty cycling. About 7-8 mA with continuous LoRa receive. SD off when not logging.

## 7. Accelerometer

LIS2DH12TR (LCSC C110926, $0.36-0.61, stock varies). I2C, motion interrupt to P1.07. Mount rigidly near a board corner. A stock-firmware I2C scan must not hang or misidentify it: check at bring-up.

## 8. Carrier PCB

- 2-layer, 1.6 mm, solid ground on the bottom, stitched. RF needs no controlled impedance, given R9.
- Route PDM clock and SD clock away from the module and the antenna pigtail, and never under the module.
- Headers: mic pod, SWD pads access, PPS, OLED, sense jumper, solar. Test points on VCC, BAT+, SD rail, PDM CLK and DATA.
- Outline set by the enclosure. The fakeTec is a reference only, because its repo has no licence: draw this board fresh.
- Assembly: JLCPCB Economic, about $8 setup, one side, $3 per unique extended part unless preferred. Machine-place passives, regulators, accelerometer, SD socket. Hand-fit ProMicro, radio, holder.

## 9. Bring-up tests

| Step | Test | Pass |
|---|---|---|
| 1 | Incoming ProMicro check, section 2 | VCC 3.3 V, P0.13 switches |
| 2 | Power up without modules, current limited | Rails correct, reset state as designed: SD off |
| 3 | Stock Meshtastic, then MeshCore | Both boot, join a mesh and exchange messages with another node. No hang from the mic, card or accelerometer |
| 4 | PDM at 1.280 MHz, ratio 80 | CLK edges at pod under 13 ns with cable fitted. Tone at the right bin, HFXO on |
| 5 | Radio transmitting during capture | No added lines or lost samples in the spectrum |
| 6 | Noise floor in a quiet box, U1 and U2 | Compare with 29 dB SPL. Coherence separates self-noise |
| 7 | 94 dB SPL calibrator through windscreen | Pa scale within ±1 dB across pods. Calibrator not yet sourced |
| 8 | Low-frequency sweep, 40-400 Hz | Response usable to 80 Hz |
| 9 | SD log, 1 h at 64 kB/s, with radio | No gaps. Largest write stall recorded and buffered |
| 10 | Current with PPK2 in each state | Replaces section 6 and doc 04's estimates |
| 11 | Motion and tamper | INT1 fires, tilt reads, wake from sleep |

## 10. Cost, all estimates

| Item | Per unit |
|---|---|
| ProMicro + HT-RA62 + pigtail + antenna | $13.40 |
| Carrier PCB, assembly and parts, at quantity 5 | $8-15 |
| Mic pod, assembled, one mic | $4-7 |
| Cable, connectors, SMA | $3-5 |
| 18650 | $5 |
| **Node** | **$33-45** |

## 11. Open items before layout

1. Measure the HT-RA62's pad pitch and confirm the IPEX connector on a real module.
2. Measure nRF VDD on purchased ProMicros, and fix the rail question in section 6.
3. Confirm the mid-board pads on purchased boards.
4. Confirm IM69D130 noise at 1.28 MHz by test, since the datasheet doesn't specify that clock.
5. Wait for the ground-mic check before fixing pod mounting.
6. Choose connector, protection IC, LDOs, reverse-polarity FET and SD socket with stock at LCSC.
7. Decide whether LR2021 goes on v2 after the ranging test (doc 08 section 4).

## Sources

- [IM69D130 datasheet](https://www.infineon.com/dgdl/Infineon-IM69D130-DS-v01_00-EN.pdf) and [JLCPCB part](https://jlcpcb.com/partdetail/IM69D130V01/C536262)
- [nRF52840 PDM](https://docs.nordicsemi.com/r/bundle/ps_nrf52840/page/pdm.html) and [pin table](https://docs.nordicsemi.com/r/bundle/ps_nrf52840/page/pin.html)
- [HT-RA62 datasheet](https://resource.heltec.cn/download/HT-RA62/HT-RA62(Rev1.1).pdf) and [reference design](https://resource.heltec.cn/download/HT-RA62/HT-RA62_Reference_design.pdf)
- [Meshtastic ProMicro target](https://github.com/meshtastic/firmware/tree/master/variants/nrf52840/diy/nrf52_promicro_diy_tcxo) and [MeshCore `promicro`](https://github.com/meshcore-dev/MeshCore/tree/main/variants/promicro)
- [ProMicro clone survey](https://github.com/joric/nrfmicro/wiki/ALternatives) and [fakeTec repo](https://github.com/gargomoma/fakeTec_pcb)
- [T5838 clock modes, TDK EVB guide](https://invensense.tdk.com/wp-content/uploads/2022/08/AN-000278-T5838-Flex-EVB-User-Guide-v1.2.pdf), read through search results only
- [LIS2DH12TR at LCSC](https://www.lcsc.com/product-detail/image/LIS2DH12TR_C110926.html) and [CN3791 at LCSC](https://www.lcsc.com/product-detail/C154992.html)
