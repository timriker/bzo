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
| teleporter proximity | `Player.cxx:642`, `SceneRenderer.cxx:1145` | two effects, below |
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

### The screen flash is the impactful half

`SceneRenderer.cxx:1145` blends the whole frame toward `blindnessColor`, which is
`{1, 1, 0, 1}` -- **yellow** -- at `density = t / 0.75` clamped to 1. So the
frame is solid yellow from about 1.94 units out, and the player emerges on the
far side. At tank speed that is roughly 130ms of ramp into a full-field flash.

**This is what makes a teleport read as a teleport upstream.** It hides the view
discontinuity. bzo hard-cuts to the destination today with only the sound, which
is the one place a bzo teleport looks unlike a BZFlag teleport.

### The tank alpha fade is the minor half

`teleAlpha = 1.0f - (0.75f * teleporterProximity)`, multiplied into `color[3]`
alongside the cloak alpha, so every tank fades toward 25% over the same band. It
carries real information -- a tank about to vanish shows it -- but it is subtle
and brief for a tank at speed. Not worth building alone; nearly free beside the
flash.

### Two things to settle first

**bzo has no graded overlay to hang the flash on.** `setBlank` is binary: it
hides `worldGroup` and blacks the background, where upstream's is a density
blend in a colour. So this needs a new mechanism -- which is worth having anyway,
because it is also what upstream's `useDimming` is, and bzo's Blindness is
currently the same on/off approximation.

**It needs an XR answer, and that is the blocker.** A full-field yellow flash is
uncomfortable in a headset and a photosensitivity concern besides: on a flat
screen it is a flourish, in VR it is the entire visual field going opaque. Three
plausible designs, none of them chosen yet:

- **A lower ceiling in XR.** Same ramp, capped well short of opaque -- simplest,
  and keeps one code path with one number that differs.
- **A vignette instead of a fill.** Darken or tint the periphery and leave the
  centre clear, which is the established comfort technique for exactly this and
  is used by XR locomotion systems for the same reason. Costs the "you cannot see
  through a teleporter" property.
- **A much shorter ramp.** Flash briefly at the crossing rather than over five
  units of approach, trading the warning for a smaller dose.

The vignette is the most likely right answer and the most work. Do not build the
flash before this is decided, per the rule that a flag effect needs an XR
implementation before it lands.

## Order

1. **The graded overlay**, then the teleporter flash on top of it once the XR
   question is answered. Fix Blindness to use it in the same pass.
2. **The tank alpha fade**, with `getProximity` already there.
3. **Weather**, if a map ever asks.
