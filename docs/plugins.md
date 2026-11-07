# Server plugins

Server-side plugins in JavaScript, with bzfs's plugin API (issue #195).
Upstream references are paths under `$HOME/bzflag/`: the API is
`include/bzfsAPI.h`, implemented in `src/bzfs/bzfsAPI.cxx`. What is not built
yet is in `docs/plugins-plan.md`.

## Shape

- **JavaScript only.** A C++ plugin cannot load into node, so plugins are
  ported, not run as they are.
- **Upstream's names.** Events and their data carry the names and fields of
  `bz_*EventData`, and the API calls keep their `bz_` meanings, so porting a
  C++ plugin is mechanical.
- **In-process.** Plugins load with `require` and are trusted as bzfs trusts
  a `.so`. A worker thread could not answer the synchronous events:
  AllowCTFCapture, GetPlayerSpawnPos, SlashCommand and the chat filters all
  need a reply before the server goes on. A plugin that throws is logged and
  the server carries on; one that throws while loading is left off.
- **Cheap per tick.** The tick event and per-update events cost nothing while
  no plugin is registered for them.
- **Both client kinds.** What a plugin does reaches native BZFlag clients as
  well as bzo's.
- **Proxied games run no plugins here.** A game bzo proxies runs on the
  target server, which runs its own; see "Behind the proxy".

## A plugin

One `.cjs` file. It exports `meta` and upstream's `Init`, `Event` and
`Cleanup`; `Init` gets the API as `bz` and calls `bz.Register`, as a C++
plugin calls `Register`:

```js
module.exports = {
  meta: { name, version, author, description, license },
  Init(bz, config) { bz.Register(bz.bz_ePlayerJoinEvent); },
  Event(data) { if (data.eventType === 'bz_ePlayerJoinEvent') ... },
  Cleanup() {},
  l10n: { de: { 'Hello, {player}': 'Hallo, {player}' } },
};
```

`meta` needs `name`, `version`, `author` and `description`; a file without
them, or without `Init`, does not load. `config` is the plugin's options from
`server.json`, an object where upstream passes the `-loadplugin` string.
`plugins/sample.cjs`, upstream's SAMPLE_PLUGIN, is the starting point.

`meta.options`, `[{ name, type, default, help }]`, describes those options
for the Plugins panel. A type is `boolean`, `number` (with `min`, `max` and
`step`), `choice` (with `values`) or `string` (with `maxLength`).

Each plugin gets its own `bz`, so what it registers -- events, commands,
timers, BZDB variables, poll types, map objects, web pages -- goes when it
is unloaded. A flag type it registered stays until the server restarts.

## Where plugins live

bzo's own are in `plugins/`, which an upgrade replaces. Plugins an operator
installs are in `plugins/` beside `server.json` (`PLUGINS_PATH`):
`data/plugins` in a checkout, `/data/plugins` in Docker, which an upgrade
keeps. An installed plugin wins over a bundled one of the same name, and the
log says so, since that bundled plugin's upgrades then never load.

## Turning them on

`server.json`'s `"plugins"` maps a plugin's file name to `true`, `false` or
an object of its options (on unless its `enabled` is false). A plugin it
does not name is off, bundled or installed: a file on disk is not a request
to run it, and an installed one that is off is not even read, since reading
a module runs it. `example-server.json` turns `compassletters` on, for
BZFlag players.

`/listplugins`, `/loadplugin <name>[,<options as JSON>]` and
`/unloadplugin <name|number>` are upstream's, admins only, and last until a
restart. A client is told again what a plugin changes for it: its commands,
its translations, its BZDB defaults.

## The Plugins panel

A section of the Operator panel lists every installed plugin, bundled or
uploaded: its name, version, description, author and license, or why it
failed, and a switch staged behind Apply. A switch is live, as `/loadplugin`
is, and is written to `server.json` as `"plugins": { "<id>": true|false }`,
keeping any options there. The list goes to admins after they join, as the
admin roster does, since `init` goes out before `isAdmin` can say yes.

A plugin's `meta.options` are rows beneath its switch -- a checkbox, slider
or list a headset steps through, or a text field it reaches by its virtual
keyboard -- each labelled by its help and staged behind Apply. Apply writes
it into the plugin's object in `server.json` and starts a running plugin
again with it, as upstream takes options only at `-loadplugin`. Only admins
are sent option values.

A running plugin's BZDB variables, such as ctfOverseer's, are rows too, by
their own names: a bool a checkbox and anything else a text field, since a
value may be an expression. Apply sets one as `/set` does and keeps it in
`server.json`'s `bzdb` block.

### Upload

Where `"pluginUpload": true` is in `server.json`, an admin uploads a `.cjs`
into `data/plugins` from the panel. It is off unless set; copying a file into
`data/plugins` always works.

