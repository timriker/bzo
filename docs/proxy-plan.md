# Proxying a real bzfs server

A browser can watch a live match, but not yet play in one. Issue #82: let a
browser play, or watch, on an ordinary `bzfs` server through a bzo instance.
`docs/network.md` is the protocol reference this plan assumes -- what bzo says
on the wire, what bzfs says, and where the two differ. Upstream references are
paths under `$HOME/bzflag/`.

## What already exists to build on

- **A partial bzfs client.** `server/remote-world-import.cjs` dials a server's
  TCP port, completes the `BZFS0221` handshake, and asks `MsgQueryGame`,
  `MsgWantSettings`, `MsgWantWHash` and `MsgGetWorld`, decoding the binary
  world into bzw text. None of that needs a player slot. `MsgEnter` is sent
  only for the BZDB dump, which bzfs gives nobody who has not joined, and
  `buildEnterPayload` lays out the whole message including its 22-byte token
  field -- forwarding a global login is writing into a slot that exists rather
  than adding one.
- **The forwarded-login probe.** `probeGlobalToken` and `/login/<target>` send
  one such `MsgEnter` with a real token in that field and read bzfs's verdict
  back. Step 1 below.
- **A held connection.** `server/bzfs-session.cjs` joins a target and stays on
  it, decoding what bzfs says about players, teams, flags, the rabbit and the
  clock, and answering its lag pings. Step 2 below, and what step 3 forwards
  from.
- **The viewer's cached world, unchanged.** A proxy's world is the same
  artifact Map Viewer already serves: `import-<host>_<port>.bzw`
  (`remoteMapFileName`, `server.js:1506`) and its hashed JSON. That includes
  how object names are handled -- upstream's `Obstacle` has no name field and
  packs none, so the binary world arrives flattened and unnamed -- which is
  settled behaviour in production rather than a question proxying reopens.
- **A list row already parsed into `host` and `port`.** `fetchServerList`
  splits the list server's `nameport` field, so a bzfs row carries
  `bz.rikers.org` and `5154` -- exactly the key a proxy map is written
  against.
- **Hashed world delivery.** A parsed map becomes `/maps/<hash>.json`,
  `immutable`, which any client can fetch. See AGENTS.md, "Hashed, cacheable
  world delivery".
- **The global login.** `/login` already runs the `my.bzflag.org` weblogin and
  `CHECKTOKENS` round trip (`docs/login.md`).
- **Dialling real servers routinely.** `docs/list-server.md`.
- **A client that renders a world it is not playing in.** Map Viewer.

## The shape: one instance, several targets, no game of its own

An instance is configured to proxy bzfs servers rather than to host a map. It
may offer several: the bzo on `bz.rikers.org` can carry the bzfs on
`bz.rikers.org:5154` over `127.0.0.1:5154`, a second test bzfs on another
loopback port, and a third on `192.168.12.x`, each listed and joined
separately. What it does not do is host
its own game *and* proxy others -- that needs per-player world, config, roster
and clock, and buys nothing this does not.

Several targets cost little because **a proxy holds no game state to
partition**. The globals a second local map would force into a `Game` object
(below) are exactly the ones proxy mode deletes: no obstacles, no teleporter
graph, no zones, no world weapons, no bases, no clock, because none of that is
simulated here. What is per-target is a world to serve and a connection to
dial.

The state question resolves harder than "mirror upstream's config". Each
browser gets its own bzfs connection, so each browser receives the real roster,
scoreboard, flags and clock down its own socket. **There is nothing for the
proxy to mirror.** It stops being a game server and becomes a codec: no shot
simulation, no hit detection, no flag logic, no scores, no match clock, no
rabbit, no anti-cheat.

What it does hold is small:

- **A world per target**, fetched once at boot -- not per player -- through the
  existing importer, into the same `import-<host>_<port>.bzw` cache and hashed
  delivery Map Viewer uses. Every player on that target shares it, and several
  worlds are already ordinary: hashed delivery serves any number of maps by
  content hash, so the synthesized `init` names the one this connection's
  target resolved to.
- **A target per connection**, chosen at join from the `proxies` map below.
  A lookup, not state.
- **An `init` buffer per connection.** bzo's client wants one `init`; bzfs
  delivers the same facts as a burst after `MsgEnter` (`MsgGameSettings`,
  `MsgTeamUpdate` per team, `MsgFlagUpdate` per flag, `MsgAddPlayer` per
  player). The proxy collects the burst and synthesizes one message. Buffering,
  not simulation.
