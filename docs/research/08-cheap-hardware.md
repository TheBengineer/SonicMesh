# Research 08 — Cheap hardware for five nodes: parts, Meshtastic and MeshCore, and a custom board

Date: 2026-11-06

No script. Firmware facts come from the `meshtastic/firmware`, `meshcore-dev/MeshCore` and `gargomoma/fakeTec_pcb` repos, read
on this date. Prices come from store listings and search snippets on this date, not from carts. They exclude shipping and
tariffs, and they move often. Anything marked *est* is not sourced. No hardware has been built or measured for this doc.

**Question.** What is the cheapest sound way to build about five nodes? Can the same hardware run Meshtastic and MeshCore? Is
the fakeTec a good starting point for a board of our own?

## Answers in brief

1. **Build five single-mic nRF52840 nodes on fakeTec v3 or v4 boards.** About $20 per node in parts, about $100 for five. With an
   18650 and holder (*est* $5 each), about $125. A few spares and shipping are extra.
2. **The fakeTec is not electrically a Heltec V3.** It copies the V2/V3 outline so cases fit, but it carries an nRF52840 ProMicro and
   a separate SX1262 module. Heltec's V3 is an ESP32-S3. That difference helps: doc 04 picks the nRF52840 because it keeps PDM and
   DMA running while the CPU sleeps, at about 2 mA against 20-25 mA for an S3.
3. **The same fakeTec wiring runs both firmwares.** Meshtastic's `nrf52_promicro_diy_tcxo` and MeshCore's `promicro` targets use the same
   radio pins (section 2). Buy TCXO radio modules, because MeshCore's `promicro` target sets a 1.8 V TCXO.
4. **"Compatible" has limits.** Stock firmware has no acoustic detector, and protocol v0's TDMA does not interoperate with either mesh on
   air. A node runs one or the other at a time unless the detector is built into the mesh firmware (section 3).
5. **Do not design a bare-chip board for five units.** A $3.59 ProMicro undercuts the nRF52840 chip alone at low quantity ($4.44-$6.11
   at most listings). The worthwhile custom board is a **carrier**: ProMicro and radio module on it, plus a mic pod, accelerometer, power and
   a microSD slot, keeping the Meshtastic pin map (section 5).
6. **The fakeTec repo has no licence file.** It has gerbers and design files, but no stated licence, so draw our own carrier and use the repo
   as a reference, or ask the author.
7. **Ranging is the one thing this build gives up.** Doc 06 needs an LR2021 or LR1121, and the SX1262 has no sub-GHz ranging. LR2021
   support in both firmwares is young (section 4). Test it on a $99 two-board kit before putting it on a carrier.
8. **The mic matters more than the board.** The sim assumes 29 dB SPL self-noise (`sim/acoustics/model.py`), which is an SNR of 65 dB. The cheap Adafruit
   breakout is 61 dB, and the IM69D130 is 66 dB at a clock near the one the nRF52840 can give (section 6). The T5838 named in an earlier version of this doc does not work with the nRF52840.

## 1. Options for five nodes

Per-node parts, US915. Prices are in section 9.

| Build | MCU, radio | Mic | Per node | Five | Meshtastic | MeshCore | Assessment |
|---|---|---|---|---|---|---|---|
| **fakeTec v3/v4** | ProMicro nRF52840 + HT-RA62 | Add PDM | **~$20** | **~$100** | Yes, DIY target | Yes, `promicro` | Recommended. Low power, free pins, needs SMD soldering |
| XIAO nRF52840 kit | XIAO + Wio-SX1262 | Add PDM | ~$21 | ~$105 | Yes, support level 1 | Yes, `xiao_nrf52` | Almost no soldering. 32 kHz crystal. Few spare pins, and the kit was out of stock at one store |
| XIAO nRF52840 Sense + Wio-SX1262 | As above | On board, plus an IMU | *est* $25-30 | *est* $135 | Yes | Yes, PDM pins defined | Quickest working detector. Mic is on the dev board, so no remote pod. Mic SNR not checked |
| Heltec T114 | nRF52840 + SX1262 | Add PDM | $23-39 | $115-195 | Yes | Yes, `heltec_t114` | Finished board. Listings run from $17.90 to about $39, so check what each includes |
| Heltec V3 | ESP32-S3 + SX1262 | Add PDM | ~$23 | ~$115 | Yes | Yes, `heltec_v3` | Good price, but draws 10 times the power. Use only for multi-mic work |
| **XIAO ESP32-S3 kit, 4-mic array** | ESP32-S3R8 + Wio-SX1262 | 4 PDM | $31-49, with GNSS $39-60 | One only | Yes, support level 3 | Yes, `xiao_s3_wio` | Chosen for the array node. 8 MB PSRAM, and the radio leaves the header pins free (section 8) |
| Heltec V3, 4-mic array | ESP32-S3 + SX1262 | 4 PDM | ~$38, with GNSS ~$48 | One only | Yes, support level 1 | Yes | Better firmware support, but no PSRAM, against doc 04's ~450 KB of working RAM |

