# World viewer and editor

Plan for inspecting a world (issue #183) and editing one in the browser (issue
#184). Nothing here is built.

## What already exists

- **Map Viewer** (issue #68). `?viewmap=` converts any listed map in the
  background (`prepareMapForView` in `server.js`), caches the world JSON under
  its hash, and draws it without touching the live game. The viewer joins as an
  Observer on the wire.
- **Roaming views and the phantom tank.** Free roam, tracking, and
  `ROAM_VIEW.DRIVE_FP`/`DRIVE_TP`, cycled with `C`, the Settings Camera row and
  the XR Camera row. The phantom tank drives with the real local simulation.
- **The compiler.** `server/bzw-parse.cjs` keeps each object's `name` and
  `definedIn`. A group instance's members are named `instance:member`; an
  unnamed instance is labelled `define#N`, so nested groups compose into a
  path.
- **Identity.** A forum login yields a verified BZID (`server/sessions.cjs`).
  An `adminWhitelist` op has none.
- **Voice channels.** `voice-channels.mjs` decides on the server who hears whom.
- **nodemon** does not watch `maps/`, so writing a map does not restart the
  server.

## Order of work

1. Source spans in the parser.
2. The viewer (#183).
3. User map folders: upload, download, view, activate.
4. The editor (#184), saving on demand.
5. The shared edit room, then live edits.

## Source spans

The parser records where each object came from: file, byte range and line
range of its block. Both the viewer and the editor need it. It is fetched on
demand, never added to the world JSON, which already reaches 74 MB on the
largest map.

## Viewer (#183)

- Pick an object with the roaming camera, or a pointer ray in XR.
- Panel: type, name, group path, source line, position, size, rotation,
  drivethrough and shootthrough, material, textures, physics driver.
- World summary: counts by type, face counts, materials, missing textures, the
  largest meshes.
- Values are shown as written in the BZW. bzo uses BZFlag's coordinate frame
  (#182), so nothing is converted.

## User maps

- `maps/<bzid>/<name>.bzw`, one folder per forum BZID. Map keys become
  `<bzid>/<name>.bzw`, with path checks so `..` or a forged BZID cannot leave
  the folder. Not in git, like `maps/import-*.bzw`.
- Upload and download. A size quota and a filename allow-list.
- Anyone may view the current map and every user map.
- The owner edits their own maps. An op may edit any; a forum-login op starts
  in their own folder, an `adminWhitelist` op has no folder and cannot create
  maps.
- **Activate** (op only) copies the map to `maps/<name>.bzw` and leaves the
  user's copy editable. It never overwrites a map bzo ships, and asks before
  overwriting one already activated.
- Every save produces a new hash; older cached JSON for the same user file is
  pruned.
- The upload page says user maps are the uploader's own content; the AGPL
  compatibility rule applies to maps bzo ships.

## Editor (#184)

### Edit is a view

Edit joins free roam, tracking, and phantom first- and third-person driving in
the `C` cycle. The editor drives the map, then cycles back to Edit with the
selection intact. Edit adds a free camera with selection, gizmos and panels;
the other views behave as they do in Map Viewer.

### Editing

- Client side: selection, move/rotate/resize gizmos, snap-to-grid, undo, a raw
  text panel for the selected block. While dragging, only the edited object is
  rebuilt locally.
- First version edits box, pyramid, base, teleporter and link. Meshes, arcs,
  cones, spheres and tetras are view-only.
- **Save** writes the file and the server recompiles it in the background, as
  Map Viewer does. The client loads the new world when the compile is done. The
  server does not restart.
- Saving rewrites only the edited blocks, by their source span. Everything else
  stays byte-for-byte.
- A save is refused if the file changed since it was loaded.

### Names lead back to the source

- An object is found by name. An unnamed object gets a generated name, written
  into the file only when that object is edited.
- Names in BZW need not be unique. An ambiguous name falls back to type and
  position in the file.
- Teleporter links match names with wildcards (`globMatch` in
  `bzw-parse.cjs`). A generated teleporter name must match no existing link
  pattern, or links would re-wire silently.

### Groups

- Objects inside a `define` are edited in the definition, which changes every
  instance. The editor warns when the define has more than one instance.
- An instance edits only what belongs to it: shift, scale, spin, shear, and
  its overrides (tint, team, phydrv, matref, drivethrough, shootthrough).
- A member selected in a placed instance is read-only there and offers "edit
  definition".

## Edit room

One room for each map being edited, held inside the existing connection. Not a
new session type.

- **One writer.** The lock goes to a connection with a BZID that owns the map
  or is an op. It is released on disconnect. The owner can hand it over; an op
  can take it.
- **Watchers.** Everyone else viewing that map. At first they reload on each
  save, through the Map Viewer path. Later the writer's edits go out as small
  changes (object and new fields) that each client applies the same way; the
  file still changes only on save.
- **Chat and voice** scoped to the room: a "same map" voice channel, and text
  chat with the same scope.
- **Follow the editor**: a watcher button that tracks the writer's camera.
- Editors and watchers are Observers in the game, as Map Viewer is, so they
  count against the observer limit and show on the scoreboard.

No multi-writer editing. Merging simultaneous edits is not worth its cost.

## Other editors to borrow from

- [WebBZEdit](https://github.com/allejo/WebBZEdit): MIT, three.js with React.
  Same stack, so code can be reused. Box, pyramid, base, teleporter and link,
  zone, mesh faces, materials, world options. No group or mesh editing, no
  undo.
- [BZMapMaker](https://github.com/ahsthree/BZMapMaker): LGPL-2.1, Python and
  Qt. Direct 3D editing with a 2D view, 2-, 3- and 4-team symmetry, undo, snap,
  and byte-for-byte mesh round-trip. Ideas, not code.
- [BZWorkbench](https://github.com/BZFlag-Dev/bzworkbench): LGPL-2.1, C++,
  inactive since 2011. The widest object coverage; a checklist.
- [webbzw](https://github.com/BZFlagCommunity/webbzw),
  [bzw-viewer](https://github.com/cs8425/bzw-viewer) and the
  [bz-next map viewer](https://bz-next.github.io/mapviewer3/mapviewer.html):
  text with a 3D preview, or viewing only.

None of them supports XR.