- **Two lookup tables**: bzfs `uint8` player id to bzo id, and flag indices.

One TCP connection per player is unavoidable -- bzfs allots a `PlayerId` per
connection and there is no multiplexing. The proxy therefore receives every
broadcast once per connected browser. Wasteful, harmless, and exactly why
nothing needs mirroring.

Two of the issue's open questions dissolve here. **Chat** has no bzo-side game
to come from, so it all goes to bzfs and comes back. **Voice** is bzo's own
(below). The two logins also collapse to one: a proxy instance has no bzo-side
identity or operator surface worth keeping, so go straight to the bzflag.org
weblogin and forward the token to bzfs unspent -- which works, but only from
inside the target's network. That is the next section.

## The token forces co-location

**No change to bzfs is required, and none is proposed.** What follows is a
constraint on where a proxy may run, not a feature request upstream: unmodified
bzfs accepts a forwarded token from a proxy on a private address, and will
never accept one from a proxy on a public address.

bzfs does not validate a token itself. It hands the token to the list server
along with the address it observed on the player's connection
(`ListServerConnection.cxx:413`):

```cpp
Address addr = handler->getIPAddress();
if (!addr.isPrivate()) { msg += "@"; msg += handler->getTargetIP(); }
```

`my.bzflag.org` compares that address with the one the token was issued to.
`misc/checkToken.php` documents the site half: `$checkIP` defaults true and the
address is `$_SERVER['REMOTE_ADDR']`, the browser that just logged in. A proxy
breaks the comparison by construction -- the token is bound to the browser's
address and bzfs reports the proxy's.

**`isPrivate()` is the way through, and it is not an option** -- it is
127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16, hardcoded
(`Address.cxx:121`). When the observed address is one of those, bzfs omits the
`@<ip>` **entirely** and the list server checks the token with no address at
all. That reply is already confirmed from this end: bzo's `/login` probe asks
`CHECKTOKENS` without an IP and gets `TOKGOOD` back with the `ip=` field echoed
empty (AGENTS.md, "Global registration"). A proxy reaching bzfs over loopback
or a private LAN therefore has a forwarded token accepted as it stands.

Three consequences, and they are the plan's shape rather than details:

- **A proxy must be inside its target's network.** Same host is
  `127.0.0.1:5154`; same LAN or a VPN peer is a 10/8 or 192.168/16 address.
  Same datacenter is not enough when both machines carry public addresses --
  what counts is the peer address bzfs sees on `accept()`, not the distance.
  Dialling the target's public name from the same host fails too, since the
  kernel picks a public source address for a public destination: the private
  target has to be configured, not resolved. A bzfs bound to one public
  interface with `-i` has no private address to offer at all.
- **Only a server whose own operator installs the proxy can be proxied.** That
  is a far stronger consent property than an address ban, and it needs no
  coordination: a stranger's public bzfs cannot carry a forwarded token in the
  first place.
- **The latency objection largely dissolves.** #82's "worst of both" assumes a
  proxy far from its target, and the token constraint makes that deployment
  impossible. The added hop is sub-millisecond by construction, leaving the
  player's total at browser-to-proxy -- the same order as a native client
  reaching a distant server.

**Where the check fails it is not a kick.** `TOKBAD` costs the player their
global identity, not their seat: bzfs says "Global login rejected, bad token"
and, for a registered callsign, "You must use global authentication"
(`ListServerConnection.cxx:284`, `bzfs.cxx:2561`), then lets them play
unverified. Unverified means no global groups and **no BZID** -- and the BZID
is what the accountability argument below rests on. It also loses a callsign
clash to the real owner arriving on a native client (`bzfs.cxx:2167`). None of
it runs at all against a target that is not publicized -- none of
`-publictitle`, `-publicaddr` or `-publickey`
(`CmdLineOptions.cxx:1039-1075`) -- which leaves `notRequired` and never
checks a token (`bzfs.cxx:4737`).

So the only deployment where proxying works is the one where every proxied
player is globally verified with a real BZID. The mechanism and the
accountability requirement are one constraint seen twice.

**The callsign comes from the weblogin callback, never from the client.** bzo
does not check the token, so it has no independent knowledge that a claimed
callsign is genuine, and bzfs checks `callsign=token` as a pair. A client
allowed to name its own callsign would simply arrive unverified -- no worse
than a native client, which may claim any name, but it defeats the BZID
requirement that makes the proxy tolerable at all. Both values arrive in the
callback's single `t=<token>:<callsign>` parameter (`docs/login.md`), so using
that pair and nothing else is also the least code.

