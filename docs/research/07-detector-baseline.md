# Research 07 — Detector baseline: why the perimeter misses drones, and what the false-alarm rate can and cannot show

Date: 2026-11-05

Scripts: [`sim/perimeter/run.py`](../../sim/perimeter/run.py) (`--tune`, `--ablate`, and the held-out run with
`--part crossings` and `--part fa`), [`sim/perimeter/real_checks.py`](../../sim/perimeter/real_checks.py),
detector [`sim/detector/detector.py`](../../sim/detector/detector.py), gateway rule
[`sim/perimeter/fa.py`](../../sim/perimeter/fa.py). Tests: `sim/tests/test_gateway.py`.

**Question.** Does the 13-node perimeter meet the Phase 1 exit criteria: at least 95% of crossings detected below
100 m altitude, and at most 1 false alarm per km of perimeter per day? If not, what is the best trade-off, and how
far off is it?

**Short answer: no.** The exit criteria are not met. Round 3 (section 11, 2026-11-05) changes the picture on the
false-alarm side and not on the Pd side. A 8192-sample frame (512 ms window, 256 ms hop) with a slower floor rise
(F2) gives 0 gateway false alarms in 223 node-hours on the rural bed (bound 1.00 per km-day, meeting the target at 95 %),
and raises gateway Pd below 100 m on a new draw from 0.10 to 0.29. But gateway Pd is still far below 95 %. The gain
is almost all FPV: mini and matrice gateway Pd below 100 m stays at 0 on folds 1-3 at every frame length and threshold,
and on the new draw it is 0.13 and 0.00. The dense stress bed gives 7 times more gateway alarms with F2 than with the
round-2 setting. F2 is kept as the rural candidate and is not made the default (section 11.6).

## Answers in brief

00. **Round 4 (section 12, 2026-11-06).** A bug: sub-harmonic takeover fired whenever a track's own score was 0, moving the
   track to a sub-harmonic where it then lost its hits. On a new draw (folds 4-5 clips, 191 crossings below 100 m), a guard
   (`sub_guard`) raises gateway Pd from 0.15 to 0.23, all of it FPV (0.47 to 0.71). Mini and matrice stay at 0. Rural gateway alarms
   are unchanged at 5 and 5 in 223 node-hours (1.67 per km-day, bound 3.5), and node alarms rise 61 %. It meets the bar set beforehand.
   It is not yet the default, and the targets are still not met.

0. **Round 3 (section 11, 2026-11-05).** Frame length, neighbour matching, floor and gate retests, and a new draw, all
   run in this round with the current code. Longer frames raise line SNR
   for mini and matrice under the pink ambient (matrice node Pd under pink 0.25 at 1024 samples, 1.00 at 2048; mini 0.22,
   0.67, 0.94, 0.97 at 1024, 2048, 4096, 8192). The gain stops at 4096 for mini and at 2048 for matrice; FPV's line
   score at the true f0 collapses at 8192. Node alarm rates differ between rows, so this is not an exact match. 8192 at 0.23 (30 node alarms per node-day) gives node Pd
0.81 and gateway Pd 0.35, against 0.68 and 0.19 for 1024 at 0.10 (51 per node-day) (folds 1-3, 39 node-hours). The mini and matrice gateway stays at 0. Harmonic-line matching (small-integer ratios backed by two shared harmonics,
   17 bits per report) changes nothing at the operating point, so it is not adopted. Slower floor rise (0.05 per 32 ms)
   at 8192 raises gateway Pd from 0.35 to 0.41 and cuts node alarms from 49 to 40 in the tuning bed; gate_harm 2 adds
   node alarms (92). New draw (folds 4-5, seeds 12012 onward; clip reuse not checked): F2 gateway Pd below 100 m 0.29 against
   0.10 for the round-2 setting on the same draw; rural false alarms 0 in 223 node-hours for F2 (bound 1.00 per km-day)
   and 0 in 78 node-hours for the round-2 setting (bound 2.85). Dense stress bed: 2880 per km-day for F2 against 411
   for round 2. Targets are not met.

1. **Held-out result (folds 4-5, chosen setting, theta 0.10).** Gateway Pd below 100 m is **18%** (36 of 199
   crossings); node-level Pd below 100 m is **62%**. The 95% target is not close. Pd falls with wind for FPV
   (below 50 m: 88% at 0-2 m/s, 31% at 5-8 m/s). Mini and matrice were **never** detected at the gateway below
   100 m (0 of 62 and 0 of 61); FPV was detected in 36 of 76.
2. **Cause of the node misses: the 2-second track-age gate (round 1), and for mini and matrice the pink ambient
   (round 2, section 10.1).** Round 2 splits the rural bed: pink ambient alone takes mini and matrice node Pd from
   about 1.0 to 0.2-0.25 at the ASSUMED 40 dB SPL; events alone have no measurable effect. The effect is steep in the
   ambient level (30 dB: node Pd 0.78 and 0.94; 50 dB: 0.03 and 0.00). Removing the age gate in round 1 raised node Pd
   below 100 m from 0.68 to 0.95 and gateway Pd from 0.19 to 0.57 (folds 1-3). The other rejection steps (harmonicity, good-frac, impulse)
   change Pd by 0.05 or less. Removing the gate does not reach the target either: gateway Pd stops at 0.57. A
   +6 dB source level on mini and matrice moves their gateway Pd only from 0 to 0.04 (folds 1-3, small samples).
   Round 2 answer (section 10.3): +6 dB raises node Pd (mini 0.28 to 0.50; matrice 0.22 to 0.47 in the layer test)
   but a gateway pair needs both nodes and an f0 match, and most both-detect pairs fail the f0 match. Doppler does not
   explain those pairs.
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
6. **Round 2 detector trials (folds 1-3, 13 node-hours).** Gap-tolerant age, lower theta, floor gate 3 dB, slower
   floor rise, start-up cap, and fundamental-or-second-harmonic gate: none raises gateway Pd without a large
   false-alarm cost (table in section 10.4). Fresh held-out (new seeds, folds 4-5 clips): gateway Pd below 100 m 0.16
   (31 of 196); rural false alarms 1.9 per km-day on 78 node-hours (95% upper bound 6.0). Round 1 held-out: 0.95 (bound
   4.5). Pooled 156 node-hours: 1.4 per km-day (bound 3.7). Targets not met.
7. **Node-to-node across the A|B boundary (ASSUMED timing model).** Median wait after the later onset falls from
   0.62 s to 0.31 s in event mode, and from 2.26 s to 2.09 s in idle mode (15 boundary pairs). Measured from the
   drone entering 400 m, both are about 29 s, so detection dominates and the network step is small.
8. **Real-audio checks.** Direct DroneNoise clips: Matrice on at 6 of 9 mics, Mini 3 Pro on at 8 of 9. The Mini's
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
  0 to 0 (n = 34), FPV 0.49 (n = 37). Level does limit node detection, and section 10 measures that; at the gateway
  the f0 match limits it as well, which is why this gateway figure moves so little.

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

## 10. Round 2, 2026-11-05: bed split, ambient check, source level, detector trials, fresh held-out

Scope as set in the round-2 brief. Everything below is measured with the scripts named here; ASSUMED values are tagged.
The detector's default settings did not change. Every new detector option defaults to the baseline behaviour, and the
baseline reproduces the section 4 numbers (theta 0.10 on folds 1-3: node Pd 0.68, gateway Pd 0.19).

### 10.1 Which part of the rural bed does the damage (step 1)

`uv run sim/perimeter/bed_layers.py --passes 4`: one node, one pass per row, 9 geometries (altitude 20, 50 or 90 m by
speed 5, 15 or 25 m/s), 4 passes each, so 36 node-passes per row per class. Folds 1-3 only (the diagnosis folds).
Crossing offset from the node is one of -150, -50, 50 or 150 m, seeded per pass. Measured within 300 m of the node.
Pink ambient (ASSUMED 40 dB SPL, band 100 Hz to 4 kHz) and events (rural scene draws, with the ambient switched off)
are separate layers. The "full" row is pink + events + 2 m/s wind, as in the round-1 rural bed.

| Class | Row | Median max track age (gate 62) | Node Pd | Frames on | Median best comb (theta 0.10) | Comb at true f0 | Line-to-floor, dB | Floor rise at harmonics, dB |
|---|---|---|---|---|---|---|---|---|
| FPV | propagation only | 435 | 1.00 | 0.99 | 0.636 | 0.197 | 18.5 | 1.85 |
| FPV | + turbulence | 329 | 1.00 | 0.96 | 0.658 | 0.215 | 18.3 | 2.50 |
| FPV | + pink | 276 | 0.89 | 0.70 | 0.272 | 0.000 | 6.6 | 0.87 |
| FPV | + events | 332 | 1.00 | 0.96 | 0.652 | 0.215 | 18.3 | 2.59 |
| FPV | + pink + events + wind | 280 | 0.83 | 0.63 | 0.274 | 0.000 | 6.6 | 0.75 |
| FPV | wind only | 490 | 1.00 | 0.99 | 0.651 | 0.237 | 17.5 | 2.25 |
| Mini | propagation only | 190 | 0.97 | 0.71 | 0.373 | 0.141 | 12.7 | 2.10 |
| Mini | + turbulence | 184 | 1.00 | 0.81 | 0.388 | 0.146 | 13.2 | 2.62 |
| Mini | + pink | 28 | 0.22 | 0.09 | 0.104 | 0.000 | 4.2 | 0.91 |
| Mini | + events | 210 | 0.97 | 0.80 | 0.390 | 0.141 | 12.6 | 2.62 |
| Mini | + pink + events | 32 | 0.31 | 0.15 | 0.104 | 0.000 | 4.2 | 0.89 |
| Mini | + pink + events + wind | 36 | 0.28 | 0.13 | 0.114 | 0.000 | 4.2 | 0.86 |
| Mini | wind only | 168 | 0.97 | 0.84 | 0.375 | 0.000 | 10.7 | 2.60 |
| Matrice | propagation only | 309 | 1.00 | 0.91 | 0.254 | 0.186 | 7.5 | 2.42 |
| Matrice | + turbulence | 493 | 1.00 | 0.94 | 0.279 | 0.207 | 10.2 | 3.18 |
| Matrice | + pink | 30 | 0.25 | 0.13 | 0.105 | 0.051 | 3.8 | 0.70 |
| Matrice | + events | 490 | 1.00 | 0.93 | 0.279 | 0.197 | 9.5 | 3.12 |
| Matrice | + pink + events | 36 | 0.31 | 0.15 | 0.106 | 0.051 | 3.9 | 0.78 |
| Matrice | + pink + events + wind | 20 | 0.22 | 0.10 | 0.091 | 0.000 | 3.5 | 1.02 |
| Matrice | wind only | 144 | 0.86 | 0.58 | 0.189 | 0.000 | 5.4 | 2.85 |

