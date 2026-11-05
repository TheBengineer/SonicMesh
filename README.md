# SonicMesh

A loose perimeter of low-cost microcontroller acoustic nodes that detects small drones crossing at low altitude.
It works as a tripwire: for each crossing it says where along the line, which way and when.

**Nodes:**
- **Detector (~$20–35, ~2 mA):** nRF52840/nRF54L15, one PDM mic, LoRa radio with ranging (LR2021), accelerometer. No GNSS.
- **Array (~$65–90):** ESP32-S3, 4 mics for bearings, LR2021, GNSS with PPS.

- **Acoustic** detection on the node: an FFT harmonic detector, then a small CNN that rejects other noise sources.
- **Remote ID** scanning (BLE/Wi-Fi). Receive-only, apart from LoRa.
- **Network:** local clusters of nodes on LoRa, with synced timestamps, joined by a backbone mesh between controllers so the line can cross terrain. Only summaries cross the backbone. Neighbouring nodes also hear each other directly, for faster fixes.
- **Placement:** the installer's phone plays its GPS fix to the node as sound. Periodic LoRa ranging between neighbours checks that nodes haven't moved.
- **Health:** a 23-byte report on every 5-minute heartbeat (battery, mic, tamper, link, clock), paused during drone events.

**Controller (gateway):** Raspberry Pi, one per cluster. It combines detections from its nodes using bearing intersection and time-difference-of-arrival (TDOA) localization, tracks targets with a Kalman filter, and shows them on a map UI.

## Status

Research and simulation. See [PLAN.md](PLAN.md) for the architecture, phased plan and risks, [docs/research](docs/research) for the findings behind it, and [docs/web-demo-plan.md](docs/web-demo-plan.md) for the planned browser simulation.
