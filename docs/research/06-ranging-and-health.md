# Research 06 — Periodic LoRa ranging and health telemetry

Date: 2026-11-04

Script: [`sim/experiments/ranging_health.py`](../../sim/experiments/ranging_health.py)
(`uv run sim/experiments/ranging_health.py`, ~5 s).

**Question.** What do periodic radio ranging between neighbours, and a health report on every
heartbeat, add to the perimeter? What do they cost in airtime and energy?

## Answers in brief

1. **Health telemetry is nearly free.** A 23-byte report on the existing 5-minute heartbeat takes
   206 ms at SF9/125 kHz: 0.07% duty per node and < 1% of the channel for 13 nodes. That is far
   inside the EU868 1% limit.
2. **Ranging does not position nodes on a perimeter.** The nodes form a near-straight line, so
   range measurements barely constrain where a node sits *across* the line. With GNSS anchors on
   every 3rd node and no other position source, the across-line error is ~50 m. Positions keep
   coming from acoustic provisioning (doc 05, ~1.5 m), and ranging adds nothing measurable to them.
3. **Ranging is an integrity check.** Per node-year it allows one false alarm, and it finds:
   - **gross mistakes:** swapped node IDs, a provisioning fix from the wrong spot, or a node
     placed at the wrong position in the line. These are tens to hundreds of metres;
   - **moves along the line:** ≥ 10–20 m with sub-GHz ranging, ≥ 5–10 m with 2.4 GHz;
   - **impostors:** a node with the right key answering from the wrong distance.
   It does **not** catch moves across the line. The ~$1 accelerometer (doc 05) does, so keep it.
4. **One radio can do both jobs.** Semtech's LR11xx and LR20xx LoRa transceivers include
   round-trip time-of-flight (RTToF) ranging in the sub-GHz band. That replaces the SX1262 on
   both node types, with no second radio. The SX1280 at 2.4 GHz ranges more precisely but has
   shorter links and would be a second radio. It isn't needed for integrity checks.
5. **Energy is small.** An hourly sweep costs ~1–2% of the minimal node's 2 mA budget. A daily
   sweep plus on-demand sweeps costs well under 0.1%.

## 1. Health telemetry

**Report contents.** 152 bits of fields plus 4 B of framing (type, sequence number, truncated
message authentication code) = **23 B**.

| Field | Bits | What the gateway does with it |
|---|---|---|
| Battery voltage, 10 mV steps | 8 | Forecasts days to empty |
| Solar harvest today | 8 | Flags shaded or dirty panels |
| Enclosure temperature | 8 | Battery derating, overheating |
| Uptime + reset reason | 16 | Watchdog resets, brown-outs |
| Mic band noise floor (minimum over interval) | 8 | **Live coverage estimate** (see below) |
| Mic self-test flags: stuck PDM, clipping, DC, dead band | 4 | Dead or blocked mic → coverage gap |
| Wind / self-noise level | 8 | Explains coverage drops; adapts thresholds |
| Detections and rejected candidates since last report | 12 | False-alarm trend; tuning |
| Tilt from install orientation | 8 | Knocked over; array heading is now wrong |
| Tamper / moved flags (accelerometer, ranging) | 4 | Security alert; re-provision |
| Gateway beacon RSSI and SNR at the node | 16 | Link margin trend |
| Clock offset to beacon and drift | 16 | Time-sync health (matters for TDOA) |
| Neighbours heard, retries, queue depth | 12 | Mesh health |
| GNSS satellites + PPS lock (array nodes) | 8 | Array timing health |
| Firmware build hash (every 12th report, else config CRC) | 16 | Fleet version drift |

**Airtime.**

| Setting | Airtime | Duty per node at 5 min | 13 nodes, channel busy |
|---|---|---|---|
| SF7/125 kHz | 62 ms | 0.021% | 0.27% |
| SF9/125 kHz | 206 ms | 0.069% | 0.89% |
| SF10/125 kHz | 371 ms | 0.124% | 1.61% |

**Health reports stop during a drone event**, so detection traffic has the channel to itself.
They resume when the event ends. The detection messages show the node is alive in the meantime.

