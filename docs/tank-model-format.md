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

The renderer animates however many indexed wheels it finds on each side, in numeric order.
This supports 3-wheel, 4-wheel, and other tracked layouts without model-specific code.

## Material Role Intent

Object names are the hard contract. Material names are advisory and may be used
to improve role inference in the future.

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
- tread belt surfaces use the animated tread texture
- tread caps use darker mechanical tread-cap materials
- wheel meshes are animated by side based on discovered wheel object names
- if only `ltread` and `rtread` exist, the renderer still works in fallback mode

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

## Notes

- Prefer upstream BZFlag names when they already exist
- Use `bzo` extension names to expose more structure for animation and materials
- The renderer should prefer specific split-part names first, then fall back to simpler names
