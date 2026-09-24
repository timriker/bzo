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
the logs all read it directly, with no default of their own to fall back on.

**A zero height is a real height.** `size w d 0` is upstream's own default for a
`base` -- `CustomBase` leaves the third extent at 0 -- and it means a pad painted
on the ground rather than a block: a tank drives onto it instead of having to
jump, and a shot flies across it. Any obstacle may say it; only a `base` has much
reason to. An obstacle that gives no `size` at all is a different thing, and
still falls back to bzo's 4.

An obstacle with no `name` is given one -- `B0`, `P3`, `t2` -- because the name
is what the collision log, the debug labels and the teleporter links refer to.

A bare `box`, `pyramid` and `base`, each at upstream's own default `size` for
one that gives none (`_boxBase`/`6 * _muzzleHeight`, `30.0`/`9.42`; `_pyrBase`/
`5 * _tankHeight`, `8.20`/`10.25`; a `base`'s own zero-height default, see
above):

```
box
	position     x     y     0.0
	rotation     deg
	size         30.0  30.0  9.42
end

pyramid
	position     x     y     0.0
	rotation     deg
	size         8.20  8.20  10.25
end

base
	position     x     y     0.0
	rotation     deg
	size         30.0  30.0  0.0
	color        1
end
```

A `base` is a `box` under a different `kind`, so `rotation` and a real,
non-zero `size` height both work exactly as they do on one.

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

## Materials

`material` / `end` (`src/bzfs/CustomMaterial.cxx`, `src/bzfs/ParseMaterial.cxx`)
is a named bundle of a texture and a tint, registered once and then pulled
into a `box` or a `pyramid` by name -- `matref <name>` -- instead of
restating `addtexture`/`diffuse` on every obstacle that wants the same look.
`maps/bzo.bzw` carries a labelled example next to the passability row: a
`caution-amber` material and a box that `matref`s it.

```
material
  name caution-amber
  addtexture caution
  diffuse 1.0 0.62745 0.12549
end

box
  name matref
  ...
  matref caution-amber
end
```

A material's own fields:

| keyword | effect |
|---|---|
| `name <string>` | what a `matref` line looks it up by, case-insensitively |
| `addtexture <name>`, `texture <name>` | the texture -- see below |
| `notextures` | clears a texture set earlier in the same block |
| `color <r g b [a]>`, `diffuse <r g b [a]>` | the tint, read exactly as a plain obstacle's own (see **Colour**, above) |
| `noradar` | the obstacle is left off the radar entirely |
| `nolighting` | the face is drawn unlit -- its texture and tint at full brightness, untouched by the renderer's own lighting |
| `matref <name>` | copies another already-defined material wholesale, which a line stated after it then overrides |
| `dyncol <name>` | replaces the material's own tint outright with a named `dynamicColor`'s live RGBA -- see **Animated materials**, below |
| `texmat <name>` | a named `textureMatrix`'s live UV transform, layered on top of whatever UVs the texture already carries -- see **Animated materials**, below |
| `specular <r g b [a]>`, `shininess <n>`, `emission <r g b [a]>` | a highlight on the face, and a self-lit tint -- see **Lighting**, below |
| `ambient <r g b [a]>` | read and dropped -- see **Lighting**, below for why |

**A `matref` may also name a material by number instead of by name**, upstream's
own alternative for a `material` block that gave no `name` line at all --
`BzMaterial::findMaterial` (`src/game/BzMaterial.cxx:75-86`) checks whether the
target's first character is a digit *before* it ever tries a name match, and if
so reads it as a plain index into the file's materials, in the order they were
defined -- `matref 0` is the first `material` block in the file, named or not.
bzo reads it the same way, against every material in file order regardless of
whether it gave a `name`: real maps lean on this, most heavily
`import-bz4.rikers.org_5154.bzw`, whose 18 materials are all but one unnamed
and referenced purely as `matref 0` through `matref 17`. This does not
replicate upstream's own dedup on add (`BzMaterialManager::addMaterial` reuses
an existing entry, rather than appending a new one, for a block that matches
one already registered on every field upstream tracks) -- doing that against
only the fields bzo itself keeps would collapse two materials upstream still
tells apart by a field bzo drops (a multi-layer `addtexture`, most notably; see
below), which shifts every later index enough to break that same map's own
highest `matref`s -- checked directly against `import-bz4.rikers.org_5154.bzw`'s
own materials, so bzo indexes in plain file order instead.

A `matref` on an obstacle takes the same face selector a plain `color`/
`diffuse` line does -- bare, or `top`/`bottom`/`sides`/`outside`/an axis
name, resolved down to bzo's own walls/caps split (see **Colour**). Whatever
the referenced material set -- texture, tint, `noradar`, `nolighting` -- lands
on the face group named, and a property line stated *after* the `matref` on
the same obstacle overrides it, the same sequential read as everything else
here. `addtexture`/`texture` and `noradar`/`nolighting` are also read
directly on an obstacle with no material block at all, the same as `color`/
`diffuse` already are.

