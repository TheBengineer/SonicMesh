# Research 02 — Information budget: what has to cross the mesh, and can LoRa carry it?

Date: 2026-11-04

**Assumptions:**
- Drone events are rare, so during an event the mesh may transmit flat out. Regulatory note:
  EU duty-cycle limits are averaged per hour, so a short burst is allowed. Each relay's
  retransmissions count against its own budget.
- Drones fly at up to **50 m/s**, to leave headroom.
- Nodes are 300–400 m apart.

## Answers in brief

1. **Everything except TDOA fits easily, even at SF7/125 kHz.**
   - A node's per-update report (detection, bearing, level, two harmonic-line frequencies) is about
     **40–70 bits**.
   - Sent at 2 Hz by 12 nodes with 2 relay hops, that's about **3 kbit/s for the whole mesh**.
2. **TDOA also fits during an event.**
   - **1-bit audio at 4 kS/s performs as well as full 16-bit, 16 kS/s audio** (a 64× reduction for free).
   - One TDOA "fix" is a 0.5–1 s window from each of 2–4 nodes, so **2–4 kbit per node**.
   - At **SF5–SF7 with 500 kHz bandwidth** (20–50 kbit/s per channel, with 28–33 dB of link margin
     at 400 m), that allows roughly 1–2 fixes per second.