**The login route already has the right shape.** `/login/:returnPage?` carries
an allowlisted path segment rather than a query parameter, because the callback
weblogin.php returns to may hold only one query parameter -- a second needs an
`&` that weblogin.php's own query string claims (`LOGIN_RETURN_PATHS`,
`server.js:560`). A target becomes another key, `/login/bz.rikers.org_5154`,
and the reason it is an allowlist rather than a trusted segment still holds: an
unrecognised one would be an open redirect. The `proxies` map below is that
allowlist.

**The first target already satisfies all of this.** The bzfs behind
`bz.rikers.org` runs on the same host as bzo itself, listening on
`0.0.0.0:5154`, so `127.0.0.1:5154` reaches it and the address bzfs observes
is loopback -- no `-i` binding to get in the way. It runs `-publicaddr
bz.rikers.org:5154` with a `-publickey` (`bzfs.conf`), so it is publicized and
token checks do run rather than falling through to `notRequired`. That
`-publicaddr` is also what the public list row carries, so `bz.rikers.org_5154`
is the map key. Nothing about the first proxy needs a second machine or a
cooperating operator.

**And a forwarded token is accepted there.** `probeGlobalToken`
(`server/remote-world-import.cjs`) sends one `MsgEnter` over loopback carrying
a token my.bzflag.org issued to a browser, under the callsign the weblogin
callback named, and bzfs answers `Global login approved!` and then accepts the
join -- roughly three quarters of a second from callback to verdict. The
assumption the rest of this plan rests on is measured rather than reasoned:
bzfs asked the list server with no `@<ip>` half, because the connection came
from 127.0.0.1, and the list server checked the token without an address.

## Transport: the proxy speaks TCP and UDP

bzo's browser side is one WebSocket and nothing else -- no unreliable path, no
second channel (`docs/network.md`). bzfs is TCP plus a UDP link on the same
port, IPv4 only. The conversion is entirely inside the proxy: it terminates the
WebSocket and dials both.

That asymmetry is where bzo is today rather than a property of the design. A
browser can be given an unreliable path -- a WebRTC data channel, or HTTP/3 and
WebTransport -- and a bzo that had one would match the shape bzfs already has,
with the proxy forwarding unreliable to unreliable instead of flattening it
onto the WebSocket. bzo does not have one: its WebRTC use is voice, and that is
browser to browser rather than browser to server, so none of it is a transport
the proxy could borrow. Until that changes the proxy absorbs the mismatch, and
co-location is what makes absorbing it cheap.

**UDP is optional only for an observer.** bzfs applies a blunt rule to any
non-bot player that sends `MsgShotBegin` over TCP -- "Your end is not using
UDP", "Turn on UDP on your firewall or router", then `removePlayer(i, "no
UDP")` (`bzfs.cxx:5596-5608`). So the first shot a TCP-only proxied player
fires disconnects them. Reading is unaffected either way, since
`NetHandler::pwrite` only routes `MsgShotBegin`, `MsgShotEnd`,
`MsgPlayerUpdate`, `MsgPlayerUpdateSmall`, `MsgGMUpdate`, `MsgLagPing` and
`MsgGameTime` over UDP when `udpout` is up and sends everything over TCP
otherwise -- it is sending a shot that is fatal.

The proxy therefore does what a normal client does, and does it because that is
what a normal client does rather than only where it is forced: one UDP socket
per proxied player alongside the TCP connection, opened by sending
`MsgUDPLinkRequest` from it and confirmed by bzfs with `MsgUDPLinkEstablished`
back over TCP and a `MsgUDPLinkRequest` back over UDP (`sendUDPupdate`,
`bzfs.cxx:329`). The UDP path has its own ceiling: `MaxUDPPacketLen` is 68
bytes against TCP's 1024 (`Protocol.h:47`).

**Not by entering as a bot.** The kick is guarded by `!isBot()`, and `isBot()`
is just `type == ComputerPlayer` (`PlayerInfo.h:319`), so `MsgEnter` could
claim it and dodge the rule. It would be a lie about what the client is, it
changes how a target treats the player, and it trades looking like a good
client for avoiding the thing that makes one.

Co-location makes the dual path cheap rather than merely mandatory. UDP exists
for loss and head-of-line blocking on a real network; over loopback or a LAN
there is effectively neither, so the proxy gets the protocol bzfs expects
without inheriting the failure modes it was designed around.

## The one real design cost: authority

