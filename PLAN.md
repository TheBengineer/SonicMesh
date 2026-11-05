# SonicMesh — Prototyping Plan

**Goal:** a loose perimeter of cheap, microcontroller-based acoustic sensor nodes that detects
small drones (Group 1 UAS, < 25 kg) crossing it at low altitude. Scope is the perimeter alone; radar
and other outside sensors are off the table for now, in the simulation and the hardware.

The perimeter is a tripwire. For each crossing it answers *did something cross, where along the
line, which way, and when*. Precise localisation is a bonus, not the core requirement.

Research so far, which this plan builds on:
- [01: TDOA, processing, boards, emulation](docs/research/01-tdoa-processing-hardware.md)
- [02: information budget over LoRa](docs/research/02-information-budget.md)
- [03: real drone recordings](docs/research/03-real-hover-audio.md)
- [04: hardware boundaries](docs/research/04-hardware-boundaries.md)
- [05: acoustic provisioning](docs/research/05-acoustic-provisioning.md)
- [06: LoRa ranging and health telemetry](docs/research/06-ranging-and-health.md)

Design: [message format and schedule v0](docs/protocol-v0.md).

---

## 1. Concept: a tripwire that crosses terrain

- **Strong at:** low, slow, terrain-hugging drones close to the line, including RF-silent ones.
- **Weak at:** range (a few hundred m per node), wind, high-altitude targets.
- **Output:** crossing alerts with segment, time, direction, class and confidence.

**Network.** Backbone + local mesh clusters ([protocol](docs/protocol-v0.md), sections 3a–3b).
Three controllers, one for each subsection of the line, link in a mesh on their own LoRa channel, so the
line can cross ridges and rivers. Each runs a LoRa cluster of nodes, and only summaries cross the
backbone. Observer stations behind the line listen to the backbone. Every node can also reach a
second controller at slightly longer range, and moves there if its own fails. Neighbouring nodes hear each other
directly, for faster confirmation and fixes in the first seconds, at cluster boundaries and behind
terrain.

---

## 2. What the research established

1. **Continuous drone sound is enough for timing. No crisp event is needed.**
   - Rotor speeds wobble constantly under flight control. Measured: ~0.6% for a GPS-hovering
     Matrice 300, 1–3% for a Mini 3 Pro, and 1.3–2% at the steadiest for a DIY FPV quad in
     manual mode.
   - Real time of flight between real microphones matched geometry to 4–7 cm.
   - Heavy, stable drones wobble least, so they're the hardest case. Drones in real flight
     add more wobble.
2. **Detection is cheap. RAM matters more than CPU.**
   - FFT, harmonic detection, a small CNN and bearings fit in < 25% of one ESP32-S3 core.
   - Buffering audio for timing needs PSRAM.
3. **The baseline traffic fits plain LoRa easily.** Detection, confidence, bearing, level and
   harmonic frequencies take ~40–70 bits per node per update, ~3 kbit/s for a 12-node event.
   GPS-synced TDMA slots make node ID and timestamps almost free.
4. **Precision TDOA/FDOA is an optional add-on, carried in bursts.**
   - Nodes send 1-bit, 4 kS/s audio clips (2–4 kbit per node), aligned using bearing-based priors.
   - This gives sub-ms TDOA and sub-m/s Doppler down to about −5 dB (slow) or 0 dB (50 m/s).
   - It needs LoRa switched to SF5–SF7 / 500 kHz during events. With 300–400 m spacing, those
     settings keep 28–33 dB of link margin.
5. **Bearings are the key coarse measurement.** Matching nodes without bearings needs about +10 dB
   more signal.
6. **Drone classes span ~80 Hz** (large camera drones) **to ~1 kHz** (FPV) blade-pass
   fundamentals. Detector bands and features must adapt to that range, not be fixed.
7. **Positions come from acoustic provisioning; radio ranging checks them.**
   - The installer's phone plays its GPS fix to the node as sound while placing it: ~1.5 m error,
     no GNSS on the node (doc 05).
   - Periodic LoRa ranging can't position nodes on a near-straight line (~50 m across-line error),
     but it does catch gross mistakes, moves along the line of ≥ 10–20 m, and impostors (doc 06).
     The accelerometer covers moves across the line.
8. **Health telemetry is nearly free:** 23 B on each 5-minute heartbeat, < 0.1% duty per node.
9. **No MCU emulator models I²S audio input.** So simulate at the firmware HAL boundary: the node's
   processing core is built natively and fed simulated audio. Emulators and real boards are only
   for ISA, memory and timing checks.

## 3. System design

