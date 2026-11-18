# Waypoints

A point a server or plugin sets for one player to drive to, shown until they
reach it ([#199](https://github.com/timriker/bzo/issues/199)). The plugin
calls, a bzo client's beacon, radar ring, heading marker and label, and a
BZFlag client's flag and shots are built ([waypoints.md](waypoints.md)); what
follows is still to come. Upstream
references are paths under `$HOME/bzflag/`.

## Left for a bzo client

- An operator's `/waypoint` command, for the same as a plugin.
- A positional sound repeating from the point: `hunt` is the nearest upstream
  sound, `pop` and `lock` the alternatives (`public/audio/`).

## Open questions

- Whether arrival should need the player on the ground.
- How a proxied target's players get one: an upstream target's plugins cannot
  set it.
