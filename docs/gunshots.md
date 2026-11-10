# Gunshots: a second use case on the same network

Status: simulated. The shot sound, the detector and the locator run in the browser demo. Nothing here has been
measured on a real node yet.

## Why this matters

The network was built to hear drones. The same nodes, radio, gateway and map now also hear gunshots, and place
where each shot was fired. No node hardware changes. The shot path adds one detector, one locator, one message
type and one map layer. Drone detection still works as before.

That is the point of the design: a new use case is a new detector and a new locator plugged into the same
pipeline, not a new system. The last section lists the steps.

## What a shot sounds like

A shot is one sharp crack followed by a fading tail from the surroundings. The model in
`web/src/acoustics/shot.ts` renders that crack and tail. The tail's decay and band balance are fitted to four
recordings of target shooting, taken close to the mic. Each shot is varied in level and tail length, so no two are
identical.

The model does not separate the muzzle blast, the flash, or the bullet's shockwave. Those would be separate sources,
and a later project.

Shots reach the mics through the same propagation path as drone sound: distance, air, terrain blocking and the
ground reflection. The mics overload at 130 dB SPL, so a close shot clips the way a real one would.

## How a node detects a shot

A drone has a pitch, so a node finds it with a comb (`web/src/detector/comb.ts`). A shot has no pitch: it is a
broadband click. So the shot path uses a different test, in `web/src/detector/impulse.ts`:

- The node measures the power in 1 ms windows.
- An onset is a window at least 12 dB above the background level.
- After an onset, the node holds for 50 ms, long enough that the crack itself does not start another onset.
- The background is learned slowly, and not during a shot's tail, so a tail does not raise the bar for the next shot.

A node that hears a crack records the onset time. An array node also takes a bearing from the crack's first 512
samples (32 ms), using the broadband delay-and-sum in `web/src/detector/bearing.ts`.

## How the gateway places a shot

Sound travels about 343 m/s, so a shot reaches each node a little later, depending on distance. The gateway does not
need a shared clock with the shooter. It uses the differences between onset times:

1. **Hyperbolas.** Two nodes' onset times place the shot on a curve, where the difference in arrival times is
   fixed. Three or more nodes give a spot.
2. **Bearings.** Hyperbolas are symmetric about the line of nodes, so the times alone cannot say which side of the
   line the shot was on. An array's bearing picks the side. A fit needs two bearings.
3. **Residual gate.** A candidate spot is kept only if its onset times agree within 5 ms (about 1.7 m of travel).
   Otherwise the onsets are two shots, or noise.
4. **Radius.** The fix comes with an uncertainty circle, from the bearing error (about 2 sigma) at the nearest array.

Each shot needs at least four onsets, so one stray crack does not become a shot.

### Several shots at once

Two shots can land in the same second. The solver does not separate them by time. It looks for every spot where two
bearings cross, collects the onsets that agree with a single fire time at that spot, and fits the largest group
first. It then removes what that fit explains and repeats, up to eight shots per window. Duplicate fits of one shot
are merged.

## What the network sends

When a node hears a shot, it sends a `SHOT` message (`web/src/protocol/messages.ts`) with the onset time. Where it
goes depends on the mode:

- **Idle:** in the node's own window (`docs/protocol-v0.md`). At startup the hub gives every node a window, and no
  two nodes share one, so idle shots never contend.
- **Event:** in the node's own event slot. A node with a queued shot takes that slot for one superframe, and its
  detections resume in the next. Without this, a drone that stays in the air blocks every shot.

This is a new message type, so the protocol table and the timeline colour both gained an entry.

The gateway's fit in the demo currently reads the onsets the nodes report directly, not the decoded `SHOT` messages.
Switching the solver to the decoded messages is a known next step.

## Expected accuracy (simulated)

On the example scenario (13 nodes, staggered by a seeded jitter), most shots placed by the solver land within 15 m
of where they were fired, and the worst case in the example run is about 40 m. Shots that overlap in time are told
apart when their bearings cross. A far shot fired 0.5 s after a closer one can be masked by the closer shot's tail
at most nodes; that is open.

## Adding another use case

A new use case, such as a vehicle, a generator, or a fence breach, follows the same five steps. Each one touches a
known place in the code.

1. **Model the event** in `web/src/acoustics/`, as a source that renders sound at each mic, the way `shot.ts` does for a
   crack. Add it to `provenance.yaml` with its tag (ASSUMED until it is checked against recordings).
2. **Detect it at the node** in `web/src/detector/`. Choose the test that fits the event: a pitch (comb), a click
   (impulse), or a level change. Reuse the bearing estimator if the event has a direction.
3. **Report it** by adding a message type in `web/src/protocol/messages.ts`, then send it from the node in its alert slot,
   as `web/src/lora/mac.ts` does for `SHOT`.
4. **Locate it** at the gateway in `web/src/lora/`, from the reports it sends. If the event has no timing, a
   bearing-based locator may suffice; if it has timing, reuse the hyperbola fit in `shotLocate.ts`.
5. **Draw it** in `web/src/scene/worldView.ts` and the inspector, and give it a colour in the timeline. Then add a
   test per layer, as `web/tests/shots.test.ts` and `shotLocate.test.ts` do.

Drone detection did not change in any of this. Each new use case adds code beside the existing ones.

## Where the code is

| Layer | File |
|---|---|
| Sound model | `web/src/acoustics/shot.ts` |
| Shot schedule and one-off shots | `web/src/sim/shots.ts` |
| Node onset detector | `web/src/detector/impulse.ts` |
| Bearing from a short window | `web/src/detector/bearing.ts` (`estimateShotBearing`) |
| Node report | `web/src/lora/nodeStub.ts` |
| Gateway solver | `web/src/lora/shotLocate.ts` |
| Gateway messages and slots | `web/src/lora/mac.ts`, `web/src/protocol/messages.ts` |
| Map and timeline | `web/src/scene/worldView.ts`, `web/src/ui/timeline.ts` |
| Tests | `web/tests/shots.test.ts`, `web/tests/shotLocate.test.ts`, `web/tests/mac.test.ts` |
