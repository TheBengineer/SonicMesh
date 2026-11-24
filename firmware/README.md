# SonicMesh firmware

Firmware for the SonicMesh field test on Seeed XIAO nRF52840 Sense boards.

A node captures its PDM microphone, runs every enabled detector at once (drone harmonic comb, gunshot
onset), and broadcasts the records they produce over BLE Coded PHY (long range, S8) extended
advertising. A gateway board on a laptop's USB hears all the nodes, prints one JSON line per record,
and runs the time sync train that the nodes follow.

The firmware is a Zephyr v4.5.0 module. The two applications are `apps/node` and `apps/gateway`, and
both share the library in `lib/` and the headers in `include/sonicmesh/`.

## Layout

| Path | What it is |
| --- | --- |
| `include/sonicmesh/` | Public headers: `wire.h` (frame format), `records.h` (record types), `detector.h` (detector API), `param.h` (run-time parameters), `trace.h` (trace streams), `msg.h`, `audio.h`, `timesync.h`, `radio.h`, `status_led.h`, `diag.h` |
| `lib/` | Shared code: `wire.c`, `msg.c`, `timesync.c`, `status_led.c`, `bootloader.c`, `diag.c`, `param.c`, `shell_cmds.c` (the `sm` shell command). Node only: `audio.c`, `detector.c`, `health.c`, `radio_node.c`. Gateway only: `radio_gateway.c` |
| `detectors/drone_comb/` | Harmonic comb drone detector. `comb.c` is the portable DSP, `drone_comb.c` the Zephyr glue |
| `detectors/gunshot_impulse/` | Gunshot onset detector. `impulse.c` is the portable test, `gunshot.c` the glue |
| `apps/node/` | Node application (`src/main.c`, `prj.conf`, board overlay that enables the PDM mic) |
| `apps/gateway/` | Gateway application (`src/main.c`, `prj.conf`) |
| `apps/common.conf` | Settings both apps build with. `tools/build.sh` passes it as `EXTRA_CONF_FILE` |
| `apps/usb_console.overlay` | USB serial console: 8 KB transmit FIFO and hardware flow control, so output is not cut |
| `Kconfig`, `CMakeLists.txt`, `zephyr/module.yml` | The Zephyr module: options, sources, module registration |
| `tools/` | `install_toolchain.sh`, `build.sh`, `flash.sh`, `smlog.py`, and `sm` with `smtool/` (tuning and bench tests, see below) |
| `tests/host/` | Host tests that need no Zephyr: comb parity, wire format, timing bench; `smdet.c`, the detector cores as a library for offline replay |

## Setup

Run this once on a new machine:

    firmware/tools/install_toolchain.sh

It installs Zephyr v4.5.0 into `~/zephyrproject` and the Zephyr SDK 1.0.1 ARM toolchain into
`~/zephyr-sdk-1.0.1`. It needs about 2-3 GB and is safe to run again.

Serial ports belong to the `dialout` group. Check that your account is in it with `id -nG | grep dialout`.

When a board is in its bootloader it appears as a USB drive labelled `XIAO-SENSE`. udisks mounts it
automatically. If it does not, `flash.sh` mounts it with `udisksctl`.

Install pyserial for the log tool: `pip install pyserial`.

## Build

    firmware/tools/build.sh node
    firmware/tools/build.sh gateway

The outputs are `firmware/build/node/zephyr/zephyr.uf2` (and `zephyr.hex`) and the same under
`build/gateway/`. The `build/` directories are ignored by git.

Extra arguments go to CMake, so any Kconfig symbol from `firmware/Kconfig` can be overridden:

    firmware/tools/build.sh node -DCONFIG_SM_ADV_INTERVAL_MS=200
    firmware/tools/build.sh node -DCONFIG_SM_DETECTOR_GUNSHOT=n

## Flash

    firmware/tools/flash.sh node /dev/ttyACM1
    firmware/tools/flash.sh gateway /dev/ttyACM0

`flash.sh` needs no buttons on a board that runs SonicMesh firmware:

1. It opens the board's serial port at 1200 baud. The running firmware answers that by restarting the
   board into its UF2 bootloader (`lib/bootloader.c`).