**Node types.** Sizing and power figures are in
[doc 04](docs/research/04-hardware-boundaries.md).
- *Detector node (~$20–35, ~2 mA):* nRF52840 or nRF54L15 + LoRa radio with ranging (LR2021 or
  LR1121; an SX1262 board such as the RAK4631 is fine for early benches), 1 PDM mic (e.g. T5838),
  and an accelerometer for tamper detection.
  - No GNSS: position comes from acoustic provisioning at install, and time sync from gateway
    LoRa beacons.
  - Scans BLE for Remote ID.
  - Runs for months on one 18650, or indefinitely on a 0.15–0.5 W panel.
- *Array node (~$65–90, ~45–63 mA):* ESP32-S3 N16R8 + 4 PDM/TDM mics + LR2021 + GNSS with PPS.
  Its GNSS position makes it a ranging anchor.
  - Aperture: 10–15 cm for FPV-class drones; 30–50 cm helps low-frequency drones.
  - Power: 2.5–3.5 W panel and 2× 18650.
  - Placement: every 2nd–3rd position, or every position on critical segments.
- *Reference node (optional, ~$100–140):* ESP32-P4 + ESP32-C6 with 8 mics, for research and
  labelled data.
- **Mics:** avoid the ICS-43434, which is Last Time Buy. Plan around PDM or TDM mic families.

**Perimeter geometry.**
- **Spacing ≈ 1.5 × reliable detection radius.** If the 150–300 m estimate holds, that's
  roughly 200–400 m. Phase 3 measures the real value.
- A crossing at 50 m/s then spends ~6–12 s in range of at least one node.
- Optional second row ~100 m behind the first, for direction of travel without arrays.

**Processing on the node.**
1. 16 kHz capture into a ring buffer, which also feeds a PSRAM buffer for the optional TDOA clips.
2. FFT with harmonic-comb scoring across an 80–2000 Hz fundamental/harmonic range.
3. A small CNN to reject look-alike sounds (cars, mowers, generators, aircraft, insects).
4. Bearing (GCC-PHAT) on array nodes.
5. Only a detection with ≥ 2 nodes agreeing, or a sustained single-node track, raises a crossing alert.

**Network and messages.**
- *Idle:* a robust LoRa setting (SF9/125 kHz) with a 5-minute heartbeat. Each heartbeat is a 23 B
  health report: battery and solar, temperature, resets, mic noise floor and self-test, wind
  level, detection counts, tilt and tamper flags, beacon link quality, clock offset, GNSS lock,
  firmware hash. **Health reports stop during events.**
- *Ranging:* round-trip time-of-flight to neighbours, scheduled by the gateway into TDMA slots:
  once when a node joins, daily at the quietest hour, and on demand after a tamper, tilt or reset.
  Never during events. ~0.1% of the detector node's energy.
- *Event:* switch to a fast setting, with GPS-synced TDMA slots.
- *Baseline messages:* detection + confidence, bearing, band level, 1–2 harmonic-line frequencies,
  class on change. A Doppler trend across nodes gives direction of travel.
- *Optional burst layer:* the gateway requests aligned 1-bit audio clips from the 2–4 best nodes
  for precise TDOA/FDOA.

**Controller (gateway), one per cluster.**
- Raspberry Pi with a LoRa radio and a backbone link to neighbouring controllers.
- Fuses its nodes into crossing events and tracks, and hands tracks to the next cluster.
- Health monitoring:
  - 3 missed heartbeats outside an event → segment-gap alert.
  - A live coverage map from each node's noise floor (+6 dB ambient ≈ half the detection radius).
    Thin segments show on the operator's view.
  - Battery forecasts, mic faults, tamper and ranging-integrity alerts.
- Exposes an operator interface: alerts, tracks, coverage and gaps.
- Logs everything for replay.

## 4. Phased plan

Each phase has an exit criterion. A failed criterion means re-plan, not push on.

### Phase 0: Groundwork. *Mostly done.*
Repo, research docs 01–06, simulation experiments, and real drone recordings (DroneNoise Database).

### Phase 1: Simulator and detector baseline (3–4 weeks)
- **Acoustic world, `sim/acoustics`.** Real and synthetic drone sources and flight paths.
  Propagation with ground reflection, wind and turbulence. Real background scenes.
- **Negative datasets.** Real recordings of wind, traffic, mowers, aircraft and birds.
- **Detector in Python**, fronting a portable C/C++ core behind a HAL:
  harmonic comb with adaptive band, plus a small CNN.
- **Perimeter scenario runner.** N nodes along a line, random crossings (class, altitude, speed,
  wind), with a simple LoRa/TDMA model.