Rejected:
- **Heltec HT-CT62** ($6.90). The cheapest MCU and radio on one module, but it is an ESP32-C3, which doc 04 rates tight and which cannot
  sample in light sleep.
- **RAK4631.** Supported everywhere and was the plan's bench board, but no current price was found. Doc 04's ~$18 needs rechecking.

**"Array" could mean two things.** The chosen build is five single-mic nodes and maybe one 4-mic node (section 8). Five 4-mic nodes would cost about twice as much
and need a far larger power budget. Doc 04 already found that an all-array line costs 1.6 to 2.3 times more per km.

## 2. The fakeTec

- **Versions.** v3 has bigger pads, two buttons and access to the charge-boost option. v4 adds three MOSFETs for switching external
  loads, which suits a mic or GNSS rail. v5 and v6 add battery features, but v6 is marked untested. The repo itself suggests v3 or v4.
- **Stated cost.** About 10 € without options, in the repo. A build guide gives about $11.
- **Radio.** HT-RA62 or E22-22S have a TCXO. RA-01SH does not. Buy the RA-62.

**Radio pins, checked in both firmwares:**

| Signal | Meshtastic `nrf52_promicro_diy_tcxo` | MeshCore `promicro` (through its pin table) |
|---|---|---|
| CS | P1.13 | P1.13 |
| SCK | P1.11 | P1.11 |
| MOSI | P1.15 | P1.15 |
| MISO | P0.02 | P0.02 |
| DIO1 | P0.10 | P0.10 |
| BUSY | P0.29 | P0.29 |
| RESET | P0.09 | P0.09 |
| RXEN | P0.17 | P0.17 |
| 3V3 enable | P0.13 | P0.13 |

Whether a prebuilt MeshCore image for this target is on its web flasher was not confirmed. Building from the repo works either way.

**Where the mic goes.** nRF52840 PDM pins can be routed to GPIOs, but Meshtastic's three "free" mid-board pins are the wrong choice. P1.01, P1.02 and P1.07 are
"low frequency I/O only" in Nordic's table, and third-party guidance puts that limit near 10 kHz, against a PDM clock of 1 MHz or more. Near the radio this could
also add noise. Use the GPS pins instead, since detector nodes have no GNSS: P0.20 and P0.22 are the first candidates. **Check both against Nordic's pin table before wiring.**

**Known problems:**
- **ProMicro batch quality.** One builder reports 10 failures in 20-25 red TenstarRobot boards soon after soldering, and none in the next 5 black boards from another seller. A clone survey reports some faulty 2025 black TENSTAR boards and fine red ones, so colour is not a reliable guide. Flash and test every board before soldering, and buy spares.
- **Charging.** The ProMicro charges at 100 mA, or 300 mA with the boost pads bridged. A guide warns against batteries above 450 mAh without the bridge, which matters
  for an 18650.
- **Bootloader.** Update it before use. Some boards arrive with an old one or none.
- **Antenna pigtail.** One cheap black pigtail underperformed in the repo's notes. Test each node's link.
- **Low-frequency clock.** Both ProMicro targets use the internal RC oscillator (`USE_LFRC`), while XIAO targets use a crystal. Detector-node
  clock accuracy has not been measured and has to be measured on this hardware.

## 3. What Meshtastic and MeshCore compatibility can mean

| Level | What it means | Work | Result |
|---|---|---|---|
| A. Reflash | Hardware runs stock firmware, or SonicMesh firmware, one at a time. UF2 bootloader makes swapping easy | None | Useful as ordinary mesh radios, no detection while on stock firmware |
| B. Detector inside mesh firmware | Detector runs as a task, and alerts go out as mesh messages on a private channel | Moderate | Alerts reach a phone or gateway with no protocol work. Best first pilot |
| C. Protocol v0 | Own TDMA, beacons, event mode and ranging | Most | What the plan specifies. Does not interoperate with either mesh on air |

**Level B limits.** Only short alerts fit: onset, f0, confidence and level. The 2 Hz `DETECT` stream in protocol v0 does not suit a flooded mesh. Slot timing is lost, and
so are event mode and burst TDOA. Continuous LoRa receive also costs power: doc 04 gives 4.6 mA for RX against 0.10 mA duty-cycled. So a level B node draws *est* 7-8 mA, or about
17 days on a 3000 mAh 18650. It still needs measuring.

**Which host first: MeshCore.**
- It is MIT licensed. Meshtastic is GPL-3.0, so a distributed fork with the detector in it must be GPL.
- It has a `simple_sensor` example with time-series code, which is a natural place to attach a detector. This is from its file list; the code has not been reviewed.
- Meshtastic's `AudioModule` is ESP32 voice audio, with no use here.

