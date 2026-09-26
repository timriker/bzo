# BZW map features

Staging plan for the BZW keywords `docs/bzw.md` lists under "What is ignored" --
the map-format features upstream has that bzo does not read yet. Upstream
references are paths under `$HOME/bzflag/`; the format itself is also
documented at
<https://projects.porteighty.org/bzw_docs/documentation/world-design/bzw/>.

Issue #72 tracks this as a whole; open a narrower issue instead if one section
here turns into its own multi-week effort, the way flags split out to #6 and
commands to #5.

## Working method

**Validate against a real map before writing bzo's own.** Every keyword here
has years of maps already written against it; a hand-written three-line test
fixture proves the parser accepts bzo's own assumptions, not that it agrees
with what mappers actually wrote. Before starting a section, find or fetch a
real `.bzw` that exercises it, run it through `parseBZWMap`, and fix
disagreements before calling the section done.

No third-party map pack with mesh/group/physics-driver usage in the wild turned
up on a search of the BZFlag-Dev GitHub org or the usual community sites --
BZFlag ships no sample maps using them either. The porteighty `bzw_docs` pages
for `mesh` and `group` each carry a complete, runnable example block, though,
which is the next best thing to a real map and is cited per section below. `arc`/`cone`/`sphere`/`tetra`'s docs pages are unfinished --
placeholder text where an example should be -- so those four are validated
against `$HOME/bzflag/src/bzfs/Custom{Arc,Cone,Sphere,Tetra}.cxx` directly
rather than against any map, real or documented, until one turns up.

**`scripts/survey-live-maps.mjs` is how "what do real maps use" gets
answered.** It asks the public list server what is running, imports each
server's live world through bzo's own `POST /list/import`, and reports what
bzo's parser said it could not read. An imported map is bzo's own
re-serialization of the *compiled* world off the wire, so what it measures is
what a real server actually runs rather than what somebody typed: the source
map's comments, its `define` names and any keyword the compiled world drops
are gone before bzo ever sees them. The server's own world variables do
survive -- the import enters as a momentary observer to collect them and
writes the non-default ones back as `-set` lines -- so `-set` usage is
measured here like any other keyword.

**Once a keyword works, give it a home and delete the section here.** A
per-obstacle keyword (mesh, group, material, phydrv) gets a labelled corner of
`bzo.bzw`, the same treatment every obstacle and passability keyword already
has there. A **map-wide** one -- anything on the `world` block itself, since a
map has exactly one -- cannot share `bzo.bzw` that way: `noWalls` on the map
that also demos every other obstacle would delete the border every other
example relies on, and a single `waterLevel` cannot show two heights at once.
A `-set` weather preset is the same kind of map-wide singleton, one map either
raining or not. Those get their own small map instead, in the style
`collision-test.bzw`, `pizza_box.bzw` and `empty.bzw` already set: one
purpose, named for it. Either
way, `docs/bzw.md` moves the keyword out of "What is ignored" and into
whichever section documents it, with the same rigor -- upstream source, the
conversion bzo applies, what a mapper needs to know. This plan file shrinks as
sections close, down to nothing; git history holds the record of what closed,
so nothing here should say "done" and stay.

### Live servers that exercise each gap

