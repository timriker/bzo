# Objectives

A plugin gives one player a place to go: a flag only that player sees, on
radar and in 3D, and a task line pinned in the HUD ("Go to the red flag").
When the player reaches it, the flag flies off and the task clears or moves
on to the next one. The first map that needs this is Moroni Invitational. None
of it is built. Upstream references are paths under `$HOME/bzflag/`.

## Upstream has no private flag

bzfs sends a flag's every change to everyone (`sendFlagUpdate(FlagInfo&)`,
`src/bzfs/bzfs.cxx:361`). It sends the whole list to one player only when
that player joins (`:428`). `bz_moveFlag` and `bz_resetFlag` broadcast too. A
bzfs plugin can only fake a private flag by writing raw packets past the API.
bzo builds a BZFlag client's packets itself, so it can do this properly.

Upstream's HUD alerts (`hud->setAlert`, `src/bzflag/playing.cxx`) are only
ever set by the client itself. The server can only reach a BZFlag client
through chat.

## One spare flag slot

A BZFlag client makes room for as many flags as `numFlags` says in the game
settings (`server/bzflag-server.cjs:169`, read by `WorldBuilder.cxx:230`).
On a map with objectives, bzo adds one slot above the real flags. Nobody holds
it, and everyone sees it as `FlagNoExist` until they are given an objective.

To give one player an objective, bzo sends a `MsgFlagUpdate` for that slot to
that player's connection only. It says `FlagOnGround` at the objective's
position, with the type the map asks for: the red team flag, say, on a map
where red's real flag is nowhere. That player's radar and world show the flag.
Nobody else's do.

The browser takes the same per-player `flagUpdate` on the same slot, so both
kinds of client follow one rule. The radar ring and sky beacon in
`public/js/hunt.mjs` point at it as they do at a team flag, which also covers
XR.

## Arrival

The BZFlag client asks to grab any flag it drives over
(`playing.cxx:4119-4142`), but only when:

- it is alive and not paused;
- it carries no flag;
- it is on the ground or on a building;
- it is within 0.1 of the flag's height.

So an objective has to sit exactly on a surface. A player carrying a flag
can't "arrive" through the grab at all.

bzo therefore decides arrival itself, from the player's position against the
objective (tank radius plus `_flagRadius`, as upstream measures it). A
`MsgGrabFlag` for the spare slot is only a hint to check now. It is never
taken as a real grab, never answered with `MsgGrabFlag`, never reaches
`bz_eFlagGrabbedEvent`, and never counts toward a capture.

On arrival, bzo sends that player the slot as `FlagGoing`, the way upstream
does when a flag resets, so the client plays its own fly-off. Then it sends
the next objective, or `FlagNoExist`.

## The pinned task

- **Browser:** a server message sets a `hud.js` alert slot with no timeout and
  clears it on arrival. It reuses `setAlert`'s slots and drawing; no new UI.
- **BZFlag clients:** a chat line from the server when the objective is set,
  and another on arrival. Nothing stays on screen for them.

## Plugins set objectives

A plugin decides who gets which objective and when, from whatever it likes:
team, score, time, zones, other players' objectives. The server only shows
the objective and reports arrival. Upstream has no such API, so these calls
are bzo-only. They sit beside the ported API under names that don't pass for
upstream's:

- `bz_setObjective(playerID, flagType, pos, text)` replaces the player's
  objective, if they have one.
- `bz_clearObjective(playerID)`.
- `bz_getObjective(playerID)`.
- An arrival event that carries the player and the objective. The plugin
  answers it with the next objective or with nothing.

A player has at most one objective at a time. It ends when the player leaves.
Dying doesn't end it. Moroni Invitational ships with its own plugin.

## Bots follow objectives

Server-side bots (`server/bots.cjs`, `bot-worker.cjs`) are players to a
plugin, so a plugin gives a bot an objective the same way it gives one to a
person. The bot reads its objective as a goal and scores it alongside threats
and flags, which is "Choosing" under step 4 of
[bots-plan.md](bots-plan.md). A bot gets no flag packet and no HUD line, only
the goal. A bot carrying a flag still arrives, because the server, not a
grab, decides arrival.

A plugin can also read the other players' objectives (`bz_getObjective`). It
can then send bots to defend a place players are heading to, or to race them
there.

## Catches

- A team-coloured flag on radar reads as "team flag". That's fine on a map
  with one team, but misleading in CTF. Prefer a non-team type there.
- A bzo client proxied to a remote bzfs gets no objectives. Only bzo's own
  server has them.
- Replays and observers should see each player's objective, or none. Decide
  when recording reaches it.
