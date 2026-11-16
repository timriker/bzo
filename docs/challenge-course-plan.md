# Challenge course

A timed course of skill sections that any client can run, stock BZFlag
included: parkour jumps, a climb, holes that need Tiny or Narrow, pillars
that need Obese, a dark cave, a rain section. Waypoints lead the way, a
ghost of the record holder drives alongside, and the server's title names
the current record. None of it is built. The tricks it rests on are in
[stock-client-enhancements-plan.md](stock-client-enhancements-plan.md);
upstream paths are under `$HOME/bzflag/`.

## The course

- **All in the map.** The course plugin registers its own objects
  (`bz_registerCustomMapObject`, `bzfsAPI.h:2030`), as upstream's `koth`
  and `keepaway` do, and bzo hands it each block
  ([plugins.md](plugins.md)). Each is a box or cylinder
  (`bz_CustomZoneObject`) plus the course's own fields:

  ```text
  coursesection
    name parkour
    order 1
    position 0 0 0
    size 10 10 5
    hint "Jump the pillars"
  end
  ```

  Other objects follow the same shape: checkpoints, targets with a path,
  and zones with their effects (`fog`, `rain`, `jumpvelocity`,
  `maxbumpheight`, `giveflag`, `kill`). Stock BZFlag clients never see
  these blocks; they are not in the world sent to a client.
- **bzfs without the plugin refuses such a map.** Tested with
  `/usr/games/bzfs`: an unregistered block is "invalid object type", and
  its `end` fails the load. A map that must also load on plain bzfs can
  instead put the fields on an ordinary `zone`, where an unknown parameter
  is only a warning ("unknown object parameter ... - skipping") and the map
  loads; the plugin reads them all the same. Since the course runs on a
  dedicated bzo server, custom objects are the default.
- **A zone** is a box with enter and leave actions: set BZDB for the runner,
  give or take a flag, or kill. Leaving undoes what entering did.
- **Many runners at once.** Every effect is per runner, so a run never
  changes the course for anyone else.
- **A dedicated server.** The course is the whole game there. Every player
  joins one team with `noTeamKills` on, so runners cannot kill each other:
  the stock client itself refuses a teammate's hit (`LocalPlayer::checkHit`,
  `LocalPlayer.cxx:1616`), and bzo's server asks the same rule. Shots are
  for targets only.
- **Bots run it as players do.** A bot such as Ace gets the same waypoints,
  the same ghost and the same timer through the same per-runner path, and
  drives the course on what it is shown, nothing more.

## Runs

There are two kinds, on the same sections:

- **A section run.** Driving into any section's start, in any order,
  starts that section alone: its clock, its targets, its flag, its ghost.
  Its finish ends the run and records a section time.
- **A course run.** Crossing the course start gate starts the run clock
  and leads through every section in the course's order. Only a course run
  that clears every section, in order, sets a course time. Each section it
  clears also counts as a section time.

Both:

- The timer is sent to the runner alone (`MsgTimeUpdate`). Any flag they
  carry is taken at the start.
- The next goal is the runner's waypoint
  ([waypoints-plan.md](waypoints-plan.md)): a beacon on bzo clients, a
  private team flag and a sound on BZFlag clients. In a course run it
  leads to the next section's start; in a section run, through the section.
- Entering a different section's start during a course run does nothing;
  the waypoint keeps pointing at the next one in order.
- Dying -- a missed jump, a hazard, a lava floor -- restarts the section:
  the runner goes back to its start, its targets come back, its flag is
  given again, and its clock starts over. The run's clock keeps running,
  so retries cost run time but not section time. Where a section cannot be
  restarted cleanly (one that hands over to the next mid-air, say), death
  goes back to the last checkpoint instead. `MsgAlive` does the move, which
  a stock client takes as a new life: it stops dead and drops any flag
  (`LocalPlayer.cxx:1039`). Leaving the course or `/abort` ends the run.
- No time limit. Waypoints, targets and the ghost are the runner's alone
  and the section flags are taken back at each section's exit, so a slow
  run holds nothing anyone else needs. The server's idle kick still
  applies.

## Beginners and veterans

