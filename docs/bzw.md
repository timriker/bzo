# BZW map import

What bzo reads out of a BZFlag `.bzw` file, and what it ignores. The importer is
`parseBZWMap` in `server.js`, with the `options` block split between
`parseBZWServerOptions` there and `parseBZWTeamMode` in the `teams` pair.

Maps live in `maps/`; `mapFile` in `server.json` picks one, and `"random"`
generates a world instead. A map is parsed once, on startup, and the obstacle
list goes to every client in the `init` payload, so the client and the server
collide against the same geometry by construction.

Every keyword is matched case-insensitively against the line's first
whitespace-delimited token, as upstream matches with `strcasecmp` -- so
`Position` is a position and `basey` is not a `base`.

`maps/bzo.bzw`, the default map, carries a labelled example of each
passability keyword in its south-east corner: a row of boxes named for the
mode each one demonstrates, which bzo draws as their debug labels.

Two references, and they answer different questions. `$HOME/bzflag/src/bzfs/`
is the authority on what a keyword *does* -- `WorldFileLocation::read`,
`WorldFileObstacle::read`, `CustomPyramid`. The BZW format documentation at
<https://projects.porteighty.org/bzw_docs/documentation/world-design/bzw/> is
the authority on what a mapper is allowed to write.

## Coordinates

BZFlag's world is right-handed with +Y north and +Z up; bzo's is Three.js's,
with -Z north and +Y up. The importer converts as it reads:

| BZW | bzo | note |
|---|---|---|
| `position x y z`, or `pos` | `x`, `z = -y`, `baseY = z` | +Y north becomes -Z north |
| `size x y z` | `w = 2x`, `d = 2y`, `h = z` | BZW's x/y are half extents, z is a full height |
| `rotation deg`, or `rot` | `rotation = deg * pi/180 + pi` | degrees CCW about +Z, and the depth axis flips |
| `world` / `size r` | `MAP_SIZE = 2r` | BZW states the half width; `CustomWorld.cxx:38` doubles it too |

`pos` and `rot` are upstream's own aliases (`WorldFileLocation::read`), so a map
that uses the short spellings is not a map that arrives at the origin.

A `pyramid` is flat-topped -- the kind you can drive on -- if it says `flipz`
or gives a negative `size` height. Both are upstream's ZFlip, either may come
first, and bzo stores the answer as a positive `h` with `inverted` set.

## Obstacles

`box`, `pyramid`, `base` and `teleporter` are read. Each takes `name`,
`position`, `size` and `rotation`; `box` and `pyramid` also take `color`,
`base` also takes `color` with a different meaning, `pyramid` also takes
`flipz`, and `teleporter` also takes `border`.

On a `base`, `color` is a BZFlag team index, clamped to 1-4 (red, green, blue,
purple), and it is what makes a base a capture target for that team. A `base`
with no `color` is red. A base is tinted by the team holding it, so it takes no
colour of its own.

**Every obstacle carries a `rotation`, whether or not the block gave one.** The
importer states 0 for a block that says nothing, because everything downstream
turns the field into a cosine: the collision pair, the renderer, the radar and
the logs all read it, and one absent field meant each of them carrying a default
of its own. A missing one used to read as 0 in the arithmetic and throw in the
one place that formatted it -- an anti-cheat collision report against an
unrotated box -- which is exactly the cost of a shape that is only mostly
there.

**A zero height is a real height.** `size w d 0` is upstream's own default for a
`base` -- `CustomBase` leaves the third extent at 0 -- and it means a pad painted
on the ground rather than a block: a tank drives onto it instead of having to
jump, and a shot flies across it. Any obstacle may say it; only a `base` has much
reason to. An obstacle that gives no `size` at all is a different thing, and
still falls back to bzo's 4.

An obstacle with no `name` is given one -- `B0`, `P3`, `t2` -- because the name
is what the collision log, the debug labels and the teleporter links refer to.

### Colour

On a `box` or a `pyramid`, `color` is the colour the obstacle is painted, and
`diffuse` is the same property under the name bzflag itself writes
(`ParseMaterial.cxx:90`). Three or four numbers between 0 and 1, upstream's own
numeric colour form:

```
box
  name BU_Burrow
  position -25 40 0
  size 1 1 0
  color 1.0 0.62745 0.12549
end
```

