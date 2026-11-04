# SonicMesh — Prototyping Plan

**Goal:** a loose perimeter of cheap, microcontroller-based acoustic sensor nodes that detects
small drones (Group 1 UAS, < 25 kg) crossing it at low altitude. It works alongside a radar system
that covers high and distant targets.

The perimeter is a tripwire. For each crossing it answers *did something cross, where along the
line, which way, and when*, then cues radar or a camera to take over. Precise localisation is a
bonus, not the core requirement.

Research so far, which this plan builds on:
- [01: TDOA, processing, boards, emulation](docs/research/01-tdoa-processing-hardware.md)
- [02: information budget over LoRa](docs/research/02-information-budget.md)
- [03: real drone recordings](docs/research/03-real-hover-audio.md)

---

## 1. Concept: acoustic below, radar above

| | Acoustic perimeter (this project) | Radar |
|---|---|---|
| Strong at | Low, slow, terrain-hugging drones close to the line, including RF-silent ones | High and distant targets, wide-area tracking |
| Weak at | Range (a few hundred m per node), wind, high-altitude targets | Ground clutter, multipath, terrain masking, birds near the ground |
| Output | Crossing alerts: segment, time, direction, class, confidence | Tracks |

**Fusion.** Acoustic alerts cue the radar (or a PTZ camera) to the right sector at low elevation.
Radar tracks heading toward the perimeter raise node sensitivity in that segment. One shared track
picture lives at the gateway.

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
7. **No MCU emulator models I²S audio input.** So simulate at the firmware HAL boundary: the node's
   processing core is built natively and fed simulated audio. Emulators and real boards are only
   for ISA, memory and timing checks.

## 3. System design

**Node types.**
- *Detector node (~$40–60):* ESP32-S3 (N16R8, 8 MB PSRAM), 1 I²S MEMS mic, SX1262 LoRa,
  GNSS with PPS, solar + 18650. It reports detections, level and harmonic frequencies.
- *Array node (~$70–95):* the same, with 4 mics (5–15 cm aperture) for bearings. Placed every
  2nd–3rd position, or at every position on critical segments.
- Both scan for Remote ID (BLE / Wi-Fi) for free.

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

**Mesh and messages.**
- *Idle:* a robust LoRa setting with a 5-minute heartbeat.
- *Event:* switch to a fast setting, with GPS-synced TDMA slots.
- *Baseline messages:* detection + confidence, bearing, band level, 1–2 harmonic-line frequencies,
  class on change. A Doppler trend across nodes gives direction of travel.
- *Optional burst layer:* the gateway requests aligned 1-bit audio clips from the 2–4 best nodes
  for precise TDOA/FDOA.

**Gateway.**
- Raspberry Pi with a LoRa radio.
- Fuses nodes into crossing events and tracks.
- Exposes an interface for the radar/C2 system: alerts out, cues in.
- Logs everything for replay.

## 4. Phased plan

Each phase has an exit criterion. A failed criterion means re-plan, not push on.

### Phase 0: Groundwork. *Mostly done.*
Repo, research docs 01–03, simulation experiments, and real drone recordings (DroneNoise Database).

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

### Phase 2: Bench node (2–3 weeks)
- ESP32-S3 I²S capture from 1 and 4 mics. The detector core builds natively, under QEMU-S3
  in CI, and on hardware.
- Measure CPU, RAM and power on the board.
- Remote ID scanner.
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
- 6–10 nodes on a 1–2 km line, with LoRa TDMA and the gateway.
- Scripted crossings at different speeds, altitudes and directions.
- Define and stub the radar/C2 interface.
- **Exit:**
  - ≥ 95% of crossings below 100 m detected.
  - Correct segment and direction ≥ 90%.
  - Alert latency ≤ 5 s.
  - False alarms ≤ 1/km/day.
  - 72 h unattended operation.

### Phase 5: Integration and hardening (ongoing)
- Radar cueing both ways.
- Optional TDOA burst layer where precision helps.
- Wake-on-sound low-power stage.
- Over-the-air updates when serviced.
- Enclosure and BOM cost-down toward < $40 per detector node.

## 5. Key risks

| Risk | Mitigation |
|---|---|
| Wind noise limits range | Wind-screen R&D in Phase 3. Raise thresholds adaptively when the node's anemometer or self-noise rises. Lean on radar in high wind. |
| False alarms from look-alike sounds | Require ≥ 2-node agreement. Hard-negative mining from field logs. Cross-check with radar. |
| Quiet or large stabilised drones (least wobble, low tones) | Adaptive bands down to ~80 Hz. Treat them as the design worst case in simulation. |
| Gaps in the line (node failure, terrain) | Spacing margin, heartbeat monitoring, optional second row. |
| LoRa congestion during events | TDMA, aggregate messages per track, optional burst layer only on request. |
| Regulatory | Receive-only RF. LoRa within regional duty and dwell rules. Legal test flights. No raw audio stored or sent outside R&D. |

## 6. Open questions

1. **Radar:** which system, its low-altitude floor and coverage, and its interface (alerts, cues, track format)?
2. **Perimeter:** length, terrain, and how dense the background noise is (rural or urban)?
3. **Target classes:** consumer camera drones, FPV, larger fixed-wing? This drives the bands and the training data.
4. **Region:** EU868 or US915 (duty-cycle rules)?

## 7. Immediate next steps

- [ ] Phase 1: build `sim/acoustics` out of the experiment code, and collect negative background recordings.
- [ ] Phase 1: a detector baseline with an adaptive harmonic band, scored for detection and false alarms on real audio.
- [ ] Order a bench kit:
  - 2× ESP32-S3 N16R8
  - 8× ICS-43434 mics
  - 1× LilyGO T-Beam Supreme
  - 1× Raspberry Pi Zero 2 W + GNSS module, for synced field recording