3. **Side information is worth more than raw bits.** If the gateway uses the bearing fix to predict
   each node's arrival time, it can request *time-aligned* snippets. Without that alignment,
   short-window TDOA did not work at all in the test. The cheap FDOA report (the ratio of the two
   nodes' harmonic frequencies) then narrows the Doppler search. That keeps FDOA at 50 m/s
   accurate to about 1–2 m/s even when TDOA fails, where it otherwise reached 80–140 m/s errors.
4. **50 m/s forces short windows** (≤ 0.5 s). Over a 1 s window the TDOA drift curves too much.
   Short windows cost noise tolerance: a fast drone needs about 0 to +10 dB band SNR for TDOA,
   where a slow one manages about 0 to −5 dB.
5. **Shift- and scale-invariant features** (the image-matching analogy) are the natural next step
   down in size. The estimate is ~0.3–1 kbit/s, but it is untested; see §5.

## 1. LoRa capacity during an event

Script: [`sim/experiments/lora_budget.py`](../../sim/experiments/lora_budget.py). It uses the
SX1262 airtime formula, 255-byte packets, and GPS-synced TDMA with 4 ms guard times.

**Link assumptions:**
- 20 dBm transmit power and 2 dBi antennas.
- Near-ground path loss modelled with exponent 3 (an assumption; needs a field check).
- Under these assumptions, the signal at 400 m is −86 dBm.

| Setting | Goodput, kbit/s | Margin @ 400 m | ~Range |
|---|---|---|---|
| SF7 / 125 kHz (typical Meshtastic-like) | 4.9 | 39 dB | ~8 km |
| SF7 / 500 kHz | 19.0 | 33 dB | ~5 km |
| SF6 / 500 kHz | 31.9 | 30 dB | ~4 km |
| SF5 / 500 kHz | 51.5 | 28 dB | ~3.4 km |

**Takeaways:**
- **The node spacing is short enough to use the fastest LoRa modes.** Use a robust setting
  (SF7–SF9/125 kHz) while idle, and switch to SF5–SF7/500 kHz when the event starts.
- **GPS-synced TDMA matters.** The nodes already have PPS timing, so a scheduled slot plan reaches
  ~90% channel use, versus ~18% for unscheduled (ALOHA-style) access.
- **Slots replace header fields.** Each node's slot identifies it and timestamps its message,
  so ID and time fields cost close to zero bits.

The channel is shared, so each node's share of the goodput is smaller:

| Per-node kbit/s | 3 nodes, 1 hop | 6 nodes, 2 hops | 12 nodes, 2 hops |
|---|---|---|---|
| SF7/125 | 1.6 | 0.4 | 0.2 |
| SF7/500 | 6.3 | 1.6 | 0.8 |
| SF5/500 | 17.2 | 4.3 | 2.1 |

**Caveats:**
- *FCC (US915):* the 500 kHz modes likely qualify as "digital modulation" under FCC §15.247
  (no dwell-time limit). Verify that the 6 dB bandwidth is ≥ 500 kHz.
- *EU868:* use the 869.4–869.65 MHz sub-band (10% duty, 250 kHz, so SF5–7/250 at 27–9.7 kbit/s),
  or budget against the 1% hourly limits.
- *Extra burst capacity:* the SX1262's GFSK mode (50–300 kbit/s) is a further option for
  short-range bulk bursts.

## 2. How small can a TDOA payload be?

Script: [`sim/experiments/tdoa_compression.py`](../../sim/experiments/tdoa_compression.py).

**Method:**
- Each node band-limits its audio, decimates it, and keeps only the sign of each sample.
- The gateway runs GCC-PHAT with a drift-rate search.
- Node 2's window is offset by a TDOA predicted from a coarse position (σ = 20 ms).
- Optionally, the drift search is narrowed by a cheap FDOA prior (σ = 1 m/s).
- 8 trials per cell, so treat percentages as ±15%.

Each cell below gives the share of trials with TDOA error under 5 ms (≈ 1.7 m), with the FDOA prior on:

| Speed, window | SNR | raw 16 kS/s (256 kbit/s) | 1-bit 4k (4 kbit/s) | 1-bit 2k (2 kbit/s) | 1-bit 1k (1 kbit/s) |
|---|---|---|---|---|---|
| hover, 1 s | +10 | 100% | 100% | 100% | 25% |
| hover, 1 s | 0 | 100% | 100% | 38% | 38% |
| hover, 2 s | −5 | 38% | 50% | 12% | 12% |
| 10 m/s, 2 s | 0 | 100% | 88% | 62% | 25% |
| 10 m/s, 2 s | −5 | 50% | 62% | 38% | 25% |
| 50 m/s, 1 s | +10 | 100% | 100% | 88% | 38% |
| 50 m/s, 1 s | 0 | 38% | 25% | 12% | 0% |
| 50 m/s, 0.5 s | +10 | 100% | 100% | 100% | 12% |
| 50 m/s, 0.5 s | 0 | 50% | 75% | 38% | 0% |
| any | −10 | ≤ 25% | ≤ 25% | ≤ 12% | ≤ 25% |

**TDOA findings:**
- **The 1-bit 4 kS/s payload is the clear choice**: it matches raw audio throughout.
- 2 kS/s works at good SNR. 1 kS/s keeps too little bandwidth to time the signal sharply.
- When TDOA locks, its error is 0.0–0.4 ms. That is far better than needed, which suggests the
  windows could be shortened further at high SNR.

**FDOA (Doppler speed difference) findings:**
- When TDOA locks, FDOA error is 0.02–0.1 m/s for slow drones and ~1–2 m/s at 50 m/s.
  At 50 m/s it is limited by the TDOA drift curving within the window.
- When TDOA doesn't lock, FDOA falls back to about what the prior gives, 1–3 m/s.
- Without the prior, FDOA error at 50 m/s blew up to 50–140 m/s.

**Side-information finding:** without time-aligned windows, the 0.5 s / 50 m/s case failed
completely, even at +10 dB. The TDOA between nodes (up to 0.88 s) exceeded the window, so the two
snippets held different sound. **The bearing-based prior is what makes short-window TDOA work.**

## 3. Ranked information inventory

Ranked by value to the mission (detect → locate → track → classify) per bit. Sizes assume
predictive/delta coding against the current track where noted.

| Rank | Item | What it buys | Bits per update | Rate during event | Fits on |
|---|---|---|---|---|---|
| 1 | Detection flag + confidence (ID and time implied by TDMA slot) | Something is here, and which nodes hear it | 4–8 | 2 Hz | anything |
| 2 | Bearing az/el + uncertainty | Position from ≥ 2 nodes; aligns TDOA windows | 18 raw, ~10 predicted | 2 Hz | anything |
| 3 | Band level / SNR | Picks the TDOA nodes; weak range prior | 6 | 2 Hz | anything |
| 4 | 1–2 harmonic-line frequencies (cheap FDOA) | Velocity; narrows the TDOA drift search | 11/line raw, ~6 delta | 1–2 Hz | anything |
| 5 | Class / type | Threat assessment | ≤ 3, on change | rare | anything |
| 6 | Gateway → nodes: track state + snippet request | Window alignment, node selection | ~64 | 1–2 Hz broadcast | anything |
| 7 | **TDOA snippet: 1-bit audio, 4 kS/s** | ~1 m precision positions (time differences under a millisecond) and FDOA | 2,000–4,000 per node per fix | 2–4 nodes, 0.3–1 Hz | SF5–7 / 500 kHz |
| 8 | Invariant feature packet (proposed, §5) | TDOA + FDOA at lower rate | ~300–1,000 /s (estimate) | same | SF7/125 upwards (if it works) |
| 9 | Raw multi-mic audio | Training data, forensics | 1 Mbit/s per node | never live | collect over Wi-Fi when servicing |

**Baseline totals.**
- Ranks 1–6 come to about 40–70 bits per node per update.
- With 12 nodes at 2 Hz and 2 relay hops, that's ~3 kbit/s for the whole mesh. It fits
  SF7/125 kHz with room to spare, and uses only 15% of SF7/500.

**TDOA layer.**
- One fix from 3 nodes with 1-bit 4k audio is ~750 B with 0.5 s windows, or ~1.5 KB with 1 s windows.
- With 2-hop relaying that's 12–24 kbit per fix: about 0.6–1.3 s of airtime at SF7/500,
  or 0.25–0.5 s at SF5/500.
- So **~2 fixes/s at SF5/500, or about one fix per second at SF7/500.**

**Update-rate needs at 50 m/s.**
- A constant-velocity tracker's error between updates is ~½·a·Δt².
- With manoeuvres of 5–20 m/s², holding error to 30 m needs updates every 1.7–3.5 s.
  The 2 Hz baseline is comfortable.

## 4. Information-theory notes

**Where the timing information lives:**
- Steady harmonic structure is the same at every node, so it carries *no* timing information.
- Arrival time is carried only by the unpredictable part: rotor-speed jitter, blade-noise
  modulation, and broadband noise.
- So a payload should keep that randomness and discard the predictable structure.
- Taking the sign of whitened audio does exactly that. This is why 1-bit audio costs only about
  2 dB (the 2/π factor for a polarity correlator) and matched raw audio here.

**The theoretical floor:**
- Since node 2's signal is mostly predictable from node 1's, distributed source coding theory
  (Slepian–Wolf) says node 2 could, in principle, send only the conditional entropy H(X₂|X₁).
- In practice, exploiting that requires already knowing the delay. The time-aligned prior is a
  crude version of the same idea.

**Fisher-information view of feature bandwidth:**
- TDOA error σ_τ ≈ 1 / (2π B_rms √(2·T·B·SNR)).
- The randomness that features rely on (rotor-speed jitter) has a bandwidth B of only ~5–20 Hz.
- At B_rms ≈ 5 Hz, T = 1 s and feature SNR ≈ 10, σ_τ ≈ 5 ms. That is still under 2 m of range
  difference, so a feature payload can in principle be 10× smaller than 1-bit audio.

## 5. Next: invariant features ("SIFT for drone audio")

A Doppler shift stretches node 2's spectrogram relative to node 1's:
- the frequency axis scales by (1 − ρ),
- the time axis scales by (1 + ρ),
- and everything is offset by the TDOA.

This is the audio counterpart of an image that is scaled and shifted. The same tricks apply.

**Option A: log-frequency (Fourier–Mellin) features.**
- On a log-frequency axis, the frequency scaling becomes a shift.
- One 2-D correlation over (time lag, log-frequency shift) then recovers TDOA and FDOA together,
  with no warp search.

**Option B: landmark hashes (Shazam-style).**
- Each node picks spectrogram peaks, such as the individual rotor lines at higher harmonics where
  the 4 rotors separate.
- It encodes peak pairs as (f₁, f₂/f₁, Δt). The frequency ratio is Doppler-invariant, and Δt
  barely changes over short gaps.
- The gateway matches hashes between nodes. The matched pairs' time offsets vote for the TDOA,
  and their frequency ratios vote for the Doppler.
- Cost: ~20–30 bits per landmark at ~20–40 landmarks/s, so ~0.5–1 kbit/s.

**Option C: per-rotor line tracks.** Track each rotor's line frequency at ~20–40 Hz, using
4–6 bits per sample. That's ~0.3–0.6 kbit/s. Doppler appears as a scale factor on each line,
which is solvable directly.

**Risks.** Picking and labelling peaks becomes unreliable at low SNR, before raw correlation does.
The earlier single-f0 tracker failed for exactly this reason. The experiment should measure the
SNR threshold against 1-bit 4k audio: features win only if their threshold is close, because their
size advantage is just 4–10×.

## 6. Two-stage test: cheap coarse match, then a narrow fine search

Script: [`sim/experiments/tdoa_two_stage.py`](../../sim/experiments/tdoa_two_stage.py).

**Setup:**
- Every coarse stage gets the same 2 s window from both nodes and **no bearing information**.
- The fine stage is 1-bit 4 kS/s audio, aligned by the coarse result and searched ±15 ms and
  ±8 m/s around it.
- 10 trials per row.

**Coarse options:**
- *lines* (~1.1 kbit per node). Each node announces its 12 strongest line frequencies
  (500–2000 Hz). The gateway registers the two sets by frequency ratio, which gives the Doppler.
  Nodes then send 25 frames/s wobble tracks of 4 matched lines, which are correlated after
  undoing the time stretch.
- *1-bit 1k* (2 kbit per node). 1-bit audio at 1 kS/s (100–450 Hz), full lag and drift-rate search.

Each cell is the share of trials with TDOA error under 5 ms after the fine stage:

| Speed | SNR | lines → fine | 1-bit 1k → fine | bearing → fine (baseline) |
|---|---|---|---|---|
| hover | +10 | 90% | 100% | 100% |
| hover | 0 | 10% | 30% | 100% |
| 10 m/s | +10 | 90% | 100% | 100% |
| 10 m/s | 0 | 0% | 30% | 90% |
| 50 m/s | +10 | 60% | 10% | 100% |
| 50 m/s | 0 | 0% | 10% | 20% |

**Findings:**
- **Coarse → fine works as designed.** Whenever the coarse stage lands within ±15 ms, the fine stage
  reaches 0.0–0.2 ms, and FDOA error falls to 0.03–1 m/s.
- **Both bearing-free coarse stages need about +10 dB**, roughly 10 dB worse than bearing-aligned
  windows. Two causes:
  - *Line features:* line-frequency noise swamps the ~1% rotor wobble at lower SNR.
  - *1-bit 1k audio:* full-range lag and drift searches over a 2 s window have many chances for a
    false peak. At 50 m/s the drift also curves within the window.
- **Bearings remain the best coarse stage.** They're also the cheapest: ~20 bits, already sent every update.
- **Bearing-free TDOA is a fallback for close, loud targets**, such as single-mic nodes or a drone
  near the nodes. Possible improvements, all untested:
  - longer coarse windows for slow targets,
  - correlating across more than two nodes jointly,
  - matching line features against a predicted drone model rather than node-to-node.

## Reproduce

```bash
uv run sim/experiments/lora_budget.py
uv run sim/experiments/tdoa_compression.py --trials 8
uv run sim/experiments/tdoa_compression.py --trials 8 --fdoa-prior 0
uv run sim/experiments/tdoa_two_stage.py --trials 10
```
