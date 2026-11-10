# Message format and schedule — v0

Date: 2026-11-04. Status: draft for M2–M4 and the first firmware. Numbers come from docs 02 and 06;
airtimes from `sim/experiments/lora_budget.py`.

**Scope:** the perimeter's network: backbone between controllers, local clusters, node-to-node
traffic (frames, schedule, messages, security), and a first sketch of the operator interface. Radar
and other outside sensors are out of scope for now.

**Terms:** a *controller* is what earlier docs and the demo call the gateway: a GNSS-timed Raspberry
Pi with a LoRa radio. A *cluster* is one controller and the nodes it schedules.

## 1. Decisions in v0

1. **Backbone + local mesh clusters, not one big mesh.** The perimeter is a chain of clusters, so
   it can cross ridges, rivers and other terrain that a single radio cell couldn't. Controllers
   are linked in a mesh (the backbone). Inside a cluster, most nodes reach the controller directly
   (28–39 dB of margin at 350 m spacing, doc 02); nodes behind terrain go through a scheduled relay.
   Most traffic stays local; only summaries cross the backbone (section 3a).
2. **Region: United States (US915).** The event layer's 500 kHz channels at tens of percent occupancy
   are allowed there (digital modulation, ≥ 500 kHz bandwidth, no dwell limit). The 125 kHz idle
   layer hops channel by superframe counter (see section 3); confirm the FCC details before hardware.
3. **Each controller owns its cluster's time.** Its GNSS-disciplined beacon defines every slot.
   Detector nodes (no GNSS) time-stamp the beacon's RxDone and run their sample clock against it;
   array nodes also check against their own PPS. All controllers use GNSS time, so superframes line
   up across clusters.
4. **Authenticated, not encrypted.** Every frame carries a 4-byte truncated AES-CMAC under the
   site key, with a replay counter. Contents are not secret enough to justify encryption in v0;
   a flag bit reserves it.
5. **Nodes may talk to nodes.** Every frame is a broadcast, so a node can use what it overhears from
   its neighbours (section 3b). This adds no routing and, in event mode, no airtime.

## 2. Frame layout

All multi-byte fields little-endian. Bit-packed payloads are LSB first.

```
| hdr (1) | src (1) | ctr (1) | payload (0–247) | mic (4) |
hdr:  type (4 bits) | version (2) = 0 | flags (2): bit0 relayed, bit1 encrypted (reserved)
src:  node id 1–254, unique within a cluster; 0 = controller, 255 = unprovisioned
ctr:  low 8 bits of the superframe counter (full counter is in the beacon) → replay window
mic:  AES-CMAC-32 over (site id, cluster id, full superframe counter, hdr..payload)
```

Overhead: 7 bytes. LoRa CRC on, explicit header.

## 3. Schedule

### Idle mode — SF9 / 125 kHz, superframe 4 s

| Part | Time | Use |
|---|---|---|
| Beacon | 0–230 ms | `BEACON` (206 ms at 24 B) |
| Scheduled slots | 900–3,980 ms | 14 slots × 220 ms, assigned by the beacon: the node windows (`DETECT_START`, `SHOT`), `HEALTH`, `RANGING_*`, `JOIN` |

The 250–890 ms alert window is gone: a detection now goes out in the sender's own window, so nothing contends.

The scheduled slots are fixed by use, so nothing contends in them:

- **First superframe: join.** Each node sends `JOIN` in a slot named for its id, at a 237 ms pitch, because a
  `JOIN` (29 B, 0.226 s at SF9) is longer than one 220 ms slot. Thirteen fit the region, so every node joins at
  startup, before a drone event can keep the network busy. A node that missed the join sends it again in the
  superframes where `sf mod 4 = 2`, until the hub names its window.
- **Node windows: every superframe except ranging and join superframes.** The hub gives each joined node a window,
  slot 0 to 12 in join order, and names it in the beacon. In its window a node sends its pending `DETECT_START`
  first, or else its queued `SHOT`. No two nodes contend. Windows are named a few per beacon, so the beacon stays
  inside its 250 ms window (247 ms at 13 nodes).
- **Health: slot 13**, the spare slot, on any superframe. At most one node is due in a superframe.
- **Ranging: every fourth superframe, from superframe 4 on**, slots 0 to 6. The windows pause on those superframes,
  so a detection or shot waits up to 8 s at worst, 4 s usually.