2. The bootloader appears as the `XIAO-SENSE` drive on the same USB port. The script finds it by USB
   port, not by name alone, so two boards are not confused.
3. The script copies the `.uf2` to the drive. The board writes it and restarts.
4. The script waits for the serial port to come back with the Zephyr USB vendor id, then reports the
   port.

A board running other firmware may ignore the 1200 baud touch. Double-tap the reset button quickly to enter the bootloader, then run `flash.sh` as usual. The
script finds the drive the same way.

To tell which port is which board, use the USB port path. `udevadm info -q property /dev/ttyACM1 | grep
ID_PATH` shows it, and `ls -l /dev/serial/by-path/` lists the links. Each node and gateway also prints
its identity on its console at boot. A node prints `SonicMesh node` followed by its 4-digit hex id, and
a gateway prints `SonicMesh gateway` followed by a boot line. Unplugging a board and seeing which
`/dev/ttyACM*` disappears also works.

## Run a field test

Before going out, prepare each node on USB:

    firmware/tools/sm deploy --flash          # every node plugged in; leave out --flash to only check

`sm deploy` optionally flashes the node app, applies the field settings in `tools/smtool/field.json`
(only values that differ: setting a detector parameter restarts that detector), saves them, and checks
time sync to a gateway on air, audio rate, mic level, battery and that both detectors are on. It prints
one PASS/FAIL line per node and appends a record to `data/field/deploy-YYYYmmdd.jsonl`. Use
`--no-sync` with no gateway running and `--names names.json` to print friendly names.

To find how far apart nodes can be, walk the radio range: set one node to send HEALTH every second
(`tools/sm set --port <node> health.period_s=1`, not saved), power it from a power bank at mounting
height, and carry the laptop with the gateway away from it:

    firmware/tools/sm range

Type the distance (or any note) and Enter at each stop. Every 2 s it prints records received and lost,
RSSI, copies heard per record (of `radio.repeats`) and the node's sync state; at the end a table per
mark. It logs to `data/field/range-*.jsonl`. Reboot the node afterwards to return to its saved period.

Every board runs a hardware watchdog (`lib/watchdog.c`, 30 s): a hung board restarts itself, reported
as reset cause 0x10. `sm wdt` shows its state and `sm wdt test` stops feeding it, to check it.

1. Plug the gateway into the laptop, and note its port (`ls /dev/ttyACM*`).
2. Start the logger:

       python3 firmware/tools/smlog.py --port /dev/ttyACM1

   It prints each decoded record and a status table every 10 seconds, and writes every line to
   `data/field/smlog-YYYYmmdd-HHMMSS.jsonl` at the repository root. Use `--out` for another path and
   `--quiet` to print only the status table. `data/` is local only and is never committed or bundled.
3. Power the nodes from USB power banks. Each node prints its status block on its own console.
4. Watch for the gateway boot line. It is printed as a banner, for example:

       GATEWAY BOOT cause=0x1 (reset pin) crashes=0

   `cause` is the hardware reset cause (zephyr `RESET_*` bits: 0x1 pin, 0x2 software, 0x4 brownout,
   0x8 power-on, 0x10 watchdog, 0x20 debug, 0x100 CPU lockup). `crashes` counts fatal errors since power
   on, so a number above 0 means the gateway has crashed and recovered.

### LEDs

Node:

- Green on while the node is synced to the gateway's time (updated every 10 seconds). A short green
  flash at boot.
- Blue on while the drone detector is on.
- Red flash for 150 ms at each gunshot onset.
- Red solid if the radio or the microphone did not start.

Gateway:

- Blue flash at boot.
- Green flash of 20 ms for each sync label it writes (once per second).
- Blue flash of 30 ms for each drone record received, red flash for each shot record.
- Red solid if the radio did not start.

### Node console status block

Every `health.period_s` (10 s) a node prints a block like this (values are examples):

    [node fb98] up 120s  level 66.0 dB  max 72.0 dB  clips 0  rate 15999.25 Hz  batt 4112 mV
      sync: yes  last event 0.3s ago  fit 32 pts  drift -3.0 ppm
      radio: 4 records pending, 0 dropped
      drone_comb   blocks 240  drops 0  cpu 60%
      gunshot      blocks 240  drops 0  cpu 1%

