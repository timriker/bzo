# Flags

bzo carries every flag BZFlag has except one: the four team flags and forty-one
of upstream's forty-two superflags. `WA` Wide Angle is deliberately absent, and
the last section here says why.

This document holds the things the code cannot: the shape of the flag system, and
the places where bzo's flags deliberately differ from BZFlag's. Per-flag
mechanics are not repeated here -- they live in comments beside the code that
implements them, each citing the upstream file and line it came from, where they
cannot drift out of step with the behaviour.

## Where it lives

- **`public/flags.mjs` + `server/flags.cjs`** are a mirrored pair, byte-identical
  in behaviour and checked by `npm run check:shared-pairs`. They hold the flag
  table, the enums, the world constants and every pure rule: what a flag does to
  a shot, to a tank's speed and size, to what its carrier can see, and to who can
  hit whom. Both ends read the same copy, so a rule cannot be enforced one way by
  the client and another by the server.
- **`scripts/test-flags.mjs`** covers the pair against upstream's own numbers,
  and asserts both copies agree.
- **`public/collision.mjs` + `server/collision.cjs`** hold the obstacle geometry
  the phasing flags need, in the same mirrored arrangement.
- **`server.js`** owns everything stateful: the flag array, the pool, spawning,
  landing-spot search, grab and drop validation, and every hit and kill.
- **`public/client.js`** animates. It integrates a flight, draws the effects, and
  refuses locally anything the server would refuse, so an unmodified client never
  sends a packet the server has to argue with.

**Flag ownership lives only in the server's `flags` array.** There is no second
copy on the player. A client's *knowledge* of a flag's identity lives in its own
flag record and nowhere else: a superflag's type is revealed only while somebody
holds it, so an update for a dropped one arrives with `type: null`, and
`keepFlagIdentity` is the rule that keeps the record's answer across it. A record
is a slot rather than a flag, so it forgets when its flag leaves the world -- its
next flag is a fresh roll, and keeping the old identity would label a new Useless
as the Identify that stood there before it.

**Identify is asked for, not pushed.** Upstream's `searchFlag` sweeps for every
player on every position update and sends the answer whether or not the client
could already give it. bzo's client makes the same sweep -- `findNearestGroundFlag`
in the flags pair, so neither end can pick a different flag -- names the nearest
one itself when its record knows the type, and sends a `nearFlag` only for one it
cannot name. The server answers by sweeping its own copy of that tank's position,
so the request carries nothing to validate.

**The `FLAG_TYPES` table is the list of what bzo has.** A row is what puts a flag
in `superFlags.allowed`'s default and in the help panel, which `buildFlagHelp`
generates from the same table, so a row with no behaviour behind it would be a
flag in the world that lies about what it does.

**Where a flag's rule is enforced follows one test:** server-side wherever a
modified client could gain by lying, client-side wherever it only changes what
its own player sees. Blindness, Jamming and Colourblindness are the carrier's
own business and have no server part at all. Everything about who can hit whom is
the server's.

## The shape of it

The server owns every flag and sends the whole flight with the event that starts
it; the client integrates that arc locally. That is exactly how
`FlagInfo::dropFlag` and `World::updateFlag` split the work upstream. There is no
per-frame flag packet and no clock sync -- the client advances `flightTime` by its
own frame delta from the value the server sent, and both sides land the flag on
the same numbers because `computeFlagFlight` and `getFlagFlightState` are one
mirrored pair.

Grab, drop and capture are client-initiated and server-validated, which is bzfs's
own arrangement: the client sweeps for what it is driving over and asks, and the
server revalidates with a deliberately loose radius that absorbs a lag period.

A superflag's identity is hidden from every client while nobody holds it, and
becomes known to *everyone* the moment somebody picks it up. Upstream can hide
one for nothing, because every superflag it draws is white and only the name
differs. bzo pays a little: a flag it knows to be bad wears `BAD_FLAG_COLOR`
wherever it appears -- in the world, on the radar and on the scoreboards -- so a
slot that has been identified looks different from one that has not.

