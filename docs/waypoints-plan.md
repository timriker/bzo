# Waypoints

A point a server or plugin sets for one player to drive to, shown until they
reach it ([#199](https://github.com/timriker/bzo/issues/199)). The plugin
calls, a bzo client's beacon, radar ring, heading marker, label and sounds,
and a BZFlag client's flag and shots are built ([waypoints.md](waypoints.md)); what
follows is still to come. Upstream
references are paths under `$HOME/bzflag/`.

## Left for a bzo client

- An operator's `/waypoint` command, for the same as a plugin.

## Open questions

- Whether arrival should need the player on the ground.
- How a proxied target's players get one: an upstream target's plugins cannot
  set it.
