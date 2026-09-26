# Network

bzo's wire protocol: what a browser and the server say to each other, and how
far that sits from the binary protocol `bzfs` speaks. Upstream references are
paths under `$HOME/bzflag/`.

Upstream has no protocol document either. The closest thing is the comment
block at `include/Protocol.h:187-317` -- which message goes which way and what
it carries, but no byte layouts -- mirrored verbatim on the wiki as
[Network Protocol](https://wiki.bzflag.org/Network_Protocol). The layouts live
only as paired code: `src/bzflag/ServerLink.cxx` packs, `src/bzfs/bzfs.cxx`
unpacks, `include/Pack.h` holds the primitives and `include/PlayerState.h` the
motion record. This file is bzo's half of that, plus the mapping between them.

## Transport

One WebSocket per client, to the same host and port the page was served from
(`public/client.js:5634` picks `wss:` for an `https:` page). There is no second
channel: no UDP, no unreliable path, no separate control connection. A dropped
frame is a dropped frame at the TCP layer and arrives late rather than never.

`new WebSocketServer({ server })` (`server.js:1312`) takes ws's defaults, which
means no `permessage-deflate` -- frames go out as uncompressed UTF-8 -- and
ws's 100 MiB inbound message ceiling, which is a ceiling rather than a budget:
the one message that is ever large is `uploadMap`.

bzfs, for contrast, is TCP plus an *optional* UDP link
(`MsgUDPLinkRequest`/`MsgUDPLinkEstablished`, `bzfs.cxx:332`) on port 5154,
IPv4 only, opened with `BZFLAG\r\n\r\n` and answered with eight bytes of
protocol version and one byte of player id before any message.

## Encoding

JSON text, one object per frame, discriminated by a `type` string. No binary
frames, no length prefix, no message codes. `sendToServer`
(`public/client.js:5622`) and `broadcast`/`broadcastAll`/`sendToPlayer`
(`server.js:10767`, `:10777`, `:12289`) are the only ways anything reaches the
socket.

Positions and angles are rounded to two decimals on the way out and speeds to
three, which is the whole of bzo's compression story. bzfs quantizes: each
`MsgPlayerUpdateSmall` packs position and velocity as 16-bit fixed point
(`PlayerState::pack`), and caps a packet at `MaxPacketLen` 1024 bytes, 68 on
UDP.

The protocol is lockstep in this repo -- client and server ship together, so
neither end version-negotiates and neither end tolerates a field it does not
recognize. See AGENTS.md, "Coding Conventions".

## Lifecycle

A connection and a join are two different things, as they are upstream.

1. The socket opens. The server allots a player id and immediately sends
   `init` (`server.js:14522`) -- config, world pointer, roster, flags, teams,
   clock. The player is not in the game yet and no one else has been told
   about them. This is bzfs's "connected but has not sent `MsgEnter`" state,
   in which upstream likewise answers world and settings queries.
2. The player picks a name, team and tank in the entry dialog and the client
   sends `joinGame`. The server validates the team, seats the player, answers
   with `playerJoined` to everybody.
3. From there the client sends input and the server sends state.
4. `playerLeft` on close. bzo has no `MsgExit` equivalent from the client --
   closing the socket is the exit.

Identity is not on this socket at all. A player signs in over HTTP at `/login`
and the server reads the session cookie when the socket opens; see
`docs/login.md`.

## Player ids

A player id is a slot number, and it is upstream's: `0` through 243, with the
destinations that are not a player at the top of the byte -- 251 a team, 252
the admin channel, 253 the server, 254 everybody (`Address.h:73-78`, and
`player-ids.mjs`/`player-ids.cjs`, which is the pair both ends read them
from). bzo writes them as strings, because they are object keys here rather
than bytes on a wire.

The numbering is shared with BZFlag deliberately. A slot number is what the
scoreboard shows and what an id-taking command names, so it should mean the
same thing in both; and a proxied player's id *is* the target's own
(`docs/proxy-plan.md`), which only works if both ends agree which numbers a
player may hold. The one place the two differ: upstream spends 244 through 251
on the eight teams and names which one, where bzo spends only 251 and means
"the sender's team", since a client can address no other.

## Client to server

29 types, dispatched by one switch in `server.js`. Fields marked optional are
omitted rather than sent null.

| type | fields | meaning |
|---|---|---|
| `joinGame` | `name`, `team`, `tankModel`, `isMobile`, `viewMap?` | enter the game. `team`/`viewMap` come from `getJoinTeamFields()` so the Map Viewer sentinel is translated in one place |
| `m` | `x`,`y`,`z`,`r`,`fs`,`rs`,`vv`,`vx`,`vz`,`dt`,`sdt`,`ct`,`d?` | motion. See below |
| `tp` | `fromFaceId`,`toFaceId`,`x`,`y`,`z`,`r`,`vv`,`vx`,`vz`,`jd` | the client believes it crossed a teleporter face |
| `zone` | `fromFaceId`,`x`,`y`,`z`,`r` | a Phantom Zone tank crossed a portal and flipped instead of moving |
| `shoot` | `x`,`y`,`z`,`dirX`,`dirY`,`dirZ` | fire. The server allots the slot and owns the flight |
| `grabFlag` | `index` | ask for the flag at that roster index |
| `dropFlag` | -- | drop what is carried |
| `captureFlag` | `team` | the base team whose base the carrier is standing on |
| `nearFlag` | -- | ask what flag is underfoot, for the HUD line |
| `pause` | -- | toggle; the server runs the countdown |
| `selfDestruct` | -- | `/kill` on yourself |
| `identify` | -- | toggle the lock/identify target |
| `message` | `dst`, `msgType`, `text` | chat. `dst` is a player id, or one of the reserved ids below; `msgType` is `chat`/`action`/`team`/`admin`/... |
| `setTankModel` | `tankModel` | change tank mid-session |
| `queryPlayers` | -- | ask for a fresh roster |
| `getMaps` | `requestId` | the map list |
| `importMapForView` | `file` | import a remote server's world for the Map Viewer |
| `importMap` | `hostPort` | operator: import a remote world into the cache |
| `listRemoteServers` | -- | ask for the server list |
| `uploadMap` | `mapName`, `mapContent` | operator: a whole `.bzw` as a string |
| `setMap` | `mapFile` | operator: change the live map |
| `setOperatorConfig` | one key per changed row | operator panel commit |
| `setListServerKey` | `key` | operator: the list-server credential |
| `matchControl` | `action` | operator: countdown, end, etc |
| `voiceState` | `channel`, `team`, `enabled`, `transmitting` | mic state |
| `voiceOffer` / `voiceAnswer` | `channel`, `to`, `description` | WebRTC signalling |
| `voiceIceCandidate` | `channel`, `to`, `candidate` | WebRTC signalling |
| `debug` | `message`, `name?` | client debug line, echoed to the server log |

## Server to client

| type | fields | meaning |
|---|---|---|
| `init` | `clientBuild`, `serverVersion`, `player`, `players`, `config`, `teamMode`, `teamScores`, `liveConfigKeys`, `operatorConfig`, `listServer`, `rabbitId`, `timeLeft`, `gameOver`, `voiceRtcConfig`, `world`, `viewableMaps`, `flags`, `worldTime`, `serverName`, `description`, `motd` | everything, once, on connect |
| `pmBatch` | `moves` | one tick's accepted moves, one entry per mover. The normal motion path |
| `pm` | `id`,`x`,`y`,`z`,`r`,`fs`,`rs`,`vv`,`vx`,`vz` | a single move, outside the batch |
| `pt` | as `pm` plus `fromFaceId`,`toFaceId`,`jd`,`d?` | an accepted teleport |
| `positionCorrection` | `x`,`y`,`z`,`r`,`vv` | the server moved you; the client snaps |
| `playerJoined` / `playerLeft` / `playerUpdated` / `playerList` | player records | roster. A record carries `bzid` only to an admin -- `broadcastPlayerRecord` sends two payloads, and `getState` omits the field entirely for everyone else |
| `alive` | player record | spawn |
| `killed` | `victimId`, `shooterId`, `projectileId`, plus the hit's own fields | somebody died, and why |
| `shotBegin` | `id`, `playerId`, `x`,`y`,`z`, `shotSlot`, `dirX`,`dirY`,`dirZ`, `flag`, `ricochet`, `segments`, `target`, `createdAt` | a shot exists |
| `shotEnd` | `id`, `reason`, `x`,`y`,`z` | it stopped, and where |
| `reload` | -- | a shot slot came back |
| `flagUpdate` | `flags` | the whole flag array |
| `grabFlag` / `dropFlag` | `playerId`, `flag` | one flag changed hands |
| `transferFlag` | `fromId`, `toId`, `flag` | Steal |
| `captureFlag` | `playerId`, `index`, `flagTeam`, `baseTeam` | a capture |
| `nearFlag` | `index`, `flagType`, `position` | the flag underfoot |
| `antidoteFlag` | `position` | where the antidote appeared |
| `teamUpdate` | `teams` | team scores and sizes |
| `scoreOver` | `playerId`, `team` | the match ended on score |
| `timeUpdate` | `timeLeft` | the match clock |
| `newRabbit` | `playerId` | rabbit anointed |
| `lockTarget` | `playerId`, `targetId` | a GM lock |
| `identifyResult` | `targetId`, `locked` | the identify answer |
| `playerPaused` / `playerUnpaused` / `pauseCountdown` / `pauseCancelled` | `playerId` (+ position on pause) | pause state |
| `message` | `src`, `dst`, `msgType`, `text`, `ts` | chat, in and out |
| `lag` | `lagMs` | the server's measurement of *your* lag |
| `serverConfigUpdate` | `serverName`, `motd`, `shotMaxActive`, `ricochet`, `timeLimit`, `timeManualStart`, `maxPlayerScore`, `maxTeamScore` | live config changed |
| `mapList` | `maps`, `viewableMaps`, `currentMap`, `shotMaxActive`, `ricochet` | operator map list |
| `remoteServerList` | `servers` | the list-server answer |
| `importMapResult` / `importMapForViewResult` | `success`, `file`, ... | import outcome |
| `voiceRoster` | `channel`, `nearbyRadius`, `peers` | who you can hear |
| `voiceState` | `channel`, `playerId`, `team`, `enabled` | a peer's mic |
| `voiceMicToggled` | `playerId`, `enabled` | mic indicator |
| `voiceOffer` / `voiceAnswer` / `voiceIceCandidate` | `channel`, `from`, `description`/`candidate` | forwarded signalling |
| *(no type)* | `error` | a refusal, as a bare `{ error }` object |

## Motion

The `m` packet is sent **when the inputs change**, not on a clock: the client
compares this frame's speeds against the last ones it sent and stays quiet if
nothing moved, with a forced send every `MAX_UPDATE_INTERVAL` (5 s,
`public/client.js:4060`) as a heartbeat and on any jump or land transition.
Everything between two packets is extrapolated at both ends from the
velocities in the last one.

`fs` and `rs` are fractions of the world's *base* speed and turn rate, not of
the tank's own -- a tank carrying `V` or `QT` reports more than 1 and the
server places it correctly with no flag state of its own (AGENTS.md, "`fs` and
`rs` are fractions of the *world's* speed"). That is exactly upstream's
`userSpeed`/`userAngVel`, which ride in `PlayerState` when the `UserInputs`
status bit is set.

The three time fields are bzo's own and have no upstream counterpart:

- `dt` -- the frame the speeds were measured over.
- `sdt` -- how long since the last packet, which is the window the speeds
  actually changed over. Neither side can measure this alone, so the client
  claims it and the server bounds how far it will trust the claim.
- `ct` -- this frame on the client's own clock, relative to its own origin.
  The server only ever differences it against the same client's previous
  accepted value. See `docs/lag-plan.md`.

bzfs sends `MsgPlayerUpdate` continuously instead, and carries a `status`
bitfield (`Alive`, `Paused`, `Exploding`, `Teleporting`, `FlagActive`,
`CrossingWall`, `Falling`, `OnDriver`, `UserInputs`, `JumpJets`, `PlaySound`)
plus an `order` counter for reordering, and a physics-driver index. bzo
carries none of those: the equivalent facts are either separate messages
(`playerPaused`, `killed`) or derived from the velocities.

Lag is measured on the server and only on the server (`server/lag.cjs`) -- a
client that measured its own lag would be reporting on the thing it is judged
by. It is *shown* the answer via `lag`. bzfs measures the same thing with a
round trip the client answers, `MsgLagPing`.

## Where authority sits

This is the deepest difference between the two protocols, and it is not a
formatting one.

**bzo is server-authoritative.** The client sends inputs; the server simulates
shots, decides hits, and runs one `applyDeath` (`server.js:13472`) that every
way to die passes through. It validates movement against a speed and
acceleration model and can answer with `positionCorrection`. The client
predicts locally so the tank feels immediate, and the prediction is advisory.

**bzfs is client-authoritative for the things that matter most.** The victim
decides it died and says so (`playing.cxx:3967` calls `sendKilled`, which packs
`MsgKilled` with the killer, the reason and the shot id); the shooter decides a
shot began and ended; the client declares a flag grab and a teleport. bzfs
relays, scores, and applies rules -- it does not adjudicate geometry. Its
protocol has no equivalent of `positionCorrection` because it does not decide
where anyone is.

So the same list of nouns -- killed, shot begin, shot end, grab flag, teleport
-- appears on both wires with the arrow pointing the other way.

## Coordinates, units and ids

- **Up axis.** bzo is Y-up, bzw and bzfs are Z-up. The conversion happens once,
  at map parse: `posBzf`/`shiftBzf` hold the file's own values and the bzo
  obstacle is built from them (`server.js:5493`).
- **Angles** are radians in both, and bzo's `r` is a Three.js Y rotation where
  upstream's `azimuth` is about Z.
- **Player ids** are decimal strings in bzo and a `uint8` in bzfs, where
  255/254/253/252 and the team ids are reserved. bzo already borrows 253 for a
  world weapon's shots (`server/shots.cjs`), and a decimal string can never
  collide with it.
- **Units** follow upstream wherever a value came from upstream -- world units,
  seconds, and `shakeTimeout` in tenths of a second. See
  `docs/game-modes-plan.md`.
- **Names follow upstream** wherever the same thing exists on both sides. A
  player record carries `alive` (upstream's `Alive` status bit, a boolean and
  not a hit-point pool), and `wins`, `losses` and `tks` -- the three counters
  `MsgScore` carries and the same words `teamUpdate` already used for a team's
  tally. A name diverges only where the thing does: `shoot` is a request where
  upstream's `MsgShotBegin` is a declaration, `shotSlot` is upstream's
  per-player shot number under another name because bzo needs `id` for a
  globally unique projectile, and `fs`/`rs`/`m`/`pm` are terse because they are
  sent constantly as text.

## What is not on the socket

Three things a bzfs client gets over its one connection arrive over HTTP here
instead:

- **The world.** `init.world` is `{ hash, url }` and the client fetches
  `/maps/<hash>.json`, `immutable`, because the filename is the content hash.
  `init.viewableMaps` lists every other hashed map for the Map Viewer. bzfs
  sends the compiled world as a binary blob over `MsgGetWorld` with an md5 in
  `MsgWantWHash`; the idea -- skip the transfer when the client already holds
  this world -- is the same, done with ordinary HTTP caching. See AGENTS.md,
  "Hashed, cacheable world delivery".
- **Identity.** `/login` and a session cookie, not a token in a join message.
- **Assets** -- textures, models, sounds -- are static files, where upstream
  has `MsgFetchResources` and `MsgCacheURL`.

## Distance from bzfs

Upstream has 56 message codes. Roughly two thirds have a bzo counterpart, and
the mapping is mostly one to one:

| bzfs | bzo |
|---|---|
| `MsgEnter` / `MsgAccept` / `MsgReject` | `joinGame` / `playerJoined` / `{ error }` |
| `MsgAddPlayer` / `MsgRemovePlayer` | `playerJoined` / `playerLeft` |
| `MsgQueryPlayers` | `queryPlayers` / `playerList` |
| `MsgPlayerUpdate`, `MsgPlayerUpdateSmall` | `m`, `pm`, `pmBatch` |
| `MsgAlive` | `alive` |
| `MsgKilled` | `killed` (opposite direction) |
| `MsgShotBegin` / `MsgShotEnd` | `shoot` → `shotBegin` / `shotEnd` |
| `MsgGrabFlag` / `MsgDropFlag` / `MsgCaptureFlag` / `MsgTransferFlag` | same names |
| `MsgFlagUpdate` / `MsgNearFlag` | `flagUpdate` / `nearFlag` |
| `MsgTeleport` | `tp` / `pt` |
| `MsgTeamUpdate` / `MsgScore` / `MsgScoreOver` | `teamUpdate` / player records / `scoreOver` |
| `MsgTimeUpdate` | `timeUpdate` |
| `MsgPause` | `pause` / `playerPaused` |
| `MsgNewRabbit` | `newRabbit` |
| `MsgMessage` | `message` |
| `MsgSetVar` / `MsgGameSettings` | `init.config` / `serverConfigUpdate` |
| `MsgGetWorld` / `MsgWantWHash` | `init.world` + HTTP |
| `MsgLagPing` | `lag` (measured server-side, not answered) |
| `MsgSuperKill` | closing the socket (it is a forced disconnect, not a kill) |

Upstream messages bzo has no counterpart for: `MsgGMUpdate` (retargeting a
guided missile in flight -- bzo sends `lockTarget` instead and the server flies
it), `MsgNegotiateFlags`, `MsgAdminInfo`, `MsgPlayerInfo`, `MsgHandicap`,
`MsgAutoPilot`, `MsgCustomSound`, `MsgFetchResources`, `MsgCacheURL`,
`MsgGameTime`, `MsgLagState`, `MsgFlagType`, `MsgReplayReset`,
`MsgPortalAdd`/`Remove`/`Update`, and the ping-packet codes.

bzo messages with no counterpart upstream: everything voice
(`voiceState`, `voiceRoster`, `voiceOffer`, `voiceAnswer`,
`voiceIceCandidate`, `voiceMicToggled`), the Map Viewer and import messages
(`importMapForView`, `importMap`, `uploadMap`, `setMap`, `getMaps`,
`mapList`, `remoteServerList`), `positionCorrection`, `zone`,
`setOperatorConfig`, `setListServerKey`, `setTankModel`, `identify`,
`selfDestruct` (upstream's `/kill` is an ordinary `MsgMessage`) and `debug`.

## Talking to a real bzfs

`server/remote-world-import.cjs` is already a partial bzfs client: it dials a
server's TCP port, completes the `BZFS0221` handshake, and asks
`MsgQueryGame`, `MsgWantSettings`, `MsgWantWHash` and `MsgGetWorld`, decoding
the binary world into bzw text which then becomes an ordinary bzo world. bzfs
answers all four to any connection, entered or not.

It then does send `MsgEnter`, once the world is already in hand, and this
costs a seat. A bzfs sends its BZDB only from `addPlayer`, after a player has
actually been accepted (`bzfs.cxx:2361-2365`), so `_tankSpeed`, `_gravity`
and every other world variable can only be read by briefly being on the
server: one observer slot named `bzo-import`, one join and one part in
everybody's chat, then `MsgExit`. What comes back is written into the
exported map as `-set` lines -- only the values that differ from upstream's
own defaults (`server/bzdb-defaults.cjs`, generated from `globalDBItems` by
`scripts/gen-bzdb-defaults.mjs`), and including names bzo does not read
itself, because a map played at `_tankSpeed 40` should say so in the file.
A rejected or timed-out join costs the import nothing: everything above it
already arrived, and the map loads without `-set`. `enterForVariables: false`
skips the join for a caller that would rather stay invisible.

That covers the world download, the game settings and the world variables. A proxy that let a
browser *play* on a real server would need the rest: the join handshake and
its initial burst, pack and unpack for the remaining codes, and an answer to
the authority inversion above -- something on bzo's side has to be willing to
say "I died" on the player's behalf, because bzfs will never say it for them.
`docs/proxy-plan.md` is the plan for that; issue #82.
