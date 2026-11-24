# Node firmware for the field test

Status: running on two XIAO nRF52840 Sense boards on the bench (one node, one gateway). Not yet run
outdoors or with eight nodes. How to build, flash and log is in `firmware/README.md`; this note
records the design choices and what the bench measured.

## Shape

The firmware is a library (`firmware/`, a Zephyr module) and two small apps:

- **node:** captures the on-board PDM mic at 16 kHz, runs every enabled detector on the same audio
  at the same time, and broadcasts what they report.
- **gateway:** hears every node, prints each record as a JSON line on USB serial for
  `firmware/tools/smlog.py`, and runs the time sync train.

The radio is BLE 5 Coded PHY (S8, the long-range mode) on the nRF52840, with no LoRa. It is
broadcast only: no connections and no pairing, so the number of nodes is not limited by connection
slots.

## Detectors run side by side

Capture fills 512-sample blocks (32 ms) from a shared pool. Each block goes to every detector's own
queue; each detector has its own thread and priority and releases the block when done, and the
block returns to the pool when the last one has. A detector that falls behind loses its own blocks
(counted as drops) without stopping capture or the other detectors.

| Detector | Source | Priority | CPU on chip |
|---|---|---|---|
| Gunshot onset | port of `web/src/detector/impulse.ts` | 2 (high) | under 1 % |
| Drone harmonic comb | port of `web/src/detector/comb.ts` | 13 (lowest) | about 60 % |

The comb port matches the Python reference frame by frame on all 12 cases of
`web/tests/fixtures/comb_parity.json`, with the same tolerances as `web/tests/comb.test.ts`
(`firmware/tests/host`). On the chip its worst frame is 25-36 ms against a 32 ms hop; a slow frame is
absorbed by its queue. The first straight port took 110 ms a frame; scoring only candidates whose
fundamental passes the gate, float window sums and grouped logs brought it down, with parity intact.

Detectors can signal each other through events. The gunshot detector publishes each onset, and the
comb skips frames within 0.6 s of one, as the web node does.

Adding a third detector is one new source file that calls `SM_DETECTOR_DEFINE`, a Kconfig switch, a
record code, and a decoder entry in `smlog.py` (steps in `firmware/include/sonicmesh/detector.h`).

## Settings and debugging at run time

Reflashing eight boards in a field is slow, and the detector thresholds are still guesses, so every
threshold is a run-time parameter. Any module declares one with `SM_PARAM_DEFINE`, as a detector
registers itself, and it can then be read, changed and saved over the USB shell (`sm param ...`).
Saved values live in the storage partition, which reflashing leaves alone. A change to a detector's
parameter re-runs that detector's init in its own thread, between blocks.

Each detector's thresholds are written once, as an X-macro list in its portable header
(`COMB_TUNABLES`, `IMPULSE_TUNABLES`). The list generates the C struct, the board's parameters and the
names in the host replay library (`firmware/tests/host/smdet.c`). So a tuning file found by replaying
recordings on the laptop applies to a board unchanged.

Debug output has two levels of control. Zephyr's log filters (`log enable dbg <module>`) handle human
messages. Trace streams (`sm trace comb 1`) print per-frame detector values as JSON for tools, and
cost one compare when off. The `rec` stream prints every record a node queues, in the gateway's
format, so a node on USB can be tested without a gateway.

`firmware/tools/sm` is the Python side: parameters on several boards, scenario runs through speakers
with scoring, parameter sweeps on hardware or on replay.

Still to do for the field: carry parameter changes in the gateway's sync train, so nodes away from a
laptop can be retuned by radio. The parameter registry is ready for it; the radio side is not built.

## Broadcast format

A frame is one extended advertisement carrying Manufacturer Specific Data (company id 0xFFFF, the
test id): a 5-byte header (magic, version, node id, flags) and then any number of records, each
`type | len | id | payload`. Receivers skip types they do not know, so new detectors need no change
to the radio code or the gateway. Timed records start with the same 5 bytes (time in microseconds,
and a flag saying whether it is network time), so tools can place any record in time. The layouts
are in `firmware/include/sonicmesh/wire.h` and `records.h`.

There are no acknowledgements. Each record rides in 5 consecutive frames about 100 ms apart, and the
gateway drops repeats by (node, record id). Record ids start at a random value at boot, so a
rebooted node's first records are not taken for repeats.

This is not the LoRa protocol in `docs/protocol-v0.md`. The field test does not need its slots,
encryption or MIC, and Coded PHY airtime is short enough that random advertising timing works for
eight nodes.

## Time sync

Shot location needs the nodes' onset times on one clock, to well under a millisecond.