Keep the detector as a portable core behind a HAL, as the plan says, so hosting it in either firmware or in protocol v0 firmware is a thin layer. The final choice depends on your
network: if you already run a Meshtastic mesh and don't plan to distribute binaries, Meshtastic works too.

## 4. LR2021 and ranging

- **Parts are cheap.** Elecrow's module is $6.90: 10 x 10 mm, 20 pins, with a TCXO listed. This does not fit the RA-62 footprint on a fakeTec.
- **Kit.** Seeed's LR2021 LoRa Plus kit is $99 for two sets, with XIAO nRF54L15 boards.
- **RadioLib** has an LR2021 driver with a ranging command file. This session did not confirm its behaviour on hardware.
- **Meshtastic** has an LR2021 interface, pin definitions in the ProMicro DIY target, a `rak3401-lr2021` target and an nRF54L15 target. The last two are support level 3 and not actively supported.
  The ProMicro readme's module table lists no LR2021 module.
- **MeshCore** has a `CustomLR2021` driver, used on boards such as the MeshTracker X1. Its `promicro` target is SX1262 only, so a ProMicro with LR2021 needs a custom target.

**So:** build the five nodes on SX1262. Buy the two-board kit only for the Phase 2 ranging measurement in doc 06. If ranging proves useful, add the LR2021 on the second carrier revision.

## 5. A custom board

| Level | Design | Cost for 5 | Verdict |
|---|---|---|---|
| 0. Stock fakeTec + hand wiring | PCB is about $2 for five | ~$100 | Do first. Finds real problems cheaply |
| 1. Own carrier | ProMicro + RA-62 or E22 on a 2-layer board | *est* $130-180 with assembly | **Next step.** RF stays on a module, and stock firmware still runs |
| 2. Bare nRF52840 + SX1262 | Own RF layout, match, crystal, power | *est* several hundred, plus test gear | Not at this quantity |

**Why not level 2.** The nRF52840 alone lists at $4.44-$6.11 at low quantity (one LCSC page shows $2.94 but no stock). It is an aQFN part needing fine-pitch assembly, and an
extended-part fee at JLCPCB. RF layout needs a VNA to tune, and modules may carry certification that a new board would not. Doc 04's *est* $12-18 per node needs
volume, so revisit at 50 or more boards.

**Carrier features, in priority order:**
1. **Same pin map as `nrf52_promicro_diy_tcxo`,** so stock firmware boots and the board stays a mesh node.
2. **Mic connector** for a small pod with an IM69D130 on its own board, on high-speed-capable pins, with a series resistor and a ground return beside the clock. The pod lets the mic sit in a windscreen at the
   height under test. A ground-mic check is queued, so do not fix the height in the design. Keep the cable short: 1 MHz or more of PDM clock on a long wire is a real risk for both signal and
   radio noise.
3. **Accelerometer** on the existing I2C pins, for the tamper rule in the plan. Part not yet chosen.
4. **MicroSD slot, or at least its footprint.** See section 7. This is the feature with the largest research value.
5. **Power:** 18650 holder, a charger that suits it rather than relying on the ProMicro's, battery sense on P0.31, and a current-measure jumper so a power profiler can replace doc 04's estimates.
   Add a solar input once a design is tested: fakeTec v6's CN3791 is untested.
6. **Keep the fakeTec's Heltec outline only if** you want those cases. A weatherproof enclosure with a mic port probably sets the outline instead.
7. **Later revision:** a second footprint for the LR2021 module with its own u.FL connector, which avoids an RF stub between the two.

**Assembly.** JLCPCB Economic PCBA is about $8 setup, 2-50 boards, one side, and $3 per unique extended part unless preferred. Keep the passives and mic pod on assembly. Hand-solder the ProMicro and radio so they can be swapped.

## 6. Microphones

| Part | SNR | Low end | Price | Notes |
|---|---|---|---|---|
| MP34DT01-M (Adafruit 3492 breakout) | 61 dB | Not checked | $4.95 (1-9) | Ready to wire. About 4 dB noisier than the sim assumes |
| MP34DT05 | Not checked | 100 Hz listed | $2.16 | Bare part. Lower bound sits above matrice-class fundamentals |
| SPH0641 | Not checked | 100 Hz listed | $2.14 | Bare part |
| **IM69D130** | 66 dB(A) at 1.536 MHz, 69 at 3.072 | 28 Hz | $1.89-2.02 | 1.62-3.6 V, with a 1.05-1.9 MHz mode that covers the nRF52840. Bare, needs a pod. LCSC C536262. Noise at 1.28 MHz is not specified |
| T5838 | 68 | 28 Hz LF cutoff listed | €2.00 | **Does not fit the nRF52840.** High-Quality needs 2.0-3.7 MHz, Low-Power 400-800 kHz, and nRF52840 PDM offers 1.000-1.333 MHz. Listed at 1.8 V too |
| ICS-52000 | Not checked | Not checked | $3-4 | TDM, for array nodes |

