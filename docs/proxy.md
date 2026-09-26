# Proxying a real bzfs server

What bzo supports for letting a browser watch a match on an ordinary BZFlag
server. `docs/network.md` is the wire this rests on -- what bzo says, what
bzfs says, and where the two differ -- and `docs/proxy-plan.md` is what is
still unbuilt, playing above all. Upstream references are paths under
`$HOME/bzflag/`.

## The link

`?proxy=<host_port>` points the ordinary client at a proxied server:

```
https://bz.rikers.org/?proxy=bz.rikers.org_5154
```

The key is the target's public `host:port` as the BZFlag list server
publishes it, with the separator a URL can hold -- the same name its imported
world is already filed under (`remoteMapFileName`). It is a GET parameter
because the whole value of such a link is that it can be sent to somebody, and
it names the *match* rather than the wire: which address bzo dials to reach it
is the operator's business and appears nowhere a player can see.

A target bzo does not proxy is refused on the WebSocket with one sentence, not
quietly joined to this server's own game. The page itself is the ordinary
client, served from `/` as always, which is why the parameter is a query
rather than a path: the page is one file of relative asset references, and a
`/proxy/<target>` URL resolves every one of them a directory deep.

`?view=` and `?follow=` work on a proxy link as they do anywhere
(AGENTS.md, "`?follow=leader` is the link to hand somebody who wants to
watch"), and both survive a login.

## A proxy runs inside its target's network

**Not a preference -- the only deployment where a forwarded login works.**
bzfs does not check a token itself. It hands it to the list server along with
the address it saw on the player's connection, and my.bzflag.org compares that
with the address the token was issued to -- the browser's. A proxy breaks that
comparison by construction.

`isPrivate()` is the way through (`Address.cxx:121`): 127.0.0.0/8, 10.0.0.0/8,
172.16.0.0/12 and 192.168.0.0/16, hardcoded. For a peer on one of those, bzfs
omits the address from its question entirely (`ListServerConnection.cxx:413`)
and the list server checks the token with no address at all. Confirmed against
a real server: an unmodified bzfs answers "Global login approved!" to a token
forwarded from `127.0.0.1`.

Three consequences, and they are the shape of the feature rather than details:

- Same host is `127.0.0.1:5154`; same LAN or a VPN peer is a 10/8 or
  192.168/16 address. Same datacenter is not enough when both machines carry
  public addresses -- what counts is the peer address bzfs sees on `accept()`.
  Dialling the target's *public* name from the same host fails too, since the
  kernel picks a public source address for a public destination: the private
  address has to be configured, not resolved.
- **Only a server whose own operator installs the proxy can be proxied.** A
  stranger's public bzfs cannot carry a forwarded token in the first place --
  a far stronger consent property than a ban list, and it needs no
  coordination.
- The added hop is sub-millisecond by construction, so a proxied player's
  latency is browser-to-proxy, the same order as a native client reaching a
  distant server.

Where the check fails it is not a kick. The player loses their global identity
and plays unverified, which on a registered callsign also earns bzfs's "This
callsign is registered. You must use global authentication."

## What a proxy connection is

**Not a player in this server's game.** A proxied socket is never in
`players`, so nothing here simulates for it, broadcasts to it or scores it.
bzo stops being a game server for that connection and becomes a codec: no shot
simulation, no hit detection, no flag logic, no scores, no clock, no rabbit,
no anti-cheat. Each browser gets its own `BzfsSession`
(`server/bzfs-session.cjs`) and therefore its own connection to the target,
because bzfs allots a `PlayerId` per connection and has no multiplexing.

**Ids are the target's.** bzo numbers players out of upstream's own space
(`docs/network.md`, "Player ids"), so the slot the target calls 3 is the slot
bzo calls 3 -- no table, no translation, and an id-taking command names the
same player on both.

**The world is the target's, through the existing importer.** It is the same
`import-<host>_<port>.bzw` cache and the same hashed delivery Map Viewer
serves, so a target imported within the hour costs a second viewer nothing.

**The callsign is never the client's to choose.** In order: the one the
weblogin callback named, for a browser that has just signed in; then a bzo
session's; then a numbered `bzo-view-N`. The motto the target's player list
shows is `via https://<this bzo>`, which is the one thing the operator on the
other end cannot work out for themselves.

## What crosses

The connection is held open, and `init` is synthesized from what bzfs tells a
joining player -- the roster, the team scores, the flags, the clock, the
server's own greeting -- rather than from anything bzo holds.

| From the target | To the browser |
|---|---|
| `MsgAddPlayer` / `MsgRemovePlayer` | `playerJoined` / `playerLeft` |
| `MsgPlayerUpdate`, `MsgPlayerUpdateSmall` | `pmBatch`, one batch per 20Hz tick |
| `MsgAlive` / `MsgKilled` / `MsgPause` | `alive` / `killed` / `playerPaused` |
| `MsgFlagUpdate` / `MsgGrabFlag` / `MsgDropFlag` / `MsgTransferFlag` / `MsgCaptureFlag` | the same names bzo already uses |
| `MsgShotBegin` / `MsgShotEnd` | `shotBegin` / `shotEnd` |
| `MsgScore` | `playerUpdated` -- bzo carries scores on the record |
| `MsgPlayerInfo` | the `-`, `+` and `@` beside a callsign |
| `MsgTeamUpdate` / `MsgTimeUpdate` / `MsgNewRabbit` | `teamUpdate` / `timeUpdate` / `newRabbit` |
| `MsgMessage` | `message` |
| `MsgLagPing` | answered, not forwarded |

The browser sends only chat. Everything else a client can say is about
playing, and is dropped rather than answered.

## The two conversions

**Coordinates.** bzfs is right-handed with +Y north and +Z up; bzo is
three.js's, -Z north and +Y up. `x` is `x`, `y` is bzfs's `z`, `z` is minus
bzfs's `y` -- the same change the world importer makes as it reads a `.bzw`
(`docs/bzw.md`, "Coordinates"). A heading is a quarter turn apart: bzfs
measures counter-clockwise from +X, and a bzo rotation is a three.js rotation
about Y whose zero faces -Z.

**Inputs, not velocities.** bzfs sends the velocity a tank has; bzo's `fs` and
`rs` are the *inputs* a client would have held, as a fraction of the tank's
top speed and turn rate, because that is what the receiving client
dead-reckons with between updates. So the fraction is recovered against the
very numbers that client will multiply back by: this server's config with the
target's own map laid over it, which is where the target's `-set` lines
already are.

## Where one end is silent

Upstream expects every client to simulate a shot for itself, so it says less
than bzo's client needs to hear, and the proxy keeps the clock for it.

- **A shot that runs out of life ends with no message at all.** Every upstream
  client stops drawing it when its `lifetime` is up, where bzo's client
  removes a projectile only when the server ends it. The proxy sends the
  ending itself, at the shot's own lifetime or the world's edge, whichever
  comes first, and sends it as reason 1 -- both wires spend that byte the same
  way, `0` meaning "show the explosion", so a shock wave fades rather than
  going off.
- **A liveness change is not in a position update.** A `pmBatch` says where a
  tank is and not whether it is in the game, so a tank already alive when a
  connection opened -- one whose `MsgAlive` nobody here was present for --
  would stay dead on the roster, and the roaming views follow only living
  tanks. A change of state sends a roster update.
- **A flag's owner is stale on the wire.** bzfs leaves the packed owner where
  the last carrier left it, so carried is read off the *status*, as upstream's
  own client reads it. The same test decides which superflags are
  unidentified: bzfs masks those as Phantom Zone for everybody, admin or not,
  and bzo shows them as unidentified exactly as it does its own.

## Transport

The proxy terminates one WebSocket and dials both of bzfs's transports: TCP,
and a UDP link on the same port opened by sending `MsgUDPLinkRequest` from the
socket that will receive on it. The link is up before the join finishes, not
because watching needs it but because a good client has one -- bzfs
disconnects any non-bot player who fires over TCP (`bzfs.cxx:5596`), and the
bulk messages are the ones that ride it. Co-location is what makes it cheap:
over loopback there is neither the loss nor the head-of-line blocking UDP
exists to dodge.

Lag pings are answered rather than forwarded. bzfs counts the ones that come
back and kicks a client that stops answering (`lagKick`, `bzfs.cxx:4378`).

## Signing in to a proxied server

`/login/<host_port>` runs the bzflag.org weblogin and **deliberately does not
call `CHECKTOKENS`**. A token is answered once, so checking it here would
spend the very thing the target needs. bzo holds it in memory against a
short-lived `bzo_proxy_login` cookie and returns the browser to the match; the
next WebSocket to that target carries it into `MsgEnter`, and bzfs verifies it
with the list server. The verdict arrives as a chat message the player is
already reading.

It is deliberately not a bzo session. Sessions are written to `sessions.json`,
and a live credential does not belong in a file; and a session means bzo
verified a callsign, which is exactly what a proxy login is not -- the
verifying is the target's. For the same reason the `-`/`+`/`@` marks come from
the target's `MsgPlayerInfo` rather than from bzo assuming its token worked.

`/login/<host_port>[/<view>]` and `/logout/<host_port>[/<view>]` return to the
match being watched rather than to this server's own game, carrying the roam
view in the path because bzflag.org's callback may hold only one query
parameter. `/login/probe-<host_port>` is the diagnostic that proves a new
target will accept a forwarded token at all: it joins, reads the verdict, and
prints it as plain text without creating a session.

## What is not supported

- **Playing.** A proxied browser watches. Nothing a client says about moving,
  shooting or grabbing is forwarded, because bzfs is client-authoritative for
  exactly those things and bzo's client has never had to say them. That is the
  bulk of `docs/proxy-plan.md`.
- **A shot's path.** Tracing a shot against the world is client-side work
  upstream, and bzo's client does not do it, so a proxied shot passes through
  a wall it should have stopped at, and a Laser arrives without the segments
  bzo draws a beam from.
- **A reconnect stays verified.** bzflag.org answers a token once, so the
  browser's next connection rejoins unverified.
- **More than one target, chosen anywhere but the URL.** The allowlist is
  `PROXY_TARGETS` in `server.js`, hardcoded, with no picker and no list row.
- **An operator surface that knows it is proxied.** A proxied admin is shown
  bzo's own operator panel because the target says they are an admin. It is
  display only -- those messages are dropped -- but it should not be offered.