Node Pd is the share of passes with the track on at any time within 300 m. "Comb at true f0" and "line-to-floor" use
the class's blade-pass frequency from the simulation, as a diagnostic only; the detector never sees it.

Reading the table:

- **Pink ambient is the damage. Events are not.** Events alone change nothing measurable for any class (node Pd within
  0.03 of turbulence alone). Pink alone takes mini and matrice node Pd from about 1.0 to 0.2-0.25 and drops the median
  best score to the threshold (0.10). FPV falls less (node Pd 0.89) because its best score stays at 2.7 times the
  threshold.
- **Wind costs less.** Wind alone keeps mini node Pd at 0.97 and matrice at 0.86 (on 0.58), so it is not the main
  cause.
- **Why pink.** Pink noise falls with frequency (about -3 dB per octave), so its noise is strongest in the bins at the
  mini and matrice fundamentals (250 and 100 Hz). The comb's fundamental gate (`GATE_LOG`: the fundamental must stand
  3 dB above its flanks) then zeroes the score at the true f0 in most frames (the median comb at the true f0 is 0.000
  with pink). The score that survives sits at the threshold. The line-to-floor ratio falls by 6 to 12 dB in every
  class. FPV loses the most in dB and still survives, so the class differences appear to follow the margin over the
  threshold rather than the line-to-floor ratio alone.
- **The floor tracker does not absorb more under pink.** The floor rise at the harmonic bins is 0.7 to 0.9 dB with
  pink and 1.9 to 3.2 dB without it. Without a bed the tracker does absorb a few dB of line (rows "propagation only" and
  "+ turbulence"), but pink does not make that worse. Pink sets the floor; the tracker is not the cause.
- **The result depends on the ASSUMED 40 dB.** Same layer test, pink ambient alone (`--ambient-db`, mini and matrice,
  36 node-passes per cell):

| Pink ambient (ASSUMED) | Mini node Pd | Mini median age | Matrice node Pd | Matrice median age |
|---|---|---|---|---|
| none (turbulence only) | 1.00 | 184 | 1.00 | 493 |
| 30 dB SPL | 0.78 | 87 | 0.94 | 181 |
| 40 dB SPL (assumed, used everywhere else) | 0.22 | 28 | 0.25 | 30 |
| 50 dB SPL | 0.03 | 8 | 0.00 | 9 |

  Across this range node Pd falls from about 0.9 to about 0 for a 10 dB change in the bed. The rural bed's cost is
  almost entirely inside that range, so the bed's level has to be measured before the cost can be trusted. Section
  10.2 explains why the level was not changed.

### 10.2 The ambient assumption against local data (step 2)

`uv run sim/perimeter/ambient_check.py`. Outdoor ESC-50 clips in `data/backgrounds/esc50` (1,240 clips, all five folds;
CC BY-NC 3.0, local use only; numbers only, no audio in the repo).

| Quantity | Result |
|---|---|
| Quietest 2 s band level (100 Hz to 4 kHz), dBFS | median -28.3; 10th to 90th percentile -68.2 to -16.6 |
| Loudest 2 s band level, dBFS | median -20.4 |
| Quiet-to-loud range, dB | median 4.4; 10th to 90th percentile 0.9 to 43.7 |
| Spectral slope of the quietest 2 s, dB per octave | median -4.08; 10th to 90th percentile -8.6 to +0.25 (pink -3.0) |
| Share of quiet sections in the pink range (-4.5 to -1.5 dB/oct) | 0.28 |

What this supports and does not:

- **The absolute level is not tested.** The clips are normalised and carry no calibration, so dBFS cannot be turned into
  dB SPL. No local file gives a calibrated ambient, so the 40 dB SPL (ASSUMED) is neither confirmed nor refuted. The only
  calibrated-looking material, the DroneNoise hover recordings, depends on the ASSUMED x10 factor (section 7).
- **The spectral shape is steeper than the sim's pink.** The median quiet section falls about -4 dB per octave, against
  -3 for the sim's pink, with a wide spread. For a fixed total level, a steeper slope puts more relative energy at
  100 to 300 Hz, where the mini and matrice fundamentals sit. If the total is right, the sim's pink under-weights the
  low band, so the sim may be optimistic about mini and matrice. This is a shape argument from ESC-50 quiet sections
  (which include wind and traffic rumble), not a measurement of rural ambient.
- **The quiet-to-loud ratio does not test the event levels.** The sim puts events 10 to 14 dB above the ambient at 20 m
  and 10 dB below it at 300 m (ASSUMED). The clips show a median loud-to-quiet range of 4.4 dB, but ESC-50 clips are not
  recordings of events at fixed distances, so this does not settle the event-to-ambient ratio either.
- **Decision.** The ambient is not changed. Nothing in the data justifies a new level, and the sensitivity in section 10.1
  is larger than any change the data could support. Results are reported at the assumed 40 dB, with the 30 and 50 dB
  sensitivity above.

### 10.3 Why +6 dB barely moved gateway Pd (step 3)

`uv run sim/perimeter/level_check.py --crossings 40` and `uv run sim/perimeter/pair_check.py --crossings 40`.
Crossings below 100 m, folds 1-3 bed, theta 0.10, the 30 s octave gateway rule, with the same bed and crossing sample at
each level (paired). The source level is raised by scaling the emitted signal (`gain_db` in `run.py`), so the rotor speed
and the Doppler are unchanged. Levels are ASSUMED; only the change is meaningful.

| Class | Measure | 0 dB | +6 dB | +12 dB |
|---|---|---|---|---|
| Mini | node Pd, crossings (n = 40) | 0.57 | 0.72 | 0.95 |
| Mini | gateway Pd, crossings (n = 40) | 0.00 | 0.05 | 0.20 |
| Mini | node Pd, layer test (n = 36) | 0.28 | 0.50 | 0.81 |
| Mini | median best comb, layer test | 0.114 | 0.185 | 0.337 |
| Matrice | node Pd, crossings (n = 40) | 0.35 | 0.75 | 0.93 |
| Matrice | gateway Pd, crossings (n = 40) | 0.00 | 0.05 | 0.07 |
| Matrice | node Pd, layer test (n = 36) | 0.22 | 0.47 | 0.94 |
| Matrice | median best comb, layer test | 0.091 | 0.119 | 0.176 |

A gateway pair needs both adjacent nodes to detect inside the 30 s window and their f0 estimates to agree. A separate
pair-level run (new crossings, seed 6060, 40 per class; `pair_check.py`) classifies every both-detect pair (first
in-window onset of node i with an in-window onset of node i+1):

| Class and level | Gateway detected (of 40) | Both-detect pairs | Within 30 s | f0 rule passed | Both rules | f0 ratio 'other' | 'other' explained by Doppler |
|---|---|---|---|---|---|---|---|
| Mini 0 dB | 1 | 6 | 2 | 1 | 1 | 4 | 0 |
| Mini +12 dB | 6 | 32 | 25 | 10 | 8 | 17 | 0 |
| Matrice 0 dB | 0 | 4 | 0 | 0 | 0 | 4 | 0 |
| Matrice +12 dB | 10 | 16 | 14 | 10 | 10 | 4 | 0 |

Answer. +6 dB does raise node Pd, by 0.2 to 0.3 at the crossing level, but the gateway needs a pair. At +6 dB node Pd is
0.5 to 0.75, so if the two nodes were independent both would detect in about a quarter to a half of crossings, and only
about a third of both-detect pairs agree in f0. The gateway therefore moves from 0 to about 0.05. At +12 dB most mini
pairs fail the f0 test on ratios outside the octave allowance (the rule allows 1, 1/2 and 2; 3/2, 2/3 and 3 fail).
Doppler was the first candidate: nodes on either side of a 25 m/s pass see a ratio up to about 1.15, which exceeds the
12 % tolerance. It explains none of the 'other' pairs (ASSUMED straight-line motion from `track_of`). So the 'other' pairs
are harmonic or other locks, not Doppler. The two matrice gateway counts at +12 dB differ between the runs (3 of 40 in
`level_check`, 10 of 40 in `pair_check`) because the crossing samples differ. That spread is about the binomial spread at
n = 40 (SE about 0.06). The f0 match is the remaining lever. It was not changed here, because loosening it would also let
in more false pairs and needs its own false-alarm test.

### 10.4 Detector trials on folds 1-3 (step 4)

`uv run sim/perimeter/trials.py --group <name> --hours 1.0 --crossings 120`. Each group shares one comb, so variants in a
group share one crossing run and one false-alarm run. Crossings: 120 (seed 2026, the tuning sample), 96 below 100 m.
False alarms: the rural bed on folds 1-3, 1 h per node, 13 node-hours (the same bed for every row). Node alarms are counted
per node-day from 13 node-hours. A count of 21 is noisy (95% interval about 13 to 32), so differences of 10 to 20 % in
that column are not meaningful. Gateway events are rare at this size and are shown for completeness only.