**Why the low end matters.** Doc 07 finds that the fundamental gate causes nearly all mini misses, and plan finding 6 puts large drones near 80 Hz. A mic that rolls off at 100 Hz makes a fundamental at 80 Hz harder
to see, on top of the ambient problem. The detector's noise model also needs updating if the mic differs from 29 dB SPL.

**Recommendation:** make the IM69D130 pod the target. Fit an Adafruit breakout on the first node or two so you are not held up by a PCB order, and compare them side by side.

**Sample rate.** The detector assumes 16 kS/s (`sim/detector/detector.py`). nRF52840 PDM at 1.280 MHz with ratio 80 gives exactly that. Nordic recommends the crystal as the clock source. See [the carrier spec](../carrier-board-v1.md).

## 7. What five nodes should measure first

Hardware does not fix the Phase 1 result: gateway Pd below 100 m is far below target in simulation, and mini and matrice are close to zero. What five nodes can do is replace assumptions:
1. **Calibrated ambient level.** The largest open item: matrice node Pd swings from 0.94 at 30 dB to 0.00 at 50 dB against an ASSUMED 40 dB SPL (doc 07 10.1). The IM69D130 datasheet gives sensitivity at ±1 dB.
2. **Real crossings** of your own FPV, with synced recordings at several nodes. This needs storage, and a ProMicro has only 1 MB of flash, so log to microSD or stream over USB to a Pi. It is why the slot is on the carrier list.
3. **Node clock accuracy,** RC against crystal, for the wobble comparison. It has not been measured.
4. **Real current and CPU.** Doc 04 budgets the minimal node at 8 kS/s, while the detector runs at 16 kS/s. So its ~6 % CPU becomes *est* 12 %, and ~2 mA becomes *est* 3 mA. Frames of 8192 samples (F2) also use more RAM, and the room left beside mesh firmware
   on a 256 KB part is not known.

## 8. Recommended order

1. **Now, about $20-50:** one or two nodes for bring-up. A fakeTec v3 with an Adafruit mic, and if you want a working mic that day, a XIAO nRF52840 Sense with a Wio-SX1262. Prove PDM capture alongside LoRa, and measure current.
2. **Then, about $100-125:** the rest of the five on fakeTec v3 or v4, with spare ProMicros, each tested before soldering.
3. **Alongside:** an IM69D130 pod board, *est* under $30 for a few. Bench-compare it against the breakout.
4. **Optional, $99:** the LR2021 kit for the doc 06 ranging test. Only needed if ranging stays in the plan.
5. **Optional, about $39-60:** one XIAO ESP32-S3 array node with GNSS, to measure real array gain (see below).
6. **After that:** the carrier board, using what the first nodes showed.

This replaces the bench kit in `PLAN.md` section 7 if you agree. That list is RAK4631 and ESP32-S3 based, and costs more.

**Chosen build (2026-11-06): five single-mic nodes, and maybe one 4-mic node.**

| Item | Quantity | Cost |
|---|---|---|
| Single-mic fakeTec nodes, Adafruit mic | 5 | $98.70 |
| 18650 and holder | 5 | *est* $25 |
| Spares: 2 ProMicro, 1 HT-RA62 | 3 | $11.08 |
| **Subtotal, single-mic line** | | **~$135** |
| XIAO ESP32-S3 + Wio-SX1262 kit | 1 | $10.90-29.49 |
| Adafruit mics | 4 | $19.80 |
| ATGM336H with PPS, needed only for timing work | 1 | $8.50-11 |
| **Subtotal, 4-mic node** | | **$39-60** |
| **Total** | | **~$175-195**, before shipping and tariffs |

**Why the XIAO ESP32-S3 for the array node.**
- **Memory.** It has 8 MB of PSRAM, while a Heltec V3 has none. Doc 04 budgets about 450 KB of working RAM for an array node.
- **Pins.** Both firmwares put its radio on GPIO 7, 8, 9 and 38-42. That leaves GPIO 1-6, 43 and 44 for a PDM clock, two PDM data lines, PPS and a GNSS UART. Check the GPIO-to-header mapping on Seeed's pinout before wiring.
- **Firmware.** Meshtastic marks it support level 3 and actively supported, against level 1 for the Heltec. MeshCore has `xiao_s3_wio`. Do not mix up the radio boards: Seeed notes that the SX1262 in the nRF52840 kit does not fit this board.
- **Price.** Listings conflict: $10.90 on a Seeed datasheet, £10.50 at The Pi Hut, and $29.49 at a US reseller. Check Seeed's store.

