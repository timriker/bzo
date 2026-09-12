# Teleporter collision fix

A record of a multi-part collision bug found through live play against the
default SW-corner teleporter (`portal`/`roof` in `maps/bzo.bzw`), and its
fix. Kept as a reference for anyone hitting a similar symptom against a
teleporter, or any other thin/oriented obstacle, in the future. Upstream
references are paths under `$HOME/bzflag/`.

## Symptoms, as reported

1. A tank jumping into the teleporter's solid frame (its jamb, the border
   between the outer footprint and the doorway) could get permanently stuck
   at a fixed height, unable to fall or move.
2. Slowly driving straight at the frame's front or rear face (the direction
   you'd drive through the doorway) passed through solid material with no
   collision at all.
3. Flying with Wings (`WG`) into the front of the frame while gaining
   height would hang completely at the jamb/header boundary; backing off or
   releasing forward thrust freed it.

All three traced back to the same file pair, `public/collision.mjs` /
`server/collision.cjs` (a hand-maintained mirror, checked by
`scripts/check-shared-pairs.mjs`) and `public/motion.mjs` /
`server/motion.cjs`, but three distinct defects.

## Defect 1: a static classifier instead of a swept one

`getTankHitNormal` answered "which face did I hit" from the tank's resting
position alone (`getOrigRectNormal`, a same-file invention with no upstream
name), classifying a corner as whichever of up to two axes the point read
closest to. Upstream's `Obstacle::getHitNormal` (`Obstacle.cxx:123`) answers
the same question by casting a ray for each of the four corners of the
*moving* tank box across the step just taken, and separately for each of the
four corners of the obstacle across the tank's own (also moving, if turning)
box, and takes whichever of those eight rays crosses first. The static
read has no way to tell, from a single grazing rest position, that the
velocity it is about to compute points back into the solid it just met; the
swept ray does, because it answers from the path, not the endpoint.

Ported as `timeAndSideRayHitsOrigRect`/`timeAndSideRayHitsRect`
(`collision.mjs:953`/`992`, upstream's own names from `Intersect.cxx`) and
`getSweptSideNormal` (`collision.mjs:1054`, no upstream name -- the
two-pass loop is the inline body of `Obstacle::getHitNormal`, not a
separately factored function there). `getSideNormal` (`collision.mjs:1106`)
picks the swept path when the caller supplies a `sweep` (the step's actual
start/end and the tank's own half-extents), falling back to the static
classifier otherwise -- matching upstream's own fallback
(`LocalPlayer.cxx:614`, "sometimes fancy test says there's no intersection
... fall back to simple normal calculation").

`resolveTankMotion` (`motion.mjs:41`) had to start passing the pass's true
`fromX/fromZ/fromAz`/`toX/toZ/toAz` into `getNormal`, not just the resolved
contact point it passed before -- the swept test needs the whole step, and
nothing upstream of it had a reason to keep those around once the binary
search narrowed to a contact point. `resolveTankStep` (`client.js:6417`)
builds the `sweep` object from `getMyTankScale()` and passes it through.

Confirmed by re-running the exact real jump position/heading/speed that
first reported symptom 1 against the fixed code: a single clean hit,
correct velocity cancellation, clean fall to landing.

## Defect 2: solidity tested "overlaps the doorway", not "overlaps the pillar"

`findTankObstacle`'s teleporter branch decided a hit was "passing cleanly
through" if the occupant's box overlapped the doorway rectangle at all. A
real tank (6.0 units long) is much bigger than the border (~1 unit), so it
can reach past the border into the doorway while its centre -- and the rest
of its body -- is still over solid pillar material, and the old test called
that clean. This is symptom 2: any square-on approach to the frame's front
or rear face passed straight through, because the tank's long axis always
reached into the doorway.

Upstream's `Teleporter::inBox` (`Teleporter.cxx:259`) never asks this
question at all -- it tests the occupant against two explicit
border-square columns (each a `border × border` square, offset
`getBreadth() - border/2` from centre) for the jamb band, and against the
full outer footprint for the crossbar band above it. `findTankObstacle`
(`collision.mjs:423`) now does the same: `pillarR = dims.border / 2`,
`pillarOffset = dims.halfD - pillarR`, testing each pillar rectangle
directly rather than testing the doorway and inverting the answer.

`getTankHitNormal`'s teleporter branch (`collision.mjs:1142`) needed the
matching change -- it was still picking the *normal* off the frame's full
outer footprint, which a real tank is wider than in the thin direction, so
it could never register a clean crossing of that footprint at all. It now
resolves the swept/static side-normal against whichever pillar rectangle
the tank is nearer, not the outer footprint.

## Defect 3: the header shortcut didn't check what it was overhead of

`getTankHitNormal`'s teleporter branch answered "you hit the header's
underside" (a pure ceiling normal, `{0,-1,0}`) whenever the higher of the
step's two endpoints was above `activeH` -- with no check for whether the
tank was still horizontally over a pillar rather than the open doorway, and
no check for whether the step was actually *crossing* into that band versus
merely resting above it already. A Wings tank hovering and thrusting into a
pillar's own front face, having floated above `activeH` a frame or two
earlier, kept reading as a ceiling hit on every subsequent frame: the
ceiling normal cancels the rise and leaves the forward thrust untouched,
while the pillar is still solid in front of it and the header solid
overhead -- every direction the search tries stays blocked, and nothing
moves again. That's symptom 3.

Two conditions now gate the ceiling answer: the step must actually cross
`activeH` from below (`low < activeH && high >= activeH`, `crossedFlatTop`'s
own shape run in the other direction), and the tank must not still be
horizontally over a pillar (`overPillar`, the same pillar-rectangle test as
defect 2). A tank resting above `activeH` against a pillar reads the
pillar's own front face as an ordinary wall; only once it has actually
cleared the pillar does the header's own front face -- or, on an upward
crossing over the open doorway, its underside -- apply.

## What to check if this resurfaces

- `scripts/test-collision.mjs` has a regression test (`simulateJumpIntoJamb`)
  that replays the exact real jump trajectory from symptom 1. If a future
  change reintroduces the livelock, that test fails first.
- `maps/bzo.bzw` carries a permanent test fixture -- `frame_pillar_a`,
  `frame_pillar_b`, `frame_header` -- three plain boxes sized to a default
  teleporter's outer footprint (see `BZW_TELEPORTER_DEFAULTS` and
  `CustomGate::finalize` in `server.js`). Because they're plain boxes, not
  teleporters, they exercise `resolveTankMotion`'s generic corner-slide
  handling (defect 1) independent of the teleporter-specific code (defects
  2 and 3), and can be dropped into `bzfs`/`bzflag` unmodified to compare
  against upstream directly.
- Any future obstacle shape thinner than a tank in one dimension, or with a
  non-convex solid cross-section (an L-shape, a ring), is a candidate for
  the same class of bug: a static end-of-step classifier and a
  solidity test phrased as the complement of open space both break down
  once the occupant's own size is comparable to the obstacle's.
