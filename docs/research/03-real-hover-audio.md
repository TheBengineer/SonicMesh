# Research 03 — Real hover recordings: rotor wobble, real TDOA, and the sim with a real source

Date: 2026-11-04

## Data

**DroneNoise Database**, University of Salford, CC BY 4.0
([figshare](https://salford.figshare.com/articles/dataset/DroneNoise_Database/22133411/1),
[repository record](https://salford-repository.worktribe.com/output/3626643/dronenoise-database)).
Recorded at Edzell, Scotland, on 17 Aug 2022.

**Files used.** The hover-at-10 m sets for two drones, each 9 channels × 20 s, 50 kHz float WAV:
- DJI Matrice 300 RTK: `Ed_M3_10_H00_N_C_nw_ev1_M1…M9.wav`
- DJI Mini 3 Pro: `Ed_3p_10_H00_N_C_nw_ev1_M1…M9.wav`

The drone names come from the group's
[supplementary material](https://salford.figshare.com/articles/media/Multi-propeller_Vehicle_s_Noise_-_Supplementary_Material/27917541).

**Array.** Nine ground-plate microphones in a line perpendicular to the flight path, at lateral
angles of 0°, ±15°, ±30°, ±45° and ±60° from a point 10 m below the drone. That puts them 0, 2.7,
5.8, 10.0 and 17.3 m out from the centre
([hovering paper](https://salford-repository.worktribe.com/output/2096913/suas-noise-characterization-during-hovering-operations),
[Forum Acusticum 2023](https://dael.euracoustics.org/confs/fa2023/data/articles/000248.pdf)).
M1…M9 is taken to run from −60° to +60°; the measured delays confirm that order.

**Flight mode.** Both drones were in GPS-assisted hover, not manual mode. A steady-stick manual
recording (the user's own drone) is still needed for a true worst case.

**Fetch the files** (about 72 MB) into `data/dronenoise/`, which git ignores:

```bash
curl -s "https://api.figshare.com/v2/articles/22133411/files?page_size=500" | python3 -c "import json,sys; [print(f['download_url'], f['name']) for f in json.load(sys.stdin) if f['name'].startswith(('Ed_M3_10_H00_N_C_nw_ev1_','Ed_3p_10_H00_N_C_nw_ev1_'))]" | sort -u -k2,2 | while read u n; do curl -sL -o "data/dronenoise/$n" "$u"; done
```

## 1. The sound itself

Script: [`sim/experiments/real_hover_analysis.py`](../../sim/experiments/real_hover_analysis.py).

| | Matrice 300 (≈ 6 kg, large props) | Mini 3 Pro (< 250 g) |
|---|---|---|
| Strongest tonal peaks | 81, 92 Hz; harmonics at 159–187, 239, 275–280, 327, 367, 409 Hz | 178/181, 221/226, 254/257, 501/507 Hz |
| Line structure | Low blade-pass rate, many weak harmonics | Pairs of close lines (rotors at slightly different speeds) |
| **Fast wobble** (< 1 s), on clean lines | **0.55–0.66%** rms, rms bandwidth 5–7 Hz | **0.95–3%** rms, rms bandwidth 4–13 Hz |
| Slow drift (> 1 s) | ~1.5% rms | 1.4–2.4% rms |

**Takeaways:**
- **Even a GPS hover has plenty of rotor wobble.** It matches the simulation's assumptions
  (0.5–2%, ~6 Hz bandwidth), so the synthetic model wasn't optimistic. The smaller drone wobbles more.
- Some lines show 6–10% "wobble". That is probably the tracker jumping between two close rotor
  lines, the same failure the line-feature method suffers from.
- **The big drone's harmonics sit low (80–400 Hz).** The line-feature coarse stage looks in
  500–2000 Hz, so it finds little there. Any line-based method needs to choose its band per drone.

## 2. Real TDOA between real microphones

Measured with GCC-PHAT in 1 s windows, against centre mic M5. The "expected" column assumes the
drone was exactly over M5.

| Mic | x (m) | Expected (ms) | M3 raw mean ± std | M3 1-bit 4k | 3p raw mean ± std | 3p 1-bit 4k |
|---|---|---|---|---|---|---|
| M1 | −17.3 | 29.15 | 27.79 ± 0.36 | 27.78 ± 0.45 | 27.95 ± 2.10 | 25.44 ± 12.95 |
| M3 | −5.8 | 4.51 | 4.38 ± 0.23 | 4.27 ± 0.28 | 4.19 ± 0.14 | 4.20 ± 0.14 |
| M4 | −2.7 | 1.03 | 1.16 ± 0.06 | 1.05 ± 0.05 | 0.89 ± 0.05 | 0.90 ± 0.05 |
| M6 | +2.7 | 1.03 | 0.31 ± 0.04 | 0.33 ± 0.09 | 1.02 ± 0.08 | 1.00 ± 0.08 |
| M7 | +5.8 | 4.51 | 2.86 ± 0.17 | 2.84 ± 0.28 | 4.63 ± 0.22 | 4.62 ± 0.24 |
| M9 | +17.3 | 29.15 | 24.38 ± 0.11 | 25.82 ± 5.35 | 29.87 ± 2.39 | 28.49 ± 3.54 |

**Fitting the drone's actual hover position** to all 8 TDOAs:
- M3: +0.71 m across, ~12.3 m from the array line. **Residual 0.11 ms rms (4 cm).**
- 3p: −0.33 m across, ~10.3 m from the line. **Residual 0.22 ms rms (7 cm).**

(A single line of mics can't separate height from along-track offset, so only their combined
distance is reported.)

Path-closure checks (M1→M5 + M5→M9 against M1→M9 directly) agree to within 0.08–0.10 ms.

**Takeaways:**
- **A real drone's continuous sound gives sharp, consistent TDOA on real microphones.**
  It agrees with geometry to centimetres, with no "crisp event" needed.
- **1-bit 4k audio matches full-quality audio where SNR is good** (inner mics).
  At the far 60° mics its scatter grows to several ms (3p: up to 13 ms).
  Those mics are at shallow angles, where ground-plate microphones lose some signal.

## 3. Long-range sim driven by the real recordings

Script: [`sim/experiments/real_source_tdoa.py`](../../sim/experiments/real_source_tdoa.py).

**Setup:**
- The centre-mic recording, 10 m below the drone, becomes the source waveform.
- Each trial starts at a random point in the recording.
- The sound is propagated to two nodes 300 m apart, using the same model as `tdoa_two_stage.py`.
- 10 trials per row.

Cells show the share of trials with TDOA error under 5 ms after the fine stage:

| Drone, speed | SNR | lines → fine | 1-bit 1k → fine | bearing → fine | bearing → fine (synthetic model, doc 02) |
|---|---|---|---|---|---|
| M3, hover | 0 | 10% | 80% | **100%** | 100% |
| M3, hover | −5 | 0% | 0% | **90%** | 20%* |
| M3, 10 m/s | −5 | 0% | 0% | **70%** | — |
| M3, 50 m/s | 0 | 0% | 0% | **80%** | 20% |
| 3p, hover | 0 | 30% | 70% | **100%** | 100% |
| 3p, 10 m/s | −5 | 0% | 0% | **60%** | — |
| 3p, 50 m/s | 0 | 20% | 0% | **100%** | 20% |
| either, any | −10 | ≤ 10% | ≤ 10% | 10–20% | ≤ 25% |

\* From the doc 02 compression run, hover with 2 s windows.

FDOA error when TDOA locks: 0.02–0.1 m/s (hover, 10 m/s) and 0.5–0.9 m/s (50 m/s).

**Takeaways:**
- **Real drone sound does better than the synthetic model.** With bearing-aligned windows, 1-bit 4k
  TDOA works down to **−5 dB** for slow drones and **0 dB at 50 m/s**. The synthetic model needed
  about +5 dB more. Real rotor noise carries more random broadband content than the model gave it.
  So the earlier conclusions were conservative.
- **Bearing-free coarse stages still need about 0 to +10 dB.**
  - *1-bit 1k:* the better of the two for slow drones, working to about 0 dB.
  - *Line features:* poor on the M3, because its harmonics sit below the 500–2000 Hz band they search.
  - So bearings remain the coarse stage to design around.

**Caveat:** the recording's own background noise travels through the sim as if it came from the
drone. Ten metres below a hovering drone that background is much weaker than the drone, but it
could make results slightly optimistic.

## 4. The user's FPV quad in manual mode (onboard GoPro audio)

**Source.** A 34.6 s compilation of four clips, mostly flown in manual (acro) mode, filmed by a
GoPro on the drone. The audio comes from a YouTube download (AAC, 128 kbit/s, 44.1 kHz, both
channels identical).

It isn't in the repo. To recreate the WAV:
`ffmpeg -i <video.mp4> -vn -acodec pcm_s16le data/user/fpv_dam_001.wav`.
The clip cuts are at about 8.3, 14.8 and 21.2 s.

**What the audio is.** The camera rides on the drone, so it hears the motors and props up close.
That means no propagation and no Doppler, plus frame vibration and the wind of flight.

**The sound.** Strong motor/prop lines sit at **~450–1000 Hz**, with weaker lines at 100–300 Hz.
The throttle sweeps the lines between about 240 and 840 Hz. That is a much higher band than the
camera drones (80–400 Hz for the Matrice, 180–500 Hz for the Mini).

Script: [`sim/experiments/fpv_onboard_analysis.py`](../../sim/experiments/fpv_onboard_analysis.py).
It tracks the dominant 350–1100 Hz line with a ±3% per-frame gate, so it follows throttle sweeps.

| Clip | Span | Line (range) | Fast wobble | Bandwidth | Quietest 2 s |
|---|---|---|---|---|---|
| 1 | 0–8.3 s | 471 Hz (241–641) | 4.9% | 3.5 Hz | 2.4% |
| 2 | 8.3–14.8 s | 687 Hz (464–832) | 3.8% | 3.8 Hz | 3.0% |
| 3 | 14.8–21.2 s | 653 Hz (577–709) | 3.6%* | 4.3 Hz | 2.4%* |
| 4 | 21.2–34.6 s | 731 Hz (495–836) | **2.0%** | 6.2 Hz | **1.3%** |

\* Overlaying the track on the spectrogram shows it hopping between two parallel lines (~620 and
~700 Hz) at 16–17.5 s, which inflates clip 3. Clip 4 tracks one band cleanly. That band visibly
shimmers, because four motor lines are blended in it.

**Steady-stick manual flight is *not* the low-modulation worst case.**
- Even the steadiest 2 s of clip 4 wobbles about **1.3%**, roughly twice the GPS-hover Matrice
  (0.55–0.66%).
- That fits the physics. In acro mode the rate controller still corrects constantly, and a light,
  high-thrust FPV quad needs large RPM changes for small corrections.
- So the true worst case for timing is the **big, stable, GPS-hovering drone**.

### Long-range sim with the FPV audio as the source

Source: clip 4 from 21.5 to 33.5 s, band-limited to 300–3000 Hz to cut the low-frequency wind
rumble. Run with:

```bash
uv run sim/experiments/real_source_tdoa.py --wav data/user/fpv_dam_001.wav --start 21.5 --end 33.5 --band 300,3000
```

Cells show the share of trials with TDOA error under 5 ms, 10 trials each:

| Speed | SNR | lines → fine | 1-bit 1k → fine | bearing → fine |
|---|---|---|---|---|
| hover | +10 | 60% | 50% | 100% |
| hover | 0 | 20% | 0% | **100%** |
| hover | −5 | 10% | 10% | 60% |
| 10 m/s | 0 | 0% | 0% | **90%** |
| 10 m/s | −5 | 0% | 0% | 60% |
| 50 m/s | +10 | 10% | 0% | **100%** |
| 50 m/s | 0 | 10% | 10% | 10% |

**Takeaways:**
- **Bearing-aligned TDOA works on FPV audio** down to 0 dB for slow drones (−5 dB in 60% of trials),
  but needs about +10 dB at 50 m/s. That is about 5–10 dB worse than with the DroneNoise hover
  recordings as the source.
- A likely reason: the onboard audio is mostly tonal lines, with less radiated broadband noise
  than a ground mic picks up. Band-limiting removed even more.
- **Bearing-free coarse stages fail.**
  - *1-bit 1k* only looks at 100–450 Hz, below most of an FPV quad's lines (and the 300 Hz
    source band-limit removed even more).
  - Together with the Matrice's lines sitting *below* the line-feature band, this shows **any
    fixed band will miss some drone class**. The band has to follow each detected drone's own
    harmonic structure.
- **Caveats:**
  - Onboard audio isn't what a ground node hears. Frame vibration and wind on the camera mic
    don't radiate, and the far-field mix of tonal and broadband sound differs.
  - AAC compression may also soften fine detail.
  - The wobble numbers are the reliable part. Treat the sim rows as indicative.

## 5. Next steps

1. **Record the user's drone from the ground at 2+ synced points.** A clap or GPS-PPS marker is
   enough to sync them. Fly in GPS hover (if the quad has it), steady-stick manual, and passes at
   speed. Ground recordings answer what the onboard audio can't: the far-field signature and real
   two-node TDOA.
2. **Choose every band adaptively** (line-feature band, 1-bit coarse band, detector focus) from the
   detected blade-pass rate. Drone classes span ~80 Hz (large camera drones) to ~1 kHz (FPV)
   fundamentals.
3. **Fold real recordings into the noise side as well**: wind, traffic, birds, and other sources
   as negatives for the detector.