**An uploaded plugin is code running as the server.** Anyone who passes
`isAdmin` can then do anything the server's user can. That is the trust bzfs
gives `/loadplugin`, but bzo's admins are bzflag.org groups, not a local
file, so the rights are wider than an upstream operator expects. The panel
says so beside the upload button (`docs/installation.md`).

The upload is logged with the admin's callsign and its SHA-256, written off
in `server.json` before the file lands, and listed for an admin to switch
on. An upload of a plugin already there replaces its file and keeps its
switch, and the panel names both versions; Delete takes an upload back, and
a bundled plugin it hid comes back. Either may be a running plugin's file:
the copy already loaded runs until the next restart.

## Events

`bz.Register` takes any of upstream's `bz_eEventType` names. These fire:

- Players: `bz_ePlayerJoinEvent`, `bz_ePlayerPartEvent`,
  `bz_eAllowPlayer` (after the bans), `bz_ePlayerSpawnEvent`,
  `bz_eAllowSpawn`, `bz_eGetPlayerSpawnPosEvent`, `bz_ePlayerDieEvent`,
  `bz_ePlayerPausedEvent`, `bz_ePlayerUpdateEvent` (every accepted move,
  while one listens).
- Flags: `bz_eAllowFlagGrab`, `bz_eFlagGrabbedEvent`,
  `bz_eFlagDroppedEvent`, `bz_eFlagTransferredEvent`,
  `bz_eAllowCTFCaptureEvent`, `bz_eCaptureEvent`.
- Shots: `bz_eShotFiredEvent`, `bz_eAllowServerShotFiredEvent`.
- Chat: `bz_eRawChatMessageEvent`, which may rewrite or drop a line before
  anything else is asked of it, and `bz_eFilteredChatMessageEvent`, once a
  line has gone to whoever it was for. `messageType` is `eChatMessage` or
  `eActionMessage` (`/me`).
- Game: `bz_eGameStartEvent`, `bz_eGameEndEvent`, `bz_eTickEvent` (every
  100 ms while one listens), `bz_eGetWorldEvent`, `bz_eBZDBChange`.
- Polls: `bz_eAllowPollEvent`, `bz_ePollStartEvent`, `bz_ePollVoteEvent`,
  `bz_ePollVetoEvent`, `bz_ePollEndEvent`.
- `bz_ePermissionModificationEvent`.

Where bzo differs:

- `bz_eFlagTransferredEvent` may let a Thief's steal go on, cancel it, or
  spend the thief's flag alone.
- `bz_eAllowSpawn` may hold a tank dead, telling it once, or kick it. bzo's
  server respawns tanks itself, so a held tank is asked again a respawn delay
  later where a BZFlag client would ask again.
- Upstream fires no zone entry or exit events; a zone plugin tests positions
  on `bz_ePlayerUpdateEvent`.
- Upstream fires `bz_eFilteredChatMessageEvent` for `/msg` alone
  (`commands.cxx:1044`); bzo fires it for every line delivered -- to all, a
  team, the admin channel or a player -- and not for one refused, such as a
  muted player's.
- A player record's `currentFlag` names every flag alike, "Red Team (+R*)"
  as "Shock Wave (+SW)", where upstream's says "Red team flag".
- A player record has `bot`, bzo's: a robot, whether this server runs it or
  a client joined as one. Upstream's record cannot tell.

## API

Upstream's, by its names:

- Players: `bz_getPlayerByIndex`, `bz_getPlayerBySlotOrCallsign`,
  `bz_getPlayerIndexList`, `bz_getPlayerCount`, `bz_getPlayerCallsign`,
  `bz_getPlayerTeam`, `bz_getPlayerFlag`, `bz_getPlayerFlagID`,
  `bz_getTeamCount`, `bz_getAdmin`, `bz_kickUser`, `bz_killPlayer`.
- Scores: `bz_setPlayerWins`, `bz_setPlayerLosses`, `bz_setPlayerTKs` and
  their `bz_increment*`.
- Flags: `bz_getNumFlags`, `bz_getFlagName`, `bz_getFlagPosition`,
  `bz_flagPlayer`, `bz_removePlayerFlag`, `bz_resetFlag`, `bz_resetFlags`,
  `bz_RegisterCustomFlag`.
- Shots: `bz_fireServerShot`, `bz_vectorFromRotations`.
- Messages: `bz_sendTextMessage`, `bz_sendTextMessageToTeam` (upstream's
  team overload of `bz_sendTextMessage`, which JavaScript cannot tell from
  the player one), `bz_sendPlayCustomLocalSound`, `bz_debugMessage`.
- BZDB: `bz_getBZDBBool`, `Double`, `Int`, `String`, `bz_BZDBItemExists`,
  `bz_registerCustomBZDBBool`, `Double`, `Int`, `String`,
  `bz_removeCustomBZDBVariable`.
