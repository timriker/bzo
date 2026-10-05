# Proxying a real bzfs server

What bzo supports for letting a browser watch a match on an ordinary BZFlag
server. `docs/network.md` is the wire this rests on -- what bzo says, what
bzfs says, and where the two differ -- and `docs/proxy-plan.md` is what is
still unbuilt, playing above all. Upstream references are paths under
`$HOME/bzflag/`.

## The link

`?proxy=<host_port>` points the ordinary client at a proxied server:

```text
https://<this bzo>/?proxy=example.org_5154
```

The name is a key of the `proxies` map below, spelled the way a URL should
spell it: `host:port` is the identity everywhere a person reads it -- the
config, the list row, the Map column -- and the link writes the port after
an underscore, because a `:` comes back from an address bar as `%3A` and a
link is made to be shared. It is the same spelling the cached world already
uses (`import-<host>_<port>.bzw`), so a link and a file read alike. One
derivation, `proxyUrlKey`, sits between the two.

It is a GET parameter because the whole value of such a link is that it can be
sent to somebody, and it names the *match* rather than the wire: which address
bzo dials to reach it is the operator's business and appears nowhere a player
can see.

A target bzo does not proxy is refused on the WebSocket with one sentence, not
quietly joined to this server's own game. The page itself is the ordinary
client, served from `/` as always, which is why the parameter is a query
rather than a path: the page is one file of relative asset references, and a
`/proxy/<target>` URL resolves every one of them a directory deep.