- `level` is the mean sound level over the period and `max` the loudest 32 ms block, both in dB SPL
  from the assumed microphone sensitivity (see Known limits).
- `clips` counts samples at full scale. `batt` is the battery voltage (on USB power with no battery it reads the charger output).
- `sync` says whether the node's times are network time, when the last sync event arrived, how many points
  are in its clock fit, and the drift it has fitted.
- `radio` shows records waiting to be sent and records dropped because the pool was full.
- Each detector line shows blocks processed, blocks it missed because its queue was full, and its share
  of CPU.

`sm param set health.print 0` turns the block off; the HEALTH record is still sent.

## Change settings and debug without reflashing

Both apps have a shell on the USB serial port (any terminal, e.g. `screen /dev/ttyACM0 115200`, or the
`tools/sm` tool). Commands answer in JSON lines, ending with `{"k":"ok",...}` or `{"k":"err",...}`:

| Command | What it does |
| --- | --- |
| `sm info` | role, node id, build time, counts of parameters and trace streams |
| `sm status` | sync, drift, levels, battery, queue and drop counters as one JSON line |
| `sm param list [prefix]` | every parameter with value, default, range and help |
| `sm param set <name> <value> ...` | change in RAM, range-checked; several pairs at once |
| `sm param save` | write every changed parameter to flash; `sm param reset [name]` then `save` undoes |
| `sm trace` / `sm trace comb 1 audio 1` / `sm trace off` | list, start and stop trace streams |
| `sm send <type> [hex]` | queue a raw record, to test the radio path without sound |
| `sm capture <seconds>` / `sm capture stop` | stream the audio exactly as the detectors receive it (node; see below) |
| `sm reboot`, `sm bootloader` | restart; restart into the UF2 bootloader |
| `sm wdt`, `sm wdt test` | watchdog state; stop feeding it (the board restarts within 30 s) |
| `log enable dbg sm_audio`, `log status` | Zephyr's own per-module log levels |

**Parameters** are named `<group>.<name>`: `gunshot.ratio_db`, `drone_comb.theta`,
`audio.full_scale_db` (the mic calibration), `health.period_s`, `radio.repeats`, and
`<detector>.enable` for each detector. Saved values live in the board's storage partition, which UF2
reflashing does not touch, so a board keeps its tuning across firmware updates. A saved value that a
new build no longer has, or whose range it no longer allows, is ignored with a warning at boot.

A change to a detector's parameter re-runs that detector's init in its own thread before its next
block, so the new value applies within 32 ms. It also resets that detector's state (an open drone
detection is closed with an END record).