The colour multiplies the texture the obstacle already wears rather than
replacing it, which is what `diffuse` does in the pipeline upstream draws with.
`bzo.bzw` paints the pad under every bad flag's zone, so a pad reads as
the kind of flag standing on it -- and the figure is written into the map rather
than looked up from bzo's own bad-flag colour, because what a map is painted is
the map's decision.

A face selector in front of the keyword narrows which faces take it, and
upstream's names are `x+`, `x-`, `y+`, `y-`, `z+` and `z-` with `top`,
`bottom`, `sides` and `outside` as extras (`CustomBox.cxx:34`). bzo draws a box
as two groups -- its four walls and its two caps -- so a selector lands on one of
those two: the upright faces are walls, the flat ones are caps, and naming one
wall paints all four. Upstream's `z` is up where bzo's `y` is, so `z+` and `z-`
are the caps.

The fourth number is alpha. It is read, so a map stating it is not turned away,
and then dropped: an obstacle bzo draws is opaque. Upstream also accepts an X11
colour name here; bzo does not, and an obstacle naming one keeps its plain
texture.

Everything that draws the obstacle follows the colour. Its debug label wears it,
as a base's label wears its team's, and the radar shades its footprint with it --
towards the panel's neutral grey, the same way and by the same fraction a base's
team colour is shaded, so a painted surface still reads as ground rather than as
a tank.

Painting an obstacle costs one extra draw call for all the tinted boxes on the
map and one for all the tinted pyramids, because the colour rides on the vertices
and lets obstacles painted differently still merge into one mesh -- the way every
base already shares one material whatever team holds it. A map that paints
nothing pays nothing.

Upstream reads this on a plain `box`, but not for free: any material property
makes `CustomBox` emit a `MeshObstacle` instead of a `BoxBuilding`
(`CustomBox.cxx:302`). The shape is the same box either way, so bzo reads the
colour and keeps its own box.

### Passability

Upstream's `WorldFileObstacle::read` takes four bare keywords, no arguments,
matched without regard to case. Every obstacle type inherits them, and bzo reads
all four on all four types:

| keyword | effect |
|---|---|
| `drivethrough` | tanks pass through it |
| `shootthrough` | shots pass through it |
| `passable` | both of the above |
| `ricochet` | shots bounce off it, even shots that would otherwise stop |

`drivethrough` is honoured by both copies of `checkCollision`, `shootthrough` by
`findShotObstacle` and `findShotSegmentImpact` -- upstream tests
`isShootThrough()` in `getFirstBuilding` before it looks at any geometry, and
these are the same question in the same place. `ricochet` is upstream's third
source of a bounce after the world's `+r` and the Ricochet flag: `makeSegments`
stops an ordinary shot only when `!building->canRicochet()`, and otherwise gives
it the same reflection an `R` carrier gets.

The world border is built from the same two flags rather than from a special
case. Upstream's border is one `WallObstacle` a side doing two jobs at once --
`inCylinder` ignores height, so it stops a tank at any altitude, while
`makeSegments` ignores a bouncing shot's hit above `getHeight()` and lets the
shot fly over rather than back into the arena. bzo says that with two colliders a
side: a barrier a thousand units high marked `shootthrough`, which stops tanks
and nothing else, and in front of it the visible wall, `_wallHeight` tall and
marked `drivethrough`, which stops shots and nothing else. See
`getWorldBorderColliders`.

## Teleporters and links

A `teleporter` is a box with a `border`, and its two faces are named
`<name>:f` and `<name>:b`. A teleporter that gives neither takes upstream's
defaults from the `CustomGate` constructor -- half width `0.5 * _teleportWidth`,
half breadth `_teleportBreadth`, height `2 * _teleportHeight`, and a border of
twice the half width, so `0.56 / 4.48 / 20.16 / 1.12` -- which is what
`maps/bzo.bzw` relies on and every other map in `maps/` spells out.

**The importer resolves the border into the solid, and the world goes out
collision-ready.** `Teleporter::finalize` grows the stated size by the border --
`size[1] = origSize[1] + border * 2`, `size[2] = origSize[2] + border` -- and
those grown values *are* the obstacle's extents upstream, so they are what
collides, what holds a tank up and what is drawn. bzo therefore applies that
growth once, at parse time, and a teleporter's `w`/`d`/`h` on the wire mean
exactly what they mean on a box: the solid.

