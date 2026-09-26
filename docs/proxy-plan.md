# Proxying a real bzfs server -- what is left

What bzo does *not* yet do for a browser on a real BZFlag server.
`docs/proxy.md` is what it does: watching a live match, with the world, the
roster, the tanks, the flags, the shots and the chat all coming off the target.
This is the rest of issue #82 -- playing above all -- and it is kept current
with the code, so anything built is deleted from here rather than marked done.
Upstream references are paths under `$HOME/bzflag/`.

## An instance that proxies rather than hosts

Today a bzo both hosts its own game and proxies a target. The instance worth
building is one that does only the second: configured with servers rather than
a map, offering several at once -- the bzo on `bz.rikers.org` carrying the
bzfs on `bz.rikers.org:5154` over `127.0.0.1:5154`, a second test bzfs on
another loopback port, and a third on `192.168.12.x`, each listed and joined
separately. Hosting a game *and* proxying others needs a per-player world,
config, roster and clock, and buys nothing this does not.

Several targets cost little because a proxy holds no game state to partition.
The globals a second local map would force into a `Game` object (below) are
exactly the ones proxy mode deletes: no obstacles, no teleporter graph, no
zones, no world weapons, no bases, no clock, because none of it is simulated
for a proxied connection. What is per-target is a world to serve and a
connection to dial, and both of those already work.

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
the proxy dials, and it is private because a forwarded login only verifies
from a private address (`docs/proxy.md`). The key cannot be the dial target:
every proxy's is `127.0.0.1:5154`, which names nothing and collides across
instances. Never a
`host:port` a client supplies -- the map is also the login-return allowlist, so
an entry is the only thing that makes a target nameable at all.

A target with no published identity -- a test bzfs on a second loopback port,
or one on `192.168.12.x` -- has no `-publicaddr` to borrow, so its key is
whatever name the operator wants shown. The key only has to be unique within
the map and usable as a URL path segment, which a `host:port` already is
(`:` is legal in a path). The row's title and settings come from the target
itself either way, so a made-up key costs nothing in what a player sees.

**A target that is not publicized needs no token at all.** A bzfs with none of
`-publictitle`, `-publicaddr` or `-publickey` never checks a token
(`bzfs.cxx:4737`), so one an operator runs unlisted is the easy case rather
than an excluded one: it can be proxied with no global login in the path.
Requiring one is then the proxy's own policy, not bzfs's. An operator mixing a
public target with a private test one therefore gets global logins on the first
and not the second, without configuring either.

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

## A way in that is not a link

A `?proxy=` link is the way in today (`docs/proxy.md`), and it is the only
one. Two more, both of them the ones Map Viewer already has, because a proxy
is the same thing seen from further away: the same client, pointed somewhere
else.

- **A picker in the entry dialog**, beside the Map Viewer one, fed by a
  `proxies` list on `init` the way `viewableMaps` feeds that one. A player who
  has never seen a link picks a server from the instance's own list. Choosing
  one is a page navigation to its `?proxy=` link rather than a message on the
  live socket: the target is fixed when the socket opens -- `init` is
  synthesized from it -- and a navigation is what `/login` already does for
  the same reason.
- **A row on `/list`**, which is the section below.

**Several targets on one instance is the ordinary case, not the exotic one.**
A host running four `bzfs` on four local ports publishes one bzo and four
keys: `?proxy=example.org_5154`, `_5155`, `_5156`, `_5157`. Nothing about that
needs multi-world (below) -- the worlds are the targets', fetched and hashed
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
  which is unmistakably something its operator installed, and the global
  login every proxied player carries is what keeps them answerable.
- **Cheating.** A proxy hands anyone a BZFlag client they can modify in
  devtools, and bzo's anti-cheat does not run in proxy mode. BZFlag's client is
  open source too, but editing JavaScript and recompiling C++ are not the same
  bar. This wants a decision before the play path is built, not after.
- **Latency.** The proxy adds its own hop to bzfs's, and the token constraint
  pins it inside the target's network, so that hop is sub-millisecond and the
  player's total is browser-to-proxy -- the same order as a native client
  reaching a distant server. "Worst of both" describes a deployment the token
  check will not authenticate; see `docs/proxy.md`, "A proxy runs inside its
  target's network".

## Order of work

The list server comes last. It is discovery for something that has to work
first, it needs both ends of a bzo pair updated before a row appears, and
every step before it is cheaper against one hardcoded loopback target than
against a registry.

1. **Replace the hardcoded target with the `proxies` map**, plus its
   `/login/<target>` allowlist. Several targets first exist here, so this is
   also where voice gains its same-target precondition and the synthesized
   `init` starts naming a per-connection world hash, and where the entry
   dialog's picker gets a list to show.

2. **Add play.** The client's second authority mode (`killed`, `shotEnd`,
   `alive`, and grab/drop/capture/teleport as notifications), the
   dead-and-waiting state, the rejoin cooldown, holding the bzfs connection
   across a browser reconnect -- which also keeps a reconnecting player
   verified, since a token is answered once -- and the cheating decision,
   which wants settling before this lands rather than after.

3. **Trace a forwarded shot on the client.** A shot's path is client-side work
   upstream and bzo's client does not do it, so a proxied shot passes through
   a wall and a Laser arrives without its beam. This is the client learning to
   fly a shot it was given, not the proxy simulating one.

4. **Advertise to the list server.** Per-target report blocks, the bzo table's
   rows and its Proxied column, per-target liveness.

5. **Multi-world only if something wants two local maps on one host** -- never
   a prerequisite for any of the above, since several proxied targets are not
   multi-world.
