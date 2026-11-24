# Measured bench chain and room noise

`sm measure` measures the bench chain (laptop, headphones, air, the board's PDM mic, the DC blocker) and the room
noise, so replay and the simulation can use the same chain the boards hear. Code: `measure.py` (measurement),
`response.py` (applying a profile). Profiles are JSON under `data/bench/profiles/` (local only, never committed).

## Commands

    sm measure response --port P [--level-dbfs -12] [--repeat 2] [--chain "..."]
    sm measure levels   --port P [--chain "..."]
    sm measure noise    --port P [--seconds 60] [--chain "..."]

`--chain` is free text stored in the profile. Keep it accurate: a profile records what it was measured with, and
the bench, field and reference-meter measurements are different chains.

- `response` plays an exponential sweep (50 Hz to 7.5 kHz, 10 s, 1 s silence either side) at `--level-dbfs`. It
  prints the magnitude in 1/3-octave bands relative to 1 kHz. Bands from 63 Hz to 6.3 kHz are valid; the sweep
  does not cover the rest.
- `levels` plays 1 kHz tone steps from -60 to 0 dBFS in 6 dB steps, 1 s each. It reports the board level in dB
  SPL per step, the noise floor, THD, the linear range, the clip onset and a gain fit over the linear part.
- `noise` records with nothing played. It reports the level, the 1/3-octave spectrum (25 Hz to 6.3 kHz) and the
  stationary tones: peaks more than 10 dB above the local spectral median, with a stationary fraction.

## Method

- Counts become pascals with `audio.pa_factor(full_scale_db)/32768`, the node's own scaling. `full_scale_db` is the
  board's `audio.full_scale_db` (default 120). A full-scale sine has RMS level `full_scale_db` dB SPL, so a tone at
  `dBFS` in digital reads about `full_scale_db + dBFS` dB SPL at the mic if the chain is flat.
- Sweep: Farina inverse filter. The recording is resampled from the board's measured `rate_hz` to the 16 kHz grid
  of the played file, which removes the board's clock offset (a 50 ppm error moves a 10 s sweep by about half a millisecond). The response is the
  band-mean power of a 120 ms impulse-response window at the peak. `--repeat` averages band powers.
- Latency: from the start of the sweep to the impulse-response peak. Informational only.

## How replay and simulation should call it

    from smtool import response

    profile = response.load_profile("data/bench/profiles/<stamp>-<node>-response.json")
    x = response.apply_response(x16k, 16000, profile)     # float in, float out, same length, no delay

    noise = response.load_profile("data/bench/profiles/<stamp>-<node>-noise.json")
    pa = response.noise_from_profile(noise, seconds, 16000, rng)   # pascals at the mic

- `apply_response` designs a minimum-phase FIR (1024 taps) from the magnitude, interpolated smoothly over log
  frequency and normalised at 1 kHz. It adds no delay, so replay timelines stay the same. Apply it to the file
  samples before scaling to pascals, or to the pascal chunks; it is scale-free either way.
- `noise_from_profile` returns pascals, the units of `replay.quiet_chunks`. Quiet time in replay is 40 dB SPL white
  noise today; a noise profile replaces it. Generate in chunks for long timelines.
- Use the `levels` profile to check that the playback level is in the linear range. Above `clip_onset_dbfs` the
  response no longer applies.

## Limits

- The response is the whole bench chain combined: headphones, air, board mic, DC blocker and the PDM decimator.
  Separating the mic needs a reference mic, or a speaker with a known response, measured in the same room.
- Outside the valid bands the FIR holds the nearest valid value: flat below 63 Hz and above 6.3 kHz (the chain above
  7.1 kHz is unmeasured). The noise profile has nothing below 25 Hz (a board's DC blocker removes it anyway).
- The noise profile is one realisation of random noise with the measured band levels: bins are equal on average
  within a band, not the measured fine structure. Tones are added at their measured levels and phase is random.
- The noise measured on the bench is the bench room. Recordings the owner makes in the woods with a phone carry the
  phone's own microphone response, which is not the board's. Do not mix the two without labelling the chain; a
  profile for each phone needs its own response measurement.
- Stationary tones are measured over one recording. A tone that is present only part of the time shows a
  stationary fraction below 1.
- The sweep assumes paplay plays 16 kHz samples at the nominal rate. Whatever the host does to the sound is part of
  the measured chain, not corrected for.