BZW's convention is the opposite -- its stated size is the *opening*, and the
frame is that plus the border -- which is a trap for every reader downstream.
Three of them open-coded the growth and two got it wrong: the obstacle top, the
support footprint, and the debug outline that is supposed to *show* the support
footprint. `getShotTeleporterDims` is now a reader rather than a calculator; the
only thing it still derives is the portal opening inside the frame, which is
upstream's own `getBreadth() - border` subtraction. Anything that wants the
solid can just read `w`/`d`/`h` and be right by default. A `link` block takes `from` and `to`, either of
which may be:

- a face name, `ne_tele_low:f`;
- a glob over face names, `ne_*:f` or `?w_tele_high:b`, matched case-insensitively;
- a numeric face id, `0` for the first teleporter's front face, `1` for its back.

A trailing `F` or `B` is accepted for `f` and `b`, and a leading `:` is dropped.
As upstream does, **a source face with no link of its own passes through to the
opposite face of the same teleporter**, so an unlinked teleporter is a doorway
rather than a dead end. A link naming a face that does not exist is logged and
dropped.

## The `options` block

Read as a bzfs command line, one option a line. Everything bzo understands:

| option | effect |
|---|---|
| `-c` | team play on |
| `-offa` | team play off, free-for-all |
| `-rabbit [score\|killer\|random]` | Rabbit Chase: one rabbit against every hunter, no colour teams |
| `-autoTeam` | assign teams rather than letting players pick |
| `-a <vel> <rot>` | the world's acceleration limit, upstream's inertia switch; `0 0` is none |
| `-noTeamKills` | players on the same team are immune to each other; rogue is excepted |
| `-tk` | a team killer does *not* die for it -- upstream kills them by default, and this is the opt-out |
| `-mp a,b,c,d,e,f` | per-team player limits, in BZFlag's team order; a team limited to 0 is not offered |
| `-j` | tanks may jump |
| `+r` | every shot ricochets |
| `-fb` | superflags may spawn on and come to rest on buildings |
| `-st <seconds>` | how long a bad flag sticks before it shakes off |
| `-sw <kills>` | how many kills shake a bad flag off |
| `-sa` | put an antidote flag in the world for whoever carries a bad one |
| `-ms <count>` | how many shots a tank may have in the air at once |
| `-s <count>`, `+s <count>` | how many superflag slots the world holds |
| `-f <abbrev\|good\|bad>` | take a flag type, or a whole quality, out of the pool |
| `-set _maxFlagGrabs <n>` | how many pickups a superflag survives |
| `-set _wingsJumpCount <n>` | how many times `WG` Wings may flap before it needs the ground again |
| `-set _maxBumpHeight <n>` | how high a step a tank may climb without jumping |
| `-srvmsg <text>` | a line the world says to each player as they join |

## A pad flush with the ground

An obstacle with **no height, sitting on the ground** -- `size w d 0` at
`position x y 0`, which is exactly how BZW writes a flat base -- is a pad rather
than a block, and bzo makes it passable to tanks and to shots whether or not the
map says `drivethrough`. Upstream's own words, on the base
(`BaseBuilding.cxx:77`): *"if a base is just the ground (z == 0 && height == 0)
no collision -- ground is already handled".*

Upstream writes that guard on the base alone, because a zero-height box is
vanishingly rare there. Its box arithmetic has none, and the case that shows the
difference is a **burrowed** tank: `BU` drives below zero, so its own span reaches
up through a pad's `[0, 0]` and it stops dead on one.

A pad is still drawn, and still labelled by the debug labels: the passability
flags are read only by the collision code, never by the renderer. That is what
makes a pad useful for marking ground -- `maps/bzo.bzw` puts a named one under
every flag zone, so `L_Laser` and friends label the whole ring.

A map option only ever turns a switch **on**, which is how a bzfs switch behaves:
nothing in a map turns off something the server config enabled. `-j` is the one
that reads oddly as a result -- bzo has jumping on by default, so `-j` in a map
matters only on a server whose own config turned it off.

The two options that carry a *value* rather than flip a switch are the exception,
and they differ from each other. `-st` and `-sw` take the larger of the map's
number and the config's, because both are switches that happen to be spelled with
a number. `-ms` **replaces** the config's `shotMaxActive` outright: upstream reads
a map's `options` block where `-world` sits on its command line, so the map's
number is simply the later assignment. Changing it re-derives the reload time from
`shotRange / shotSpeed / shotMaxActive`, since each slot comes back after
`_reloadTime / maxShots`; a `shotReloadTime` pinned in `server.json` still wins.
`-ms 0` means "tanks cannot shoot" upstream, which bzo has no mode for, so zero
is clamped to one shot as the config's own value is.