CTF is on when team mode is on **and** the map has bases, which is upstream's
`ClassicCTF`. Team flags occupy the first slots of the flag array so a team's
index does not move when the superflag count changes, and the two kinds differ in
ways worth knowing before touching either: a team flag never vanishes, appears at
its base instead of flying in, comes to rest on buildings, and leaves the world
with its team, while a superflag flies in, expires after `_maxFlagGrabs` pickups,
and may only come to rest on the ground.

## Intentional differences from BZFlag

Each of these is deliberate. Do not "fix" one without being asked.

### The protocol

- **A hidden flag carries `type: null`** rather than upstream's fake `"PZ"`
  abbreviation. There is no wire compatibility to preserve, and a packet that
  lies about a type is the sort of thing a reader has to disprove.
- **`dropFlag` carries no position.** Upstream sends the client's own position
  because the server's copy lags; bzo uses the server's copy, which is already
  movement-validated, so there is one less field to check and nothing to game.
  The difference is at most a frame of tank motion in where the flag lands.
- **`antidoteFlag` has no upstream counterpart**, because upstream has no packet
  to have: its client picks its own antidote spot and asks for the drop when it
  gets there. bzo's server picks the spot and decides the arrival, so it has to
  say where.
- **The zoned state rides on the flag entry** rather than in a player-state
  status bit, and travels as the state it *is* rather than as a toggle, so a
  client's own prediction of a teleporter crossing converges on it instead of
  flipping a second time.

### What the world may void

`getForbiddenFlags` is upstream's `forbidden` set: a type in it is out of the
random pool and skipped by the zone-flag loop, so it is voided everywhere at
once. bzo carries upstream's rules -- jumping on voids `JP` and off voids `NJ`,
`+r` voids `R`, a world with no teleporters voids `PZ`, a world with no teams
voids `G` -- with one deliberate omission:

- **A teamless world does not void `CB` or `MQ`.** Upstream voids both because
  its team mates share one colour, so with no teams `myTank->getTeam()` is rogue
  for everybody and neither flag says anything. bzo gives every player a colour
  of their own, so Masquerade wearing the viewer's colour still hides who you
  are and Colourblindness still hides everyone's identity, teams or no teams.
  `G` Genocide genuinely needs teams to mean anything and is voided without them.

Upstream's `+f <abbrev>[{count}]` -- a pinned count of a type with no zone to put
it in -- is the one map switch bzo has no model for: a slot is either drawn from
the pool or bound to a zone, with no third state.

### Colour, which bzo splits in two

Upstream colours tanks by team; bzo gives every player a colour of its own and,
in team mode, shades team mates apart within a band around the team colour. That
splits "the viewer's team" from "the viewer's colour", and the two flags that
read it go opposite ways on purpose:

- **`CB` Colourblindness paints every other tank rogue**, not the viewer's own
  colour. Rogue *means* no team in BZFlag, so it says "team unknown", which is
  what the flag actually gives you; everyone in your own colour would say "all
  friendly", a misleading instruction from a flag whose help is "Don't shoot
  teammates!". It would also make `CB` and `MQ` indistinguishable on screen, so
  the precedence between them -- `CB` wins -- would stop being observable.
- **`MQ` Masquerade wears the viewer's own colour.** It is a colour that
  certainly exists on the viewer's team, where the team's *base* shade is one no
  real team mate wears; it needs no roster lookup, so it cannot collide with a
  second masquerading tank or change frame to frame; and it is the colour a
  viewer most associates with "one of us". The cost is the mirror image -- your
  own colour is unique, so a tank wearing it exactly is impossible otherwise --
  which is the subtler tell and the one worth paying.

Both are read through `getEffectiveTankColor`, the one place a remote tank's
colour is decided, so the tank body, its shots and its radar blip cannot
disagree. A tank is *built* from its colour rather than tinted, so an effective
colour change rebuilds it; `refreshTankDisguises` compares each tank's effective
colour against the one it was built from once a frame rather than hooking the
three unrelated events that can cause it.

The scoreboard is deliberately **not** colourblinded, which is upstream's choice
too: the flag costs you the ability to read a team off a tank in front of you,
not the ability to know the teams exist.

### `M` Momentum composes with the world instead of replacing it

