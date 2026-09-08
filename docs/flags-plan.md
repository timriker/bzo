# Flags

Design and staging plan for BZFlag-style flags in bzo. All flag work is tracked
as **GitHub issue #6**; reference it from every flag commit and changelog entry.
Upstream references are paths under `$HOME/bzflag/`.

Phases 1 (the Useless superflag, animation, and the drop key), 2 (team flags and
capture), 3 (Identify), 6 (damage rules), 7 (per-player tank dimensions), 8 (shot
variants), 9 (Ricochet), 10 (Shock Wave), 11 (Thief), 12 (Guided Missile) and 13
(per-viewer visibility) are **implemented**, as are phase 5's three good flags and
the jumping switch with all three flags that hang off it -- `JP` Jumping, `WG`
Wings and `NJ` No Jumping -- see "Jumping, and the flags that carry it".
All three of phase 4's ways out of a bad flag -- the **shake timeout**, **shake
wins** and **antidote flags** -- are in, and three of its four client-side bad
flags with them; `WA` Wide Angle is the one left, and it is blocked rather than
merely unstarted. Phase 14 has `OO` Oscillation Overthruster in; `BU` Burrow and
`PZ` Phantom Zone are what is left of it.

Every flag is named as well as abbreviated wherever it is mentioned here, in
`Flag.cxx`'s own words: the abbreviation is what the code, the config and the
scoreboard use, and the name is what the help panel and a player say.

The flag table in `public/flags.mjs` carries only the flags bzo implements, so
**this document is the list of what is missing** -- see "What is left to add".

## What upstream does

**The server owns everything; the client animates from events.** There is no
per-frame flag packet. `FlagInfo::dropFlag()` (`src/bzfs/FlagInfo.cxx:154`)
computes launch position, landing position, `flightEnd`, and `initialVelocity`
once and ships them with `MsgDropFlag` + `MsgFlagUpdate`.
`World::updateFlag()` (`src/bzflag/World.cxx:729`) then integrates the arc
locally: x/y is a straight lerp from launch to landing, and z is that lerp plus
`t * (v0 + 0.5 * gravity * t)`. Server and client land the flag independently on
the same numbers.

**Status machine** (`include/Flag.h:60`):
`NoExist -> Coming -> OnGround -> OnTank -> InAir -> OnGround`, plus `Going` for
a flag that vanishes instead of landing. `Coming` and `Going` are the warp
effects: a hover at apex while the cloth fades in or out and a
`FlagWarpSceneNode` disc stack grows then shrinks.

**Identity hiding is unconditional, not an option.** `sendFlagUpdate()`
(`src/bzfs/bzfs.cxx:361`) sets `hide = (flagTeam == NoTeam) && (player == -1)`,
and `Flag::fakePack` substitutes the abbreviation `"PZ"`. Team flags are never
hidden, and a superflag becomes known to *everyone* the moment someone picks it
up. This costs nothing visually because every superflag renders white
(`FlagType::getColor`, `src/common/Flag.cxx:409`); only the name differs.

**The client initiates grab, drop, and capture.** `checkEnvironment()`
(`src/bzflag/playing.cxx:4119`) sweeps every flag each frame, throttled to one
grab request per 200ms, and sends `MsgGrabFlag` for anything within
`tankRadius + flagRadius` with `|dz| < 0.1`. `grabFlag()` (`bzfs.cxx:3674`)
revalidates with a very loose radius (`tankSpeed + tankRadius + flagRadius`) to
absorb lag. Capture is likewise client-detected. That matches bzo's rule that
the client always sends valid data and the server checks only catch modified
clients.

**Constants** (`src/common/global.cxx`): `_flagAltitude` 11, `_flagRadius` 2.5,
`_flagPoleSize` 0.8, `_flagPoleWidth` 0.025, `_flagHeight` 10 (drop-spot
clearance, not visual size), `_maxFlagGrabs` 4, `_baseSize` 60. Flight time is
`2 * sqrt(2 * 11 / 9.8)` ~ 3.0s for both the coming arc and every drop.

## Data model

`public/flags.mjs` + `server/flags.cjs` are a **mirrored** shared pair, checked
by `npm run check:shared-pairs` and covered by `scripts/test-flags.mjs`. They
hold the flag-type table, the status and endurance enums, the world constants,
and the flight math -- `computeFlagFlight()` (server, once per event) and
`getFlagFlightState()` (client, once per flag per frame). Both are pure, so the
test can hold them against upstream's numbers without a server around them.

Everything else is server-only, as it is upstream: landing-spot search
(`DropGeometry`, which lives in `bzfs`), spawn positions, grab validation.

Server state is a `flags` array indexed by flag index, each entry mirroring
`FlagInfo`. Flag ownership lives only there -- there is no second copy on the
player -- so `flag.owner` is the one answer to who carries what.

## Protocol

Every message is upstream's own name with the redundant `Msg` dropped. Grab,
drop and capture each travel in both directions under one name, as they do
upstream -- `MsgGrabFlag` is both the client's request and the server's
broadcast of what it decided -- and the direction says which is which, since
neither side has a handler for the other's copy.

| message | direction | payload | upstream |
|---|---|---|---|
| `grabFlag` | to server | `{ index }` | `MsgGrabFlag` |
| `grabFlag` | to client | `{ playerId, flag }` | `MsgGrabFlag` |
| `dropFlag` | to server | none | `MsgDropFlag` |
| `dropFlag` | to client | `{ playerId, flag }` | `MsgDropFlag` |
| `captureFlag` | to server | `{ team }` | `MsgCaptureFlag` |
| `captureFlag` | to client | `{ playerId, index, flagTeam, baseTeam }` | `MsgCaptureFlag` |
| `flagUpdate` | to client | `{ flags: [...] }`, also embedded in `init` | `MsgFlagUpdate` |
| `nearFlag` | to client | `{ index, flagType, position }`, to one player | `MsgNearFlag` |
| `antidoteFlag` | to client | `{ position }` or `{ position: null }`, to one player | none |

`antidoteFlag` has no upstream counterpart because upstream has no packet to
have: its client picks its own antidote spot and asks for the drop when it gets
there. bzo's server picks the spot and decides the arrival, so it has to say
where -- see "Antidote flags" for why the authority moved.

Two deliberate departures from upstream's packets, neither a behaviour change:

- A hidden flag carries `type: null` rather than upstream's fake `"PZ"`. There
  is no wire compatibility to preserve here, and a packet that lies about the
  type is the sort of thing a reader has to disprove.
- `dropFlag` carries no position. Upstream sends the client's own position
  because the server's copy lags; bzo uses the server's copy, which is already
  movement-validated, so there is one less field to check and nothing to game.
  The difference is at most a frame of tank motion in where the flag lands.

## Phase 1 -- the Useless superflag (implemented)

16 superflag slots, upstream's `-s` default count, all of type `US`. Useless
does nothing by design, so the whole grab/drop/animation path can be exercised
with no gameplay effect to get wrong.

- Flags spawn through upstream's `addFlag()`: status `Coming`, a 3s hover-and-
  fall arc, and the warp disc stack.
- Grab is client-detected and server-validated; drop is the `Space` key, the
  XR `A` button, or the touch Drop button.
- A dropped flag flies upstream's parabola to whatever surface is below the
  tank, and either lands there or, on its fourth grab or anywhere but the
  ground, goes `Going` and vanishes. A vanished slot is refilled on upstream's
  halflife schedule (`FlagHalfLife` 10s, `bzfs.cxx:7621`).
- Dying, disconnecting, pausing, or self-destructing drops the carried flag
  (upstream `zapFlagByPlayer`).

**`flagsOnBuildings` reaches spawning and dropping by different routes.**
`resetFlag` passes `maxZ = 0` when it is off, so `DropGeometry::dropIt` takes its
short path and a flag always *spawns* on the ground; when it is on, `resetFlag`
picks a random altitude too and the downward ray decides which surface under it
the flag settles on. `dropFlag` always passes `maxZ = MAXFLOAT`, so a *dropped*
flag casts the full ray whatever the setting, and the setting only decides
whether a superflag may stay where the ray put it. With it off, a superflag
dropped on a roof takes the roof as its landing and goes `Going` from there,
rising out of the world rather than falling to the floor.

Either way a spawn must leave a tank-radius cylinder `_flagHeight` tall clear
above it, so a flag never appears somewhere a tank could not drive to reach.

bzo reads the switch as `-fb` from a map's `options` block or as
`flagsOnBuildings` in `server.json`, and either turns it on. `maps/hix.bzw` sets
it. Team flags ignore it entirely -- they always rest where the ray puts them.

**Grab radius is BZFlag's, not bzo's.** `FLAG_GRAB_RADIUS` is
`4.32 + 2.5 = 6.82`, built from BZFlag's tank radius rather than bzo's 2, for
the same reason the sound reference distance keeps 86.4: the figure scales with
the world, not the vehicle. A bzo tank would otherwise have to be almost
centred on a flag to take it. It is one constant in the shared pair if it needs
tuning.

## Phase 2 -- team flags and capture (implemented)

CTF is on when team mode is on and the map has bases, which is upstream's
`ClassicCTF`. Team flags come first in the flag array, as they do upstream, so a
team's flag index does not move when the superflag count changes.

- One team flag per colour team that has a base. Bases parse with a BZFlag
  colour index 1-4 in `server.js`; the flag home is the centre of the top of one
  of that team's bases. `maps/hix.bzw` has all four at z=26 h=4, so homes land at
  z=30.
- A team flag is `FlagNormal`: it never vanishes, never expires from grabs, and
  appears at its base rather than flying in. It leaves the world only when its
  team empties, and returns when the team's first player arrives
  (`bzfs.cxx:2478` and `:2966`). A flag an enemy carried off before the team
  emptied is cleared by `teamFlagTimeout` instead, default 30s.
- A dropped team flag rides the same downward ray onto whatever flat top it is
  standing over, and unlike a superflag it is allowed to stay there: team flags
  do come to rest on buildings. What it may never come to rest on is another
  team's base. When it would, upstream works down a
  chain: a drop zone, which bzo has none of, then the world centre, then its own
  base (`bzfs.cxx:3793`).
- Capture is carrying an enemy flag onto your own base, or your own flag onto an
  enemy base. The team that loses the flag is always the flag's own team, so an
  own goal costs your team and wins nobody anything. Everyone on the losing team
  dies with the standard explode delay and respawns on their base; the capping
  team gains a win and the capped team a loss (`bzfs.cxx:3994`). Upstream scores
  no individual deaths for a capture -- the team loss is the whole penalty.
- Spawning on base, from `RandomSpawnPolicy::getPosition`: in CTF that is every
  spawn, because `PlayerInfo::resetPlayer(ctf)` sets the flag at join, and it is
  set again for everyone caught by a capture.
- The `flag_alert`, `flag_won`, `flag_lost`, `teamgrab` and `killteam` sounds,
  and the "Flag Alert!!!", "Team Grab!!!" and "Don't capture your own flag!!!"
  alerts.

The capture cheat check only logs, as upstream's does -- every `removePlayer`
call in `bzfs.cxx` `captureFlag` is commented out. A quantized position and a
legitimate capture are hard to tell apart, and refusing an honest capture is
worse than trusting a modified client about a base it still had to drive to.

## What is left to add

Upstream carries 47 flag types: a Null type, four team flags, and 42
superflags. bzo has the four team flags and thirty-nine superflags -- everything
except `WA` Wide Angle, `BU` Burrow and `PZ` Phantom Zone -- so
**3 superflags remain**, 2 good and 1 bad. The table below is the whole list, grouped by the
machinery each group needs rather than by name, because the machinery is what
decides the order. `src/common/Flag.cxx` is the authority for every name,
abbreviation, endurance, quality and help string; `src/common/global.cxx` for
every constant named here.

| Phase | Flags | What it needs that bzo does not have |
|---|---|---|
| 4 | `WA` Wide Angle | **blocked**: no XR answer yet, see below |
| 14 | `BU` Burrow, `PZ` Phantom Zone | movement through and under geometry |

Phase 14 is a feature of its own and owes nothing to anything left, and `OO` has
already built the half of it that `PZ` needs. Phase 4 is down to its last flag,
and that one is blocked rather than merely unstarted.

Phase 13 was taken next because `CB` had already built most of it: a flag that
changes what one player sees of another needed one place where a remote tank's
appearance is decided, and `getEffectiveTankColor` is that place.

Phases 7, 8 and 9 were taken out of order. 9 hangs off a world switch rather than
off the phases before it, as `JP`, `NJ` and `WG` do. 8 turned out to need nothing
from phase 6 after all -- `flag` already reached `Projectile` and `shotBegin` with
Ricochet. 7 was asked for while `maps/flagbuffet.bzw` was on the test server,
which is the map that makes a size flag worth having, and it owed nothing to 4, 5
or 6 either.