`-s` replaces `superFlags.count` the same way and for the same reason. Its count
is optional, and upstream turns anything unparseable *or zero* into 16 -- `atoi`
gives 0 for a missing count and 0 is then overwritten -- so `-s`, `-s 0` and
`-s 16` are all sixteen flags and none of them are none. `+s` differs from `-s`
only in marking every slot `required`, which keeps all of them in the world at
once where `-s` lets a slot sit empty between insertions; bzo has only the
insertion schedule, so it reads both spellings the same way.

`-set _maxFlagGrabs` is a plain BZDB assignment, so the map's number replaces the
config's `maxFlagGrabs` as `-ms` and `-s` do. Only the server acts on it -- it is
read on grab and spent on drop -- but it rides into the `init` payload anyway,
which is bzo's equivalent of upstream shipping every BZDB var to clients whether
the client reads it or not.

`-set _wingsJumpCount` and `-set _maxBumpHeight` are the same assignment again,
each replacing its own `server.json` key (`wingsJumpCount`, `maxBumpHeight`).
`_maxBumpHeight` is purely a client value -- bzo's bump-climb is resolved on the
client alone, `server.js` never runs a tank's motion itself -- so unlike the
others it does nothing the server acts on directly; it rides `GAME_CONFIG` to
the client the same way regardless, which is what `resolveTankStep` reads
instead of the module's own default.

`-srvmsg` accumulates: every occurrence is another line, in map order, and a
single occurrence may carry more than one by writing a literal `\n` inside it.
Upstream joins them with that same marker and splits them again on the way out
(`bzfs.cxx:2507`), so both spellings mean the same thing. The text is taken off
the raw line rather than from the split tokens, because its own spacing is part
of it -- upstream reads a quoted argument as one token and never touches the
inside.

The lines go out as ordinary **server chat to the player who just joined**, which
is how upstream sends them, and is why they are not `motd`:

| bzo | upstream | what it is |
|---|---|---|
| a map's `-srvmsg` | `-srvmsg` | said to each player on join, after the join completes |
| `motd` in `server.json` | *nothing* | the label the entry dialog shows before anyone joins |
| `description` in `server.json` | `-publictitle` | the blurb a public server list shows |

Upstream has **no server MOTD at all.** Its `MessageOfTheDay` (`src/bzflag/motd.cxx`)
is a *client* feature: the client fetches `BZDB.get("motdServer")` over HTTP and
shows a BZFlag project announcement, which no game server has any say in. bzo's
`motd` is its own thing and keeps its own name; the one upstream option it
resembles is `-srvmsg`, and the two are kept apart because they speak at
different moments -- one before you join, one after.

Not read: `-admsg`, upstream's periodic advertisement broadcast to everyone on a
timer, and `-helpmsg`, which reads chunks out of a file.

`-f` is a switch that happens to name its target: disallows accumulate, nothing
puts one back, and `good` or `bad` takes a whole quality out at once. It filters
the pool a slot draws from, next to the two types the game style already forbids
(`JP` or `NJ` by the jumping switch, `R` on a `+r` world). Naming `WA`, the one
flag bzo does not carry, is not an error -- it was not in the pool to remove.

Upstream's `+f <abbrev>[{count}]`, which pins a chosen number of one type in the
world, is **not** read: bzo's flag model is one pool and one slot count, with no
per-type counts to put them in.

`-mp` with no explicit `-c` or `-offa` implies team play when it enables any
team other than rogue and observer.

`-rabbit` is the one option here that turns something *off*: Rabbit Chase has no
colour teams, so it zeroes every colour team's limit whatever the config or an
earlier `-c` asked for, and says so on load. That is upstream's own behaviour
(`CmdLineOptions.cxx:1586`) and it is what makes Rabbit Chase and CTF mutually
exclusive -- upstream complains about the pair and lets Rabbit Chase win
whichever order they arrive in. A map with bases still loads; they simply stand
there with no team to own them.

The style argument is optional and names one of upstream's three: `score` picks
the rabbit by ranking, `killer` gives it to whoever shot the last one, `random`
replaces the ranking with a random number. A bare `-rabbit` is `score`, and so
is a style bzfs would not recognise -- it leaves the argument unconsumed rather
than rejecting the switch.

A map with no `world` block gets upstream's own default: `_worldSize` 800, which
is the full width, so the world spans +/-400.

