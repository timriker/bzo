# Server plugins -- plan

Issue #195. What is left of server plugins in JavaScript; what is built is in
`docs/plugins.md`. Upstream references are paths under `$HOME/bzflag/`.

## Why these

`include/bzfsAPI.h` defines 55 events and about 270 `bz_*` functions. The tree
ships 37 plugins under `plugins/`; outside it, allejo's are the best known:
LeagueOverseer (the core of Leagues United servers), mapchange,
neutralzones, flagresetoncap, ScoreRestorer and ctfOverseer.

The BZDB variables bzo ignores on `/list` show which plugins public servers
run. The largest groups are custom-weapon variables (`_grapeshot*`,
`_torpedo*`, `_grenade*`, on 14–16 servers), then a team-war mode (`_tw*`), a
genocide variant (`_geno*`) and a translator (`_tr*`), about 12 servers each.
The groups at 12 may all be one operator's servers.

## Left to do

- **ScoreRestorer.** `_scoreSaveTime` is still in the core (`server.js`): it
  keeps scores across a restart and gives a returning bot its old slot,
  which the plugin API cannot do yet. Move it out as allejo's ScoreRestorer,
  on, once it can.
- **Changing bzo's own world.** `bz_eGetWorldEvent` for bzo's world only says
  what it is, since the map is parsed before plugins load. Load plugins
  first, as upstream does; then a plugin could name another file, add
  objects, or build the world itself with `bz_addWorldBox`, `Pyramid`,
  `Base`, `Teleporter`, `Weapon`, `WaterLevel` and `bz_setWorldSize`.
  Upstream's take only drive-through and shoot-through and make no meshes.
- **The map loader's warning.** A plugin's custom map object is still
  reported as an ignored block when the map loads.
- **The packet events.** `bz_eNetDataSendEvent` and
  `bz_eNetDataReceiveEvent` are registrable but never fire. Offer them
  read-only, costing nothing unless a plugin registers, carrying
  BZFlag-shaped messages whichever client sent them, since bzo's own clients
  and native ones do not share a wire format. No plugin in upstream's tree
  uses them.
- **A hidden bundled plugin in the panel.** An installed copy hiding a newer
  bundled one is logged; the Plugins panel should say so too.
- **Groups.** Permissions are admin-or-not. Upstream's groups file, which
  would hand them out finer, waits.
- **The handicap events** wait for handicap (`docs/game-modes-plan.md`).

## Behind the proxy, not yet run

Read in upstream's source but not yet run through `npm run
test:proxy-plugins`:

- **Team and admin chat** (koth, keepaway, timedctf, fairCTF) keeps its
  destination both ways.
- **A refused capture or theft** (ctfOverseer, thiefControl) is refused the
  same way a grab is.
- **A held spawn** (`bz_eAllowSpawn`): the browser asks once after each death
  and the target holds it, as bzfs does for any client.