- Commands: `bz_registerCustomSlashCommand`, `bz_removeCustomSlashCommand`.
- Clock: `bz_getCurrentTime`, `bz_getTimeLimit`, `bz_setTimeLimit`,
  `bz_isTimeManualStart`, `bz_isCountDownActive`,
  `bz_isCountDownInProgress`, `bz_isCountDownPaused`.
- Polls: `bz_registerCustomPollType`, `bz_removeCustomPollType`,
  `bz_pollActive`, `bz_pollVeto`.
- Permissions: `bz_hasPerm`, `bz_grantPerm`, `bz_revokePerm`.
- Map: `bz_registerCustomMapObject`, `bz_removeCustomMapObject`,
  `bz_CustomZoneObject`.
- Web: `bzhttp_RegisterVDir`, `bzhttp_RemoveVDir`, `bzhttp_RemoveAllVdirs`.
- Server: `bz_getPublicDescription`, the server's title, and
  `bz_getPublicAddr`, the first `publicUrl` -- a URL, where upstream's is
  host:port.

bzo's own:

- `bz_changeMap` starts a new game on another map, as the panel does.
- `bz_sendRelayMessage(network, name, text)` says a line from another
  network -- a Discord channel, IRC -- to every player. A BZFlag client reads
  the server message `[network] name: text`; bzo's own puts it with the chat.
- `bz_getDataDir()` is the directory `server.json` is in, where a plugin
  keeps what it saves; an upgrade keeps it.
- `bz_runCommand(line, { callsign, bzid, admin, via })` runs a slash command
  for a linked account on another network, as a player who is not in the
  game, and resolves to the lines it answered. A BZID banned here runs
  nothing; a plugin's own commands answer that they are for players in the
  game.
- `bz.setTimeout`, `bz.setInterval` and `bz.clearTimer`, cleared when the
  plugin is; upstream's plugins count ticks.