**Trace streams** print machine-readable lines, `{"k":"tr","s":"<stream>","t":<local us>,...}`:
`audio` (level per block), `impulse` (onset test per block), `comb` (every comb frame; level 2 adds
the slowest step), `rec` (every record the board queues: the gateway's fields, with the type in `ty`). They go through the
log buffer; two streams at once (about 60 lines a second) were sent without loss on the bench.

**Capture** (`lib/capture.c`) is registered as a detector, so it gets the same blocks, and sends each
one as a JSON line (base64, about 43 kB/s). Its sending thread has the lowest priority, so capturing
never changes what the detectors do: when CPU is short the capture has gaps (counted, and visible as
missing sample numbers) and the detectors drop nothing. On the bench a capture with only the `rec` trace
on had no gaps in a quiet room. While a drone sound plays the comb uses more CPU and the capture lost
about 4 % of its blocks; with another trace stream on as well it lost 17 %. `sm measure` switches the
comb off while it measures. `sm` subcommands can be added from any file with
`SHELL_SUBCMD_ADD((sm), ...)`, as capture does.

**`tools/sm`** (`tools/smtool/README.md`) drives all of this from Python: read and write parameters on
several boards, apply a tuning file, record traces, play test clips through speakers and score what the
boards report, sweep a parameter, and replay WAV files through the same detector C code on the laptop
(`make -C firmware/tests/host lib` first). A tuning file is a flat JSON object of parameter names and
values, and means the same to a board and to the replay.

## Architecture

- **Audio capture** (`lib/audio.c`, priority 1). One thread reads the PDM microphone at 16 kHz in
  512-sample blocks (32 ms). A DC blocker removes the microphone offset.
- **Shared blocks.** Each block is taken from a pool of `CONFIG_SM_AUDIO_BLOCKS` slots and handed to
  every detector. The block is read-only and reference-counted, and returns to the pool when the last
  detector releases it.
- **Detectors** (`lib/detector.c`). Each detector has its own message queue of up to
  `CONFIG_SM_DETECTOR_QUEUE` blocks and its own thread at its own priority. If a detector falls behind,
  it drops its own blocks and counts them, so capture keeps running. Priorities: gunshot 2, comb 13.
- **Event bus.** `sm_event_publish` runs a detector's `on_event` in the publisher's thread. The gunshot
  detector publishes `SM_EVT_IMPULSE` at each onset. The comb listens and skips any 1024-sample frame
  that overlaps the 0.6 s after a shot, so a crack's tail does not read as a drone.
- **Health** (`lib/health.c`, priority 11). Sends the `HEALTH` record and prints the status block.
- **Logging** runs in its own thread at priority 10: after audio and onset (1 and 2), before health and the
  comb (11 and 13).
- **Outgoing records** (`lib/msg.c`). Any thread queues a record with `sm_msg_send` or
  `sm_msg_send_timed`. Records wait in a pool of `CONFIG_SM_RECORD_POOL` entries. Each advertising
  event carries the oldest pending records in one frame, and each record rides in
  `radio.repeats` (default 5) consecutive frames, because broadcast has no acknowledgements.
- **Radio** (`lib/radio_node.c`). Frames are non-connectable extended advertisements on Coded PHY,
  every `CONFIG_SM_ADV_INTERVAL_MS`. The gateway (`lib/radio_gateway.c`) listens on Coded PHY and drops
  repeats by (node, record id), so each record is printed once.

### Frame format

The byte layout is in `include/sonicmesh/wire.h`, and each record type's payload is documented in
`include/sonicmesh/records.h`. In short, a frame is manufacturer data with company id 0xFFFF (reserved
for testing): magic `'S'`, version 1, node id, flags, then records. Each record is type, length, id,
payload. A receiver skips types it does not know, so new detectors need no change to the radio path or
to older tools.

### Time sync

The gateway runs a periodic advertising train with period `CONFIG_SM_SYNC_PERIOD_MS` (1000 ms). Once per
period it rewrites the train's payload with its own clock, which is the `SYNC` record (`label_us`,
`period_ms`). Every node hears the same label in the same transmission. A node scans in short windows
until it finds the train, then follows it and stops scanning, so its radio can keep sending. It fits its
own clock to the labels by least squares over the last 32 points, for offset and drift. Timed records
carry a flag saying whether their time is network time. `include/sonicmesh/timesync.h` has the full
explanation.

## Adding a detector

The detector API is in `include/sonicmesh/detector.h`. The steps are:

1. Write `detectors/<name>/<name>.c` with an init function, a process function (called with each audio
   block), and optionally an `on_event` function. Register it with `SM_DETECTOR_DEFINE`. It gets the
   parameter `<name>.enable` for free.
2. Pick a record code from 0x20 to 0x7F and add it to `enum sm_record_type` in
   `include/sonicmesh/records.h`, with its payload documented beside it.
3. Add a Kconfig entry inside the `if SM_ROLE_NODE` block of `firmware/Kconfig`.
4. Add the source to `firmware/CMakeLists.txt`, following the existing detector lines.
5. Add the decoder to `tools/smlog.py`: one entry in `RECORD_TYPES`, and the code in `TIMED` if the
   record starts with a timed header. Add a hand-built payload to `selftest()`.
6. Make its thresholds parameters instead of `#define`s, named `<name>.<setting>`, and read them in
   init. Keep the portable core (no Zephyr) separate from the glue, with the settings in one X-macro
   list as `COMB_TUNABLES` and `IMPULSE_TUNABLES` do, so the same list feeds the board's parameters and
   the replay library (`tests/host/smdet.c`).
7. Optionally add a trace stream for its per-frame values (`SM_TRACE_DEFINE`, `SM_TRACE`).

In the example below, the threshold would become a parameter like this, and `clap_init` would read it
(the variable is `sm_clap_peak_counts`):