| Change (one at a time) | Node Pd < 100 m | Gateway Pd < 100 m | Node alarms per node-day (count) | Gateway events | Kept |
|---|---|---|---|---|---|
| Baseline, theta 0.10 | 0.68 | 0.19 | 38.8 (21) | 0 | (frozen) |
| theta 0.09 (below the old grid edge) | 0.70 | 0.18 | 55.4 | 2 | no |
| theta 0.08 | 0.70 | 0.18 | 59.1 | 2 | no |
| Track gap tolerance, 1 s (`gap_frames` = 31) | 0.69 | 0.19 | 42.5 | 1 | no |
| Track gap tolerance, 2 s (`gap_frames` = 62) | 0.69 | 0.19 | 42.5 | 1 | no |
| Floor gate 3 dB instead of 6 (`floor_gate_db`) | 0.77 | 0.34 | 236.3 | 11 | no |
| Floor rise 0.05 dB per frame instead of 0.1 (`floor_up_db`) | 0.66 | 0.27 | 94.2 | 0 | no |
| Start-up floor capped at the local median, +-16 bins (`init_env_bins`) | 0.67 | 0.16 | 51.7 | 1 | no |
| Fundamental or second harmonic may pass the 3 dB gate (`gate_harm` = 2) | 0.77 | 0.25 | 81.2 | 0 | no |

Keep rule: a change is kept only if gateway Pd rises without a clear rise in node alarms. None did. The gap, theta and
start-up changes give no Pd gain. The floor and gate changes buy gateway Pd (0.25 to 0.34) with a 2 to 6 times rise in
node alarms, which is the wrong direction for a false-alarm target. The start-up cap is bounded and unit-tested, but the
scenario never starts a node with a drone already sounding (the warm-up is 10 s before the drone enters the window), so
its row here does not test the fix.

Tests added for the new options (`sim/tests/test_detector.py`): gap tolerance keeps the age across a short dropout and
restarts it after a longer one (the baseline restarts after 25 frames); the start-up cap keeps a line present at start-up
out of the floor; the second-harmonic gate passes a buried fundamental only when `gate_harm` = 2. Their per-frame cost
(a few operations, and one start-up pass) was not costed against doc 04, because no change was kept.

Tuned on folds 1-3 only: the trial rows above. Folds 4-5 were not used for any of them (the held-out and fresh runs used
the frozen baseline).

### 10.5 Fresh held-out run (step 5)

Frozen before the run: theta 0.10 and the baseline detector (every new option off). No change met the keep rule, so the
223 node-hour false-alarm run was not started, and the existing 78 node-hours were run with fresh seeds, as the brief
allowed.

Freshness. New and never used before: crossing seeds (5050), background master seed (8888), rural false-alarm seeds
(8000) and dense stress seeds (9000). **Not fresh:** the ESC-50 clips. Folds 4-5 clips were used in round 1, and ESC-50 has
only five folds, so the clip pool is the same. The event draws, their placement and the mixing are new. This is a second
run on folds 4-5 clips with new draws, not a clean held-out set. Folds 4-5 are a repeated test set.

| Set | Crossings below 100 m | Gateway Pd < 100 m | Node Pd < 100 m | Rural node-hours | Rural gateway events | Rural per km-day | 95% upper bound per km-day |
|---|---|---|---|---|---|---|---|
| Folds 4-5, round 1 (repeated test set) | 199 | 0.18 (36) | 0.62 | 78 | 1 | 0.95 | 4.5 |
| Folds 4-5, fresh draws (this run) | 196 | 0.16 (31) | 0.51 | 78 | 2 | 1.9 | 6.0 |
| Both runs pooled | 395 | 0.17 (67) | 0.56 | 156 | 3 | 1.4 | 3.7 |

Clopper-Pearson 95% intervals: fresh gateway Pd 0.11 to 0.22; fresh node Pd 0.43 to 0.58. Rural node alarms: 34.5 per
node-day in round 1 and 38.8 per node-day fresh. Fresh dense stress bed (0.5 h per node, 6.5 node-hours): 27 gateway
events, 309 per km-day. The zero-event bound for <= 1 per km-day needs 223 node-hours (not run).

Fresh gateway Pd below 100 m by class: FPV 30 of 60 (0.50); mini 1 of 65; matrice 0 of 71. (From the per-cell table
printed by `run.py`; the per-cell table is not stored in the JSON.) Node Pd below 100 m: 0.65 below 50 m and 0.40 at
50-100 m. Latency across a controller boundary (ASSUMED timing model): event mode median wait after the later onset 0.74 s
without node-to-node and 0.35 s with it; idle mode 2.87 s and 2.45 s.

### 10.6 Resources, reproduction, logs

- Peak memory measured: 808 MB for the layer test (6 workers, `/usr/bin/time -v`) and 660 MB for the fresh held-out run
  (parent process). The other jobs were not timed with `time -v`. The 3 GB address-space limit (`RLIMIT_AS`) is set only
  in the false-alarm pool (`fa.py`, round 1). The crossing, layer and pair pools (`run.py`, `bed_layers.py`,
  `level_check.py`, `pair_check.py`, `trials.py`) have no limit in the code, and no job ran more than 6 worker processes
  at once. Those pools were not measured with a limit set, so their memory is not separately guaranteed.
- Wall time: layer test 19 min (756 node-passes); level check 15 min; pair check 7 min (run twice); detector trials 10 to
  15 min per group; ambient sensitivity 4 min per level; fresh held-out 49.5 min; ambient check under 1 min.
- Reproduce: `uv run sim/perimeter/bed_layers.py --passes 4 --json <path>`;
  `uv run sim/perimeter/bed_layers.py --passes 4 --ambient-db 30 --classes mini,matrice --rows "+ pink|+ pink + events"`
  (and `--ambient-db 50`); `uv run sim/perimeter/ambient_check.py`; `uv run sim/perimeter/level_check.py --crossings 40`;
  `uv run sim/perimeter/pair_check.py --crossings 40`;
  `uv run sim/perimeter/trials.py --group track|floor-gate3|floor-up05|startup-cap16|gate2 --hours 1.0 --crossings 120`;
  `uv run sim/perimeter/run.py --seeds fresh --crossings 240 --hours 6 --dense-hours 0.5`.
- Logs are outside the repo, in the session scratch directory: `bed_layers_full.log`, `amb_30.log`, `amb_50.log`,
  `level_check.log`, `pair_check.log` and `pair_check2.log` (the second is the Doppler version), `trial_*.log`, and
  `fresh_heldout.log`, with JSON results beside them.
- Tests: `uv run --with pytest --with numpy --with scipy pytest sim/tests`: 20 passed (17 before round 2, plus 3 for gap
  tolerance, start-up cap and second-harmonic gate). `npm --prefix web test`: 76 passed, 1 skipped.

### 10.7 What is ASSUMED, and what remains unproven

- ASSUMED and not measured: the pink ambient level (40 dB SPL) and its spectrum; the source levels; the rural event rates;
  the straight-line motion behind the Doppler check.
- Found this round: the rural result depends on the ambient level within about 10 dB. The local data cannot set that level,
  and its quiet sections are steeper than the sim's pink.
- Not resolved: the f0 agreement of node pairs, which limits the gateway at higher source levels (harmonic locks, not
  Doppler); whether the fundamental gate is the right place to fix mini and matrice; real multi-node data for the pair
  rule; whether any detector change can reach the Pd target without the false-alarm cost seen here.
- Still unproven: the 95% Pd target; the <= 1 per km-day false-alarm target (the best measured bound is 3.7 on pooled
  156 node-hours; 223 node-hours with zero events would be needed); the rural bed as a model of a real site.

## 11. Round 3, 2026-11-05: frame length, neighbour matching, retests, new draw

Scope as set in the round-3 brief. Every number below comes from a log or JSON file written by the runs named here, in
`/home/ben/.cache/sonicmesh/round3/` (paths in 11.8). The round-2 defaults are unchanged: `Params()` is still 1024 samples,
hop 512, theta 0.16, and `run.py`'s `CHOSEN` is theta 0.10. The unit tests pass (27, `sim/tests`). The default detector was
checked against the round-2 detector (`HEAD` version, saved as `detector_round2.py`) on four parameter sets, and all four
outputs were identical. Earlier runs of these settings, if any, are not compared here; this section reports only the runs
listed in 11.8.

### 11.1 Frame length (step 1)

**Conversion.** The frame is a parameter (`Params.n_fft`, `Params.hop`). Time constants in `Params` are in baseline hops
of 512 samples (32 ms), and `to_frames()` converts them to the frame in use. Values read from `to_frames()` in this run:

| Setting | 1024 / 512 | 2048 / 1024 | 4096 / 2048 | 8192 / 4096 |
|---|---|---|---|---|
| age_min | 62 | 31 | 16 | 8 |
| hold_frames | 32 | 16 | 8 | 4 |
| m_win | 16 | 8 | 4 | 2 |
| k_on | 6 | 3 | 2 | 1 |
| impulse_hold | 4 | 2 | 1 | **0** |
| ref_frames | 31 | 16 | 8 | 4 |
| start-up frames (init_frames) | 8 | 4 | 3 | 3 |
| smooth | 0.75 | 0.5625 | 0.316 | 0.100 |
| floor_up_db (per frame) | 0.10 | 0.20 | 0.40 | 0.80 |
| floor_down_db (per frame) | 0.50 | 1.00 | 2.00 | 4.00 |
| gap_frames | 0 | 0 | 0 | 0 |
| init_env_bins | 0 | 0 | 0 | 0 |

The comb bin widths, the 3 % comb tolerance, the 80 Hz to 4 kHz range and the 0.5 % f0 grid were not re-checked in this run.

