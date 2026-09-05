# Flags

Design and staging plan for BZFlag-style flags in bzo. All flag work is tracked
as **GitHub issue #6**; reference it from every flag commit and changelog entry.
Upstream references are paths under `$HOME/bzflag/`.

Phases 1 (the Useless superflag, animation, and the drop key), 2 (team flags and
capture), 3 (Identify) and 9 (Ricochet) are **implemented**, as is the jumping
switch and all three flags that hang off it -- `JP`, `WG` and `NJ` -- see
"Jumping, and the flags that carry it". All three of phase 4's ways out of a bad
flag -- the **shake timeout**, **shake wins** and **antidote flags** -- are in;
its four client-side bad flags are not, and neither is phase 6 beyond `SH`
Shield. Phases 5, 7, 8 and 10 onwards are not.

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
superflags. bzo has the four team flags, Useless, Identify, Jumping, Wings,
Ricochet, No Jumping and Shield, so **35 superflags remain** -- 22 good and
13 bad. The table below is the whole list,
grouped by the machinery each group needs rather than by name, because the
machinery is what decides the order. `src/common/Flag.cxx` is the authority for
every name, abbreviation, endurance, quality and help string;
`src/common/global.cxx` for every constant named here.

| Phase | Flags | What it needs that bzo does not have |
|---|---|---|
| 4 | `B` `JM` `CB` `WA` | shake wins, antidote flags |
| 5 | `V` `QT` `A` `M` `RC` `FO` `RO` `LT` `RT` `BY` `TR` | the effect resolver, in the shared pair |
| 6 | `SR` `G` | damage rules, and a shot that remembers its flag |
| 7 | `T` `N` `O` | per-player tank dimensions |
| 8 | `F` `MG` `L` `IB` `SB` | per-shot rate, life, velocity and obstacle rules |
| 10 | `SW` | a shot with no path -- an expanding sphere |
| 11 | `TH` | flag stealing |
| 12 | `GM` | a steerable shot, and a lock-on target |
| 13 | `ST` `CL` `MQ` `SE` | per-viewer visibility |
| 14 | `OO` `BU` `PZ` | movement through and under geometry |

Phases 4 to 8 are each a small hook on machinery the phase before it built.
Phases 10 to 14 are each their own feature and can be taken in any order once 8
is done. Phase 9 was taken out of order for the same reason `JP`, `NJ` and `WG`
were: it hangs off a world switch rather than off the phases before it.

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
  it out (`normalizeSuperFlagConfig`, `server.js:2180`);
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

Upstream's `-f` and `+f` (`CmdLineOptions.cxx:751` and `:757`) set per-type
counts and forbid types. `superFlags.allowed` covers the common case; per-type
counts are worth adding only when there are enough flags for the mix to matter.

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

## Phase 4 -- the four bad flags that only change your own view

The machinery this phase was built around is done -- sticky endurance, and all
three of upstream's ways out; see "Getting rid of a bad flag". What is left is
the four bad flags that need nothing beyond it, because they change only what
the carrier sees:

- **`B` Blindness** -- no out-the-window view; the radar still works. Upstream
  draws a black screen and keeps the HUD.
- **`JM` Jamming** -- the radar stops working; the view is untouched.
- **`CB` Colorblindness** -- every tank draws in your own team's colour, so you
  cannot tell friend from enemy. Touches the tank colour lookup, the radar
  colour lookup, and the scoreboard.
- **`WA` Wide Angle** -- field of view goes to `_wideAngleAng` 1.745329 rad
  (100 degrees). One camera value on the desktop; in XR the headset owns the
  projection, so this one has nothing to do there and should say so rather than
  fighting it.

**Test:** each of these plus a shake timeout short enough to watch. `WA` is the
one held back on the XR rule below -- the headset owns the projection, so a
field-of-view change has nothing to do there and it needs its own answer first.

## Phase 5 -- the effect resolver, and the movement flags

Thirteen flags, one piece of machinery. Every one of them is a multiplier or a
clamp on tank motion, and both sides need the same answer: the client predicts
the move, the server validates it against the client's own reported velocities
(`validateMovement`, `server.js:1895`), so a speed multiplier the server does
not know about reads as linear drift.

Add to the shared pair:

```
getFlagEffects(abbreviation) -> {
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

`NJ` is out of this group and in already: it is a clamp on the jump gate rather
than on the motion resolver, and the gate has asked the shared pair since the
jumping switch landed. See "Jumping, and the flags that carry it".

`TR` is a firing rule rather than a motion one, but it belongs here: it is an
input clamp, and the resolver is where input clamps live.

## Phase 6 -- damage rules

Three flags that change what a hit does rather than what a shot is. bzo's server
owns hit detection (`simulateProjectilesStep`), which makes all three
server-side and simpler than upstream. **`SH` Shield is implemented**; the other
two are not.

- **`SR` Steamroller** -- touching a tank kills it, within
  `_srRadiusMult` 2.0 tank radii. A new server-side per-tick proximity sweep
  over live players; there is no such sweep today. Upstream's `_squishFactor`
  and `_squishTime` only flatten the victim's model as it dies, which is
  cosmetic and can wait.
- **`G` Genocide** -- killing one tank kills its whole team. Upstream detects
  this on each client (`playing.cxx:2664`), because upstream's clients report
  their own deaths; bzo's server decides hits, so bzo does it in one place on
  the server when the killing shot carried `G`. That is a deliberate deviation
  and the reason to note it: the outcome is identical and the check is not
  duplicated per client.

`G` needs the projectile to remember which flag fired it. Add `flag` to
`Projectile` (`server.js:1598`) from the shooter's carried flag at fire time,
and put it in the `shotBegin` payload -- the client needs it too, from phase 8
on, to draw the shot right. This is the whole of phase 8's plumbing, arriving
one phase early because `G` is the cheapest thing that proves it works.

### `SH` Shield (implemented)

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

## Phase 7 -- per-player tank dimensions

Three flags, and one number that is currently a literal in a dozen places.
`checkCollision(x, y, z, tankRadius = 2, ...)` (`server.js:1693`),
`validateMovement`'s hardcoded `2` (`:1961`), the hit test's `dist < 2`
(`:3418`), `findValidSpawnPosition` and the client's `validateMove`
(`public/client.js:4212`) all assume one size for every tank.

Give a player a size derived from its flag, thread it through all of those, and
scale the rendered model to match:

| Flag | Effect | Constant |
|---|---|---|
| `T` Tiny | length and width x0.4 | `_tinyFactor` |
| `N` Narrow | width x0.001 | literal in `Player.cxx:756` |
| `O` Obesity | length and width x2.5, too wide for a teleporter | `_obeseFactor` |

Height is never scaled -- `Player::setFlagEffect` (`Player.cxx:733`) touches
only the first two of the three dimensions, so a Tiny tank is short and stubby
rather than small, and an Obese one is not tall. Upstream also eases the scale
in over `FlagEffectTime` rather than snapping it; that is cosmetic and can wait,
but the collision size must be the *target* from the moment the flag is taken or
the two sides disagree during the ease.

Upstream's dimensions are `_tankWidth` 2.8, `_tankLength` 6.0 (so
`_tankRadius` = 0.72 x length = 4.32) and `_tankHeight` 2.05. bzo's tank is
half that width, which is why `FLAG_GRAB_RADIUS` is built from
`BZFLAG_TANK_RADIUS` rather than from bzo's 2 -- the same question comes up
here, and the same answer applies: scale the *factors* from upstream and the
*base* from bzo.

`N` is the one that needs the oriented box rather than the cylinder, and
`checkCollision` already has both shapes (`options.rotation`). The hit test
does not -- it is a plain radius -- so `N` only reads as narrow against shots
once the hit test uses the box too. Worth doing in this phase; upstream's
`Player::getDimensions` is one shape for both.

`O` not fitting through a teleporter falls out of the box test for free, since
bzo's teleporter portal interior already keeps a full-radius check.

## Phase 8 -- shot variants

Five flags. All of them are the same change: a shot's rate, lifetime, velocity
and obstacle behaviour come from the firing flag instead of from
`GAME_CONFIG`. Phase 6 already put `flag` on the projectile and in `shotBegin`.

- `GAME_CONFIG.SHOT_SPEED`, `SHOT_RANGE`, `SHOT_RELOAD_TIME` and
  `SHOT_MAX_ACTIVE` become the defaults a resolver overrides per shot. Upstream
  multiplies: `ShotStatistics` and `LocalPlayer::fireShot` read `_*AdVel`,
  `_*AdRate` and `_*AdLife` and apply them to the world's numbers.
- `getShotRejection` (`server.js:1992`) and `getAvailableShotSlot` (`:2058`)
  are the reload gate. Both need the per-flag rate or a machine gun trips them.
- The client draws the shot and must agree about its length and lifetime.

| Flag | Velocity | Rate | Life | Notes |
|---|---|---|---|---|
| `F` Rapid Fire | x1.5 | x2 | x1/2 | `_rFireAdVel` `_rFireAdRate` `_rFireAdLife` |
| `MG` Machine Gun | x1.5 | x10 | x1/10 | `_mGunAd*` |
| `L` Laser | x1000 | x0.5 | x0.1 | `_laserAd*`; effectively instant, so it is a beam to draw, not a projectile to fly. Also `_lRAdRate` 0.5 when Laser and Ricochet meet. |
| `IB` Invisible Bullet | -- | -- | -- | the shot is not drawn on other players' radar, but is drawn out the window |
| `SB` Super Bullet | -- | -- | -- | passes through buildings; skip the obstacle test in `simulateProjectilesStep` |

`L` is the one with real client work in it: an instant beam has no travel to
interpolate, so it wants its own draw path.

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
- **The world border**, which bzo models as four boxes, so it needs nothing of
  its own. The obstacle test now runs before the out-of-bounds test for that
  reason.
- **The ground**, which upstream treats as a surface of its own
  (`ShotStrategy::getGround`) rather than as an obstacle, and so does
  `traceShotStep`.

**Teleporter frames still stop a bouncing shot**, and are the one surface that
does not reflect. Frames are decided by the teleporter trace, which the client
does not run for shots at all -- it has no frame hit to bounce off -- so
bouncing them on the server alone would put the two copies of the shot on
different paths. Doing it properly means the frame test joining the shared pair.

**A ricocheted shot can kill the tank that fired it**, which is the flag's own
help text. `LocalPlayer::checkHit` tests a player's own shots like anyone
else's; before it bounces a shot cannot reach its shooter, because it leaves the
muzzle further out than the hit radius and outruns the tank, but bzo samples a
shot once a step rather than testing the whole segment, so it says that outright
rather than trusting the sampling to agree. Killing yourself is a loss and
nothing else, as self-destruct is.

`SB` and `L` both interact with this when they land: a super bullet ignores
buildings and so never reflects off one, and Laser and Ricochet together halve
the reload rate (`_lRAdRate`).

## Phase 10 -- Shock Wave

`SW`. A shot with no position and no direction: firing kills every tank between
`_shockInRadius` (`_tankLength`) and `_shockOutRadius` 60, over
`_shockAdLife` 0.2 of the normal shot life, including tanks on and inside
buildings. Needs a shot kind that expands rather than moves, a sphere to draw,
and the team-kill warning upstream gives it. The proximity sweep from `SR` is
the same shape of code.

## Phase 11 -- Thief

`TH`. A fast, tiny, harmless tank whose shot steals a flag instead of killing:
speed `_thiefVelAd` 1.67, size `_thiefTinyFactor` 0.5, shot velocity
`_thiefAdShotVel` 8.0, rate `_thiefAdRate` 12.0, life `_thiefAdLife` 0.05, and
`_thiefDropTime` half a reload before the stolen flag can be dropped. Needs
phase 7's dimensions and phase 8's shot variants, and one new server rule: a
hit transfers the victim's flag to the shooter rather than killing.

## Phase 12 -- Guided Missile

`GM`. A shot that steers toward a locked target at `_gmTurnAngle` 0.628319 rad
per second after `_gmActivationTime` 0.5s, with life `_gmAdLife` 0.95 and a
`_gmSize` 1.5 model. Lock-on is upstream's `identify` at `_lockOnAngle` 0.15,
retargetable in flight.

bzo already has the target: the `identify` binding on `I`, right click, either
VR B button and either gamepad shoulder picks the tank in your sights within
`_targetingAngle` 0.3 and sets it as your nemesis. That is the lock. What is
missing is a shot whose direction is recomputed each tick on the server, and
the HUD lock-on box and sound.

## Phase 13 -- per-viewer visibility

Four flags that all ask the same new question: what a tank looks like depends on
who is looking. Today every client draws every tank the same way. All four need
the *carried flag of other players* to be known to the client, which it already
is -- `flag.owner` in the flags array -- so the work is in the render path, not
the protocol.

- **`ST` Stealth** -- invisible on radar; the model still draws, and its shots
  still draw.
- **`CL` Cloaking** -- the model does not draw; the radar blip still does. A
  cloaked tank hit by a laser is revealed (`LocalPlayer.cxx:1630`).
- **`MQ` Masquerade** -- to an enemy, your tank and your scoreboard row take
  *their* team's colour. To a teammate, nothing changes.
- **`SE` Seer** -- sees stealthed, cloaked and masquerading tanks normally. It
  is the counter to the other three, so it is cheapest to write last and it is
  what makes them testable without two machines.

## Phase 14 -- movement through and under geometry

Three flags, each of them a change to collision itself, which is why they are
last. `WG` was the fourth and is done -- it needed air steering rather than a
change to collision, so it came out of this group early. `motion.mjs` and `collision.mjs` are the shared pairs involved, and both
have tests that need to keep passing.

- **`OO` Oscillation Overthruster** -- drives through buildings; cannot reverse
  or shoot while inside one (`LocalPlayer.cxx:678`, `:916`). Needs "inside a
  building" as a state the tank can be in, which `motion.mjs` currently treats
  as the one thing that must never happen.
- **`BU` Burrow** -- sits at `_burrowDepth` -1.32, immune to normal shots,
  killable by `SR` from anyone including teammates, speed x`_burrowSpeedAd` 0.80
  and turn x`_burrowAngularAd` 0.55. Needs negative ground, which bzo's
  `groundLimit` assumes is zero.
- **`PZ` Phantom Zone** -- passing through a teleporter toggles Zoned; a Zoned
  tank drives through buildings, fires Zoned shots, and can only be hit by
  `SB`, `SW` or another Zoned shot. Needs `OO`'s pass-through, a hook on bzo's
  teleporter path, and a shot kind with its own hit rules.

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
