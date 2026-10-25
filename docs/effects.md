# Effects

The visual effects upstream BZFlag draws, and where bzo draws each. Upstream
references are paths under `$HOME/bzflag/`.

Two subsystems hold almost every visual effect upstream has, and bzo has all of
both.

**`effectsRenderer.cxx` -- all seven families, all present.** Each is chosen by a
BZDB index into a list where 0 is off, and bzo implements the default variant of
each, per the project rule of shipping one variant rather than a setting:

| upstream default | class | bzo |
|---|---|---|
| spawn "Blossom" (`spawnEffect=1`) | `StdSpawnEffect` | `activeSpawnEffects` |
| shot (`shotEffect=1`) | `StdShotEffect` | `render.js` muzzle cone |
| death "Fancy" (`deathEffect=1`) | `RingsDeathEffect` | present, deliberately different |
| land "Dirt Flash" (`landEffect=1`) | `StdLandEffect` | `createLandingEffect` |
| GM puff "Smoke" (`gmPuffEffect=3`) | `SmokeGMPuffEffect` | `trailGMPuffs` |
| rico "Ring" (`ricoEffect=1`) | `StdRicoEffect` | `render.js` rico cone |
| shot teleport "IDL" (`tpEffect=1`) | `StdShotTeleportEffect` | `render.js` collar |

Note `deathEffect` has only one live variant: `SquishDeathEffect`, `FadeToHeaven`
and `SpikesDeathEffect` exist but their selection is commented out
(`effectsRenderer.cxx:487`), so `RingsDeathEffect` is what upstream always draws.

**`Player::addToScene` -- the per-tank visuals.** bzo has the cloak alpha with
its ease, the zoned quarter-alpha, the dimension scaling, including `O`
Obesity's and `T` Tiny's (`public/js/flags.mjs`), and the teleporter alpha fade
(`updateTankDimensions` in `client.js`).

**Elsewhere:** bzo has `FlagWarpSceneNode`, the animated treads, and the eighth
dimension. `_mirror` defaults to `none` so a map has to ask for reflections, and
nothing else in `src/geometry` is an effect bzo lacks.

## Teleporter proximity is two effects, not one

Both read `World::getProximity(state.pos, BZDBCache::tankRadius)`, so the
expensive part is shared and building one is most of building both.

`Teleporter::getProximity` is `t = 1.2 - x / radius`, where `x` is the distance
from the portal plane and `radius` is `_tankRadius` -- which is
`0.72 * _tankLength`, so **4.32**, not the sub-unit number the name suggests.
There is a lateral gate at `1.2 * radius` against the portal rect, an
`atan2`-squared trail-off along the sides, and height limits at the frame:

| distance from the portal plane | `t` |
|---|---|
| 5.18 units, about a tank length | fade begins |
| 1.94 units | 0.75 |
| 0.86 units | 1.0 |

The screen flash is "Teleporter flash" in `AGENTS.md`.

The tank fade is `teleAlpha = 1.0f - (0.75f * teleporterProximity)`
(`Player.cxx:642`), multiplied into the cloak alpha, so every tank -- your own
included -- fades toward a quarter over the same band. Seer sees the fade but
not the cloak (`:915`), and a zoned tank keeps its flat quarter whatever it is
near.
