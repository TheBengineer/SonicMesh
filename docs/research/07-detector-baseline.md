# Research 07 — Detector baseline: why the perimeter misses drones, and what the false-alarm rate can and cannot show

Date: 2026-11-05

Scripts: [`sim/perimeter/run.py`](../../sim/perimeter/run.py) (`--tune`, `--ablate`, and the held-out run with
`--part crossings` and `--part fa`), [`sim/perimeter/real_checks.py`](../../sim/perimeter/real_checks.py),
detector [`sim/detector/detector.py`](../../sim/detector/detector.py), gateway rule
[`sim/perimeter/fa.py`](../../sim/perimeter/fa.py). Tests: `sim/tests/test_gateway.py`.

**Question.** Does the 13-node perimeter meet the Phase 1 exit criteria: at least 95% of crossings detected below
100 m altitude, and at most 1 false alarm per km of perimeter per day? If not, what is the best trade-off, and how
far off is it?

**Short answer: no.** The exit criteria are not met. The best setting found detects about 1 crossing in 5 below
100 m on the held-out folds, and the false-alarm rate is not yet bounded below 1 per km per day.

## Answers in brief

1. **Held-out result (folds 4-5, chosen setting, theta 0.10).** Gateway Pd below 100 m is **18%** (36 of 199
   crossings); node-level Pd below 100 m is **62%**. The 95% target is not close. Pd falls with wind for FPV
   (below 50 m: 88% at 0-2 m/s, 31% at 5-8 m/s). Mini and matrice were **never** detected at the gateway below
   100 m (0 of 62 and 0 of 61); FPV was detected in 36 of 76.
2. **Cause of the node misses: the 2-second track-age gate.** Removing it raises node Pd below 100 m from 0.68 to
   0.95 and gateway Pd from 0.19 to 0.57 (folds 1-3). The other rejection steps (harmonicity, good-frac, impulse)
   change Pd by 0.05 or less. Removing the gate does not reach the target either: gateway Pd stops at 0.57. A
   +6 dB source level on mini and matrice moves their gateway Pd only from 0 to 0.04 (folds 1-3, small samples).
   Mini and matrice comb scores are low in the rural bed, and their tracks break before 2 s (section 2). The age
   gate is also what keeps false alarms down: without it there are 2,287 node alarms per node-day on the rural bed.
