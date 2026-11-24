# smtool: tuning and test tool for node firmware

`firmware/tools/sm` is the launcher. Everything else is in this package. Run `sm --help` or
`sm <command> --help` for the options. Python 3.14, standard library, numpy and pyserial only.

Build the replay library once (offline commands need it):

    make -C firmware/tests/host lib

Commands that touch a board take `--port` (repeat it for several boards). Ports are `/dev/ttyACM*`.

## Commands

| Command | What it does |
|---|---|
| `sm ports` | Lists boards with role and node id (sends `sm info`). |
| `sm params --port P [prefix] [--json]` | Lists parameters with value, default, range and help. |
| `sm get --port P names...` | Reads parameters. |
| `sm set --port P name=value ... [--save]` | Sets parameters in RAM, checks each echo, optionally saves. |
| `sm save --port P` | Saves every changed parameter to flash. |
| `sm reset --port P [name]` | Resets one parameter, or all, to default in RAM. |
| `sm apply --port P tuning.json [--save]` | Applies a tuning file. Names the board lacks are skipped with a note. |
| `sm dump --port P > tuning.json` | Writes the board's non-default values as a tuning file (one board). |
| `sm trace --port P comb=1 audio=1 [--seconds N] [--out f.jsonl]` | Turns trace streams on, records every JSON line with host receive time `w`, turns them off at exit or Ctrl-C. |
| `sm replay WAV\|scenario.json... [--tuning f] [--set name=value] [--full-scale-db 120] [--gain-db 0] [--channel n] [--quiet-spl 40] [--out events.jsonl] [--frames frames.jsonl] [bench chain options]` | Runs both detectors offline and prints SHOT and DRONE events with file times. A scenario file replays its whole timeline and prints the score line (latency, tail). The header names the chain used. |
| `sm label WAV [--ratio-db 25]` | Strict replay of one clean recording; prints SHOT times as a JSON list to paste into a scenario. |
| `sm run scenario.json --node P [--node P...] [--gateway P] [--tuning f] [--set n=v] [--trace comb=1] [--max-s N] [--tol 0.03] [--capture]` | Plays the scenario through the speakers and records every board. Writes a run directory. `--capture` also records the first node's audio into the run directory. |
| `sm capture --port P --seconds S [--out f.wav] [--play clip.wav]` | Records one board's audio as its detectors receive it (up to 600 s). Writes a 16-bit WAV and `f.wav.json`. `--play` plays a clip with paplay while recording. `sm capture --port P --stop` ends a capture that is running. |
| `sm check RUN_DIR` | Replays the run's `capture.wav` through the detectors with the node's parameters, compares the result with the node's own SHOT and DRONE events, and writes `check.json`. |
| `sm sweep (--replay \| --node P ...) scenario.json --vary name=v1,v2 [--vary ...] [--tuning base.json] [--max-s N] [--quiet-spl 40] [bench chain options, replay only]` | Runs every combination and prints a table sorted by cost. Each line of `results.jsonl` records the chain (profile paths, levels offset). |

Bench chain options (replay and `sweep --replay`; see "Bench chain" below):

    --bench fb98                       newest response, levels and noise profiles of node fb98
    --response P  --levels P  --noise P  explicit profiles (override one kind of --bench)
    --noise-bed / --no-noise-bed       room noise under clips too (default on with --noise or --bench)

Parameter names are the board's: `gunshot.<name>` for the impulse test, `drone_comb.<name>` for the comb
(including `drone_comb.update_ms` and `drone_comb.shot_mask_ms`), `audio.full_scale_db`. Replay reads the same
names. Board-only names (for example `radio.repeats`) are noted and ignored by replay.

Exit status: 0 ok, 1 usage or device error, 3 a hardware run stopped by its max duration, 130 interrupted.

## Tuning workflow

1. Replay sweep on the scenario, offline, to pick candidates:

       sm sweep --replay firmware/tools/smtool/scenarios/bench_mixed.json --vary gunshot.ratio_db=12,15,18

2. Put the chosen values in a tuning file (`{"gunshot.ratio_db": 15}`) and apply them to the boards:

       sm apply --port /dev/ttyACM0 --port /dev/ttyACM1 tuning.json

3. Confirm on hardware. Each run is recorded and scored:

       sm run firmware/tools/smtool/scenarios/bench_mixed.json --node /dev/ttyACM0 --gateway /dev/ttyACM1

4. Only when the run is good, save to flash on each board: `sm save --port ...`. Values set with `sm set` or
   `sm apply` are RAM only until saved.

A hardware sweep (`sm sweep --node ...`) does step 3 for each combination and restores the boards' previous
values at the end.

## Scenario files

```json
{
  "name": "bench_mixed",
  "gap_s": 4,
  "clips": [
    {"kind": "gunshot", "path": "data/gunshots/oga-gunshot-sounds/sounds/cz.wav", "shots": [0.52], "gain_db": 0},
    {"kind": "drone", "path": "data/dronenoise/Ed_3p_10_H00_N_C_nw_ev1_M1.wav"},
    {"kind": "quiet", "silence_s": 60}
  ]
}
```