```c
SM_PARAM_DEFINE(clap, peak_counts, int, 12000, 100, 32767, NULL, "block peak that counts as a clap");
```

A minimal example, `detectors/clap/clap.c`, reports any block whose peak is above a threshold:

```c
#include <stdlib.h>

#include <zephyr/kernel.h>

#include <sonicmesh/audio.h>
#include <sonicmesh/detector.h>
#include <sonicmesh/msg.h>
#include <sonicmesh/records.h>
#include <sonicmesh/wire.h>

#define CLAP_PEAK_COUNTS 12000
#define CLAP_HOLD_US (500 * 1000)

static int64_t next_ok_us;

static int clap_init(void)
{
	return 0;
}

static void clap_process(const struct sm_block *blk)
{
	int peak = 0;
	uint32_t at = 0;

	for (uint32_t i = 0; i < blk->n; i++) {
		int v = abs(blk->pcm[i]);

		if (v > peak) {
			peak = v;
			at = i;
		}
	}
	if (peak < CLAP_PEAK_COUNTS) {
		return;
	}

	int64_t t_us = sm_block_time_us(blk, at);

	if (t_us < next_ok_us) {
		return;
	}
	next_ok_us = t_us + CLAP_HOLD_US;

	uint8_t body[2];

	sm_put_u16(body, (uint16_t)peak);
	sm_msg_send_timed(SM_REC_CLAP, t_us, body, sizeof(body));
}

SM_DETECTOR_DEFINE(clap, clap_init, clap_process, NULL, 1024, K_PRIO_PREEMPT(5));
```

With `SM_REC_CLAP = 0x20` in `records.h`, the Kconfig entry and CMake line follow the drone and gunshot
ones:

```
config SM_DETECTOR_CLAP
	bool "Clap detector (example)"
	default n
```

```cmake
  zephyr_library_sources_ifdef(CONFIG_SM_DETECTOR_CLAP
    detectors/clap/clap.c
  )
```

The decoder for `tools/smlog.py`:

```python
def dec_clap(b):
    (peak,) = struct.unpack_from("<H", b)
    return {"peak": peak}, f"peak {peak} counts"

RECORD_TYPES[0x20] = ("CLAP", dec_clap)   # or add 0x20 to the dict literal
TIMED.add(0x20)
```

Choose the priority to match the work. Short, timing-sensitive detectors go above the heavy ones (lower
number runs first). Timestamps come from the block, so priority affects latency, not accuracy. Enable the
detector with `-DCONFIG_SM_DETECTOR_CLAP=y`, or make it `default y` while developing.

## Tests

- `make -C firmware/tests/host test` builds and runs every `test_*.c` there. `test_comb` checks the C
  comb against the web implementation's fixture (`web/tests/fixtures/comb_parity.json`, converted into
  `tests/host/build/`). `test_wire` checks the frame format and prints a frame that
  `smlog.py --selftest` decodes.
- `make -C firmware/tests/host bench` times `comb_step` on 20 seconds of drone and of noise. It is not
  part of `test`.
- `python3 -m unittest discover -s firmware/tools/smtool/tests` checks the Python tool offline: shell
  protocol parsing, replay on synthetic clicks and tones, resampling, scoring.
- `python3 firmware/tools/smlog.py --selftest` checks every record decoder, the reset-cause names, the
  boot and sync line handling, and the C-built frame.

## Known limits

- Levels are dB SPL from an assumed microphone sensitivity (parameter `audio.full_scale_db`, default
  120 dB SPL at full scale). They are not calibrated.
- The gunshot onset thresholds are assumed, not tuned on recordings (`docs/gunshots.md`). One loud crack
  can give two onsets about 50 ms apart.
- Battery voltage uses the XIAO's on-board divider and the nominal resistor values; it has not been
  checked against a meter.
- The radio has no encryption or authentication. Company id 0xFFFF is the test id.
- CPU is the tightest resource: the comb uses about 60 % in quiet and up to 80 % with a drone playing,
  which is why capture cannot be lossless while the comb is busy. A third detector needs CPU headroom.
- The comb runs at about 60 % of the CPU. Its worst step is about 25-36 ms against a 32 ms budget. A slow
  frame is absorbed by the detector queue, and the queue drops blocks only when it is full.
