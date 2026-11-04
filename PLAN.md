# SonicMesh — Prototyping Plan

Goal: a mesh of low-cost, microcontroller-based sensor nodes that together detect, and roughly
locate, small drones (Group 1 UAS, < 25 kg) at ranges well beyond what any one cheap sensor can do alone.

"Long range" here means the **network's** coverage, not each node's. A single cheap node can hear
or sense a small quadcopter at a few hundred metres at best. Many nodes, spread out and fused,
can cover kilometres. The prototype has to prove that this trade works.

---

## 1. Physics first: what a cheap node can and can't do

| Modality | What it senses | Realistic single-node range (small quad) | Node cost | Notes |
|---|---|---|---|---|
| **Acoustic** (MEMS mic array) | Rotor blade-pass harmonics, roughly 100 Hz–5 kHz | 100–300 m in quiet rural conditions; 50–150 m in urban or windy conditions | $15–40 | Core modality (the project's name). Works on drones with no RF link (autonomous or fiber-guided). Wind and traffic are the main problems. |
| **Remote ID receiver** (Wi-Fi beacon/NAN + BLE 4/5) | ASTM F3411 broadcast of drone position and ID | 300 m–1 km+ (BLE Long Range, Wi-Fi) | ~$5 (on the same ESP32) | Almost free to add. Catches only compliant drones, but those give exact GPS position, which is very useful as **ground truth** for training the acoustic side. |
| **Passive RF energy** (2.4/5.8 GHz control/video links) | Activity in the drone's control and video links | 500 m–2 km | $10–30 (ESP32 Wi-Fi sniffing; nRF/CC2500 RSSI sweep) | Detects that something is transmitting; poor at telling what it is. Receive-only. |
| Optical/IR | — | — | — | Out of scope for MCU nodes. Could be added later as a cueable camera at the gateway. |

**Decision:** acoustic is the primary sensor. Remote ID and RF-energy sniffing ride along on the
same ESP32 at almost no extra cost. They add detections, and Remote ID supplies labelled training data.

### Acoustic range budget (rule of thumb)
- Source level of a small quad at 1 m: about 70–80 dB(A); larger multirotors are louder.
- Spherical spreading costs −6 dB per doubling of distance, so −40 dB at 100 m and −50 dB at 300 m. Air absorption on top of that is significant above ~2 kHz.
- Rural background is 30–40 dB(A); suburban is 45–55 dB(A).
- So, with narrowband harmonic processing (which gains 10–20 dB over broadband), expect **~150–300 m**
  per node. **Node spacing of 200–400 m** gives overlapping coverage. Phase 2 field tests confirm or correct these numbers.

---

## 2. System architecture

```
 ┌──────────── Sensor node (×N) ────────────┐        ┌──────── Gateway ────────┐
 │ 2–4× I²S MEMS mics (ICS-43434 / SPH0645) │        │ Pi 5 / mini-PC          │
 │ ESP32-S3 (DSP + TinyML, Wi-Fi/BLE RID)   │  LoRa  │ LoRa concentrator/node  │
 │ GNSS w/ PPS (time sync + self-location)  │ ─────► │ Fusion + TDOA/bearing   │
 │ SX1262 LoRa radio (mesh)                 │  mesh  │ Tracker (Kalman/GNN)    │
 │ 18650 + 1–2 W solar, weatherproof box    │        │ Map UI, logging, alerts │
 └──────────────────────────────────────────┘        └─────────────────────────┘
```

**On the node (edge):** the node processes audio locally and sends only compact detections.
Raw audio is far too much data for LoRa.
1. Capture audio at 16 kHz, 24-bit I²S, with a ring buffer.
2. Run a 1024-point FFT per 64 ms frame, then harmonic-comb scoring: look for a fundamental of 80–400 Hz
   with ≥ 3 harmonics that stays stable over about 0.5 s.
3. Pass candidates to a small CNN on log-mel features (TFLite Micro / Edge Impulse on the ESP32-S3) to
   reject cars, lawnmowers, aircraft and birds.
4. With 2–4 mics, estimate a local bearing with GCC-PHAT. Mic spacing of 5–15 cm gives coarse direction of arrival.
5. Send a detection message (about 30–50 bytes): node ID, GPS-time timestamp (µs), confidence,
   fundamental frequency, bearing ± uncertainty, SNR, class. Remote ID and RF hits are separate message types.

**Mesh:** LoRa (SX1262, 868/915 MHz).
- Start with **Meshtastic firmware** on a separate radio, or its protocol, to get multi-hop working for free.
  Move to a lean custom flood/managed-flood protocol only if latency or airtime becomes a problem.
- Airtime budget: at SF7/125 kHz, a 40-byte packet takes about 70 ms. Duty-cycle limits (1% in the EU)
  allow roughly 50 packets per node per hour if done naively, so **rate-limit and aggregate**:
  one message per track per 2–5 s, plus a heartbeat every 5 min.
- Fallback for dense bench tests: ESP-NOW (higher bandwidth, ~200 m range).

**Gateway (fusion):**
- Associate detections from multiple nodes in time (GPS-synced timestamps).
- Localize: **bearing intersection** from nodes with arrays, plus **TDOA** on harmonic onset or
  envelope features across nodes. Coarse but workable at ~1 ms timing accuracy, which corresponds to ~0.34 m of sound travel.
  Use received level against modelled spreading as a weak range prior.
- Tracker: constant-velocity Kalman filter with gated nearest-neighbour association, then confirm and delete tracks.
- Output: a live map (web UI over Leaflet/OpenStreetMap), event log, alerts, and stored raw detections for replay.

**Time sync:** a GNSS PPS interrupt disciplines the ESP32 timer, which should achieve ≤ 10 µs.
That is more than enough for acoustic TDOA, where the error budget is dominated by the propagation
medium (wind, temperature), not the clock.

---

## 3. Reference node BOM (prototype quantities)

| Part | Example | ≈ USD |
|---|---|---|
| MCU | ESP32-S3-DevKitC-1 (N16R8) | 10 |
| Mics | 4× ICS-43434 I²S breakout (or 2× for cheap nodes) | 16–24 |
| LoRa | SX1262 module (Waveshare/EBYTE), or Heltec/LilyGO board with integrated LoRa | 8–15 |
| GNSS | u-blox M10 / ATGM336H with PPS out | 8–15 |
| Power | 18650 cells ×2, CN3791 solar charger, 2 W panel | 15 |
| Enclosure | IP65 box, acoustic mesh/foam wind-screen, mast mount | 10–15 |
| **Total** | | **≈ $70–95 / node** |

The target cost for a production-like node is **<$60**. Gateway: Raspberry Pi 5 + LoRa HAT ≈ $120.

Power: ESP32-S3 continuous DSP draws about 80–120 mA at 3.3 V, roughly 0.35 W, or about 8.5 Wh/day.
That is feasible on 2× 18650 (~22 Wh) plus a 2 W panel in reasonable sun. Duty-cycling
(a low-power wake-on-sound stage, see Phase 5) is the long-term lever.

---

## 4. Phased prototype plan

Each phase has an exit criterion. Don't advance until it's met; a failed criterion means re-plan.

### Phase 0 — Groundwork (1–2 weeks)
- Set up the repo: `firmware/` (ESP-IDF or PlatformIO), `gateway/` (Python), `tools/` (data capture,
  labelling), `data/` (git-lfs or external storage), `docs/`.
- Collect acoustic datasets: public drone audio sets (e.g. DREGON, the Al-Emadi drone audio dataset,
  ESC-50 for negatives), plus our own recordings.
- Line up test drones and legal flying. US: Part 107 or recreational rules, a site away from controlled
  airspace, and landowner permission. All RF work is **receive-only**: no jamming, no spoofing.
- **Exit:** repo skeleton, dataset index, flying site and drones confirmed.

### Phase 1 — Single node on the bench (2–3 weeks)
- I²S capture from 1 mic, then 4 mics, on the ESP32-S3. Stream raw audio over USB/Wi-Fi to a laptop for recording.
- Prototype the detector in Python first (FFT + harmonic comb + small CNN) on recorded and public data.
  Then port it to the MCU (ESP-DSP for FFT, TFLite Micro for the CNN).
- Add a Remote ID scanner (BLE + Wi-Fi beacon/NAN parsing; opendroneid-core-c is a reference).
- **Exit:** on the MCU, detector **≥ 90% recall at ≤ 1 false alarm/hour** on held-out recordings
  at realistic SNR; inference ≤ 50 ms per frame; Remote ID decoded from a test drone.

### Phase 2 — Single node in the field: range characterization (2 weeks)
- Fly 2–3 drone types (e.g. a DJI Mini class, a 5" FPV quad, a larger ~2 kg quad) on radial legs
  out to 600 m at several altitudes. Log drone GPS as ground truth.
- Measure detection probability vs. range, wind speed and background level. Measure bearing error vs. SNR.
- Test wind-screen designs. Wind is the biggest real-world killer.
- **Exit:** measured **Pd(range)** curves per drone class. These set the node spacing for Phase 3.
  If the 50% detection range is < 100 m, revisit the mic count, beamforming, or the modality mix before scaling.

### Phase 3 — Small mesh (4–6 nodes) (3–4 weeks)
- Integrate LoRa mesh, GNSS time sync, and node self-survey (average GPS fixes at power-up).
- Gateway v0: ingest, store, map display of raw detections.
- Measure delivery rate, end-to-end latency and airtime use under bursty detection load.
- **Exit:** ≥ 95% message delivery across ≥ 2 hops; **detection-to-gateway latency ≤ 5 s**;
  nodes run unattended for 72 h.

### Phase 4 — Localization and tracking (3–4 weeks)
- Implement bearing intersection, TDOA, and fused solving, plus the Kalman tracker.
- Fly scripted paths through a 4–6 node grid (spacing taken from Phase 2) and compare tracks with drone GPS.
- **Exit:** track established within **10 s** of entering coverage; median position error **≤ 30 m**;
  ≤ 1 false track per day in field conditions.

### Phase 5 — Scale and harden (ongoing)
- 10–20 nodes over 1–2 km². Test node loss and self-healing of the mesh.
- Power: add a wake-on-sound stage. Options are an analog band-pass and comparator, or a low-power
  co-processor (e.g. ESP32-S3 ULP, or a separate nRF52/RP2040) that keeps the main core asleep.
- Over-the-air config and firmware updates over Wi-Fi when serviced (LoRa is too slow for full images).
- Weatherproofing, a cost-down pass on the BOM, and an enclosure design for manufacture.
- Optional: an SDR (RTL-SDR/HackRF) at the gateway for wider RF context; a PTZ camera cued by tracks.

**Rough total to an end-of-Phase-4 demo: ~3–4 months part-time, ~$1–1.5k in hardware**
(8 nodes, gateway, 2–3 test drones excluded).

---

## 5. Key risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Acoustic range lower than hoped (wind, noise) | Needs denser, costlier mesh | Measure early (Phase 2). Better wind screens. Narrowband integration. Lean on RF/Remote ID for far detection. |
| False alarms from engines, mowers, insects, aircraft | Alert fatigue | Need confirmation by ≥ 2 nodes or a second modality. Hard-negative mining from field logs. |
| LoRa airtime / duty-cycle limits | Lost or late detections | Aggregate into tracks on the node; send only changes in state. Adaptive spreading factor. ESP-NOW for dense clusters. |
| TDOA degraded by wind and temperature gradients | Poor localization | Prefer bearings from arrays; use TDOA as a soft constraint. Log temperature. |
| Quiet or gliding drones; RF-silent autonomous drones | Missed detections | Acoustic still covers RF-silent drones. Accept fixed-wing gliding as a known gap. |
| Power budget in winter / low sun | Node downtime | Wake-on-sound duty cycling. Bigger panel. Report health in heartbeat. |
| Regulatory | Legal exposure | Receive-only RF. ISM-band LoRa within duty limits. Legal test flights. Privacy: nodes never store or send raw audio once out of R&D mode. |

---

## 6. Open questions to decide early
1. **Region / band:** EU868 or US915? This sets the LoRa duty-cycle rules.
2. **Threat envelope:** which drone classes and what altitudes matter most? This drives the
   mic band and the CNN training set.
3. **Deployment context:** rural perimeter vs. urban? Background noise changes node spacing by about 2×.
4. **Build vs. reuse for the mesh:** Meshtastic as-is, or a custom protocol from the start?
5. **Bearing vs. TDOA emphasis:** 4-mic array nodes (better bearing, more cost) vs. cheap 1-mic nodes
   used only for TDOA. A mixed fleet is a strong option to test in Phase 4.

## 7. Immediate next steps
- [ ] Order 3 dev nodes' worth of parts (ESP32-S3, 4× ICS-43434, SX1262, GNSS w/ PPS).
- [ ] Create the repo skeleton and a PlatformIO/ESP-IDF I²S capture-to-USB firmware.
- [ ] Download and index public drone and negative audio datasets. Build the Python detector baseline.
- [ ] Book the flying site and confirm the test drones.