**`addtexture` and `texture` are not the same keyword upstream, even though
bzo draws the same slot either one does.** Upstream's own `BzMaterial::
addTexture` (`BzMaterial.cxx:812`) always grows the material's own texture
list by one slot; `setTexture` (`:833`) replaces the *last* slot instead, or
creates the first one if the list is still empty. Every stock obstacle
already starts with one texture from its own constructor (a plain `mesh`'s
own `"mesh"`, a `box`'s own `"boxwall"`/`"roof"`, and so on), so the two
keywords produce a genuinely different material there: `addtexture` leaves
two texture layers, `texture` one. That would be academic if anything drew
the second layer, but nothing does -- every renderer that reads a material
(`OpenGLUtils.cxx`, `MeshSceneNode.cxx`, `MeshSceneNodeGenerator.cxx`,
`BackgroundRenderer.cxx`) asks for slot 0 alone, with no exception anywhere
in the tree, so a stacked second or third `addtexture` is inert in real
play: only the first texture a material ever names is the one a client
draws. bzo has no multi-texture model, but keeps to that same slot -- an
`addtexture` once a texture is already set is the no-op it is upstream too,
`notextures` clears the slot so the next `addtexture` counts as the first
again, and a `texture` line always takes effect, matching `setTexture`
always replacing whatever the single slot bzo tracks already holds. This is
why `maps/bzo.bzw`'s own mesh fixtures write `texture` rather than
`addtexture`: on a plain `mesh` block, `addtexture` leaves the stock
`"mesh"` texture as the visible first slot, so the shape would keep showing
that wireframe default against a real bzfs/bzflag -- and now against bzo
too -- instead of the fixture's own texture. A *fresh* `material` block has
no constructor default to begin with, so `addtexture` there is already the
first (and only) texture either way.

**A second layer was clearly meant to be a decal, not a repeating tile.**
`BzMaterial.h`'s own `CombineModes` enum (`replace`, `modulate`, `decal`,
`blend`, `add`, `combine`) names the classic OpenGL `glTexEnv` modes for
stacking texture units, and `addTexture` (`BzMaterial.cxx:825`) sets every
layer it creates to `decal` by default -- paint the new texture over the
base wherever it is opaque, let the base show through wherever it is
transparent, which is exactly a non-repeating graffiti sticker on a plain
wall rather than a second tiling pattern. No `.bzw` keyword ever lets a
mapper choose a different mode, and no code past `addTexture` itself reads
`combineMode` at all -- confirmed by grepping the whole upstream tree for a
second bound texture unit (`glActiveTexture`, `GL_TEXTURE1`): nothing binds
one anywhere. The field is stored, and even round-trips over the network
and through "Save World," but the classic renderer never draws it. This
reads as a shelved feature rather than a working one -- worth bzo
implementing for real once the format's still-missing pieces above and in
`docs/bzw-plan.md` are caught up, since doing the actual decal blend would
put bzo ahead of what a live upstream client shows today, not behind it.

**A texture name is one of bzo's own local assets, or an absolute URL.**
Upstream names a texture either by its own stock name (`boxwall`, `wall`,
`roof`, `pyrwall`, `telelink`, `caution`) or by a mapper-hosted file, and bzo
reads both:

- A stock name bzo also ships a picture for (six of upstream's) resolves to
  that local asset -- see `resolveBzwStockTexture` in `server.js`, and
  `STOCK_MATERIAL_TEXTURE_FILES` in `public/texture.js`, which must name the
  same set. A stock name outside that set (`mesh`, upstream's own
  wireframe/grid texture, most notably: a mapper who means "textureless
  grid" is naming a completely different thing than bzo's own mesh
  *geometry*) is logged on load and the obstacle's own type keeps its plain
  default texture instead.
- An absolute `http`/`https` URL -- the only kind of external texture any
  real map sampled actually used (docs/bzw-plan.md's "Evidence from real
  maps") -- is recognized by the server (`parseBzwTextureUrl`) and forwarded
  to every client, **never fetched by the server itself.** `http://` is the
  one to actually write: confirmed directly against a real client that
  upstream's own texture downloader (`Downloads.cxx`) reliably follows
  `http://` but not `https://` -- the same URL, scheme swapped, failed to
  load and silently kept the obstacle's own plain default texture instead
  (no error either side; it just never arrives). `maps/bzo.bzw`'s own
  `thin_wall` names its external texture this way now, on
  `images.bzflag.org`.

  A browser is the opposite: an `https://` page (bz.rikers.org, most
  notably) refuses to load a plain `http://` resource at all (mixed-content
  blocking), which is exactly what forwarding a mapper's `http://` line
  as-is to bzo's own clients would trip. So the server does not forward it
  as-is -- `parseBzwTextureUrl` strips the scheme down to a protocol-relative
  `//host/path` before it ever reaches a client, and each one resolves that
  against its own `window.location.href`, the way a protocol-relative
  `<img src>` already would in any browser. A mapper never has to choose
  between the two: write `http://` for upstream, and bzo silently makes it
  work for its own browsers too.

  A protocol-relative URL (`//host/path`, no scheme at all) written
  *directly* in the file is also recognized, and skips the stripping step
  since there is nothing left to strip -- but it has no equivalent for real
  upstream at all: `bzflag`'s own `BzfNetwork::parseURL` scans for a
  leading `:` before it does anything else, so a string with no scheme
  fails to parse before curl is ever involved, unlike a scheme it can at
  least attempt and fail quietly the way `https://` does. Reserve this
  spelling for a map that only bzo will ever load; a mapper-facing `.bzw`
  should write `http://` and let the server do the rest.

  **Every host is attempted, deliberately unlike upstream.** Upstream trusts
  one host by default (`DownloadAccess.txt`'s shipped
  `allow *images.bzflag.org` / `deny *`, `Downloads.cxx:37-59`) and leaves
  widening that allowlist to the *player's* own local config file -- a real
  per-viewer decision upstream's own client supports. bzo has no equivalent
  of that file (a browser has none, and there is no server-side stand-in for
  one either), and whoever picked the host -- an operator running the
  source server a map was imported from, or a mapper hand-writing a `.bzw`
  -- has no channel to tell bzo "trust this one too": a fixed allowlist here
  would just be bzo guessing on their behalf, backwards from what an
  allowlist is for. `isExternalTextureUrlLoadable` in `public/texture.js`
  therefore only checks that the URL parses and names `http`/`https`; see
  "Intentional deviations from BZFlag" in `AGENTS.md`. Anyone who wants a
  picture blocked can already do that on their own end -- an ad blocker, a
  browser's own site permissions -- the same as with any other third-party
  image on the web.

  Attempted is not the same as loaded: a texture load is tagged
  `crossOrigin` (required for any WebGL texture, not only a cross-origin
  one), which means the request carries a real `Origin` header and the
  *response* must carry a matching `Access-Control-Allow-Origin` or the
  browser refuses the load outright, the same as any other CORS-gated
  resource -- there is no plain-image fallback the way an ordinary `<img>`
  tag gets. Checked directly (several paths, across several mappers'
  subdirectories): `images.bzflag.org` sends `Access-Control-Allow-Origin: *`
  on every response, so a texture named from there loads for real rather
  than falling back; a host that never expected a cross-origin `<canvas>`
  to read its pixels back may well refuse. Either way -- a malformed
  URL/scheme, or a well-formed one whose own response still refuses the
  load -- the obstacle falls back to its type's plain default texture,
  logged once to the console for the second case
  (`loadExternalTexture`/`STOCK_MATERIAL_TEXTURE_FILES` in
  `public/texture.js`) rather than left blank; the first is silent, since a
  malformed line is a mapper's own typo rather than a remote host's
  behavior worth a runtime warning.

  **A texture that actually has transparency gets it, real maps do use
  this.** A survey of every texture referenced by the public server list's
  own live maps found 39 distinct pictures with genuine, non-uniform alpha
  in active use -- trees, shrubs, chainlink and barbwire fences, cutout
  signage -- none of bzo's own stock assets among them (all six are opaque
  by construction), and 42 more with an alpha channel present but every
  pixel opaque, an export artifact rather than real transparency. Once a
  texture's image decodes, `detectImageAlpha` in `public/texture.js` scans
  it for any pixel that is not fully opaque -- the same test upstream's own
  `OpenGLTexture::getBestFormat` runs (`OpenGLTexture.cxx:336-351`) to set
  `imageInfo.alpha`, which `MeshSceneNode::updateMaterial`
  (`MeshSceneNode.cxx:401-406`) reads to decide whether a face needs
  blending at all -- and only then does the material carrying it turn on
  ordinary alpha blending (Three's `transparent`), the modern equivalent of
  upstream's own always-available `BZDBCache::blend` path (there is no
  hardware left that needs its stipple fallback). A texture proven opaque
  costs nothing extra; `maps/bzo.bzw`'s own `mesh_billboard` names a real
  map's shrub texture for exactly this reason, so the path has a fixture to
  check itself against beyond a server survey.

