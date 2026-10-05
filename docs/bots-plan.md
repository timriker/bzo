# Autopilot and bots

Plan for issue #151: bots a tutorial sets off, and a smarter bot. The
autopilot (Roger and Ace) and server-launched bots are built; see the
`docs/bots-plan.md` paragraph in `AGENTS.md`. Upstream references are paths
under `$HOME/bzflag/`.

## What upstream has

- **Autopilot** (`src/bzflag/AutoPilot.cxx`, "Roger"). Client-side only. Each
  frame `doAutoPilot(rotation, speed)` (`playing.cxx:1031`) replaces the
  stick, so the tank moves through ordinary physics. Priority order: drop a
  flag it cannot use, dodge the nearest incoming shot, back off a wall, chase
  the nearest foe, fetch a flag, wander. Then two checks every frame: don't
  drive into water, and fire when the aim is lined up. `teachAutoPilot` scores
  flags by kills minus deaths.
- **Toggle**: key `9`, at most once every five seconds. MsgAutoPilot tells the
  server, which tells everyone ("Roger taking controls"). `-disableBots` kicks
  anyone who turns it on (`bzfs.cxx:2820`).
- **Robots** (`src/bzflag/RobotPlayer.cxx`): extra players run by one client
  over its own connection, with their own region-graph path finding. A
  separate engine from the autopilot.
- **Server-side players** (`bz_ServerSidePlayerHandler`,
  `src/bzfs/ServerSidePlayer.cxx`): a plugin API that has join, spawn,
  `setMovement`, `fireShot`, `jump`, `dropFlag` and event callbacks. The only
  plugin that ships with it (`plugins/serverSidePlayerSample`) just chats.
  Upstream has the plumbing for a server bot but no behaviour for one.

## Step 3: tutorial triggers

A map or lesson file names zones and what happens there: "entering this box
spawns a bot at that spawn point, with this skill". Triggers run on the server,
against positions it already validates. Nothing on the client decides
anything. This is the online half of `docs/tutorial-plan.md`'s lessons.

Lessons want a few knobs the pilot doesn't have yet:

- **Skill**: reaction delay, aim error, turn rate. A slow opponent, then a
  faster one.
- **Behaviour**: a stationary target, a patrol, or a chaser.

## Step 4: a smarter bot

Roger stays upstream's; these go into Ace. In order of payoff:

1. **Path finding (started).** `public/nav.mjs`: a grid of 4-unit columns, a
   node for each surface a tank fits on in each, and the only moves that change
   a tank's level -- a step no taller than `_maxBumpHeight`, a drop, and a jump
   -- plus a bridge straight over a gap one column wide, which a tank longer
   than the gap drives across. There are no ramps: a slope holds a tank up but
   is never driven up, pyramid or mesh. Each destination gets one backwards
   search, kept, so a route from anywhere is a walk downhill: about 1ms, after
   about 90ms for a new destination and about 2s for the first one in a world,
   which builds the graph and flies its flights. Ace uses it to fetch team
   flags and the antidote, and to carry a flag home.

   How fast he drives one is measured, not guessed: `npm run bench:pilot`
   (`scripts/bench-pilot.mjs`) runs every base-to-base pair of a map with
   the server bot's physics and Ace's driving strategies side by side --
   `ACE_TUNING` in `public/autopilot.mjs` holds the choices. On hix the
   defaults arrive 12 of 12, in 28 to 41 seconds: the straight line a
   person drives -- jump down onto the box in front of the base, drive off
   it, jump onto the box in front of the other base, and up again.

   That route exists because the graph flies its jumps and drops rather than
   assuming them. From every other column, each of the eight ways, it flies
   a jump and a drive off the edge at three forward speeds -- a flight keeps
   the speed it left with, so the speed is the pilot's one choice -- against
   each column's solid heights, landing on the first surface it comes down
   onto. Routes are priced in seconds, flights by their air time. Ace flies
   one as planned: square to it at its takeoff, at its speed, and with the
   turn for the next leg put on as he leaves, since a tank keeps turning
   through the air.

   Not yet: teleporters; surfaces narrower than a tank, which a person
   drives along hanging over both edges; building off the main thread, which
   the first route on the Orin will feel; and Ace using routes to chase or
   to wander.
   Roger only looks three ways and goes whichever is most open, and stays
   that way.
2. **Aiming.** Lead the target from shot speed instead of a fixed 300ms, and
   use the shot tracer for ricochet bank shots.
3. **Skill knobs.** As in step 3.
4. **Dodging.** Trace each enemy shot against the bot's own planned path,
   rather than reacting to the nearest shot only.
5. **Choosing.** Score each option (threat, flag value, team goal) rather than
   follow a fixed priority list.
6. **Team roles** for capture-the-flag: attack, defend, escort. Bots on a
   team divide the work between them -- one goes for the enemy flag, one
   brings ours back, one guards it -- and say so to each other, so two do
   not chase the same job. They coordinate over team and direct messages,
   which every player already has: the same channel for a server bot, a
   browser's autopilot and a person, who can read along or join in.
7. **Camping.** Holding a spot and shooting from it rather than chasing:
   a base deck, a tower. Worth it first with `GM` Guided Missile and `L`
   Laser, whose reach and aim do not depend on closing in. The lunge
   (`startLunge`) is the first piece: from a standstill, a moment at full
   speed so a shot carries to a still foe just out of reach -- base to base
   on HiX -- then a stop. What is missing is choosing to hold the spot at
   all; today Ace chases instead, and a lunge only happens when something
   else has him standing still.
8. **Fairness.** Ace sees everything the view holds -- every tank and shot,
   through walls, at any range -- and is meant to be as capable as he can be.
   How hard a bot plays against people is a setting for later: what a player
   in its seat could know (radar and window), going after whoever is winning,
   easing off someone far behind, and all-out for bot-against-bot games.

## Offline play

An offline bot needs kills, flags and scores decided in the browser.
`docs/tutorial-plan.md` stage 4 covers that cost. The pilot itself already
runs in the browser; what is missing is something to rule on what it does.