Phase 7 paid forward to 11. `TH` Thief is a size flag as much as a shot flag, so
`_thiefTinyFactor` was one more case in `getTankDimensionScale` beside `T` and
`O`, and phase 8 had already made its shot three multipliers and a beam -- which
left the stealing as the only thing phase 11 actually had to build.

Phase 10 paid forward to the phase before it, which is why 6 came after it:
`applyShockWaveHits` had already established a sweep that kills several tanks
from one cause, and `SR` is the same shape asked against a radius rather than
against a wave.

## Phase 3 -- Identify (implemented)

The first superflag with an effect, and the one that makes an unidentified flag
on the ground worth walking up to. Everything hidden identity protects is
meaningless while every flag is the same flag.

Server-side and passive. `searchFlag()` finds the nearest flag resting on the
ground within `IDENTIFY_RANGE` 50 of a player carrying `ID`, and when that is a
different flag from last time sends `nearFlag` to that player alone. The client
puts `Closest Flag: <name>` on the HUD for 5 seconds and in the chat log.

- `nearFlag` is server-to-client, `{ index, flagType, position }`, and it is the
  one flag message sent to a single player rather than broadcast.
- The sweep runs off each accepted position update, as upstream runs it off
  `MsgPlayerUpdate` (`bzfs.cxx:5509`), not off the game loop -- a player who is
  not moving cannot have a new nearest flag.
- `player.lastIdFlag` is the dedupe. Upstream leaves it alone when the player
  stops carrying `ID`, so re-taking the flag beside the same flag stays silent;
  bzo clears it, because the answer is what a player who just picked the flag
  up is waiting for.
- A flag's identity stays hidden in `flagUpdate` regardless. Identify tells its
  carrier what one flag is; it does not reveal that flag to the world, which is
  why the message carries a type and the flag update still does not.
- The client guards on still carrying `ID`, as upstream does
  (`playing.cxx:2029`): the message can arrive a lag period after the flag is
  gone.
- The alert takes upstream's text and its 5 seconds but sits on slot 1 rather
  than slot 0. Driving past a row of flags reports each one, and slot 0 carries
  the death and kill notices, which a player has four seconds to read and cannot
  ask for again.

Do not confuse this with bzo's `identify` binding on `I` and right click, which
picks the tank in your sights. Same word, unrelated feature; the `ID` flag has
no key.

### Identity the client remembers

bzfs reveals a superflag's type only while somebody is carrying it, so a flag
that has been picked up and put back down goes anonymous again on the wire even
though the player watching it knows exactly what it is. `rememberFlagIdentity`
in the flags pair holds what a client has learned, keyed by flag index, fed by
`nearFlag` and by any flag state that arrives with a type on it -- which covers
a grab by anyone, since bzfs reveals it to everybody, and covers team flags,
which are never hidden.

The index is a *slot* rather than a flag, so the memory is dropped when the slot
empties or takes a flag flying in: its next identity is a fresh roll, and
keeping the old one would label a new Useless as the Identify that stood there
before it.

With the debug labels on, a flag whose identity this client knows carries its
abbreviation over it -- `ID`, `US`, or `B*` for the blue team flag, whose colour
already says so. A flag nobody has identified carries nothing, which is the
point. The label is created the first time a flag has something to say, so a
world of 200 flags does not pay for 200 label canvases to draw nothing.

### The registry rule this phase sets

**`FLAG_TYPES` holds only the flags bzo implements.** Adding a row is the last
step of implementing a flag, not the first, because the row is what:

- puts the flag in `superFlags.allowed`'s default, so the server starts handing
  it out (`normalizeSuperFlagConfig`, `server.js:2561`);
- documents it in the help panel, which `buildFlagHelp` generates from the same
  table so the two can never disagree;
- names it on the scoreboard, in the grab and drop messages, and in Identify's
  own answer.

A row with no behaviour behind it is a flag in the world that lies about what it
does. **This document is the list of what is missing. The code is not.**

Each row carries upstream's `name`, `abbreviation`, `endurance`, `quality`,
`team` and `help`, in upstream's declaration order, and `scripts/test-flags.mjs`
holds every row against those rules: a key matching its abbreviation, a name and
help string present, every bad flag sticky, every team flag normal.

### Where the pool comes from

`-s` sets how many superflag slots a world holds, `-f` takes a type or a whole
quality out of the pool, and a `zone` block's `zoneflag` pins a chosen count of a
chosen type inside that zone -- all three read from a map's `options` block or its
`zone` blocks, and all three are in. `superFlags.count` in `server.json` is the
baseline a map's `-s` replaces; `superFlags.allowed` still works but is redundant,
because absent it defaults to exactly the flags this table implements.

Upstream's `+f <abbrev>[{count}]` (`CmdLineOptions.cxx:757`) is the one still
missing. It pins a count of a type without a zone to put it in, which bzo has no
model for: a slot is either drawn from the pool or bound to a zone, with no third
state. Worth adding when there are enough flags for the mix to matter.

### The game style voids flags the world contradicts

`CmdLineOptions.cxx:1703` builds a `forbidden` set before any flag is placed, and
a type in it is voided everywhere at once -- `flagCount[ft] = 0`, out of the
random pool, and skipped by the zone-flag loop. bzo's `getForbiddenFlags` is the
same set, and carries the two rules whose flags exist:

| upstream rule | bzo |
|---|---|
| jumping on voids `JP`, off voids `NJ` | in |
| `+r` voids `R` | in |
| a world with no teleporters voids `PZ` | **missing**, `PZ` is phase 14 |
| a world with no teams voids `G` | **missing**, `G` is phase 6 |
| a world with no teams voids `CB` and `MQ` | **deliberately not taken**, see phase 13 |

The last two are not oversights yet -- none of those four flags exist -- but each
belongs in `getForbiddenFlags` in the same change that adds its flag, not later.
`PZ` on a world with nothing to phase through and `G` on a world with no teams to
wipe out are both a flag that lies about what it does, which is the thing this
document exists to prevent.

## Jumping, and the flags that carry it (implemented)

`JP`, `NJ` and `WG` out of order, because all three hang off one thing the world
did not have: a switch that says whether an ordinary tank may leave the ground.

**The switch.** `World::allowJumping`, upstream's `-j`, reaches bzo as a
`jumping` key in `server.json` and as `-j` in a map's `options` block. Upstream
has jumping off until the switch turns it on; bzo has had it on since before
there was a switch, so the default stays **on** and `jumping: false` is what
turns it off. A map's `-j` can still turn it back on, because a bzfs switch
never turns anything off -- the same rule `-fb` follows. It goes to the client
as `ALLOW_JUMPING` in the `init` config.

**`JP` Jumping.** Unstable, good, and forbidden outright while the switch is on
(`CmdLineOptions.cxx:1705`): a flag that grants what every tank already has is
worse than absent, because it looks like it does something. `superFlags.allowed`
may name it either way and the server drops it from the pool when it cannot
matter, and says so in the log.

**`NJ` No Jumping.** Sticky, bad, and forbidden the other way round from `JP`:
upstream drops it from the pool on a world that does not allow jumping
(`CmdLineOptions.cxx:1710`), because there it takes away what no tank had.
Exactly one of `JP` and `NJ` is ever in the pool, which is why
`getForbiddenFlags` forbids one or the other rather than testing each. The flag
itself is one clause in `canJump`: no jump from a surface, whatever the world
says. It came in with the shake timeout because it is the cheapest bad flag
there is -- the jump gate already asks the shared pair, on both sides -- and
because it finishes the switch that `JP` only half-answered.

Upstream leaves the altitude tape up under `NJ` (`playing.cxx:1465` tests only
`JP` and the world switch), and so does bzo.

**`WG` Wings.** Unstable, good, and never gated on the switch at all -- a flap
is a flap, whatever the map says. Wings is the one flag that drives and steers
off the ground (`LocalPlayer.cxx:342`); every other tank keeps the velocity it
took off with, which is what upstream calls dead stick and what bzo already did.

**Wings is four BZDB variables, and it plays as whatever a server sets them
to.** All four are `Locked` upstream, which means the server sets them and the
client obeys, so they are world configuration and travel to the client in the
`init` config with the rest of the physics. bzo reads them from `server.json`
rather than from upstream's `-set`, the same way it reads `tankSpeed` and
`gravity`, which upstream also only has as BZDB.

| `server.json` | BZDB | default | what it does |
|---|---|---|---|
| `wingsJumpCount` | `_wingsJumpCount` | 1 | flaps a surface refills, take-off included |
| `wingsJumpVelocity` | `_wingsJumpVelocity` | `jumpVelocity` | how hard a flap throws you |
| `wingsGravity` | `_wingsGravity` | `gravity` | how fast a wings tank falls |
| `wingsSlideTime` | `_wingsSlideTime` | 0 | seconds to reach the speed the stick asks for |

The count is what decides whether Wings is a flying flag or a steering one. A
surface refills it every tick and the take-off spends one, so at the stock 1
there is one jump and no flaps left -- Wings is then worth carrying for its air
control alone, which is why servers that want tanks to actually fly raise it.
The flap you have left over after driving off a ledge is the interesting case:
upstream slows a falling tank rather than relaunching it
(`newVelocity[2] += oldVelocity[2]`), and one already rising faster keeps what
it has, so a flap taken late in a dive buys almost nothing.

`_wingsJumpVelocity` and `_wingsGravity` have no values of their own upstream --
they are the strings `"_jumpVelocity"` and `"_gravity"` -- so a server that says
nothing about them gets a wings jump identical to an ordinary one. Leave the keys
out of `server.json` for that; spelling either one out as `null` means the same.
`_wingsSlideTime` above zero puts momentum in the air: the stick adds to the
velocity the tank has rather than replacing it (`doSlideMotion`).

`getMaxWorldHeight` (`bzfs.cxx:1264`) exists upstream because raising the count
raises how high a tank can get, and the clouds have to start above that. bzo's
`getJumpApexHeight` answers the same question.

**The jump control is one press, one jump, which upstream's is not.** Upstream
binds `jump` on both press and release: the press sets `wantJump`, the release
clears it, a refused jump leaves it set so the request fires the moment the tank
lands, and -- because `SDL2Display` does not filter `event.key.repeat` -- holding
the key re-sets it at the operating system's key-repeat rate. On a jumping world
that reads as bouncing; with `_wingsJumpCount` above 1 it means a held key dumps
every flap in a fraction of a second, once the repeat delay has passed.

bzo has no key-repeat event to inherit. Every input surface it has -- the
keyboard, the touch button, an XR grip, a gamepad face button -- reports the jump
control as a held boolean sampled once a frame, so copying upstream would spend
the flaps at frame rate, which is both faster than upstream and different on
every machine. bzo takes the rising edge instead: one press, one jump. A tank
coasting through the air does not sample the sticks at all, so landing re-arms
the control and holding jump still bounces a tank down a building, which is the
part of upstream's behaviour worth having. What bzo does not carry over is the
pending request: a flap asked for in mid-air with no flaps left is dropped rather
than queued for the landing.

A flap is `SFX_FLAP` rather than `SFX_JUMP`. Upstream announces it to the other
clients with `PlayerState::WingsSound`; bzo already knows who is carrying what,
so the flag answers and there is no bit in the packet.

The shared pair answers all of it: `canJump(abbreviation, allowJumping,
airborne, flapsLeft)`, `hasAirControl(abbreviation)`,
`getWingsJumpVelocity(wingsJumpVelocity, verticalVelocity)` and
`getWingsSlideVelocity(...)`. The client gates the key with them and the server
re-asks on every jump it sees, because bzfs does not check jumping at all and a
modified client would otherwise fly on a world that forbids it. The server does
not follow the flap count -- that would mean running the client's whole
ground/air state machine off position updates -- so it asks the weaker question
it can answer, may this tank leave a surface, and logs a refusal as
`[ANTICHEAT:...] JUMP REJECTED`. Wings' own gravity does reach the server, which
extrapolates a wings carrier at `_wingsGravity` so a lower one does not read as
vertical drift.

The altitude tape follows upstream's own rule (`playing.cxx:1465`): it is up
while the world allows jumping or `JP` is in hand. Upstream does not list Wings
there and neither does bzo.

## Getting rid of a bad flag (implemented)

Upstream's three ways out, taken ahead of the bad flags they exist for, because
no bad flag is playable without at least one of them. All three are off by
default as upstream has them, and each may be turned on from `server.json` or
from a map's `options` block; with none of them on, dying is the only way out.
`describeBadFlagRelease` on each side answers "how does this world let me put it
down", for the startup log on the server and for the message a player gets on
picking one up.

### The shake timeout