- `kind`: `gunshot`, `drone` (a drone clip, including FPV), or `quiet` (no file; `silence_s` seconds).
- `path`: relative to the repository root, or absolute.
- `shots`: times in seconds from the start of the clip. Leave it out to count SHOTs inside the clip without
  labels (they cost nothing, so misses are not counted).
- `gain_db`: default 0. Replay scales the file; hardware uses paplay's volume.
- `gap_s`: silence before the first item, between items and after the last.

The timeline is the items with gaps. Replay and hardware follow the same timeline, so the scoring windows match.
Quiet time in replay is 40 dB SPL white noise (`--quiet-spl` on sweep and replay), unless a noise profile is
given (see "Bench chain"); the gaps are the same noise.

## Bench chain

Replay can model the measured bench chain (`sm measure`, see MEASURE.md). Without these options replay is the
plain model: file samples scaled by the full-scale assumption, 40 dB SPL white noise for quiet time. Three
parts, each optional:

- `--response PROFILE`: every clip is filtered by the measured response (the chain's magnitude, 1 kHz = 0 dB)
  before scaling. Quiet noise is not filtered. The filter is minimum-phase and adds no delay.
- `--levels PROFILE`: sets the playback level. The levels profile's fit gives `spl_at_0dbfs` (112.86 dB SPL for
  fb98), measured at the levels profile's own full scale (120). Each clip gets the offset
  `spl_at_0dbfs - 120` (-7.14 dB) added to its gain, so a 0 dBFS sine lands at `spl_at_0dbfs` at the mic.
- `--noise PROFILE`: quiet time is the measured room noise (band levels and stationary tones) instead of white
  noise. `--noise-bed` (default on with `--noise`) also adds it under every clip, since the room is always there.
  The bed is added after the response, because the room is not played through the headphones.

How the scale combines, for a clip sample x in [-1, 1] with gain `gain_db` (the scenario item's, or
`--gain-db` for WAV files) and detector full scale `F` (`--full-scale-db` for WAV files, `audio.full_scale_db`
in a scenario or tuning file):

    pascals = x * pa_factor(F, gain_db + levels_offset)    levels_offset = spl_at_0dbfs - profile full scale

`F` still sets the counts-to-pascals scale of the detectors, as it does on the board, so changing it moves clip
levels: with the fb98 profile and F = 120, a 0 dBFS sine is 112.86 dB SPL; F = 100 gives 92.86 dB SPL. Clip gain
adds in dB on top. Without `--levels`, `levels_offset` is 0 and the plain model applies.

`--bench NODE` picks the newest `response`, `levels` and `noise` profile of NODE in `data/bench/profiles` (file
names start with the UTC stamp). `--bench DIR` does the same in a directory holding one node. An explicit option
overrides one kind. A missing kind is noted and that part is off. The chain is printed in the replay header and
recorded per point in `results.jsonl`.

    sm sweep --replay firmware/tools/smtool/scenarios/bench_mixed.json --bench fb98 --vary drone_comb.theta=0.10,0.13
    sm replay data/bench/hover_M5_quiet30.json --bench fb98 --set drone_comb.hold_ratio=2.0

A scenario file can be given to `sm replay`: its whole timeline is run and the score line gives the drone
latency, tail and quiet shots. `data/bench/` is local output and is not committed.

Shipped: `scenarios/bench_mixed.json` (four gunshot files, two dronenoise `H00` files, one FPV clip, 60 s quiet),
`scenarios/quiet.json` (5 minutes quiet, for false alarms). The gunshot entries have no labels yet (see Limits).

## Capture and the replay check

`sm capture` streams the audio that the node's detectors receive (after the DC blocker, as raw int16 counts,
at the board's real rate of about 15999.25 Hz). The WAV is written at the nominal 16000 Hz, and the sidecar
`<file>.json` holds the node, `first_sample` (board sample index of the first sample), `t0_local_us` (the
board's local time of that sample), `rate_hz` (the measured rate), `gaps` (`[index, length]` in samples,
zero-filled in the WAV), the board's own gap count, `start_host` (host time the capture started), and the
parameters and playback when given. A gap is a jump in the board's sample index, so a line the shell dropped
shows up as a gap; the count of blocks alone is not trusted.

`sm run --capture` records the first node for the whole timeline plus 5 s into `capture.wav` (+ sidecar). The
capture's audio lines go to that file and are left out of `lines.jsonl`. The rec trace and events work as
before. The capture is stopped and waited for if the run aborts.

`sm check RUN_DIR` answers whether the replay agrees with the board:

- The capture is trimmed to the board's 512-sample block grid (`first_sample % 512` samples are dropped; a
  capture normally starts on a block boundary, so this is usually 0). The comb steps every 512 samples from
  the start of the replay, so this alignment matters.
