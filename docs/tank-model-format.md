# Tank Model Format

`bzo` tank models are OBJ files whose object names define gameplay/render roles.
The renderer should work across simple, detailed, and custom tracked vehicles by
discovering these named parts instead of hardcoding a single model layout.

## Goals

- Preserve original BZFlag tank naming where it exists
- Support richer `bzo` tank models with split tread and wheel parts
- Keep tread texture animation generic across multiple vehicle styles
- Make model differences live mostly in OBJ files, not renderer forks

## Core Object Names

These names are the primary contract for all tank models:

- `body`
- `turret`
- `barrel`

These match upstream BZFlag naming and should be preferred whenever possible.

## Tread Object Names

### Upstream BZFlag-compatible names

- `ltread`
- `rtread`

These are accepted as the simple fallback for left and right treads.

### Expanded `bzo` names

- `leftTreadMiddle`
- `leftTreadFrontCap`
- `leftTreadRearCap`
- `rightTreadMiddle`
- `rightTreadFrontCap`
- `rightTreadRearCap`

These allow the renderer to apply different materials to belt runs versus end caps.

### Additional accepted aliases

- `leftTrack`
- `rightTrack`
- `tread_belt_left`
- `tread_belt_right`
- `tread_cap_left_front`
- `tread_cap_left_rear`
- `tread_cap_right_front`
- `tread_cap_right_rear`

## Wheel Object Names

Preferred wheel names are per-side and numerically indexed:

- `leftWheel1`
- `leftWheel2`
- `leftWheel3`
- `leftWheel4`
- `rightWheel1`
- `rightWheel2`
- `rightWheel3`
- `rightWheel4`

Additional accepted aliases:

- `wheel_left1`
- `wheel_left2`
- `wheel_left3`
- `wheel_left4`
- `wheel_right1`
- `wheel_right2`
- `wheel_right3`
- `wheel_right4`

The renderer animates however many indexed wheels it finds on each side, in
numeric order. This supports 3-wheel, 4-wheel, and other tracked layouts
without model-specific code.

## Navigation Light Object Names

Upstream BZFlag draws three navigation lights above the turret, read the way an
aircraft's are: white astern, red to port, green to starboard, so which way a
tank is pointing resolves before its silhouette does. A model places its own:

- `lightRear` -- white
- `lightPort` -- red, on the tank's left
- `lightStarboard` -- green, on the tank's right

Each is a single-vertex point object, not geometry:

```text
o lightRear
v 0.000000 2.100000 1.530000
p -1
```

The renderer reads the vertex for its position and nothing else. The colours
are fixed, because the three colours are the convention the lights are read by
and not a model's choice; an object built out of faces instead of a `p` works
too, and is read at its own centre.

Rest each one on the surface directly beneath it, a couple of centimetres
clear -- not on the top of the whole tank. A light beside a tall turret belongs
on the deck it is over: sunk into the hull it is depth-tested away and never
appears, and held up at the turret's height it visibly floats in mid-air.
`scripts/test-tank-models.mjs` measures the surface in each light's own column
and holds every model to that band.

Upstream can hard-code one height for all three because it has one tank, and
that height sits *inside* the turret of three of the models `bzo` ships. A
model that names none of the three falls back to upstream's coordinates for the
stock tank, which is right for a tank shaped like the stock one and wrong for
anything else.

These objects carry a `p` command, so `readObjObjectNames` leaves them out of
the names it reports and the renderer's part lookup -- which wants meshes --
never sees them. Adding them cannot affect whether a model builds.

## Material Role Intent

Object names are the hard contract. Material names are advisory: the renderer
picks materials by object name, and a `usemtl` in the file is documentation for
the next person rather than something the renderer reads.

Recommended material role names:

- `body_skin`
- `tread_belt`
- `tread_cap`
- `wheel_side`
- `wheel_face`
- `barrel_dark`

Legacy/material names already seen in existing assets and accepted by the current
pipeline include:

- `tread_side`
- `tread_cap`
- `bm0`
- `bm1`
- `bm2`
- `bm3`
- `bm4`
- `bm5`

## Renderer Behavior

