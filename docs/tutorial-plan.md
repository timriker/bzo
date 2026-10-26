# Tutorial mode and offline play

Plan for issue #129: what an installed client does when the server it was
installed from is unreachable, and what tutorial levels are built on top of
that. Upstream references are paths under `$HOME/bzflag/`.

Saying it is offline, and an offline game on the last map against bots, are
built. Stage 3 and the lessons are a plan.

## What an offline launch does today

The service worker precaches the shell -- `index.html`, `client.js`,
`styles.css`, Three, and the offline host below -- and caches everything else
on first use, so the page itself loads with no server. Then `connectToServer`
opens a WebSocket to the same host, it fails, and `ws.onclose` schedules
another attempt in three seconds. An attempt that never opened puts the
loading overlay up with "Offline" (or "Cannot reach <host>") and "Trying
again...".

A page that has never reached a server, and is offline or has failed three
attempts, then drives the last world it played instead (stage 2, below).

`/manifest.webmanifest` is deliberately never intercepted, so a cold first
visit with no network cannot install either. That is correct -- the manifest is
generated per request and names the server -- and it is not worth changing.

## Stage 2: the last map, offline

Built. Online, the client keeps the last game's `init` in `localStorage`
(`offlineWorld`), without other players, flags or anything about the
connection, plus up to 16 places the server spawned this player on that world
-- spots the server checked against the whole world, so the offline host needs
no collision of its own to pick one. The map is already on disk: `init`
carries a `worldRef` of `{url, hash}`, and `public/sw.js` serves `/maps/`
cache-first because a file there is named for its own content hash.

Offline, `public/js/offline-worker.mjs` answers on the same port the loopback
uses (practice-plan.md, step 1): it replays the saved `init` with
`clientTracesShots`, seats the player, spawns them on a saved spot, echoes
their shots and brings them back after a death they declare, as the proxy does
for a bzfs. Three Ace bots play against them (stage 4). The map is also kept
in a cache of its own (`bzo-offline`, which `public/sw.js` never drops), so an
update does not leave an installed app with nothing to drive.

Left:

- **A tutorial map pinned in `PRECACHE`.** The saved world is whatever the
  player last played. A lesson needs a map whose layout it can depend on.
- **Coming back online.** An offline game stays offline until a reload, rather
  than being yanked out from under the player when the network returns. A
  quiet "server reachable" notice would be the friendly half of that.

## Stage 3: practice range

Static targets and local shot-vs-body hit tests, plus whatever scripting states
a lesson's goal and notices it being met. The geometry is already client-side:
`public/js/collision.mjs` is the `collision` module and is what resolves
every move today. What is new is a small loop that decides "that hit", against
targets that belong to nobody.

## Stage 4: bots, and a real offline match

A free-for-all against three Ace bots, no flags, is built: the offline Worker
runs the server's own bot host and decides each bot's death the way a proxied
browser decides its own. What is left is the rest of a match -- flags, teams,
the clock -- which [practice-plan.md](practice-plan.md) plans as the game's
rules out of `server.js` into one module the server and a browser Worker both
run.

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