The same course serves both: a beginner tries to get through, a veteran
races the clock.

- A beginner practises sections on their own, in any order, and tries a
  course run once each one goes. A veteran races both.
- Only a section cleared with every target goes on that section's
  scoreboard.
- A runner stuck during a course run can `/skip` to the next section. The
  run still finishes, but sets no course time; the sections they did clear
  still count.
- The waypoint's label says what the section wants ("Grab Tiny, drive
  through the hole", "Guided Missile: hit the tank behind the wall").
- The ghost shows how it is done. A beginner may pick a slower ghost than
  the record, such as today's best or their own.
- Which sections a player has cleared, and their best times, are kept, so
  the course also reads as progress ([practice-plan.md](practice-plan.md)).
- The finish records the time and, on a record, fires the fireworks: a fan
  of server shots upward, which fly off the map and harm no one.

## Sections

Each section is short, so a veteran can race it in well under a minute,
and each teaches one thing a beginner needs. Listed in course order; a
section run may take any of them alone.

### Tutorial

The course opens with the basics, each a section with its own clock and
scoreboard like any other, so a veteran can race them too. The hints say
the key to press as well as the goal.

1. **Driving.** Forward, back, turning on the spot, then a slalom of posts
   and a long straight at full speed.
2. **Jumping.** One low box to jump onto, then a gap to jump across, then
   a jump with a turn in the air.
3. **Shooting.** Three still targets: near, far, and one beyond shot range
   that teaches how far a shot carries. Then one that moves, to lead.
4. **Radar.** A target behind a wall that shows only on radar; drive
   around and find it. Teaches reading the radar and the shot lines on it.
5. **Flags.** A pad to drive over and pick up a flag, then drop it on a
   marked spot, then pick up a good flag and shake off a bad one.
6. **Teleporters.** Drive through one, then shoot through one at a target
   on the far side.

### Challenges

7. **Parkour.** Boxes and pillars to jump between, some needing a turn in
   the air. The zone sets upstream's default `_jumpVelocity` 19, and with
   `_gravity` -9.8 a jump peaks at about 18.4 units
   (`src/common/global.cxx:70`), so gaps and heights are tuned against
   that. Falling restarts the section.
8. **Climb.** Steps of rising height: up to 0.33 drives over
   (`_maxBumpHeight`), anything taller needs a jump timed to land on it.
   It ends at a wall too tall to jump, with a Jumping (JP) flag in front:
   while the runner holds it, bzo sends them a higher `_jumpVelocity`. The
   stock client jumps a JP holder with the same `_jumpVelocity` as anyone
   (`LocalPlayer.cxx:1453`), so the flag is just the visible reason for
   the bigger jump, with no new flag type. bzo forbids JP on a jumping
   world today (`server.js`, "grants what every tank already has"), so the
   course server must allow it. Watchers still draw the arc right, since
   they predict from the launch speed (`Player.cxx:1148`).
9. **Squeeze.** A Tiny pad, then a low, small tunnel; a Narrow pad, then a
   tall slot seen edge-on, then both in a row with a pad swap between. The
   exit takes the flag back. Others draw the tank by its flag, so it looks
   right to all. bzo keeps a pool of each flag, one per runner in the
   section, so nobody waits for one.
10. **Stepping stones.** An Obese pad, then pillars far enough apart that a
   stock tank drops between them and an Obese one rests across. Untested:
   whether upstream physics holds a wide tank on two supports must be
   checked with the real client before this is built.
11. **Storm.** Rain (`_rainType`, `_rainDensity`, live callbacks,
   `WeatherRenderer.cxx:84`) over a stretch of wet ground where the runner
   slides (`_momentumLinAcc`, `_momentumAngAcc`): braking early, steering
   into a slide, a narrow bridge at the end.
12. **Cave.** Dark fog for the runner (`_fogMode`, `_fogEnd`, `_fogColor`;
   the stock client re-reads fog every frame, `SceneRenderer.cxx:740`). A
   winding tunnel driven mostly by radar, with two targets that show on
   radar long before they show on screen.
