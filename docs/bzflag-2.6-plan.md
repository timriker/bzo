# BZFlag 2.6 compatibility

Plan for bzo to serve BZFlag 2.6 native clients alongside 2.4 ones, and two
changes to suggest upstream so one server can do that on one port with one
list entry. Upstream references are paths under `$HOME/bzflag/`.

Upstream `master` is 2.5.3 with protocol `BZFS0225`; the release is expected
to be called 2.6. It has no release and no tags yet: a 2.5 player builds it
from source, and the only listed `BZFS0225` servers are blast's, on
`xs.bzexcess.com`. blast is merging 2.4.30 into it and getting GitHub builds
working. His review of what is on `master`, with open questions per area:
[BZFlag 2.6 Changes](https://docs.google.com/document/d/1u5sFsj42tp8tpvYTvGpEbZhylj1MMg3xnz8Nytx2XzM/edit?tab=t.0#heading=h.ucjfhksotbq8).
Re-read it before each step below; skins, the shot manager and flag effects
are all still under review there, so the wire is not frozen.

## What 2.6 changes on the wire

Diffed `origin/2.4` against `origin/master`:

| Area | 2.4 | 2.6 (`master`) |
|---|---|---|
| Connect | `BZFLAG\r\n\r\n`, reply `BZFS0221` + id | Same, reply `BZFS0225` + id |
| MsgEnter | type, team, callsign, motto, token, version | Adds `skinIndex` (u16) and `locale[17]` |
| MsgAddPlayer | id, type, team, score, callsign, motto | Adds `skinIndex` |
| World transfer | MsgWantWHash, MsgCacheURL, MsgGetWorld by offset | MsgAcceptWorld, MsgSetWorld (hash), MsgStartWorld, MsgWorldChunk (1000 bytes), MsgEndWorld; no cache URL |
| World format | `BzMaterial::pack` | Adds normal-map and specular-map names per material |
| Shots | Client picks the shot id, sends MsgShotBegin | Client sends MsgFireShot with a slot; server assigns a global id and broadcasts MsgShotBegin (FiringInfo +2 bytes) |
| Flags | MsgGrabFlag, MsgDropFlag, MsgTransferFlag | MsgRequestFlag, MsgGrantFlag (+shot limit), MsgStealFlag, MsgFlagDropped |
| Custom flags | MsgFlagType | Adds an effect byte; Genocide leaves the standard set; an unknown-flag type |
| Chat | MsgMessage | MsgSendChat, MsgReceiveChat, same layout |
| Teams | Rejoin to change | MsgSetTeam |

Unchanged: PlayerState (MsgPlayerUpdate and the small form), MsgAlive,
MsgKilled, MsgShotEnd, MsgScore, MsgTeleport, MsgCaptureFlag, MsgSetVar,
MsgGameSettings, the ping and list-server `gameinfo`, UDP setup, and every
obstacle's pack format.

2.6 parses and sends normal and specular maps, but nothing in `src/bzflag`
reads them back, so its client does not render them. Its OBJ loader
(`src/geometry/WavefrontOBJ.cxx`) has no caller in the client either.

## Suggested upstream: say the version in the connect header

A 2.4 and a 2.6 client send the same `BZFLAG\r\n\r\n`, then compare the
server's 8-byte reply to their own version and quit on a mismatch
(`ServerLink.cxx:290`). The server has to answer before it knows which client
it has, so today each protocol needs its own port.

Suggest that 2.6 clients send the version string they speak in place of
`BZFLAG`:

```text
BZFS0226\r\n\r\n
```

Both ends then exchange the same string: a server that speaks it compares the
header with its own version and answers as today; one that does not answers
with its own version, and the client reports the mismatch as it does now.

This is safe against 2.4 servers. `bzfs.cxx:6082` compares the first ten bytes
to `BZFLAG\r\n\r\n`; the new header does not match, so the connection takes the
non-player path. After its 2.5 s connection timeout (`bzfs.cxx:6032`) bzfs
replies `BZFS0221\r\n\r\n` and closes (around `bzfs.cxx:6174`), well inside the
client's 10 s wait. The client sees `BZFS0221` and says so. Appending the
version after the old header would not work: bzfs drops a connection that
sends more than two bytes past it (`bzfs.cxx:6090`).

## Suggested upstream: several versions per host:port on the list

The list server (`BZFlag-Dev/bzfls2`) finds a server by `nameport` alone:
`getServerByNameport` for ADD (`bzfls.php:600`) and REMOVE. One host:port is
one row with one `version`, so a second ADD from the same port with another
version replaces the first.

Suggest keying the row on `nameport` and `version`:

- ADD updates the row matching both, or adds one.
- REMOVE with `version` removes that row; without it, every row for the
  `nameport`, so existing servers keep working.
- LIST already filters by `version` (`getServersForUnregistered`), so each
  client still sees only servers it can join. Nothing else changes.

Until then, a second hostname on the same address gets its own row, e.g.
`bz26.rikers.org:5154`. The list requires the name to resolve to one IPv4
address, the requester's. That only helps once the connect header lets one
port serve both; before it, 2.6 needs its own port anyway.

## Lockstep makes bzo a test bench

bzo's browser client and server ship together and never version-negotiate
(`docs/network.md`, "lockstep"). The server serves the client, and a build hash
in `init` reloads every browser on its next connect after a change
(`checkClientBuild`, `public/client.js`). A protocol change lands on both ends
in one commit and every player is on it within a restart.

So bzo can try a 2.6 idea, such as server-assigned shot ids, flag
request/grant, or a team change without a rejoin, with real players, in the
same game as 2.4 native clients, before upstream freezes the wire. It is also
a second, independent implementation: where bzo and `bzfs` disagree, one of
them has a bug or the protocol has an ambiguity. Findings go back to blast's
review doc.

## What bzo already does that 2.4 does not

| bzo | Where | Native clients | 2.6 item |
|---|---|---|---|
| The server owns shots: it assigns the slot and id, flies the shot, decides hits | `server/shots.cjs`, `docs/network.md` | Their MsgShotBegin goes the same path, keeping the client's id | Shot manager, server-assigned ids |
| Reload tracked per slot, `_reloadTime` over the flag's rate | `server/shots.cjs` | Enforced on their shots | Reload tracking |
| Server bots that play (Roger and Ace) through the same move and shot checks as a browser | `server/bots.cjs`, `docs/bots-plan.md` | Seen as `[auto]` players | Server-side players (blast: loading R2 crashes the server) |
| Team change from the browser, by reconnecting | `server.js` | No | MsgSetTeam |
| Automatic team pick by size, then score | `server/teams.cjs` | Yes | Automatic team assignment |
| OBJ tank models, chosen per player, and camo | `docs/tank-model-format.md`, `public/camo.mjs` | No | OBJ loading, skins |
| Worlds served by content hash, compressed, cached forever; native clients get it through MsgCacheURL | `docs/network.md`, `docs/bzflag-clients.md` | Yes | Faster map transfer (2.6 drops the cache URL instead) |

bzo-only, with no 2.6 counterpart: WebXR, touch, installable app, voice chat,
the proxy to real `bzfs` servers, the operator panel, `.rec` recording and
browser replay, and auto-rejoin.

Gamepads are not bzo-only. Upstream reads any SDL joystick
(`src/platform/SDLJoystick.cxx`), and 2.4.30 is ahead of `master` there, so
2.6 gets it from the merge. They differ:

| | bzo | BZFlag 2.4.30 |
|---|---|---|
| Setup | Browser's standard layout, on when plugged in | Picked in Input Settings, opened at startup; raw `SDL_Joystick`, no hotplug |
| Driving | Left stick | Axes chosen by number (`jsXAxis`, `jsYAxis`), invertible |
| Shaping | Fixed 20% dead zone | `jsRangeMin` (dead zone, 5%), `jsRangeMax`, `jsRampType`, `jsStretchCorners` |
| Buttons | Fixed: shoot, jump, drop, identify | Bound like keys ("Joystick Button 1", hat directions); no defaults |
| Rumble | Death and firing, Rumble setting on by default; XR controllers too | Death and firing, `rumble` on by default |
| Menus | Driven by the pad | Joystick buttons reach menus, which answer keyboard keys only |

bzo could take upstream's dead-zone and ramp settings; upstream could take a
default button layout and menu navigation.

Not in bzo yet: locale at join (`docs/i18n-plan.md`), normal and specular
maps, custom flags or a flag effect field, an unknown-flag type, and
`-noSelfKills`.

## Steps before 2.6 clients

Each works for browsers on its own and costs a 2.4 native client nothing.

1. **Skins.** Upstream's 28 PNGs (`data/<team>_tank_{hex,digital,facet,solid}.png`,
   LGPL/MPL, about 3.2 MB) into `public/textures`, loaded only when a tank uses
   one. A Skin picker next to the tank model, kept with the other join
   choices, relayed to every browser. bzo numbers its own skins and maps them
   to 2.6's 0-4 later, since blast is still deciding on them. 2.4 clients see
   the standard texture.