### Animated materials: `dynamicColor` and `textureMatrix`

Two named, time-varying blocks a `material`'s own `dyncol <name>`/
`texmat <name>` line pulls in -- `src/bzfs/CustomDynamicColor.cxx`,
`src/game/DynamicColor.cxx` and `src/bzfs/CustomTextureMatrix.cxx`,
`src/game/TextureMatrix.cxx`. Both resolve by name the same digit-first-then-
name way `matref` does (`DynamicColor.cxx:80-101`,
`TextureMatrix.cxx:73-94`), collected into their own registry the same way a
`material` or a `physics` block is. Real usage is well evidenced --
`ahs3_Ironside_Battlefield.bzw`, `dw_missilewar3.bzw`, and
`import-Planet-MoFo.com_4202.bzw` (all under `maps/`) use both, for a
teleporter's glow, scrolling stripe and pillar textures, and a cycling
multi-frame billboard sign.

`dynamicColor` / `end` -- one block per named colour, up to four channel
lines (`red`/`green`/`blue`/`alpha`), each of which can carry any number of:

| line | effect |
|---|---|
| `limits <min> <max>` | this channel's own low/high value (defaults 0/1) |
| `sinusoid <period> <offset> <weight>` | a cosine wave blending toward `limits`' high end |
| `clampup <period> <offset> <width>` | forces the channel to its high end for `width` seconds out of every `period` |
| `clampdown <period> <offset> <width>` | the same, forced to the low end instead |
| `sequence <period> <offset> <ints...>` | a round-robin list, each slot `0` (low), `1` (leave to any sinusoid), or `2` (high) -- overrides every clamp/sinusoid above it for as long as it is active |

Every frame, a channel's value is `low*(1-factor) + high*factor`: `factor` is
`0`/`1`/`0.5` while a clamp (or a sequence slot) forces it, otherwise the sum
of every `sinusoid`'s own `weight * cos(phase * 2π)`, centred and clamped
into `[0, 1]` (`DynamicColor::update`, `DynamicColor.cxx:371-463`) -- ported
in `public/render.js`'s `evaluateDynamicColor`. `dyncol` on a material
**replaces its whole diffuse tint outright**, every frame
(`MeshSceneNode.cxx:487-491`), not a multiply against a static `color`/
`diffuse` line stated alongside it -- and every material naming the same
`dynamicColor` animates in exact lockstep, upstream's own shared-pointer
semantics, not a separate instance per material.

`textureMatrix` / `end` -- one block per named UV transform, `fixedshift
<u> <v>`/`fixedscale <u> <v>`/`fixedspin <degrees>`/`fixedcenter <u> <v>`
baked once (a `0` on `fixedscale` leaves the axis at its prior value, never
zeroing it), and `shift <uFreq> <vFreq>`/`spin <freq>`/
`scale <uFreq> <vFreq> <uScale> <vScale>`/`center <u> <v>` re-evaluated every
frame (a `scale` below `1.0` is ignored the same way). `texmat` on a material
layers this on top of whatever UVs the geometry already carries -- a real
texture-matrix transform (`OpenGLGState.cxx:536-544`,
`TextureMatrix::update`, `TextureMatrix.cxx:405-444`), not a change to the
texture's own tiling -- ported as `applyTextureMatrix` in `public/render.js`.

**A box/pyramid's own wall or cap animates too, one assumption narrower than
a mesh face.** `_getSharedObstacleMaterials` in `public/render.js` reads
`wallDynamicColor`/`capDynamicColor`/`wallTextureMatrix`/`capTextureMatrix`
the same way `_buildMeshObject` reads a mesh face's own -- `maps/bzo.bzw`'s
own `PD_Conveyor`/`PD_Death` pads are the real fixture for this side of it,
a scrolling stripe and a colour-cycling beacon on two plain boxes, the same
mechanism the three maps above validate on a mesh face. The one thing this
path does not yet handle is a slot carrying **both** a static `wallColor`/
`capColor` *and* a `dyncol` at once -- `dyncol` is assumed to be the only
tint that slot's shared material ever needs, since every obstacle sampled so
far states one or the other, never both. A future map that does state both
needs `_getSharedObstacleMaterials`/`_addObstacleFragment` taught to skip
baking a vertex tint for a dyncol'd slot specifically, rather than the
whole-box `vertexColors` flag it is today.

### Lighting: `specular`, `shininess`, `emission`, and `ambient`

`BzMaterial`'s own four Blinn-Phong coefficients (`BzMaterial::reset`
defaults: ambient `0.2 0.2 0.2 1`, specular/emission `0 0 0 1`, shininess
`0`). Three of them reach real GL state upstream: `MeshSceneNode.cxx:463-465`
feeds a face's `specular`/`emission`/`shininess` straight into an
`OpenGLMaterial`, which sets `GL_SPECULAR`/`GL_EMISSION`/`GL_SHININESS`
(`OpenGLMaterial.cxx:115-117`) -- and switches on an accurate, view-dependent
specular term (`GL_LIGHT_MODEL_LOCAL_VIEWER`) whenever a material's specular
is non-black (`:118-131`). bzo mirrors this: a face with real specular
(any of its red/green/blue above zero) becomes a `THREE.MeshPhongMaterial`
with that `specular`/`shininess`, and `emission` becomes `emissive` on
whichever material class the face ends up with (`MeshLambertMaterial` has an
`emissive` slot too, so a merely-emissive, non-specular face costs nothing
extra). A face with no real specular stays `MeshLambertMaterial`, visually
identical to a `MeshPhongMaterial` whose own specular is black but cheaper to
draw -- `hasRealSpecular`/`pickLitMaterialClass` in `public/render.js`.

**`ambient` is read and dropped, deliberately.** It is the fourth of
`BzMaterial`'s own coefficients, but it never reaches a `glMaterial` call
anywhere in the whole upstream tree -- confirmed by grep -- so a mapper's own
`ambient` line does nothing in a real bzflag client either.
`BzMaterial.cxx:652`'s own comment on the field says as much ("not really
used"), and its `printMTL` export even writes it out as an OBJ *comment*
(`#Ka`) rather than a real `Ka` line. bzo matches that by not applying it,
the same as any other property this section reads but does not act on --
not a parity gap to report.

Not yet read:

- **`texsize`/`texoffset`**, so a `matref`'d or `addtexture`'d picture always
  tiles at whatever UV density its obstacle type's own default already bakes
  in (8 units per tile on a box's or a pyramid's walls, 2 on a box's caps --
  see **Colour** and `_prepareBoxGeometry`) rather than at a size or an offset
  the map may have asked for.