bzo is server-authoritative. The client sends inputs; the server simulates
shots, decides hits and runs one `applyDeath`. bzfs is client-authoritative for
exactly these things: the victim decides it died and says so
(`playing.cxx:3967`), the shooter declares shot begin and end, the client
declares flag grabs and teleports. bzfs relays and scores; it does not
adjudicate geometry, which is why it has no `positionCorrection`.

So **the browser has to say "I died."** It is already capable -- it predicts
motion, traces shot paths locally, and shares `collision.mjs` with the server.
It simply never sends those conclusions. That is roughly six new client to
server messages (`killed`, `shotEnd`, `alive`, plus grab/drop/capture/teleport
changing from request to notification) behind a mode flag.

The cost is not the six messages. It is that the client acquires a second set
of semantics, and every gameplay feature after that has to work both ways.

## Respawn, and the rejoin cooldown

bzo respawns automatically: `applyDeath` queues `victim.respawn()` on a
`setTimeout` of `GAME_CONFIG.RESPAWN_DELAY` and broadcasts `alive`.
The client never asks, and there is no message for asking.

Upstream leaves the player dead until they act. On death bzfs sets
`setSpawnDelay(_explodeTime)` (`bzfs.cxx:3371`); the client's `restart` command
sends `MsgAlive` (`clientCommands.cxx:379`, `ServerLink.cxx:816`), guarded by
not-game-over, not-observer, not-alive and not-exploding; bzfs then queues the
spawn honoring the delay and its spawn policy.

A proxied player therefore needs two things bzo does not have: a
**dead-and-waiting state** to sit in with a prompt, and an `alive` message to
leave it with. The state is not from nothing -- the roam camera already knows
how to sit somewhere and look around.

Separately there is a real cooldown, but it is for re-entering the *server*,
not for dying. `RejoinList` adds a player on part if they had ever spawned
(`bzfs.cxx:2943`) and refuses `MsgAlive` for `_rejoinTime` seconds
(`bzfs.cxx:4851`), which defaults to `_explodeTime` and is locked
(`global.cxx:126`). It exists to stop quitting to dodge a shot.

**That collides with bzo's auto-reconnect.** A browser that drops its WebSocket
and comes back is, if the proxy re-enters, a fresh `MsgEnter` straight into the
rejoin list -- so a mobile network blip is indistinguishable from quit-dodging
and benches the player through no fault of their own. The proxy must hold the
bzfs connection open across a browser reconnect, keyed on the session, rather
than tearing it down and re-entering. This is a design constraint, not a
refinement.

## Which servers an instance may proxy

**A map in `server.json`, from display name to dial target** -- not a list of
hosts, because those are two different addresses and both are needed:

```json
"proxies": {
  "bz.rikers.org:5154": "127.0.0.1:5154",
  "bz-test:5155":       "127.0.0.1:5155",
  "bz-lan:5154":         "192.168.12.20:5154"
}
```

The key is the identity a player sees. For a publicized target it is exactly
the host:port the public bzflag list carries -- the target's own
`-publicaddr` -- so the bzo row and the bzflag row read the same string and a
player comparing them sees one server. The value is what
the proxy dials, private for the reason above. The key cannot be the dial
target: every proxy's is
`127.0.0.1:5154`, which names nothing and collides across instances. Never a
`host:port` a client supplies -- the map is also the login-return allowlist, so
an entry is the only thing that makes a target nameable at all.

A target with no published identity -- a test bzfs on a second loopback port,
or one on `192.168.12.x` -- has no `-publicaddr` to borrow, so its key is
whatever name the operator wants shown. The key only has to be unique within
the map and usable as a URL path segment, which a `host:port` already is
(`:` is legal in a path). The row's title and settings come from the target
itself either way, so a made-up key costs nothing in what a player sees.

**A target that is not publicized needs no token at all.** `notRequired` skips
the check entirely (above), so a bzfs an operator runs unlisted is the easy
case rather than an excluded one: it can be proxied with no global login in the
path. Requiring one is then the proxy's own policy, not bzfs's. An operator
mixing a public target with a private test one therefore gets global logins on
the first and not the second, without configuring either.

**A proxied player is on `bz.rikers.org:5154`.** That is the host:port the
public bzflag list publishes, it is what the bzo row says, and it is the whole
of the player's model of where they are. The dial target is how the proxy
reaches it, and operator configuration is all it ever is: it names nothing a
visitor can act on, it means something different on every host, and passed
through it would outlive the session in artifacts. Three places it would arrive
today if the value were used where the key belongs:

- **The cached map's name**, which is the one thing here a player really does
  handle. `remoteMapFileName` builds `import-<host>_<port>.bzw`
  (`server.js:1506`), and that name is the `?viewmap=` parameter in a URL a
  player can share and the row `/list` shows under local maps. Key it on the
  map's key, so the target's world caches as
  `import-bz.rikers.org_5154.bzw` whatever was dialled to fetch it.
- **Anything a player is told went wrong.** "could not reach
  bz.rikers.org:5154", never the loopback address. `server.log` may say
  either; its reader is the operator.

The `.bzw` itself is not in that set. `/maps` serves `MAP_CACHE_DIR`, the
hashed JSON (`server.js:415`); the `.bzw` lives in `RUNTIME_MAPS_DIR` and is
never served, so a player references the file by name and receives the JSON.
`buildBZWText`'s `# downloaded by bzo ... from <host>:<port>` header
(`remote-world-import.cjs:1412`) is therefore an operator-visible artifact
rather than a leak. It should still carry the display name, for provenance:
a cached world whose header disagrees with its own filename is confusing, and
an operator reading it wants to know which target it came from, not the
loopback address they configured themselves.

Keying on the display name is not only the discreet choice, it is the working
one. `parseImportMapFileName` recovers a host:port from the name so a shared
`?viewmap=` link outlives the cache, and `bz.rikers.org:5154` is re-askable by
any bzo, while `import-127.0.0.1_5154.bzw` would send somebody else's instance
at its own loopback.

**The import needs its own entry point, not a relaxed guard.**
`performRemoteMapImport` deliberately refuses a host:port that is not in the
public bzfs list, falling back to a cached copy or throwing
(`server.js:1608`) -- the address there comes from a client-supplied
`?viewmap=` name, so the check is the thing standing between that name and an
arbitrary outbound connection. It stays exactly as it is. A proxy's own import
is authorized by the operator's `proxies` map instead: name from the key,
address from the value, permission from the config. A second caller of the same
fetch, authorized differently, rather than a loosening of the first.

The map is an operator assertion bzo cannot verify: get it wrong and players
see one server's name over another server's game. Where the key is a real
public address, that is checkable -- the importer already dials a target and
reads its title and world hash, so comparing the private target's reply against
the public name's at boot catches a mismatched entry for one round trip. Where
the key is a made-up label there is nothing to compare it against, and nothing
to get wrong either.

**Every proxied player arrives from the same private address**, so the target
operator cannot tell them apart by address at all: `/kick` and `/mute` are
per-`PlayerId` and still reach one player, but `/ban` reaches all of them or
none. `/idban`, `/idunban` and `/idbanlist`
(`src/bzfs/BanCommands.cxx:209-213`) ban by BZID and survive a callsign change,
which is the per-player lever -- and it works precisely because a co-located
proxy is where the forwarded token verifies. A proxy that refuses an unverified
player therefore makes every proxied player individually accountable, a
stronger guarantee than a native client gives, since bzfs otherwise admits
unregistered players.

The token is single use and is spent at `MsgEnter`, cleared on both sides the
moment it is used, so one weblogin buys one bzfs join and a browser reconnect
cannot silently re-authenticate. That is a second reason the bzfs connection
has to be held across a browser reconnect rather than re-entered, alongside the
rejoin cooldown above.

`MsgEnter` also carries a client version string (`getAppVersion()`,
`ServerLink.cxx:690`). A proxy puts its own there, so an operator can see who
arrived by bzo without anybody inventing a mechanism.

## How a player reaches one

Three ways in, and they are the three Map Viewer already has, because a proxy
is the same thing seen from further away: the same client, pointed somewhere
else.

- **A link.** `?proxy=<host_port>`, beside `?viewmap=<file>`. A GET parameter
  rather than a POST or a path: the whole value of it is that it can be sent
  to somebody, and a URL that keeps the choice out of itself cannot be. It is
  also why the target is keyed on the public `host:port` rather than the dial
  address -- the link says which match, not which wire.
- **A picker in the entry dialog**, beside the Map Viewer one, fed by a
  `proxies` list on `init` the way `viewableMaps` feeds that one. A player who
  has never seen a link picks a server from the instance's own list. Choosing
  one is a page navigation to its `?proxy=` link rather than a message on the
  live socket: the target is fixed when the socket opens -- `init` is
  synthesized from it -- and a navigation is what `/login` already does for the
  same reason.
- **A row on `/list`**, which is the section below.

`/login/<host_port>` ends the same way. Today it prints the probe's verdict
because that is all it is; once a proxied player can play, its ending is a
redirect to `/?proxy=<host_port>` -- the token is spent joining that target, so
the browser should land in that match rather than back at a page about it.