**Known defect in the conversion (found after the freeze, not fixed).** The impulse hold is 4 baseline hops (128 ms). At
8192 samples it converts to 0 frames (0.5 rounds to 0), so the impulse hold is switched off at 8192; the 4096 setting gives
1 frame. The frozen F2 setting therefore has no impulse hold. It is not changed, because F2 was frozen and scored on the new
draw, and a fix would be a second look. A one-frame exploration on folds 1-3 is in 11.7.

Checks: the converted settings for 2048 are unit-tested (`test_to_frames_keeps_time_constants_in_seconds`), and so is the
geometry (`test_geometry_bins_and_track_step_follow_the_frame`). Both pass in this run.

**Layer test (line SNR and comb score by frame).** `bed_layers.py --passes 4`, folds 1-3, 756 node-passes per frame length
(from the log). Medians within 300 m of the node. `line` is the line-to-floor ratio (dB) at the true harmonics 1-4
(diagnostic only, not seen by the detector), `comb@bpf` the comb score at the true fundamental (diagnostic).

| Class | Row | 1024: node / comb / comb@bpf / line dB | 2048 | 4096 | 8192 |
|---|---|---|---|---|---|
| FPV | prop only | 1.00 / 0.636 / 0.197 / 18.5 | 1.00 / 0.733 / 0.072 / 20.2 | 1.00 / 0.750 / 0.261 / 24.3 | 1.00 / 0.716 / 0.000 / 30.3 |
| FPV | + pink | 0.89 / 0.272 / 0.000 / 6.6 | 1.00 / 0.347 / 0.000 / 10.0 | 1.00 / 0.406 / 0.041 / 13.8 | 1.00 / 0.432 / 0.000 / 22.1 |
| Mini | prop only | 0.97 / 0.373 / 0.141 / 12.7 | 1.00 / 0.490 / 0.256 / 18.0 | 1.00 / 0.535 / 0.276 / 23.4 | 1.00 / 0.531 / 0.260 / 29.7 |
| Mini | + pink | 0.22 / 0.104 / 0.000 / 4.2 | 0.67 / 0.167 / 0.000 / 7.2 | 0.94 / 0.205 / 0.094 / 12.3 | 0.97 / 0.209 / 0.103 / 19.8 |
| Mini | + pink + events + wind 2 | 0.28 / 0.114 / 0.000 / 4.2 | 0.97 / 0.180 / 0.000 / 6.7 | 1.00 / 0.214 / 0.062 / 12.1 | 1.00 / 0.214 / 0.070 / 21.1 |
| Matrice | prop only | 1.00 / 0.254 / 0.186 / 7.5 | 1.00 / 0.530 / 0.364 / 19.6 | 1.00 / 0.664 / 0.433 / 23.8 | 1.00 / 0.735 / 0.427 / 32.1 |
| Matrice | + pink | 0.25 / 0.105 / 0.051 / 3.8 | 1.00 / 0.172 / 0.109 / 8.1 | 1.00 / 0.229 / 0.166 / 13.1 | 1.00 / 0.254 / 0.186 / 22.0 |
| Matrice | + pink + events + wind 2 | 0.22 / 0.091 / 0.000 / 3.5 | 0.86 / 0.162 / 0.095 / 6.9 | 1.00 / 0.195 / 0.095 / 11.9 | 1.00 / 0.195 / 0.100 / 20.2 |

Reading: under the ASSUMED 40 dB pink bed, mini and matrice node detection recovers with frame length (mini 0.22 to 0.97,
matrice 0.25 to 1.00 at 8192). The line-to-floor ratio keeps rising with frame length, but the median comb score rises
only slowly beyond 2048 for mini (0.167 to 0.209), and matrice keeps rising to 8192 (0.172 to 0.254), so the gain is
mainly for mini between 2048 and 4096. FPV is the
other way round: its comb score at the true fundamental collapses to zero at 8192 (its 2 % rotor wobble, about 12 Hz rms, is
probably wider than the comb window and flanks at that bin width; this reason is ASSUMED, not tested), while its node Pd stays 1.00 through the other candidates.
The layer test takes the max over harmonics 1-4 and does not give a per-harmonic breakdown. Per-harmonic limits were
not measured.

**Tuning sweep (folds 1-3, 120 crossings seed 2026, rural bed 3 h per node = 39 node-h, bed seed 6000).** Rule: round-2
(30 s, f0 within 12 % direct or octave). Theta chosen by the round-2 rule: the highest gateway Pd below 100 m with no gateway
event in the bed.

| Frame | theta | Node Pd < 100 m | Gateway Pd < 100 m | Node alarms per node-day (count) | Gateway events |
|---|---|---|---|---|---|
| 1024 / 512 | 0.10 | 0.68 | 0.19 | 51.1 (83) | 0 |
| 2048 / 1024 | 0.10 | 0.89 | 0.24 | 288.6 (469) | 207 |
| 2048 / 1024 | 0.23 | 0.66 | 0.22 | 44.3 (72) | 0 |
| 4096 / 2048 | 0.10 | 0.98 | 0.43 | 288.0 (468) | 249 |
| 4096 / 2048 | 0.23 | 0.76 | 0.31 | 48.6 (79) | 0 |
| 8192 / 4096 | 0.10 | 0.97 | 0.26 | 299.1 (486) | 112 |
| 8192 / 4096 | 0.23 | 0.81 | 0.35 | 30.2 (49) | 0 |
| 8192 / 4096 | 0.26 | 0.75 | 0.34 | 20.9 (34) | 0 |

Node alarm rates differ between rows, so the comparisons are not exact matches. 8192 at 0.23 (30 node alarms per node-day)
gives node Pd 0.81 and gateway Pd 0.35. 1024 at 0.10 (51 per node-day) gives 0.68 and 0.19. 1024 at 0.18 (17 per node-day)
gives 0.56 and 0.10, and 8192 at 0.26 (21 per node-day) gives 0.75 and 0.34. At these rates the 8192 frame gives higher node
and gateway Pd. The 2048 and 4096 rows at low theta produce gateway events (207 and 249 at theta 0.10) in a bed with no bound
on them, so they are not usable operating points.

**Per class (same sweep, seed 6000).** Gateway Pd is FPV only at every frame length:

| Frame, theta | FPV node / gateway (n = 37) | Mini node / gateway (n = 25) | Matrice node / gateway (n = 34) |
|---|---|---|---|
| 1024, 0.10 | 0.92 / 0.49 | 0.48 / 0.00 | 0.56 / 0.00 |
| 8192, 0.23 | 1.00 / 0.92 | 0.80 / 0.00 | 0.62 / 0.00 |
| 8192, 0.26 | 1.00 / 0.89 | 0.72 / 0.00 | 0.50 / 0.00 |

Mini and matrice node detection rises with frame length, but neither reaches a gateway pair at 0 dB source level. The pair
check at +12 dB (below) gives gateway pairs for both, so the limit at 0 dB is the two-node requirement with this ASSUMED
level, which 8192 does not remove.

**Cost (computed from `ops_per_frame()` and `state_bytes()`, `cost_estimates.txt`).** Real FFT plus comb and tracker, hop = n/2:

| Frame | Frames per s | MFLOP/s (model) | State RAM (bytes, float32, 8 start-up frames) | Window / hop |
|---|---|---|---|---|
| 1024 / 512 | 31.25 | 2.16 | 17,596 | 64 ms / 32 ms |
| 2048 / 1024 | 15.6 | 1.67 | 32,956 | 128 ms / 64 ms |
| 4096 / 2048 | 7.8 | 1.46 | 63,676 | 256 ms / 128 ms |
| 8192 / 4096 | 3.9 | 1.39 | 125,116 | 512 ms / 256 ms |

Compute falls with frame length (fewer frames per second), but state RAM and decision latency rise. The 8192 state is 125 KB by the model's count, against 18 KB at 1024. Whether a given node class in doc 04 can hold it was
not checked in this run. The 512 ms window centre sits 256 ms after the window start, so each decision is about 0.25 s later
than at 1024 samples (a latency estimate from the window length, not measured; the protocol is not changed).

**Two frame lengths.** Not run. The layer test shows that FPV and mini/matrice prefer different lengths, but the per-class
gateway result does not change across lengths (FPV only), so a second length is not justified by these numbers.

### 11.2 Neighbour matching (step 2)

**Design.** Each node reports f0 (11 bits: the existing DETECT line-1 field, 0.2 % steps) and a 6-bit presence mask
of harmonics 1-6 (a harmonic is present when its window peak stands 2x above its flanks and sits within 4 % of k f0; the
same test as the harmonicity gate). Rule "lines" (`fa.ratio_lines_ok`): the f0 ratio must lie within 12 % of a
small-integer ratio rho in {1, 2, 1/2, 3/2, 2/3, 3, 1/3}, and at least 2 harmonics must be shared at that ratio. Harmonic k of
one node and harmonic m of the other are the same line when k rho = m within 12 %. So a node locked on the second or third
harmonic still matches, but only on shared lines. A first version (a free Doppler scale over absolute line frequencies) was
written and replaced before any run: it accepts any small coincidence of harmonic series, so it was not measured.

**Bits.** f0 11 bits + mask 6 bits = 17 bits per report. Against the `DETECT` message in `docs/protocol-v0.md` (not edited; the field sizes below were not re-checked in this run):
the 8 B payload carries 49 bits today (line 2 delta is 6 of them). Replacing line 2 delta with the mask and adding f0 gives
60 of 64 bits, so no new message type and no payload growth would be needed. This is a report of what it would need, not
a spec change.

**Results (folds 1-3, 8192 frame).** Tuning sweep with the lines rule, same crossings and bed as the f0 sweep:

