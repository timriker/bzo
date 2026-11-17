# Practice

A match against bots in the browser, on any map this server holds or any
public bzfs server's, offline once loaded. Nothing goes to a server while it
runs: the game is a Worker in the page. [practice-plan.md](practice-plan.md)
is what is still unbuilt.

## Starting one

- **The entry dialog.** Once a world has been played, its Server row offers
  "Practice offline" at easy, normal and hard, on the last map played.
- **`/list`.** Every map this server holds has a Practice button, at
  normal, and so does every bzfs server where the operator set
  `viewOtherServers`.
- **A link.** The same thing by hand:

```text
https://<this bzo>/?practice=<level>&map=<file>&bots=<n>
```

| Parameter | Values | Otherwise |
| --- | --- | --- |
| `practice` | `easy`, `normal`, `hard` | any other value is `normal` |
| `map` | a map file this server lists, or `import-<host>_<port>.bzw` | the last world played |
| `bots` | 0 to 15 | 3 |

The chat says where you are: "Offline, against bots, on hix.bzw. Reload to
reconnect."

**Map Viewer** is practice with nobody else in it: `?viewmap=<file>`, with
its `cam=` and `pos=`, and Map Viewer in the entry dialog, open the map
offline with no bots and you an observer, free to roam or drive. You are not
on the server while you look: its game, chat and voice are not with you.

## The bots

Every bot is Ace (`public/js/autopilot.mjs`). The level is his skill
(`ACE_LEVELS`): how late he reacts and how many of his shots he takes,
raised while he is behind the best foe and lowered while he is ahead. At
hard he plays his best until he is well ahead of everyone, as on a server.

Your own autopilot is on offer too (9), even where a bzfs server sets
`_disableBots`: it runs in your browser and plays nobody real.

## The map's game

The game follows the map:

- **Capture the flag** where two colour teams or more have a base. You join
  the first of them unless you pick another; the bots alternate between your
  team and the rest. Each base has its team flag, and a capture sends it home,
  moves the team scores by the server's rule and kills the losing team.
- **Rabbit Chase** where the map's options say `-rabbit`. Everyone hunts
  until the game makes them the rabbit, picked as `-rabbit` says.
- **Free-for-all** otherwise: rogues where the map allows them, else each bot
  on another team.

Superflags come as the map deals them. A shell, a Laser, a Shock Wave, a
Guided Missile and a Super Bullet fly as they do on the server.

## The map's settings

`/api/practice/<file>` answers with the map and the config it plays by:
bzo's defaults with the map's own `-ms`, options and BZDB laid over, as a
server running it would. For a bzfs import that is its server's: jumping only
where its `-j` allows it, ricochet where its `+r` does, and its `-s` count of
flags from every flag its `-f` leaves. For one of this server's maps,
jumping and flags start from this server's settings, and the map's own
options go over them.

An import is fetched first when it is not held here, as `?viewmap=` does. A
bzfs server's plugins do not come with it. `_disableBots` does not either.

The client keeps the answer per map, so the same link opens again with no
server.

## How it runs

`public/js/offline-worker.mjs` answers the page's game connection
(`port-transport.mjs`) as a server would. It plays the way a proxied bzfs
does ([proxy.md](proxy.md)): your client traces every shot and declares its
own death (`clientTracesShots`), and each bot decides its own the same way,
with the same `getShotTankHit`. The game itself -- shells, deaths, spawns,
respawns, tallies, flags and each bot's view -- is `public/js/bot-game.mjs`,
which `scripts/arena.mjs` also runs, bots only and faster than real time.

`?loopback` on an ordinary game's URL puts it through the same kind of port
(`loopback-worker.mjs` relays it to the server's socket), which is how the
port is checked against live play.

## Not yet

A dropped flag's flight, a team flag's timeout home, antidotes, the match
clock, a shell through a teleporter, and choosing the pilot or the teams. See
[practice-plan.md](practice-plan.md).