3. **Gateway rule: two real errors.** The 10 s pair window rejects most true adjacent-node pairs (the median gap
   between the two nodes' onsets is 15 s; 84% are under 30 s). The f0 match also rejects a second harmonic against
   the fundamental at the other node (only 10% of mini and 14% of matrice pairs agree within 12% without an octave
   allowance). Changing the window to 30 s and allowing an octave raised gateway Pd at every threshold on folds
   1-3 (0.11 to 0.17 at theta 0.12; 0.19 at 0.10). It is not free: the old rule gave 0 gateway events at every
   threshold on the 39 node-hour bed, and the new rule gave 1 event each at theta 0.12, 0.16 and 0.18.
4. **Alternatives to two-node confirmation.** A single node's own alarm is at 39 node-alarms per node-day at the
   chosen threshold, which is about 120 per km-day at the perimeter (folds 1-3). That fails the target by two
   orders of magnitude, so the pair rule stays. Dropping the track-age gate gives 2,566 gateway alarms per km-day.
   A 1 s age gives 223 per km-day.
5. **False alarms are not bounded below the target.** Rural bed, folds 4-5, 78 node-hours (6 h per node): 112 node
   alarms (34 per node-day), one gateway alarm: **0.95 per km-day, 95% upper bound 4.5 per km-day**. Zero events
   would bound it at 2.9 per km-day. Showing <= 1 per km-day with zero events needs **223 node-hours** (17.1 line
   hours); that did not fit the time budget. The dense ESC stress bed gives 549 gateway alarms per km-day.
6. **Node-to-node across the A|B boundary (ASSUMED timing model).** Median wait after the later onset falls from
   0.62 s to 0.31 s in event mode, and from 2.26 s to 2.09 s in idle mode (15 boundary pairs). Measured from the
   drone entering 400 m, both are about 29 s, so detection dominates and the network step is small.
7. **Real-audio checks.** Direct DroneNoise clips: Matrice on at 6 of 9 mics, Mini 3 Pro on at 8 of 9. The Mini's
   f0 sits at about twice the centre-mic line on most mics. Propagated real sources cannot be separated from the bed
   alone: a 50 dB bed with no drone triggers at the source's f0 in 30-60% of 60 s trials (10 trials).

## 1. Method

**Scenario (unchanged).** 13 nodes at 350 m on a line; crossings with class (FPV, Mini, Matrice), altitude 10-120 m,
speed 5-25 m/s, crossing angle 40-140 deg, crossing point along the line, wind 0-8 m/s. Source levels 85 dB (FPV)
and 80 dB (Mini, Matrice) at 1 m, and the blade-pass frequencies, are ASSUMED from `sim/acoustics/model.py`. A node
renders the drone while it is within 600 m. A crossing counts as detected when a gateway alarm falls within the
window while the drone is within 400 m of the line. Background: rural scene (ESC-50 outdoor events at assumed rates
and levels, pink ambient 40 dB SPL, wind 2 m/s) and, as a stress test, a dense bed of back-to-back ESC-50 clips at
50 dB SPL.

**Data splits.** Folds 1-3 are used for diagnosis, tuning and the ablation. Folds 4-5 are held out. Before the
held-out run, two things were done on folds 4-5 that the rules did not allow for: the earlier quick run and a later
12-crossing quick check both scored folds 4-5, and the first held-out attempt (50 h per node) was
stopped after it had produced crossing results and not finished the false-alarm run. The crossing numbers from that
attempt match the final crossing run exactly (same seeds, same code). Changes made after looking at folds 4-5:
the latency comparison now uses every adjacent pair where both nodes detect (the gateway-confirmed set had only
2 pairs in the quick run); the real-audio criterion was changed after the first run counted any alarm as a
detection (see section 7); and a `score()` default was corrected so that the "all altitudes" column is all
altitudes. None of these changes the detector or the gateway rule.

**Detector and gateway settings.**

| Parameter | Value | Notes |
|---|---|---|
| theta | 0.10 | chosen on folds 1-3 (section 4); the lowest value tried |
| hold_ratio | 1.0 | 0.5 tested (section 2) and not used |
| age_min | 62 frames (2 s) | ablated (section 2) |
| Gateway window | 30 s | was 10 s |
| Gateway f0 match | within 12 %, directly or an octave apart | was within 12 % only |
| N_HARM_MAX | 16 | 10 tested (section 2) and not used |

**Statistics.** Crossing Pd is a binomial share; with n = 96 (folds 1-3, below 100 m) the standard error is about
0.04 at Pd 0.2. False alarms are counted as gateway events over the whole line-time. The 95% upper bound for k
events in T line-hours is chi-squared(0.95, 2k+2)/2 events, divided by T/24 times 4.2 km. The rural bed here
is the ASSUMED scene; its rates are judgement, not measurement.

## 2. Node misses: cause (step 1)

Ablation, folds 1-3, 120 crossings (96 below 100 m), theta 0.10. Each rejection step switched off on its own. The
impulse step has its own comb, so it runs separately.

| Setting | Node Pd < 100 m | Gateway Pd < 100 m | Node alarms per node-day, rural, 13 node-h | Gateway alarms per km-day, rural, 13 node-h |
|---|---|---|---|---|
| All on (chosen) | 0.68 | 0.19 | 39 | 0 (0 events) |
| No track age | 0.95 | 0.57 | 2,287 | 2,566 (449 events) |
| Age 1 s (16 frames) | 0.96 | 0.45 | 569 | 223 (39 events) |
| good_frac 0 | 0.68 | 0.19 | | |
| No harmonicity | 0.69 | 0.19 | | |
| No impulse rejection | 0.73 | 0.21 | | |
| Slew on (for reference) | 0.14 | 0.00 | | |

Source: `uv run sim/perimeter/run.py --ablate --crossings 120 --hours 1`. The false-alarm columns are on a 13
node-hour bed, so a zero there is not a bound (section 6).

**Evidence on the mechanism** (exploration on folds 1-3 with the code before this change: harmonic cap 16,
gateway 10 s and exact f0, theta 0.12; per-crossing diagnostic, not part of the repo):

- Track age in the crossing window (median of each node's maximum): FPV 98 frames, Mini 24, Matrice 18. The gate
  needs 62 hits without a reset.
- Comb score at the class fundamental, maximum in the crossing window (median): FPV 0.61, Mini 0.17, Matrice 0.16,
  against a threshold of 0.12. Mini and matrice are over threshold, but only just, and they fall back below it
  often enough that the track resets.
- Band SNR (100 Hz to 4 kHz, drone against bed) is -15 to -19 dB median for all classes. Wind below 200 Hz
  dominates that band, so band SNR is the wrong measure for a comb; it is not used as evidence for the mechanism.
- Wind matters for FPV on the held-out set: below 50 m, gateway Pd is 0.88 at 0-2 m/s, 0.65 at 2-5 m/s and 0.31 at
  5-8 m/s.

**Tested and not used:**

- *Harmonic cap 10 instead of 16* (the source has 10 harmonics; doc 04 says 10). Node Pd below 100 m 60 of 96
  against 61 of 96. No effect; reverted to 16.
- *Hysteresis (hold_ratio 0.5)*, so an acquired track survives on half the threshold. Node Pd 0.64 against 0.62, no
  gain, and it broke the existing 0 dB mini test (the track locked on a third-harmonic sub-multiple). Default kept
  at 1.0. The parameter stays in the code with the test that exercises it.
- *Source level +6 dB for mini and matrice* (ASSUMED levels, folds 1-3, theta 0.10): mini gateway Pd 0 to 0.04 (n = 25), matrice
  0 to 0 (n = 34), FPV 0.49 (n = 37). The level is not what limits mini and matrice.

**Which layer breaks mini and matrice (exploration, not part of the repo).** One geometry only: 30 m altitude, 15 m/s,
perpendicular pass, 8 node-passes per row, theta 0.10, rural bed from folds 1-3. Values are medians within 300 m of
the node: the longest track age (62 needed) and the best comb score in the frame.

| Layers | FPV age / score | Mini age / score | Matrice age / score |
|---|---|---|---|
| Propagation only | 171 / 0.33 | 124 / 0.21 | 327 / 0.20 |
| + turbulence | 142 / 0.33 | 72 / 0.21 | 320 / 0.20 |
| + rural bed | 293 / 0.17 | 29 / 0.07 | 56 / 0.05 |
| + bed, wind 2 m/s | 298 / 0.17 | 20 / 0.07 | 38 / 0.05 |
| + bed, wind 6 m/s | 142 / 0.18 | 38 / 0.07 | 22 / 0.05 |
| Turbulence and wind 6 m/s, no bed | 132 / 0.34 | 44 / 0.19 | 97 / 0.10 |

Without the bed, mini and matrice tracks pass the age gate in calm air. Adding the rural bed cuts their scores by
about a factor of 3 to 4 and takes them below the gate, so the bed is the largest single step here. Wind on its own
costs less, though it does take the mini below the gate. The bed's rates and levels are ASSUMED, so this result
depends directly on an assumption. Whether the pink ambient or the events do the damage was not separated. The
harmonic structure of the synthetic source is not the main limit: clean passes clear the gate.

**Not resolved.** Real hover recordings of the same drones are detected at 6 to 8 of 9 mics (section 7), and the real
Mini 3 Pro centre mic (M5) comes out about 10 dB quieter at 1 m than the model assumes (under the ASSUMED x10
calibration: 70 dB against 80 dB). Why +6 dB does so little at the gateway, when the bed costs so much score, is also
open: only the gateway figure was measured, on 25 mini and 34 matrice crossings.

## 3. Gateway rule (step 2)

**Per-node detection range.** On folds 1-3 with the earlier code, the first node onset inside the crossing window
was a median 226 m from the node (90th percentile 485 m) at theta 0.12. Two adjacent nodes 350 m apart both
detect only if the drone is inside about 175 m of each, so the two-node rule needs range well beyond that for many
crossings.

**Adjacent-node onset gaps** (folds 1-3, earlier code, harmonic cap 10; 77 pairs where both nodes detect): median
15 s, 90th percentile 34 s; 84% within 30 s and 99% within 60 s. Only 39% of these pairs agree in f0 within 12%
directly (fundamental 47%, mini 10%, matrice 14%), because one node locks on a second harmonic.

**Rule change.** Window 10 s to 30 s, and f0 may agree directly or an octave apart (`fa.GATE_OCTAVE`). The
window keeps the drone's along-line travel time in range for most crossings. Doc 02 assumed the two nodes agree on
f0 directly; the octave allowance follows from the observed harmonic locks.

**Alternatives (folds 1-3, theta 0.10).** Pd is from the 120 tuning crossings. False alarms are from the 39 node-hour
tuning bed, except the last two rows, which are from the 13 node-hour ablation bed.

| Rule | Gateway Pd < 100 m | Gateway alarms per km-day | Note |
|---|---|---|---|
| Two nodes, 10 s, exact f0 (old) | 0.12 | 0 | 0 events in 39 node-h |
| Two nodes, 30 s, octave f0 (chosen) | 0.19 | 0 | 0 events in 39 node-h |
| One node, its own track (chosen threshold) | 0.68 (node) | about 120-160 | 39 node-alarms per node-day |
| Two nodes, 30 s, no track-age gate | 0.57 | 2,566 | 449 events, 13 node-h |
| Two nodes, 30 s, 1 s track age | 0.45 | 223 | 39 events, 13 node-h |

The single-node rule is the only alternative that would not need the pair, and it fails on false alarms by about
two orders of magnitude. Keeping two nodes is necessary at this node false-alarm rate.

## 4. Threshold tuned on folds 1-3 (step 3)

`uv run sim/perimeter/run.py --tune --crossings 120 --hours 3`: 120 crossings on folds 1-3 (96 below 100 m); bed
folds 1-3, 3 h per node (39 node-hours). Old rule = 10 s, exact f0; new rule = 30 s, octave f0.

| theta | Node Pd < 100 m | Gateway Pd < 100 m, old | Gateway Pd < 100 m, new | Node alarms per node-day | Gateway per km-day, old | Gateway per km-day, new |
|---|---|---|---|---|---|---|
| 0.10 | 0.68 | 0.12 | 0.19 | 51.1 | 0.00 | 0.00 |
| 0.12 | 0.64 | 0.11 | 0.17 | 38.8 | 0.00 | 1.90 |
| 0.14 | 0.62 | 0.05 | 0.12 | 28.3 | 0.00 | 0.00 |
| 0.16 | 0.59 | 0.06 | 0.11 | 22.8 | 0.00 | 1.90 |
| 0.18 | 0.56 | 0.05 | 0.10 | 16.6 | 0.00 | 1.90 |
| 0.20 | 0.54 | 0.05 | 0.08 | 12.3 | 0.00 | 0.00 |
| 0.23 | 0.51 | 0.05 | 0.08 | 9.2 | 0.00 | 0.00 |
| 0.26 | 0.47 | 0.02 | 0.04 | 6.8 | 0.00 | 0.00 |
| 0.30 | 0.40 | 0.00 | 0.02 | 2.5 | 0.00 | 0.00 |

**Choice.** theta 0.10: the highest gateway Pd below 100 m with no gateway event in the tuning bed (point estimate
at or below 1 per km-day). It is the lowest value in the grid; values below 0.10 were not tried. Node alarms rise
quickly as theta falls (51 per node-day at 0.10). The 39 node-hour tuning bed cannot show the target (zero events gives a 95% bound
of 5.7 per km-day), and the choice is a point-estimate choice on folds 1-3 only.

Two earlier exploratory grids (hysteresis times age, and a 3 h bed with the harmonic cap at 10) were run on folds
1-3 and led to the same gateway conclusion; the code was then returned to the settings above.

## 5. Node-to-node across a controller boundary (step 4)

Subsections as in `docs/protocol-v0.md` 3a-1: A = nodes 1-4, B = 5-9, C = 10-13. The boundaries are between nodes 4 and
5 and between 9 and 10. Each adjacent pair where both nodes detect is timed from its later onset.

The timing model is **ASSUMED**, not a network simulation. Event superframe 0.5 s, idle superframe 4 s, a DETECT
airtime of 0.05 s and controller processing of 0.05 s (both ASSUMED), and a backbone superframe 0.5 s with a
38.5 ms message (from doc 3a). Within a cluster, or across a boundary with node-to-node, the second report waits
for its own slot. Across a boundary without node-to-node, it also waits for a backbone slot and forwarding.
The acoustic onset times come from the simulation.

| Mode | Node-to-node | Boundary pairs | Median wait after later onset (s) | Median time from drone entering 400 m (s) | 90th percentile from entry (s) |
|---|---|---|---|---|---|
| Event (0.5 s) | off | 15 | 0.62 | 28.9 | 73.8 |
| Event (0.5 s) | on | 15 | 0.31 | 28.5 | 73.4 |
| Idle (4 s) | off | 15 | 2.26 | 29.8 | 75.2 |
| Idle (4 s) | on | 15 | 2.09 | 29.4 | 74.9 |

All adjacent pairs with both nodes detecting: 78 (held-out). Node-to-node saves about 0.3 s in event mode and about
0.2 s in idle mode at a boundary. The detection onset, about 29 s after the drone enters 400 m, dominates. This
agrees with doc 3b: node-to-node helps in the first seconds and when a controller is lost, not during an event.

**LOCAL_FIX skipped.** The perimeter simulation has no array-node bearing estimator. The array geometry exists only in
the golden renderer.

## 6. Held-out results and false alarms (step 5)

**Crossings, folds 4-5, theta 0.10, 240 crossings** (`uv run sim/perimeter/run.py --part crossings --crossings 240`).

| Class | Altitude | n | Gateway detections | Gateway Pd |
|---|---|---|---|---|
| FPV | below 50 m | 41 | 23 | 0.56 |
| FPV | 50-100 m | 35 | 13 | 0.37 |
| Mini | below 50 m | 24 | 0 | 0.00 |
| Mini | 50-100 m | 38 | 0 | 0.00 |
| Matrice | below 50 m | 26 | 0 | 0.00 |
| Matrice | 50-100 m | 35 | 0 | 0.00 |
| All | below 100 m | 199 | 36 | 0.18 |
| All | 100-120 m | 41 | 2 | 0.05 |

Node-level Pd below 100 m is 0.62. Below 50 m it is 0.69, and at 50-100 m 0.56. Gateway Pd by wind for FPV below 50 m is
0.88, 0.65 and 0.31 at 0-2, 2-5 and 5-8 m/s. Over all 240 crossings, gateway Pd is 0.16 and node Pd 0.59.
These are the numbers the exit criterion (95% below 100 m) is measured against. They are far below it.

**False alarms, folds 4-5, theta 0.10** (`uv run sim/perimeter/run.py --part fa --hours 6 --dense-hours 0.5`):

| Bed | Node-hours | Node alarms | Node alarms per node-day | Gateway alarms | Per km-day | 95% upper bound per km-day |
|---|---|---|---|---|---|---|
| Rural (ASSUMED rates) | 78 (6 h per node) | 112 | 34.5 | 1 | 0.95 | 4.5 |
| Dense stress (50 dB ESC) | 6.5 (0.5 h per node) | 279 | 1,030 | 48 | 549 | (large) |

Rural node alarms by sound class: insects 34, engine 19, chirping birds 17, crickets 12, car horn 9, frog 6, crow 3,
dog 3, and one each for pouring water, church bells, sheep, rooster, hen, cow, vacuum cleaner, cat and airplane.
Insects, birds and engines, which are harmonic or tonal, are the main node false alarms.

**Sizing.** With zero gateway events the 95% upper bound is 3 events over the exposure. For that bound to reach 1 per
km-day the exposure must be 3 x 24 / (1 x 4.2 km) = 17.1 line-hours, which is **223 node-hours**. The rural run covered 78 node-hours (2.9 times short). At the measured
speed (about 58 min for 78 node-hours on 6 workers), 223 node-hours needs roughly 2.8 hours. That is beyond the
two-hour budget, so it was not run. The result is a bound of 4.5 per km-day, not 1.

## 7. Real-audio checks (step 6)

`uv run sim/perimeter/real_checks.py --trials 10` (local recordings from `data/`; aggregate numbers only). These are
**real recordings, not simulated**, except where a line is marked ASSUMED.

**Control (new).** Bed only, no drone, 10 trials of 60 s: the share of trials with any on frame after warm-up is 60%.
The share with an on frame within 5% of a reference f0 is 60% at 88 Hz, 40% at 226 Hz, 60% at 257 Hz and 30% at
124.5 Hz. The bed on its own triggers the detector
often enough that the propagated results below cannot be read as detections.

**1. Direct, centre mic and all nine mics, 10 m hover (DroneNoise, CC BY 4.0).**

| Drone | Mics with any on frame after warm-up | f0 against centre-mic peaks |
|---|---|---|
| Matrice 300 | 6 of 9 (M2, M3, M7 off) | M1 93 Hz, M4 86, M5 88.5, M6 87, M8 84 (peaks 81-92 Hz) |
| Mini 3 Pro | 8 of 9 (M1 off) | M2 218 and M5 229 Hz (peaks 221, 226); M3, M4, M6-M8 near 453 Hz, which is 2x 226 Hz; M9 1,140 Hz |

The f0 result is the harmonic-lock problem in section 3. It is not fixed by the octave match, which only applies at the
gateway.

**2. Centre mic as emitted source (x10 to 1 m, ASSUMED calibration), stationary at 30 m altitude, over the folds 4-5
bed.** Each trial is 60 s. A hit needs an on frame within 5% of the source's own f0. Propagated Pd at 50, 100, 200,
300 and 400 m:

- Matrice 300: 1.0, 1.0, 0.9, 0.8, 0.9
- Mini 3 Pro: 0.9, 0.5, 0.5, 0.3, 0.6

**3. Onboard FPV clip (21.5-33.5 s), 85 dB at 1 m (ASSUMED calibration).** Direct: on for the whole clip, median f0 124.5 Hz.
Propagated: 0.9, 0.9, 0.9, 0.8, 0.8 at 50-400 m.

These propagated Pd values are not evidence of detection: with 10 trials and the bed control at 30-60%, the
numbers at 50-400 m are indistinguishable from the bed. The first run of these checks counted any on frame as a
detection and gave 1.0 at every range; that was a bug, found in the bed control, and is corrected here.

Runtime: 13.5 min wall with other jobs running. Peak RSS 362 MB.

## 8. What is real, what is ASSUMED, what is unproven

- **Real:** the DroneNoise hover recordings (section 7, part 1); the onboard FPV clip; the ESC-50 background clips
  (CC BY-NC 3.0, local use only; no audio is in the repo).
- **ASSUMED:** the source levels (85 / 80 / 80 dB at 1 m) and the DroneNoise calibration (x10); the rural event rates,
  levels and ambient; the wind model; the turbulence; the node-to-node timing (section 5); the classes' blade-pass
  frequencies and rotor wobble.
- **Unproven:** that any node or gateway setting reaches 95% Pd below 100 m; that the rural false-alarm rate is below
  1 per km per day (the bound is 4.5 on 78 node-hours); that the synthetic mini and matrice behave like the real
  drones at range; the octave and 30 s gateway rule on real multi-node data; the node-to-node gain in a live
  network.

## 9. Reproduce

```
uv run sim/perimeter/run.py --quick                       # about 2 min
uv run sim/perimeter/run.py --tune --crossings 120 --hours 3     # folds 1-3, about 30 min
uv run sim/perimeter/run.py --ablate --crossings 120 --hours 1   # folds 1-3, 43 min with another job running
uv run sim/perimeter/run.py --part crossings --crossings 240     # folds 4-5, about 30 min
uv run sim/perimeter/run.py --part fa --hours 6 --dense-hours 0.5  # folds 4-5, about 60 min
uv run sim/perimeter/real_checks.py --trials 10                  # about 14 min
```

Two runs of `--part crossings` and `--part fa` ran at the same time, so the times are with contention on a
32-core machine.

## Sources

- Harmonic comb design (10 harmonics, 80-1000 Hz): [`docs/research/04-hardware-boundaries.md`](04-hardware-boundaries.md).
- Information budget and gateway timing: [`docs/research/02-information-budget.md`](02-information-budget.md).
- Real hover spectra and harmonic lines: [`docs/research/03-real-hover-audio.md`](03-real-hover-audio.md).
- Subsections and node-to-node: [`docs/protocol-v0.md`](../protocol-v0.md) sections 3a and 3b.
- DroneNoise dataset, University of Salford, CC BY 4.0. ESC-50, CC BY-NC 3.0 (local use only).
