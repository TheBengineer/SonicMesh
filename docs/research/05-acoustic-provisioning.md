# Research 05 — Acoustic provisioning: the phone tells the node where it is

Date: 2026-11-04

**The idea.** While a node is being placed, the installer's phone loops its GPS fix out of its
speaker as a signed data frame. The node listens in "modem mode" from power-up. It keeps the fixes
it heard while the phone was next to it, and commits its position once it hears the phone walk
away.

**What it needs.** No GNSS on the node and no extra radio. It works from a web page: Web Audio
plays the sound and the Geolocation API supplies the fix, with no app and no Web Bluetooth, which
iOS lacks.

Code: [`sim/provisioning/`](../../sim/provisioning/). Run it with `uv run sim/provisioning/run.py`
(~4 min).

## Link design

| Item | Choice | Why |
|---|---|---|
| Carrier and band | 2.5 kHz, ~2.35–2.65 kHz | Phone speakers are decent there; fits a minimal node's 8 kS/s |
| Modulation | DBPSK, 200 baud, root-raised-cosine pulses (β 0.5) | Differential detection tolerates hand-held phase drift |
| Sync | 63-symbol m-sequence preamble | Frame start, Doppler and phase reference |
| Doppler | Preamble searched over time-scale α ±1.2%, then refined by a maximum-likelihood frequency search on the preamble | A walking phone stretches or compresses the whole waveform (carrier *and* timing), so one α fixes both. Its sign is the phone's radial direction |
| FEC | Rate-½, K=7 convolutional (171/133) with soft Viterbi, plus a pseudo-random interleaver | Survives ground-bounce notches and noise |
| Frame | 32 B: site, sequence number, time, lat/lon (1e-7°), altitude, accuracy, 8-byte truncated HMAC-SHA256, CRC-16 | 2.96 s on air, looped with 0.15 s gaps |

Loopback results: decodes at **0 dB SNR** in the 300 Hz band, with ±0.8% Doppler (±2.7 m/s).
α is estimated to within ~4×10⁻⁵, about 1.4 cm/s of radial speed.

## Placement logic (node side)

**Carried.** Either the accelerometer says the node is moving, or (without one) the decoded GPS fix
moves faster than 0.6 m/s over ~6 s while the received level stays steady and high. That's the
phone and node travelling together. While carried, nothing is latched.

**Near.** Frames within 6 dB of the loudest frame since the node was set down. A near window can
only start within 10 dB of that loudest frame, so frames from the operator walking off can't
start one.

**Walk-away.** Any one of these:
- the carrier-band level stays below max(near − 12 dB, noise floor + 4 dB) for 3 s, *and* a decoded
  frame's Doppler shows the phone receding;
- that level condition lasts 6 s, if nothing decodes any more;
- a receding frame's own GPS fix is more than 8 m from the near fixes.

The noise floor is measured in the 0.15 s gaps between frames.

**Commit.** The accuracy-weighted mean of the near fixes, with outliers > 5 m dropped. With fewer
than 2 near frames (no linger), it uses the last frame from while the node was carried, flagged
*low confidence*.

**Security.**
- Frames must pass the CRC, the site-key HMAC, and in-session time/sequence consistency.
- The node has no clock before it joins the mesh, so the **gateway** checks the committed frame's
  timestamp is recent. That blocks replaying an old recording.

## Simulated results

**Channel model:**
- The phone loops frames at 80 dB SPL at 10 cm through a 0.7–7 kHz speaker response.
- Ground-level node mic, reached directly and by a ground bounce (Γ 0.7), with a moving phone and
  a moving node, so Doppler is built in.
- Pink ambient noise, plus ~29 dB SPL of mic self-noise.
- Phone GPS: a ±2 m wandering bias (60 s correlation) plus 0.5 m jitter.

**Scenario:** carry the node and phone 40 m, set the node down, linger, walk off at 1.4 m/s.
8 seeds per row.

| Scenario | Commits | Confident | Error median / max | Commit after leaving | Frames decoded |
|---|---|---|---|---|---|
| A: accelerometer, 10 s linger, 45 dB ambient | 8/8 | 8 | **1.1 m / 3.6 m** | 6.5 s | 200/216 |
| B: no accelerometer, 10 s linger | 8/8 | 8 | **1.1 m / 3.6 m** | 6.5 s | 200/216 |
| C: no accelerometer, no linger | 8/8 | 0 (fallback) | 6.0 m / 9.8 m | 6.0 s | 181/192 |
| D: as A at a noisy site, 60 dB ambient | 8/8 | 8 | 1.1 m / 3.6 m | 9.4 s | 104/216 |
| E: phone without the site key | 0/8 | — | — | — | 0 accepted (200 HMAC rejects) |

Range test (share of frames decoded, phone held still at 1.2 m height, node on the ground):

| Ambient | 0.5 m | 1 m | 2 m | 4 m | 8 m | 16 m |
|---|---|---|---|---|---|---|
| 45 dB | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 60 dB | ✓ | ✓ | ✓ | 38% | 0% | 0% |

✓ = all frames that fit in the run (92%; the rest were cut off at its ends).

**Takeaways:**
- **Position error is just phone-GPS error** (1.1 m median, 3.6 m worst here). The audio link and
  latch add essentially nothing.
- **A ~10 s linger matters more than an accelerometer.** With a linger, both A and B are fully
  confident. Without one (C), the node can only use the fix from just before it was set down:
  6–10 m error, correctly flagged low-confidence. **UX rule: "hold the phone by the node until it
  confirms".**
- The ~$1 accelerometer is still worth it for tamper alerts ("node moved"). Moving a node then
  resets it to provisioning automatically.
- **Noisy sites work** because the walk-away test uses the measured noise floor, but there the
  link only reaches ~2–4 m.
- **Development bugs worth remembering:**
  - Judging "carried" from two consecutive fixes made GPS jitter look like walking. Judge it over
    ~6 s.
  - Without the noise-floor rule, noisy sites never committed.

## Practical design notes

- **Confirmation back to the installer.** The node has no speaker. Once it commits, it joins the
  mesh over LoRa with its position and confidence. The gateway (or a cloud relay) then tells the
  web page "node 17 placed at … ± … m". That closes the loop, and is where the replay/time check
  runs.
- **Web page:**
  - It needs HTTPS for geolocation and a tap before playing audio.
  - Keep the screen on with the Wake Lock API.
  - Wait for a GPS fix of ≤ 5 m accuracy before allowing placement.
  - Under tree cover, step into the open first, then walk to the node.
- **Array nodes also need heading.** Options:
  - have the phone send its compass heading while held along an arrow on the enclosure (±5°;
    metal nearby skews it),
  - add a magnetometer,
  - use the Remote ID calibration flight.
- **On the node:**
  - The receiver costs a mixer, an RRC filter, and 17 preamble correlations only while in modem
    mode, plus a ~300-bit Viterbi per frame. That's trivial even on the minimal nRF52840 node.
  - In firmware, do the preamble search with a streaming matched filter rather than the batch FFTs
    used here.
- **Prior art:** [ggwave](https://github.com/ggerganov/ggwave) (multi-tone FSK + Reed–Solomon, with
  a browser build) would also work. This custom modem adds Doppler/radial-speed measurement,
  stronger FEC, and authentication, which the placement logic uses.

## Not yet modelled

- A person's body shadowing the speaker.
- Phone speaker directivity.
- Wind noise at the mic.
- Phones that resample or filter audio unusually.
- Real ground impedance.

**Next real-world check.** Play the frames from a phone web page to a bench node, an ESP32-S3 or
nRF52840 with a PDM mic, and log decode rate against distance and site noise.
