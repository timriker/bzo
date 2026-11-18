# Waypoints

A point a plugin sets for one player to drive to. A player has at most one;
setting another replaces it. [waypoints-plan.md](waypoints-plan.md) is what is
still to come.

## Setting one

A plugin calls `bz_setWaypoint(playerID, x, y, z, label, radius)` and
`bz_clearWaypoint(playerID)` ([plugins.md](plugins.md)). `radius` defaults
to 5: when the player's tank comes within it, across and up, the server
clears the waypoint and fires `bz_eWaypointArrivalEvent` with the player,
the point and its label. A radius of 0 is never reached, for a plugin that
moves the waypoint on itself; laptimer does that at each line crossed.

A waypoint outlives a death. A new connection starts with none.

## What a bzo client shows

- A white wedge hanging from the clouds over the point, as the team flag,
  the antidote and a hunted tank have, in a headset too.
- A white cross and ring on the radar, at the panel's edge when the point is
  off it.
- A white marker on the heading tape.
- The label on the status line, under anything more pressing there (Paused,
  Sealed).
- A soft bell from the point once a second, quieter than a shot and fainter
  with distance, and a rising two-note chime on reaching it: cleared or moved
  on while the tank is within 40 of it. bzo's own sounds
  (`scripts/make-waypoint-sounds.mjs`).

## Ace

Ace drives to his waypoint ahead of hunting or flags, a server bot's and a
player's autopilot alike, stopping only for a foe close enough to fight.

## What a BZFlag client is shown

A BZFlag client has no waypoint, so it is shown things it does understand,
sent to that player alone:

- **A team flag at the point**, the player's own team's (purple for a rogue),
  in a flag slot the game settings count past the world's own. It hovers 0.3
  over the point: a client grabs a flag only within 0.1 of its tank's height
  (`playing.cxx:4141`), so it is never grabbed. It is a dot on the radar, and
  in a game with team flags a heading marker too, as upstream marks only the
  player's own team flag there (`prepareTheHUD`).
- **A server Phantom Zone shot straight up** every half second, starting 10
  over the point, clear of a tank on it, since a client judges its own hits.
  A zoned shot passes through a sign or a bridge over the point rather than
  ricocheting, hits only a zoned tank, and is drawn faint. The client hears it
  where it starts, the one way to put a sound at a place for one player.
- **The label once**, as a line from the server.