`-st` upstream, and the first of the three, because it is the one that makes a
bad flag playable by itself and needs nothing from the others. Reached as
`flagShakeTimeout` in `server.json`
and as `-st <seconds>` in a map's `options` block -- the one map switch that
takes a value -- and, as with every bzfs switch, a map may turn it on where
nothing turns it back off, so the larger of the two wins. Off by default, as
upstream has it: with no timeout a bad flag is carried until it kills you.

Both sides normalize through `normalizeShakeTimeout` in the flags pair, which
clamps to 0.1s..300s and rounds to the tenth of a second upstream stores on the
wire (`CmdLineOptions.cxx:1268`). Rounding matters because both sides count the
same number down and neither may be a frame ahead of the other.

**The client owns the countdown and the server owns the clock.** The client
resets `shakeSecondsLeft` when it takes a sticky flag, subtracts each frame
delta, and sends `dropFlag` at zero -- upstream's `LocalPlayer::doUpdate`
(`LocalPlayer.cxx:159`) exactly. The server records `flag.grabbedAt` at the grab
and puts the drop request through `canShakeFlag` before it agrees, because
without that a modified client sheds a bad flag on contact. A refusal is logged
as `[ANTICHEAT:...] SHAKE REJECTED`.

Two differences from upstream fall out of that, both in the shared pair:

- `SHAKE_DROP_GRACE_SECONDS` 0.25. The server's `grabbedAt` is when it *saw* the
  grab, which is later than the client's, so the server's clock is always a
  little behind and would refuse an honest request. Lag only ever makes the
  request late, never early, so the grace is for that gap and for clock drift,
  nothing more.
- The client does not latch at zero the way upstream does. Upstream's server
  never refuses, so upstream never has to ask twice; bzo's can, so a countdown
  that has run out re-asks on the same 200ms throttle the grab uses, and the
  drop lands the moment the server's clock agrees.

A shaken flag goes through the ordinary `dropFlag`, and a sticky flag has one
grab in it (`FlagInfo.cxx:135`), so shaking one off spends its last grab and it
leaves the world rather than lying in wait for the next tank.

**The display is upstream's, in upstream's own slot.** `playing.cxx:1455` names
the flag you just took on HUD alert slot 2 for three seconds, in the warning
colour when it is one you cannot put down, and `HUDRenderer.cxx:998` replaces
the status line with the time left to a tenth while a bad flag is in hand. bzo
has no status line, so the countdown holds slot 2 for as long as the flag lasts
-- which is the same information in the same place, and it reaches the XR panel
for free because `getActiveHudAlerts` is shared. Pressing the drop control on a
sticky flag says how this world lets you put it down rather than sending a
request the server will refuse.

### Shake wins

`-sw` upstream: a count of kills, clamped 1..20 by `normalizeShakeWins`
(`CmdLineOptions.cxx:1288`), armed when a sticky flag is taken and counted down
by each kill until it drops.

**This one lives entirely on the server**, which is where it differs from
upstream. `LocalPlayer::changeScore` (`LocalPlayer.cxx:1714`) counts it down on
the client and asks for the drop, because upstream's client is told its own
score and upstream's bzfs accepts any drop request. bzo's server is what decides
a kill happened, so counting anywhere else would mean shipping the count out and
taking the answer back on trust. `recordShakeWin` hangs off the one place a kill
is credited, and the client simply sees the flag go.

Upstream counts a win and only a win -- never a loss, never a teamkill -- and so
does bzo, because the hook is inside the `shooter.id !== player.id` branch that
guards `kills++`.

Nothing is displayed while it counts down. Upstream shows nothing either, and
the grab message already said how many kills it would take.

### Antidote flags

`-sa` upstream: while you carry a bad flag, a yellow flag stands somewhere in
the world, and driving onto it sheds what you are carrying.

The spot is `LocalPlayer::setFlag`'s (`LocalPlayer.cxx:1668`) -- a random point
inside a square centred on the world, half the world wide on a CTF map and the
world less a base width otherwise, rejected and re-rolled up to a hundred times
while a tank would not fit there. `getAntidoteCoordinate` in the flags pair
answers one axis and is called twice; the clearance test is the server's own
`checkCollision` at tank radius, which is upstream's
`inBuilding(pos, tankRadius, tankHeight)`.

**The server picks the spot and decides the arrival, which upstream's client
does.** This is the one real departure in the group, and the shake timeout is
the reason for it: bzo's server refuses a sticky drop it has not agreed to, so
an antidote the client placed would mean accepting *every* sticky drop from
anyone on a server with `-sa` on, which would undo that validation entirely.
Moving it costs one message -- `antidoteFlag`, sent to its owner alone the way
`nearFlag` is -- and makes the antidote as server-authoritative as the timeout.

Arrival is `checkAntidote`, which runs off each accepted position update as
`searchFlag` does, and asks the two questions the flag grab asks: on the same
level, and within `FLAG_GRAB_RADIUS`. Upstream's own test is a 2D distance
against `getRadius() + flagRadius` gated on `location == OnGround`, which is the
same pair of questions in the other order.

The client draws it three ways, which are upstream's three:

- **The flag itself**, yellow (`LocalPlayer.cxx:1695`). It takes a key of its
  own in the flag node pool -- a string rather than a flag index -- so it gets
  the cloth, the ripple and the billboarding without a second code path, which
  is what upstream gets from reusing `FlagSceneNode`.
- **The radar**, in flat yellow over every flag in the world
  (`RadarRenderer.cxx:715`), because it is the one you are looking for.
- **The heading tape**, a yellow marker beside the team flag markers
  (`playing.cxx:6847`). `getFlagHeadingMarkers` returns both, and it no longer
  gives up early on a world with no teams, since the antidote does not need one.

## Phase 4 -- the bad flags that only change your own view (three of four in)

`B` Blindness, `JM` Jamming and `CB` Colorblindness are **implemented**. `WA`
Wide Angle is **blocked on the XR discussion** and is the only thing left in this
phase.

All three that landed are honoured entirely on the carrier's own client, which is
where upstream honours them: there is no packet and no server rule, because a
modified client that ignored one would only be cheating itself out of a penalty
it is already carrying. The server's whole part is three rows in the flag table.
The predicates -- `blanksTheView`, `jamsTheRadar`, `hidesTeamColors` -- live in
the flags pair so the table stays the one place a flag is described.

**`B` Blindness.** "Can't see out window.  Radar still works." Upstream sets
`SceneRenderer::setBlank` (`playing.cxx:6212`), the same switch it uses for a
paused tank, and keeps drawing the HUD. bzo has one switch that says the same
thing on both surfaces: everything the game draws hangs off `worldGroup` and
every HUD panel hangs off the camera, so `renderManager.setBlank` hides the
former and the latter is untouched. The sky background goes black with it -- a
blinded tank should not be able to read the time of day off the horizon. Nothing
XR-specific was needed, because the split it relies on is the one XR already
uses.

**`JM` Jamming.** "Radar doesn't work.  Can still see." Upstream paints a noise
texture over the whole panel at full white and draws nothing else
(`RadarRenderer.cxx:433`), so the radar is *gone* rather than dimmed. bzo has no
noise texture and generates the static instead -- one grey level per cell of a
coarse grid, which reads as static at radar size for a few hundred fills.

**The static is translucent, and that is a deliberate divergence.** Upstream can
afford opaque noise because its radar owns a region of the screen outside the 3D
viewport, so covering it costs the view nothing. bzo's radar floats *over* the 3D
view, where opaque static would take away part of what the flag explicitly leaves
you. A jammed frame therefore *replaces* the panel background rather than covering
it, at the same alpha the background would have had -- so the jammed panel is
exactly as heavy as a working one, no more of the world is hidden while jammed
than the radar hides anyway, and the panel does not appear to change weight as
static and good frames alternate. `RADAR_JAM_STATIC_ALPHA` is derived from the
panel's own two numbers rather than picked, so the two cannot drift apart.

The cadence is upstream's and is the interesting half. `decay` is the chance of a
good frame: it starts at 0.01 and the noise branch leaves it there, so about one
frame in a hundred breaks through; that frame sets decay to 1, which *guarantees*
a second good frame, and it halves per frame until noise takes over again. So a
jammed radar gives a readable burst every second or two rather than an even
flicker, and you can learn to play off the bursts. `getNextRadarJamDecay` in the
flags pair is that rule, and `scripts/test-flags.mjs` holds it to the two
properties that matter: a good frame is always followed by another, and the decay
always settles back to the floor.

**XR is free here**, and worth saying why rather than leaving it to be
rediscovered: the XR radar panel is textured *from the DOM radar canvas itself*,
so anything drawn into that canvas is in the headset on the same frame. Jamming
needed no XR path at all.

