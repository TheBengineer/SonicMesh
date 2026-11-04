# SonicMesh

A loose perimeter of low-cost microcontroller acoustic nodes that detects small drones crossing at low altitude.
It complements radar: acoustic covers the low, close-in airspace where radar struggles with clutter, and radar covers high and distant targets.

**Node (~$70–95):** ESP32-S3, 2–4 I²S MEMS mics, SX1262 LoRa, GNSS with PPS, solar + 18650.

- **Acoustic** detection on the node: an FFT harmonic detector, then a small CNN that rejects other noise sources.
- **Remote ID** (BLE/Wi-Fi) and passive RF-energy sniffing on the same chip. All RF is receive-only.
- Compact detection messages sent over a **LoRa mesh**, with GPS-synced timestamps.

**Gateway:** Raspberry Pi. It combines detections from many nodes using bearing intersection and time-difference-of-arrival (TDOA) localization, tracks targets with a Kalman filter, and shows them on a map UI.

## Status

Research and simulation. See [PLAN.md](PLAN.md) for the architecture, phased plan and risks, and [docs/research](docs/research) for the findings behind it.
