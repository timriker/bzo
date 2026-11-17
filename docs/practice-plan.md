# Practice mode

Plan for practice against bots on any map, in the browser and offline from
an installed client. It is stage 4 of [tutorial-plan.md](tutorial-plan.md) --
"bots, and a real offline match". What practice does today is
[practice.md](practice.md); this is what it still lacks, and how the rules
come out of `server.js` to give it the server's game rather than its own.

## What it is

Pick a map the way Map Viewer does, pick how many bots and which pilot, and play
on it: spawning, shooting, dying, flags, scores, exactly as on a server. With no
server reachable, an installed client offers the same from the maps it holds.

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

`BotDriver` and the bot host are browser ESM next to the pilots, and
`server/bots.cjs` keeps only the fill rule.

## Steps

Each slice is moved and the server switched to it in the same change, checked
against live play: every game bzo runs goes through it, which is the best test
it could have.

1. **Loopback.** Done: `?loopback` ([practice.md](practice.md), "How it
   runs").
2. **The core, in slices**, in order of what a first match needs. Each takes
   what a player tells it, as bzfs does; the server goes on deciding its own
   game's shots and deaths around it.
   1. spawn selection
   2. kills declared, respawns, scores
   3. flags: spawning, grab, drop, capture, antidote, shake. Shared by the
      server and practice already: `public/js/flag-spawn.mjs`,
      `public/js/flag-rules.mjs`, `public/js/flag-drop.mjs`, and capture
      scoring (`getTeamScoreDeltasForCapture`). Left: a dropped flag's
      flight, a team flag's timeout home, and antidotes.
   4. match rules: clock, rabbit, team scores. The rabbit is shared
      (`public/js/rabbit.mjs`). Left: the clock.
3. **Bots that declare their own deaths.** Done for shells and every flagged
   shot ([practice.md](practice.md)). Left: a shell through a teleporter.
4. **Practice host.** Done: `offline-worker.mjs` on `bot-game.mjs`. Those
   rules are the game's own until step 2's slices replace them.
5. **The entry.** Done for the level, the map and the bot count. Left:
   choosing the pilot, and teams or not, with the settings named as
   `server.json`'s.
6. **Offline.** The service worker precaches the core, the pilots and the route
   graph; the client remembers the worlds it has played (the `worldRef`s from
   `init`); an installed client with no server offers Practice on those.
   [tutorial-plan.md](tutorial-plan.md) stage 2 -- free drive on the last
   map, `offline-worker.mjs` -- is built already, and is what this grows from.

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