Re-import one of these to test a section (`npm run dev`, then the join
dialog's "Import Remote Map", or `scripts/survey-live-maps.mjs --server
<host:port>`). The address is the durable pointer, not the file:
`maps/import-*.bzw` is a regeneratable cache and is gitignored. These were
the maps running at the time of the survey; a server that rotates maps may
be playing something else by the time you read this.

| Gap | Server | Map |
| --- | --- | --- |
| non-vertical `spin` (24 lines) | `bmbz.ducatileague.org:6004` | LouMan's Mystic Valley |
| non-vertical `spin` (11) | `bmbz.ducatileague.org:5152` | Airfield Attack! |
| non-vertical `spin` (9) | `bmbz.ducatileague.org:6002` | INCOMING! :: by ahs3 |
| zone `flag <type>` | `bmbz.ducatileague.org:5157` | Island Hopping |
| zone `flag <type>` | `bmbz.ducatileague.org:5160` | Castle Warfare |
| `spheremap` | `bmbz.ducatileague.org:5185` | FATALITY by tankatek |
| `occluder` | `1purplepanzer.mooo.com:4101` | Desert War |
| `angular`/`slide` physics | `bmbz.ducatileague.org:5179` | BMBZ: Eria Ziel |
| missing `explode1` texture | `bmbz.ducatileague.org:5164` | LouMan's Pandemonium |
| missing `treads` texture | `bmbz.ducatileague.org:5198` | Traxion Radial by GEP |
| missing `dusty_flare`/`puffs` | `bmbz.ducatileague.org:5185` | FATALITY by tankatek |
| missing `blend_flash` texture | `bmbz.ducatileague.org:5178` | Nix Dodgeball by R3lax |
| missing `root` texture | `1vs1.catay.be:5155` | 1vs1 fancy style |
| an `arc` bzo refuses to build | `bmbz.ducatileague.org:5162` | Pool Table by GEP |

Group-placed teleporter links are broken on import for a different reason --
a bug, not a missing keyword: see issue #130, reproduced on
`bmbz.ducatileague.org:5181` (Obstacle Course) and
`bmbz.leaguesunited.org:5198` (HiX).

**Map Viewer previews most of this without a live match.** Picking a map in
the join dialog's Map Viewer loads and renders its geometry immediately, and
its driveable phantom tank (`AGENTS.md`, "Map Viewer" -- `ROAM_VIEW.DRIVE_FP`/
`DRIVE_TP`) runs the same client-side collision and motion a real tank's
client owns, unvalidated by the server since nothing about a preview is a real
player. That is enough to check mesh/group collision, a `noWalls` map's open
edge, or a physics driver's push, by driving into it and watching what
happens -- no second client, no team to join, no server restart. What it
cannot check is anything the *server* decides: a driven tank's position is
never anti-cheat-validated in a preview, so a physics driver's interaction
with `antiCheat.collisionSlack` and the server's extrapolation still needs a
real client on the live map, not a Map Viewer session.

## Mesh geometry

`mesh`/`meshbox`/`meshpyr`/`arc`/`cone`/`sphere`/`tetra` are parsed, textured,
placed through `group` (including from inside a nested `define`), rendered,
collided with (tank and shot, oriented tank box and concave shapes included,
per-face `drivethrough`/`shootthrough`), radar-drawn, and debug-labelled. See
"Mesh and its primitives" in `docs/bzw.md` for the full detail of what a
mapper can rely on; `src/bzfs/CustomMesh.cxx`, `src/bzfs/CustomMeshFace.cxx`,
and each primitive's own `Custom*.cxx` remain the upstream reference. What is
left:

- [ ] Name a mesh's own individual faces in the collision log, the way a
      box's face selectors are named today -- a mesh's debug label already
      names the whole mesh, but not which face a report is against.
- [ ] `checkPoints` -- upstream's own aid for telling a mesh's inside from its
      outside on an arbitrary shape -- is not read: bzo's own collision never
      needs to ask that question, so there is nothing to port it onto yet.

## Groups and transforms

`define` / `enddef` / `group` are read now, including a `group` instance
nested inside a `define` -- real recursion, matching `GroupDefinition::
makeGroups`, not the flat single level first shipped. See "Groups" in
`docs/bzw.md` for what a `group` instance takes, how nesting composes, and how
a member's name is kept unique at any depth -- including a `teleporter`
placed through one, which is also read now, the same as any other member.
`src/bzfs/CustomGroup.cxx` remains the reference for what is left.

`shift`/`scale`/`spin` are read now too, as `WorldFileLocation`'s own names
for the position/size/rotation triple `CustomGroup` already folds into the
same transform -- `shift` and a vertical-axis `spin` on any obstacle, `scale`
only inside a `group` (a plain box's own `size` already means its literal
half-extent, not a multiplier, and no local map names one through `scale`
instead). See "Groups" in `docs/bzw.md` for the detail and the real map lines
that motivated it (`ahs3_Ironside_Battlefield.bzw`'s `table`/`fence` groups).
What is left:

- [ ] A bare `transform` / `enddef` block's `shift`/`scale`/`shear`/`spin`
      lines composed into one named matrix, and `xform <name>` referencing it
      from inside a `group` block or a plain obstacle.
- [ ] `shear`, on a plain obstacle or inside a `group` block -- no
      representation in bzo's axis-aligned box/pyramid model at all.
- [ ] `scale` stated directly on a plain box or pyramid, no `group` involved.
- [ ] A `spin` about anything but the vertical axis -- tips a shape out of
      bzo's axis-aligned model the same way `shear` does. The most common
      thing bzo drops on a real map: 63 such lines across 7 of the 54 live
      servers `scripts/survey-live-maps.mjs` imported, one map alone
      accounting for 24. Needs a general oriented box/pyramid
      representation, or upstream's own mesh-conversion fallback.

## Materials and appearance

`material` / `matref`, `texture`, `texsize`, `texoffset`, `dynamicColor`,
`textureMatrix`, and the lighting inputs `ambient`, `specular`, `emission`,
`shininess`, plus the flags `noradar` and `nolighting`.
`src/bzfs/CustomMaterial.cxx`, `src/common/ParseMaterial.cxx`.

**`material`/`matref`/`addtexture`/`texture` are read now**, resolving a
named stock texture against bzo's existing asset set exactly as "Evidence
from real maps" below predicted, plus `color`/`diffuse` as a tint (already
read on a plain obstacle; a `matref` is just a second way to state it),
`noradar` and `nolighting`. **An external texture URL is read too, and
forwarded to the client** -- the server itself never fetches one; each
connected browser decides for itself whether to, against an allowlist (its
own origin, or `*images.bzflag.org`) and the browser's own CORS enforcement
on top of that. See "Materials" in `docs/bzw.md` for the full syntax, the
stock-texture list, and what a material still cannot say. What is left:

### Evidence from real maps

Pulled four real maps rather than guess at what a `material` block actually
says in the wild -- `bz-next/bz-next.github.io`'s `maparchive/`, which matches
names still on the public server list today (`bzflag.allejo.io`'s "Ironside
Battlefield FFA", and a "Missile War" lineage several DarkWorld-descended
servers still run). Every texture-naming line in them is `addtexture` (the
real keyword upstream writes; a bare `texture` line never appeared once), and
it names one of two things:

- Upstream's own stock texture, by name with no path -- `boxwall`, `wall`,
  `roof`, `pyrwall`, `telelink`, `caution`, and one called `mesh` (a stock
  wireframe/grid texture, unrelated to mesh *geometry* -- see the callout in
  `docs/bzw.md`'s "Materials" section, so the two "mesh"es are never confused
  with each other). bzo already shipped an equivalent PNG for six of these
  under `public/textures/`, which is what `resolveBzwStockTexture` resolves
  against.
- One external URL, out of everything sampled:
  `http://images.bzflag.org/astevens/pine.png`, in a "wood" material. The
  BZFlag forums document uploading a texture there and linking it into a
  `material` block, so the host is real and mappers do use it -- just rarely,
  next to naming a stock texture. `maps/bzo.bzw`'s `thin_wall` names this
  same URL now, permanently, and it actually shows the real picture:
  `images.bzflag.org` sends `Access-Control-Allow-Origin: *` on every response
  (checked directly), so the browser's CORS check passes and the load
  succeeds.

This is what made resolving a named texture against bzo's *existing* asset
set almost the whole of what a real map's `material` block asks for, with an
absolute URL -- the one thing left outside that asset set -- read too, but
never fetched by bzo's own server: see "Materials" in `docs/bzw.md` for the
client-side loadability check (`isExternalTextureUrlLoadable` in
`public/texture.js` -- every host is attempted now, a deliberate deviation
from upstream's own allowlist) and its own CORS check, which
`images.bzflag.org` passes. Geometry-wise, two of the four
sampled maps were pure box/pyramid plus `group`, zero mesh; the other two
leaned on `arc` (a mesh generator) for curved walls, so mesh remains
necessary eventually rather than skippable forever -- see "Mesh geometry"
above, and every `matref` actually sampled turned out to be inside one of
those unread `mesh` faces or `arc` primitives rather than on a plain
`box`/`pyramid` -- material support pays off on today's real maps only once
mesh geometry does too.

- [ ] `texsize`/`texoffset` scaling and shifting a `matref`'d or
      `addtexture`'d picture's UVs upstream's own way, rather than every
      obstacle of a kind sharing that kind's own baked-in tiling regardless
      of what material it wears. Reading them also closes a second gap: on a
      box or pyramid they clear `isOldBox`/`isOldPyramid`, so a flush obstacle
      stating one is a mesh with degenerate faces to bzfs, and bzo's own
      zero-area check cannot report what it never reads.
- [ ] Stock textures bzo ships no PNG for, each named by a real map and
      each falling back to the obstacle's plain default: `explode1`,
      `treads`, `blend_flash`, `puffs`, `dusty_flare`, `flag`, `root` (10
      names across 10 of the 54 live maps surveyed). Several are BZFlag's
      own effect textures rather than wall textures, so some belong with
      `docs/effects-plan.md` rather than here.
- [ ] `spheremap` -- a material's environment-mapped texture coordinates,
      dropped on 4 of the 54 live maps surveyed.

## Physics drivers

`phydrv`, defined by a `physics` / `end` block and referenced from a `box`,
`pyramid`, `group` instance, or `mesh` face. `src/bzfs/CustomPhysicsDriver.cxx`,
`include/PhysicsDriver.h`. See "Physics drivers" in `docs/bzw.md` for the
full account of what a mapper can rely on now.

`linear` and `death` are read -- the two real maps actually use (16 `linear`
and 5 `death` instances across the 21 real maps fetched to validate this
section, none of them `angular`, `radial`, or `slide`). `phydrv` resolves
against a named driver registry the same digit-first-then-name way `matref`
resolves, and a `group` instance's own `phydrv` reaches a mesh member's
faces on upstream's own terms -- see "Physics drivers" in `docs/bzw.md`.
`resolvePhysicsDriverAt` (the shared `collision` pair) resolves a driver off
an obstacle/face both sides already agree they found, and can't disagree
about -- but the two sides find that obstacle two different ways, matching
two different upstream mechanisms rather than one:

- The client's `linear` push reads `lastMotionObstacle`, set from its own
  swept motion the same way upstream's `lastObstacle` is: only from a
  surface the tank was actually expelled by/rests on (`LocalPlayer.cxx:
  617-624`), never a `driveThrough` one.
- The server's death check (and its anti-cheat `linear` drift allowance)
  uses `findPhysicsSurfaceObstacle` (server.js/collision.cjs only -- the
  server has no swept-motion tracking of its own to reuse), a static
  overlap test matching upstream's *other* mechanism,
  `LocalPlayer::getHitBuilding`/`collectInsideBuildings` (LocalPlayer.cxx:
  927-937, 986-992): it deliberately ignores `driveThrough`, since a death
  face is exactly the kind of surface a tank is meant to drive straight
  across. Originally this reused `checkCollision` (the anti-cheat
  penetration test, whose vertical slack is written to let a tank resting
  exactly on solid ground read as *clear* -- backwards for "what am I on"),
  which is why the death driver silently never fired until this existed.

What's left:

- [ ] `angular` (a rotation about a point) and `slide` (removes friction
      rather than pushing) -- parsed as recognized-but-unread keywords inside
      a `physics` block, so a map defining one still loads and round-trips
      cleanly, but not wired to motion. No real map sampled uses either; add
      the motion side once one does.
- [ ] `radial` -- parsed the same way, but likely never needs a motion side
      at all: upstream itself never applies it either (no
      `PhysicsDriver::getRadialVel`/`getRadialPos` consumer anywhere in its
      own renderer), the same shelved-feature shape as `combineMode: decal`
      under "Materials" above.

## Zones and occluders

- [ ] A zone's `flag <type>` qualifier -- "flags of this type respawn here",
      distinct from `zoneflag <type> [count]`, which is read and puts flags
      into the world. Dropped on 9 of the 54 live maps surveyed, the most
      widespread single keyword bzo does not read. `CustomZone::read`.
- [ ] `occluder` -- a mesh marked as blocking what is behind it, upstream's
      own visibility cull. One map of 54. bzo culls through three.js's own
      frustum culling and nothing else, so this is a rendering-speed
      keyword with no gameplay meaning; last in line here for that reason.

## Leftovers

Small enough to fold into whichever section lands near them, or to take as a
single pass once the rest of this plan is empty:

- [ ] Any `-set` variable beyond the three bzo already threads through
      (`_maxFlagGrabs`, `_wingsJumpCount`, `_maxBumpHeight`) stays a
      map-by-map judgment call -- add a config knob for one only when a map
      that needs it shows up, per `docs/flags.md`'s existing rule for these.
- [ ] A real second-texture decal blend, matching the `combineMode: decal`
      default `BzMaterial::addTexture` already sets (`BzMaterial.cxx:825`)
      but no upstream renderer ever draws -- see "Materials" in
      `docs/bzw.md` for the full account. Behind everything else here on
      purpose: this would put bzo ahead of what a live bzflag client shows
      today rather than catching up to it, so it waits until the rest of
      this plan -- the parts where bzo is still behind upstream -- is done.

Not planned: `-helpmsg`. Its argument is a path on the server's filesystem, and
upstream itself refuses to take one from a world file
(`checkFromWorldFile`, `CmdLineOptions.cxx:337-344`) for exactly the reason bzo
would inherit worse -- every option here arrives through a map's `options`
block, and a map is not only something an operator hand-wrote; see
`docs/bzw.md`'s note on `-helpmsg` under "The options block".