- **`alphathresh`.** Read, and used as the material's alpha test the way
  upstream does (`MeshSceneNode.cxx:525`). See **Alpha threshold** below for
  what happens when a map states none.
- **`shader`/`addshader`/`noshaders`, `noculling`, `nosorting`, `occluder`,
  `groupAlpha`, `spheremap`, `notexalpha`, `notexcolor`, `resetmat`.** Read
  and dropped -- not yet implemented rather than deliberately declined. Each
  is counted as it is dropped and named in the server log and in the map's
  own `-srvmsg` lines, so a map says which of them it asked for. Two are
  worth singling out, because bzo does not merely ignore them:

  - `notexalpha` asks for a texture's alpha channel to be ignored. bzo turns
    blending on for any texture with real alpha (see **Texture alpha**), so a
    map stating this gets the opposite of what it asked for.
  - `noculling` asks for a surface to be drawn from both sides. bzo uses
    `DoubleSide` in a number of places, but each is bzo's own decision about
    a particular feature; a map cannot ask for it.
- **`noshadow`.** Read and kept on the material (see **Materials**), but
  nothing yet skips building a caster's projected shadow for one that asks
  for none -- every solid obstacle casts one regardless.

### Alpha threshold

Upstream runs an alpha test only where a material states `alphathresh`:
`BzMaterial::reset` defaults it to 0 and `MeshSceneNode.cxx:525` reads 0 as
"no alpha test at all" rather than as a threshold of zero. A map that states
one gets exactly that value here.

**Where a map states none, bzo does not match upstream, on purpose.** A
texture with real transparency gets an alpha test of 0.05 anyway. Without it a
foliage cutout's fully transparent pixels still write depth and block whatever
is behind them -- which is a visible fault, not a stylistic difference, and
was blocking teleporter effects through the gaps in a shrub before this
existed. 0.05 is low enough to catch only the pixels upstream's own default
would have drawn as fully invisible regardless.

That difference is a map's to close, not bzo's: a material carrying a
transparent texture and no `alphathresh` renders one way here and another way
upstream, and only the map can say which it meant. So bzo says so, once per
texture, as a `[DBG]` line to the server -- naming the texture and the default
it fell back to. `maps/bzo.bzw`'s own billboard bush is in exactly this state
and reports itself.

Two real textures explain why the fallback is 0.05 and not something higher:
a telelink overlay at a uniform 80% alpha and a glass texture at a uniform
20%, both from live maps, both of which have to keep blending and keep
occluding normally. A 0.5 threshold would send a uniform-alpha texture
entirely one way or the other -- vanished or solid.

## Teleporters and links

A `teleporter` is a box with a `border`, and its two faces are named
`<name>:f` and `<name>:b`. A teleporter that gives neither takes upstream's
defaults from the `CustomGate` constructor -- half width `0.5 * _teleportWidth`,
half breadth `_teleportBreadth`, height `2 * _teleportHeight`, and a border of
twice the half width, so `0.56 / 4.48 / 20.16 / 1.12` -- which is what
`maps/bzo.bzw` relies on and every other map in `maps/` spells out:

```
teleporter
	position     x     y     0.0
	rotation     deg
	size         0.56  4.48  20.16
	border       1.12
end
```

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

```
link
	from ne_tele_low:f
	to ne_tele_high:b
end
```

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
| `-time <seconds>` | the match clock; not upstream's `h:mm:ss` clock-time form |
| `-timemanual` | the clock above waits for `/countdown` instead of starting on its own |
| `-mps <score>` | ends the match when any player's wins minus losses reaches it |
| `-mts <score>` | ends the match when any colour team's wins minus losses reaches it |
| `-ms <count>` | how many shots a tank may have in the air at once |
| `-s <count>`, `+s <count>` | how many superflag slots the world holds |
| `-f <abbrev\|good\|bad>` | take a flag type, or a whole quality, out of the pool |
| `-set _maxFlagGrabs <n>` | how many pickups a superflag survives |
| `-set _wingsJumpCount <n>` | how many times `WG` Wings may flap before it needs the ground again |
| `-set _maxBumpHeight <n>` | how high a step a tank may climb without jumping |
| `-set _rainType <rain\|snow\|fatrain\|frog\|particle\|bubble>` | turns on weather -- see **Weather** |
| `-srvmsg <text>` | a line the world says to each player as they join |
| `-admsg <text>` | a line said to everyone already playing, repeated every 15 minutes |
| `-gndtex <name>` | the ground's texture -- a stock name or an external URL, same as any other `texture` line; a map can equally get the same effect with an explicit `material name GroundMaterial ... end` block |

## Ground texture

Two ways to the same effect: `-gndtex <name>` in the options table above, or
an explicit top-level `material name GroundMaterial ... end` block. Both
register a material named `GroundMaterial`, and upstream's
`BackgroundRenderer::setupGroundMaterials` (`BackgroundRenderer.cxx:265-303`)
looks it up by that exact name to texture the ground plane and tint it from
the material's own `diffuse`/`color` -- the same lookup bzo's own
`parseBZWMap` performs (against `materialsByName`, case-insensitively) to
build the `groundMaterial` that `render.js`'s `buildGround` textures the
plane from. A map that gives neither keeps the `std_ground` checkerboard
every other map already gets.

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

**A zero-height *box* still needs a real bzfs to agree it is one shape, not
six degenerate ones.** `CustomBox::read` (`isOldBox`) takes bzo's own fast,
always-valid path only while a box states nothing beyond
`position`/`size`/`rotation`/passability -- a face selector, `phydrv`, or any
material property at all (a bare `color` included) switches it to the general
path every other transformed obstacle takes, which builds the box as eight
explicit corners. At `size w d 0` the four "top" corners land exactly on the
four "bottom" ones, so all four side faces collapse to zero area -- real bzfs
drops each one with an "invalid mesh face" warning and keeps going (harmless:
the top/bottom faces are still four *distinct* corners each, so the pad still
draws flat and still collides the way this section describes; only its
invisible vertical edge is what is missing). `maps/bzo.bzw`'s four
team-coloured spawn pads hit exactly this -- `color` plus `size ... 0` -- and
carry `size ... 0.01` instead for that reason: visually flush, but a real
plane for upstream to build a side face from, so the map loads silently on a
real `bzfs` as well as on bzo's own.

A pad is still drawn, and still labelled by the debug labels: the passability
flags are read only by the collision code, never by the renderer. That is what
makes a pad useful for marking ground -- `maps/bzo.bzw` puts a named one under
every flag zone, so `L_Laser` and friends label the whole ring.

A map option only ever turns a switch **on**, which is how a bzfs switch behaves:
nothing in a map turns off something the server config enabled.

The options that carry a *value* rather than flip a switch are the exception,
and they differ from each other. `-st`, `-sw`, `-time`, `-mps` and `-mts` take
the larger of the map's number and the config's, because every one of them is
a switch that happens to be spelled with a number. `-ms` **replaces** the
config's `shotMaxActive` outright: upstream reads
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

