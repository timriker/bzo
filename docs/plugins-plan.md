# Server plugins -- plan

Issue #195. Server-side plugins written in JavaScript, with at least the hooks
bzfs gives its plugins. Upstream references are paths under `$HOME/bzflag/`.

## What upstream has

`include/bzfsAPI.h` defines 55 events (`bz_e*Event`) and about 270 `bz_*`
functions, implemented in `src/bzfs/bzfsAPI.cxx`. A plugin is a shared library
that bzfs loads with `-loadplugin` or `/loadplugin`. It registers for events,
custom slash commands, custom map objects and custom flags. `/listplugins`
shows what is loaded.

The tree ships 37 plugins under `plugins/`. Outside the tree, allejo's are the
best known: LeagueOverseer (the core of Leagues United servers), mapchange,
neutralzones, flagresetoncap, ScoreRestorer and ctfOverseer.

The BZDB variables bzo ignores on `/list` show which plugins public servers
run. The largest groups are custom-weapon variables (`_grapeshot*`,
`_torpedo*`, `_grenade*`, on 14–16 servers), then a team-war mode (`_tw*`), a
genocide variant (`_geno*`) and a translator (`_tr*`), about 12 servers each.
The groups at 12 may all be one operator's servers.

## Shape

- **JavaScript only.** A C++ plugin cannot load into node, so plugins are
  ported, not run as they are.
- **Upstream's names.** Events and their data carry the names and fields of
  `bz_*EventData`, and the API calls keep their `bz_` meanings, so porting a
  C++ plugin is mechanical. This follows bzo's rule of matching upstream's
  shapes rather than translating at the edges.
- **In-process.** Plugins load with `require` and are trusted as bzfs trusts
  a `.so`. A worker thread, as `server/bot-worker.cjs` uses, cannot answer the
  synchronous events: AllowCTFCapture, GetPlayerSpawnPos, SlashCommand and the
  chat filters all need a reply before the server goes on.
- **Cheap per tick.** The tick event and per-update events must cost nothing
  when no plugin registered for them.
- **Two directories.** bzo's own plugins are in `plugins/`, which an upgrade
  replaces. Plugins an operator installs are in `plugins/` beside
  `server.json` (`PLUGINS_PATH`): `data/plugins` in a checkout,
  `/data/plugins` in Docker, which an upgrade keeps. An installed plugin wins
  over a bundled one of the same name, and the log says so, since that
  bundled plugin's upgrades then never load.
- **One file each.** A plugin is a `.cjs` file. It exports `meta` and
  upstream's `Init`, `Event` and `Cleanup`; `Init` gets the API as `bz` and
  calls `bz.Register`, as a C++ plugin calls `Register`. The header of
  `server/plugins.cjs` has an example.
- **Configured in `server.json`.** `"plugins"` maps a plugin's file name to
  `false` (off) or an object of its options. Every plugin found is on unless
  turned off, so bzo's own are on by default.
- **Proxied games are out of scope.** A game bzo proxies runs on the target
  server, which runs its own plugins.
- **Both client kinds.** Whatever a plugin does must reach native BZFlag
  clients as well as bzo's.

## The Plugins panel

A section of the Operator panel (`docs/operator-panel-plan.md`) that lists
every installed plugin, bundled or uploaded. Built so far: a row per plugin
with its name, version, what it does, its author and license, or why it
failed, and a switch staged behind Apply. A switch is live, as `/loadplugin`
is, and is written to `server.json` as `"plugins": { "<id>": true|false }`,
keeping any options there. The list goes to admins after they join, as the
admin roster does, since `init` goes out before `isAdmin` can say yes. Still
to come:

- **What it is.** Name, version, author, description and license, from a
  `meta` object every plugin exports. A plugin without one does not load.
- **On or off.** Each plugin has an enable switch, staged behind the panel's
  Apply button like every other row and saved to `server.json`. Turning one off
  calls its unload hook, as `/unloadplugin` does upstream; a plugin that
  registered a custom flag or custom map object can only change on a restart,
  which the panel says.
- **Its options.** A plugin declares its options in `meta` (name, type,
  default, a line of help), and the panel shows them as rows. Plugins that keep
  their settings in BZDB variables show those instead.
- **Its state.** Loaded, off, or failed with the error. A plugin that throws
  while loading is left off and the server keeps running.