- `body` and `turret` use the tintable BZFlag-derived body texture
- `barrel` is flat dark, and carries no texture at all
- tread belt surfaces use the animated tread texture
- tread caps use darker mechanical tread-cap materials
- wheel meshes are animated by side based on discovered wheel object names
- if only `ltread` and `rtread` exist, the renderer still works in fallback mode
- navigation lights draw as screen-space points on the turret: they follow it,
  cast no shadow, and are absent from the explosion debris. Their size is a
  share of the drawing buffer's height rather than a count of pixels -- of
  whichever buffer is being drawn into, so the tank preview's small canvas
  gets small lights -- and follows the distance by its square root, so it
  grows slower than the tank does

A part gets the material of the object it is named into, so geometry belongs in
the object whose *role* it wants rather than the one it sits next to. A gun's
bore in `barrel` and its casing in `body` draws a camouflaged tube around a
black hole: both are doing exactly what their object asked for. Split by what a
piece should look like, and the renderer does the rest.

## Texture Coordinates

**Author them.** A model is expected to arrive unwrapped, and an unwrapped model
always looks better than anything the renderer can work out for itself.

A model that has no `vt` lines at all is rescued rather than left broken, since
one without texture coordinates draws every fragment from a single texel and
comes out flat team colour with no skin on it -- a plastic toy rather than a
tank. The renderer projects coordinates for it once, when the model loads:

- treads are wrapped around their own belt loop, so the scrolling tread texture
  runs along the track. The narrowest axis of the mesh is taken as the width of
  the track, and the number of times the tread image repeats comes from the
  belt's own size, so links come out the size the stock tank's are
- every other surface is wrapped on a sphere struck from the middle of the
  assembled tank, so one skin runs across hull, turret and barrel continuously

This is a rescue and not a substitute for unwrapping. A sphere stretches
wherever a surface does not face outward from the centre, and no projection
knows what the model meant. A model that ships its own coordinates keeps them
untouched.

## Loading

Models are loaded as they are needed, not all at once: the one a player has
selected, and the one either side of it in the carousel, because those are the
only ones the carousel can reach next. Anything else arrives when somebody
looks at it or when another player turns up wearing it.

This matters for what a model costs everyone else. A model is parsed on the
main thread of every client that loads it, and a large one is expensive enough
to be felt on a slow machine -- a 160,000-triangle model takes most of a second
there. Keeping a model small is a courtesy to every player who scrolls past it,
and the catalogue can grow without taxing people who never wear any of it.

## Licensing

A model is a separate work from the code that draws it, and the two do not
share a licence by sitting in the same repository. See **Bundled assets and
licensing** in [the README](../README.md) for what is expected of a model
before it ships.

## Unbuildable Models

A tank is the OBJ file it came from and nothing else. There is no generic tank
to stand in for a model the renderer cannot build, because a substitute reports
a broken model as working and leaves the fault to be found in play.

A model that does not name `body`, `turret` and `barrel`, or that names no
running gear on both sides, is therefore **not offered**: the server checks each
file in `public/obj/` as it lists the models and logs the roles the file is
missing instead of listing it. `public/tank-parts.mjs` and its
`server/tank-parts.cjs` mirror hold the check both ends read, and
`npm run test:tank-models` holds every shipped model to it.

Reaching the renderer with an unbuildable model is an error there too:
`createTank` returns nothing, names the missing roles on the console, and the
player is left without a tank rather than wearing one that is not theirs.

## Minimal Supported Model

A simple model only needs:

- `body`
- `turret`
- `barrel`
- `ltread`
- `rtread`

## Detailed Supported Model

A more detailed tracked vehicle may provide:

- `body`
- `turret`
- `barrel`
- `leftTreadMiddle`
- `leftTreadFrontCap`
- `leftTreadRearCap`
- `rightTreadMiddle`
- `rightTreadFrontCap`
- `rightTreadRearCap`
- `leftWheel1`
- `leftWheel2`
- `leftWheel3`
- `rightWheel1`
- `rightWheel2`
- `rightWheel3`
- `lightRear`
- `lightPort`
- `lightStarboard`

## Notes

- Prefer upstream BZFlag names when they already exist
- Use `bzo` extension names to expose more structure for animation and materials
- The renderer should prefer specific split-part names first, then fall back to
  simpler names
