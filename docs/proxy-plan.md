# Proxying a real bzfs server

Nothing here is built. Issue #82: let a browser play, or watch, on an ordinary
`bzfs` server through a bzo instance. `docs/network.md` is the protocol
reference this plan assumes -- what bzo says on the wire, what bzfs says, and
where the two differ. Upstream references are paths under `$HOME/bzflag/`.

## What already exists to build on

- **A partial bzfs client.** `server/remote-world-import.cjs` dials a server's
  TCP port, completes the `BZFS0221` handshake, and asks `MsgQueryGame`,
  `MsgWantSettings`, `MsgWantWHash` and `MsgGetWorld`, decoding the binary
  world into bzw text. It deliberately never sends `MsgEnter`, so it never
  occupies a player slot.
- **Hashed world delivery.** A parsed map becomes `/maps/<hash>.json`,
  `immutable`, which any client can fetch. See AGENTS.md, "Hashed, cacheable
  world delivery".
- **The global login.** `/login` already runs the `my.bzflag.org` weblogin and
  `CHECKTOKENS` round trip (`docs/login.md`).
- **Dialling real servers routinely.** `docs/list-server.md`.
- **A client that renders a world it is not playing in.** Map Viewer.

## The shape: one instance, one server

An instance is configured to proxy one bzfs server rather than to host a map.
The alternative -- a bzo instance that hosts its own game and proxies others
per player -- needs per-player world, config, roster and clock, and buys
nothing this does not.

The state question resolves harder than "mirror upstream's config". Each
browser gets its own bzfs connection, so each browser receives the real roster,
scoreboard, flags and clock down its own socket. **There is nothing for the
proxy to mirror.** It stops being a game server and becomes a codec: no shot
simulation, no hit detection, no flag logic, no scores, no match clock, no
rabbit, no anti-cheat.

What it does hold is small:

- **The world**, fetched once at boot -- not per player -- through the existing
  importer, hashed, and served like any other map. Every proxied player shares
  it.
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
weblogin.

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

**The operator picks.** An allowlist in `server.json`, never "any host:port a
client names." `bz4.rikers.org` is ours, so proxying it needs nobody's
permission.

**An admin who does not want it bans our address.** That is a good property:
the opt-out works today, needs no coordination, no upstream patch and no
negotiation. A proxy that could not be refused would be the problem.

**But a blanket address ban is otherwise their only tool, and that is the bad
half.** `/kick` and `/mute` already work on a single proxied player, because
those are per-`PlayerId`. `/ban` is per-address, so banning one proxied player
bans every one of them, and a server is left choosing between tolerating
somebody and evicting everyone who arrived by web.

**Requiring a forum login for every proxied player fixes that.** bzfs already
has the mechanism: `/idban`, `/idunban` and `/idbanlist`
(`src/bzfs/BanCommands.cxx:209-213`) ban by BZID and survive a callsign change.
A proxy that refuses to carry an unregistered player makes every proxied player
accountable by an id the target operator can act on individually -- a stronger
guarantee than a native client gives, since bzfs otherwise admits unregistered
players unless the operator sets `-requireidentify`.

The token is single use and is spent at `MsgEnter`, so a bzo session cannot be
reused as a bzfs token: the proxy obtains a fresh one per bzfs join. That is
the issue's "second weblogin", and requiring it is a feature rather than a
cost.

`MsgEnter` also carries a client version string (`getAppVersion()`,
`ServerLink.cxx:690`). A proxy puts its own there, so an operator can see who
arrived by bzo without anybody inventing a mechanism.

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

**Scoping is what actually needs building**, and only once an instance holds
more than one game. A channel belongs to a game, not to an instance:
`areVoicePeers` already has two symmetric preconditions -- same channel, then
the channel's own rule -- and same-game becomes a third, with `getVoicePeers`
filtering the roster by game first. Under whole-instance proxy mode there is
exactly one game and voice works unchanged. Voice is what forces the question
first, because All's hint is a literal promise ("Every player on the server,
however far away") that becomes false the moment there are two games.

Cross-game voice is deliberately out of scope. It breaks "voice comes from
where the speaker is standing" -- no shared space, so it has nowhere to come
from and would have to be flat. If it is ever wanted it is a fourth, explicitly
non-spatial channel, additive rather than a change to the three.

## Multi-world is a fork, not a next step

Whole-instance proxy mode makes per-player game state *unnecessary*, so it
brings nothing toward hosting several games at once. The two designs pull
apart:

- **Whole-instance proxy** -- delete server-side game state. The cheapest path
  to issue #82.
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

- **Shared address.** Every proxied player comes from the proxy's address. To
  the target server the proxy looks like one host running many clients, which
  is also what a cheat proxy looks like. The BZID requirement above is what
  makes that tolerable.
- **Cheating.** A proxy hands anyone a BZFlag client they can modify in
  devtools, and bzo's anti-cheat does not run in proxy mode. BZFlag's client is
  open source too, but editing JavaScript and recompiling C++ are not the same
  bar. This wants a decision before the play path is built, not after.
- **Latency.** The proxy adds its own hop to bzfs's. The mitigation is
  placement: run the proxy in the same datacenter as the target and the added
  hop is about a millisecond, leaving the player's total at browser-to-proxy --
  the same order as a native client reaching a distant server. "Worst of both"
  only holds when a proxy is far from its target.

## Order of work

1. **Observer-only, whole-instance.** An observer never sends state, so none of
   the authority inversion applies and none of the respawn work does either. It
   reuses the importer, and the latency budget tolerates it. Delivers "watch
   any real server, in a browser or a headset."
2. **Add play to it.** This is where the client's second authority mode, the
   dead-and-waiting state, the connection-held-across-reconnect rule and the
   cheating decision all land.
3. **Multi-world when something actually wants two games on one host** -- not
   as a prerequisite for either of the above.
