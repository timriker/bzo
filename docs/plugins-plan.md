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
- **Configured in `server.json`.** A list of plugins, each with its options.
  bzo's own plugins are in the default list, so they are on unless an
  operator removes them.
- **Proxied games are out of scope.** A game bzo proxies runs on the target
  server, which runs its own plugins.
- **Both client kinds.** Whatever a plugin does must reach native BZFlag
  clients as well as bzo's.

## Built-ins that move to plugins

Features bzo built in that were plugins elsewhere. Each moves out, keeps its
BZDB variables, and is on by default:

- `_scoreSaveTime`: allejo's ScoreRestorer.
- `_disallowSelfCap`: allejo's ctfOverseer.
- The Discord bridge (`docs/discord.md`): the job upstream's ircRelay plugin
  does, and the shape Matrix and IRC in `docs/chat-bridge-plan.md` would take.

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
- kill credit for server shots. Check what upstream credits and how plugins
  use shot metadata before choosing.

## Stages

1. **Core.** The loader and its `server.json` list, about 20 events and about
   60 API calls: join, part, spawn, die, kill, flag grab, drop, capture and
   transfer, chat, slash commands, tick, timers and BZDB. Hook points include
   `grabFlag`, `dropFlag`, `captureFlag` and `killPlayer` in `server.js`.
   Prove it by moving ScoreRestorer and ctfOverseer out, and porting
   rabbitTimer, flagStay, teamflagreset, autoFlagReset and killall.
2. **Rules and custom flags.** The remaining allow and modify events, zone
   entry and exit, custom map objects (the BZW parser passes unknown objects
   to the plugin that registered them), polls and permissions, `/plugins`,
   `/listplugins` and `/loadplugin`, and custom flags with server shots. Port
   koth, keepaway, HoldTheFlag, timedctf, fairCTF, chathistory, TimeLimit,
   shockwaveDeath and wwzones.
3. **The Discord bridge** moves to a plugin once stage 1's chat events carry
   what it needs.

Not planned: the network data events, raw world access, and the handicap
events until handicap exists (`docs/game-modes-plan.md`).