`?view=` and `?follow=` work on a proxy link as they do anywhere
(AGENTS.md, "`?follow=leader` is the link to hand somebody who wants to
watch"), and both survive a login.

## Which servers an instance may proxy

`proxies` in `server.json`, from the name a player sees to the address bzo
dials:

```json
"proxies": {
  "example.org:5154": "127.0.0.1:5154",
  "my-test:5155":     "192.168.12.20:5155"
}
```

Both are needed because they are different addresses. The key is the
identity: for a publicized target it is exactly the `host:port` the public
BZFlag list carries -- its own `-publicaddr` -- so the bzo row and the bzflag
row read the same string and a player comparing them sees one server. It is
also what the world is filed under (`import-<host>_<port>.bzw`), so a shared
`?viewmap=` link names something another bzo could re-ask; a dial address
would not, since every proxy's is `127.0.0.1` and names nothing. A target with
no published identity -- a second loopback port, a LAN address -- has no
`-publicaddr` to borrow, so its key is whatever label the operator wants
shown, and its title and settings still come from the target itself.

A value may be an object instead, for a target that needs more than an
address. `requireLogin: false` lifts the verified-player rule below for that
one target, which is what a test server wants:

```json
"proxies": {
  "bz.rikers.org:5154": { "address": "127.0.0.1:5154", "requireLogin": false }
}
```

The map is the allowlist, and the only thing that makes a target nameable:
`?proxy=`, `/login/<name>` and `/logout/<name>` all refuse a name that is not
a key -- under its link spelling, and a refusal names the ones that are -- so
a client cannot aim this instance at a host the operator did not choose. An
entry whose name or address is not `<host>:<port>` is refused at boot and
logged; an entry whose dial address is not private is kept and warned about,
since a target that is not publicized never checks a token anyway.

The import a proxy makes is authorized by this map rather than by the public
BZFlag list: the name comes from the key, the address from the value, and the
permission from the config. Map Viewer's own `?viewmap=` import is unchanged
and still refuses a host the public list does not carry -- that address comes
from a client, and the check is what stands between it and an arbitrary
outbound connection.

## Watching a server this instance does not proxy

`proxies` is the operator's list of servers a browser may *play* on. Watching
is a separate thing with a separate rule: `?watch=<host>_<port>` reaches any
server on the public BZFlag list, as an observer -- or, with `&team=`, plays
there as a guest (below).

It is not a second implementation. A watch is a proxy with the team forced and
the token withheld, so both spellings resolve into one request and only the
authorisation differs. Nor is the connection new: `performRemoteMapImport`
already joins any listed server as an observer to take its world and leave,
and watching is that same connection not hung up.

**Who may.** An admin of this instance: a signed-in member of `adminGroups`,
or a local admin (`localAdmin`, this machine or the whitelist). Admin is the
gate on connecting somewhere the instance's own operator never configured. A
signed-in watcher is shown as the forum callsign bzo verified; a local admin
with no login as a `bzo-view-<tag>` with a random tag, which claims to be
nobody and cannot collide with another viewer's name. The
session is checked before any network work, and a public list that could not
be fetched refuses rather than allowing -- a check that did not happen is not
a check that passed.

**What the target sees.** The verified forum callsign, a motto of
`via <this bzo>`, and the ordinary bzo version string. It cannot verify the
callsign and marks the player unverified regardless, so its scoreboard shows
`-` rather than `+`; what the motto gives an operator is the instance to
address, which is the same trust model the rest of this document rests on. A
player's own motto is never forwarded -- that field is one of the few ways
the connection announces itself, and it says only that.

**What a watcher can do**, decided by bzfs rather than by anything here:

- **Not spawn.** `isAllowedToEnter` is `verified || !isRegistered()` and gates
  `playerAlive` (`Permissions.cxx:129`, `bzfs.cxx:3199`). A watch connection
  never sends `MsgAlive` either, so it does not provoke a kick to explain.
- **Nothing privileged.** Groups are granted only inside `if (verified)` once
  the list server approves a token (`ListServerConnection.cxx:263-276`), so a
  watcher holds none. `/` lines pass straight through and the target answers:
  `/msg`, `/serverquery` and `/uptime` work; `/report`, `/clientquery`,
  `/playerlist` and `/set` are refused in bzfs's own words.
- **Chat, where that server allows it.** bzfs itself puts no verification
  check on `MsgMessage` (`bzfs.cxx:5024`), but servers configure this: Planet
  MoFo relays a watcher's chat, while a server set up to withhold messaging
  from unauthenticated observers refuses it and says so. That refusal is an
  ordinary server message and reaches the browser like any other, so nothing
  here has to explain it. Watching works on both.

**Playing as a guest.** `&team=` (the /list row's **Play**) enters on that
team as `bzo-<callsign>`, unregistered. A forum callsign is registered, and
bzfs removes a registered name that has not identified the moment it spawns;
the token that would identify it cannot be forwarded to a server outside this
instance's network (above). An unregistered name spawns wherever the server
lets guests spawn, which is upstream's default and which an operator turns off
in the groups file (`EVERYONE: -SPAWN`) or with a plugin. Nothing published
says which, so bzo finds out ("Guest access", below), and a row it knows
refuses guests offers no Play.

**Bans are collective here, unlike playing.** A proxied *player* carries a
real token, so a target can `/idban` one of them by BZID. A watcher carries
none and never can, so the only lever is an address ban, which takes every
watcher from that instance at once.

Whether observers are accepted at all is knowable without connecting:
`observerMax` is the sixth entry of the ping's `teamMaximums`, which the
public list already carries.

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
- **Only a server whose own operator installs the proxy can carry verified
  players.** Anyone can point a proxy at a stranger's public bzfs and it will
  work: it is an ordinary client connection. It is not a covert one -- the
  version string and the motto both name this bzo, by design ("What a target
  operator sees") -- but saying who you are is not the same as being let in.
  What cannot follow is the forwarded token, so every player arrives
  unverified, which is a watcher's inconvenience and a player's wall. So
  proxying a stranger's server is a thing an operator would object to rather
  than a thing they are protected from, and their lever against it is the same
  address ban it has always been.
- The added hop is sub-millisecond by construction, so a proxied player's
  latency is browser-to-proxy, the same order as a native client reaching a
  distant server.

Where the check fails it is not a kick, at least not at the door. The player
loses their global identity and joins unverified, and a registered callsign
earns bzfs's "This callsign is registered. You must use global
authentication." on the way in (`bzfs.cxx:2560-2567`) -- a message and nothing
more. The wall is the first spawn: `playerAlive` asks
`accessInfo.isAllowedToEnter()` and removes an unidentified player outright
for "unidentified" (`bzfs.cxx:3199-3205`). So an unverified proxy can watch a
stranger's server indefinitely and cannot play on it for a second, which is a
distinction that only starts to bite once there is a play path at all
(`docs/proxy-plan.md`).

## Being listed

An instance reports its targets to bzo's list server (`docs/list-server.md`)
as a `proxies` block on its ordinary report, and `/list` draws one row per
*game*: the instance's own, and one per target.

A proxied row carries that target's whole game -- counts, shot limit, style,
every option bit -- read off the target rather than off the bzo carrying it.
The **Map** column is the one difference, and it is one column because a row
is one thing or the other: the map a bzo runs, or the server it proxies. The
URL is the instance either way, and the link is its `?proxy=` for the target.

The numbers come from `MsgQueryGame` and `MsgWantSettings` on a connection
that never enters the game, so they cost the target nothing, show in nobody's
chat, and work for a target on no public list. Only the title comes from
elsewhere, since a dial cannot ask for one. Targets are dialled on the
report's cadence, never per join or part -- that would be a round trip per
target per arrival.

**Liveness is per target.** A target that did not answer the last dial leaves
the table while its instance's row stays, on the same rule a stale instance
gets: a row is an invitation, and that one leads nowhere. Registration is
unchanged -- one key per instance, and one callback proves every target.

**Two instances may carry the same target.** Two registrations, two rows, one
match: their counts are identical rather than additive, which is what the Map
column stops anybody mistaking for two servers.

## What a target operator sees

Every proxied player arrives from the same private address, so a target
operator cannot tell them apart by address at all: `/kick` and `/mute` are
per-`PlayerId` and still reach one player, but `/ban` reaches all of them or
none. `/idban`, `/idunban` and `/idbanlist` (`BanCommands.cxx:209-213`) ban by
BZID and survive a callsign change, which is the per-player lever -- and it
works precisely because a co-located proxy is where a forwarded token
verifies. A proxy that admitted only verified players would therefore make
every one of them individually accountable, which is a stronger guarantee than
a native client gives, since bzfs otherwise admits unregistered players.

`MsgEnter` carries a client version string (`getAppVersion()`,
`ServerLink.cxx:690`), and a proxy puts its own there -- the release, the
build id, then `-bzo-web`, in upstream's own shape -- so who arrived by bzo,
on which version, is visible without anybody inventing a mechanism. bzfs reads
the leading three numbers and keeps the string as typed, and `/clientquery`
prints it. The motto beside the callsign says which bzo they came through.

Between the two, an operator who wants no proxied players can see them and
can refuse them, and that is the intended end state rather than a gap. A
proxy that could not be refused would be the problem; being announced is what
makes refusing it possible.

**bzo's own anti-cheat does not run here, and cannot.** A proxied connection
is not in this server's game: nothing on this side simulates a shot, decides a
hit or validates a position, because bzfs does all of that and believes its
clients. So a proxy hands anyone a BZFlag client they can modify in devtools.
BZFlag's client is open source too, but editing JavaScript and recompiling C++
are not the same bar, and pretending otherwise would be worse than saying it.

Nothing on this side can close that, so the answer is accountability instead
of enforcement, which is the rule below.

**Only a verified player plays.** A connection carrying no global login joins
as an observer whatever team its link asked for, and is told why. bzfs would
admit it as a player itself -- this is the proxy's courtesy, not the target's
rule -- and what it buys the operator is that every proxied player is
answerable by a BZID, so `/idban` reaches one of them where `/ban` would reach
all of them. An operator who does not want the policy edits their own bzo: it
is a default, not a boundary, and `requireLogin: false` on a target turns it
off there. A registered callsign gets the same answer for a second reason,
since it could not have spawned anyway -- and keeps getting it on a target
that does not require a login.

## What a proxy connection is

**Not a player in this server's game.** A proxied socket is never in
`players`, so nothing here simulates for it, broadcasts to it or scores it.
bzo stops being a game server for that connection and becomes a codec: no shot
simulation, no hit detection, no flag logic, no scores, no clock, no rabbit,
no anti-cheat. Each browser gets its own `BzfsSession`
(`server/bzfs-session.cjs`) and therefore its own connection to the target,
because bzfs allots a `PlayerId` per connection and has no multiplexing. One
consequence worth knowing before an instance carries a crowd: every broadcast
the target sends arrives once down each socket, so the proxy reads N copies of
it. Wasteful, harmless, and exactly why nothing here needs mirroring.

**Ids are the target's.** bzo numbers players out of upstream's own space
(`docs/network.md`, "Player ids"), so the slot the target calls 3 is the slot
bzo calls 3 -- no table, no translation, and an id-taking command names the
same player on both.

**The world is the target's, through the existing importer.** It is the same
`import-<host>_<port>.bzw` cache and the same hashed delivery Map Viewer
serves, so a target imported within the hour costs a second viewer nothing.

**The callsign is never the client's to choose.** In order: the one the
weblogin callback named, for a browser that has just signed in; then the
session's, which is that same name on every connection after the first; then a
random `bzo-view-<6 hex>` for a browser that has never signed in. The motto the
target's player list shows is `via https://<this bzo>`, which is the one thing
the operator on the other end cannot work out for themselves.

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

And back the other way. Everything a browser declares about its own tank is
forwarded, because bzfs is client-authoritative for exactly those things: it
checks what a client says and relays it, rather than deciding it.

| From the browser | To the target |
|---|---|
| `m` | `MsgPlayerUpdate`, at the target's own `MaxUpdateTime` |
| `shoot` | `MsgShotBegin`, preceded by a position update |
| `grabFlag` / `dropFlag` / `captureFlag` | `MsgGrabFlag` / `MsgDropFlag` / `MsgCaptureFlag` |
| `tp` | `MsgTeleport`, by upstream's own face numbering |
| `pause` | `MsgPause` |
| `killed` / `selfDestruct` | `MsgShotEnd`, `MsgDropFlag`, `MsgKilled` -- see below |
| `lockTarget` | `MsgGMUpdate` |
| `message` | `MsgMessage`, converted to ASCII |
| `identify`, `nearFlag` | answered by the browser itself, not sent |

**A shot claims the flag the target has on record for it.** bzfs corrects a
shot's flag in its own table but rebroadcasts the packet it was sent unless
something else already repacked it (`shotFired`, bzfs.cxx), so a shot that
claims nothing reaches every other client as an ordinary bullet whatever the
shooter is holding. The claim is read off this connection's own flag state,
which is bzfs's answer echoed back, so it cannot disagree with the check that
kicks for a mismatch. A shock wave also fires from under the tank with no
velocity, which the target enforces by refusing any other.

`identify` and `nearFlag` are the two bzo asks its own server and a target has
no message for: bzo decides a lock and searches for a flag underfoot, where
upstream's client decides both for itself and says so afterwards. So on a
proxied connection the browser answers them, with the same shared code the
server would have used (`pickTargetInSights`, `collision.mjs`).

**A guided missile's lock is the browser's, and it must not read it back.**
This is the trap the whole outbound half sets: the target relays what it is
told, so anything the client decided arrives back looking like an answer.
Three places have to refuse it. `MsgShotBegin` carries no target field for
anybody -- `FiringInfo::pack` is time, shot, flag and lifetime -- so the echo
of your own shot would clear the lock it was fired under. bzfs rebroadcasts a
`MsgGMUpdate` to the sender as well, so the echo of your own lock would undo
the next lapse. And `lastTarget` is `NoPlayer`, 255, never absent: a missile
chasing nobody still writes that byte.

The lock lapses the way upstream's does and as permanently: a target that dies
or takes `ST` is dropped outright rather than followed again if it comes back
(`GuidedMissleStrategy.cxx:168`). A missile already in the air says so on its
next step, which is also the only thing that ever sends a target -- upstream
sends from the missile rather than from the key press, and so a lock taken
with nothing in the air costs no packet at all.

## Dying is the browser's to declare

bzo is server-authoritative and bzfs is the reverse, and nowhere is the gap
wider than here: **bzfs never decides that a tank died.** It takes the
victim's word for it (`playing.cxx:3967`) and asks nothing. A tank nobody
reports dead stays alive forever -- shot at, driven through water and parked
on death pads, with nothing happening.

So a proxied browser runs upstream's own `LocalPlayer::checkHit` and
`checkEnvironment` against its own tank, and reports all six deaths upstream
sends: a shot, a run-over, genocide, self-destruct, water and a death pad. The
rules are not a second copy -- `getShotTankHit` and `shockWaveHitsTank`
(`shots.mjs`) are the very functions this server decides its own game's hits
with, asked of one tank instead of every tank.

Three details of the order, which is upstream's and is load-bearing:

- **The shot is ended first**, so that dropping a Shield flag cannot leave the
  same shot free to hit again (`playing.cxx:4164`). Only a shot that is
  *stopped* by hitting something: a laser, a thief's beam and a shock wave all
  pass through their victim, and ending one would claim it stopped while
  everyone else can still see it going.
- **The flag drops before the kill**, so bzfs records where it fell rather than
  where the tank respawns.
- **A Shield sends the first two and no kill at all.** That also balances the
  `endShot` anti-cheat exactly: `MsgShotEnd` raises `endShotCredit` and notes a
  Shield held at that moment, `MsgKilled` lowers it again, and so does dropping
  that Shield. Drop first and the credit leaks -- three saves and the target
  kicks the player for "wrong end shots".

**Chat out is converted to ASCII.** bzfs reads a message a byte at a time and
asks `TextUtils::isVisible` of each (`isSpamOrGarbage`, `bzfs.cxx:4474`),
whose character classes stop at 126 -- so a single accent is enough to be
kicked for "a garbage message". A native client never meets this because its
own text input cannot produce one; a browser can type anything. So accents are
folded to their letters (`está` leaves as `esta`) and anything with no ASCII
spelling is dropped, and the player is told once per connection rather than
disconnected. bzo's own chat is untouched by this: it is JSON over a
WebSocket, and it carries whatever you type.

**A long chat line goes out as several.** A bzfs message holds 127 bytes of
text (`MessageLen` less its NUL, `global.h:35`), which is where a native
client's input stops. A browser's does not, so after the ASCII conversion a
longer line is split, each piece broken at the last space that fits
(`splitBzfsChat`). An action's pieces each start with `/me`. A slash command
is sent whole, since a second piece would arrive as chat; bzfs keeps the first
127 bytes, and the player is told once.

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
  going off. A beam is the exception: the wire carries a reload time rather
  than a beam's own short life, so the client expires it on its own clock.
- **A liveness change is not in a position update.** A `pmBatch` says where a
  tank is and not whether it is in the game, so a tank already alive when a
  connection opened -- one whose `MsgAlive` nobody here was present for --
  would stay dead on the roster, and the roaming views follow only living
  tanks. A change of state sends a roster update.
- **A flag's owner is stale on the wire.** bzfs leaves the packed owner where
  the last carrier left it, so carried is read off the *status*, as upstream's
  own client reads it. The same test decides which superflags are
  unidentified: bzfs masks those as Phantom Zone for everybody, admin or not,
  and bzo shows them as unidentified exactly as it does its own. What names
  them is `/flag show`, whose reply is text and nothing else on both servers
  -- and the client reads that text either way, so a proxied operator's map
  fills in like anyone else's.

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

The token is deliberately not in a bzo session: sessions are written to
`sessions.json`, and a live credential does not belong in a file. The
**callsign** is a session, with no BZID on it, because a name is not a
credential -- it is what this browser is called over there, and it should
survive a reconnect and a restart even though the verification cannot. A
session with no BZID grants nothing in bzo's own game, which is the whole
point: bzo checked nothing, so bzo claims nothing. For the same reason the
`-`/`+`/`@` marks come from the target's `MsgPlayerInfo` rather than from bzo
assuming its token worked.

`/login/<host_port>[/<view>]` and `/logout/<host_port>[/<view>]` return to the
match being watched rather than to this server's own game, carrying the roam
view in the path because bzflag.org's callback may hold only one query
parameter. `/login/probe-<host_port>` is the diagnostic that proves a new
target will accept a forwarded token at all: it joins, reads the verdict, and
prints it as plain text without creating a session.

## What is not supported

- **Voice.** Nothing about it crosses. Voice never touches the bzfs wire, so a
  proxied player is in a match with people they cannot be heard by; what that
  should mean is in `docs/proxy-plan.md`.
- **A dead-and-waiting state.** bzo respawns on a timer and never asks;
  upstream leaves a dead player dead until they press something. A proxied
  player dies and comes back without being consulted.
- **A reconnect stays verified.** bzflag.org answers a token once, so the
  browser's next connection rejoins under the same callsign but unverified --
  which a registered callsign earns bzfs's "You must use global
  authentication" for. Holding the bzfs connection across a browser reconnect
  is what fixes it, and it is in `docs/proxy-plan.md`.
- **An operator surface that knows it is proxied.** A proxied admin is shown
  bzo's own operator panel because the target says they are an admin. It is
  display only -- those messages are dropped -- but it should not be offered.

## Guest access

Whether a player with no bzflag.org login may chat or spawn on a server is a
permission in that server's own groups file or a plugin, and no ping, list
entry or BZDB variable carries it. So the world tracker
(`server/bzfs-worlds.cjs`) asks, during the observer join it already makes
for a world's variables, and /list shows the answer as **Guests Watch** or
**No Guests**, **Guests Play** or **Registered Only**, and **Guests Chat** or
**Guests Muted**:

- **Watch**: whether that unregistered join is let in at all. A refusal for
  a full server or a ban says nothing either way; any other, such as a
  plugin's `bz_eAllowPlayer`, is **No Guests**. Registered Only still lets
  guests watch: bzfs checks the spawn permission only when a tank spawns.
- **Chat**: one private message to itself, which bzfs returns to the sender
  alone. bzfs checks `TALK` and then `PRIVATEMESSAGE` and names the one it
  refused. Never a public line: chat relay plugins carry public chat to IRC
  or Discord even from an empty game.
- **Spawn**: only on a server with no players or observers on it, joining as
  a player instead and sending one `MsgAlive`; the tank spawns or bzfs refuses
  (`playerAlive`, bzfs.cxx:3211), and the visit ends at once.
- **When**: with every import, which happens anyway when a world changes; on
  its own otherwise, a month after the last answer or sooner if the list
  entry changes, a week after a check that got no answer, and no more than
  one such visit every ten minutes across the whole list.
- **For free**: a guest's real visit through the proxy records what bzfs did
  -- spawned it, refused it, echoed or refused its chat.

The visitor is `bzo-import` with the motto `bzo server check --
<publicUrl>/list`, so an operator who sees it knows where the answers are.