13. **Gallery.** Every target at once: a field of them, some still, some
   crossing on paths, near and far. The section ends the moment the last
   one falls, so a good shot clears it in seconds. Teaches leading a moving
   target and how far a shot carries.
14. **Bank shots.** Targets behind walls that only a ricochet reaches, off
   one wall and then two. Its walls are marked `ricochet`, so no flag
   is needed (see Jumping and ricochet per section).
15. **Heavy weapons.** Pads in a row, each with its target, all up at once
    and taken in any order: Laser down a long lane, Shock Wave in a cluster
    under a low roof, Super Bullet through a wall, Guided Missile at tanks
    behind buildings that never come into line of sight. Each pad's flag is
    taken back when its target falls.
16. **Wings.** A Wings pad, then platforms in the air to land on in turn,
    with `_wingsJumpCount` set for the runner so a beginner has spare
    flaps.
17. **Gauntlet.** A field crossed under fire from turrets that aim at the
    runner. The turrets' shots go to that runner alone (see Private
    hazards), so other runners never meet them. Reaching the far side ends
    it; a hit restarts it.

The finish follows the gauntlet: fireworks, and the run's times.

More can join later: a lava floor (a server kill on touching the
ground), a teleporter maze where a shot through one teleporter hits a
target beyond another, and a team pad for a two-player course.

## Private hazards

The gauntlet's turrets fire shots only their runner is sent
(`MsgShotBegin` to that connection alone). A stock client checks every
shot it knows against its own tank and blows itself up on a hit, so the
runner can die to them; nobody else ever sees them. bzo traces them for
that runner only. Untested, with the other unknowns in Steps.

## Jumping and ricochet per section

A stock client reads jumping and ricochet once, from the game settings at
join. A second `MsgGameSettings` mid-game makes it fetch the world again
(`playing.cxx:2149`), so the options themselves cannot change per section.
What a section can change instead:

- **Jumping is off by default.** The server has jumping on (`-j`) and
  the map sets `_jumpVelocity 0`, so no runner can jump. A section that
  wants jumping sets `jumpvelocity` on its zone (19 for an ordinary jump,
  more while holding the JP flag in the climb), sent to the runner on
  entry and set back to 0 on exit. Sections that do not mention it stay
  jump-free. This costs no flag slot, so a jumping section can still hand
  out Tiny.
- **Tested** with the real 2.4.30 client against bzfs (`-j`,
  `-set _jumpVelocity 0`): the jump key leaves the tank at height 0, it
  keeps driving and steering through repeated jumps, and bzfs does not
  object. The jump sound and the landing puff still play, which is
  acceptable. Still unchecked: the value changing mid-game rather than at
  join.
- **Ricochet in one section.** No flag needed: the map marks the section's
  walls `ricochet`, an obstacle property a stock client honours per
  obstacle (`Obstacle::canRicochet`, `include/Obstacle.h:372`), and bzo
  parses it too (`server/bzw-parse.cjs`). Shots bounce off those walls and
  stop on every other one, with the server's ricochet left off.

bzo's own clients take the same rules directly, with no flag needed, and
its server checks jumps and bounces against the runner's section.

## Targets

- **What a target is.** A fake tank only the runner sees, sent as the ghost
  is (`MsgAddPlayer` to that connection alone). Static ones sit on posts;
  moving ones follow a path set in the map.
- **Who decides a hit.** bzo's server already traces every shot, bounces
  included, against tanks (`findShotPlayerHit`, `server.js`). Targets join
  that trace for their runner's shots only. A stock client does not report
  hitting anyone -- the victim does -- so the server's trace is the only
  judge, and that holds for bzo clients and bots alike.
- **What the runner sees.** On a hit, bzo sends that runner `MsgKilled` for
  the target, so their client draws the explosion. A cleared target stays
  gone for the rest of the run.
- **Where they are.** The cave, the gallery, bank shots and heavy weapons
  (see Sections). A flag a target needs is given by a pad and taken back
  when the target falls or the runner leaves.
- **Guided Missile needs a test.** A stock client locks on to any player
  it knows, so it can lock on to a target, and it steers the missile
  itself and reports the lock (`MsgGMUpdate`). bzo then has to trace the
  missile toward a target that exists only on that connection, mapping the
  connection's slot back to the target.

