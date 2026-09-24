# Tutorial mode and offline play

Plan for issue #129: what an installed client does when the server it was
installed from is unreachable, and what tutorial levels are built on top of
that. Upstream references are paths under `$HOME/bzflag/`.

Only the caching step is built. Everything from "Say so" down is a plan.

## What an offline launch does today

The service worker precaches the shell -- `index.html`, `client.js`,
`styles.css`, Three -- and caches everything else on first use, so the page
itself loads with no server. Then `connectToServer` opens a WebSocket to the
same host, it fails, and `ws.onclose` schedules another attempt in three
seconds, forever. The entry dialog's server name, description and MOTD are
filled from the `init` message, so it never fills. The player is left on
"Loading World / Connecting render systems..." with nothing saying why.

`/manifest.webmanifest` is deliberately never intercepted, so a cold first
visit with no network cannot install either. That is correct -- the manifest is
generated per request and names the server -- and it is not worth changing.

## Stage 1: say so

Honest text on the loading overlay once a connection attempt has failed, rather
than a spinner that means "connecting" and "there is nothing to connect to"
equally. Independent of everything below, and worth doing on its own.

## Stage 2: free drive on the last map

The world is already in the browser. `init` carries a `worldRef` of
`{url, hash}` and the client fetches the world itself (`loadWorldFile` in
`public/client.js`), from `/maps/<12 hex>.json` -- express serves that URL space
out of `cache/maps/`, where a file is named for its own content hash and
answered `immutable`. `public/sw.js` serves `/maps/` cache-first for exactly
that reason, so a map the player has seen is on disk and needs no request.

**What is missing offline is the pointer, not the payload.** `worldRef` arrives
inside `init`, over the socket that is down. Two ways to hold one without the
server:

- Remember the last `worldRef` in `localStorage`. Gives the player the map they
  were actually on, and costs nothing until it is needed.
- Pin a tutorial map's hash in the worker's `PRECACHE`. Survives the cache wipe
  a build-id change performs, which the incidental copy does not, and is what a
  tutorial needs anyway: a map whose layout the lesson can depend on.

A tutorial wants both. With a `worldRef` in hand, the client synthesizes an
`init` and `applyWorldData` runs unchanged -- Map Viewer already builds a world
from a URL with no match behind it, and already has a driveable phantom tank
(issue #68). The socket sites are already guarded by `ws.readyState` checks;
what they need is for the absence of a socket to be an expected state rather
than a failed one.

**This must not fight the reconnect loop.** Auto-rejoin is deliberate, so the
socket can come back mid-drive. Offline play has to decide what happens then;
yanking a player out of a tutorial because the network returned is the wrong
answer.

## Stage 3: practice range

Static targets and local shot-vs-body hit tests, plus whatever scripting states
a lesson's goal and notices it being met. The geometry is already client-side:
`public/collision.mjs` is half of the `collision` pair and is what resolves
every move today. What is new is a small loop that decides "that hit", against
targets that belong to nobody.

## Stage 4: bots, and a real offline match

Opponents and adjudication. That means porting upstream's `RobotPlayer`
(`src/bzflag/RobotPlayer.cxx`) and standing up kill, flag and score authority in
the browser. This is the expensive tier, and the one to be sure is wanted before
starting.

## What the client already has

The mirrored pairs exist because the client predicts: `collision`, `motion`,
`shots`, `flags`, `teams`, `headset` and `voice-channels` each have a
`public/*.mjs` and a `server/*.cjs` copy. Driving, jumping, ricochets,
teleporters and flag effects are all already in the browser. What lives only in
`server.js` is the deciding: spawn selection, flag spawning, hits, kills,
scores, timers, and BZW parsing (`server/remote-world-import.cjs`).

## The constraint on all of it

"Known duplication (do not add more)" in `AGENTS.md` is the governing rule.
A local authority is a third copy of logic that has already drifted twice
between two.

The clean shim is a loopback speaking the same JSON protocol: `sendToServer` and
`handleServerMessage` are the seam, so the client needs almost no special
casing, and it would also give a server-free way to test the client. Bundling
`server.js` into a worker is not viable -- it is wired to express, `ws`,
sessions and the list server.

**The way to stay out of the duplication trap is for offline mode to decide as
little as possible.** A free drive decides nothing at all: no kills, no scores,
no flag authority, nothing to drift because nothing is adjudicated. That is why
stage 2 is a shim and stage 4 is a second game, and why the stages are worth
shipping in order.

## Tutorial ideas

From issue #129:

- Basic driving: reach a place on the map.
- Basic shooting: hit a tank.
- Basic dodging: a slow opponent, then a faster one.
- Team play: flags, team captures, friend and foe.
- GM: hit someone behind an obstacle.
- Parkour.

The first two need nothing past stage 3. The rest need bots.