**`CB` Colorblindness.** "Can't tell team colors.  Don't shoot teammates!"
Upstream substitutes `RogueTeam` for the real team wherever a remote player's
colour is asked for -- the radar blip (`RadarRenderer.cxx:133`), the tank and its
shots (`playing.cxx:6168`, `Player::addShots`'s `colorblind` argument) -- and
suppresses the hunt flash on the radar.

bzo needs one extra thought here, because bzo does not colour tanks by team:
every player gets a colour of their own, and in team mode the server shades team
mates apart *within a band around the team colour* (see "Radar colours" in
`AGENTS.md`). That band is exactly where the team is legible, so replacing the
player colour with rogue is the faithful move and `getEffectiveTankColor` is the
one place it happens -- tank body, shots and blip all ask it. Your own tank keeps
its colour, as it does upstream.

**Rogue, and deliberately not the viewer's own colour** -- which is worth writing
down because phase 13's `MQ` went the other way and the two look like the same
question. They are not. `MQ`'s upstream value is `myTank->getTeam()`, which is
genuinely ambiguous in bzo because bzo splits "the viewer's team" from "the
viewer's colour"; `CB`'s is `RogueTeam`, a fixed third colour that is nobody's in
particular. Taking the viewer's colour there would be a different rule rather
than a different reading, and a worse one on three counts:

- it would make `CB` and `MQ` **indistinguishable on screen**, so the precedence
  between them -- `CB` wins, since upstream consults Masquerade only `if
  (!colorblind)` -- would stop being observable at all;
- rogue *means* no team in BZFlag, so painting everyone rogue says "team
  unknown", which is what colourblindness actually gives you. Everyone in your
  own colour says "all friendly", which is a misleading instruction from a flag
  whose help is "Don't shoot teammates!";
- and both are equally uniform, so both satisfy the only thing the flag has to
  do. With that tied, the tie breaks on which signal is honest.

Outside team mode bzo hands colours out from the whole wheel, so rogue is a
genuinely neutral value there too rather than a colour somebody already has.

Two consequences worth knowing:

- A tank is *built* from its colour rather than tinted -- the body texture and
  the name label are both generated from it -- so a change of colourblindness
  rebuilds the remote tanks rather than recolouring them. That happens at once on
  the flag change, not on each tank's next update, because a tank sitting still
  would otherwise keep a colour it is no longer entitled to.
- `ID` Identify degrades with it. Upstream drops to "Looking at a tank" rather
  than naming the callsign (`playing.cxx:4479`), because the name would give away
  the team the colour no longer does. Phase 3 is already in, so this is a real
  interaction rather than a note for later.

The scoreboard is deliberately **not** colourblinded, which is upstream's choice
too: its list of who is on which team stays readable, so the flag costs you the
ability to read a team off a tank in front of you and not the ability to know the
teams exist.

**`WA` Wide Angle -- blocked.** Field of view goes to `_wideAngleAng` 1.745329
rad (100 degrees). On the flat canvas that is one camera value. In XR the headset
owns the projection: the runtime sets it from the device's optics, and a client
that overrode it would either be ignored or would make people ill. So `WA` has no
XR implementation, and bzo's rule is that a flag needs one before it ships --
otherwise the same flag is a real penalty in the browser and a no-op in a headset,
which is worse than not having it.

The options, none of them chosen yet:

1. **Widen the flat view only, and let it be a no-op in XR.** Simplest, and
   dishonest in the way the rule exists to prevent.
2. **Substitute a different penalty in XR** -- a vignette, or a blur at the
   edges -- so the flag costs something on both surfaces without touching the
   projection. Not upstream's effect, but upstream's *intent*.
3. **Forbid `WA` on a server whose players are in headsets**, the way the game
   style already voids `JP` and `NJ`. Honest, and it makes the flag pool depend
   on who is connected, which nothing else does.

This wants a decision before code.

## Phase 5 -- the motion resolver, and the movement flags (implemented)

Eleven flags, one piece of machinery. Every one of them is a multiplier or a
clamp on tank motion, and both sides need the same answer: the client predicts
the move, the server validates it against the client's own reported velocities
(`validateMovement`, `server.js:2145`), so a speed multiplier the server does
not know about reads as linear drift.

Add to the shared pair, beside `getShotEffects`, which phase 8 built to the same
shape and is the model to copy:

```
getMotionEffects(abbreviation) -> {
  speedFactor, angVelFactor,
  linearAccel, angularAccel, friction,   // null means use the world's
  forwardOnly, reverseOnly, leftOnly, rightOnly, reverseControls,
  canJump, mustJump, mustFire,
  ...
}
```

Pure, table-driven, tested by `scripts/test-flags.mjs` against upstream's
numbers. `motion.mjs` and its `.cjs` twin take it as an argument rather than
looking it up, so they stay pure too. The call site on the client is wherever
input becomes velocity; on the server it is the extrapolation in
`getExtrapolatedPosition` and the drift thresholds.

Upstream applies these in `LocalPlayer::getMaxSpeed` (`LocalPlayer.cxx:1100`),
`getMaxAngVel` (`:1156`) and `doUpdateMotion` (`:1541`):

| Flag | Effect | Constant |
|---|---|---|
| `V` High Speed | speed x1.5 | `_velocityAd` |
| `QT` Quick Turn | turn x1.5 | `_angularAd` |
| `A` Agility | speed x2.25 for `_agilityTimeWindow` 1.0s after a direction change of at least `_agilityVelDelta` 0.3 | `_agilityAdVel` |
| `M` Momentum | acceleration limited to `_momentumLinAcc` 1.0 and `_momentumAngAcc` 1.0, friction `_momentumFriction` 0 | bad |
| `RC` Reverse Controls | drive and turn inputs negated | bad |
| `FO` Forward Only | reverse speed clamped to 0 | bad |
| `RO` Reverse Only | forward speed clamped to 0 | bad |
| `LT` Left Turn Only | right turn clamped to 0 | bad |
| `RT` Right Turn Only | left turn clamped to 0 | bad |
| `BY` Bouncy | jumps continuously on landing (`LocalPlayer.cxx:877`) | bad |
| `TR` Trigger Happy | fires continuously (`LocalPlayer.cxx:1308`) | bad |

### The three good ones

`getMotionEffects` is in the shared pair, shaped like `getShotEffects` as the
plan above asked: two multipliers on the world's own tank speed and turn rate,
and one boolean for the rule that is not a number. `V` and `QT` are a number
each. Agility is the boolean, because it has a clock.

**The wire carries speed, not stick.** `fs` and `rs` are fractions of the
*world's* base speed and turn rate, so a boosted tank reports more than 1 and
every reader -- `getExtrapolatedPosition`, the client's remote extrapolation, the
tread animation -- multiplies by the world's own figure and is already correct.
Nothing but the client needs to know which flag is in hand. That is what made
this land without the server growing a copy of the motion resolver, which is the
shape the plan above feared.

**The server holds a bound, not an instant.** `getMaxSpeedFactor` answers the
most a flag could ever manage -- 2.25 for Agility, whether the window is open or
not -- and the server clamps the reading to it. Mirroring a one-second window off
packets that do not carry the stick would be a second copy of a state machine to
disagree with; a ceiling costs nothing. It is a looser gate than upstream's, and
the same trade as the shot position tolerance.

**Agility is exempt from the acceleration check**, on its forward half only. The
window opens and the tank is 2.25x faster in that same frame, so no acceleration
bound describes it -- which is already why a `WG` tank is exempt in the air. Its
turn half still applies, because Agility does not touch turning.

**Upstream's own details, kept.** The window does not extend while it is open, so
holding the stick buys one second and not more, and a reverse needs half the
change to trigger because a reverse is a smaller number to begin with.

**One upstream detail deliberately not kept: what the change is measured
against.** Upstream compares the new stick with the previous *`desiredSpeed`*
fraction, which may itself already be boosted, clamped to [-0.5, 1]:

```
float oldFrac = desiredSpeed / BZDBCache::tankSpeed;   // can be up to 2.25
if (oldFrac > 1.0f) oldFrac = 1.0f;
```

That clamp invents a change that never happened. A half-forward stick boosts to
1.125, clamps to 1.0, and next frame `|0.5 - 1.0|` clears the 0.3 limit -- so the
boost re-triggers for as long as the stick is held:

| stick held | upstream | bzo |
|---|---|---|
| 1.0 | boosts once, expires | boosts once, expires |
| 0.7 down to about 0.4 | **boosted permanently** | boosts once, expires |
| 0.3 or less | never triggers | never triggers |

An upstream Agility tank holding half forward sits at 28 units a second
indefinitely -- faster than anybody at full throttle -- without ever moving the
stick. Agility rewards *changing* direction, and holding still is not changing,
so half stick outweighing full stick is a bug and not a rule.

It is invisible upstream because a keyboard stick is only ever 0 or +/-1, where
both readings agree exactly. bzo has analog input everywhere -- touch, gamepad,
XR thumbsticks -- so it would be the normal case here rather than the corner.
bzo therefore measures against the previous **stick**, and Agility is agile at
every stick position and on every real change.


### The seven bad ones

Five of them clamp the stick and two act without it, and none is a multiplier --
which is why they extend the table the good three built rather than needing one
of their own. Every one is a boolean in `MOTION_EFFECTS`.

**The clamps go on the raw stick**, where upstream puts them: `RC` is negated
where input is gathered (playing.cxx:983 for the keyboard, :1021 for the mouse)
and the four "only" flags are clamped in `setDesiredSpeed` and
`setDesiredAngVel`. Doing it there rather than on the resolved velocity means
everything downstream -- the acceleration smoothing, Agility's window -- sees
what the tank was actually asked to do. bzo's signs happen to agree with
upstream's: positive forward is forwards and positive turn is left, which is why
`LT` clamps the negative side and `RT` the positive.

**`RC` pressing forward drives backwards at half speed**, because the negation
lands before the reverse-speed clamp: a full forward stick becomes a full reverse
one, and reverse is capped at `REVERSE_SPEED_RATIO`. That is upstream's order and
it is the right one -- the flag reverses the controls, it does not turn the tank
around.

**These stay client-side, as upstream has them.** The server does not re-derive
the clamps, because `fs` and `rs` are measured from the resolved displacement: a
tank sliding along a wall legitimately reports a sign it never asked for, and a
server clamp would rubber-band an honest `FO` tank scraping backwards off a
corner. They are handicaps, and removing one with a modified client is cheating
yourself out of a punishment.

**`BY` Bouncy is out of the jump gate entirely.** `canJump` answers yes for it
whatever the world says, which is upstream's `(flag != Flags::Bouncy)`
(LocalPlayer.cxx:1425) and most of what makes it a punishment rather than a
second `JP`. Landing buys `BOUNCE_DELAY` 0.2s and every frame after that is a
bounce, each a random quarter-to-full of the world's jump velocity -- the
randomness is the flag, since a fixed bounce would just be jumping you did not
ask for.

That randomness broke something on the way in. **The server inferred a jump from
`vv > 10`**, a flat number that predated every flag. A Bouncy bounce starts as
low as 4.75 at bzo's default, so the server missed those jumps outright and went
on extrapolating the tank along the ground while it was in the air. The threshold
is now a tenth of the world's own jump velocity: clear of the two-decimal
quantization on the wire, under anything that could be a real jump, and it
follows a server that has tuned the jump.

**`TR` Trigger Happy pulls the trigger every frame** whether or not anybody is
holding it (playing.cxx:7345), and upstream's `firingStatus` stays Ready however
long the reload has left. So it skips bzo's reload gate and waits only for a free
shot slot -- which is not a rate increase, because a free slot is the rule the
server already holds every shot to. It changes who pulls the trigger, not what
leaves the barrel: `getShotEffects('TR')` is the world's own shot.

### `M` Momentum, and the inertia it belongs to

`M` was left until last because it is not a clamp on anything -- it is an
acceleration model, and bzo had one of its own that had to go first.

**Upstream has no inertia by default.** `doMomentum` limits how fast a velocity
may change, but only `if (linearAcc > 0.0f)`, and that limit comes from bzfs's
`-a <vel> <rot>`, which defaults to `0 0`. A stock BZFlag tank reaches full speed
in one frame. bzfs calls the switch inertia in its own comments, sends both
figures to every client in the world settings packet, and reads a map's `options`
block through the same parser as its command line -- so `-a` is a game style a
map may set, like `+r`.

**bzo had inertia BZFlag does not, and no way to turn it off.** Five rates of its
own -- `forwardAccel`, `reverseAccel`, `forwardDecel`, `turnAccel`, `turnDecel`
-- smoothed the *stick* rather than the velocity, at roughly `-a 2.25 2.36`, set
only in `server.json` and never reachable from a map. That is the opposite of the
goal: bzo is meant to feel like BZFlag and offer the same knobs for changing it.
So the five rates are gone, `-a` is in at both levels with upstream's `0 0`
default, and `doMomentum` is in the shared pair where the client that drives the
tank and the server that checks it both run it.

**`M` composes with the world rather than replacing it.** Upstream substitutes:

```
linearAcc = (flag == Momentum) ? _momentumLinAcc : World::getLinearAcceleration();
```

`_momentumLinAcc` and `_momentumAngAcc` both default to 1.0 -- exactly what `-a
1 1` gives -- so upstream's `M` does *nothing at all* on such a world, and on
anything heavier it is an **upgrade**. That is a strange thing for a bad flag to
be. bzo adds the reciprocals instead, the way two constraints on one quantity
combine, which reduces to upstream's own figure on a world with no inertia and
makes `M` a handicap everywhere else:

| world `-a` | no flag | with `M` | upstream's `M` |
|---|---|---|---|
| `0 0` (default) | no limit | 20 u/s² | 20 u/s² |
| `1 1` | 20 u/s² | 10 u/s² | 20 u/s² (no effect) |
| `0.5 0.5` | 10 u/s² | 6.7 u/s² | 20 u/s² (faster) |

That table is the whole of the deviation, and it is the only one in the phase.

**`_momentumFriction` is not implemented.** `doFriction` limits how fast the
velocity *vector* may swing, which bites when turning at speed; `_friction`
defaults to 0 and `_momentumFriction` is 0, so neither does anything on a default
world. Worth knowing that upstream's `M` therefore *removes* friction from a
world that had set it -- one more way its `M` can be an upgrade.

`NJ` No Jumping is out of this group and in already: it is a clamp on the jump gate rather
than on the motion resolver, and the gate has asked the shared pair since the
jumping switch landed. See "Jumping, and the flags that carry it".

`TR` is a firing rule rather than a motion one, but it belongs here: it is an
input clamp, and the resolver is where input clamps live.

## Phase 6 -- damage rules (implemented)

Three flags that change what a hit does rather than what a shot is. bzo's server
owns hit detection, which makes all three server-side and simpler than upstream.

### `SR` Steamroller

**Touching a tank kills it**, within the victim's radius plus `_srRadiusMult` 2.0
of the roller's. It is the only rule in the game that runs off nothing but where
two tanks are -- no shot, no geometry, no event -- so it gets a sweep of its own
in the game loop rather than a hook on something that was already happening.

**The reach is measured in tank radii, so it takes bzo's tank and not BZFlag's.**
This is the other side of the rule `BZFLAG_TANK_RADIUS` and `_shockInRadius`
follow: those are distances through the world and transfer unchanged, while a
reach built from the vehicle has to shrink with it. A bzo tank is half as wide,
so a Steamroller measured in upstream's radii would kill from twice as far away
as it looks. Both radii are scaled by whatever the tank's flag does to its size,
because upstream reads both off `Player::getRadius` -- so `T` Tiny is harder to
run over *and* has a shorter reach, and `O` Obesity is the reverse.

**The vertical separation counts double.** Upstream's distance is
`hypot(hypot(dx, dy), dz * 2)`, so a tank a storey above you is twice as far away
as the same gap along the ground and cannot be squashed through a roof. (Upstream
names the result `distSquared` and compares it to an unsquared radius. The name
is wrong; the comparison is right.)

**bzo sweeps on the server; upstream sweeps on each client.** Upstream runs the
loop for the local tank only, in the same else-chain that has already decided it
was not killed by a shot, by death touch or by water. bzo's server decides every
kill, so it runs the whole sweep once -- a client that decided it had been run
over would be a client that could decide it had not. The sweep costs one pass
over the players while nobody is carrying the flag, which is the normal case.

`_squishFactor` and `_squishTime` only flatten the victim's model as it dies.
That is cosmetic and still to do.

### `G` Genocide

**Killing one tank kills its whole team.** Read off the *shot*, so it is asked
where a shot kills somebody rather than anywhere a tank happens to die -- the
projectile has carried its firing flag since Ricochet.

Upstream detects it on each client (`playing.cxx:2655`), because upstream's
clients report their own deaths; bzo asks once, on the server that decided the
kill. The outcome is identical and the check is not duplicated per client.

**Only on a world with teams** -- "geno only works in team games :)" is
upstream's own comment -- **and never for rogue**, whose players share a name
rather than a side. bzo goes one step further than upstream and takes `G` out of
the flag pool entirely on a world without teams, as it already takes out `JP` on
a world that always jumps and `R` on one that always bounces; upstream leaves it
in and lets it do nothing.

**The shooter's own team is not consulted.** A Genocide shot that killed a team
mate takes the rest of the shooter's team with it. That is upstream's rule, and
with a team killer dying for it by default the shooter goes too.

### Friendly fire, and what it costs

Phase 6 is where team kills stop being incidental, so the two switches upstream
guards them with arrived with it. They are not the same switch and they run in
opposite directions:

- **`-noTeamKills`** -- "Players on the same team are immune to each other's
  shots. Rogue is excepted." Friendly fire off. Off by default. Upstream refuses
  the hit on the victim's own client (`LocalPlayer::checkHit`); bzo refuses it in
  the one place that decides hits, which covers shots, shock waves and being run
  over together.
- **`-tk`** -- "player does not die when killing a teammate". Note which way this
  runs: upstream kills a team killer **by default** (`teamKillerDies` starts
  true) and `-tk` is what turns that off. So bzo's default is the strict one, and
  the switch is the lenient one.

Either way a team kill scores the killer a death rather than a kill, which is
upstream's `score.killedBy()` in place of `score.kill()` -- so it never counts
towards shaking a bad flag either. `areFoes` in the teams pair is the one answer
to who may kill whom: everyone on a world with no teams, and every rogue always.

`-tkkr` (kick a player over a team-kill ratio) and `-tkannounce` are not
implemented. Kicking is not something a development test server wants.

### `SH` Shield

Being shot drops your flag instead of killing you, and the flag flies
`_shieldFlight` 2.7 times the normal altitude, so it is in the air
sqrt(2.7) ~ 1.64 times as long -- long enough to drive back under it.

The altitude is one argument: `getFlagThrownAltitude` in the shared pair answers
`_shieldFlight * _flagAltitude` for `SH` and `_flagAltitude` for everything else,
and `dropFlag` passes it to `computeFlagFlight`, which already took a thrown
altitude. It applies to every way a Shield leaves a tank, not only to a hit,
because upstream tests the type in `FlagInfo::dropFlag` and nothing else
(`FlagInfo.cxx:174`). A flag flying *in* is untouched: `addFlag` settles its arc
before it picks a type, so a Shield arrives like anything else.

The hit path asks `shieldsAgainstShot` before it kills. When it answers, the
shot ends where it struck, the tank keeps its health, `dropPlayerFlag` throws
the flag, and nobody scores -- no kill, no death, no shake win, and no
`playerHit`, so no client explodes anything. The client needs no new message:
the `shotEnd` draws the impact and the `dropFlag` it already handles plays the
drop sound and says what was lost, which is exactly the feedback upstream gives
(`playing.cxx:3919` skips the explosion and the alert; `handleFlagDropped`
still plays `SFX_DROP_FLAG`).

**Only a shot.** Upstream tests the reason as well as the flag, so a shielded
tank is still killed by a capture, by a self-destruct, and by the flags that
kill without a shot when they arrive. That falls out for free here: those paths
do not run through the projectile sweep.

**A shot is spent by the first tank it reaches.** The sweep tests the projectile
against every player, so it checks that the projectile is still in flight before
each one: a shot that has already killed a tank, or been taken by a shield, has
nothing left to hit the next tank with. Upstream never has this to decide --
each client tests only its own tank, so one shot is one hit by construction.

## Phase 7 -- per-player tank dimensions (implemented)

Three flags, and one size that used to be the same for every tank. The scale is a
pair rather than a number, because upstream's `Player::updateFlagEffect`
(`Player.cxx:733`) sets the length and width targets separately and never touches
height at all -- so a Tiny tank is short and stubby rather than small, and an
Obese one is wide rather than tall.

| Flag | Effect | Constant |
|---|---|---|
| `T` Tiny | length and width x0.4 | `_tinyFactor` |
| `N` Narrow | width x0.001, length untouched | literal in `Player.cxx:756` |
| `O` Obesity | length and width x2.5, too wide for a teleporter | `_obeseFactor` |

`getTankDimensionScale` in the flags pair is the whole rule, and the factors are
upstream's while the bases stay bzo's -- `TANK_HALF_WIDTH` 1.4 and
`TANK_HALF_LENGTH` 3.0 in the collision pair, which are upstream's own halved
dimensions, and `TANK_HIT_RADIUS` 2, which is not.

**Where the size is asked.** `testOrigRectTank` and `pyramidIntersectsTank` take
the scale, so obstacle collision, the swept step and `findSupportSurface` all use
it on both sides of the wire: a narrow tank really does fit sideways through a gap
nothing else fits, and an obese one is stopped by a teleporter's portal interior
without a rule of its own, because that interior is checked at full size.

**The hit shape is not the collision shape, and that is upstream's doing.**
`Player::getRadius` (`Player.cxx:204`) is `dimensionsScale[0] * _tankRadius` --
the *length* scale on the radius -- and carries upstream's own note: "this
encompasses everything but Narrow -- the Obese, Tiny, and Thief flags adjust the
radius, but Narrow does not." Narrow only touches the width, so the sphere it
would otherwise keep is full size. `SegmentedShotStrategy::checkHit`
(`SegmentedShotStrategy.cxx:262`) therefore gives Narrow a box of its own, and
says why in place: *"width of box is shell radius so you can actually hit narrow
tank head on"*. So:

- every flag but `N` meets a sphere, scaled by the length factor;
- `N` meets an oriented box, `getSegmentBoxHitFraction` in the collision pair,
  whose half width is the **shell radius** and whose half length is the tank's
  own -- not `NARROW_FACTOR`, which would be unhittable from the front rather
  than hard to hit.

bzo does not apply upstream's `0.99 *` shrink on the sphere, because bzo's base
radius is its own number rather than `_tankRadius`.

**The ease is cosmetic only.** Upstream eases the scale in over
`_flagEffectTime` 0.64s and its collision uses the eased value, because upstream
tests hits on the victim's own client. bzo's server owns hits, so the gameplay
size is the **target** from the moment the flag changes hands and only the drawn
tank eases -- `updateTankDimensions` keeps upstream's `dimensionsScale`,
`dimensionsTarget` and `dimensionsRate` per tank and fixes the rate when the
target changes, which is what makes the ease linear and exactly
`_flagEffectTime` long however far it has to travel. A hitbox that disagreed with
the server for two thirds of a second would be worse than a tank that changes
size faster than it looks like it should.

The server-position ghost is scaled by the same factors. It is a sibling of the
tank rather than a child, so it inherits nothing and has to be told; a full-size
ghost around a Tiny tank would misreport the one thing it exists to show.

**`N` reads oddly in XR, and correctly.** At `_tankWidth` x 0.001 the tank is a
plane, so the two eyes' viewpoints are far enough apart relative to its width that
each can catch a different face of the turret. Nothing to fix: it is what a tank
one and a half millimetres wide looks like in stereo, and the flag's own help text
promises exactly that -- "Very hard to hit from front but is normal size from
side." Anything that made it read better in a headset would be making it wider
than upstream, which is the flag.

What is *not* per-player: `getPauseRefusal`, which still asks a
`BZFLAG_TANK_RADIUS` cylinder. It is a bzo-only guard with no upstream
equivalent and is deliberately more generous than the box, so a flag can only
ever make it stricter than it needs to be.

## Phase 8 -- shot variants (implemented)

Five flags, and one resolver behind all five: a shot's velocity, rate, lifetime,
obstacle rule, radar visibility and firing sound come from the flag that fired it
rather than from `GAME_CONFIG`. `getShotEffects` in the flags pair is that
resolver -- pure, table-driven, and held against upstream's numbers by
`scripts/test-flags.mjs`.

| Flag | Velocity | Rate | Life | What else |
|---|---|---|---|---|
| `F` Rapid Fire | x1.5 | x2 | x1/2 | `_rFireAdVel` `_rFireAdRate` `_rFireAdLife` |
| `MG` Machine Gun | x1.5 | x10 | x1/10 | `_mGunAd*` |
| `L` Laser | x1000 | x0.5 | x0.1 | `_laserAd*`; a beam, not a projectile, and `SFX_LASER` rather than `SFX_FIRE` |
| `SB` Super Bullet | -- | -- | -- | passes through buildings, and so never bounces |
| `IB` Invisible Bullet | -- | -- | -- | off every radar but its owner's |

**Life is the rate, and that is why the slots need nothing.** `_rFireAdLife` and
`_mGunAdLife` are not numbers upstream: they are the strings `1.0 / _rFireAdRate`
and `1.0 / _mGunAdRate`. A shot slot frees when its shot dies, so a flag whose
shots live a tenth as long has its slots back ten times as fast, and the rate
falls out. bzfs's own server-side gate agrees -- `GetShotLifetime`
(`GameKeeper.cxx:401`) scales by `AdLife` and never looks at `AdRate` -- so
`getShotRejection` (`server.js:2256`) and `getAvailableShotSlot` (`:2356`) needed
no change at all. Only the client's interval between shots reads the rate, in
`getShotReloadTimeMs`, because that interval is what an honest client waits.

Laser is the flag that breaks the reciprocal: a tenth of the life against half
the rate, so its slot comes back long before its reload does. bzo spaces its
shots over one world reload interval instead of giving every slot a timer of its
own, so that interval is a floor under every bar in the shot-status display --
which is what makes the wait for a laser legible rather than a bar that reads
ready and a trigger that does nothing.

**Range is velocity times life**, so the table above is also the range column:
Rapid Fire reaches x0.75 as far ("faster but not as far") and Machine Gun x0.15
("very short range").

### `L` Laser -- a beam rather than a projectile

At `_laserAdVel` 1000 a shot covers 1666 units in one simulation step, further
than any bzo world is wide. There is nothing left to interpolate and nothing a
point-sampled sweep could catch, so the whole path is walked once, when the
trigger is pulled, by `traceShotBeam` -- which is exactly what upstream does in
`LaserStrategy`'s constructor, and why its laser draws along a segment list
rather than following a shell.

- The walk takes whichever of a building, the ground, a teleporter, the world
  edge and a tank it reaches first, one segment at a time, as `makeSegments`
  does. Upstream gets that ordering by narrowing one `t` across `getGround`,
  `getFirstBuilding` and `getFirstTeleporter` in turn; bzo asks the ground and
  the buildings over the whole reach, lets the nearer of the two truncate the
  segment, and asks the teleporters over what is left, which comes to the same
  thing -- a portal behind a wall is not one the beam ever reaches. It stops at
  upstream's own `maxSegment` 100. Range is velocity times life, 35000 units, so
  a straight beam is limited by the map and only a bouncing one runs out of it.
- **The obstacle question had to become a ray.** `findShotImpact` bisects from
  the far end of the segment, so it only ever finds an obstacle the far end is
  inside -- which holds for one 1.67-unit step of an ordinary shot and fails
  outright for a beam, which crossed the world in one segment and sailed through
  every wall on the way. `findShotSegmentImpact` joins the collision pair for it:
  every obstacle is asked for the interval over which the segment crosses its
  oriented bounding box, the intervals are walked nearest first, and the exact
  `shotInsideObstacle` test is applied inside each one that could still beat the
  best hit so far. The box is the exact solid for a box, a base and the world
  border; for a pyramid it is a hull, so the interval is sampled and bisected
  within. `traceShotStep` is left alone -- an ordinary shot's step is short, and
  the ray test allocates.
- A bounce off a pyramid can send the beam steeply upward, and with 35000 units
  to spend it can clear the world border and leave. Upstream does the same
  deliberately: `makeSegments` ignores a hit on the outer wall above the top of
  it (`ignoreHit`) rather than bouncing a shot back down.
- On a `+r` world it reflects: `makeSegments` promotes `Stop` to `Reflect` and a
  laser is a `Stop` shot, so the beam bends off buildings by their own normal and
  off the ground about straight up. Each new segment starts a hair off the
  surface, as a teleport exit does, because `traceShotStep` carries a shot that
  begins inside something straight through and a segment starting on the wall it
  just bounced off would never move.
- Hits are resolved at that same moment and the beam is cut short at the tank it
  reached. A tank that drives into a beam afterwards is not hit, because the shot
  passed before it got there -- the line left behind is the shot's remains, not
  the shot.
- The projectile is a clock from then on: it holds its slot, and at
  `_laserAdLife` its `shotEnd` goes out. A beam that struck something sparks
  where it struck; one that ran out of range or left the world fades.
- `shotBegin` carries the segments, each tagged with what ended it. That is the
  one thing the client cannot work out for itself, so it is also the one shot
  bzo does not predict locally: the shooter gets the report and the muzzle flash
  the instant it fires and the beam when the message lands. Each tagged bend
  plays `SFX_RICOCHET` with the rico effect, and all of them at once, because
  upstream's laser is already at the end of its path the first time it updates.
- The client draws each layer of upstream's untextured beam -- a bright core
  inside a faint glow (`LaserSceneNode.cxx:178`) -- as one instanced draw over
  every segment, so a hundred-bounce beam costs two draws and no per-segment
  geometry. bzo ships no laser texture, so the untextured variant is the one to
  draw. On the radar the beam is drawn as its own polyline.

### The hit test became a segment test

A Rapid Fire shell covers 2.5 units in a step against a tank 4 units across, so
sampling the shot's position once a step can step past the edge of a tank.
Upstream never can: `SegmentedShotStrategy::checkHit` tests the frame's whole
ray. `findShotPlayerHit` now does the same, over the step the shot just took,
and takes the nearest tank rather than the last one it looked at. Two things
follow, both of them upstream's behaviour rather than bzo's old behaviour:

- The step has already been cut short at whatever it ran into, and the sweep now
  runs before the obstacle test, so a tank standing in front of a wall is reached
  before the wall is.
- A step that bounced is still sampled at its end. The straight line from where
  such a step started to where it finished cuts the corner, and a tank the far
  side of the wall the shot bounced off did not just get hit.

`TANK_HIT_RADIUS` and `TANK_HIT_HEIGHT` are what that test reads, and they are
where phase 7's dimension flags landed.

**`SB` Super Bullet.** Traced against nothing rather than against the obstacle
list, which is upstream's `Through` -- including a teleporter frame, which is a
building. The ground still stops it, because the floor was never in the obstacle
list to begin with. It does not bounce even where the world bounces everything,
since `makeSegments` promotes `Stop` and never touches `Through`, and
`shotRicochets` says so. Upstream lets a super bullet leave the world and fly on
until its lifetime runs out; bzo ends it at the border, which is the same shot
either way.

**`IB` Invisible Bullet.** One clause in the radar sweep. Upstream draws your own
shots before it asks the question (`RadarRenderer.cxx:585`) and hides other
players' invisible ones (`:664`), so an `IB` carrier can still see what it fired.
`SE` Seer is the exception upstream makes and it arrives with phase 13.

## Phase 9 -- Ricochet (implemented)

The first shot that does not travel in a straight line, and like `JP` it hangs
off a world switch rather than off the phases before it, which is why it came
out of order.

**The switch.** `RicochetGameStyle`, upstream's `+r`, reaches bzo as a
`ricochet` key in `server.json`, as `+r` in a map's `options` block, and as a
checkbox on the Operator panel. Off by default, as upstream has it, and a map
may turn it on where nothing turns it back off -- the rule every bzfs switch
follows. It goes to the client as `ALL_SHOTS_RICOCHET` in the `init` config, and
again in `serverConfigUpdate` when an operator flips it. Upstream settles the
game style at startup and never revisits it; bzo lets an operator change it, so
the superflag pool is filtered per draw rather than at startup and an `R` flag
standing in a world that has just forbidden it is zapped.

**`R` Ricochet.** Unstable, good, and forbidden outright while the switch is on
(`CmdLineOptions.cxx:1957`), exactly as `JP` is under `-j`: a flag that grants
what every shot already does looks like it does something and does not. The help
panel says which of the two rules the world is playing by, because on such a
server the flag list would otherwise promise a flag nobody can find.

**The bounce.** `SegmentedShotStrategy::makeSegments(Reflect)` builds the whole
bounce path once, at the moment of firing, because each upstream client owns the
shots it fires. bzo integrates a shot a fixed step at a time on both sides, so
the reflection happens inside a step: `traceShotStep` in the `collision` pair
finds where the step meets solid geometry, takes the surface normal there, and
reflects with `reflectShotDirection`, which is `ShotStrategy::reflect` including
its refraction branch for a normal that faces the wrong way. The shot keeps its
lifetime, so a bounce costs range and nothing else.

Both sides run that same function. The server is authoritative as ever and the
client draws its own copy, because a bounce that waited for the server would
arrive a round trip after the shot had already gone through the wall. Nothing
new goes over the wire for it: `shotBegin` gained `flag` and `ricochet`, which
is what FiringInfo carries upstream, and the client predicts both for its own
shot so the first bounce is not late on the one screen it has to look right on.

The surfaces it bounces off:

- **Buildings**, by `Obstacle::get3DNormal`. Upstream reads the face off the
  exact ray/surface intersection; bzo stops the shot at the last point that was
  still outside, so the flat top and bottom of a box are named by the same
  vertical tests that let that point stay outside, and everything else falls
  through to the cross-section's horizontal normal.
- **Pyramids**, whose sloped faces are what put a vertical component into a shot
  that was fired flat -- which is what makes the ground and the tops of boxes
  reachable at all.
- **The world border**, but only as high as the wall you can see. Upstream's
  border is one `WallObstacle` a side doing two jobs at once: `inCylinder` and
  `inBox` ignore height entirely, so it is an infinite half-space that stops a
  tank at any altitude, while `makeSegments` ignores a bouncing shot's hit on it
  above `getHeight()` (`ignoreHit`) and lets the shot fly over rather than back
  into the arena. bzo says that with two colliders a side rather than a special
  case in the shot path, each doing one of the two jobs and standing aside from
  the other with one of upstream's own per-obstacle flags. The barrier, a
  thousand units high -- taller than any map bzo has to hold -- is the tank
  collider and is `shootThrough`: that is upstream's wall as a tank meets it, a
  height-ignoring half-space with no roof. The visible wall, `WORLD_WALL_HEIGHT`
  tall, is the shot collider and is `driveThrough`: it exists to give a shot a
  height to stop bouncing at. `WORLD_WALL_HEIGHT` is upstream's
  `3.0 * _tankHeight`, and the renderer draws the wall to it, so what bounces a
  shot is exactly what a player can see. The obstacle test runs before the
  out-of-bounds test so the border is met as geometry rather than as a limit.

  The flag on the visible wall is what makes the split correct rather than what
  papers over it: both colliders share an inner edge, so the barrier holds tanks
  before they reach the wall, and the wall's roof -- which upstream's
  `WallObstacle` does not have at all, `getHitNormal` only ever answering with
  the plane -- is not a surface any collision code has to reason about.
- **The ground**, which upstream treats as a surface of its own
  (`ShotStrategy::getGround`) rather than as an obstacle, and so does
  `traceShotStep`.

**Per-obstacle ricochet is upstream's third source of a bounce**, after the
world switch and the flag. `Obstacle::canRicochet` -- `ricochet` in a `.bzw` --
makes one obstacle reflect even an ordinary shot: `makeSegments` stops a `Stop`
shot only when `!building->canRicochet()`, and otherwise falls through into the
same reflection an `R` carrier gets. `traceShotStep` asks the obstacle the same
question, so the field is honoured the moment a map can set it. Upstream builds
its own border walls with it off (`addWall`, `bzfs.cxx:1057`), which is why only
a shot that ricochets of its own accord bounces off the border.

**`drivethrough` and `shootthrough` are the pair it belongs with.** Upstream's
`.bzw` takes both per obstacle -- `drivethrough` makes an object passable to
tanks, `shootthrough` makes it transparent to shots -- and reads them as
`Obstacle::isDriveThrough` and `isShootThrough`, the latter tested by
`getFirstBuilding` before it looks at any geometry. bzo honours both fields
already: `findShotObstacle` and `findShotSegmentImpact` skip a `shootThrough`
obstacle, and both copies of `checkCollision` skip a `driveThrough` one. Nothing
but the world border's own barrier sets either yet; a map parser that learns the
two keywords has nowhere else to put them and nothing else to change.

**Teleporter frames still stop a bouncing shot**, and are the one surface that
does not reflect. Frames are decided by the teleporter trace, which the client
does not run for shots at all -- it has no frame hit to bounce off -- so
bouncing them on the server alone would put the two copies of the shot on
different paths. Doing it properly means the frame test joining the shared pair.

**A ricocheted shot can kill the tank that fired it**, which is the flag's own
help text. `LocalPlayer::checkHit` tests a player's own shots like anyone
else's; before it bounces a shot cannot reach its shooter, because it leaves the
muzzle further out than the hit radius and outruns the tank, and bzo says that
outright with a bounce count rather than leaning on the hit test to agree.
Killing yourself is a loss and nothing else, as self-destruct is.

Two of phase 8's flags meet this rule. `SB` Super Bullet ignores buildings and so
never reflects off one, whatever the world says. `L` Laser does reflect, and its
beam is bent segment by segment when the walk that builds it meets a wall -- see
"`L` Laser -- a beam rather than a projectile". Upstream declares a `_lRAdRate`
0.5 for the two together and no longer reads it anywhere, so there is nothing to
implement: a tank carries one flag, and a laser on a `+r` world is the only way
the two meet.

## Phase 10 -- Shock Wave (implemented)

`SW` Shock Wave. **A shot with no path.** It never leaves the tank that fired it;
what travels is its radius. A sphere starts `_shockInRadius` across and grows to
`_shockOutRadius` 60 over `_shockAdLife` 0.2 of a shot's life, killing every tank
it swells past, and the strategy expires the shot the moment it is full size.
That is `ShockWaveStrategy` in four lines; the rest of this section is what each
of them costs a server that decides hits for everybody.

**`_shockInRadius` is declared as `_tankLength`, so it is upstream's 6.0 and not
bzo's smaller tank.** The wave sweeps a distance through the world rather than a
multiple of the vehicle, which is the reasoning `BZFLAG_TANK_RADIUS` and the
sound reference distance already carry: the figure transfers unchanged.

**Nothing stops it.** `isStoppedByHit()` returns false, so a wave resolves every
tank inside it rather than the nearest one. That is the first shot in bzo that is
more than one kill, and it is why `applyShotPlayerHit` split in two:
`applyShotVictim` is what happens to a tank, and what happens to the shot is the
caller's -- an ordinary shell is spent by the tank it hits, a wave by nobody.

**`checkHit` asks nothing about the geometry.** No obstacle trace, no height
gate, no tank radius, no narrow box: just a sphere from where the wave was fired
to where the tank is, measured to the tank's own position, so a tank on a roof is
as far away as the roof is high. It is the only hit test in bzo that reads no
collider at all, and that is upstream's own note on it -- "a shock wave can kill
anything inside the radius, be it behind or in a building or even zoned" -- and
what lets the help text promise tanks "on/in buildings".

**A shield holds against a wave for the whole wave.** Upstream ends the shot
locally once a shield has saved somebody, precisely because a wave is not stopped
by a hit and would otherwise find the same tank again on the next frame with the
shield already gone -- "making the shield useless" is its own comment
(`playing.cxx:4032`). bzo carries the same rule as a set of resolved players on
the projectile, which covers the other way a tank could meet one wave twice: a
kill and a respawn inside 0.7s.

**Your own wave cannot kill you**, and unlike a ricochet there is no bounce that
could ever earn it. Teammates are another matter. bzo has no team-kill switch and
a shot has always killed through a team, so a wave does too -- which is what the
flag's own help text is warning about, and the whole of the warning upstream
gives it.

**The reload is the world's own.** Each of the four segmented strategies scales
it -- `setReloadTime(reload / adRate)` -- and `ShockWaveStrategy` is the one that
does not. So `SW`'s `rateFactor` is 1 and only its `lifeFactor` moves: a wave is
gone in 0.7s and the next one still comes round on the full 3.5.

That is also where `SW` walks into a gap `L` Laser was already standing in. bzo's
server holds a shot slot for the shot's *life* and the client gates firing on the
*reload*, which agree only because `F` and `MG` declare their life as the
reciprocal of their rate. Laser and Shock Wave do not, so an honest client fires
both at upstream's cadence while the server's slot check would let a modified one
fire far faster. See "a variant's slot frees on its life, not its reload" in
AGENTS.md -- it is a loose anti-cheat gate rather than a wrong game, and it is
being fixed on its own rather than inside this phase.

**bzo draws upstream's low-quality wave, because its default one cannot be
drawn.** At quality 2 and above a shock wave inverts the colour of everything
inside the sphere with `glLogicOp(GL_INVERT)` and lays the team-coloured surface
over the inversion (`SphereSceneNode.cxx:386`). WebGL has no logic op to invert
with. What is left is the fallback: a plain translucent sphere fading 0.75 to
0.25 as it swells -- one of upstream's own variants rather than a third one bzo
invented, which is the rule about shipping one variant and no setting. It is
drawn double-sided, because the wave grows past the camera and the inside of the
ball is most of what you ever see of your own, and one shared sphere geometry is
scaled per frame, so a wave costs one draw whatever size it is.

**The shooter predicts it.** A wave is a sphere growing from a known point at a
known rate, so unlike a beam there is nothing to wait a round trip for: it goes
out through `createLocalProjectile` like an ordinary shell and re-anchors when
`shotBegin` lands. It fades at full size rather than ending on anything, so it
takes neither the impact effect nor `SFX_SHOT_BOOM`; `SFX_SHOCK` when it is fired
is the only sound it makes, and there is no muzzle flash because there is no
muzzle -- the shot origin is "under tank" (`LocalPlayer.cxx:1230`). On the radar
it is a circle of the current radius, as `radarRender` draws it.

## Phase 11 -- Thief (implemented)

`TH` Thief. **The only shot in the game whose outcome is neither a death nor
nothing.** A thief's beam takes the flag the tank it reaches is carrying and
leaves the tank alive, and everything else about the flag is the price of being
close enough to fire it: a tank half the usual size (`_thiefTinyFactor` 0.5) at
two thirds again the usual speed (`_thiefVelAd` 1.67, which beats `V` High
Speed's 1.5), firing twelve times a reload (`_thiefAdRate` 12) a beam that
reaches four tenths of a shell's range.

**It is a beam, not a shell.** `ThiefStrategy` is `LaserStrategy` with different
numbers: the same `makeSegments(Stop)` in the constructor, the same node per
segment added to the scene all at once, and an `update` that spends the clock and
never moves anything. So it goes in `getShotEffects` as `beam: true` beside `L`
and takes the path `traceShotBeam` already walks. The range falls out of the two
numbers -- `_thiefAdShotVel` 8 against `_thiefAdLife` 0.05 is 0.4 -- rather than
being a range of its own.

The beam is cyan for everybody (`setColor(0, 1, 1)`), where a laser wears its
shooter's colour. That is the one shot in the game that does not say who fired
it, and it is right: what a thief beam means is "that was a theft", not "that was
so-and-so shooting at you". `beamColor` on the shot effects is how it reaches the
client, and it is null for every other flag.

**Three of upstream's hit rules stop being about damage.** `LocalPlayer::checkHit`
excepts Thief by name twice and `ThiefStrategy` once, and all three are in
`findShotPlayerHit`:

- **You can never rob yourself.** Thief sits beside Shock Wave in the
  `source == this` test (`LocalPlayer.cxx:1612`), and unlike a ricochet there is
  no bounce that could ever earn it.
- **A team mate's flag is fair game.** The no-team-kills guard excepts Thief in
  its own words -- "Thief can still take a teammate's flag" -- because nothing
  about a theft is a kill, and the team mate carrying what you want is exactly
  who you rob.
- **A tank is not what stops the beam.** `ThiefStrategy::isStoppedByHit` returns
  false. bzo reads that as "a tank with nothing to take does not block it" and
  stops the beam at the first tank it can actually rob. That is the one place
  this phase does not simply follow upstream: upstream lets every client along
  the beam report its own theft, the thief keeps only the last one to arrive, and
  bzfs zaps the rest -- so robbing one tank per shot destroys nothing anybody
  wanted and loses nothing anybody would notice.

**Shield does not save you from a thief.** Upstream tests `killerFlag ==
Flags::Thief` *before* it calls `gotBlowedUp` (`playing.cxx:4174`), so a shielded
tank simply loses the Shield to the thief. `applyShotVictim` asks the same
question in the same order.

**The transfer is one message and no drop.** Upstream has the victim's client
send `MsgTransferFlag` and bzfs check that the tank being transferred *to* is
really carrying Thief; bzo needs neither half, because the shot already carries
the flag it was fired with and the server is what decided it hit. `stealFlag`
moves the flag between owners and broadcasts `transferFlag`, which is the only
message in the game that moves a flag without a grab or a drop -- the flag never
touches the ground, so nothing else would repaint it.

**A theft spends the Thief flag.** Upstream zaps whatever the thief is holding
before handing the stolen flag over, and what the thief is holding is Thief
(`bzfs.cxx:5167`). `FlagInfo::addFlag` agrees from the other end: it names Thief
beside the sticky flags in the test that gives a flag a single grab, so `TH` is
the only good flag in the world with one grab in it. That is now
`getFlagGrabCount` in the flags pair.

**And it costs the thief a reload.** `_thiefDropTime` is charged when the Thief
flag *leaves* the tank -- after a successful steal, the moment the theft spends
it -- and upstream's own comment on the line is "make sure the player must reload
after theft" (`playing.cxx:3823`). It is declared as `_reloadTime * 0.5`, and
upstream's `_reloadTime` is a shot's whole life rather than the interval one slot
comes back on, so `getThiefDropReloadSeconds` takes the world's shot life and not
bzo's `SHOT_RELOAD_TIME`: at the defaults a theft costs several ordinary reloads.
Putting the flag down by hand costs the same, because upstream cannot tell the
two apart and neither reading is unfair.

**One shot can slip out under the penalty, and that is upstream's race too.** The
theft is decided on the server and the penalty is charged when the drop reaches
the thief, so a client whose ordinary reload -- a twelfth of the world's, all of
0.29s -- expires inside that round trip fires once more before the penalty lands.
Measured on a headless probe at 12fps it was one shot 374ms after the steal, and
the 1.75s then held from there. Nothing on this side can close it: only the
server knows a theft happened, and bzo's server gates firing on shot slots rather
than on a reload timer (see "The server does not enforce a reload timer" in
AGENTS.md). Upstream is worse off, because its theft takes an extra hop -- the
victim's client sends `MsgTransferFlag` before bzfs zaps anything.

The victim gets a HUD line of their own, which upstream has no equivalent of. bzo
says "Dropped X flag" every other time a flag leaves your tank, and a theft is the
one way of losing one that sends the victim no drop at all -- so without it the
flag would simply be gone with nothing said. Everything else follows upstream's
`handleFlagTransferred`: the chat line reads "stole so-and-so's flag", and a
stolen *team* flag rings the same two alerts a grabbed one does.

In XR it needs nothing new. A thief aims and fires like any other tank, the beam
is a polyline the renderer already draws, and losing a flag is a HUD line that
already has a place to sit.

## Phase 12 -- Guided Missile (implemented)

`GM` Guided Missile. **The one shot whose path cannot be extrapolated from where
it started.** Everything else bzo fires is a direction and a speed decided at the
muzzle; a missile's heading is a new answer every simulation step, turned toward
whichever tank its shooter has locked at `_gmTurnAngle` 0.628319 radians a
second. `GuidedMissileStrategy::update` is the whole of it, and the rest of this
section is what that costs a game where the server owns hits and the client draws.

Its three other numbers are small: life `_gmAdLife` 0.95, no change to speed and
none to the reload -- the strategy scales `lifetime` and never calls
`setReloadTime` -- and `_gmActivationTime` 0.5, which is not about steering at
all. See "The half second nothing is hit".

**Azimuth and elevation turn separately**, each toward its own target and each at
the full rate (`GuidedMissleStrategy.cxx:186` and `:195`), so a missile that has
to come around *and* climb does both at once. `steerGuidedShot` in the flags pair
is that arithmetic, in bzo's angles: azimuth 0 faces -Z and grows to the left,
which is `playerRotation`'s own convention, and the missile's direction vector is
decomposed and recomposed each step rather than kept as a pair of angles -- so a
missile that crosses a teleporter keeps the heading the teleporter gave it with
nothing to resynchronise.

A missile never ricochets, on any world. The ricochet switch is read by
`makeSegments`, and `GuidedMissileStrategy::checkBuildings` has no reflect branch
at all: the missile explodes on the first building it reaches. `shotRicochets`
refuses it for the same reason it refuses `SB`.

### The lock is the server's

Upstream runs `setTarget()` on the shooter's own client. bzo runs it on the
server, and this is the one place the phase departs from upstream on purpose: a
lock steers a real missile, so a modified client claiming one it never earned
would be aiming somebody else's weapon. Nothing is lost by moving it -- upstream's
scan reads `myTank->getAngle()`, the tank's own heading rather than the camera's,
which the server already knows exactly.

So the `identify` binding sends one message and the server answers it:

- **Two cones, one press.** The tighter `_lockOnAngle` 0.15 -- about 8.6 degrees
  -- is a lock, and only for a player who has a missile to steer: the flag in
  hand, or one still in the air after the flag was dropped, which is upstream's
  `tankHasShotType`. The wider `_targetingAngle` 0.3 only *names* the tank, which
  is what identify does for a player carrying anything else. `pickTargetInSights`
  in the flags pair is the scan, with the cone as an argument, because the
  observer's roaming identify asks the same question at the wider angle.
- Upstream walks both cones in one loop and lets a nearer tank outside the lock
  cone shut out a further one inside it, purely because of the order its roster
  happens to be in. bzo asks the two questions separately, so the answer does not
  depend on that.
- **A lock is public.** The server broadcasts `lockTarget`, because every client
  steers every missile and so every client has to know what each one is steering
  at. `shotBegin` carries the target too, which seeds a client that has not seen
  a `lockTarget` for that shooter yet.
- **A target that stops being lockable stops being followed, with no packet.**
  `canLockOnto` -- alive, unpaused, not an observer, not carrying `ST` -- is asked
  wherever the lock is *read* rather than only where it is set, and both ends ask
  it, so a target that dies or ducks under Stealth is dropped by the missile on
  the same step on every screen. Upstream refuses Stealth outright here, with no
  `SE` exemption: where a missile may fly is not a matter of what somebody can
  see. The look at the wider cone does exempt a seer (`playing.cxx:4436`).
- A dead shooter has nothing locked (`playing.cxx:3827`), and a lock onto a
  player who has left is cleared rather than left to expire.
- **A lock lapses with the missile.** When `GM` leaves the hand and the last
  missile leaves the air there is nothing for the lock to steer, so it goes --
  and so does the bracket. Upstream never clears a target on a flag change at
  all: nothing in `LocalPlayer` does it, so its marker outlives the flag that
  earned it. This is a deliberate departure: a bracket over a tank you have no
  way to shoot at is saying something that is no longer true. Dropping `GM` while
  a missile is still flying keeps the lock, because retargeting that missile is
  the thing the flag's own help text promises.

### Both ends steer, and only the server hits

The client cannot wait for the server to say where a missile is -- there is no
per-shot update packet in bzo, as there is none upstream -- so it integrates the
same `steerGuidedShot` against its own copy of the target's position, which is
exactly what upstream's remote clients do. Where a client's idea of that tank
lags the server's, the missile is drawn a little wide of where it really is, and
the hit is still the server's to decide. That is the same bargain every other
shot in bzo already makes; a missile only makes it visible, because its whole
path bends rather than its endpoint moving.

### The half second nothing is hit

`_gmActivationTime` gates **hits**, not steering (`GuidedMissleStrategy.cxx:318`,
"GM is not active until activation time passes (for any tank)"). The missile
flies and turns from the muzzle; nothing it touches in its first half second is
hit. The tank the rule is really for is the one that fired it -- a missile locked
onto a target two lengths away comes round through its own shooter -- so it is
`activationTime` on the shot effects rather than a rule about ownership, and
`findShotPlayerHit` returns nothing at all while it is running.

### What the player sees and hears

- **`missile.wav` when it is fired**, which is upstream switching the report on
  the flag (`playing.cxx:2957`) rather than playing `SFX_FIRE` for everything.
  Laser was the first flag bzo had that did this; this is the second.
- **`lock.wav` for the tank being shot at**, with a "locked on me" message, at
  most every 0.75s. Upstream plays it when a `MsgGMUpdate` naming you arrives
  (`playing.cxx:3537`), which is a missile *already in the air* -- so the warning
  is on the shot and on a retarget, never on somebody's finger on the lock
  button. Taking the lock warns nobody.
- **The bolt is upstream's default-quality one**: a billboard like every other
  shot, textured from `missile.png` -- a 4x4 sheet stepped one cell a frame
  (`BoltSceneNode.cxx:864`) -- and trailing a `SmokeGMPuffEffect` puff every
  `gmPuffTime` 1/8s. The modelled missile with fins is behind
  `useQuality() >= 3`, so by "Fewer options than BZFlag" bzo draws the variant
  upstream draws by default. The colour is bzo's own: upstream paints every
  missile the same orange, and bzo colours every shot by who fired it, which is
  the shot you most want the owner of.
- **The tail follows the heading.** Every other shot's trail is laid out once
  along the direction it was fired; a missile's is re-laid each step, which is six
  sprite positions and the only thing about the shot that moves.

### The lock-on marker, and the one thing XR changed

Upstream draws the lock-on bracket in screen space: it projects the target,
clamps the result to the window edge so a target behind you still has a marker on
the rim, and draws two brackets and the callsign (`HUDRenderer.cxx:1314`).

bzo draws the bracket **in the world**, as a sprite standing at the locked tank,
in the colour that tank is drawn in. A screen-space overlay means nothing in a
headset, where there is no window to pin it to, and a sprite already billboards
in both. The proportions are upstream's, and depth testing is off because a lock
is a HUD element -- a target that ducks behind a wall is exactly when you want to
know where it went.

What that costs is upstream's edge clamping, so **the heading tape carries a
marker for the locked tank** instead. That is where a bearing belongs in bzo
anyway -- it is already how a team flag is found -- and it is the answer for a
target off the side of the screen in the window and in VR alike.

## Phase 13 -- per-viewer visibility (implemented)

`ST` Stealth, `CL` Cloaking, `MQ` Masquerade and `SE` Seer. Four flags that only
ever disagree with each other, so they are read as a set: `ST` hides a tank from
the radar, `CL` hides it from the window, `MQ` makes it wear the viewer's own
colours, and `SE` defeats all three.

**Which end asks.** `ST`, `CL` and `MQ` are read off the tank being *looked at*;
`SE` is read off the tank doing the looking. That split is why upstream threads
`seerView` down into every draw call (`playing.cxx:6139`) rather than testing a
flag where the tank is drawn, and why `getVisibleTankAlpha` in the flags pair
takes both flags rather than one.

| Flag | Hides from | Defeated by |
|---|---|---|
| `ST` Stealth | the radar blip, and lock-on | `SE` |
| `CL` Cloaking | the window, and lock-on | `SE` |
| `MQ` Masquerade | the team colour | `SE`, an observer, or `CB` |

**`ST` and `CL` are mirror images and carrying one does not buy the other.** A
stealthed tank is solid in the window; a cloaked tank is still on the radar
(`RadarRenderer.cxx:628` filters only Stealth). `scripts/test-flags.mjs` asserts
both directions, because it is the pair most likely to be conflated later.

**`CL` fades rather than blinks.** `Player::updateFlagEffect` sets
`alphaTarget = 0` (`Player.cxx:769`) and `updateTranslucency` eases it over the
same `_flagEffectTime` the dimensions use, so bzo eases it in the same loop and
from the same rate rule. Only a *fully* faded tank disappears, which is upstream's
`cloaked && !seerView` (`Player.cxx:899`); part-way through, the tank is part-way
transparent and can be seen if you are looking. A hidden tank is hidden outright
rather than drawn at alpha 0, so it costs no draws and casts no shadow -- and its
name label goes with it, since a floating callsign over an invisible tank would
give away the one thing the flag is for.

**The ghost fades with the tank.** The server-position ghost is a clone with its
own materials, so it takes the same alpha scaled by its own `GHOST_ALPHA_SCALE`,
and a fully cloaked tank's ghost is hidden -- via the flag that
`updateDebugGeometryVisibility` already reads, so the cloak and the debug toggle
do not each set visibility once a frame and disagree. A ghost left behind a
vanished tank would hand a debug build the exact position the flag hides.

**`MQ` folds into the one place a remote tank's colour is decided**, and the order
there is upstream's (`playing.cxx:6171`): colourblindness first and it wins
outright, because upstream computes `effectiveTeam = RogueTeam` and only consults
Masquerade `if (!colorblind)` -- a colourblind viewer cannot be fooled by a
disguise, as there is nothing left to fool. Then Masquerade, defeated by `SE` and
never applied for an observer, who has no colour to impersonate with. Then the
tank's own colour.

**What colour a masquerading tank wears is a bzo question upstream does not have.**
Upstream writes it as `effectiveTeam = myTank->getTeam()`, which is the viewer's
*own* colour there, because upstream's team mates all share one. bzo shades team
mates apart inside a band around the team colour, which splits that into two
readings, and bzo takes **the viewer's own colour**:

- it is a colour that certainly exists on the viewer's team, where the team's
  *base* colour is one no real team mate wears -- a masquerading tank painted in
  the base shade would be the only tank with it, which is a tell a regular would
  learn in a day;
- it needs no roster lookup and no choice of which team mate to copy, so it
  cannot collide with a second masquerading tank or change frame to frame;
- and it is the colour a viewer most associates with "one of us".

The cost is the mirror image: your own colour is unique in bzo, so a tank wearing
it exactly is impossible otherwise. That is the subtler of the two tells, and the
one worth paying -- a player rarely has a precise sense of their own tank's
shade, being inside it.

It also means **`MQ` works in bzo without teams**, where upstream's would not.
Upstream voids Masquerade on a teamless world (`CmdLineOptions.cxx:1716`) because
`myTank->getTeam()` is then rogue for everyone and the disguise says nothing; in
bzo the viewer's own colour is theirs alone whether or not there are teams, so
the flag still hides who you are. The same argument applies to `CB`, which hides
bzo's individual colours in free-for-all where upstream would have nothing to
confuse. So bzo deliberately does **not** take the `!hasTeam` half of that
forbid rule for `CB` and `MQ`. `G` Genocide, the third flag in it, genuinely
needs teams to mean anything and should be voided when it lands in phase 6.

Because a tank is *built* from its colour rather than tinted, a change of
effective colour rebuilds it -- and three flags can cause that with no shared
trigger: `CB` and `SE` are mine to pick up, `MQ` is theirs, and a flag change
arrives on a flag message rather than a player update. So rather than hooking
three events, `refreshTankDisguises` compares each tank's effective colour
against the one it was built from once a frame. The compare is two property reads
and a number test; only an actual change costs a rebuild.

**`SE` reaches further than the other three**, and two of its reaches are live
interactions rather than notes for later:

- **`IB` Invisible Bullet** goes back on the radar for a seer, which is
  `iSeeAll` in `RadarRenderer.cxx:665`. `IB` landed in phase 8, so a seer is now
  the counter to an invisible shooter.
- **`ID` Identify** can lock onto a stealthed or cloaked tank only with `SE`
  (`playing.cxx:4242`), and `B` Blindness refuses every target outright
  (`:4239`). Both halves matter: hiding from the eye and the radar would mean
  little if the flag that names a tank could still find one.

**One rule is the server's, and only one.** "Laser can't hit a cloaked tank"
(`LocalPlayer.cxx:1630`). That is not a matter of what somebody can see -- a
cloaked tank is genuinely immune to a beam -- so with bzo's server owning hits it
has to be the server's answer rather than each client's. It is also what makes
`CL` a good flag rather than a cosmetic one. Everything else in this phase is
per-viewer and stays on the client, as it does upstream.

The scoreboard is untouched by all four, as it is by `CB`: it says who is playing
and on which team, and none of these flags is about that.

## Phase 14 -- movement through and under geometry

Three flags, each of them a change to collision itself, which is why they are
last. `WG` Wings was the fourth and is done -- it needed air steering rather than a
change to collision, so it came out of this group early. `motion.mjs` and `collision.mjs` are the shared pairs involved, and both
have tests that need to keep passing.

`OO` Oscillation Overthruster is **implemented**; see below. What is left:

- **`BU` Burrow** -- sits at `_burrowDepth` -1.32, immune to normal shots,
  killable by `SR` Steamroller from anyone including teammates, speed x`_burrowSpeedAd` 0.80
  and turn x`_burrowAngularAd` 0.55. Needs negative ground, which bzo's
  `groundLimit` assumes is zero.
- **`PZ` Phantom Zone** -- passing through a teleporter toggles Zoned; a Zoned
  tank drives through buildings, fires Zoned shots, and can only be hit by
  `SB` Super Bullet, `SW` Shock Wave or another Zoned shot. `OO` has built the
  pass-through; what is left is a hook on bzo's teleporter path and a shot kind
  with its own hit rules.

### `OO` Oscillation Overthruster (implemented)

**Phasing is a rule about expulsion, not about collision.** Upstream does not
stop testing obstacles for a tank carrying `OO`: `getHitBuilding`
(`LocalPlayer.cxx:914`) finds the obstacle exactly as it would for anyone and
then decides whether the tank is *expelled* from it, and the motion loop breaks
out on an obstacle it is not expelled from. `phasedObstacleExpels` in the
collision pair is that decision, and the three things that still expel are
upstream's: a wall, which is bzo's world border; a teleporter, so `OO` crosses
one rather than driving through its frame; and a reverse at ground level, which
is what stops a tank *outside* a building backing into one.

Because nothing else is exempt, **a phased tank sinks through a roof rather than
resting on it** -- a surface it is not expelled from holds nothing up. That is
upstream's behaviour and not a bug to fix: `checkCollision` and
`findSupportSurface` both ask the same question and have to give the same answer,
or the tank falls through a roof and is snapped straight back onto it.

**Inside a building is a state, and three controls read it.**
`collectInsideBuildings` (`LocalPlayer.cxx:966`) is upstream's own list of every
obstacle the tank box overlaps where the frame left it, and bzo's
`findInsideBuildings` is the same sweep -- all of them, not the first, because a
tank crossing a corner is inside two buildings. From it:

- **No reverse** (`setDesiredSpeed`, `:1098`). The clamp lives in
  `applyMotionInput` in the flags pair, ahead of every flag clamp, and reads the
  state rather than the flag -- which is upstream's own wording, and means a tank
  wedged in a building for any other reason is refused the same reverse.
- **No shot** (`fireShot`'s "make sure we're allowed to shoot", `:1220`). Refused
  on the client *and* by `getShotRejection`: the cover a building gives a shooter
  is the largest prize the flag has to offer a modified client. Non-fatal there,
  because the shot and the move that carried the tank inside cross on the wire.
- **No drop** (`cmdDrop`, `clientCommands.cxx:355`). A flag dropped inside a
  building would land inside it, where nothing could reach it again.

Pausing inside a building was already refused, for the same reason and by the
same test: `getPauseRefusal` asks the collider without phasing, so it answers for
`OO` without knowing about it.

**The eighth dimension is not decoration.** An obstacle's faces are back-face
culled, so from inside one the walls are not there at all and a phased tank is
driving through a building it cannot see. Upstream answers with two nodes per
obstacle and bzo draws both: `EighthDimSceneNode`'s loose triangles in random
colours at random alpha (60 for a box or base, 20 for a pyramid, sized
`size[0] / cbrt(count)`), and `EighthDBoxSceneNode`/`EighthDPyrSceneNode`'s white
wireframe of the obstacle around them. `SceneBuilder.cxx:46` has a cheaper
variant behind `SHELL_INSIDE_NODES` that reuses the obstacle's own wall nodes; it
is off by default, so the triangle cloud is the one to ship.

**One mesh, not sixty.** The colour and alpha vary per triangle and still cost a
single draw, because they ride on a four-component vertex-colour attribute --
which is what upstream's one `glBegin(GL_TRIANGLES)` loop with a `myColor4fv` per
triangle amounts to. A building you are inside is two draws, the cloud and the
wireframe, which is upstream's two render nodes exactly. The node is attached to
the scene on entry and detached on exit rather than hidden, since
`updateMatrixWorld` walks the graph whatever is visible, and its matrix is
composed once because the obstacle it belongs to never moves.

Two differences from upstream, both deliberate: the nodes are built the first time a tank is inside that obstacle
rather than with the world, because a map has hundreds of obstacles and no frame
draws these until somebody carries the flag; and the pyramid's envelope comes
from bzo's own `getPyramidSurfaceLocalHeight` rather than upstream's
`slope * hypot(x, y)`, which is a cone rather than a pyramid and knows nothing of
an inverted one.

There is nothing here that needs an XR answer: the shapes are world geometry, and
a headset sees them as a window does.

## Rules for an agent picking this up

- One phase per commit, and one changelog entry per phase, both referencing
  issue #6.
- `npm run check` before you are done. `check:shared-pairs` will fail if
  `public/flags.mjs` and `server/flags.cjs` drift, and every constant and every
  pure function added in these phases belongs in that pair and in
  `scripts/test-flags.mjs`.
- Take the numbers from `src/common/global.cxx`, not from this document. If they
  disagree, upstream is right and this document is stale.
- A flag's effect is server-authoritative wherever a modified client could gain
  by lying, and client-side wherever it only changes what its own player sees.
  Blindness is client-side; Velocity is not.
- Ship no setting for a flag's presentation. Where upstream offers variants,
  implement the default one.
- **Do not add a flag whose effect has no clear implementation in XR.** bzo
  ships one client for desktop, mobile and the headset, so a flag that quietly
  does nothing in VR is worse than an absent one: it looks like it works and the
  player cannot tell. `WA` Wide Angle is the type case -- the headset owns the
  projection, so changing the field of view has nothing to do there. Flags like
  that are held back and given their own XR answer rather than shipped with a
  desktop-only effect, and this is what decides the order within a phase as much
  as the machinery does.
- **Add the flag's row to `FLAG_TYPES` last.** The row is what puts the flag in
  `superFlags.allowed`'s default and in the help panel, so a row landing ahead
  of its behaviour is a flag in the world that lies about what it does and a
  help entry that promises it. Cross the flag off the table above in the same
  commit -- that table is the only list of what is missing.
- The help panel documents each flag from its row, with upstream's own help
  string. `buildFlagHelp` generates it, so there is nothing to write in
  `index.html`; get the `help` field right and the page follows.