**Several targets on one instance is the ordinary case, not the exotic one.**
A host running four `bzfs` on four local ports publishes one bzo and four keys:
`?proxy=example.org_5154`, `_5155`, `_5156`, `_5157`. Nothing about that needs
multi-world (below) -- the worlds are the targets', fetched and hashed
separately, and bzo hosts no game of its own.

## Advertising a proxy

bzo's own list server (`docs/list-server.md`) is bzo on both ends over
HTTPS/JSON, so these fields are ours to add; nothing here needs anything from
`my.bzflag.org`.

**One row per proxied target, not one per instance.** A proxy holds no game of
its own, so its own player count, shot limit, style and option bits describe
nothing, while the target's describe the match a player is deciding whether to
join. A row therefore carries the target's counts, options and title, the
proxy's URL as where clicking goes, and the target `host:port` in a new
**Proxied** column, empty for a native bzo row. `gus.rikers.org` offering
three local bzfs hosts is three rows, each with its own settings, not one row
summarising them.

**bzo instances are the only source, and the bzo table the only place it
shows.** A proxy's targets are known to that proxy and to nobody else -- the
bzflag list cannot say which of its rows somebody is willing to carry, and a
proxied target need not be on that list at all. So the report gains a
per-target block, the designated instance holds them, and `/list`'s bzo table
gains the rows. The bzflag table is untouched: it stays what it is, a directory
of real servers to import a map from.

**The row's numbers come from the proxy's own dial, not from
`my.bzflag.org`.** The proxy already talks to the target over loopback, so
`MsgQueryGame` gives it live counts, shot limit, style, option bits and title
first-hand -- which also works for an unlisted target, and cannot disagree with
what a joining player will actually meet.

**A key is per instance; a row is per instance and target.** Registration
stays one key per URL (`docs/list-server.md`), so `gus.rikers.org` offering
three local bzfs hosts holds one key and produces three rows, and one challenge
callback proves all three at once. A row is identified by the pair, not by
either half. The **Proxied** column names the target and the existing URL
column names the bzo instance carrying it, which is also the whole of what
"local" and "remote" mean here -- a row for this instance's own proxy arrives
by the same path as anyone else's, since the designated instance already writes
its own report straight into its registry rather than special-casing itself.

**Two instances may carry the same target, and nothing coordinates them.**
`bz.rikers.org` reaching `bz.rikers.org:5154` on `127.0.0.1:5154` and
`orin-bzo` reaching it on `192.168.12.5:5154` are two independent registrations
with two keys, and both rows list. This is where separating the map's key from
its value pays: the identity a player sees stays the same across proxies while
the dial target is local to each, so the two rows agree about which match they
lead to and differ only in the way in. Nothing needed building to allow it --
it is a consequence of keys being per instance, and it is unlikely to be
common.

The honest reading of those two rows is that **they show one match twice**, so
their player counts are identical by construction rather than additive. That is
the Proxied column earning its place: same target means same game, and a
visitor who reads the column cannot mistake two ways in for two servers.

**Liveness is per target too.** A proxy can be up with one of its targets
down, so each block carries that target's own reachability from the last dial
and the row goes stale on its own. The key-level staleness rule
(`STALE_FAIL_THRESHOLD`) still governs whether the *instance* is answering at
all; it cannot speak for a bzfs behind it.

**The rows are the chooser; no client setting on top.** Picking between two
rows for one target is a real choice and `/list` already offers it. A stored
preference for one proxy over another would add nothing on top: both sit inside
the target's network, so they differ in who runs them and in the browser's own
route to each, neither of which a settings dialog could decide better than the
player clicking a row.

**A proxy-only instance is the cheaper install, not a restricted one.**
Proxy mode already deletes server-side game state, so an instance with
`proxies` set and no `mapFile` has no map, no tick and no anti-cheat to
configure. That is the distribution story for #82: a bzfs
operator installs bzo beside the servers they already run, adds a map entry
per server, points `listServerUrl` at the designated instance and registers one
key. bzo spreads as an add-on to bzfs servers rather than needing anyone to run
a bzo game.

## Voice

Voice never touches the bzfs protocol. Browsers connect to bzo, the proxy owns
the roster and the signalling, and the media is peer to peer between browsers.
Nothing to translate and no new messages -- it is the one feature a proxy makes
no harder.

It is also not new. Players already use a separate voice app or sit in the same
room; bzo's voice is a convenience, not a capability the game lacked.