- Each node's `HEALTH` comes round every 75 superframes (5 min), staggered by node id.
- Worst-case alert latency: ≤ 4 s to the controller, + 4 s until the next beacon switches modes.
  (Phase 4 target: ≤ 5 s to the operator. Tighten by beaconing the mode switch immediately.)
- Controller beacon duty: 5%.
- US915 rules generally require frequency hopping below 500 kHz, so idle frames hop across the
  125 kHz channels by superframe counter. A 206 ms beacon is inside the 400 ms dwell limit.

### Event mode — SF7 / 500 kHz, superframe 500 ms (2 Hz updates)

| Part | Time | Use |
|---|---|---|
| Beacon | 0–25 ms | `BEACON` with track state and snippet requests (18 ms at 32 B) |
| Node slots | 30–290 ms | Up to 16 slots × 16 ms for `DETECT` (11.6 ms at 15 B) |
| Burst window | 300–495 ms | Allocated per beacon: `SNIPPET` chunks (100 ms per 255 B at SF7, 34 ms at SF5) |

- The controller enters event mode on any `DETECT_START` or a `HANDOFF` from a neighbouring
  cluster (section 3a), and leaves after 10 s with no detections. `HEALTH` stops during events (doc 06); ranging never runs during events.
- A 4 kbit snippet (1 s of 1-bit 4 kS/s audio) is 2 chunks at SF7 → one node per superframe, or
  5–6 chunks per window at SF5 when margins allow (gateway chooses per node from link SNR).

### 3a. Backbone and clusters

| Tier | Link | Carries | Stays off it |
|---|---|---|---|
| **Backbone** | Controller ↔ controller mesh on its own LoRa channel (SF8 / 500 kHz); a second radio in each controller. Observer stations listen | Crossing events and tracks, `HANDOFF`, health roll-ups, configuration | Raw `DETECT`, `HEALTH` and ranging frames; snippets |
| **Cluster** | LoRa, the schedule above. One controller, up to about 13 nodes (the example line is ~4 km) | All node traffic in sections 3–5, including scheduled relays | |
| **Node ↔ node** | The same LoRa frames, overheard | Neighbour detections and local fixes (section 3b) | |

- **Channels.** Each cluster has its own idle and event channels, reused only at a distance of
  3 or more clusters. Superframes are aligned by GNSS.
- **Relays.** The controller assigns them in the beacon: a relay repeats a named node's frame in its
  own slot with flag `relayed` set, at most 2 hops. Routes are scheduled, not discovered, so timing
  stays deterministic. Each relayed frame uses a slot, which reduces the cluster's capacity.
- **`HANDOFF`.** When a track heads for a neighbouring cluster, the controller sends it the track
  state (section 4) over the backbone. That cluster enters event mode before the drone arrives.
- **Backbone schedule.** A 500 ms GNSS-timed superframe with 3 origin slots and 3 relay slots of about
  45 ms each: a 32 B message plus the 7 B frame takes 38.5 ms at SF8/500. Each controller repeats
  frames it hears once (flooding), so losing the middle controller doesn't split the backbone.
- **Observer stations** sit behind the line, listen on the backbone channel and never transmit. They
  decode and verify frames, and show alerts, tracks, health and coverage. Because they can't ask
  for a repeat, controllers re-send the full track state every update and a state snapshot every 30 s.

### 3a-1. Layout: three subsections

The perimeter stays as it was (13 nodes at 350 m, about 4.2 km), split into three subsections:

| Subsection | Nodes | Controller, primary for those nodes | Position (x, y) |
|---|---|---|---|
| A | 1–4 | A | −1400, −250 m |
| B | 5–9 | B | 0, −250 m |
| C | 10–13 | C | +1400, −250 m |

Observer stations (example): (−1200, −850), (0, −850), (+1200, −850) m, about 600 m behind the nearest
controller.

**Link margins** from `lora_budget.py`, before shadowing (ASSUMED path-loss exponent 3, 20 dBm, 2 dBi):

| Link | Range | Idle SF9/125 | Event SF7/500 | Backbone SF8/500 |
|---|---|---|---|---|
| Node → primary, worst | 743 m | 35.7 dB | 24.7 dB | |
| Node → secondary, best | 743 m (nodes 5, 9) | 35.7 dB | 24.7 dB | |
| Node → secondary, worst | 2,115 m (nodes 1, 13) | 22.1 dB | 11.1 dB | |
| Controller → neighbour | 1,400 m | | | 18.9 dB |
| Controller A → C, skipping B | 2,800 m | | | 9.9 dB |

