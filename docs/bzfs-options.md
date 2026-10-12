# bzfs options

Every bzfs 2.4 command-line option (`src/bzfs/CmdLineOptions.cxx`) and what bzo
has for it: a `server.json` key, an option a map's `options` block may state,
both, or neither. A map option bzo reads is described in
[bzw.md](bzw.md), "The `options` block"; a `server.json` key in
[installation.md](installation.md) and `example-server.json`. This file only
names the equivalents and says why an option has none.

**Status** is one of:

- **yes** -- read, under the name in the bzo column.
- **intentional** -- bzo has no equivalent on purpose; the reason is given.
- **not yet** -- wanted, linked to the plan that covers it, or "no plan" where
  nothing does yet.

A map option only ever turns a switch on. Where a map and `server.json` both
give a number, `-st`, `-sw`, `-time`, `-mps` and `-mts` take the larger and
`-ms`, `-s` and `-sl` take the map's.

## Game

| bzfs | bzo | Status |
|---|---|---|
| `-a <vel> <rot>` | `linearAcceleration`, `angularAcceleration`; map `-a` | yes |
| `-c`, `-offa` | `teamMode`; map `-c`, `-offa` | yes |
| `-autoTeam` | `teamMode.autoTeam`; map `-autoTeam` | yes |
| `-mp` | `teamMode.limits`, `maxPlayers`; map `-mp` | yes |
| `-rabbit [score\|killer\|random]` | `rabbit`; map `-rabbit` | yes |
| `-handicap` | -- | not yet: [game-modes-plan.md](game-modes-plan.md), Handicap (#62) |
| `-j` | `jumping`; map `-j` | yes |
| `+r` | `ricochet`; map `+r` | yes |
| `-ms <n>` | `shotMaxActive`; map `-ms` | yes |
| `-sl <flag> <n>` | `shotLimits`; map `-sl` | yes |
| `+s <n>`, `-s <n>` | `superFlags.count`; map `+s`, `-s` | yes |
| `+f <flag>` | `requiredFlags`; map `+f` | yes |
| `-f <flag>` | `superFlags.allowed`; map `-f` | yes |
| `-fb` | `flagsOnBuildings`; map `-fb` | yes |
| `-sa` | `antidoteFlags`; map `-sa` | yes |
| `-st <s>` | `flagShakeTimeout`; map `-st` | yes |
| `-sw <n>` | `flagShakeWins`; map `-sw` | yes |
| `-tftimeout <s>` | `teamFlagTimeout` | yes |
| `-sb` | -- | not yet: [game-modes-plan.md](game-modes-plan.md), "Adjacent switches" |
| `-noTeamKills` | `noTeamKills`; map `-noTeamKills` | yes |
| `-tk` | `teamKillerDies: false`; map `-tk` | yes |
| `-tkkr`, `-tkannounce` | -- | not yet: [game-modes-plan.md](game-modes-plan.md), "Adjacent switches" |
| `-time <s>` | `timeLimit`; map `-time` | yes; the `h:mm:ss` end-time form is not yet, no plan |
| `-timemanual` | `timeManualStart`; map `-timemanual` | yes |
| `-mps`, `-mts` | `maxPlayerScore`, `maxTeamScore`; map `-mps`, `-mts` | yes |
| `-disableBots` | `disableBots`; map `-disableBots` | yes |
| `-noradar` | map `-noradar`, or `_radarLimit` in `bzdb` | yes |
| `-g` | -- | intentional: bzo is a web server whose clients reload with it; one game and exit has no use. [game-modes-plan.md](game-modes-plan.md) |

## World

| bzfs | bzo | Status |
|---|---|---|
| `-world <file>`, `-w` | `mapFile` | yes |
| `-b`, `-h`, `-t`, `-cr`, `-density <n>` | `"mapFile": "random"` with `randomWorld.randomBoxes`, `randomHeights`, `teleporters`, `randomCtf`, `density` | yes |
| `-worldsize <n>` | `_worldSize` in `bzdb` | yes |
| `-ws <n>` | -- | not yet, no plan |
| `-gndtex <name>` | map `-gndtex` | yes |
| `-set <name> <value>` | `bzdb`; map `-set` | yes |
| `-setforced <name> <value>` | `bzdb` | yes: bzo keeps and passes on a variable it does not know, which is all `-setforced` adds |
| `-vars <file>` | `bzdb` | yes |
| `-synctime` | `_syncTime` in `bzdb` | yes |
| `-synclocation` | `_syncLocation` | intentional: always on, since a browser has no location of its own -- see [bzdb.md](bzdb.md) |
| `-srvmsg <text>` | map `-srvmsg`; `motd` | yes |
| `-admsg <text>` | map `-admsg` | yes |
| `-helpmsg <file> <name>` | -- | intentional: a path on the server's disk, which upstream itself refuses from a world file; [bzw-plan.md](bzw-plan.md) |
| `-cache <url>`, `-cacheout <file>` | -- | intentional: bzo serves every world by content hash and hands BZFlag clients its own `MsgCacheURL` -- see [network.md](network.md) |

## Players and moderation

| bzfs | bzo | Status |
|---|---|---|
| `-lagwarn`, `-lagdrop`, `-jitterwarn`, `-jitterdrop`, `-packetlosswarn`, `-packetlossdrop` | -- | not yet: [lag-plan.md](lag-plan.md), step 6 |
| `-lagannounce`, `-adminlagannounce` | -- | not yet: [lag-plan.md](lag-plan.md), step 6 |
| `-maxidle <s>` | -- | not yet: [commands-plan.md](commands-plan.md) has the last-input tracking it needs |
| `-speedtol <x>` | `antiCheat` | intentional: the server simulates every tank and checks drift and collisions against that, rather than one speed multiplier |
| `-spamtime`, `-spamwarn` | -- | not yet, no plan |
| `-badwords`, `-filterChat`, `-filterCallsigns`, `-filterSimple` | -- | not yet, no plan |
| `-passwd`, `-password` | `adminGroups`, `adminWhitelist`, `localAdmin` | intentional: admins are global logins in a group, or an address; there is no shared password |
| `-userdb`, `-groupdb` | `adminGroups` | intentional: permissions come from bzflag.org groups -- see [login.md](login.md) |
| `-ban <ip>` | `/ban`, kept in `bans.json` | yes, as a command rather than an option |
| `-banfile <file>` | `bans.json` beside `server.json` | intentional: one fixed place, beside the config |
| `-masterBanURL`, `-noMasterBanlist` | -- | not yet: [ban-plan.md](ban-plan.md), "Then" |
| `-poll` | `poll`; `banTime` for its `bantime` | yes |
| `-reportfile`, `-reportpipe` | -- | not yet: [commands-plan.md](commands-plan.md), reports |
| `-printscore` | -- | intentional: scores are in `server.log` and `/api/players` |

## Network and the list

| bzfs | bzo | Status |
|---|---|---|
| `-p <port>`, `-i <interface>` | `port`, `listen` | yes |
| `-publictitle <text>` | `title` | yes |
| `-publicaddr`, `-publickey`, `-publiclist` | `bzflag.publicAddr`, `bzflag.publicKey`, `bzflag.listUrl` | yes |
| `-UPnP` | `bzflag.upnp` | yes |
| `-advertise <groups>` | -- | not yet, no plan |
| `-q` | -- | not yet, no plan |

## Recording

| bzfs | bzo | Status |
|---|---|---|
| `-recbuf <MB>` | -- | intentional: bzo always buffers from boot -- see [replay.md](replay.md) |
| `-recbufonly` | -- | intentional: as `-recbuf` |
| `-recdir <dir>` | `replays/` beside the maps | intentional: one fixed place |
| `-replay` | `/?replay=<name>` | intentional: a replay is a room on the running server, not a server mode -- see [replay.md](replay.md) |

## Process

| bzfs | bzo | Status |
|---|---|---|
| `-conf <file>` | `server.json`, or `SERVER_CONFIG_PATH` | yes |
| `-loadplugin` | -- | intentional: bzo has no plugin interface; the plugins it follows are built in |
| `-pidfile`, `-d`, `-ts`, `-utc`, `-version`, `-v`, `-h`, `-help` | -- | intentional: process concerns a Node server answers its own way |