`-admsg` accumulates and splits the same way `-srvmsg` does, but is said to
everyone already on the server on a repeating 15-minute timer
(`bzfs.cxx:7555-7591`) rather than once to a player as they join. Upstream also
takes a file-backed multi-line form (`textChunker`, the same mechanism
`-helpmsg` uses); bzo has only the inline-text form.

**Not read: `-helpmsg`.** Upstream itself refuses this one from a world file --
`checkFromWorldFile` (`CmdLineOptions.cxx:337-344`) rejects `-helpmsg` (and a
handful of others) the moment it sees one written in a map rather than typed on
the server's own command line, because its argument is a **path on the
server's filesystem** that the option then reads and serves back over `/help
<name>`. A map is not command-line-typed trust upstream is willing to extend a
file read to, and bzo's map is even less trusted than upstream's: every option
here arrives through a map's `options` block, and a map is not only something
an operator hand-wrote -- `server/remote-world-import.cjs` reconstructs one
from whatever a live BZFlag server on the internet answered, minutes before
bzo ever reads its `options` block. Reading a mapper-named path off local disk
on the strength of that would be worse than upstream, not merely behind it, so
this stays unread on purpose rather than pending.

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

```
world
	size        400.0
	flagHeight  10.0
end
```

(`size` is the half width -- see **Coordinates**, above -- and `flagHeight` is
one of the three more fields below; a bare `name` line is neither upstream's
nor bzo's, and is read and dropped like any other unhandled token.)

## World fields

Three more `world`-block fields, next to `size` -- `CustomWorld.cxx:41-49`:

| BZW | effect |
|---|---|
| `flagHeight <n>` | the ceiling `hasFlagClearance` searches under for a flag to spawn |
| `noWalls` | the world border is not built at all |
| `freeCtfSpawns` | a colour team spawns in any of its `team` zones every life, not only the first and the ones after a capture |

`flagHeight` replaces upstream's `_flagHeight` (default 10), which is not the
altitude a flag spawns *at* -- that is still a random point up to the tallest
obstacle's top, `getMaxObstacleTopY` -- but the clearance above wherever it
lands that has to be clear of any obstacle before the spot is accepted.
`size w d 0`'s own rule applies: 0 is a real value here too, and turns the
clearance search off rather than being read as "unset".

`noWalls` removes the border everywhere it is built -- the server's and the
client's own collision copy, and the visible boundary walls -- so a tank or a
shot can cross the edge of the map in either direction, in every direction at
once. Nothing else about the map changes: the mountains ringing the horizon are
a distant backdrop keyed to `size` alone, on both sides of this project, and
draw exactly as they would with a border in place. `maps/noWalls.bzw` is the
small preview map for this, one marker box on each side where the wall would
otherwise have stood.

`freeCtfSpawns` only changes anything for a colour team that also has a
`base`: `getSpawnPosition`'s base-priority branch (`restartOnBase`, set on join
and after a capture -- see **Team zones** below) is skipped entirely while this
is set, so every death asks a `team` zone or the map-wide random search
instead, the same path rogue and a base-less colour team always take. Upstream
never clears `restartOnBase` while the switch is on either, since the branch
that would clear it is the one being skipped.

## Water

`waterLevel` / `end` (`src/bzfs/CustomWaterLevel.cxx`) -- one flat plane, the
whole width of the world, at a fixed height. A `world`-block-adjacent, map-wide
singleton like `noWalls` above rather than an obstacle: it takes no `name`,
`position`, or `size` of its own, since a map has at most one.

| keyword | effect |
|---|---|
| `height <n>` | the plane's altitude -- bzo's own vertical axis directly, no sign flip |
| `matref <name>`, `color`/`diffuse`, `addtexture`/`texture`, `noradar`, `nolighting`, `dyncol`, `texmat` | the surface's own material, read exactly as a plain obstacle's (see **Materials**) |

Upstream's own words for the gameplay half of it (the porteighty BZW docs
page): "Any tanks that move below this height will be destroyed." bzo reads
this the same way `WorldInfo::getWaterLevel()`'s two upstream callers do --
`playing.cxx:4196`/`:4851`'s `(waterLevel > 0.0f) && (position[2] <= waterLevel)`
kills the tank (`WaterDeath`, "fell in the water" to everyone else, "Tank
Rusted" to the tank itself -- `blowedUpMessage[WaterDeath]`, upstream's own
joke about why it blew up) -- and `validateMovement` checks it on every move,
regardless of anti-cheat mode, the same "map's own gameplay rule, not a cheat
detection" treatment a `death` physics driver already gets. `height > 0` is
upstream's own guard too: a `waterLevel 0` plane sits exactly on the ground
every tank already stands on, so without it the plane would kill on arrival.

**A material with no lines of its own still isn't bare.**
`WorldInfo::makeWaterMaterial` seeds a default -- the `water` stock texture,
tinted, and left off the radar -- if the map's `waterLevel` block names no
material at all, and bzo seeds the same default up front rather than lazily.
bzo has no alpha channel on a plain `color`/`diffuse` line to carry upstream's
own 0.9 default alpha (see **Colour**), so translucency is water's own fixed
property in `render.js` instead of something a tint line can override.

**The surface scrolls, by default.** `WorldInfo::makeWaterMaterial` also seeds
a texture matrix (`texmat->setDynamicShift(0.05f, 0.0f)`) alongside the tint,
a steady drift along U with no motion on V -- the same continuous
`fmod(t * shiftU, 1.0)` cycle `applyTextureMatrix` in `render.js` already
drives for a mapper's own `texmat`. bzo seeds this default the same way it
seeds the texture and the tint, so a bare `waterLevel` block scrolls without a
mapper asking; a `texmat <name>` line on the block replaces it with a
different animation, the same override any other default material property
here takes.

**Nothing about collision changes.** A tank or a shot passes through the
plane exactly as it passes through air -- the kill above is a position check
on every move, not a surface anything bounces off or stops at.

**The plane can be seen through, from above or below**, unlike upstream's own
single-sided, depth-writing quad -- a deliberate keep rather than an unnoticed
side effect of `DoubleSide`/`depthWrite: false` in `render.js`'s `buildWater`.
See "Intentional deviations from BZFlag" in `AGENTS.md`.

## Weather

`-set _rainType <preset>` (`src/bzflag/WeatherRenderer.cxx`) -- the generic
`-set` mechanism above, not a block of its own, the same as `_maxFlagGrabs`.
Nothing shows unless a map names one of upstream's six presets: `rain`,
`snow`, `fatrain`, `frog`, `particle`, `bubble`. `maps/weather.bzw` names
`rain` and puts a small roofed shelter over the origin to preview the roof
culling below; view it through Map Viewer (`?viewmap=weather.bzw`) -- purely a
client render, so no live match is needed.

Every drop falls (or, for `bubble`, rises) from high above the map, resets
when it reaches the ground or a roof, and -- for the presets that carry
puddles -- leaves a splash there that grows and fades over
`_rainMaxPuddleTime`. Upstream reads a dozen more `_rain*` variables to tune
one of these presets; bzo reads the ones that still mean something once one
rendering path replaces upstream's three (see below):

| `-set` variable | tunes |
|---|---|
| `_rainDensity <n>` | how many drops are ever in the air at once |
| `_rainSpread <n>` | how far from the map's centre a drop may fall |
| `_rainSpeed <n>`, `_rainSpeedMod <n>` | fall speed, and how much it varies drop to drop |
| `_rainStartZ <n>`, `_rainEndZ <n>` | the top and bottom of the fall |
| `_rainTexture <name>`, `_rainPuddleTexture <name>` | either stock texture, overriding the preset's own |
| `_useRainPuddles <0\|1>` | puddles on or off, overriding the preset's own |
| `_rainMaxPuddleTime <n>`, `_rainPuddleSpeed <n>` | how long a puddle lasts, and how fast it grows |
| `_rainSpins <0\|1>` | whether a drop tumbles as it falls |
| `_rainRoofs <0\|1\|2>` | `0` lets rain fall through a roof to the ground beneath; `1` (upstream's default) stops it at the first roof; `2` also puddles the roof itself |

`_rainBaseColor` and `_rainTopColor` are read by nothing here: both tint
upstream's `GL_LINES` streak alone, and that rendering path does not exist on
bzo -- see below. `_useLineRain`, `_useRainBillboards` and `userRainScale` are
the same kind of absence for a different reason: "**Implement the
highest-quality option upstream has for a given effect, and ship no setting
for it**" (`AGENTS.md`) means bzo already draws the best-looking variant of
each preset and has nothing for these to switch between. `_rainSize` is left
to the preset alone -- a map wanting one particular drop size is better served
naming its own `_rainTexture` on a preset already close to the size it wants.

**One rendering path carries every preset**, rather than upstream's three:
`doLineRain`'s `GL_LINES` streak (`rain` upstream, replaced here by the same
textured cross the other falling presets use, sized on its own since a
textured quad has no upstream-supplied width to inherit from a zero-width
line), a camera-facing billboard (`frog`, `particle`, `bubble`), and a
non-billboard "cross" of three quads 120 degrees apart that need not face the
camera at all (`snow`, `fatrain`, and now `rain`). `render.js`'s
`WEATHER_PRESETS` is the table of which preset gets which texture, speed,
size, and puddle colour, each a comment's citation away from the
`WeatherRenderer::set()` branch it came from.

**Roof culling is a downward raycast against the same obstacles a shot
collides with**, not upstream's own octree (`RoofTops::getTopHeight`) --
`findShotSegmentImpact` from the `collision` pair, re-used rather than ported,
skipping teleporters exactly as upstream's own comment says to ("the physics
for teles is whacked"). Asked once per drop, when it starts a new fall, not
every frame.

**A map with water needs real ground above the waterline for every team that
plays it.** Upstream forces `-fb` on unasked the moment a map's `waterLevel`
is above zero (`bzfs.cxx:1217-1223`, "WARNING: enabling flag and tank spawns on
buildings due to waterLevel"), and clamps the floor of its own random spawn
and flag searches to the waterline (`RandomSpawnPolicy.cxx:93-96`,
`SpawnPolicy.cxx:116-119`) rather than climbing to a real surface -- bzo does
both, in `FLAGS_ON_BUILDINGS` and in `dropSpawnPosition`/
`findValidSpawnPosition`/`findFlagLandingY`. That clamp is a floor, not a
guarantee: a team with no `zone` or `base` above the waterline still lands the
plain random search exactly on the water's own surface, which is the death
line itself (`<=`, both here and upstream), and dies on arrival. `maps/water.bzw`
is the preview map for this, and its own `spawn_zone` names every team
(`team 0 1 2 3 4`) for exactly this reason.

**A flag dropped over open water never rests in it either.**
`findFlagLandingY` returns `null` rather than the waterline itself when
nothing above the waterline qualifies as a landing -- upstream's own
`DropGeometry::dropIt` (`bzfs.cxx`) returns `false` from the same case, the
signal both a team flag's and a superflag's drop act on. A superflag
(`dropFlag` in `server.js`) vanishes instead of landing, the same as when its
last grab is spent. A team flag never vanishes, so it works down upstream's
own chain instead (`WorldInfo::getFlagDropPoint`, `bzfs.cxx:3792-3814`): the
nearest zone naming this team's `safety` (see **Flag safety zones**, below),
else the map centre -- re-dropped against the real geometry there rather than
assumed to be bare ground, since a water map's centre may itself be a
platform -- else the team's own base outright, which needs no test at all: a
base is always a real, already-placed landing. A `safety` zone is a
convenience this chain takes first, not a requirement the map has to supply;
without one, a drop over open water still resolves through the centre or the
base.

## Team zones

A `zone` block's `team <n> [n ...]` marks it a spawn area for BZFlag team
index `n` -- 0 rogue, 1-4 red/green/blue/purple -- and bzo reads it. A zone
may list more than one team, on one line or split across repeats; both
accumulate onto the same zone, the way upstream's own qualifier list does
(`CustomZone.cxx:188-215`).

A team zone is a fallback, and `restartOnBase` decides how often it is asked
for rather than a base's mere existence deciding it. `getSpawnPosition` only
takes the base branch when `restartOnBase` is set, which upstream does on a
join and after a capture (`bzfs.cxx:4006`) and nowhere else -- an ordinary
death, whoever or whatever caused it, leaves it `false` (`bzfs.cxx:3370`, the
unset default `respawnOnBase` every plain kill passes). So a colour team's
first life, and its first life after each capture, spawns on its `base`; every
death in between -- self-destruct, an enemy's shot, even a teammate's -- asks
the zone instead, exactly as it always has for rogue, which can never own a
base at all. Where more than one zone names the same team, one is picked
uniformly at random, the same simplification `getRandomTeamBase` already
makes among a team's bases rather than upstream's area-weighted pick
(`EntryZones::getZonePoint`). The point inside it is dropped onto whatever the
zone actually sits on (`dropSpawnPosition`), the same way a `testSpawn` is,
retrying inside the same zone a couple of dozen times before giving up to the
map-wide random search -- `findFlagSpawnPosition`'s own re-roll, for the same
reason: one crowded or awkward point is not a reason to leave the zone.

`bzo.bzw`'s centre zone carries `team 0`, so rogue spawns there rather than
the plain random search its absent base would otherwise fall to. Each of the
four colour bases also has a small `team`-zoned pad a few units beyond it,
tinted that team's colour the way a flag's pad is tinted the flag's -- so a
red tank's first life, and its first life after a capture, spawns on
`n_red_base`, and every other death spawns on `n_red_spawn` instead, and the
same for the other three.

### Flag safety zones

A zone's `safety <n> [n ...]` accumulates onto the same zone exactly as `team`
does -- upstream reads both in one shared branch of `CustomZone::read`
(`CustomZone.cxx:184-206`) -- but it answers a different question: not where a
team spawns, but where a **team flag lands when it is dropped somewhere
unsafe**. A team flag may never come to rest on an opposing team's base
(anyone grabbing it there would carry it straight into enemy territory and
blow up their own team on the spot), and upstream works down a chain when that
happens: the closest `safety` zone for the flag's team, then the world centre,
then the team's own base as a last resort. bzo's `dropFlag` follows the same
chain, and `getSafetyZonePosition` is the same proximity pick as upstream's
`EntryZones::getClosePoint` -- the nearest matching zone to where the flag
actually came down, not a random one among every match the way a spawn zone
is. `bzo.bzw`'s four team-spawn pads each carry their own team's `safety` too,
so a flag dropped on an enemy base returns to its own team's pad rather than
the map centre.

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

## Groups

`define <name>` / `enddef` collects a template of `box`/`pyramid`/`base`
blocks under a name instead of placing them; `group <name>` places a
transformed copy of that template. `CustomGroup.cxx`, `GroupDefinition`
(`ObstacleMgr.cxx`).

A `group` instance is parsed like any other obstacle -- `name`, `position`,
`rotation` and the four passability keywords all mean what they do on a box --
except `size`, which is a scale factor (`1 1 1` leaves every member at its own
size) rather than a half-extent. Placing an instance composes scale, then
rotation, then position, the same order upstream's `MeshTransform` does, and
applies that to a clone of every obstacle the named `define` holds.

`shift`/`scale`/`spin` are `WorldFileLocation`'s own, more general names for
that same triple -- `position`/`size`/`rotation` are `CustomGroup`'s shorthand
for composing exactly one of each, in that order, and a real map may spell an
instance's placement either way (`ahs3_Ironside_Battlefield.bzw`'s `table`/
`table-complete`/`fence` groups all use `shift`/`spin` rather than `position`/
`rotation`). bzo reads `shift` as `position`'s exact equivalent on **any**
obstacle, group or not -- a pure translation never distorts a shape, so the
two spellings are the same operation, not an approximation of each other.
`scale` is read the same as `size`, but only inside a `group`: a plain box or
pyramid's own `size` already means its literal half-extent rather than a
multiplier, and there is no local evidence yet of a map naming a box's own
extent through `scale` instead to say what that should do.

`spin <deg> <ax> <ay> <az>` is read as `rotation <deg>`'s equivalent, again on
any obstacle, but only when its axis is the map's own vertical (`0 0 1` or
`0 0 -1`, the latter negating the angle) -- a spin about any other axis tips
the shape out of bzo's axis-aligned box/pyramid model, the same as `shear`
always does, so it is counted for the load to name instead
(`ahs3_INCOMING.bzw`'s "3way" groups spin 90° about `1 0 0`, and are named
this way on that map's load -- moot in practice today, since "3way" is itself
a `mesh` define with nothing to place yet).

A `define` may itself hold `group` instances of other definitions, and bzo
recurses into them the way `GroupDefinition::makeGroups` does -- a definition
that names itself again while still being placed, directly or through others,
is the one case that stops rather than recursing forever, logged once as
"avoided recursion" the way upstream's own `active` guard does. Ordinary
nesting, and the same definition placed from two unrelated places, are both
just more obstacles.

A member with no `name` of its own is given one for its position in the
`define`, the same way an unnamed top-level obstacle is named for its position
in the file. Either way, the finished name is prefixed with the instance it
came from -- the `group` line's own `name` if it gave one, otherwise
`<definition>#<n>` counting earlier instances of the same definition *within
that one enclosing definition*, so a nested definition placed from two
different parents starts back at `#0` under each. Nesting composes the prefix
the same way: an unnamed box two levels deep in `bzo.bzw`'s example reads
`table-complete#0:table#0:B0`. `maps/bzo.bzw` carries a two-instance example
of its own.

