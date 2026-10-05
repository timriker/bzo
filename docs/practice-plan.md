# Practice mode

Plan for a match against bots on any map, in the browser, and offline from an
installed client. It is stage 4 of [tutorial-plan.md](tutorial-plan.md) -- "bots,
and a real offline match" -- made concrete now that the bots exist. Nothing here
is built.

## What it is

Pick a map the way Map Viewer does, pick how many bots and which pilot, and play
on it: spawning, shooting, dying, flags, scores, exactly as on a server. With no
server reachable, an installed client offers the same from the maps it holds.

## What already exists

- **The world in the browser.** Map Viewer builds any world from its
  `{url, hash}`, and `public/sw.js` keeps `/maps/<hash>.json` once fetched.
- **The tank.** The client predicts its own motion, shots and flag effects
  against the `collision`, `motion`, `shots` and `flags` pairs, and Map
  Viewer's phantom tank already drives with no game behind it (issue #68).
- **The bots.** `public/autopilot.mjs` (Roger and Ace) and `public/nav.mjs`
  (routes) are browser ESM already, and so is how a tank moves: the `drive`
  pair (`public/drive.mjs`), which the browser's tank and `server/bots.cjs`'s
  `BotDriver` both step, along with the move packet and the shot it builds.
  `BotDriver` is small and talks to its game only through messages a client
  would send.
- **The seam.** `sendToServer` and `handleServerMessage` in `public/client.js`
  are the client's whole conversation with a game; a server bot already joins
  through `acceptConnection` on a socket that never leaves the process.

## What is missing: the referee

Everything that *decides* lives in `server.js` and only there. But a practice
game does not need all of it, because the client already knows how to play
against a game that decides far less: a proxied BZFlag server.

## The client already plays bzfs's way

bzo is server-authoritative; bzfs is the reverse ([proxy.md](proxy.md), "What
crosses" and "Dying is the browser's to declare"). On a proxied connection the
browser already:

- flies every shot it is told about and tests it against its own tank, with
  the same `getShotTankHit` and `shockWaveHitsTank` the server decides with;
- declares its own death, all six ways upstream has -- a shot, a run-over,
  genocide, self-destruct, water, a death pad -- in upstream's order;
- declares its own grabs, drops, captures and teleports;
- answers `identify` and `nearFlag` itself.

What the game behind it then has to do is bzfs's job, and only that: keep the
roster, pick spawn points, spawn flags and approve grabs, fly a dropped flag,
count scores and team scores from the deaths and captures it is told about,
relay shots, and run the clock and the rabbit. **So the practice referee is
bzfs-shaped and speaks the proxy's contract** (`clientTracesShots`, the
`killed` a client sends), not bzo's own.

That takes the largest and riskiest slice -- flying shots and deciding hits --
out of the extraction altogether. The bots decide their own deaths the way the
browser does, from the shots they are told about, with the same shared
functions; a bot running in the same Worker as the referee is no different
from a client on the far side of it.

What still lives only in `server.js` and has to come out: spawn selection,
the flag lifecycle (spawning, grab rules, drop flights, capture, antidote,
shake), scoring, respawn timing, the match clock and rabbit chase -- a
fraction of the 5,000-7,000 lines of rules, interleaved with what only a
server does: sockets, sessions, the list server, the proxy, admin commands,
voice, `server.json`.

## The options

1. **A small referee in the client.** A third copy of the rules, which "Known
   duplication (do not add more)" in `AGENTS.md` forbids, and which would drift
   the way two copies already have. No.
2. **`server.js` in a Worker.** It is wired to express, `ws`, `fs`, sessions and
   the list server. Not viable.
3. **The rules out of `server.js`, into one module both run.** A game core in
   browser-ready ESM that `server.js` loads with a dynamic `import()` -- as it
   already loads the pilots -- and that a Worker runs for practice. One copy of
   the rules, two hosts. **This one**, and only the bzfs-shaped part of it:
   the rules a game keeps when its players declare their own deaths.