Upstream substitutes: `linearAcc = (flag == Momentum) ? _momentumLinAcc : world`.
Both momentum defaults are 1.0, which is exactly what `-a 1 1` gives, so
upstream's `M` does *nothing* on such a world and is an **upgrade** on anything
heavier -- a strange thing for a bad flag to be. bzo adds the reciprocals, the
way two constraints on one quantity combine, which reduces to upstream's own
figure on a world with no inertia and makes `M` a handicap everywhere else:

| world `-a` | no flag | with `M` | upstream's `M` |
|---|---|---|---|
| `0 0` (default) | no limit | 20 u/s² | 20 u/s² |
| `1 1` | 20 u/s² | 10 u/s² | 20 u/s² (no effect) |
| `0.5 0.5` | 10 u/s² | 6.7 u/s² | 20 u/s² (faster) |

`_momentumFriction` is not implemented: `doFriction` limits how fast the velocity
*vector* may swing, and both it and `_friction` default to zero, so neither does
anything on a stock world.

### `A` Agility measures the stick against the stick

Upstream compares the new stick with the previous *`desiredSpeed`* fraction,
which may already be boosted and is then clamped to [-0.5, 1]. That clamp invents
a change that never happened: a half-forward stick boosts past 1, clamps back to
1, and the next frame reads a jump of 0.5 that the player never made. bzo
compares against the fraction the player actually asked for.

### Presentation

- **Jamming's static is translucent.** Upstream can afford opaque noise because
  its radar sits outside the 3D viewport; bzo's radar floats *over* the view,
  where opaque static would take away part of what the flag explicitly leaves
  you. A jammed frame replaces the panel background at the alpha the background
  would have had, so a jammed panel is exactly as heavy as a working one.
- **A guided missile's bolt is coloured by who fired it.** Upstream paints every
  missile the same orange; bzo colours every shot by its owner, and a missile is
  the shot you most want the owner of.
- **The lock-on bracket is a world-space sprite, not a screen-space overlay.** A
  screen-space bracket has no meaning in a headset, where there is no window to
  pin it to. The cost is upstream's edge clamping: a target off screen has no
  marker, and the heading tape is where a bearing belongs anyway.
- **A lock lapses with the missile.** Upstream never clears a target on a flag
  change, so its marker outlives the flag that earned it. A bracket over a tank
  you have no way to shoot at is saying something untrue. Dropping `GM` while a
  missile is still flying keeps the lock, because retargeting that missile is
  what the flag's help text promises.
- **A theft tells the victim.** Upstream has no equivalent line. bzo says
  "Dropped X flag" every other time a flag leaves your tank, and a theft is the
  one way of losing one that sends the victim no drop at all, so without it the
  flag would simply be gone with nothing said.
- **Flags do not blow in the wind.** At upstream's default quality the cloth is
  billboarded to face the camera, so upstream's wind only turns a flag nobody can
  see turning.
- **A burrowed tank gets no screen cover.** Upstream draws a near-black rectangle
  over the lower part of the screen while burrowed. That is a flat-screen overlay
  with no meaning in a headset, and the effect it sells comes free: the eye sits
  at `position.y + 1.57`, so a burrowed tank looks out from a quarter unit above
  the ground and the world is genuinely a trench.
- **A below-ground tank is not clipped at the ground plane.** Upstream needs the
  clip plane; bzo's ground is opaque and depth-tested, so it already hides what
  is under it.
- **The zoned screen effect is the ground swap and nothing else.** Upstream's
  `setInvert` is not a colour inversion despite the name -- `BackgroundRenderer`
  keeps a second set of ground colours built from `zoneGroundTexture` and swaps
  to them. bzo swaps the one ground mesh's map, which is also the only form of
  that effect with any meaning in a headset.
- **Eighth-dimension nodes are built on demand.** Upstream builds one per
  obstacle with the world, because it builds every scene node there anyway. Here
  they are geometry no frame draws until somebody carries `OO`, and a map has
  hundreds of obstacles, so each is built the first time a tank is inside that
  obstacle. Its pyramid envelope comes from bzo's own pyramid geometry rather
  than upstream's `slope * hypot(x, y)`, which describes a cone and knows nothing
  of an inverted pyramid.
