# Web demo plan

Date: 2026-11-04

**Goal:** a browser simulation of the whole perimeter. A drone you fly, nodes you place, trees and
terrain, and every step from sound in the air to an alert at the radar shown on screen.

**Principle 1: faithful where it can be.** Where the real system will run code, the demo runs
*that code*. Where physics is involved, it uses the same models as the Python simulation and is
checked against them.

**Principle 2: honest where it can't be.** Every number and panel says whether it is real,
running shipped code, modelled, assumed or a stub. Simplifications are listed, not hidden.

---

## 1. What the user sees

```
┌──────────────────────────────────────────────┬───────────────────────────────┐
│ 3D world                                     │ Inspector (whatever you       │
│  terrain, trees, road, nodes, gateway,       │ clicked)                      │
│  radar dome, drone(s), LoRa packets as arcs, │  node 7 ▸ mic 2 waterfall     │
│  bearing rays, TDOA hyperbolas,              │  ▸ characteristics ▸ messages │
│  track vs truth                              │  ▸ health ▸ ranging ▸ state   │
│                                              │                               │
│                                              │  every panel carries a badge: │
│                                              │  REAL · SAME CODE · MODELLED  │
│                                              │  · ASSUMED · STUB             │
├──────────────────────────────────────────────┴───────────────────────────────┤
│ Timeline: LoRa TDMA slots like a logic analyser · events · alerts · scrub     │
│ ⏵ ⏸ ⏭ 0.25×–4× · seed · scenario · record / replay · truth on/off             │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Controls.**
- **Fly the drone:** keyboard or gamepad, in an FPV-like manual mode or a GPS-hover mode. Or give
  it a scripted path: crossing at 5–50 m/s, hover, terrain-hugging, out and back.
- **Choose the drone:** class presets (FPV, Mini, Matrice-class). Several drones at once.
- **Edit the world:** drag nodes and the gateway on the terrain; add or remove nodes; switch a
  node between detector and array types.
- **Set conditions:** wind, ambient level, and noise sources placed in the world (road traffic,
  a mower, a generator, aircraft overhead). These test false alarms.
- **Listen:** solo any mic and hear exactly what that node hears, upsampled for playback.
- **Truth on/off:** off shows only what the system knows; on overlays ground truth and the error.

**Click anything to inspect it.**

| Click | Shows |
|---|---|
| **Node** | <ul><li>Per-mic scrolling waterfall (spectrogram) with overlays: detected harmonic comb, tracked harmonic lines (the "characteristics"), and the true blade-pass frequencies dotted when truth is on.</li><li>Detector score and CNN class probabilities over time.</li><li>Band level vs noise floor.</li><li>Array nodes: bearing map (SRP-PHAT polar plot) and chosen bearing.</li><li>The 1-bit 4 kS/s clip buffer.</li><li>Firmware state machine: provisioning → idle → event → burst.</li><li>Every message sent and received.</li><li>Health report fields, ranging results to each neighbour, and battery/energy.</li><li>Modelled MCU load and RAM, from doc 04's figures.</li></ul> |
| **LoRa packet** (arc, or a slot on the timeline) | <ul><li>Raw bytes in hex, with each decoded field.</li><li>Type, SF/BW, airtime and TDMA slot.</li><li>RSSI/SNR at every receiver; who decoded it, who lost it (collision, range), and the relay hops.</li></ul> |
| **Timeline** | TDMA slot chart, channel utilisation, duty cycle per node, SF switches at event start/end. |
| **Gateway** | <ul><li>Crossing events and their evidence.</li><li>Bearing intersections.</li><li>TDOA bursts: GCC-PHAT correlation surfaces with the drift (FDOA) search, chosen peak, residuals.</li><li>Hyperbolas on the map.</li><li>Track vs truth error.</li><li>Health dashboard and live coverage map.</li><li>The alert/cue messages exactly as sent to the radar/C2 interface.</li></ul> |
| **Drone** | True position, velocity, four rotor speeds with their wobble, the emitted spectrum, and Remote ID broadcasts (if enabled). |
| **Radar** | Coverage dome with its low-elevation floor; simple simulated tracks; cues in and out. |
| **Any sound source** | Its recording or model, level, and position. |

## 2. Showing what's real: the provenance ledger

Every component gets one tag. A single file, `web/provenance.yaml`, holds them. The UI badges, a
"What's real?" page and this doc's table are all generated from it, so they can't drift apart.

| Tag | Meaning | Examples |
|---|---|---|
| **REAL** | Measured data | DroneNoise recordings, the user's FPV audio, real background recordings, and later bench and field logs |
| **SAME CODE** | The code that runs on the node or gateway, unmodified | Node detector core (C → WASM), message encoders, provisioning modem, gateway fusion |
| **MODELLED** | Standard physics, checked against the Python sim and, where possible, real data | Propagation delay and Doppler, spreading, ground bounce, air absorption, LoRa airtime |
| **ASSUMED** | A parameter not measured yet | Detection range, LoRa path-loss exponent, ranging error, MCU timing, current draw |
| **STUB** | A placeholder standing in for a real system | Radar, foliage acoustics, RF terrain shadowing |

**What each entry records:**
- the evidence: a link to a research doc or experiment;
- what would upgrade it, e.g. "ASSUMED → REAL: Phase 2 bench measurement";
- a known bias, e.g. "no turbulence → TDOA optimistic beyond ~200 m".

**The "What's real?" page** lists the whole ledger. It also shows a live share of the current
scene, e.g. "audio: 62% of mic samples come from real recordings".

## 3. Architecture

```
main thread            sim worker                 node worker(s)          gateway worker
───────────            ──────────                 ──────────────          ──────────────
three.js scene   ◀──   world clock (fixed 10 ms)  node core (WASM,  ──▶   fusion (Pyodide,
inspector panels       drone dynamics + sound      same C as firmware)     same Python as
waterfalls (WebGL)     propagation → per-mic       one instance/node       the Pi gateway)
timeline               audio blocks          ──▶   HAL: audio in,          alerts → radar stub
AudioWorklet (listen)  LoRa channel + TDMA   ◀──   LoRa out, clock,
                       ranging, energy             accelerometer