A practice room on the live server instead -- one game per player -- needs the
server to run several games at once, which is about as large a change, and does
nothing offline.

## The shape

```text
public/game/          the core: rules only, no I/O
  core.mjs            createGame({ world, config, hooks }) -> { join, leave, message, tick }
  ...                 one file per slice below
server.js             host: sockets, sessions, list, proxy, admin, voice, config
public/practice.mjs   host: a Worker running the core and its bots
```

The core owns players, flags, scores and the clock; shots it relays, and a
death it is told about, as bzfs does. A host gives it
`hooks`: `send(playerId, message)`, `broadcast(message)`, `log`, `now`,
`random`, and -- server only -- the anti-cheat's `reportCheat`. Players join
with a socket-shaped object, so a browser, a server bot and a practice bot are
the same thing to it, which is already true of the server.

`BotDriver` moves next to the pilots as browser ESM, and `server/bots.cjs`
keeps only the fill rule and its own wiring.

## Steps

Each slice is moved and the server switched to it in the same change, checked
against live play: every game bzo runs goes through it, which is the best test
it could have.

1. **Loopback.** A `MessagePort` transport behind `sendToServer` and
   `handleServerMessage`, so the client can talk to a Worker exactly as it
   talks to a socket. Nothing else in the client changes.
2. **The core, in slices**, in order of what a first match needs. Each takes
   what a player tells it, as bzfs does; the server goes on deciding its own
   game's shots and deaths around it.
   1. spawn selection
   2. kills declared, respawns, scores
   3. flags: spawning, grab, drop, capture, antidote, shake (the effects are
      already the `flags` pair)
   4. match rules: clock, rabbit, team scores
3. **Bots that declare their own deaths.** A bot steps the shots it is told
   about with `traceShotStep` and tests them against its own tank with
   `getShotTankHit`, as the proxied browser does -- the shot-flight half of
   the browser's code moves into a shared module so the two are one.
4. **Practice host.** A Worker that runs the core with a world and a config,
   relays shots, and fills the game with bots. The human's client joins it in
   `clientTracesShots` mode, as through a proxy. First playable: free-for-all
   against bots, no flags -- slices 1 and 2.
5. **The entry.** A "Practice" choice beside Map Viewer: the map, how many bots,
   which pilot, teams or not. The settings are the same names as `server.json`'s.
6. **Offline.** The service worker precaches the core, the pilots and the route
   graph; the client remembers the worlds it has played (the `worldRef`s from
   `init`); an installed client with no server offers Practice on those.
   [tutorial-plan.md](tutorial-plan.md) stages 1 and 2 -- saying it is offline,
   free drive on the last map -- come for free on the way.

## What it costs and what it buys

The core extraction is the work, and it carries the risk: a slice moved wrong
breaks every live game. Taking bzfs's half rather than all of it leaves out the
shot and hit code, which is the largest part and the part every game leans on
hardest; what is left is spawning, flags and scores. Still weeks rather than
days, in slices, one rule at a time and visible at once.

It buys more than practice:

- **Tutorials** (tutorial-plan.md stage 3 and the bot-driven lessons): a lesson
  is a practice game with a script.
- **Tests and benchmarks with no server.** `scripts/bench-pilot.mjs` flies one
  tank against the world; against the core it could run a whole match.
- **Off the main thread.** The route graph costs about 2s to build per world,
  which the Orin feels; a Worker is where it belongs for the client autopilot
  as well.
- **A smaller `server.js`**, whose remaining job is being a server.

## Open questions

- **Which rules a practice game takes from the map**, which from the entry
  dialog, and whether it simply reads the same `server.json` keys.
- **Saving a practice game's scores** -- likely not, since nothing scores
  against anyone real.
- **Voice, chat, the scoreboard's admin columns** -- off, since nobody else is
  there.