**Gateway rules.**
- **Silent node:** 3 missed heartbeats (15 min) outside an event → "segment gap" alert, and the
  radar is cued to watch that sector at low elevation. Event time doesn't count toward the 15 min.
- **Live coverage map.** A node's detection radius shrinks as its noise floor rises. With
  spherical spreading and air absorption ignored, +6 dB of ambient noise halves it. The
  gateway turns each node's reported floor into a per-segment coverage estimate, and passes thin
  segments to the radar as watch sectors. Phase 3's measured detection-vs-range curves calibrate
  this.
- **Mic faults:** self-test flags, or a noise floor far below that of its neighbours, mark the
  node blind even though it still reports.
- **Battery:** forecast days to empty from voltage and harvest, and alert a week ahead.
- **Tamper or tilt:** security alert. The node drops back to provisioning mode until re-placed.
- **Clock and GNSS:** a node whose time sync degrades is left out of TDOA solutions, but still
  counts for detection.

**Downlink commands.** Authenticated with the site key and gated by a sequence number. They are:
send a report now; run a ranging sweep; re-provision; change detection thresholds; reboot.

## 2. Periodic ranging

**How RTToF works.** One radio sends a short request and the other answers. The initiator times
the round trip, so no shared clock is needed. Averaging measurements in both directions, and
across hopped channels, cancels oscillator offset and reduces multipath error.

**Assumed accuracies.** These are planning numbers, not measurements, and Phase 2 must measure
them.
- Sub-GHz RTToF (LR11xx/LR20xx, 500 kHz): ~4 m per averaged sweep in the open, plus ~1 m of
  day-to-day drift.
- 2.4 GHz (SX1280, 1.6 MHz): ~1.5 m per sweep, plus ~0.5 m of drift.
- Either band: ~25% of links partly blocked, adding a fixed bias of 0–12 m.

Published results back this range: ~1 m in controlled line of sight, and a few metres to tens of
metres in real outdoor tests.

**Network modelled.** 13 nodes at 350 m spacing, each within ±15 m of a straight line. Every 3rd
node is a GNSS array node (anchor, ±2 m). Sub-GHz links reach 2 hops; 2.4 GHz links reach only
the next node.

### 2.1 Positioning: ranging doesn't help on a line

RMS error of the non-anchor nodes, along / across the line:

| Position sources | Sub-GHz RTToF | 2.4 GHz RTToF |
|---|---|---|
| Provisioning fix only (no ranging) | 1.4 / 1.5 m | 1.4 / 1.5 m |
| Anchors + ranging, no provisioning fix | 3.4 / **50 m** | 9.0 / **57 m** |
| Anchors + ranging + provisioning fix | 1.3 / 1.5 m | 1.3 / 1.5 m |

**Why.** Between two nodes on the line, the range changes in proportion to a move *along* the
line. A move *across* it changes the range only by d²/(2 × 350 m): a 10 m sideways move changes
it by 14 cm.

**Zig-zagging the nodes doesn't fix it.** Even ±60 m offsets, alternating sides, still leave
14–17 m of across-line error.

**Conclusion.** Positions come from the provisioning fix, or from GNSS on array nodes. Ranging
checks them.

### 2.2 Integrity: detecting a moved or wrong node

**Method.** A daily sweep is compared with the mean of the previous 7. The alarm threshold
allows 1 false alarm per node-year. Fixed multipath bias cancels in the comparison.

Probability of detecting a move:

| Radio | Move direction | 2 m | 5 m | 10 m | 20 m | 40 m |
|---|---|---|---|---|---|---|
| Sub-GHz (4 links) | Along the line | 1% | 10% | 79% | 100% | 100% |
| | Across the line | 1% | 0% | 0% | 0% | 2% |
| | Random | 1% | 4% | 37% | 70% | 89% |
| 2.4 GHz (2 links) | Along the line | 5% | 80% | 100% | 100% | 100% |
| | Across the line | 0% | 0% | 0% | 2% | 40% |
| | Random | 2% | 39% | 76% | 89% | 96% |

