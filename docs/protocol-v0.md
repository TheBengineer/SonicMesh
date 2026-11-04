# Message format and schedule — v0

Date: 2026-11-04. Status: draft for M2–M4 and the first firmware. Numbers come from docs 02 and 06;
airtimes from `sim/experiments/lora_budget.py`.

**Scope:** the LoRa link between nodes and the gateway (frames, schedule, messages, security),
and a first sketch of the gateway → radar/C2 interface.

## 1. Decisions in v0

1. **Star, not mesh.** At 350 m spacing every node has 28–39 dB of margin to a gateway kilometres
   away (doc 02), so v0 is a TDMA star. A node with a poor gateway link can be assigned as a
   *relay* for a neighbour's slot later; multi-hop routing is out of scope.
2. **Region: US915 first.** The event layer runs 500 kHz channels at tens of percent occupancy.
   US915 allows that (digital modulation, ≥ 500 kHz bandwidth, no dwell limit). **EU868 does not**:
   its 1% duty cycle in 868.0–868.6 MHz rules out the event layer as designed, and only the
   869.4–869.65 MHz sub-band allows 10%. An EU build needs its own plan (SF7/250 kHz event slots
   in 869.525, fewer TDOA bursts). Tracked as an open question.
3. **Gateway owns time.** The gateway's GNSS-disciplined beacon defines every slot. Detector
   nodes (no GNSS) time-stamp the beacon's RxDone and run their sample clock against it; array
   nodes also check against their own PPS.
4. **Authenticated, not encrypted.** Every frame carries a 4-byte truncated AES-CMAC under the
   site key, with a replay counter. Contents are not secret enough to justify encryption in v0;
   a flag bit reserves it.

## 2. Frame layout

All multi-byte fields little-endian. Bit-packed payloads are LSB first.

```
| hdr (1) | src (1) | ctr (1) | payload (0–247) | mic (4) |
hdr:  type (4 bits) | version (2) = 0 | flags (2): bit0 relayed, bit1 encrypted (reserved)
src:  node id 1–254; 0 = gateway, 255 = unprovisioned
ctr:  low 8 bits of the superframe counter (full counter is in the beacon) → replay window
mic:  AES-CMAC-32 over (site id, full superframe counter, hdr..payload)
```

Overhead: 7 bytes. LoRa CRC on, explicit header.

## 3. Schedule

### Idle mode — SF9 / 125 kHz, superframe 4 s

| Part | Time | Use |
|---|---|---|
| Beacon | 0–230 ms | `BEACON` (206 ms at 24 B) |
| Alert window | 250–890 ms | 4 contention slots × 160 ms for `DETECT_START` (144 ms), slotted ALOHA with random slot choice |
| Scheduled slots | 900–3,980 ms | 14 slots × 220 ms, assigned by the beacon: `HEALTH`, `RANGING_*`, `JOIN`, `ACK` |

- Each node's `HEALTH` comes round every 75 superframes (5 min), staggered by node id.
- Worst-case alert latency: ≤ 4 s to the gateway, + 4 s until the next beacon switches modes.
  (Phase 4 target: ≤ 5 s to the radar. Tighten by beaconing the mode switch immediately.)
- Gateway beacon duty: 5% (fine in US915; in EU868 only in 869.4–869.65 MHz).

### Event mode — SF7 / 500 kHz, superframe 500 ms (2 Hz updates)

| Part | Time | Use |
|---|---|---|
| Beacon | 0–25 ms | `BEACON` with track state and snippet requests (18 ms at 32 B) |
| Node slots | 30–290 ms | Up to 16 slots × 16 ms for `DETECT` (11.6 ms at 15 B) |
| Burst window | 300–495 ms | Allocated per beacon: `SNIPPET` chunks (100 ms per 255 B at SF7, 34 ms at SF5) |