- **Upload.** An admin uploads a plugin file the same way as a map, into
  `data/plugins`, so the panel may delete it again; a bundled plugin can
  only be turned off. An upload that replaces a plugin of the same name shows
  both versions before Apply, and an installed copy hiding a newer bundled one
  says so.

bzo ships its own plugins, and admins may install more.

**An uploaded plugin is code running as the server.** Anyone who passes
`isAdmin` can then do anything the server's user can. That is the same trust
bzfs gives `/loadplugin`, but bzo's admins are bzflag.org groups, not a
local file, so the rights are wider than an upstream operator expects:

- `"pluginUpload"` in `server.json` turns upload on or off; installing a
  plugin by copying it into `plugins/` always works.
- Each upload is logged with the admin's callsign and the file's hash.
- The panel says plainly, beside the upload button, that a plugin runs with
  the server's full rights.

## Translations

A plugin carries its own: an `l10n` object, `{ locale: { msgid: msgstr } }`,
for the messages it sends with `bz_sendTextMessage(from, to, msgid, params)`.
While it is loaded the server merges them into the catalog a bzo client is
sent (`/l10n/<locale>.json` and the page's inlined copy), under bzo's own, so
a plugin adds translations but never changes one bzo already has. Unloaded,
it adds nothing, and bzo's `l10n/bzo_<locale>.po` holds only the core's
strings. A native BZFlag client reads English either way.

Every bundled plugin works this way, so each is an example of it. Strings in
a JavaScript object miss gettext's merging and fuzzy matching; a script that
round-trips one plugin's strings through a `.po` waits until someone
translates one.

## Built-ins that move to plugins

Features bzo built in that are plugins elsewhere, or are optional extras that
fit one. Each moves out and keeps its BZDB variables. Turning the plugin on or
off is the switch, so a plugin is never loaded and idle: one whose behaviour
was on in bzo ships on, one that was off ships off, and when on it does what
its upstream does by default.

- `_scoreSaveTime`: allejo's ScoreRestorer, on. Still in the core: it keeps
  scores across a restart and gives a returning bot its old slot, which the
  plugin API cannot do yet.
- `_disallowSelfCap` and `_delayTeamFlagGrab`: allejo's ctfOverseer,
  `plugins/ctfOverseer.cjs`. Off, as both were; on, 1 and 20 as allejo's.
- The Discord bridge (`docs/discord.md`): the job upstream's ircRelay plugin
  does, and the shape Matrix and IRC in `docs/chat-bridge-plan.md` would take.
- The compass letters for native clients; see "The world and the network".

Rabbit, polls and handicap are core upstream and stay core in bzo.

## Custom flags and weapons

The BZFlag client has no plugins, so upstream builds custom weapons entirely on
the server:

- **The flag.** `bz_RegisterCustomFlag` sends each client `MsgFlagType` with
  the abbreviation, name, help text and quality. The header says there is no
  shot type support in 2.4, so the flag fires an ordinary shot; the client only
  learns its name.
- **The effect.** The plugin listens for shot fired, shot ended or player
  died, and calls `bz_fireServerShot` with a stock shot type (`SW`, `GM`, `L`
  ...) from the server player. Clients draw it as that stock shot.
  `plugins/shockwaveDeath` and `plugins/wwzones` work this way.

bzo already fires server shots for a map's `weapon` blocks, so
`bz_fireServerShot` reuses that path. bzo's client draws every stock shot,
XR included, so custom weapons need no new client effect. What is new:

- the bzo client accepts a custom flag type and shows its abbreviation and
  help;
- native clients get `MsgFlagType` when they join;
- nothing for kill credit. Upstream's server shots kill as `ServerPlayer`
  (`playerKilled`, `src/bzfs/bzfs.cxx:3345`): no player scores, and the victim
  reads "Killed by the server", as from bzo's world weapons now. A plugin that
  wants its player credited scores them itself.

## The world and the network

**The world.** `bz_eGetWorldEvent` (`src/bzfs/bzfs.cxx:1119`) runs before the
world loads. A plugin may name a different map file, set the game type, or
say it built the world itself with `bz_addWorldBox`, `Pyramid`, `Base`,
`Teleporter`, `Weapon`, `WaterLevel` and `bz_setWorldSize`. Those only work
before the world is finished, take only drive-through and shoot-through as
options, and make no meshes. The event's `worldBlob` is declared but bzfs
never reads it. pushstats uses the event to learn the map; map rotation
plugins such as mapchange need it to pick the next one.

bzo offers the same event at every map load, with the parsed world rather
than a file name, so a plugin can add or change objects of any kind before a
client sees them. Because bzo sends a native BZFlag client its own world
(`server/bzflag-extras.cjs`), the event says which world it is building, and a
plugin can add to one only. The compass letters bzo adds for native clients
become a bundled plugin this way, on by default.

**HTTP.** Upstream's `bz_registerNonPlayerConnectionHandler` and
`bz_sendNonPlayerData` hand a plugin raw TCP connections on the game port;
upstream's whole plugin web layer (`src/bzfs/bzfsHTTPAPI.cxx`) is built on
them. bzo is already a web server, so a plugin registers HTTP routes under its
own path instead, for a stats page or a league's endpoint. Raw connections are
not offered.

**Packets.** `bz_eNetDataSendEvent` and `bz_eNetDataReceiveEvent` fire for every
packet in or out with a copy of its bytes, read-only; no plugin in the tree
uses them. bzo offers them read-only, costing nothing unless a plugin
registers, carrying BZFlag-shaped messages whichever client sent them, since
bzo's own clients and native ones do not share a wire format.

## Stages

1. **Core.** The loader and its `server.json` list, about 20 events and about
   60 API calls: join, part, spawn, die, kill, flag grab, drop, capture and
   transfer, chat, slash commands, tick, timers and BZDB. Hook points include
   `grabFlag`, `dropFlag`, `captureFlag` and `killPlayer` in `server.js`.
   Prove it by moving ScoreRestorer and ctfOverseer out, and porting
   rabbitTimer, teamflagreset, autoFlagReset and killall. Done but for
   ScoreRestorer; each bundled plugin is off until `server.json` names it,
   with its options there in place of upstream's `-loadplugin` string. The
   Plugins panel lists them with their `meta` and switches them on and off.
   `/listplugins`,
   `/loadplugin <name>[,<options as JSON>]` and `/unloadplugin <name|number>`
   are upstream's, admins only, and last until a restart; a client is told
   again what a plugin changes for it -- its commands, its translations, its
   BZDB defaults.
2. **Rules and custom flags.** Custom map objects and zones are done:
   `bz_registerCustomMapObject` hands a plugin each block of its object from
   the live map's text, since bzo reads the map before plugins load, and
   `bz.bz_CustomZoneObject` is upstream's box-or-cylinder zone. Upstream fires
   no zone entry or exit events itself; a zone plugin tests positions on
   `bz_ePlayerUpdateEvent`, which is sent for every accepted move while one
   listens. flagStay is ported. The map loader still reports a plugin's block
   as ignored. Server shots are done: `bz_fireServerShot` fires through the
   path a map's world weapons use, after upstream's
   `bz_eAllowServerShotFiredEvent`; shockwaveDeath and wwzones are ported on
   it, wwzones on the map objects and zones above as well. A guided server
   shot steers at the target it was fired with, its own rather than a
   shooter's lock, and a native client is told the target in the MsgGMUpdate
   that follows, as bzfs tells it. Custom flags are done:
   `bz_RegisterCustomFlag` adds a type with a name and help that bzo clients
   are sent and a native client learns in reply to its flag negotiation, as
   bzfs answers it; its shots are ordinary, as 2.4's are, and a map's
   `zoneflag` of it, skipped when flags are laid out at boot, joins the world
   once the plugin registers it. `bz_eShotFiredEvent` and the score calls are
   what a plugin builds one with; customflagsample is ported.
   `bz_eRawChatMessageEvent` may rewrite or drop a line before anything else
   is asked of it, `bz_eGetPlayerSpawnPosEvent` may move a spawn, and
   `bz_eFlagTransferredEvent` may let a Thief's steal go on, cancel it, or
   spend the thief's flag alone. Left: the remaining allow events (a spawn,
   a player's join), polls and permissions, the world event and the
   `bz_addWorld*` calls, and plugin HTTP routes. Port koth, keepaway,
   HoldTheFlag, timedctf, fairCTF, chathistory, TimeLimit and mapchange, and
   move the compass letters out.
3. **Plugin options and upload** in the panel.
4. **The Discord bridge** moves to a plugin once stage 1's chat events carry
   what it needs.
5. **The packet events.**

The handicap events wait for handicap (`docs/game-modes-plan.md`).