`drivethrough`/`shootthrough`/`ricochet` on the `group` line add permission to
whatever a member already has rather than replacing it, and apply to a member
of any type. `matref`/`addtexture` and `phydrv` are read too, but neither
follows that same only-if-unset shape, and neither touches a plain box or
pyramid member at all -- both are mesh-only upstream
(`ObstacleModifier::execute`, `ObstacleModifier.cxx:179-223`), and opposite
rules from each other on a mesh's own faces: a `matref`/`addtexture` line
*replaces* every face's material outright, unconditionally, while `phydrv`
only ever touches a face that *already* names some driver -- a face with none
stays driver-less under a moving group. See **Physics drivers** and
**Materials** above for what a mapper can rely on from each.

A `teleporter` in a `define` is placed the same way any other member is --
named `t<n>` for its place in the definition if it gave no name of its own,
the same default a plain top-level teleporter gets, then instance-prefixed
like everything else. It only becomes a real, linkable face once an instance
actually places it, which is also where upstream draws the line: a `link`
block is never itself scoped inside a `define` (`CustomLink::usesGroupDef` is
`false`), so it cannot know which instance it means. A `link` naming an
endpoint by its bare, unprefixed name only ever matches a plain top-level
teleporter -- to reach one or more instances of a defined one, write the
`link` at the map's own top level with a glob pattern (`*` and `?`) against
the instance-prefixed name each one actually gets, the same wildcard matching
upstream's own `LinkManager::findTelesByName` does, and the same mechanism
bzo already had for any other teleporter link. A real map may already rely on
this: `ahs3_Ironside_Battlefield.bzw`'s own links use patterns like `topf:*`.

