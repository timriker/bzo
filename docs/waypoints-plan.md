# Waypoints

A point a server or plugin sets for one player to drive to, shown until they
reach it ([#199](https://github.com/timriker/bzo/issues/199)). Waypoints are
useful for future tutorials. None of it is built yet. Upstream references are
paths under `$HOME/bzflag/`.

## The model

- A player has at most one waypoint. Reaching it clears it, and the plugin may
  then set the next one -- or none, for as long as it wants the player doing
  something else.
- A waypoint is a point, an arrival radius and an optional label. The server
  holds it and decides arrival from the player's position.
- Plugins set and clear it (`bz_setWaypoint(playerID, x, y, z, label)`,
  `bz_clearWaypoint(playerID)`) and hear an arrival event. Operators get a
  `/waypoint` command for the same.

## What a bzo client shows

- A beacon over the point in the 3D view, the same in a headset.
- A ring on the radar, as the team flag, antidote and rabbit already have.
- A positional sound repeating from the point: `hunt` is the nearest upstream
  sound, `pop` and `lock` the alternatives (`public/audio/`).
- The label as a status line that stays until arrival.

## What a BZFlag client is sent

A BZFlag client has no waypoint, so it is told about two things it does
understand, both sent to that player alone:

- **A team flag at the point.** It gives a radar dot and the HUD's team-flag
  marker on the compass, which a custom flag does not. A client sizes its flag
  table from the game settings' maximum and does not check an index
  (`World::getFlag`), so bzo advertises spare slots for waypoints. A client
  grabs any flag on the ground within 0.1 of its height
  (`playing.cxx:4136`); one floating above the ground is never grabbed, or a
  grab can be ignored and read as arrival.
- **Server shots straight up from the point** every half second. A shot plays
  its fire sound where it starts (`playing.cxx:2954`), which is the only way
  to put a sound at a place for one player: a client plays no audio file a
  server names.

The status line has no counterpart; the label goes out once as a message from
the server.

## Open questions

- Arrival radius default, and whether arrival needs the player on the ground.
- Whether a waypoint survives the player's death.
- How a proxied target's players get one: an upstream target's plugins cannot
  set it.
