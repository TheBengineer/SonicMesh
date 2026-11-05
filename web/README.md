# SonicMesh web demo

Browser simulation of the perimeter. Milestone M0: world, flight, editing, record and replay, provenance. See
[docs/web-demo-plan.md](../docs/web-demo-plan.md) for the plan.

## Run

```sh
cd web
npm ci
npm run dev      # http://localhost:5173
```

## Build and test

```sh
npm run build    # static site in dist/
npm test         # Vitest: clock, replay, scenario schema, provenance
npm run typecheck
```

## Spec notes

`docs/protocol-v0.md` fixes the frame envelope and most message fields. These are the readings
taken where v0 leaves a layout or policy open:

- **Frame layout.** Fields are bit-packed LSB-first and little-endian. A frame is
  `hdr | src | ctr | payload | mic(4)`. The MIC is the first four bytes of AES-CMAC over
  `siteId` (2 B LE) + `fullCounter` (4 B LE) + `hdr..payload`.
- **Variable-length payloads.** The beacon carries its slot map (6-bit count, `node:8`,
  `action:3`, `arg:5` entries), snippet requests (3-bit count), and commands (4-bit count).
  Track state is padded to 88 bits. `DETECT` is padded with 7 reserved bits to 8 B. `JOIN`
  latitude and longitude are signed 32-bit. Health keeps the fields raw, in `HEALTH_FIELDS`
  order.
- **Snippet data.** Snippet payload bits are stored byte-aligned rather than as a bit stream,
  so the hex view lines up with the audio bytes.
- **Beacon budget.** The beacon's own airtime plus its slot map must fit the 250 ms (idle) and
  25 ms (event) windows. The map is capped at 7 idle and 8 event assignments; a larger node
  count leaves later nodes out of that superframe.
- **Ranging.** The MAC models the `RANGING_RESULT` frame only, not the full RTToF request and
  response exchange. Ranging runs every fourth idle superframe, rotates through links, and is
  limited to the slots left after health reports.
- **Alert retry.** A node repeats `DETECT_START` until the gateway decodes it. When event mode
  starts, other pending alerts are cleared.
- **Health and energy.** Health reports are sent every 75 idle superframes, staggered by node
  id. Battery, solar, temperature, drift, and uptime come from a small assumed energy model;
  the UI marks those fields ASSUMED and the link and audio fields MODELLED.

## Controls

- Drone: WASD or arrows move, Q/E down/up, gamepad sticks. M toggles manual and GPS-hover flight.
- World: click to select, drag nodes and the gateway on the ground. Use the Add node and Add drone buttons, then click the ground. Selecting opens a pop-up window with the object's tabs, joined to it by a tail. Drag its title bar to move it (it stays inside the view), drag the corner to resize, and close it with × or Esc, which also clears the selection. The side panel keeps the object list, and the Objects button folds it away. On the 2D map (no WebGL), click and drag objects as in 3D.
- Waterfalls: a strip with one live waterfall per node (first mic) is open by default, and its header folds it away. The LoRa logic analyser folds the same way, from the LoRa button by the transport controls. It marks a tile while its node detects, and draws the detector's debug lines: the band it measures, when it detected, and a line traced along one harmonic of each drone it can pick out in the audio. Clicking a tile or a node opens it and plays its mic, marked with a speaker icon on its waterfall, until you pick something else or press Stop listening. The strip is only computed while it is open.
- Time: P play/pause (play flies the camera to the drone unless you picked a view), `.` step one 10 ms tick, R replay, T truth overlay, F follow the drone, Del removes the selection.
- Runs: every edit is logged with its tick. Save run downloads `sonicmesh-scenario.json` and `sonicmesh-inputs.json`. Load scenario, then Load inputs, then play to replay.

## Layout

- `src/sim/`: fixed-step clock, seeded PRNG, world state, input log, runner. Nothing here uses wall time or `Math.random`.
- `src/scene/`: three.js view. It reads world state and never changes it.
- `src/ui/`: object list and tabs, the pop-up window (`popup.ts`), the waterfall strip, timeline, dialogs.
- `src/provenance/`: loads `provenance.yaml`, which drives every badge and the "What's real?" page.
- `scenarios/`: `schema.json` and the example scenario.