**Wiring the four mics.** The ESP32-S3 takes up to 4 PDM RX lines with 2 mics each, and it has a PDM-to-PCM converter on I2S0 only. So use I2S0 with one shared clock and two data lines, each with one mic set left and one set right. A shared clock keeps the mics sample-aligned, which bearings depend on.
This resolves doc 04's "verify the PDM line count". Whether the converter delivers all four channels at 16 kS/s has not been tested, so try it on one board with two lines before buying the rest.

**Array geometry.** Doc 04 suggests a 10-15 cm aperture for FPV-class drones and 30-50 cm for low-frequency drones. Build a rigid frame that takes both, with short, equal clock wires. A 1 MHz or faster clock over 15-50 cm of loose wire is the main risk, so test signal quality at the largest spacing.

**Power.** Doc 04 budgets 45-63 mA for this node, so run it from a USB power bank in short field sessions. Do not build it for unattended use yet.

**What it should answer.** Doc 04's *est* 1.4-2 times range gain, and whether bearings add enough to justify array nodes in the line. Treat it as a measurement tool that is not part of the five-node line's results, since four of its mics at one spot are not independent nodes.

## 9. Prices used

| Item | Price | Source |
|---|---|---|
| nRF52840 ProMicro | $3.59 (5-6 € for two, red boards) | Build guide; fakeTec issue 30 |
| HT-RA62 | $3.90 | Heltec shop, via search |
| fakeTec PCB, five | ~$2 | Build guide, JLCPCB |
| Pigtail | ~2 € | fakeTec repo |
| 868/915 MHz whip antenna | $3.90 | Heltec |
| Resistors, buttons | *est* $1 per node | Packs from fakeTec repo |
| Adafruit PDM breakout | $4.95 | Adafruit |
| IM69D130 | $1.89-2.02 | Listings via search |
| XIAO nRF52840 + Wio-SX1262 kit | $15.72 | RobotShop, restocking |
| XIAO nRF52840 Sense | ~$15.90 | Switch Science list price |
| Wio-SX1262 for XIAO alone | Not found | Hence the *est* above |
| XIAO ESP32-S3 + Wio-SX1262 kit | $10.90-29.49 | Seeed datasheet via search; OpenELAB |
| Heltec V3 | $17.90-19.90 | Heltec |
| Heltec T114 | $17.90-33.70; $38.99 retail | Heltec; OpenELab |
| ATGM336H with PPS | $8.50-11 | Electrodragon, Tinytronics |
| LR2021 module | $6.90 | Elecrow |
| LR2021 kit, two sets | $99 | CNX Software |
| 18650, holder | *est* $5 | Not sourced |

**Sum for the recommended node:** 3.59 + 3.90 + 0.40 + 2.00 + 3.90 + 1.00 + 4.95 = **$19.74**.

## 10. Off the shelf, or fully assembled custom?

Five nodes, including one mic, antenna and no battery.

| Route | Per node | Soldering | Note |
|---|---|---|---|
| fakeTec + ProMicro + RA-62 + Adafruit mic | ~$20 | SMD and wires | Cheapest, by about $1 |
| XIAO nRF52840 + Wio-SX1262 kit + Adafruit mic | ~$21 | Mic wires, and the pins need checking | Stock varies |
| XIAO nRF52840 Sense + Wio-SX1262 | *est* $25-30 | None for the mic | Least work. Mic and IMU on board, 32 kHz crystal, both firmwares. Mic SNR not found and it can't be moved off the board |
| Bare-chip custom board, fully assembled | *est* $25-40 | None | Assembly itself is cheap (about $8 setup). Parts and RF risk are the cost. No firmware target exists |

**Assembly is cheap, but at five boards it does not beat a ProMicro.** The nRF52840 chip alone costs more than a whole $3.59 ProMicro at most low-quantity listings. Add the SX1262, TCXO, match network and fees, plus VNA tuning, a new firmware target and any certification. Sourced BOM for this route was not done, so its *est* is rough. It may win at 50 or more boards.

**Where fully assembled does pay now:** the mic pod, and the carrier's passives and regulators.

**Recommendation.** For the cheapest working nodes with least effort, buy XIAO Sense and Wio-SX1262 sets, or fakeTecs if $5-10 per node matters. Build a carrier only when the remote mic, microSD or current point are needed.

## 11. Solar that survives weak light (2026-11-17)

**Problem.** A XIAO nRF52840 on a mountain resets. A 6 V camera panel, regulated to 5 V in its own cable, feeds the XIAO's USB input. In weak light the
panel's 5 V sags or cuts out faster than the board hands over to the battery, so the nRF browns out. The XIAO's charger (BQ25101) is a linear charger, and this
review found no input-voltage regulation on it, so it can keep pulling the panel down. Not measured here; it matches the owner's reading and other reports.

