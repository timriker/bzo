# Stock-client enhancements

Ideas for things bzo can give a stock BZFlag client that bzfs cannot. None
of it is built, and none is tested against a real client yet. Each idea
names the upstream code it rests on; paths are under `$HOME/bzflag/`.

## What bzo has that bzfs lacks

bzo writes each BZFlag client's packets itself, so it can send one player
something the others never get. bzfs broadcasts nearly everything: its
plugin API sets BZDB for everyone (`bz_updateBZDB*`, `include/bzfsAPI.h`)
and moves flags for everyone (see [objectives-plan.md](objectives-plan.md)).

The tools, all handled by the stock client (`src/bzflag/playing.cxx`):

- **Per-client `MsgSetVar`.** The client applies a BZDB change at any time.
  Physics vars are read live through `BZDBCache` or each frame
  (`LocalPlayer.cxx`); weather and sky have callbacks
  (`WeatherRenderer.cxx:84`, `BackgroundRenderer.cxx:238`).
- **Per-client `MsgAlive`.** Moves a living tank; `/mv` already does this
  (`server/bzflag-native.cjs`, `positionCorrection`). The client treats it
  as a new life (`LocalPlayer::restart`, `LocalPlayer.cxx:1039`): it drops
  its flag, deletes its shots and stops dead.
- **Per-client world at join.** Each client gets its own world blob, so
  rules fixed at join can differ by player or team. Water level and death
  physics drivers live there (`WorldBuilder.cxx:116`), not in BZDB, so they
  cannot change mid-game.
- **Per-client `MsgFlagUpdate`, `MsgAddPlayer`, `MsgCustomSound`,
  `MsgHandicap`, `MsgTimeUpdate`.**

## The rule for what others see

Other clients predict a remote tank from the position and velocity in its
last update, with *their own* gravity (`Player.cxx:1148`). So a change that
only alters the launch or speed draws right for everyone; a change to the
curve itself (gravity) draws wrong between updates. Upstream Wings already
has this mismatch (`_wingsGravity`, `LocalPlayer.cxx:361`). Shots carry
their own velocity in `MsgShotBegin`, so per-player shot speed draws right.

Collision is client-side, so per-client world geometry that changes what
is solid would desync players. Per-client world data must stay cosmetic or
passable.

## Movement

- **Pole Vault flag.** Send the holder a higher `_jumpVelocity`. Watchers
  see the right arc. Do not use `_gravity` for it.
- **Team transport.** A pad that sends two or more teammates elsewhere
  with `MsgAlive` once they have stood on it for a second or two, spaced
  apart on arrival. Flag carriers lose the flag on their own screen while
  the server still has them holding it: either re-send the grab after the
  move or refuse carriers (which also stops a capture shortcut).
- **Ice zones.** Inside a region, send `_momentumLinAcc`/`_momentumAngAcc`
  low (and `_friction`) so the tank slides. Watchers draw from velocity, so
  it looks right.
- **Low-gravity zones.** Per-client `_gravity` inside a region. Watchers
  see the hump jump at each update, as with Wings; acceptable for a
  novelty, not for a competitive map.
- **Climbing.** A flag or zone with a higher `_maxBumpHeight`, so the
  holder drives up steps others cannot.
- **Speed and turn buffs.** `_tankSpeed`, `_tankAngVel` per player, as a
  flag, a zone (a road, mud) or a handicap. bzo's own speed check must use
  the same per-player value.

## Weather and sky

- **Weather regions.** Rain or snow when a tank enters a region, cleared on
  exit: `_rainType`, `_rainDensity`, `_rainBaseColor`, puddles.
- **Night inside a zone.** Fog in a zone is built (bzw.md, "Zone
  variables"); `_syncTime` there, to make it night, is untested on a BZFlag
  client.
- **Alerts in the sky.** Flash a team's `_skyColor` when its flag is taken.
- **Badger King's ground snow** is a world-built layer whose `dynamicColor`
  alpha runs on the shared game clock. It cannot differ per player; a
  per-player version needs per-player world data at join.

## Combat

- **Per-player reload and range.** `_reloadTime` (`ShotPath.cxx`,
  `LocalPlayer.cxx`) and `_shotSpeed` as flags, rewards or handicap. bzo's
  shot validation must agree.
- **Radar range.** `_radarLimit` per player has a live callback
  (`ControlPanel.cxx:225`): a scout flag that sees further, or a jamming
  zone that shrinks it.
- **Handicap.** `MsgHandicap` lets bzo set any player's handicap, not only
  bzfs's score-based one: help a new player, or a team that is short.

## Hazards

- **Lava-floor flag.** bzo kills the holder when they touch the ground off
  an obstacle; a red `_skyColor` warns them. The stock client cannot redraw
  the ground (only `_drawGround`), and water level cannot change mid-game.
- **Hazard zones.** The same server-side kill for any region, with a sound
  (`MsgCustomSound` plays one of the client's own sounds by name,
  `playing.cxx:2081`) and a chat warning on entry.

## Information

- **Private flags.** Flags only one player or team sees: objectives,
  scavenger hunts, team supply drops. Covered in
  [objectives-plan.md](objectives-plan.md).
- **Personal countdowns.** `MsgTimeUpdate` to one player for a practice
  challenge or a team's capture timer.
- **Practice ghost.** A fake player (`MsgAddPlayer`, then updates) only one
  client sees, replaying a recorded line for them to follow. bzo ignores
  hits on it. Fits [practice-plan.md](practice-plan.md).
- **Decoys.** A ghost tank only the enemy team sees, from a Decoy flag.

## Parkour course

A course of checkpoints; finishing it sets off world weapons. The trigger
and the shots alone are possible on bzfs too: a plugin reads player updates
and calls `bz_fireServerShot` (`include/bzfsAPI.h:1723`), and Whammo's
servers already fire fireworks (`_courtFireworks`). bzo has the same call
for plugins ([plugins.md](plugins.md)), on its world-weapon path
(`server/shots.cjs`).

What only bzo adds for a stock client:

- **Private checkpoints.** The next checkpoint as a flag only that runner
  sees ([objectives-plan.md](objectives-plan.md)).
- **Personal timer.** `MsgTimeUpdate` to the runner alone.
- **Course moves.** A pole-vault gap (`_jumpVelocity`), an ice section, a
  climb (`_maxBumpHeight`) for the runner only, reset on leaving.
- **Ghost.** The best run so far as a tank only the runner sees.
- **Return.** A `MsgAlive` back to the start after finishing or falling.

The finish shots need care. Normal shots fly straight and never fall
unless `_shotsKeepVerticalVelocity` is set, so a fan fired upward is a
harmless show that leaves the map. Shots aimed into the arena kill as any
world weapon does: a reward barrage on the enemy base, say, is a rule
change, not decoration. `bz_fireServerShot` has no shooter, only a team
colour, so its kills belong to the world weapon; the older
`bz_fireWorldWep` takes a `fromPlayer` (`bzfsAPI.h:1712`).

## Constraints

- A new flag needs an XR answer as well; every idea here is server-side or
  BZDB, so bzo's web and XR clients must apply the same values.
- Images load only from images.bzflag.org for native clients, so new looks
  must be geometry, colours and existing textures.
- bzo's validation (speed, jump, shots) must use each player's own values,
  or it will reject what it allowed.

## First test

The pole vault: send `_jumpVelocity` to one real client under Xvfb and
watch it jump from a second client. Then the transport, with one of the
two carrying a flag.