The gateway runs a BLE periodic advertising train at exactly 1 s. The controller transmits it with
no random delay. Once a second the gateway writes its own clock reading into the train's payload.
Every node hears the same payload in the same transmission, so the reading labels that instant for
all of them. The label trails the transmission by a fixed amount, because the train and the label
timer run off the same crystal, and that fixed amount cancels in time differences between nodes. Each
node fits its own clock to the labels by least squares over the last 32 events, for offset and
drift, and drops single stray points.

A node scans only until it finds the gateway. Then it syncs to the train and stops scanning, and its
controller wakes the receiver only for each event. The node has one radio and cannot send while it
listens, so this matters: with continuous scanning the gateway heard about 40 % of a node's frames.

Two earlier designs failed on the bench and are recorded here so they are not tried again:

- **Gateway sends a one-shot advertisement each second and reports when it went out.** The
  "advertising set terminated" callback did not track the transmission: arrivals at the node jumped
  by 150 ms while the reported send times did not.
- **Node listens in a window around each expected beacon.** One-shot advertisements waited for a
  slot on the set's interval, so they wandered by up to ±300 ms (or ±150 ms at a 20 ms interval).

The audio sample clock is measured as well. The PDM rate is not exactly 16 kHz (measured 15,999.25
Hz on one board), and the PDM and kernel clocks use different crystals, so a tracking loop follows
the local time of each block.

## Bench results (two boards, a few cm apart, sounds played through headphones)

| Check | Result |
|---|---|
| Node finds and syncs to the gateway's train | 3.4 s after boot |
| Sync events heard once synced | every event (10 per 10 s) |
| Node clock drift against the gateway | -3 ppm, steady |
| SHOT records delivered, 18 cracks 2 s apart | 18 of 18, each heard in about 4 of its 5 frames |
| Crack spacing in network time | 2.0001 s for cracks played 2.0000 s apart |
| Synthetic harmonic tone, 330 Hz, 10 harmonics | detected at 328-333 Hz, 12 harmonics |

### 21-minute soak, both boards on USB

Recordings played in the first 2.5 minutes: two hover recordings, one FPV clip and four gunshot
files. The rest of the time the room was quiet.

| Check | Result |
|---|---|
| Resets or crashes, either board | none |
| Node synced | at every 10 s status, 121 of 121; drift -3.0 to -3.4 ppm |
| Records at the gateway | 288, none lost (1105 frames, 858 repeats dropped) |
| Comb worst frame / CPU / dropped blocks | 23-25 ms / 60 % / 0 |
| Drone track starts | 3.8 s after the first hover recording began |
| Drone track ends | 73 s after the last drone sound stopped (see below) |
| SHOTs during the gunshot files | 17 |
| SHOTs at other times | 7: three at the edges of the drone recordings, four in the quiet room, each with a rise of 12.2-12.9 dB |

Two problems are tuning problems, not code problems:

- The drone track held on weak, unrelated harmonics (score under 0.01, f0 jumping between 400 and
  1150 Hz) long after the sound stopped. The release rule needs a score floor or a stable-f0
  condition.
- The onset threshold (ratio 16, i.e. 12.0 dB) sits just below ordinary room noises. The quiet-room
  false alarms all cleared it by less than 1 dB.

Both are why the detector settings can now be changed at run time over USB (see below), with no
reflash.

### Replay check and bench chain (node fb98)

`sm run --capture` records the node's audio during a scenario, and `sm check` replays it through the
same detector code on the laptop:

| Check | Result |
|---|---|
| SHOT times, replay vs the board, same audio | match within 0.4 ms (2 of 2 shots) |
| Drone comb, replay vs the board | not shown yet: during a drone sound the capture loses about 4 % of blocks (CPU), and each gap resets the comb's history |

`sm measure` on the bench chain (laptop, Sony MDR7506 earcup over the board, mic):

| Measurement | Result |
|---|---|
| Response, 630 Hz-5 kHz | flat within 2 dB |
| Response, 63-400 Hz | 15-19 dB down (bass escapes the unsealed earcup), so bench tests under-represent low drones |
| Level ladder | linear (slope 1.002) over 60 dB, no clipping at full volume; 0 dBFS played reads 112.9 dB SPL on the assumed scale |
| Quiet room | about 64 dB SPL, steady tones at 187 and 374 Hz (a harmonic pair, likely a fan) and 1331 Hz |

Absolute levels still rest on the mic's stated sensitivity; an SPL meter would fix them.

## Known gaps

- Levels are dB SPL from the mic's stated sensitivity, not calibrated.
- The impulse thresholds are assumed (`docs/gunshots.md`). A loud crack can give two onsets about
  50 ms apart, when its tail re-crosses the threshold just after the 50 ms hold.
- No encryption or authentication on the radio.
- Range, eight-node contention, and outdoor sync have not been measured.
