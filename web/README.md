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

## Controls

- Drone: WASD or arrows move, Q/E down/up, gamepad sticks. M toggles manual and GPS-hover flight.
- World: click to select, drag nodes and the gateway on the ground. Use the + Node and + Drone buttons, then click the ground.
- Time: P play/pause, `.` step one 10 ms tick, R replay, T truth overlay, F follow the drone, Del removes the selection.
- Runs: every edit is logged with its tick. Save run downloads `sonicmesh-scenario.json` and `sonicmesh-inputs.json`. Load scenario, then Load inputs, then play to replay.

## Layout

- `src/sim/`: fixed-step clock, seeded PRNG, world state, input log, runner. Nothing here uses wall time or `Math.random`.
- `src/scene/`: three.js view. It reads world state and never changes it.
- `src/ui/`: inspector, timeline, dialogs.
- `src/provenance/`: loads `provenance.yaml`, which drives every badge and the "What's real?" page.
- `scenarios/`: `schema.json` and the example scenario.