- The gateway enters event mode on any `DETECT_START` or radar cue, and leaves after 10 s with
  no detections. `HEALTH` stops during events (doc 06); ranging never runs during events.
- A 4 kbit snippet (1 s of 1-bit 4 kS/s audio) is 2 chunks at SF7 → one node per superframe, or
  5–6 chunks per window at SF5 when margins allow (gateway chooses per node from link SNR).

## 4. Messages

| Type | Name | Dir | Payload | Notes |
|---|---|---|---|---|
| 0 | `BEACON` | G→all | superframe counter (32), GNSS time of slot 0 (40, ms), mode (1), next PHY (4), slot map (variable), commands (variable) | Event mode adds track state and snippet requests |
| 1 | `DETECT_START` | N→G | confidence (4), band level dB (6), class (3), bearing az (9) + el (5) or 0, strongest line Hz (11) | Contention slot; 5 B payload |
| 2 | `DETECT` | N→G | confidence (4), level (6), az (9), el (5), bearing σ (4), line 1 (11), line 2 Δ (6), class (3), clip-ready (1) | 8 B payload, doc 02 ranks 1–5 |
| 3 | `SNIPPET` | N→G | request id (8), chunk i/n (4+4), start sample (32, in beacon-epoch samples), 1-bit 4 kS/s data | ≤ 240 B data per chunk |
| 4 | `HEALTH` | N→G | the 152-bit report from doc 06 | 19 B payload |
| 5 | `RANGING_RESULT` | N→G | per neighbour: id (8), range dm (16), RSSI (8), SNR (8) | Up to 8 neighbours |
| 6 | `JOIN` | N→G | lat, lon (32 each, 1e-7°), alt dm (16), accuracy dm (8), confident (1), node type (2), provisioning frame seq + time + MAC (doc 05) | Gateway checks recency (anti-replay) |
| 7 | `ACK` | N→G | command id (8), result (8) | |

**Track state in the event beacon** (for window alignment, doc 02 rank 6): track id (8), x/y/z on a
2 m grid relative to the gateway (3 × 12), velocity (3 × 8, 0.5 m/s), time (16) → 11 B.

**Snippet request:** node id (8), request id (8), start sample (32), length in ms (8) → 7 B each,
up to 4 per beacon.

**Commands in the beacon** (G→node): report health now, run ranging sweep (with pair list),
re-provision, set thresholds, reboot. Each has a command id; the node answers with `ACK` in its
next scheduled slot.

## 5. Ranging

The gateway schedules RTToF exchanges in idle scheduled slots: one pair per slot, 16 measurements
across hopped channels (doc 06). Initiator and responder are named in the beacon; the initiator
reports `RANGING_RESULT`. Never during events.

## 6. Gateway → radar / C2 (sketch)

JSON over a local network socket (newline-delimited), versioned:

```json
{"v": 0, "type": "alert", "id": "evt-0192", "t": "2026-11-04T17:03:21.250Z",
 "segment": {"from_node": 6, "to_node": 7}, "position": {"lat": 0, "lon": 0, "alt_m": 30, "sigma_m": 25},
 "velocity": {"heading_deg": 182, "speed_mps": 21}, "class": "multirotor-small", "confidence": 0.86,
 "evidence": {"nodes": [5, 6, 7], "tdoa_fix": true}}
```

Other types: `track_update`, `coverage` (per-segment detection radius from the health
noise floors), `gap` (segment without a working node), and inbound `cue` (radar track → raise
sensitivity in a segment). Fixed when the radar is chosen.

## 7. Open questions

- EU868 event-layer plan, if needed.
- Whether 1-of-4 slotted ALOHA in the alert window is enough when a drone triggers 5+ nodes at
  once (simulate in M3; fallback: each node also gets a 1-in-N reserved alert slot).
- Relay assignment for nodes behind terrain.
- Key management: site key provisioning alongside the acoustic provisioning (doc 05 uses the
  same site key for the phone frames).