| theta | Gateway Pd, f0 | Events, f0 | Gateway Pd, lines | Events, lines | Node Pd (both) |
|---|---|---|---|---|---|
| 0.10 | 0.26 | 112 | 0.41 | 132 | 0.97 |
| 0.12 | 0.49 | 150 | 0.62 | 152 | 0.98 |
| 0.14 | 0.46 | 397 | 0.56 | 392 | 0.96 |
| 0.16 | 0.46 | 142 | 0.50 | 141 | 0.94 |
| 0.18 | 0.41 | 12 | 0.43 | 13 | 0.92 |
| 0.20 | 0.38 | 1 | 0.38 | 1 | 0.88 |
| 0.23 | 0.35 | 0 | 0.35 | 0 | 0.81 |
| 0.26 | 0.34 | 0 | 0.34 | 0 | 0.75 |

The lines rule adds gateway events at low theta (0.10 to 0.16) and gives nearly the same results from 0.18 up. Gateway
events in this bed are taken to be random pairs, because each node's scene is independent (ASSUMED; no shifted-null control
was run).

Pair-level check (`pair_check.py`, folds 1-3, 40 crossings per class, 8192, theta 0.23, crossing seed 6060). Counts as
printed in `pair_8192.log`:

| Class, source level | Both-detect adjacent pairs | Within 30 s | f0 rule ok | f0 rule ok and within 30 s | Lines rule within window |
|---|---|---|---|---|---|
| Mini, 0 dB | 4 | 4 | 1 | 1 | 1 |
| Mini, +12 dB | 77 | 63 | 54 | 45 | 60 |
| Matrice, 0 dB | 4 | 4 | 3 | 3 | 3 |
| Matrice, +12 dB | 65 | 58 | 38 | 34 | 37 |

At 0 dB the two rules give the same counts. At +12 dB the lines rule passes more pairs than the f0 rule (mini 60 against 45,
matrice 37 against 34). Decision: not adopted. The gateway result at 0.23 is the same for both rules (sweep above), and the
lines rule adds events at low theta.

### 11.3 Retests on the best frame (step 3)

8192 / 4096, theta 0.23, folds 1-3, 120 crossings (seed 2026), rural bed 3 h per node (39 node-h, seed 7300). Each row is its
own comb (the floor and gate change the comb), so each is a separate run with its own baseline.

| Variant | Node Pd < 100 m | Gateway Pd < 100 m | Node alarms per node-day (count) | Gateway events |
|---|---|---|---|---|
| Baseline (round-2 floor, gate_harm 1) | 0.81 | 0.35 | 30.2 (49) | 0 |
| Floor rise 0.05 per 32 ms (`floor_up_db` 0.05 per baseline hop) | 0.79 | 0.41 | 24.6 (40) | 0 |
| gate_harm 2 | 0.89 | 0.39 | 56.6 (92) | 0 |
| Floor rise 0.05 + gate_harm 2 | 0.85 | 0.41 | 43.1 (70) | 0 |

Keep rule (from round 2): keep a change only if gateway Pd rises without a clear rise in node alarms. The floor-rise change
passes: gateway +0.06 and node alarms down 19 %. gate_harm 2 fails (node alarms up 1.9 times). The combination fails on
node alarms (up 1.4 times). The floor rate is per baseline hop and converted by `to_frames`, so 0.05 per 32 ms is the same
rate (1.6 dB per second) at every frame length.

The slow floor rise is therefore the only retest kept. Carried forward as F2 = 8192 / 4096, theta 0.23, floor rise 0.05
per 32 ms. The threshold was not re-tuned for F2 (frozen from F1, to avoid another variant).

### 11.4 Finalists on folds 1-3 (step 4)

F0 = round-2 setting (1024 / 512, theta 0.10). F1 = 8192 / 4096, theta 0.23. F2 = F1 with the slow floor rise. Rural 39
node-h (bed seed 7300) and dense stress bed 6.5 node-h (0.5 h per node, seed 7300). Number of variants tried: see 11.7.

| Finalist | Node Pd | Gateway Pd | Rural node alarms per node-day (count) | Rural gateway events (per km-day) | Dense node alarms per node-day | Dense gateway events (per km-day) |
|---|---|---|---|---|---|---|
| F0 | 0.68 | 0.19 | 44.9 (73) | 1 (1.9) | 1,060 (287) | 46 (526) |
| F1 | 0.81 | 0.35 | 30.2 (49) | 0 (0) | 2,836 (768) | 298 (3,406) |
| F2 | 0.79 | 0.41 | 24.6 (40) | 0 (0) | 2,773 (751) | 286 (3,269) |

Rural F0 has one event on this bed (the round-2 tuning bed, seed 6000, had none). With 39 node-hours a single event is
noise at this level. The dense stress bed is a clear result: with the 8192 frame, false alarms in a loud clutter bed rise
seven times, so the 8192 detector is not robust in dense clutter. F1 and F2 both fail the dense bed by much more
than F0 does.

### 11.5 New draw, folds 4-5 (step 5)

**What was scored.** Folds 4-5 clips with the `r3` seeds (`SEEDS["r3"]`): crossings 12012, background 12013, rural false
alarms 12100, dense 12200. Whether these clips were used in earlier rounds was not checked, so treat the 0.29 figure as one
draw's result, not a held-out confirmation. The settings were fixed before these runs. The checkpoint code and the segment
refactor of `fa.scene_alarms` were added after the settings were fixed; they do not change results (the resume test gives
identical JSON). Each r3 run was made once in this round (`logs/r3_*`).

| Setting (same draw) | Crossings below 100 m | Gateway Pd (n) | Node Pd | Node, FPV / mini / matrice | Gateway, FPV / mini / matrice | Rural node-h | Rural node alarms per node-day | Rural gateway events | 95 % bound per km-day | Dense gateway events (per km-day) |
|---|---|---|---|---|---|---|---|---|---|---|
| F2 (8192, 0.23, slow floor) | 199 | 0.29 (57) | 0.73 | 1.00 / 0.74 / 0.54 | 0.89 / 0.13 / 0.00 | 223 | 21.5 (200) | 0 | 1.00 | 252 (2,880) |
| F0 (round 2) | 199 | 0.10 (19) | 0.55 | 0.93 / 0.49 / 0.33 | 0.35 / 0.00 / 0.00 | 78 | 33.5 (109) | 0 | 2.85 | 36 (411) |

The crossing count is per class: FPV 54, mini 69, matrice 76 (below 100 m). F2 rural: 223 node-hours is 17.15 line-hours
(one line-hour is 13 node-hours). Zero events give a 95 % bound of 2.996 events, which is 0.998 per km-day. F0 rural: 78
node-hours, same bound method, 2.85.

**The target check.** Gateway Pd below 100 m is 0.29 for F2 against the 95 % target: not met. False alarms: 0 in 17.15
line-hours gives a bound of 0.998 per km-day, which meets the 1 per km-day target only at the boundary, with the rural ASSUMED
bed. On the dense stress bed F2 has 2,880 gateway alarms per km-day.

**Diagnosis (exploration on the same draw, not used to change any rule).** The matrice gateway is zero although nodes detect
it on 54 % of crossings. Of 76 matrice crossings below 100 m, only 4 adjacent node pairs both detect, 3 of them inside 30 s,
and 1 has matching f0. The 4 pairs show f0 ratios of 5.1, 4.9, 2.1 and 1.16: one node locks on the fifth or second harmonic
of 100 Hz (501 Hz, 1023 Hz). Ratio 5 is outside the rule's set, and the lines rule (ratios up to 3) does not cover it.
Mini was not diagnosed. Source: `/home/ben/.cache/sonicmesh/round3/diag_matrice.py`, reading
the stored onsets of the held-out crossings. Any rule change for this would need a new draw, because this one has been
used.

### 11.6 Decision and what the rest of the project would need (step 6)

**Not adopted as the default.** F2 meets the rural false-alarm bound at 223 node-hours and raises gateway Pd on folds 1-3
and on the draw, but its dense stress gateway alarms are seven times the round-2 setting's. Gateway false alarms are
the criterion, and that is the stress result. So `Params()` and `run.py`'s `CHOSEN` keep the round-2 values. F2 stays the
rural candidate, with the dense result as an open item. No test was changed. (A default change would need the unit tests that
use `Params()` at 1024 samples (`test_startup_cap...`, `test_gate_harm...`, `test_harmonic_bits...`) to name `n_fft=1024`.)

**What the web demo and the planned C core would need to match F2:** frame 8192 samples, hop 4096, Hann window, the
same bin-width conversions (minimum comb half-width 15.6 Hz, flank 47 Hz), time constants converted per hop as in
`to_frames`, floor rise 0.05 per 32 ms (0.4 dB per 256 ms frame), theta 0.23, and the 6-bit mask if the lines rule were
adopted. The web demo implements the 1024-sample detector and does not change with this round. Nothing in `web/` was
changed in round 3 by me. The C core state is 125 KB at 8192 samples by the model's count (section 11.1). Whether a given node class in doc 04 can
hold it was not checked in this run.

### 11.7 Variants tried, and what was not done

- Tuning sweeps: five, each with nine thetas (45 operating points): frames 1024, 2048, 4096 and 8192 with the f0 rule, and
  8192 with the lines rule. Each sweep used 120 crossings and 39 node-hours.
- Retests at 8192, theta 0.23: floor rise 0.05, gate_harm 2, and their combination (three runs beyond the baseline), plus the
  F2 finalist runs (11.4). One line-overlap rule was written and replaced before any run; it was not measured.
- Exploration after the freeze, folds 1-3 only (not used for any choice): one-frame impulse hold at 8192 (log
  `explore_impulse1_8192`): node Pd 0.80, gateway Pd 0.38, 35 node alarms per node-day, 0 gateway events, against 0.79, 0.41,
  40 and 0 for F2.