## World weapons

A `weapon` block is a gun the world owns: it fires on a timer with nobody
driving it, and its shots kill whoever they reach.

| BZW | bzo | notes |
|---|---|---|
| `position x y z` | the muzzle | BZW's `+Y` north is bzo's `-Z`, as for an obstacle |
| `rotation deg` | the aim, around up | `bz_vectorFromRotations`, in bzo's axes |
| `tilt deg` | the aim, up or down | 0 is level |
| `type <abbrev>` | the firing flag | anything in the flag table; unknown fires a plain shell, as `Flags::Null` does |
| `initdelay s` | the first shot | default 10, measured from when the world was built |
| `delay s [s ...]` | the interval after that | default 10. A **list** is a rhythm upstream cycles a shot at a time |

**A world weapon has no visible component**, upstream or here. It is not an
obstacle: nothing is drawn at its position and it occupies no space, so a map
that wants one to be seen puts a box under it -- which is what every weapon in
`fountains.bzw` has. The `size` a weapon inherits from `WorldFileLocation` is
never read.

**And no name.** `CustomWeapon::read` reads no `name`, and a weapon is not in the
obstacle table to be named in. What upstream gives them instead is one collective
identity: a single `WorldPlayer` pseudo-player for every world weapon on the map,
`Player(ServerPlayer, RogueTeam, "world weapon", "", ComputerPlayer)`, whose
shots are drawn and put on the radar as that player's. It is not on the
scoreboard, because it is not in `remotePlayers`, and bzo keeps it out of the
roster for the same reason.

So a shot from one carries upstream's `ServerPlayer` id and the rogue team, which
is what bzo's `WORLD_WEAPON_PLAYER_ID` and `WORLD_WEAPON_TEAM` are, and it takes
no shot slot and waits on no reload -- there is no tank to answer for it. Being
rogue makes it everybody's enemy, which is what a world weapon should be.

A tank killed by one gets a death, nobody gets a kill, and the victim's team
loses a point. The notice is upstream's own whole phrase rather than a name:
`gotBlowedUp` throws the "Got shot by " prefix away when the killer has no roster
entry and says **"Killed by the server"**, which every world weapon kill does,
because `lookupPlayer` finds the pseudo-player by name and never by id.

`trigger` and `eventteam` make an event-fired weapon instead of a timed one.
bzo has no event hooks to hang one on, so a map using either is named on load and
that weapon fires on its timer.

## What is ignored

Anything not listed above is skipped without comment, which means a map using it
loads and plays with that part of it missing. The notable absences:

- **Mesh geometry**: `mesh`, `meshbox`, `meshpyr`, `arc`, `cone`, `sphere`,
  `tetra`. bzo has boxes and pyramids, so a map built out of meshes arrives
  mostly empty.
- **Groups**: `define` / `enddef` / `group`, and the instancing that goes with
  them. A grouped map arrives without whatever the groups contained.
- **Appearance other than `color`**: `material` blocks and the `matref` that
  names one, `texture`, `texsize`, `texoffset`, `dynamicColor`, `textureMatrix`,
  `phydrv`, and the rest of what `parseMaterials` takes -- `ambient`,
  `specular`, `emission`, `shininess`, `noradar`, `nolighting` and their
  neighbours. bzo textures obstacles by type and lights them one way. `color`
  and `diffuse` are read; see **Colour** above.
- **Transforms**: `shift`, `scale`, `shear`, `spin`, `xform`, which upstream
  reads on any obstacle. An obstacle carrying one arrives untransformed.
- **`world` fields other than `size`**: `flagHeight`, `noWalls`,
  `freeCtfSpawns`.
- **`water`, `physics`**.
- **A `zone` block's `flag`, `team` and `safety` keywords.** `zoneflag` is read,
  so a map's flag zones work; `flag` names a type any flag of which spawns in the
  zone, `team` makes it a spawn area, and `safety` a Phantom Zone landing spot.
  A map using any of the three is named in the load log rather than skipped
  silently, because a spawn zone that is ignored moves every tank in the world.
- **Every `-set` variable but `_maxFlagGrabs`, `_wingsJumpCount` and
  `_maxBumpHeight`.** bzo's world constants are constants, and these three are
  the ones it already keeps a configurable copy of; see `docs/flags.md`. A map
  that sets another is named on load.

A map that needs any of these is not rejected -- it is worth knowing that it
loaded rather than that it loaded *correctly*.
