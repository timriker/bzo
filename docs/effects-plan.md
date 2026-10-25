# Effects

What upstream BZFlag draws that bzo does not, and what each one is worth
building. Upstream references are paths under `$HOME/bzflag/`.

Flags (#6) and tank tracks (#24) are closed.
Nothing left in this document has a tracker.

## The audit

Two subsystems hold almost every visual effect upstream has, and bzo is complete
on one of them.

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

**`Player::addToScene` -- the per-tank visuals, and where the gaps are.** bzo has
the cloak alpha with its ease, the zoned quarter-alpha, and the dimension
scaling, including `O` Obesity's and `T` Tiny's (`public/js/flags.mjs`). Only the
teleporter alpha fade is missing.

**Elsewhere:** bzo has `FlagWarpSceneNode`, the animated treads, and the eighth
dimension. `_mirror` defaults to `none` so a map has to ask for reflections, and
nothing else in `src/geometry` is an effect bzo lacks.

## Still missing

| missing | upstream | worth |
|---|---|---|
| tank alpha fade | `Player.cxx:642` | the minor half of teleporter proximity, below |

That is the whole list.

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

The screen flash half is built (see "Teleporter flash" in `AGENTS.md`).

### The tank alpha fade

`teleAlpha = 1.0f - (0.75f * teleporterProximity)`, multiplied into `color[3]`
alongside the cloak alpha, so every tank fades toward 25% over the same band. It
carries real information -- a tank about to vanish shows it -- but it is subtle
and brief for a tank at speed. `getWorldTeleporterProximity` is already there for
it; what is missing is a hook into wherever bzo sets a tank's own alpha
(`GHOST_ALPHA_SCALE` and the cloak/zoned alpha in `render.js`) to blend it in per
tank, for every tank, not just the local one.

## Order

1. **The tank alpha fade**, with `getProximity` already there.