- **Where upstream offers a quality variant, bzo implements the default one** and
  ships no setting for it -- see "Fewer options than BZFlag" under "Intentional
  deviations from BZFlag" in `AGENTS.md`. The guided missile's bolt is the
  billboard upstream draws by default rather than the modelled one behind
  `useQuality() >= 3`; the flag cloth is the billboarded one rather than
  `realFlag`; the eighth dimension is the triangle cloud rather than
  `SHELL_INSIDE_NODES`.

### Rules that had to be rebuilt rather than ported

- **A jump is the rising edge of the control.** Upstream re-sets its jump request
  at the operating system's key-repeat rate, because `SDL2Display` does not
  filter `event.key.repeat`. bzo has no key-repeat event to inherit: every input
  surface it has reports the jump control as a held boolean sampled once a frame,
  so copying upstream would spend a Wings tank's flaps at frame rate -- faster
  than upstream and different on every machine. One press, one flap. Landing
  re-arms the control, so holding jump still bounces a tank down a building,
  which is the part worth having. A flap asked for in mid-air with no flaps left
  is dropped rather than queued for the landing.
- **A burrow is not a fall.** Upstream's `location` stays `OnGround` through both
  the dig-in and the climb back out, because only a z above zero makes a tank
  `InAir`, so its Falling status never sets and it never "lands". bzo infers both
  from the vertical velocity in a movement packet, so three things have to hold:
  a tank at or below ground level is not falling whatever its velocity says; the
  ground limit is clamped only on the way *down*, which is upstream's own
  condition and what lets a tank climb out rather than be pinned; and the creep
  that lifts it out is a floor recomputed from where the tank is rather than
  momentum it keeps, since a few stored centimetres of rise are all bzo needs to
  call the tank airborne.
- **A thief robs one tank per shot.** `ThiefStrategy::isStoppedByHit` returns
  false, so upstream's beam is not spent by a tank and every client along it
  reports its own theft; the thief keeps the last and bzfs zaps the rest. bzo
  stops the beam at the first tank it can actually rob, which loses nothing
  anybody wanted and destroys nothing.
- **A laser is the one shot bzo does not predict locally.** Its path is a
  polyline through whatever it met, tagged with what ended each segment, which is
  the one thing a client cannot work out for itself. The shooter gets the muzzle
  flash and the report at once and the beam when `shotBegin` lands.
- **The hit sphere is bzo's own radius**, so upstream's `0.99 *` shrink is not
  applied -- that factor exists to sit inside `_tankRadius`, which bzo does not
  use. The dimension ease is cosmetic only: the server owns hits and tests the
  target size from the moment the flag changes hands.
- **`getPauseRefusal` still asks a cylinder**, not the oriented box every other
  occupancy test uses. It is a bzo-only guard with no upstream equivalent, and a
  cylinder is deliberately more generous, so a flag can only ever make it
  stricter than it needs to be.

## `WA` Wide Angle is not implemented, and will not be

Wide Angle widens the field of view to `_wideAngleAng` 1.745329 rad (100
degrees). On a flat canvas that is one camera value. In a headset the runtime
owns the projection: it sets it from the device's optics, and a client that
overrode it would either be ignored or would make people ill.

bzo ships one client for desktop, mobile and the headset, and a flag that is a
real penalty in a browser and a no-op in VR is worse than an absent one -- it
looks like it works and the player cannot tell. No acceptable XR answer was
found, and keeping XR matters more than carrying the flag, so `WA` is out for
good rather than pending.

What that means in practice, all of it already true because a flag with no
`FLAG_TYPES` row cannot be placed:

- **`WA` is never spawned.** It is not in the pool a superflag slot draws from,
  so it cannot appear in the world by any route.
- **A `zoneflag WA` is ignored.** The zone keeps whatever else it declares and
  the `WA` count is dropped. The load logs the skipped type, so a map that asks
  for it says so once at startup rather than silently losing part of itself.
- **A map that forbids `WA` is honoured trivially**, since there is nothing in
  the pool to remove.
- **The help panel does not list it**, because the panel is generated from
  `FLAG_TYPES`.

A map written for BZFlag therefore loads and plays; it is short one flag, and the
server says which one.