- Not done: a per-harmonic layer test; an 8192 sweep with the floor change (F2 was frozen at theta 0.23); a clean held-out
  draw (the r3 draw is used in this round); a 223 node-hour rural run for F0 (F0 ran 78 node-hours); a two-frame-length
  comparison; impulse rejection at longer frames beyond the exploration above.
- Logs: `/home/ben/.cache/sonicmesh/round3/logs/`, JSON beside them, checkpoints in `ck_*`. Driver: `driver.sh` in the same
  directory.

### 11.8 Resources, reproduction, tests

- Memory: the parent process peaked at 0.61 to 0.81 GB (`/usr/bin/time -v`). Pool workers were about 0.5 GB resident each
  (`ps` during the 1024 layer test: six workers summed to 2.9 GB). `fa._limit_memory` sets a 3 GB address space limit per
  worker. It is called by the false-alarm pool, the layer test's initializer, the crossing pool's initializer (which the trials
  pool also uses) and the pair check.
- Wall time (rerun, 6 workers): layer test 1024 19 min, 2048 17 min, 4096 14 min, 8192 13 min; tuning sweep 1024 20 min,
  2048 11 min, 4096 8 min, 8192 7 min, 8192 lines 6 min; pair check 3 min; trials 6 to 7 min each; F2 223 node-hour rural run 55
  min (plus dense 0.5 min); F0 78 node-hour run 31 min.
- Checkpointing (new): `--ckpt DIR` on `run.py` saves each crossing (`map_crossings`) and each 5-minute segment of each node
  (`fa.scene_alarms`) when it finishes, and a rerun with the same directory skips them. Verified: a resumed tuning run gives
  identical JSON, and a partial resume recomputes only the missing jobs. Use a separate directory per configuration, because
  the stored crossing results depend on the frame, threshold and gateway rule. The trials runner (`trials.py`) has no
  checkpoint; its runs are 3 to 7 min.
- Tests: `uv run --with pytest --with numpy --with scipy pytest sim/tests`: 27 passed (14.1 s, rerun for this section). The
  web suite (`npm --prefix web test`) reports 144 passed and 1 skipped for the current `web/` tree, which this section does not
  change.

**Reproduce (repo commands; `CK` = a checkpoint directory):**

```
uv run sim/perimeter/bed_layers.py --passes 4 --frames 8192/4096 --rows "prop only|+ pink|+ pink + events + wind 2" --json <path>
uv run sim/perimeter/run.py --tune --crossings 120 --hours 3 --n-fft 8192 --hop 4096 --ckpt CK --json <path>
uv run sim/perimeter/run.py --tune --crossings 120 --hours 3 --n-fft 8192 --hop 4096 --gate lines --json <path>
uv run sim/perimeter/pair_check.py --crossings 40 --n-fft 8192 --hop 4096 --theta 0.23 --json <path>
uv run sim/perimeter/trials.py --group floor-up05 --n-fft 8192 --theta 0.23 --hours 3 --crossings 120 --json <path>
uv run sim/perimeter/trials.py --group base --n-fft 1024 --theta 0.10 --bed dense --hours 0.5 --json <path>
uv run sim/perimeter/run.py --part crossings --seeds r3 --crossings 240 --n-fft 8192 --hop 4096 --theta 0.23 --floor-up 0.05 --ckpt CK --json <path>
uv run sim/perimeter/run.py --part fa --seeds r3 --hours 17.15 --dense-hours 0.5 --n-fft 8192 --hop 4096 --theta 0.23 --floor-up 0.05 --ckpt CK --json <path>
uv run sim/perimeter/run.py --part crossings --seeds r3 --crossings 240 --ckpt CK --json <path>   # round-2 setting
uv run sim/perimeter/run.py --part fa --seeds r3 --hours 6 --dense-hours 0.5 --ckpt CK --json <path>
```

Round-2 settings: add `--n-fft 1024 --hop 512 --theta 0.10` to the tune and trials commands.

## 12. Round 4, 2026-11-06: why tracks break on a mini

**Question.** In the web demo, a mini-class drone is audible on a node's mic and its comb score is above the threshold,
but the node often does not detect it. Why?

### 12.1 Trace in the web demo

Mini alone at 20 m clearance, 15 m/s, nodes within 150 m, three seeds, using the port in `web/src/detector/comb.ts`. The
demo's terrain and propagation are not the perimeter runner's, so these figures explain the mechanism and do not estimate
Pd. Temporary test code; not kept in the repo.

- While arming, the only rule still unmet was the age rule (`age_min`, 62 hops, 2 s) in all samples on the two seeds checked.
  The harmonic share was not the limit (median 1.00).
- Tracks are short: median age at loss 6, 7 and 10 hops, then a new track about 1 hop later.
- Of 131 new tracks after a loss, 4 came back near the same pitch, 71 at another low-integer ratio and 56 at no such ratio.
  This is why `gap_frames` of 16, 31 and 62 changed nothing here, matching section 10.4.
- Misses inside a track (three seeds, baseline, 958 in all): 880 had a zero score everywhere near the track, 22 had a score
  below theta, 56 failed the harmonic check, and 0 were impulse frames. So the fundamental gate, not impulse rejection,
  causes nearly all of them. With the guard the zero-score misses fall to 731 and hits rise from 2,203 to 2,430.

### 12.2 The bug

`S[j] >= SUB_RATIO * S[index]` is true for any candidate when `S[index]` is 0. A gate failure at the track's own candidate
therefore moved the track to its lowest valid sub-harmonic, and the next frames searched around the wrong pitch. It has been
present in `detector.py` and the port throughout, so rounds 1 to 3 were all measured with it. `sub_guard` (default off, so
`Params()` is unchanged) blocks the takeover while the track's own score is 0. `gap_harm` (default off) also lets a re-found
track keep its age at a ratio a/b of its last pitch, with a and b up to the limit.

### 12.3 Trials, folds 1-3

Crossings: the 120 tuning crossings, 96 below 100 m. Pd is below 100 m. The baseline matches section 10.4 exactly.

| Variant | Node Pd | Gateway Pd | FPV node / gw (n=37) | Mini node / gw (n=25) | Matrice node / gw (n=34) | Node alarms (13 node-h) | Gateway events |
|---|---|---|---|---|---|---|---|
| Baseline, theta 0.10 | 0.68 | 0.19 | 0.92 / 0.49 | 0.48 / 0.00 | 0.56 / 0.00 | 21 | 0 |
| `sub_guard` | 0.75 | 0.27 | 1.00 / 0.70 | 0.60 / 0.00 | 0.59 / 0.00 | 32 | 0 |
| guard + gap 1 s | 0.77 | 0.27 | 1.00 / 0.70 | 0.60 / 0.00 | 0.65 / 0.00 | 37 | 1 |
| guard + gap + `gap_harm` 4 | 0.81 | 0.29 | 1.00 / 0.73 | 0.68 / 0.04 | 0.71 / 0.00 | 47 | 2 |
| guard + gap + `gap_harm` 6 | 0.83 | 0.30 | 1.00 / 0.76 | 0.72 / 0.04 | 0.74 / 0.00 | 61 | 2 |
| gap + `gap_harm` 4, no guard | 0.72 | 0.22 | 1.00 / 0.57 | 0.48 / 0.00 | 0.59 / 0.00 | 28 | 1 |

Longer false-alarm runs, baseline against `sub_guard`:

| Bed | Size | Node alarms | Gateway events | Gateway per km-day |
|---|---|---|---|---|
| Rural | 78 node-hours | 160 against 233 (49 and 72 per node-day) | 2 and 2 | 1.90 and 1.90 |
| Dense stress | 6.5 node-hours | 287 against 320 | 46 and 48 | 526 and 549 |

`gate_harm` 2 on the same folds, 96 crossings below 100 m and 78 node-hours rural:

| Variant | Node Pd | Gateway Pd | FPV gw | Mini gw | Matrice gw | Node alarms | Gateway events |
|---|---|---|---|---|---|---|---|
| `gate_harm` 2 | 0.77 | 0.25 | 0.59 | 0.08 | 0.00 | 227 | 3 |
| `gate_harm` 2 + guard | 0.81 | 0.30 | 0.73 | 0.04 | 0.03 | 291 | 4 |

### 12.4 Held-out test of `sub_guard`

The bar, set before any held-out result: gateway Pd below 100 m rises, rural gateway alarms do not rise, and dense gateway alarms do
not clearly rise. Seeds `r4` were never used before; the clips are folds 4-5 again, so this is a new draw and not a clean test set.

| Bed or crossings | Baseline | `sub_guard` |
|---|---|---|
| Gateway Pd below 100 m (n=191) | 0.15 | 0.23 |
| FPV node / gateway (n=62) | 1.00 / 0.47 | 1.00 / 0.71 |
| Mini node / gateway (n=64) | 0.48 / 0.00 | 0.62 / 0.00 |
| Matrice node / gateway (n=65) | 0.28 / 0.00 | 0.37 / 0.00 |
| Rural, 223 node-hours: node alarms | 347 (37 per node-day) | 558 (60 per node-day) |
| Rural: gateway events (per km-day) | 5 (1.67) | 5 (1.67) |
| Dense, 6.5 node-hours: gateway events (per km-day) | 42 (480) | 54 (617) |

**Result: the bar is met, narrowly on the dense bed.** A rise of 42 to 54 is about one standard deviation, and the tuning folds gave 46 to
48, so it is not a clear rise, but it is in the wrong direction. Five events bound the rural rate at about 3.5 per km-day (95 %), so
neither setting shows the target of 1. The 61 % rise in node alarms means more false pairs may appear with more nodes or closer spacing.

**`sub_guard` stays off until the owner decides.** Changing it also changes the demo and needs the fixtures rechecked.

**`gap_harm` is not adopted.** It adds 0.02 to 0.03 of gateway Pd and is where gateway events first appear in the short bed.

**`gate_harm` 2 is not adopted.** It barely moves the mini and matrice at the gateway, and adds alarms on top of the guard's.