**Observers talking to each other already works.** `voice-channels.cjs` treats
Observer as a team, matching upstream's team message dispatch, and observers
report a position (`applyObserverHeartbeat`), so all three channels work for
them. A commentary channel players cannot hear is Team while on Observer.

**"All" is a half-truth on a proxy.** It reaches every bzo client on this
proxy, not every player in the match, because native clients have no voice --
so voice All and chat All stop meaning the same set. Fix the label, not the
meaning: changing what a channel *means* per mode is worse than changing what
it *says*.

**Nearby is the one to show people.** The proxy forwards everyone's positions
anyway, native clients included, so distance is known for all of them. Two bzo
users on Nearby get spatialized voice inside a real BZFlag match, which no
BZFlag client has had; for two observers roaming the same match it also means
"we are looking at the same corner of the map."

**Scoping is what actually needs building**, and an instance offering more than
one target needs it from the start -- it is the one piece several targets
genuinely force. A channel belongs to a target, not to an instance:
`areVoicePeers` already has two symmetric preconditions -- same channel, then
the channel's own rule -- and same-target becomes a third, with `getVoicePeers`
filtering the roster by target first. Voice is what forces the question first,
because All's hint is a literal promise ("Every player on the server, however
far away") that becomes false the moment one instance carries two matches.
Chat needs the same cut, and gets it for free: it all goes to bzfs and comes
back down the connection it belongs to.

Cross-game voice is deliberately out of scope. It breaks "voice comes from
where the speaker is standing" -- no shared space, so it has nowhere to come
from and would have to be flat. If it is ever wanted it is a fourth, explicitly
non-spatial channel, additive rather than a change to the three.

## Multi-world is a fork, not a next step

Proxy mode makes per-player game state *unnecessary*, so several proxied
targets on one instance are not multi-world and bring nothing toward hosting
several local maps at once. The two designs pull apart:

- **Proxy mode** -- delete server-side game state, and several targets follow
  for the price of a lookup and a world hash. The cheapest path to issue #82.
- **Multi-world** -- every piece of game state becomes a member of a `Game`,
  and one kind of `Game` is a proxy. Both features fall out, plus one host
  running several local maps.

Multi-world concretely means moving most of `server.js`'s top-level mutable
state (`OBSTACLES`, `TELEPORTER_GRAPH`, `MAP_ZONES`, `WORLD_WEAPONS`,
`BASES_BY_TEAM`, `matchClock`, `rabbitPlayerId`, `worldTime` and the rest) plus
`players`, `projectiles`, `flags` and `GAME_CONFIG` into an object, and turning
every `broadcastAll` into `game.broadcast`. That part is large but mechanical.
The parts that are not: one tick per game against one tick over games, chat
scoping, proximity voice across worlds, what the list server advertises, which
game the operator panel's `/countdown` reaches, and the join dialog becoming a
game browser. High regression surface across a server written against those
globals, for a payoff -- one host, two maps -- that nothing is currently
asking for.

## Risks

- **Shared address.** Every proxied player comes from the proxy's private
  address, so the target sees one host running many clients -- which is also
  what a cheat proxy looks like. It sees a host on its own network, though,
  which is unmistakably something its operator installed, and the BZID
  requirement above is what keeps individual players answerable.
- **Cheating.** A proxy hands anyone a BZFlag client they can modify in
  devtools, and bzo's anti-cheat does not run in proxy mode. BZFlag's client is
  open source too, but editing JavaScript and recompiling C++ are not the same
  bar. This wants a decision before the play path is built, not after.
- **Latency.** The proxy adds its own hop to bzfs's, and the token constraint
  pins it inside the target's network, so that hop is sub-millisecond and the
  player's total is browser-to-proxy -- the same order as a native client
  reaching a distant server. "Worst of both" describes a deployment the token
  check will not authenticate. See "The token forces co-location".

## Order of work

The list server comes last. It is discovery for something that has to work
first, it needs both ends of a bzo pair updated before a row appears, and every
step before it is cheaper against one hardcoded loopback target than against a
registry. Observer-first still holds: an observer sends no state, so it reaches
a watchable real match without any of the authority inversion.

