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

`maps/test.bzw` carries a labelled example of each obstacle keyword: a row of
boxes named for the mode each one demonstrates, which bzo draws as their debug
labels.

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
| `world` / `size r` | `MAP_SIZE = 2r` | BZW states the half width |

`pos` and `rot` are upstream's own aliases (`WorldFileLocation::read`), so a map
that uses the short spellings is not a map that arrives at the origin.

A `pyramid` is flat-topped -- the kind you can drive on -- if it says `flipz`
or gives a negative `size` height. Both are upstream's ZFlip, either may come
first, and bzo stores the answer as a positive `h` with `inverted` set.

## Obstacles

`box`, `pyramid`, `base` and `teleporter` are read. Each takes `name`,
`position`, `size` and `rotation`; `base` also takes `color`, `pyramid` also
takes `flipz`, and `teleporter` also takes `border`.

`color` is a BZFlag team index, clamped to 1-4 (red, green, blue, purple), and it
is what makes a base a capture target for that team. A `base` with no `color`
is red.

An obstacle with no `name` is given one -- `B0`, `P3`, `t2` -- because the name
is what the collision log, the debug labels and the teleporter links refer to.

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
`<name>:f` and `<name>:b`. A `link` block takes `from` and `to`, either of
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
| `-autoTeam` | assign teams rather than letting players pick |
| `-mp a,b,c,d,e,f` | per-team player limits, in BZFlag's team order; a team limited to 0 is not offered |
| `-j` | tanks may jump |
| `+r` | every shot ricochets |
| `-fb` | superflags may spawn on and come to rest on buildings |
| `-st <seconds>` | how long a bad flag sticks before it shakes off |
| `-sw <kills>` | how many kills shake a bad flag off |
| `-sa` | put an antidote flag in the world for whoever carries a bad one |

A map option only ever turns a switch **on**, which is how a bzfs switch behaves:
nothing in a map turns off something the server config enabled. `-j` is the one
that reads oddly as a result -- bzo has jumping on by default, so `-j` in a map
matters only on a server whose own config turned it off.

`-mp` with no explicit `-c` or `-offa` implies team play when it enables any
team other than rogue and observer.

## What is ignored

Anything not listed above is skipped without comment, which means a map using it
loads and plays with that part of it missing. The notable absences:

- **Mesh geometry**: `mesh`, `meshbox`, `meshpyr`, `arc`, `cone`, `sphere`,
  `tetra`. bzo has boxes and pyramids, so a map built out of meshes arrives
  mostly empty.
- **Groups**: `define` / `enddef` / `group`, and the instancing that goes with
  them. A grouped map arrives without whatever the groups contained.
- **Appearance**: `material`, `texture`, `texsize`, `texoffset`, `dynamicColor`,
  `textureMatrix`, `phydrv`. bzo textures obstacles by type.
- **Transforms**: `shift`, `scale`, `shear`, `spin`, `xform`, which upstream
  reads on any obstacle. An obstacle carrying one arrives untransformed.
- **`world` fields other than `size`**: `flagHeight`, `noWalls`,
  `freeCtfSpawns`.
- **`water`, `zone`, `weapon`, `physics`**, and the flag-placement keywords a
  `zone` block carries. bzo places flags itself.
- **`-set` and other BZDB assignments.** bzo's world constants are constants; see
  `docs/flags-plan.md` for why.

A map that needs any of these is not rejected -- it is worth knowing that it
loaded rather than that it loaded *correctly*.
