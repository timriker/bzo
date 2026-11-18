# Racing

A race on a track map: laps timed across a finish line, checkpoints that keep
a lap honest and lead the way, Ace racing as players do, and flags on the
track. What is built is laptimer ([plugins.md](plugins.md)): laps, checkpoints,
each racer's waypoint ([waypoints.md](waypoints.md)), a racer killed on the
course back where they died, the records page, fireworks, today's fastest on
both lists, and flags of a few shots on the course with `_shotsNeedFlag`
([flags.md](flags.md)). The rest is a plan. Upstream paths are under
`$HOME/bzflag/`.

## Ace

- **Physics.** He steers by where the tank travels, not where it points, so a
  conveyor's push or a turntable's carry is not something to correct, and
  prefers the lane whose push runs his way. He aims a little past his
  waypoint toward the next, so he takes the corner rather than stopping at
  the gate.
- **The racing line.** The best player lap, sampled every half second or so,
  is a dense line of waypoints for him to follow, jumps included. It is the
  ghost of [challenge-course-plan.md](challenge-course-plan.md) too, drawn for
  players to race against. His level is how closely he holds it.

## Flags by lane

Flags laid on the track, the lane deciding which: the inside lane one kind,
the outside another, each a few shots. Today one zone lays one of each across
every lane.

## Steps

1. Checkpoints: built.
2. Waypoints: built, laptimer moving each racer's along the course.
3. Respawn where the racer died, keeping the lap and the waypoint: built.
4. Ace's race job: built, Ace driving to his waypoint. Physics-aware steering
   is still to do.
5. Recording the best lap as the racing line and a ghost; Ace follows it.
6. A plugin's description suffix on both lists: built, laptimer putting
   today's fastest registered player in it.
7. Flags by lane: flags of a few shots on the course and `_shotsNeedFlag` built;
   the lane choosing the flag is still to do.