**What each check covers.**
- **Accelerometer:** any handling, in any direction, immediately. It is the primary tamper sensor.
- **Ranging:** whatever the accelerometer can't vouch for:
  - gross provisioning errors, such as swapped IDs or a fix taken at the wrong node. These are
    ≥ 300 m out and detected on the first sweep;
  - a node replaced or carried along the line with its accelerometer defeated;
  - the low-confidence provisioning fallback (doc 05 scenario C: 6–10 m error), which ranging
    can confirm or flag along the line;
  - impostors: a valid key answering from the wrong range.
- **Link quality:** every ranging exchange also measures node-to-node RSSI and SNR, which maps
  the mesh's real link margins.

### 2.3 Schedule and cost

Energy per sweep, per node (initiating half its links, answering the rest; +20 dBm transmit at
110 mA, receive at 7 mA):

| Radio / setting | One measurement | 16-measurement sweep per link | Links | Per sweep | Hourly sweeps, share of a 2 mA node |
|---|---|---|---|---|---|
| Sub-GHz SF8/500 kHz | 33 ms | 0.53 s | 4 | 0.034 mAh | 1.7% |
| Sub-GHz SF7/500 kHz | 18 ms | 0.28 s | 4 | 0.018 mAh | 0.9% |
| 2.4 GHz SF8/1.6 MHz | 12 ms | 0.18 s | 2 | 0.006 mAh | 0.3% |

**Schedule.**
- **After placement:** one sweep when a node joins. This catches gross provisioning errors at once.
- **Daily:** one sweep at the quietest hour, scheduled by the gateway into TDMA slots.
- **On demand:** after an accelerometer or tilt event, after a reset, or when a neighbour reports
  something odd.
- **Never during a drone event:** detection traffic has priority.

## 3. Hardware consequence

**Detector and array nodes:** swap the SX1262 for an **LR2021** (or LR1121). Both are sub-GHz
LoRa with RTToF in the same chip.
- The LR2021 also covers 2.4 GHz. Whether its RTToF works in that band is not confirmed; check
  the datasheet.
- A dev kit pairs the LR2021 with a Seeed XIAO nRF54L15, which is the minimal node's MCU.
- Cost: a few dollars more than an SX1262. Same antenna, same mesh.
- **Fallback:** keep the SX1262 and add an SX1280 2.4 GHz module, plus a second antenna. Do this
  only if Phase 2 shows sub-GHz RTToF can't meet the integrity numbers above.

**Keep the accelerometer** on every node. Ranging can't see across-line moves.

## 4. To measure in Phase 2

- Sub-GHz RTToF error and day-to-day drift between two LR2021 boards at 350 m, in the open and
  through trees.
- Measurement time per exchange, and current, on the real board.
- Whether temperature changes the calibration over a day, which would raise false alarms.

## Sources

- [Semtech: An Introduction to Ranging with the SX1280 (AN1200.29), mirror](https://manuals.plus/m/b6f3f947301a57194a3450fa72bd48fb71ea75cff2e0fdefa29c6dd8230d9e38)
- [Müller et al. 2021, Outdoor ranging and positioning based on LoRa modulation](https://digitalcollection.zhaw.ch/bitstream/11475/22769/3/2021_Mueller-etal_Outdoor-ranging-and-positioning-based-on-LoRa-modulation.pdf)
- [SX1280 ranging precision study (arXiv 2509.23125)](https://arxiv.org/pdf/2509.23125v1)
- [Semtech LR11xx ranging demo (sub-GHz RTToF)](https://github.com/Lora-net/lr11xx_ranging_demo)
- [Semtech LR2012 / LR2021 / LR2022 datasheet](https://www.radiolocman.com/datasheet/pdf.html?di=188481)
- [LR2021 LoRa ranging notes (third-party)](https://theclams.github.io/2025/09/15/lr2021-lora_ranging.html)
- [LR2021 evaluation kit with XIAO nRF54L15](https://www.pakronics.com.au/products/semtech-lr2021-lora-plus-evaluation-kit-eu868-semtech-lora-xiao-nrf54l15-ss100039980)