- **Exit:** simulated crossing detection ≥ 95% for target classes below 100 m altitude.
  Simulated false alarms ≤ 1 per km of perimeter per day on real background audio.

### Web demo (parallel track from Phase 1)
A browser simulation of the whole perimeter, running the real node core (C → WebAssembly) and
gateway code (Python via Pyodide), with every panel tagged as real, same code, modelled, assumed
or stub. Milestones M0–M5, ~10–12 focused weeks; M2 and M4 share work with Phase 1.
See [docs/web-demo-plan.md](docs/web-demo-plan.md).

### Phase 2: Bench node (2–3 weeks)
- ESP32-S3 I²S capture from 1 and 4 mics. The detector core builds natively, under QEMU-S3
  in CI, and on hardware.
- Measure CPU, RAM and power on the board.
- Remote ID scanner.
- Health report and ranging on two LR2021 boards: RTToF error and day-to-day drift at ~350 m, in
  the open and through trees; current per exchange.
- **Exit:** the detector on the MCU matches its native build on recorded audio; ≤ 25% CPU;
  daily energy fits 2× 18650 plus a 2 W panel.

### Phase 3: Field characterisation (2–3 weeks)
- Synced ground recordings of real flights (including the user's FPV quad) at 2+ points.
- Detection range against background noise and wind, for each drone class.
- Wind-screen designs.
- Multi-day unattended false-alarm logging.
- **Exit:** measured detection-probability-vs-range curves, which set node spacing.
  False-alarm rate within 3× of simulation. If reliable range is < 100 m, revisit the mic count,
  array processing, or the role of each node type.

### Phase 4: Perimeter pilot (3–4 weeks)
- 6–10 nodes on a 1–2 km line in two clusters, with LoRa TDMA, node-to-node and a backbone link.
- Scripted crossings at different speeds, altitudes and directions.
- Define the operator interface.
- **Exit:**
  - ≥ 95% of crossings below 100 m detected.
  - Correct segment and direction ≥ 90%.
  - Alert latency ≤ 5 s.
  - False alarms ≤ 1/km/day.
  - 72 h unattended operation.
  - Every node's health visible at the gateway; a powered-off or moved node is flagged within
    15 min (moved: at the next sweep).

### Phase 5: Integration and hardening (ongoing)
- Optional TDOA burst layer where precision helps.
- Wake-on-sound low-power stage.
- Over-the-air updates when serviced.
- Enclosure and BOM cost-down toward < $40 per detector node.

## 5. Key risks

| Risk | Mitigation |
|---|---|
| Wind noise limits range | Wind-screen R&D in Phase 3. Raise thresholds adaptively when the node's anemometer or self-noise rises. Report reduced coverage in high wind. |
| False alarms from look-alike sounds | Require ≥ 2-node agreement. Hard-negative mining from field logs. Neighbouring nodes confirm each other. |
| Quiet or large stabilised drones (least wobble, low tones) | Adaptive bands down to ~80 Hz. Treat them as the design worst case in simulation. |
| Gaps in the line (node failure, terrain, noise) | Spacing margin, health heartbeat, live coverage map, optional second row. |
| Node moved, swapped or impersonated | Accelerometer tamper flag, periodic ranging integrity check, authenticated messages. |
| LoRa congestion during events | TDMA, aggregate messages per track, optional burst layer only on request. |
| Controller or backbone loss | Clusters keep working alone and buffer alerts; node-to-node still runs. Every node has a second controller in reach (protocol section 3a-2). |
| Regulatory | Receive-only RF. LoRa within regional duty and dwell rules. Legal test flights. No raw audio stored or sent outside R&D. |

## 6. Open questions

1. **Perimeter:** real site terrain, and how dense the background noise is (rural or urban)?
2. **Target classes:** consumer camera drones, FPV, larger fixed-wing? This drives the bands and the training data.

## 7. Immediate next steps

- [ ] Phase 1: build `sim/acoustics` out of the experiment code, and collect negative background recordings.
- [ ] Phase 1: a detector baseline with an adaptive harmonic band, scored for detection and false alarms on real audio.
- [ ] Web demo M0–M1: 3D world, flight controls, provenance ledger, acoustic engine with golden tests.
- [ ] Order a bench kit:
  - 2× RAK4631 + 2× PDM mic breakouts (detector node)
  - 2× LR2021 evaluation kit (XIAO nRF54L15), for ranging and the ranging-capable detector node
  - 2× ESP32-S3 N16R8 + 8× PDM/TDM mics (array node)
  - 1× LilyGO T-Beam Supreme
  - 1× Raspberry Pi Zero 2 W + GNSS module, for synced field recording
  - 1× power profiler (e.g. Nordic PPK2)