```

**Static site.** Vite + TypeScript, with no backend, so it runs from a file server or any static
host.
- Threads talk through `SharedArrayBuffer` ring buffers. That requires cross-origin isolation
  headers; where a host can't set them, a small service worker adds them.

**Fixed-step, deterministic simulation.**
- The world advances in 10 ms blocks on a seeded random generator, separate from wall-clock
  time. That allows pause, single-step, slow motion and faster-than-real-time runs.
- Every run can be recorded as `scenario.json` plus an event log, then replayed exactly.

**One scenario format with the Python sim.**
- The Phase 1 `sim/acoustics` scenario runner reads the same `scenario.json`.
- **Golden tests:** CI runs a set of scenarios in both and compares per-mic audio, node messages
  and alerts. This keeps the browser and Python sims honest with each other.

**Node logic is the firmware core.**
- Phase 1 already plans a portable C/C++ detector core behind a HAL. It gets built three ways:
  native (Python bindings for the sim), MCU, and WebAssembly (Emscripten) for the demo.
- The demo provides the HAL: audio blocks in, LoRa frames out, a clock, accelerometer events.
- Message encoding/decoding and the provisioning modem are part of the core, so the bytes in the
  packet inspector are exactly the bytes a node would send.

**Gateway logic is the gateway code.**
- The gateway is a Raspberry Pi and isn't constrained, so it can stay in Python.
- The demo runs that code in a worker with Pyodide (Python + numpy/scipy in WASM, ~10–15 MB
  download).
- If Pyodide proves too slow or heavy, port the gateway core to Rust and build it for both the Pi
  and WASM. That's decided in M4, not now.

**Sizing.**
- 13 nodes, with every 3rd an array node: ~28 mics at 16 kS/s ≈ 450k samples/s of propagation
  (2 paths each).
- Node DSP runs at the < 25%-of-an-S3-core level (doc 04).
- All comfortably real-time in WASM on a laptop. Waterfalls only render for open panels.

## 4. Simulation models

| Piece | Model | Tag | Tradeoff / known bias |
|---|---|---|---|
| Drone sound, interactive | Synthetic quad from `tdoa_feasibility.py`: 4 rotors, harmonics, blade-modulated broadband. Rotor speed follows the flight dynamics; wobble statistics fitted to doc 03 (0.6% Matrice … 2% FPV) | MODELLED, fitted to REAL | Not a recording, but its timing statistics come from real ones |
| Drone sound, replay | DroneNoise and FPV recordings on a fixed path, pitch-shifted a little with throttle | REAL (pitch shift MODELLED) | Can't respond to the stick beyond small changes |
| Propagation | Time-varying fractional delay per path, so Doppler emerges naturally; 1/r spreading; ground reflection by image source (Γ ≈ 0.7); air absorption as a per-path filter updated every block | MODELLED | Absorption approximated, not the exact ISO 9613-1 curve |
| Terrain | Heightmap; blocked paths get Maekawa barrier attenuation | MODELLED | No ground-wave, no refraction |
| Trees | Visual; optional foliage excess attenuation (ISO 9613-2) | STUB | No scattering |
| Wind | Mic wind noise from real recordings scaled by wind speed; fixed offset for refraction | REAL / STUB | Refraction ignored |
| Turbulence | Off in M1; added later as amplitude and travel-time jitter (as in `tdoa_feasibility.py`) | STUB → MODELLED | **Without it, TDOA is optimistic at range.** The ledger says so |
| Background | Real recordings placed as sources (road, mower, generator, aircraft) plus diffuse ambient per node | REAL | Looped |
| Mic | Self-noise (~29 dB SPL), response, PDM→PCM, clipping | MODELLED | |
| LoRa link | Airtime formula, log-distance path loss + log-normal shadowing, capture/collision, TDMA, duty-cycle accounting, SF switching | MODELLED + ASSUMED | Uses the same airtime code as `lora_budget.py` |
| Ranging | Doc 06 error model: noise, drift, static NLOS bias | ASSUMED | Until Phase 2 measures it |
| Health | Real report encoder; battery/solar/temperature from a simple energy model | SAME CODE + ASSUMED | |
| Provisioning | Real modem and latch on simulated phone audio (doc 05 channel) | SAME CODE + MODELLED | |
| MCU load, power | Doc 04 per-stage costs | ASSUMED | Browser timing ≠ MCU timing; HIL mode (below) makes it REAL |
| Radar | Coverage dome, low-elevation floor, detection probability vs range, track noise | STUB | Until a radar and its interface are chosen |

## 5. Getting real parts into the demo

These modes turn ledger entries from MODELLED/ASSUMED into REAL as hardware appears.

1. **Real phone provisioning.** The demo shows the provisioning page. A real phone plays frames
   into the laptop mic, and the real modem decodes them in the browser. This is the bench check
   doc 05 asks for, with a UI.
2. **Laptop mic as a node.** One virtual node's mic is replaced by the laptop's microphone. Fly
   the real drone near the laptop and see the real detector respond.
3. **Hardware in the loop.** A bench node is connected over USB with Web Serial (Chrome/Edge).
   - The demo streams that node's simulated audio into the firmware at the HAL boundary.
   - The node runs the real firmware and sends back its messages, with real CPU time and current.
   - Its panels turn REAL for compute and power.
4. **Field log replay.** Phase 3/4 recordings and LoRa logs replace simulated nodes one by one.

## 6. Milestones

Effort assumes one developer, focused weeks. M2 and M4 overlap with Phase 1 work that is needed
anyway.

| | Deliverable | Effort | Exit check |
|---|---|---|---|
| **M0** | Skeleton: Vite/TS app, 3D terrain, trees, nodes, gateway, drone with keyboard/gamepad and scripted paths, drag-to-place, fixed-step clock, record/replay, provenance ledger and badges | 1–1.5 wk | Fly, place, pause, replay deterministically |
| **M1** | Acoustic engine (WASM): sources, propagation, background, per-mic audio, listen mode, node waterfalls | 2 wk | Golden test: per-mic audio matches the Python sim to < 0.5 dB band level and < 20 µs delay |
| **M2** | Node core in C, built to WASM: detector, harmonic lines, bearings, state machine, message encoding; node inspector panels | 2–3 wk (shared with Phase 1) | Same messages as the native build on the golden scenarios |
| **M3** | LoRa layer: TDMA, channel model, packet arcs, timeline, packet inspector; health reports; ranging sweeps | 1.5–2 wk | Airtime and duty cycle match `lora_budget.py`; health pauses during events |
| **M4** | Gateway in Pyodide: crossing events, bearing fusion, TDOA bursts with correlation plots, track vs truth, coverage map, radar stub and cue messages | 2 wk | A crossing in the demo gives the same alert as the Python run |
| **M5** | Provisioning walk-through (phone avatar, then real phone); scenario library with scoring (detection rate, false alarms per km per day) | 1.5–2 wk | Scores the Phase 1 exit criteria visibly |
| Later | Turbulence, laptop-mic node, hardware-in-the-loop, field log replay | — | — |

Total: about **10–12 focused weeks** to M5. **M0–M1 alone (~3 weeks) is already a useful
spatial-audio playground** for designing detectors.

## 7. Repo layout

```
web/
  app/            TypeScript UI: scene, inspector, timeline, ledger page
  sim/            acoustic engine + LoRa channel (Rust or C → WASM)
  provenance.yaml
  scenarios/      shared scenario.json files (also used by sim/acoustics)
core/             portable C/C++ node core (firmware, native, WASM)
gateway/          Python gateway (Pi, and Pyodide in the demo)
```

The acoustic engine is the one new compiled component. Write it in the same language as the node
core (C/C++) unless Rust is chosen for the gateway, in which case use Rust for both.

## 8. Decisions and risks

- **Recordings and licences.** DroneNoise and the user's audio stay out of git (data/ is ignored).
  The demo loads them through a file picker or a local folder. Before a public build bundles any
  recording, check its licence.
- **Public or private.** A public demo of a counter-drone perimeter shows its weak spots, such as
  coverage gaps and the radar floor. Default to a private deployment; decide before M5.
- **Pyodide size and speed.** If the gateway needs > ~50 ms per 10 ms tick at 13 nodes, port its
  hot loop. Measure in M4.
- **Golden tests are the cost of faithfulness.** Two sims (Python and WASM) drift apart without
  them. They are part of M1, not optional.
- **Browser support.** WASM threads and Web Serial need Chrome/Edge for hardware in the loop.
  The rest of the demo also targets Firefox and Safari.
