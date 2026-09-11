# Effects

What upstream BZFlag draws that bzo does not, and what each one is worth
building. Upstream references are paths under `$HOME/bzflag/`.

Flags were issue #6 and tank tracks were issue #24, both closed and both built.
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
scaling. `setObese` and `setTiny` are absent only because OB and TI are not
implemented, which is a flag gap rather than an effect one.

**Elsewhere:** bzo has `FlagWarpSceneNode`, the animated treads, and the eighth
dimension. `_mirror` defaults to `none` so a map has to ask for reflections, and
nothing else in `src/geometry` is an effect bzo lacks.

**Tank tracks (#24) are built**, and were the third thing this document was
opened to plan: `public/tracks.mjs` for where a mark goes and `render.js` for
the pool that draws them. See the Tank tracks section of AGENTS.md for what
upstream has that bzo leaves out and why.

The memory question they raised -- a fading decal per tank per interval, on a
client that is CPU bound -- was answered by a fixed ring of 512 marks in one
mesh, written once when a mark is laid and uploaded only over the marks that are
still alive. A full pool drops its oldest mark, so a crowded map shortens every
trail rather than growing the cost.

## Still missing

| missing | upstream | worth |
|---|---|---|
| tank alpha fade | `Player.cxx:642` | the minor half of teleporter proximity, below |
| weather | `WeatherRenderer.cxx` | map-driven, so nothing shows unless a map asks |

That is the whole list. Weather is last for a reason: `_rainType` and its dozen
siblings are server or map settings with no default, so a client that never
joins a rainy map is not missing anything a player would notice.

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

### The screen flash is the impactful half, and is built

`SceneRenderer.cxx:1145` blends the whole frame toward `blindnessColor`, which is
`{1, 1, 0, 1}` -- **yellow** -- at `density = t / 0.75` clamped to 1. So the
frame is solid yellow from about 1.94 units out, and the player emerges on the
far side. At tank speed that is roughly 130ms of ramp into a full-field flash.

**This is what makes a teleport read as a teleport upstream.** It hides the view
discontinuity, and bzo now has it: `getWorldTeleporterProximity` (`client.js`,
next to `getShotTeleporterCrossing`) ports `Teleporter::getProximity` and
`World::getProximity` directly, and `RenderManager.setTeleporterProximity`
(`render.js`) is the overlay.

**This is not the same mechanism as Blindness, upstream's naming coincidence
aside.** `blindnessColor` is `renderDimming`'s constant name for this yellow, not
a sign the two effects share code -- `playing.cxx:6212` drives `setBlank` (a
binary hide-the-world-and-black-the-sky switch) off `Flags::Blindness` and off
pause, and separately, `playing.cxx:6232` drives `renderDimming`'s *other*
branch, `useDimming` (a fixed black 75%-density blend), off a menu being open.
`teleporterProximity` is the third, unrelated input to that same function.
bzo's existing `setBlank`-based Blindness (`client.js`, next to
`renderManager.setBlank(isViewBlinded())`) already matches upstream exactly and
needed no change. The overlay this section describes is new and is teleporter
proximity's alone.

**The overlay is a mesh parented to the camera, not a 2D screen quad.** Upstream
draws `renderDimming` with an identity projection over the whole viewport, which
has no equivalent in a headset -- there is no window to pin a 2D overlay to.
`setTeleporterProximity` instead adds a large, always-in-front, depth-tested-off
plane as a child of `this.camera`, which Three.js renders once per eye under
WebXR the same as any other object in camera space, so the wash is stereo-correct
for free.

**It gets no XR-specific cap.** `setBlank`'s comment already settles this
question for the harder case: Blindness's full opaque blackout runs "on the flat
canvas and in XR alike," unmitigated, because that is upstream's own effect and
the project rule is to ship the effect BZFlag ships. A graded yellow wash peaking
for roughly 130ms at tank speed is a smaller dose than that blackout, so capping
it in a headset while leaving Blindness uncapped would be an inconsistency this
codebase has already decided against, not a new safety line.

### The tank alpha fade is the minor half, and is not built yet

`teleAlpha = 1.0f - (0.75f * teleporterProximity)`, multiplied into `color[3]`
alongside the cloak alpha, so every tank fades toward 25% over the same band. It
carries real information -- a tank about to vanish shows it -- but it is subtle
and brief for a tank at speed. `getWorldTeleporterProximity` is already there for
it; what is missing is a hook into wherever bzo sets a tank's own alpha
(`GHOST_ALPHA_SCALE` and the cloak/zoned alpha in `render.js`) to blend it in per
tank, for every tank, not just the local one.

## Order

1. ~~The graded overlay, then the teleporter flash on top of it~~ -- both built.
2. **The tank alpha fade**, with `getProximity` already there.
3. **Weather**, if a map ever asks.