**Rule for any fix:** the MCU must never run from the panel. Panel to charger, charger to battery, battery to node. One charger per cell: a forum report
damaged a XIAO's BQ25101 by tying a CN3791 board to the same cell.

### Retrofit the existing node, about $10-15

1. Panel to a charger that throttles its current to hold the input up: Adafruit bq25185 board (5-18 V input, 1 A or 500 mA, "lowers its current draw so
   the input doesn't pull down"). Use the panel's raw 6 V if the regulator in its cable can be bypassed. The 5 V output also works, but sits at the bottom
   of the range.
2. Charger's battery output to the 18650, and the 18650 to the XIAO's BAT pads. **Nothing on USB.** The XIAO then always runs from the battery, its own
   battery sense still reads correctly, and its BQ25101 sits idle with no VBUS.
3. Firmware: MeshCore's nRF52 power management supports `xiao_nrf52`. It refuses to boot below a set voltage (3300 mV in its example), sleeps in SYSTEMOFF,
   and wakes when the battery recovers. This stops the boot loop at a flat battery. A Meshtastic change for the same thing was closed untested.

Caveats: the bq25185 stops after 6 h of uninterrupted charging; the timer resets when the panel drops at night. Li-ion must not charge below 0 °C. The board
lists thermal fault protection, but whether it has an NTC fitted was not checked, so check before a winter on a mountain.

### Retrofit details, from the BQ25185 datasheet (SLUSF65B, Aug 2026)

| Item | Datasheet | Meaning here |
|---|---|---|
| Input operating range | 3.6-18 V | A raw 6 V panel (Voc about 7-7.5 V) is well inside it |
| Input overvoltage | 18-19 V rising, charging stops | A "12 V" panel's Voc of about 21-22 V, more in cold, stops charging near noon |
| Absolute maximum input | 25 V | A cold 12 V panel at open circuit is close to it |
| VINDPM | Battery voltage + about 0.3 V (330 mV typ), else 3.6 V | **Charges whenever the panel can hold about 4.0-4.5 V,** taking only the current it can supply. This is the weak-light behaviour wanted |
| Charge type | Linear | Panel current = charge current. Voltage above the battery is lost as heat |
| Thermal regulation | 100 °C junction | Throttles current when heat builds |
| Safety timer | 360 min | Restarts with each recharge cycle or input loss, so each morning |
| Temperature input | TS/MR, for a 10k NTC; the Adafruit board has none fitted | Cut the TH trace and fit a 10k NTC on the cell. Confirm the cold cutoff against TI's table |

**6 V or 12 V panel.** Keep the 6 V panel. With a linear charger, only current reaches the battery. A 12 V panel of the same wattage gives about half
the current, so about half the charge, and turns the rest into heat, besides tripping the overvoltage limit and nearing the absolute maximum. A 12 V panel
needs a switching MPPT charger such as a CN3791 instead.

**The panel's own 5 V regulator.** Try it first. If it is a buck converter, it turns 6 V into a little more current, which helps a linear charger. If it
still hiccups in weak light, the node no longer resets, because it runs from the battery, but charging is lost while it restarts. Then bypass it and wire
the raw 6 V to the charger. Measure its behaviour at the bench under low light before the trip.

**Which Adafruit board.** Use the plain charger, product 6091.

| Board | How it connects to the XIAO | Verdict |
|---|---|---|
| **6091, charger only** | Battery terminals to the XIAO's BAT pads; nothing on USB | **Use this.** XIAO's own LDO makes 3.3 V, battery sense reads correctly, MeshCore boot protection works, fewest parts, lowest idle drain |
| 6092, 3.3 V buck | Buck output to the XIAO's 3V3 pin | Bypasses the XIAO's battery divider, so firmware sees no battery and boot protection is blind. Plugging in USB later fights the XIAO's LDO |
| 6106, 5 V boost | Boost output to the XIAO's 5V (VBUS) | Recreates the original USB path. MeshCore skips boot protection when VBUS is present, and boosting to 5 V only to drop to 3.3 V wastes energy |

Wire the XIAO to the battery terminals, **not** the board's LOAD/SYS output: SYS sits at up to 4.5 V while the panel is up, above a Li-ion cell's 4.2 V, on
a pin that also reaches the XIAO's own charger and battery divider. Load current then passes through the charger's BAT path, so its termination sees the
node's few mA, which is far below the 10 % termination threshold. When reflashing over USB, disconnect the panel, so two chargers never share the cell for long.

### Off-the-shelf replacements

| Unit | Charger | Panel | Battery | Firmware targets | Price | Fit |
|---|---|---|---|---|---|---|
| **Seeed SenseCAP Solar Node P1** | CN3165, constant-voltage MPPT, 4.5-6 V input | 5 W included | 4x 18650, not included | Meshtastic `seeed_solar_node`, MeshCore `sensecap_solar` (power management supported) | $69.90 launch | Same XIAO nRF52840 family, 6 V class. One forum boot-loop report |
| **Heltec MeshTower V2** | MPPT, 18-24 V; new BMS in rev 2.0 (March 2026) | 10 W included | 3x 2800 mAh, rated -20 to 60 °C | Meshtastic `heltec_mesh_tower_v2`, MeshCore `heltec_tower_v2` | Not confirmed | Best for a cold, exposed site. IP66 metal box. Needs an 18 V panel; the 6 V panel will not work |
| RAK WisMesh Repeater Mini V2 | Not found | Built in | 3200 mAh | Both | $89.90-99.90 | Users report sub-zero charging problems |
| Heltec MeshSolar | BQ4050 + CN3795 | 18-24 V | 1-4 cells | Both | — | Marked discontinued |

### Cost, quantity 1 and 5 (prices checked 2026-11-17, before shipping and tax)

| Route | Uses the installed 6 V panel | Per node | Five | Mic | Note |
|---|---|---|---|---|---|
| **A. Retrofit the mountain XIAO** | **Yes** | **~$10-20** | One node only | Has the XIAO's | bq25185 $6.95, 10k NTC *est* $0.50, wire and gland *est* $3, new 18650 $6.99 if the old cell is suspect. Adafruit was out of stock; The Pi Hut had it |
| B. New DIY node, same power design | Only at the mountain site | ~$44, or *est* ~$55 with enclosure | ~$220-275 | On board | XIAO nRF52840 Sense Plus $17.89, Wio-SX1262 $4.99, bq25185 $6.95, 18650 $6.99, NTC, holder and antenna *est* $7. The other four sites need panels: *est* $20-30 each for a 6 V panel, not sourced |
| C. SenseCAP Solar P1 | No, panel built in | $69.90 launch, $73.72 at RobotShop (restocking), +$28 for four 18650s | ~$490-510 | None | P1-Pro with GPS and cells was $89.90 at launch, so about $450 for five. No external panel input found |
| D. Heltec MeshTower V2 | No, needs 18-24 V | $109-129 on Heltec's store, panel and cells included | ~$545-645 | None | Check the listing is the 22 dBm V2 and not the V2H. Heltec's own pages disagree on price |

**Reading it.** Only route A, and route B at the mountain, reuse the installed panel. Route A also costs least: about a tenth of a replacement unit.
Routes C and D include their panels, so a "new panel" costs no extra money with them, but it means mounting a new unit on the mountain. For five SonicMesh
nodes, route B is roughly half the cost of C and comes with a mic; C and D would each need a mic added. Whether Meshtastic's XIAO kit target runs unchanged
on the Sense **Plus** was not checked.

**For SonicMesh nodes:** neither box has a mic. The MeshTower's GNSS connector might carry PDM, which is not checked. The carrier spec's power section
should use a VINDPM or MPPT charger and run the node from the battery only.

## Sources

**Firmware (read directly)**
- [Meshtastic firmware](https://github.com/meshtastic/firmware): `variants/nrf52840/diy/nrf52_promicro_diy_tcxo`, `variants/nrf52840/seeed_xiao_nrf52840_kit`, `variants/nrf52840/rak3401_lr2021`, `variants/nrf54l15/xiao_nrf54l15`
- [MeshCore](https://github.com/meshcore-dev/MeshCore): `variants/promicro`, `variants/xiao_nrf52`, `variants/meshtracker_x1`, `examples/simple_sensor`
- [RadioLib](https://github.com/jgromes/RadioLib): `src/modules/LR2021`

**fakeTec**
- [fakeTec PCB repo](https://github.com/gargomoma/fakeTec_pcb) and [issue 30, ProMicro failures](https://github.com/gargomoma/fakeTec_pcb/issues/30)
- [Build guide with prices](https://adrelien.com/diy-meshtastic-how-to-build-your-own-meshtastic-device-with-faketec-pcb-nrf52840/)

**Boards and radios**
- [Heltec Meshtastic products](https://heltec.org/product-category/lora/meshtastic/) and [Heltec shop](https://heltec.org/product-category/lrnode)
- [XIAO kit, RobotShop](https://www.robotshop.com/products/xiao-nrf52840-wio-sx1262-kit-for-meshtastic)
- [XIAO ESP32-S3 kit, OpenELAB](https://openelab.com/products/seeed-studio-xiao-esp32s3-sx1262), [The Pi Hut](https://thepihut.com/products/xiao-esp32s3-wio-sx1262-kit-for-meshtastic-lora) and [Seeed wiki](https://wiki.seeedstudio.com/ja/wio_sx1262_with_xiao_esp32s3_kit/)
- [Heltec V3, no PSRAM](https://heltec.org/project/wifi-lora-32-v3/)
- [XIAO nRF52840 Sense, Switch Science](https://www.switch-science.com/products/8146)
- [T114, OpenELab](https://openelab.io/a/s/products/heltec-mesh-node-t114-nrf52840-sx1262-gps-meshtastic-lorawan-868mhz)
- [Elecrow LR2021 module](https://www.elecrow.com/elecrow-lr2021-lora-module-150-960mhz-sub-ghz-full-band-lora-module.html)
- [LR2021 kit, CNX Software](https://www.cnx-software.com/2026/02/16/lr2021-lora-plus-board-combines-semtech-lr2021-and-nordic-nrf54l15-for-high-speed-flrc-and-lora-connectivity/)

**Microphones and GNSS**
- [Adafruit PDM breakout](https://www.adafruit.com/products/3492) and [its mic and SNR](https://www.berrybase.de/en/adafruit-pdm-mems-microphone-breakout)
- [IM69D130 datasheet](https://www.infineon.com/dgdl/Infineon-IM69D130-DS-v01_00-EN.pdf) and [T5838, TDK](https://invensense.tdk.com/products/T5838)
- [MP34DT05, DigiKey](https://www.digikey.com/en/products/detail/stmicroelectronics/MP34DT05TR-A/7385251)
- [SPH0641, Flux](https://www.flux.ai/jecstronic/sph0641lu4h-1.md)
- [ICS-52000, DigiKey](https://www.digikey.co.uk/en/products/detail/tdk-invensense/ICS-52000/6221214)
- [ATGM336H, Electrodragon](https://www.electrodragon.com/?p=43098) and [Tinytronics](https://www.tinytronics.nl/en/communication-and-signals/wireless/gps/modules/atgm336h-gps-module)

**Chips and assembly**
- [ESP32-S3 I2S driver: 4 PDM RX lines, 8 mics, converter on I2S0](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html)
- [nRF52840 pin table](https://infocenter.nordicsemi.com/topic/ps_nrf52840/pin.html) and [Zephyr on low-frequency pins](https://docs.zephyrproject.org/3.6.0/boards/arm/nrf52840dk_nrf52840/doc/index.html)
- [nRF52840 at LCSC](https://lcsc.com/product-detail/image/NRF52840-QIAA-R_C190794.html), [Flux](https://www.flux.ai/lcsc/nrf52840-qiaa-r~r0ks.md) and [TME](https://www.tme.com/us/en-us/katalog/microcontrollers-others_100585/)
- [BQ25185 datasheet, TI](https://www.ti.com/lit/ds/symlink/bq25185.pdf)
- [bq25185 charger, Adafruit 6091](https://www.adafruit.com/product/6091), [The Pi Hut](https://thepihut.com/collections/adafruit/products/adafruit-bq25185-usb-dc-solar-lithium-ion-polymer-charger), [XIAO Sense Plus, RobotShop](https://www.robotshop.com/products/seeed-studio-xiao-nrf52840-sense-plus-unsoldered), [Wio-SX1262, DigiKey](https://www.digikey.com/en/products/detail/seeed-technology-co-ltd/113010003/26553860), [18650 cells](https://www.18650batterystore.com/products/samsung-30q), [SenseCAP P1, RobotShop](https://www.robotshop.com/products/sensecap-solar-node-p1-meshtastic-w-o-gps-battery), [MeshTower V2 kit](https://www.passion-radio.com/lora-mesh/meshtower-v2-3210.html)
- [Adafruit bq25185 board](https://learn.adafruit.com/adafruit-bq25185-usb-dc-solar-charger-with-3-3v-buck-board), [MeshCore nRF52 power management](https://docs.meshcore.io/nrf52_power_management/), [XIAO and CN3791 conflict](https://forum.seeedstudio.com/t/xiao-nrf52840-running-hot-high-power-consumption-and-green-led-always-on/295428)
- [MeshTower V2 datasheet](https://resource.heltec.cn/download/MeshTower-V2/datasheet/MeshTower-V2.pdf), [MeshSolar wiki](https://wiki.heltec.org/docs/devices/open-source-hardware/nrf52840-series/mesh-solar/), [SenseCAP P1 launch](https://www.hackster.io/news/seeed-studio-s-sensecap-solar-node-p1-p1-pro-are-sub-90-solar-harvesting-meshtastic-nodes-b4cabffd13f1.amp), [CN3165 module](https://wiki.dfrobot.com/dfr0559/), [WisMesh Mini V2](https://store.rakwireless.com/products/wismesh-repeater-mini-v2)
- [JLCPCB assembly FAQ](https://jlcpcb.com/help/article/pcb-assembly-faqs) and [assembly price](https://jlcpcb.com/help/article/pcb-assembly-price)