## The ghost

- **Recording.** The server samples every run: time, position, azimuth,
  velocity, flag and shots. The best run is kept on disk with its time and
  runner.
- **Whose ghost.** The all-time record's, by default. A runner may choose
  today's or this week's best, or their own.
- **Section ghosts.** Each section's record is kept with its own
  recording. When a section restarts, the ghost restarts with it, from the
  section leader's run of that section.
- **Bots follow it too.** The ghost is the course's best line, jumps
  included, so a bot steering after it learns the course the way a player
  does.
- **On a bzo client** the ghost is a see-through tank started with the run.
- **On a BZFlag client** it is a fake player only that runner sees:
  `MsgAddPlayer` in a spare slot of that connection, named for the record
  ("Ghost: Name 1:23.45"), driven by `MsgPlayerUpdate` from the recording,
  removed at the end. It shows on radar, which is what makes it followable.
  Hits are judged by the victim, so shots pass through it, and tanks do not
  collide. It does appear on that runner's scoreboard.
- A ghost shows its section flag only if bzo sends that runner a private
  flag for it; without one it keeps the stock size.

## Records

- **Scoreboards.** One for the whole course and one for each section,
  each daily, weekly and all time. Daily and weekly roll over at a fixed
  UTC time. A section time counts from its last restart to its finish, so
  a beginner who never finishes the course can still lead a section.
- **Bots score too, on their own scoreboards.** A bot's ranked run is
  timed and kept as anyone's, but on bot scoreboards beside the players'.
  The title and the default ghost come from the players' scoreboards; a
  runner may pick a
  bot's ghost.
- **Who.** A runner is their BZID where they have one, so a record follows
  the player, not the callsign. A guest's record is kept under the callsign
  and marked as such.
- **Web page.** The plugin serves the leaders through
  `bzhttp_RegisterVDir` ([plugins.md](plugins.md)), at
  `/plugins/<name>/`: the course and every section, daily, weekly and all
  time, players and bots side by side. The same data as JSON for other
  sites.
- **In game.** A `/records` command, optionally for one section, and a
  chat line for each new daily, weekly or all-time best, course or section.
- **Storage.** One file per course on disk, each record with its
  recording, so every scoreboard's ghost can be replayed.

## The title

- The all-time record holder and time follow the operator's title, with
  today's best where it fits, e.g. "Challenge course -- record Name
  1:23.45, today Other 1:31.02". It goes to the BZFlag list
  (`bzflagListTitle()`, republished as a title change already is in
  `server.js`) and to bzo's own `/list`.
- The suffix is the course's, not the operator's: it is never written into
  `server.json`.
## Fair runs

- bzo's movement and jump checks must use the runner's current zone
  values, or it rejects what it set.
- Only course-given flags count; a run with any other flag is void.

## Clients

- bzo's web and XR clients apply the same zone values (fog, rain, jump,
  bump height) and draw the waypoint beacon and the ghost. Nothing here
  needs a flat screen.
- BZFlag clients load images only from images.bzflag.org, so the course is
  built from geometry, colours and stock textures.

## Steps

1. Test the unknowns with real clients under Xvfb: the Obese pillars, a
   fake player sent to one client only, `MsgKilled` for that fake player
   drawing an explosion, a Guided Missile locking on to it, a shot sent
   to one client only hitting that client, and `_jumpVelocity 0` arriving
   mid-game for one client.
2. Zones: enter/leave, per-runner `MsgSetVar`, and undo on leave.
3. Runs: section runs in any order, course runs in order, timers, and
   restarts by `MsgAlive`.
4. Waypoints, as in [waypoints-plan.md](waypoints-plan.md).
5. Flag pool and the Tiny, Narrow and Obese sections.
6. Targets: per-runner fake tanks in the server's shot trace.
7. Recording and the ghost, bzo client first, then BZFlag.
8. Section clocks and restarts, scoreboards, the web page, the title
   suffix and the fireworks.
9. Bots: Ace runs the course from its waypoints and ghost.
10. The course map itself, under a licence bzo can ship.