1. **A forwarded token verifies. Done.** `/login/probe-bz.rikers.org_5154`
   runs the weblogin, deliberately does *not* call `CHECKTOKENS` -- a token is answered
   once, so asking would spend the very thing being forwarded -- and sends one
   `MsgEnter` to `127.0.0.1:5154` with the callback's callsign and its token.
   bzfs queues the list-server ADD on the same main-loop pass
   (`bzfs.cxx:7259`) and holds the player out of the game until the reply
   lands, so the verdict arrives as a chat message and the `MsgAccept` follows
   it: `Global login approved!`, then the join. The target it may aim at is an
   allowlist, `PROXY_TARGETS`, which is what the `proxies` map grows from.
   The `probe-` prefix is because a bare target now names the way *back* to
   that target: `/login/<host_port>` signs in and returns to `?proxy=`, so a
   player watching a real server comes back watching it rather than landing in
   this server's own game. `/logout/<host_port>` does the same.

   Two things the probe does that the importer does not: it occupies a real
   player slot on the target, and a *verified* join under a callsign already
   playing there kicks that session (`bzfs.cxx:2167`). Probe with your own
   callsign while not otherwise on the target.

2. **An observer, and one synthesized `init`. Done.** `/proxy/<target>` serves
   the ordinary client, which keeps that path on its WebSocket -- the server
   has to know which bzfs a socket is for before it can send `init`, and
   `init` goes out the moment a socket opens. That connection is not a player
   in this server's game: it is never in `players`, so nothing here simulates
   for it or scores it. It gets a `BzfsSession` (`server/bzfs-session.cjs`) of
   its own instead, which joins as an observer, keeps what bzfs tells a
   joining player, answers the lag pings that would otherwise get it kicked
   (`lagKick`, bzfs.cxx:4378), and stays. `init` is synthesized from that:
   the target's world through the existing import, its roster, its team
   scores, its clock. Ids are the target's own -- a `PlayerId` names every
   player on the connection, this viewer included, so there is no second id
   space to keep a table for.

   Roster changes and the target's chat carry on afterwards; everything the
   session decodes that has a position in it is held rather than spoken, since
   that is step 3. The flag array is deliberately empty for the same reason.

   The callsign is the login session's, or a numbered `bzo-view-N` for a
   browser that has not signed in -- never the client's to choose. It is not
   yet the forwarded token from step 1: an observer that arrives unverified is
   refused nothing that matters, and the join that spends a token is step 5's.

3. **The downstream state, over both transports. Done bar two gaps.**
   Positions, spawns, deaths, pauses, flags, shots, scores, the badges beside
   a callsign, the match clock and the rabbit, all into the messages bzo's
   client already renders. The UDP link is up before the join finishes rather
   than with play: the bulk messages ride it, and a proxy that waited would be
   presenting itself as the TCP-only client bzfs kicks for shooting.

   Two conversions are the whole of the work. Coordinates -- bzfs is `+Y`
   north and `+Z` up, bzo is three.js's `-Z` north and `+Y` up, the same
   change the world importer already makes (`docs/bzw.md`), with a heading a
   quarter turn apart. And authority: bzo's `fs`/`rs` are the *inputs* a
   client would have held, because that is what the receiving client
   dead-reckons with, so they are recovered from the velocity bzfs sends
   against the very numbers that client will multiply back by.

   Where one end's silence is the other's missing message, the proxy keeps the
   clock. A shot that simply expires ends with no `MsgShotEnd` at all -- every
   upstream client stops drawing it on its own -- where bzo's client removes a
   projectile only when told to, so the proxy sends the ending, at the shot's
   own lifetime or the world's edge, whichever comes first.

   **The two gaps.** A shot's path is client-side work upstream, and bzo's
   client does not do it, so a proxied shot passes through a wall it should
   have stopped at, and a Laser arrives without the segments bzo draws a beam
   from. Both want the client to trace a shot it was given rather than the
   proxy simulating one.

4. **Replace the hardcoded target with the `proxies` map**, plus the
   `/login/<target>` allowlist. Several targets first exist here, so this is
   also where voice gains its same-target precondition and the synthesized
   `init` starts naming a per-connection world hash.

5. **Add play.** The client's second authority mode (`killed`, `shotEnd`,
   `alive`, and grab/drop/capture/teleport as notifications), the
   dead-and-waiting state, the rejoin cooldown, holding the bzfs connection
   across a browser reconnect, and the cheating decision -- which wants
   settling before this lands rather than after. The first upstream `shotBegin`
   is also the first thing that tests the UDP link for real, since that is the
   message bzfs refuses over TCP.

6. **Advertise to the list server.** Per-target report blocks, the bzo table's
   rows and its Proxied column, per-target liveness.

7. **Multi-world only if something wants two local maps on one host** -- never
   a prerequisite for any of the above, since several proxied targets are not
   multi-world.