2. **Team change without a reconnect.** Upstream's rule (`809e3cc`): to or from
   observer at once; rabbit and hunter at once in rabbit chase; between
   playing teams at the next spawn.
3. **Locale at join**, as part of `docs/i18n-plan.md`.
4. **Normal and specular maps in BZW.** Parse `normalmap` and `specularmap`
   (`src/bzfs/ParseMaterial.cxx:198`) and carry them in the world. Render
   only when a map uses them, after measuring the cost on Quest: it means
   Phong or Standard materials instead of Lambert.
5. **Flag effects.** Describe each flag by an effect plus parameters, so a
   custom flag can reuse an effect; add the unknown-flag type. Keep Genocide
   built in and follow blast's plugin work.
6. **`-noSelfKills`** as a server setting.
7. **Shot ids as 2.6 assigns them:** a global u16 per shot, with the client's
   slot as its local id. bzo already owns shots, so this is mostly naming,
   and it makes the 2.6 translation trivial.

## Steps for 2.6 clients

After blast's merge lands and the protocol settles.

1. **A 2.6 client to test with.** Build `master` locally, or take a GitHub
   build once those work.
2. **Protocol per connection** in `server/bzflag-server.cjs` and
   `server/bzflag-native.cjs`, chosen at connect: by the versioned header if
   upstream adopts it, otherwise by which port the client came in on.
3. **The 2.6 messages:** MsgEnter and MsgAddPlayer with skin and locale,
   chat renames, the chunked world transfer, material map names, flag
   request/grant/steal/dropped with the shot limit, MsgFireShot, MsgSetTeam,
   the flag effect byte, and no Genocide in the standard set.
4. **Shot ids in mixed games.** A 2.4 shooter's id needs a global id for 2.6
   players, and a 2.6 global id needs a per-player id for 2.4 players.
5. **The list.** A second ADD with the 2.6 protocol string: on its own port,
   or on the same port under a second hostname or the keyed list.

BZFlag 2.0 (`BZFS0026`) is left out: its clients send no header, so one port
could tell them apart, but the list has no 2.0 servers and 2.0 players see an
empty list.
