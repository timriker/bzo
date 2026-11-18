# Racing

A race on a track map: laps timed across a finish line, checkpoints that keep
a lap honest and lead the way, Ace racing as players do, and later, flags on
the track. The lap timer and its checkpoints are built ([plugins.md](plugins.md),
laptimer); the rest is a plan. Upstream paths are under `$HOME/bzflag/`.

## Each racer's waypoint

- The next checkpoint is the racer's waypoint
  ([waypoints-plan.md](waypoints-plan.md)): crossing checkpoint N sets
  checkpoint N+1, and the last sets the finish line. A bzo client shows the
  beacon and radar ring; a BZFlag client gets that plan's team flag and shots.
- **A death keeps it.** The racer respawns where they died, on the track, with
  the lap and its clock still running. Whoever killed them has driven on, so
  a spawn kill is rare.

## Ace

- **A race job.** With a waypoint, Ace's goal is the waypoint rather than a
  tank or a flag, routed as he routes to any point (`routeTo`), aimed a little
  past it toward the next so he takes the corner rather than stopping at the
  gate.
- **Physics.** He steers by where the tank travels, not where it points, so a
  conveyor's push or a turntable's carry is not something to correct, and
  prefers the lane whose push runs his way.
- **The racing line.** The best player lap, sampled every half second or so,
  is a dense line of waypoints for him to follow, jumps included. It is the
  ghost of [challenge-course-plan.md](challenge-course-plan.md) too. His level
  is how closely he holds it.

## Flags on the track

Flags laid on the track, the lane deciding which: the inside lane one kind,
the outside another. Taken by driving over them, as any flag is. Shots stay
off except for what a flag gives.

## Steps

1. Checkpoints: built, laptimer's `checkpoint` ([plugins.md](plugins.md)).
2. Waypoints: built, laptimer moving each racer's along the course
   ([waypoints.md](waypoints.md)).
3. Respawn where the racer died, keeping the lap and the waypoint.
4. Ace's race job: built, Ace driving to his waypoint
   ([waypoints.md](waypoints.md)). Physics-aware steering is still to do.
5. Recording the best lap as the racing line; Ace follows it.
6. A plugin's description suffix on both lists: built, laptimer putting
   today's fastest registered player in it ([plugins.md](plugins.md)).
7. Flags by lane.