- The parameters are the node's values at the run start: those before the run, with the run's `set` values
  applied. `audio.full_scale_db` sets the counts-to-pascals scale: pa = counts / 32768 * 20e-6 *
  10^(fs/20) * sqrt(2).
- Replay event times (sample index / 16000) are placed on the board's clock through `t0_local_us` and
  `rate_hz`, then on host time through the same node clock fit that `sm run` uses for its events.
- SHOT pairs must lie within 5 ms, DRONE starts and ends within 100 ms. The report gives the counts that
  match on each side, the median and maximum difference of the pairs, and a shift (the median nearest
  neighbour gap within 0.5 s), so a whole-run offset shows even when nothing pairs up.
- The verdict is `replay matches the board` when nothing is unmatched and no shift is found, else what differs.
  Gaps in the capture are noted, since events near them may differ.

## Run directory

`sm run` writes `data/bench/<UTC stamp>-<scenario name>/` (data/ is never committed):

- `lines.jsonl`: every line from every port: `{"port", "w" (host receive time), "raw" (the line as sent)}`.
  Audio (`pcm`) lines are not written here; see `capture.wav` below.
- `capture.wav` and `capture.wav.json`: with `--capture`, the first node's audio (see above).
- `check.json`: written by `sm check`: the capture used, the parameters, the SHOT and DRONE comparisons and the verdict.
- `play.jsonl`: one line per item: `index`, `kind`, `path`, `shots`, `gain_db`, `start`, `end` (host seconds).
- `events.jsonl`: decoded SHOT and DRONE events. `source` is `node` (a node's rec trace, timed by the node's
  clock through a fit) or `gateway` (a gateway rec line, timed by host receive time). `t` is host seconds.
- `params.json`: every parameter of every board before the run (`ports`), the values the run set (`set`),
  and the values before the run (`before`).
- `summary.json`: the scores for each source, and clock drift per node (ppm). Also printed as a table.

`sm sweep` writes `data/bench/<stamp>-<name>-sweep/results.jsonl` (one line per point: overrides, cost, totals,
per-window rows) and prints the table sorted by cost.

## Scoring and cost

Matching: a label is a hit if a SHOT lies within `--tol` (default 0.03 s) of it after the latency offset. For
hardware runs the offset is the median of (SHOT - label) over nearest matches within 0.3 s; it is reported in
`offset_s`. Replay uses offset 0.

Clip windows include 20 ms either side (onsets are stamped on a 1 ms grid).

Per clip kind:
- gunshot with labels: hits, misses, and extra SHOTs inside the clip. Unlabelled: SHOTs counted, no cost.
- drone: detected if a START comes within the clip or 2 s after its end; latency = START minus clip start;
  tail = how long the on interval lasts after the clip end; f0 from START and UPDATE events.
- quiet time (outside gunshot and drone clips, gaps included): SHOTs are quiet shots; DRONE-on time that no
  drone clip explains is false drone time.

Cost (lower is better):

| Term | Weight |
|---|---|
| missed label | 5 per miss |
| extra SHOT (inside a labelled gunshot or drone clip, unmatched) | 2 each |
| quiet SHOT | 5 each |
| drone tail after a drone clip | 0.2 per second |
| drone clip not detected | 10 each |
| mean drone latency over detected clips | 0.5 per second |
| false drone-on time | 0.2 per second |

Both sources are scored in hardware runs. The `node` source is the primary; SHOTs heard by several nodes within
50 ms count once.

## Time limits

- Serial commands give up after 5 s without an ok or err line (`CommandTimeout`).
- `sm run` and hardware `sm sweep` stop after `--max-s` seconds (default: scenario timeline length + 120 s).
  On expiry they turn node traces off, kill paplay and exit 3.
- Use `timeout` around long commands in scripts, for example `timeout 600 firmware/tools/sm sweep ...`.

## Limits and notes

- A capture (`sm capture`, or `sm run --capture`) streams about 43 kB/s of text over the same USB shell that
  carries the node's trace lines. Trace and record lines are timed by the node's clock, so a slow stream could
  delay them; check the clock drift in `summary.json` after a run with `--capture`.
- `sm check` uses the replay library, so it needs `make -C firmware/tests/host lib` (as for the other offline
  commands). Parameters the library does not take make the check stop with a message.

- The gunshot files in `data/gunshots/oga-gunshot-sounds` are not isolated shots: they are sustained loud
  recordings. `sm label` at the default ratio finds no shots in any of the four, and at 6 dB finds many. The
  shipped scenario therefore has no labels for them; add labels by hand after listening.
- The comb does not start a track for a tone that is already present at the first sample (start-up treats it
  as a jump). Fade tones in over a second, as real recordings do.
- On white noise after a tone stops, the comb keeps a track on for about 13 s in the synthetic test, far more
  than the 32-hop hold. Real drone tails are measured by `sm run`.
- A node's `rec` trace line has the trace's local time in `"t"` and the record type in `"ty"`; a gateway
  `rec` line has the type in `"t"` and its clock in `"g"`.