**The mini and matrice gateway problem is not solved.** Their node Pd improves, but the gateway needs two nodes and stays near 0.

### 12.4b Ground-level mic, in simulation

`sim/experiments/ground_mic_check.py`, the 120 tuning crossings, mic at 0.02 m with a complete reflection against 0.3 m with gamma 0.7, and
the bed raised 3 dB for the boundary gain on diffuse noise. With `sub_guard`, below 100 m:

| Mic | Node Pd | Gateway Pd | FPV gw (n=37) | Mini node / gw (n=25) | Matrice node / gw (n=34) |
|---|---|---|---|---|---|
| 0.3 m | 0.75 | 0.27 | 0.70 | 0.60 / 0.00 | 0.59 / 0.00 |
| Ground | 0.77 | 0.34 | 0.86 | 0.64 / 0.00 | 0.62 / 0.03 |

Without the guard, matrice node Pd falls from 0.56 to 0.41 at the ground, though gateway Pd rises from 0.19 to 0.23. The gain is
mostly FPV, on few crossings, with no false-alarm run. Geometry only: no grass, rain, mud or wind benefit. Worth a field test.

### 12.4c Rotor-noise modulation on real recordings

Sonar's DEMON method: a comb on the envelope spectrum of a higher band. `sim/experiments/demon_check2.py` scales real hover clips to range
and mixes them into the rural bed (folds 1-3). Threshold 0.1 % of 2 s bed windows, each pitch scored against its own bed statistics, 40
windows per cell. The first version (`demon_check.py`) failed its control until pitches were scored separately. Detector = `detector.py` with
`sub_guard`, 8 s of bed then 20 s of clip, 6 trials per cell, on in 1 of 24 bed-only trials. The two are on different scales and compare
only roughly. Best envelope band shown, hits below; ranges with mics M1 / M3 / M5 / M7 / M9:

| Clip, range | Plain comb, same windows | Envelope 0.5-2 kHz | Real detector (of 6) |
|---|---|---|---|
| Matrice 300, 100 m | 0 / 0 / 0 / 0.03 / 0 | 0.12 / 0 / 0.17 / 0.80 / 0.72 | 2 / 2 / 6 / 6 / 6 |
| Matrice 300, 150 m | all 0 | 0 / 0 / 0.05 / 0.50 / 0.50 | 0 / 1 / 6 / 2 / 3 |
| Matrice 300, 200 m | all 0 | 0 / 0 / 0 / 0.20 / 0.10 | 1 / 0 / 2 / 1 / 1 |
| Mini 3 Pro, 25 m | all 0 | all 0 (1-3 kHz: 0 / 0 / 0.12 / 0.15 / 0) | 1 / 0 / 4 / 1 / 1 |
| Mini 3 Pro, 50 m and beyond | about 0 | about 0 | about 0 |
| Type `Yn`, 50 m | 0.45 / 0.93 / 0.93 / 0.88 / 0.33 | 0.12 / 0.03 / 0.07 / 0.33 / 0.45 | 5 / 6 / 6 / 6 / 4 |

- **The signal is real.** The envelope finds the same pitch as the tone on every mic: about 93 Hz (the Matrice line in doc 03) and 153 Hz for `Yn`. The
  two mics on one side are stronger, in both the envelope and the plain comb, which is more like directivity than one bad mic.
- **It does not extend range beyond the real detector.** It does not reach the Mini either. It is not adopted as a detector.
- **It may be a useful cheap feature for the classifier.** Rotor blades show at the same pitch in tone and envelope, though real engines may do the same. Untested.

**Real clips against the simulator's levels** (100 Hz to 4 kHz, at 1 m, ASSUMED calibration, mics M1 / M3 / M5 / M7 / M9):

| Clip | Real, dB | Simulator, dB |
|---|---|---|
| Matrice 300 | 81 / 82 / 84 / 85 / 83 | 80 |
| Mini 3 Pro | 66 / 69 / 70 / 69 / 65 | 80 |
| `Yn` | 75 / 79 / 81 / 80 / 76 | no class |

The simulated Mini is 10 to 15 dB louder than this recording, so real Mini results may be worse than simulated ones. The real Matrice clip is detected to 100 to 150 m on most
mics, better than the synthetic matrice, so the synthetic source may be pessimistic for it. These clips hover, with no ground image, turbulence or Doppler, and the calibration
is ASSUMED, so this is a reason to check the sources, not a measured range.

### 12.4d Node spacing

**Read 12.4f first.** The 1+, 2+ and 3+ shares below count background locks too, and the mini and matrice rows are mostly
background. The table is kept as run.

`sim/experiments/spacing_check.py`, the same 96 tuning crossings below 100 m at every spacing, with `sub_guard`. "2+" and "3+" are crossings heard by at least
that many nodes within the runner's truth window. Cost is detector nodes only, at $30 each. FPV n=37, mini n=25, matrice n=34.

| Spacing | Nodes per km | Cost per km | FPV 3+ / gw | Mini 1+ / 2+ / gw | Matrice 1+ / 2+ / gw | All gw |
|---|---|---|---|---|---|---|
| 350 m | 2.9 | $86 | 0.59 / 0.70 | 0.60 / 0.20 / 0.00 | 0.59 / 0.03 / 0.00 | 0.27 |
| 250 m | 4.0 | $120 | 0.95 / 0.86 | 0.76 / 0.36 / 0.00 | 0.79 / 0.21 / 0.03 | 0.34 |
| 175 m | 5.7 | $171 | 1.00 / 0.95 | 0.88 / 0.40 / 0.12 | 0.82 / 0.44 / 0.00 | 0.40 |
| 120 m | 8.3 | $250 | 1.00 / 1.00 | 0.92 / 0.72 / 0.24 | 0.91 / 0.50 / 0.09 | 0.48 |
| 80 m | 12.5 | $375 | 1.00 / 1.00 | 1.00 / 0.88 / 0.52 | 1.00 / 0.88 / 0.15 | 0.57 |

- **FPV:** three nodes on nearly every crossing from 250 m, and gateway 0.95 from 175 m.
- **Mini and matrice:** 80 m gets two nodes on 88 % of crossings, but that is over four times the nodes of 350 m, and the simulated mini is 10 to 15 dB louder than the real clip (12.4c).
- **Two nodes is not enough to reach the gateway.** At 80 m, matrice reaches 2+ on 0.88 and the gateway on 0.15. Mini is 0.88 and 0.52. FPV does not show this gap.
  The cause is not yet measured.
- **Not a choice of spacing yet.** No false-alarm run at any spacing, and false alarms per km rise with nodes per km. The bed is independent per node, which flatters close spacing, because real
  nearby nodes share sound. Tuning crossings, small n, no held-out draw.

### 12.4e Why two nodes do not make a gateway pair

**Read 12.4f first.** Most of the mini and matrice "heard by 2+" crossings here are background locks, so these causes describe
background as much as the drone.

`sim/experiments/gap_check.py` reruns 12.4d with `sub_guard` and gives the same gateway counts. For each mini or matrice crossing below 100 m
heard by 2+ nodes with no gateway pair, the first cause that applies: **apart** (no two detecting nodes are neighbours; the gateway pairs
neighbours only), **time** (neighbours, but no onsets within 30 s), **f0** (within 30 s, but the pitch rule fails).

| Spacing | Mini: 2+ / gw / missed | Mini apart / time / f0 | Matrice: 2+ / gw / missed | Matrice apart / time / f0 |
|---|---|---|---|---|
| 350 m | 5 / 0 / 5 | 1 / 1 / 3 | 1 / 0 / 1 | 0 / 0 / 1 |
| 250 m | 9 / 0 / 9 | 1 / 1 / 7 | 7 / 1 / 6 | 2 / 1 / 3 |
| 175 m | 10 / 3 / 7 | 1 / 2 / 4 | 15 / 0 / 15 | 9 / 2 / 4 |
| 120 m | 18 / 6 / 12 | 5 / 1 / 6 | 17 / 3 / 14 | 10 / 1 / 3 |
| 80 m | 22 / 13 / 9 | 2 / 0 / 7 | 30 / 5 / 25 | 11 / 3 / 11 |

Over all spacings, the 103 misses split 49 f0, 42 apart, 12 time.

- **The pitch failures are not related harmonics.** Of 49, the lines rule (ratios up to 3 with two shared lines) would pass 3, the
  median f0 over each lock instead of the onset f0 would pass 14, and two lines at the same absolute frequency at any ratio would pass 1.
  A wider related-harmonic rule would not close this gap.
- **The matrice locks on single high harmonics.** Onset f0 as a harmonic of the 100 Hz blade-pass frequency, at 80 m: 21 at 1, then 10, 5,
  9 and 7 (21, 16, 14, 11), and 27 of 118 at no harmonic or sub-harmonic within 8 %. Two nodes that each take a different upper line as the
  fundamental report pitches that no small-ratio rule can join, for example 700 Hz against 1,000 Hz. Mini onsets spread over harmonics 1 to 4
  and 'other'. FPV locks mostly at its fundamental and never misses here.
- **"Apart" is the matrice's main cause at 175 and 120 m.** The detecting nodes are not neighbours. Whether the middle node missed, or one of the
  locks is the bed rather than the drone, is not measured: the onset counts are not checked against the source.
- **What would help, untested:** a detector that reports the fundamental, not a lone upper line, perhaps by preferring the lowest f0 that explains
  the lines, which is the job pitch tracking (approved) would take on; and allowing a pair across one silent node.

### 12.4f Correction: background inside the crossing window

`sim/experiments/silent_check.py` runs the 12.4d crossings with the drone turned down by 200 dB. Everything detected is then the bed.
With `sub_guard`, below 100 m:

| Spacing | Class | 2+ nodes, silent | 2+ nodes, drone (12.4d) | Gateway, silent | Gateway, drone (12.4d) |
|---|---|---|---|---|---|
| 350 m | FPV | 0.16 | 0.89 | 0.05 | 0.70 |
| 350 m | Mini | 0.12 | 0.20 | 0.00 | 0.00 |
| 350 m | Matrice | 0.15 | 0.03 | 0.00 | 0.00 |
| 175 m | Mini | 0.36 | 0.40 | 0.00 | 0.12 |
| 175 m | Matrice | 0.41 | 0.44 | 0.06 | 0.00 |
| 80 m | FPV | 0.81 | 1.00 | 0.08 | 1.00 |
| 80 m | Mini | 0.64 | 0.88 | 0.04 | 0.52 |
| 80 m | Matrice | 0.74 | 0.88 | 0.15 | 0.15 |

The class only sets the flight path and window length (mini windows are shorter) when the drone is silent.

- **Node counts are not drone detections.** A crossing window is about 60 to 75 s, and at close spacing a dozen nodes listen through it, so ordinary
  node alarms fill the 1+, 2+ and 3+ shares. The rate fits the long false-alarm runs: about 4 per node-hour here against 3 in 12.3.
- **Not detector start-up.** Of 277 background onsets at 80 m, 172 come more than 40 s after their node started, and 18 in the first 10 s.
- **The shared bed inflates the gateway.** Every node in a crossing cuts its bed from one 0.25 h recording, so one event clip can reach several
  nodes at the same pitch and pass the f0 rule. With a 2 h bed (146 events), the 80 m silent gateway falls to FPV 0.00, mini 0.04 and matrice 0.03,
  from 0.08, 0.04 and 0.15, and onsets in the window from 277 to 137. Every crossing run in this report uses the 0.25 h bed, so mini and matrice
  gateway Pd of a few hundredths elsewhere in it is at chance level. FPV results and the 350 m conclusions stand: the silent gateway there is 0.00 to 0.05.
- **What changes.** The matrice shows no detection above background at any spacing. The mini is clearly above background only at 80 m (0.52 against
  0.04). FPV is unaffected. The 12.4e causes mostly describe pairs of background locks, which is also why the next test failed.

**Reporting the fundamental (not adopted).** `sim/experiments/low_f0_check.py` keeps detection unchanged and, at each onset, replaces the reported f0
with the locked f0 / k that puts at least 75 % of the lines in the last second on its harmonics. At 80 m on 32 crossings, gateway Pd fell: mini 6 to 3 of 9,
matrice 0 to 1 of 10, FPV 7 of 7 both. The lines at matrice onsets are seldom a 100 Hz series (for example 145, 296 and 454 Hz, a bed source), and at
FPV onsets bed lines pull the estimate to sub-harmonics. A first version, the highest f0 on the whole grid, was worse.

**Rerun with a 2 h bed.** `spacing_check.py --bed-hours 2` and `silent_check.py --bed-hours 2`, the same crossings, `sub_guard`, below 100 m.
Gateway Pd with the drone and with it silent (FPV n=37, mini n=25, matrice n=34):

| Spacing | Cost per km | FPV gw / silent | Mini gw / silent | Matrice gw / silent | FPV 3+ nodes | Mini 2+ / silent | Matrice 2+ / silent |
|---|---|---|---|---|---|---|---|
| 350 m | $86 | 0.81 / 0.00 | 0.04 / 0.00 | 0.00 / 0.00 | 0.62 | 0.12 / 0.04 | 0.06 / 0.03 |
| 250 m | $120 | 0.97 / 0.00 | 0.08 / 0.00 | 0.03 / 0.00 | 0.97 | 0.24 / 0.08 | 0.12 / 0.15 |
| 175 m | $171 | 0.95 / 0.03 | 0.04 / 0.04 | 0.03 / 0.03 | 0.97 | 0.36 / 0.12 | 0.09 / 0.15 |
| 120 m | $250 | 1.00 / 0.00 | 0.32 / 0.00 | 0.03 / 0.06 | 1.00 | 0.72 / 0.12 | 0.29 / 0.24 |
| 80 m | $375 | 1.00 / 0.00 | 0.48 / 0.04 | 0.15 / 0.03 | 1.00 | 0.88 / 0.36 | 0.56 / 0.47 |

- **FPV:** gateway 0.81 at today's 350 m and 0.97 at 250 m, above the 0.70 and 0.86 of 12.4d. The short bed cost FPV too.
- **Mini:** above background from 120 m (8 of 25) and at 80 m (12 of 25). At 175 m and wider it is at background.
- **Matrice:** nothing above background except perhaps 80 m (5 of 34 against 1 of 34). Its 2+ counts match the silent run at every spacing.
- **Node counts still need the silent column.** Even with the longer bed, a crossing window collects background node alarms, so 1+, 2+ and 3+ are
  only meaningful against the silent run.
- **Still open:** no false-alarm run per spacing, tuning crossings only, small n, simulated sources (the simulated mini is 10 to 15 dB louder than the real clip).
  Every crossing table before 12.4g used the 0.25 h bed and carries the same bias.

### 12.4g Baselines with a 2 h crossing bed

`run.py` now sets `CROSS_BED_H = 2.0` for the crossing bed (`trials.py --bed-hours 0.25` reproduces rounds 1-4). False-alarm runs draw a fresh
scene per node and never used the shared bed, so their numbers stand; these reruns are crossings only (`trials.py --hours 0`). The 0.25 h rerun
reproduces 12.3 exactly (0.19 and 0.27, and every class). Gateway Pd below 100 m, node Pd in brackets:

| Draw | Variant | Gateway Pd, 0.25 h | Gateway Pd, 2 h | FPV gw, 2 h | Mini gw (node), 2 h | Matrice gw (node), 2 h |
|---|---|---|---|---|---|---|
| Folds 1-3, 96 | Baseline | 0.19 | 0.20 | 0.49 | 0.04 (0.52) | 0.00 (0.38) |
| Folds 1-3, 96 | `sub_guard` | 0.27 | 0.32 | 0.81 | 0.04 (0.68) | 0.00 (0.50) |
| Folds 1-3, 96 | `gate_harm` 2 | 0.25 | 0.21 | 0.51 | 0.04 (0.56) | 0.00 (0.44) |
| Folds 1-3, 96 | `gate_harm` 2 + guard | 0.30 | 0.30 | 0.73 | 0.08 (0.68) | 0.00 (0.47) |
| `r4` held out, 191 | Baseline | 0.15 | 0.18 | 0.53 | 0.02 (0.56) | 0.00 (0.35) |
| `r4` held out, 191 | `sub_guard` | 0.23 | 0.28 | 0.81 | 0.03 (0.66) | 0.02 (0.38) |

- **`sub_guard` holds up, and by more.** Held-out gateway Pd 0.18 to 0.28, FPV 0.53 to 0.81. The false-alarm side of the bar is unchanged from
  12.4 (rural gateway 5 to 5, dense 42 to 54).
- **`gate_harm` 2 adds nothing** on top of the guard (0.30 against 0.32).
- **Matrice node Pd is at background.** With the drone silent at 350 m, 1+ nodes detect in 0.35 of matrice windows (12.4f), against node Pd 0.35 to
  0.50 here. Mini node Pd (0.52 to 0.68) is above its silent 0.24. Node Pd needs the silent figure beside it from now on.
- Mini and matrice gateway Pd stay at 0.00 to 0.08 at 350 m spacing.

### 12.5 Other findings from the demo

- A single setting and seed is not enough there: a matrice at 40 m with an FPV flying scored 4 % under 75 m in one run and 89 %
  in another where only the FPV's height differed. Results near the threshold move a lot with small changes.
- Empty scenes are not always clean. In 120 s runs on six seeds, one node held a long wandering lock on one seed at baseline,
  and on two with the guard, starting in the first few seconds. The cause is not established.
- Two drones of one class join into one bogie, since bogies are formed from pitch and neighbouring nodes. Two FPVs shared one in
  50 of 53 samples, and the single estimated area then fits neither.

**Reproduce:**

```
uv run sim/perimeter/trials.py --group lock --hours 1 --crossings 120 --procs 4 --json <path>
uv run sim/perimeter/trials.py --group guard --hours 6 --crossings 120 --procs 4 --json <path>
uv run sim/perimeter/trials.py --group guard --bed dense --hours 0.5 --crossings 12 --procs 4 --json <path>
uv run sim/perimeter/trials.py --group gate2 --hours 6 --crossings 120 --procs 4 --json <path>
uv run sim/perimeter/trials.py --group guard --seeds r4 --hours 17.15 --crossings 240 --ckpt CK --json <path>
uv run sim/perimeter/trials.py --group guard --seeds r4 --bed dense --hours 0.5 --crossings 12 --ckpt CK --json <path>
uv run sim/experiments/ground_mic_check.py --crossings 120 --procs 4 --json <path>
```

**Adopted 2026-11-10.** `sub_guard` is now the default in `sim/detector/detector.py` and `web/src/detector/comb.ts`,
with the parity fixture regenerated. The trial groups pin `sub_guard=False` in their baseline row, so the commands
above still reproduce the tables. The fixture's three explicit `sub_guard` cases now run with it off, so both paths
stay covered.

## Sources

- Harmonic comb design (10 harmonics, 80-1000 Hz): [`docs/research/04-hardware-boundaries.md`](04-hardware-boundaries.md).
- Information budget and gateway timing: [`docs/research/02-information-budget.md`](02-information-budget.md).
- Real hover spectra and harmonic lines: [`docs/research/03-real-hover-audio.md`](03-real-hover-audio.md).
- Subsections and node-to-node: [`docs/protocol-v0.md`](../protocol-v0.md) sections 3a and 3b.
- DroneNoise dataset, University of Salford, CC BY 4.0. ESC-50, CC BY-NC 3.0 (local use only).