### 3a-2. Controller failure

**Placement rule.** Every node must reach a primary and a secondary controller. At install, or from
planning on the map, the primary link needs ≥ 15 dB and the secondary ≥ 6 dB at the event setting;
otherwise move the node or assign a relay. Node 1's and 13's secondary is the longest link at 2.1 km.

**Failover.**
- The join reply gives each node a primary and a secondary controller, with their channels and hop seed.
- A node that misses 3 beacons in a row (12 s idle, 1.5 s in event mode) moves to its secondary and sends
  `JOIN` in that controller's next scheduled slot.
- Controllers see a neighbour's loss on the backbone and reserve slots for its nodes before they arrive.
- Slots are enough: with B down, its 5 nodes split between A and C (at most 7 nodes each, against
  16 event slots and 14 idle slots). With two down, all 13 fit in the slots, but the far end has
  only ~2 dB at the event setting (4.2 km), so those nodes stay on SF9 and send less.
- Nodes return when the primary's beacon has been back for 1 minute. Node-to-node keeps running throughout.
- The fallback link is weaker, so event-mode traffic may step down a spreading factor per node.

### 3b. Node-to-node

**Event mode: overhearing, no extra airtime.** Nodes already listen during the event superframe,
so each one hears its neighbours' `DETECT` in their slots. Controllers send each node a neighbour
table (ids and positions on a 2 m grid) when it joins. With two bearings an array node computes an
intersection itself and sends `LOCAL_FIX` in its own slot, for the neighbours and the controller.

**Idle mode: listen only with a candidate.** Listening to the whole 640 ms alert window would take
16% × ~7 mA ≈ 1.1 mA, too much against a ~2 mA node. So a node opens the alert window only when
its own detector has a candidate. A neighbour's alert heard then counts as agreement, and the node
may lower its threshold for that f0 for a few seconds (a cue from next door).

**Where this helps (and where it doesn't).**
- *First seconds:* two neighbours can confirm each other inside one 4 s superframe, before the
  controller's beacon has switched modes.
- *Cluster boundaries:* neighbours on either side can't both reach one controller. A boundary node
  listens on the neighbouring cluster's event channel in slots agreed between the two controllers,
  so it doesn't wait for the backbone.
- *Behind terrain:* nodes keep working together when the controller or a relay is lost.
- *Not much in the middle of an event:* the controller hears the same `DETECT` frames in the same
  superframe, so its fix is about as fast, and it has every node's data. Cluster fusion stays the
  authority; `LOCAL_FIX` is a fast first answer.

To be simulated: confirmation time and energy with and without node-to-node, in the web demo and
the perimeter runner.

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
| 8 | `LOCAL_FIX` | N→all | target x, y (12 each, 2 m grid relative to the controller), time (16), partner node (8), σ (4), confidence (4) | 8 B payload, fits a `DETECT` slot; used instead of `DETECT` in that slot, section 3b |

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

## 6. Controller → operator (sketch)

Observer stations decode backbone frames into this form for their displays and any local client.
JSON over a local network socket (newline-delimited), versioned:

```json
{"v": 0, "type": "alert", "id": "evt-0192", "t": "2026-11-04T17:03:21.250Z",
 "segment": {"from_node": 6, "to_node": 7}, "position": {"lat": 0, "lon": 0, "alt_m": 30, "sigma_m": 25},
 "velocity": {"heading_deg": 182, "speed_mps": 21}, "class": "multirotor-small", "confidence": 0.86,
 "evidence": {"cluster": 2, "nodes": [5, 6, 7], "tdoa_fix": true}}
```

Other types: `track_update`, `coverage` (per-segment detection radius from the health
noise floors), and `gap` (segment without a working node or controller).

## 7. Open questions

- Whether 1-of-4 slotted ALOHA in the alert window is enough when a drone triggers 5+ nodes at
  once (simulate in M3; fallback: each node also gets a 1-in-N reserved alert slot).
- Relay assignment for nodes behind terrain, and cluster size once relays use up slots.
- Confirm the US915 details with a compliance lab before hardware: hopping set and dwell on the 125 kHz layer, and power limits at 500 kHz.
- Key management: site key provisioning alongside the acoustic provisioning (doc 05 uses the
  same site key for the phone frames).