Not yet read:

- `shear`, on a plain obstacle or inside a `group` block -- it has no
  representation in bzo's axis-aligned box/pyramid model at all, unlike
  `shift`/`scale`/`spin` above.
- A named `transform` block (`xform <name>`, referencing one built from
  `shift`/`scale`/`shear`/`spin` lines) and the `xform <name>` line that
  references one from inside a `group` block or a plain obstacle.
- `scale` stated directly on a plain box or pyramid (no `group` involved),
  rather than inside a `group` block -- see **Groups** above for why this one
  differs from `shift`/`spin`, which are read either way.

## Mesh and its primitives

`mesh` is parsed, textured, placed through `group` instances, debug-labelled,
radar-drawn, and collided with (a tank and a shot both stop at a mesh face,
per face-level `drivethrough`/`shootthrough`, a tank slides off one the same
way it slides off a box corner, and the oriented tank box is its own precise
case rather than a circle standing in for it) -- see **Groups** above.

- `angvel <degrees/sec>` -- a continuous spin, upstream's own `MeshDrawInfo`
  render-optimization animation (`angvel`, inside a `drawInfo { ... }`
  sub-block bzo does not otherwise read -- see "What is ignored" below and
  #87). Since upstream itself gives a hand-authored spin no pivot of its own
  (it turns about world origin unless placed through a `group`, in which case
  it turns about wherever that instance's own local origin landed), bzo reads
  it as a plain mesh-level property rather than modelling the unused
  `drawInfo` grammar around it, and pivots the same way: about the mesh's own
  local (0,0,0), placed by however many `group` instances (if any) it took to
  reach the world. Purely visual -- a spinning mesh's faces (upstream: any
  drawInfo-optimized one, always) collide and block shots exactly as if they
  never moved.

All six primitives that expand to a mesh upstream are read too:

- **`tetra`** parses its four vertices and per-face materials, corrects the
  vertex winding the same way upstream's own `TetraBuilding::checkVertexOrder`
  does, and builds a real four-face mesh.
- **`cone`/`meshpyr`** and **`arc`/`meshbox`** are each upstream's own same
  generator built two ways (`CustomCone.cxx`, `CustomArc.cxx` --
  `meshpyr`/`meshbox` just built with `pyramid=true`/`box=true`) -- position,
  size, a `divisions`-sided sweep (`angle`, defaulting to a full 360 degrees),
  per-face materials, `texsize`, `smoothbounce`/`flatshading`, and each one's
  own further difference: a `meshpyr`'s `flipz`; an `arc`'s own `ratio` (1,
  the default, collapses its inner radius to zero, an ordinary solid wedge or
  disc; anything less is a genuinely hollow tube, with its own `inside`
  wall).
- **`sphere`** (`CustomSphere.cxx`/`SphereObstacle.cxx`) -- `radius` (setting
  all three axes of `size` at once, for a true sphere rather than an
  ellipsoid), `divisions`, `hemisphere`/`hemi` (a dome, closed by a flat
  `bottom` disc rather than a matching lower half), and the same
  `texsize`/`smoothbounce`/`flatshading`/materials (`edge`, `bottom`) as the
  others. Defaults to `position 0 0 10` rather than the origin, so a mapper
  who never states one still gets a radius-10 sphere resting on the ground.

All four build a real explicit-texcoord (and, unless `flatshading`/a
`meshpyr`'s own default says otherwise, smooth-normal) mesh, matching
upstream's own wrap-around texturing rather than falling back to bzo's
per-face auto-planar UV. See `docs/bzw-plan.md`'s "Mesh geometry" for what is
still left on the mesh side generally (mainly a perf pass merging
same-material triangles).

## Physics drivers

`physics` / `end` (`CustomPhysicsDriver.cxx`, `PhysicsDriver.cxx`) defines a
named driver, which `phydrv <name>` then references directly from a `box`,
a `pyramid`, or a `mesh` face (its own per-face property, the way a face's
own `matref` is). A `group` instance's own `phydrv` line reaches a mesh
member's faces too, but not as an override a member can leave unset: it
replaces the driver on whichever faces already name *some* driver, and
leaves a face with none alone -- see **Groups**, and it never touches a
plain box or pyramid member regardless of whether that member set its own.

- `name <string>` -- what `phydrv` looks it up by, or its file-order index
  the same digit-first way a numberless `material` resolves a numeric
  `matref` (see **Materials**).
- `linear <x> <y> <z>` -- a velocity added to a tank resting on a surface
  naming this driver: the vertical component always, the horizontal only
  while the tank is on the ground -- upstream's own split between a plain
  push and its `slide` variant, below. A jump pad, a conveyor belt and an
  elevator are all this, in different directions. "Resting on" means
  actually solid -- upstream only ever assigns a driver from a surface a
  tank was expelled by (`LocalPlayer.cxx:617-624`, `:771-780`), so a
  `drivethrough` face never supplies one, mesh included.
- `death <message>` -- kills a tank outright instead of pushing it, showing
  the rest of the line verbatim as the reason, the same `killed` message
  a self-destruct or a run-over already sends. Unlike `linear`, this one
  reaches a `drivethrough` face too: upstream checks it a different way
  (`LocalPlayer::getHitBuilding`/`collectInsideBuildings`,
  LocalPlayer.cxx:927-937, 986-992), against any face the tank's box
  currently overlaps, before ever asking whether that face blocks anything.

Not yet read: `angular` (a rotation rate about a point, adding both a spin
and an orbital velocity) and `slide` (removes friction instead of pushing,
so a tank drifts toward its own desired heading rather than snapping to it).
Neither is exercised by a real map sampled yet -- see `docs/bzw-plan.md`,
"Physics drivers". `radial` is parsed by upstream itself and never applied
by any of its own renderers either -- no client code anywhere reads
`PhysicsDriver::getRadialVel`/`getRadialPos` -- so bzo treats it the same
way, permanently rather than provisionally.

## What is ignored

Anything not listed above is skipped, which means a map using it loads and
plays with that part of it missing. None of it is declined on purpose: each is
something bzo does not do *yet*, and where upstream's behaviour is known, the
intent is to match it and to say here where bzo deliberately does not.

Not skipped silently, though. Every keyword and every server option a map
states that no part of bzo reads is counted as it is dropped, named in the
server log, and written into the map's own `-srvmsg` lines so a player sees
what the map asked for and did not get. `scripts/survey-live-maps.mjs` imports
live maps through a running bzo and reports what that bzo said, rather than
holding an opinion of its own about what is supported.

The notable absences:

- **`texsize`/`texoffset` on a `material` block or a `matref`.** See
  **Materials** above for what a material *does* read now (`addtexture`/
  `texture` against bzo's own stock assets, `color`/`diffuse`, `noradar`,
  `nolighting`, `dyncol`/`texmat`, and -- see **Lighting** there --
  `specular`/`shininess`/`emission`; `ambient` is read but never applied,
  matching upstream's own dead field).
- **`shear`, `xform`, and a `spin` about anything but the vertical axis.**
  `shift`, `scale` and a vertical `spin` are read now -- see **Groups**
  above, and its "Not yet read" list for what of this line is left.
- **A `zone` block's `flag` keyword.** `zoneflag`, `team` and `safety` are all
  read -- see **Team zones** and **Flag safety zones** above. `flag` names a
  type any flag of which spawns in the zone; a map using it is named in the
  load log rather than skipped silently, because a spawn zone that is ignored
  moves every tank in the world.
- **Every `-set` variable but `_maxFlagGrabs`, `_wingsJumpCount`,
  `_maxBumpHeight`, and the `_rain*` family.** bzo's world constants are
  constants, and these are the ones it already keeps a configurable copy of;
  see `docs/flags.md` and **Weather** above. A map that sets another is named
  on load.

A map that needs any of these is not rejected -- it is worth knowing that it
loaded rather than that it loaded *correctly*.