- `bz_registerCustomSlashCommand` takes a third argument, `{ help,
  operator }`: the line `/help` shows, and true for an admin-only command.
  A handler is upstream's object with `SlashCommand(playerID, channel,
  command, message, params)`, or that function alone.

### Custom flags and weapons

`bz_RegisterCustomFlag` adds a type with a name and help that bzo clients are
sent and a native client learns in reply to its flag negotiation, as bzfs
answers it. Its shots are ordinary, as 2.4's are. A map's `zoneflag` of it,
skipped when flags are laid out at boot, joins the world once the plugin
registers it. A plugin builds the flag's effect on `bz_eShotFiredEvent`,
`bz_fireServerShot` and the score calls; customflagsample is the example.

`bz_fireServerShot` fires through the path a map's world weapons use, after
`bz_eAllowServerShotFiredEvent`. A guided server shot steers at the target
it was fired with, and a native client is told the target in the
MsgGMUpdate that follows, as bzfs tells it. Server shots kill as
`ServerPlayer`, as upstream's do (`src/bzfs/bzfs.cxx:3345`): no player
scores, and the victim reads "Killed by the server". A plugin that wants its
player credited scores them itself.

### Custom map objects and zones

`bz_registerCustomMapObject` hands a plugin each block of its object from the
live map's text, since bzo reads the map before plugins load.
`bz.bz_CustomZoneObject` is upstream's box-or-cylinder zone.

### Permissions

Upstream's names over bzo's groups, which are upstream's defaults: EVERYONE,
VERIFIED for a signed-in player, and every permission for an admin but
HIDEADMIN, a plugin's custom ones such as HoldTheFlag's HTFONOFF included.
What the server asks of them is the poll rights, SPAWN and TALK (`/mute`);
the operator commands are an admin's alone.

### The world

`bz_eGetWorldEvent` fires once for each world bzo builds, and `world` says
which. `bzo`, for its own clients, comes once at boot with upstream's fields
(`generated`, `ctf`, `rabbit`, `openFFA`, `worldFile`), after the plugins in
`server.json` load; the map is parsed by then, so it only says what the
world is. `bzflag` comes each time the world sent a native client is built:
when the first native client arrives, and again after a plugin loads or
unloads. It also carries the compiled world as `tree`
(`parseWorldDatabase`'s shape), with `worldSize`, `wallHeight` and
`maxHeight`. A plugin may add objects of any kind to that tree. bzo's server
never sees them, so they must be passable or out of reach. `compassletters`
is built this way.

### Web pages

`bzhttp_RegisterVDir` (`server/plugin-http.cjs`) serves a plugin's pages,
for a stats page or a league's endpoint. Upstream serves a VDir at
`/<name>/`; bzo at `/plugins/<name>/`, with upstream's index of them at
`/plugins/`. The Request, Response and enums are upstream's, `eWaitForIt` is
asked again as upstream asks it, and `GeneratePage` may return a promise
instead.

A VDir's `RequiredAuthentiction` is upstream's:

- `eBZID` sends a visitor to bzflag.org's weblogin and checks the token that
  comes back with `CHECKTOKENS`, asking about the server's `adminGroups` and
  the VDir's `BZIDAuthenicationGroups`. The page then gets the visitor's
  `BZID`, `BZIDCallsign` and `BZIDGroups`, with `UserHasPerm` (every
  permission for one in an admin group, VERIFIED's otherwise) and
  `InBZIDGroup`. The page is made for the URL the visitor first asked for.
  With `CacheAuthentication` the login is kept for an hour behind a cookie
  scoped to the VDir. Each way back from bzflag.org is good once, for ten
  minutes, and shares `/login`'s rate limit.
- `eHTTPBasic` asks for a Basic login in `HTTPAuthenicationRelalm`, and
  `eHTTPOther` asks nothing; both hand the Authorization header to the VDir's
  `AuthenticateHTTPUser`, which answers `eAuthOK` or `eAuthFail`.

A refused visitor gets the VDir's `GenerateNoAuthPage`, or a 403. Upstream's
`SessionData`, templates, resource directories and raw connections
(`bz_registerNonPlayerConnectionHandler`) are not offered; only fastmap uses
raw connections upstream, and bzo serves the world itself.

## Translations

A plugin carries its own: an `l10n` object, `{ locale: { msgid: msgstr } }`,
for the messages it sends with `bz_sendTextMessage(from, to, msgid, params)`.
While it is loaded the server merges them into the catalog a bzo client is
sent (`/l10n/<locale>.json` and the page's inlined copy), under bzo's own, so
a plugin adds translations but never changes one bzo already has. Unloaded,
it adds nothing, and bzo's `l10n/bzo_<locale>.po` holds only the core's
strings. A native BZFlag client reads English either way.

Two plugins that translate one msgid differently are logged as the second
loads; the first keeps it.

A proxied bzfs sends finished English with no msgid. The proxy matches each
of the target's own lines against every msgid with a `{name}` slot that a
loaded plugin translates, or that bzo's server sends itself, and a match goes
out with its msgid and params. So a plugin with only `meta`, an empty `Init`
and `l10n` translates a bzfs plugin's lines for bzo players on that target;
no plugin code runs for a proxied game.

## Bundled plugins

Ports of upstream's: autoFlagReset, chathistory, customflagsample,
customPollTypeSample, fairCTF, flagStay, HoldTheFlag, keepaway, killall,
koth, rabbitTimer, SAMPLE_PLUGIN, shockwaveDeath, teamflagreset, timedctf,
TimeLimit and wwzones. Of allejo's: ctfOverseer (`_disallowSelfCap` and
`_delayTeamFlagGrab`; on, 1 and 20 as allejo's) and mapchange, on
`bz_changeMap`. bzo's own: compassletters, the compass letters a native
client sees, and discord, a Discord channel's chat both ways and Linked Roles
(`docs/discord.md`), the job upstream's ircRelay did for IRC; and matrix, a
Matrix room's chat both ways (`docs/matrix.md`). Each is off until
`server.json` names it, and when on does what its upstream does by default.

## Behind the proxy

A bzo player can join a bzfs that runs plugins in C++, through bzo's proxy
(`docs/proxy.md`). A plugin acts on the wire only through what bzfs already
sends. Checked against bzfs 2.4.30 with upstream's own `.so` plugins
(`npm run test:proxy-plugins`):

- **Kills by the server** (koth, keepaway, timedctf, killall, rabbitTimer):
  `MsgKilled` with `ServerPlayer` as killer, which bzo's client shows as a
  world weapon's.
- **Kicks** (HoldTheFlag, mapchange, regFlag, nagware, superUser, `/kick`):
  the reason, then `MsgSuperKill`. Forwarded as a kick, so the browser stays
  off rather than rejoining into it.
- **The match's end** (`/gameover`, score limits, so HoldTheFlag's winner):
  `MsgScoreOver`, forwarded as `scoreOver`.
- **Custom flags** (customflagsample): a type registered while players are
  in reaches them as `MsgFlagType`. A player who joins later is never told:
  this bzfs answers flag negotiation with nothing, even to an empty list, so
  a proxied player cannot name the flag, nor can a native one.
- **Server shots** (shockwaveDeath, wwzones): `MsgShotBegin` from
  `ServerPlayer`, forwarded whoever fired it. The browser's own hit check
  counts it as upstream's client does, since a shooter on no team meets only
  the team-kill rule.
- **A refused grab** (fairCTF): no `MsgGrabFlag`, and the plugin's reason as
  a message. The browser only asks and waits for the target's answer, so the
  flag stays on the ground for it too. A tank standing on it asks again every
  0.2 seconds, as upstream's client does (`playing.cxx:4123`), so the reason
  repeats for a native player and a proxied one alike.
