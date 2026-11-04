# SonicMesh

A mesh of low-cost microcontroller sensor nodes that detects and tracks small drones at long range.
Each node can only hear a drone a few hundred metres away; the network gets its range by spreading many nodes out and combining their detections.

**Node (~$70–95):** ESP32-S3, 2–4 I²S MEMS mics, SX1262 LoRa, GNSS with PPS, solar + 18650.

- **Acoustic** detection on the node: an FFT harmonic detector, then a small CNN that rejects other noise sources.
- **Remote ID** (BLE/Wi-Fi) and passive RF-energy sniffing on the same chip. All RF is receive-only.
- Compact detection messages sent over a **LoRa mesh**, with GPS-synced timestamps.

**Gateway:** Raspberry Pi. It combines detections from many nodes using bearing intersection and time-difference-of-arrival (TDOA) localization, tracks targets with a Kalman filter, and shows them on a map UI.

## Status

Planning. See [PLAN.md](PLAN.md) for the architecture, BOM, phased prototype plan, and risks.
