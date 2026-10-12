# World variables

Every BZDB variable bzo reads, what it does here and its default. A world
sets one with `-set <name> <value>` in its map's `options` block (see
**The `options` block** in [bzw.md](bzw.md)); the server's own `bzdb` block in
`server.json` sets one for every map ([installation.md](installation.md)). A
running server changes one with `/set` and `/reset`.

Defaults are upstream's (`src/common/global.cxx`) unless the table says
otherwise. A default written as a formula follows the variables it names, so
`_tankLength 5` makes `_tankRadius` `0.72 * 5`. A switch is on for any
nonzero number, as upstream's `BZDB.isTrue` reads it. A colour is three or
four numbers, or a name from upstream's X11 table (`black`, `grey3`,
`DarkGrey`), optionally with an alpha (`red 0.5`); a colour with spaces in it
is quoted on a `-set` line.

A variable not listed here is kept and passed to clients, but changes
nothing. The `/list` page shows, for each server, how many of its variables
bzo reads.

## Tank

| variable | default | effect |
|---|---|---|
| `_tankSpeed` | 25 | how fast a tank drives |
| `_tankAngVel` | 0.785398 | how fast a tank turns, radians a second |
| `_gravity` | -9.8 | the world's gravity; bzo keeps the magnitude, so `-9.8` and `9.8` are the same |
| `_jumpVelocity` | 19 | how hard a jump pushes off |
| `_maxBumpHeight` | 0.33 | how high a step a tank climbs without jumping |
| `_noClimb` | 1 | on, a jump from a slope -- a pyramid's side, a tetra, a sloped mesh face -- goes straight up; 0 lets a tank jump its way up one |
| `_friction` | 0 | a cap on how fast a tank's velocity changes on the ground, 20 units/s² per unit; 0 is none |
| `_momentumFriction` | 0 | the same while carrying `M` Momentum |
| `_tankLength`, `_tankWidth`, `_tankHeight` | 6, 2.8, 2.05 | the tank's size: how it collides, how it is hit and how big it is drawn |
| `_tankRadius` | `0.72 * _tankLength` | the radius a flag is grabbed within |
| `_muzzleFront`, `_muzzleHeight` | `_tankRadius + 0.1`, 1.57 | where a shot leaves the tank |
| `_tankExplosionSize` | `3.5 * _tankLength` | how big a tank's explosion is |
| `_explodeTime` | 5 | how long a dead tank waits to spawn again, and how long its pieces tumble; 0 is no wait |
| `_rejoinTime` | `_explodeTime` | how long a player who left after playing waits to spawn on coming back; the tank spawns by itself once the wait is up. server.json's `rejoinTime` sets it too |
| `_squishFactor`, `_squishTime` | 1, 1 | how far a hard landing flattens a tank (0 is not at all), and how long it takes to stand back up |
| `_flagEffectTime` | 0.64 | how long a tank takes to change size, grow in on spawning, or fade; may be 0 |
| `_pauseDropTime` | 15 | how long a paused tank keeps its flag; may be 0 |

A shot hits a tank within `0.99 * _tankRadius` of its middle, as upstream's
does. bzo's own collision height and default muzzle keep their ratio to
upstream's figures when a world resizes the tank.

`_explodeTime` is bzfs's spawn delay for each victim (`bzfs.cxx:3371`).
`_rejoinTime` is something else (`RejoinList.cxx:73`). Coming back through
the entry dialog counts as leaving, as reconnecting does.

## Shots

| variable | default | effect |
|---|---|---|
| `_shotSpeed` | 100 | how fast a shot travels |
| `_shotRange` | 350 | how far a shot travels before it dies |
| `_shotRadius` | 0.5 | a shot's own size |
| `_reloadTime` | `_shotRange / _shotSpeed` | how long a shot lives, and the basis each slot's reload is divided out of |
| `_shotsKeepVerticalVelocity` | 0 | a shot fired in the air keeps the tank's climb or fall |

`_reloadTime` is the basis every shot time is derived from: a shot lives for
it, and the slot that fired comes back after it. A map that states it and
`-ms` has them applied together, since the pair fixes the sustained rate. A
flag scales both halves and not equally -- see AGENTS.md's **Shot timing**.

## Flags

| variable | default | effect |
|---|---|---|
| `_maxFlagGrabs` | 4 | how many pickups a superflag survives |
| `_flagAltitude` | 11 | how high a flag is thrown or flies in from (Shield goes higher still) |
| `_flagPoleSize` | 0.8 | how tall a flag's pole is drawn |
| `_flagHeight` | 10 | the clearance a flag spawns under; the `world` block's `flagHeight` wins |
| `_mGunAdVel`, `_mGunAdRate`, `_mGunAdLife` | 1.5, 10, `1 / _mGunAdRate` | `MG` Machine Gun: shot speed, reload rate and life, each a multiple of an ordinary shot's |
| `_laserAdVel`, `_laserAdRate`, `_laserAdLife` | 1000, 0.5, 0.1 | `L` Laser, the same three |
| `_rFireAdVel`, `_rFireAdRate`, `_rFireAdLife` | 1.5, 2, `1 / _rFireAdRate` | `F` Rapid Fire, the same three |
| `_thiefAdShotVel`, `_thiefAdRate`, `_thiefAdLife` | 8, 12, 0.05 | `TH` Thief's beam, the same three |
| `_thiefVelAd`, `_thiefTinyFactor` | 1.67, 0.5 | how fast a Thief tank drives, and how small it is |
| `_thiefDropTime` | `_reloadTime * 0.5` | the reload a Thief pays once the flag leaves it; may be 0 |
| `_shockAdLife` | 0.2 | how long an `SW` Shock Wave lasts, as a share of a shot's life |
| `_shockInRadius`, `_shockOutRadius` | `_tankLength`, 60 | the radius a shock wave starts at (may be 0) and grows to |
| `_gmAdLife` | 0.95 | `GM` Guided Missile's life, as a share of a shot's |
| `_gmTurnAngle` | 0.628319 | how far a `GM` turns toward its lock each second, radians |
| `_gmActivationTime` | 0.5 | how long a `GM` flies before it may hit anything; may be 0 |
| `_gmSize` | 1.5 | how long the `GM` missile is drawn |
| `_lockOnAngle` | 0.15 | the cone a `GM` lock is picked from, radians |
| `_forbidMarkers` | 0 | no `GM` lock-on bracket |
| `_identifyRange` | 50 | how far `ID` Identify reaches for the nearest flag on the ground |
| `_burrowSpeedAd`, `_burrowAngularAd` | 0.8, 0.55 | how fast a `BU` Burrow tank drives and turns underground, as a share of an ordinary one's |
| `_velocityAd`, `_angularAd` | 1.5, 1.5 | how much faster `V` Velocity drives and `QT` Quick Turn turns |
| `_tinyFactor`, `_obeseFactor` | 0.4, 2.5 | the size `T` Tiny and `O` Obesity make a tank |
| `_narrowFactor` | 0.001 | how thin `N` Narrow makes a tank; bzo's own, upstream draws it flat |
| `_agilityAdVel`, `_agilityTimeWindow`, `_agilityVelDelta` | 2.25, 1, 0.3 | `A` Agility's burst: how fast, how long, and how big a change of speed sets it off |
| `_srRadiusMult` | 2 | how far `SR` Steamroller reaches, in tank radii |
| `_wingsJumpCount` | 1 | how many times `WG` Wings flaps before it needs the ground again |
| `_wingsJumpVelocity`, `_wingsGravity` | `_jumpVelocity`, `_gravity` | Wings' flap and its gravity |
| `_wingsSlideTime` | 0 | how long a Wings tank takes to reach a new speed in the air; 0 is at once |

## World

| variable | default | effect |
|---|---|---|
| `_worldSize` | 800 | the width of a generated world (`"mapFile": "random"`); a map file's own `world size` wins |
| `_wallHeight` | `3 * _tankHeight` | how high the border wall stands, which is where shots stop bouncing off it |
| `_boxBase`, `_boxHeight` | 30, `6 * _muzzleHeight` | the half width and height of a `box` that states none; `_boxHeight` also sets how box walls tile and how fast the radar's height box grows |
| `_pyrBase`, `_pyrHeight` | `4 * _tankHeight`, `5 * _tankHeight` | the same for a `pyramid` |
| `_radarLimit` | `_worldSize` | the farthest the radar reaches (a quarter of it while burrowed); 0 or less is no radar. `-noradar` sets it |
| `_hideTeamFlagsOnRadar` | 0 | team flags lying on the ground are off the radar |
| `_hideFlagsOnRadar` | 0 | every flag lying on the ground is off the radar; a carried flag still shows with its tank |
| `_forbidHunting` | 0 | a hunted tank in the sights is never announced; marking still works |
| `_spawnSafeRadMod` | 20 | tank radii a spawn keeps from a tank facing it |
| `_spawnSafeSRMod` | 3 | tank radii a spawn keeps from a Steamroller or Burrow tank |
| `_spawnSafeSWMod` | 1.5 | the share of a Shock Wave's reach a spawn keeps from it |
| `_spawnMaxCompTime` | 0.01 | how long the spawn search looks before taking the farthest-from-enemies spot found |
| `_disableBots` | 0 | no robots or autopilot on this server, as `-disableBots`; `/set` changes it live |
| `_disallowSelfCap` | 0 (bzo's) | no capturing your own team's flag. From allejo's [ctfOverseer](https://github.com/allejo/ctfOverseer) plugin, whose default is on |
| `_delayTeamFlagGrab` | 0 (bzo's) | seconds after a capture that the team flag cannot be grabbed by an enemy; its own team still may. ctfOverseer's, default 20 there |
| `noWalls`, `freeCtfSpawns` | 0 | the `world` block's two switches, which upstream keeps as BZDB: no border wall, and a CTF tank spawning anywhere rather than on its base |

`_wallHeight` may be 0: the visible wall is gone, every shot leaves the world
over it, and tanks are still held at the edge, as by upstream's
height-ignoring `WallObstacle`.

## Server checks

| variable | default | effect |
|---|---|---|
| `_disableSpeedChecks` | 0 | the server's speed check is off |
| `_speedChecksLogOnly` | 0 | a speed finding is logged and not refused, whatever the anti-cheat mode |
| `_updateThrottleRate` | 30 | the most position updates a client sends a second; 0 is no limit |
| `_notRespondingTime` | 5 | how long a playing tank may go unheard before it is marked not responding: `[nr]` on the scoreboard, its flag dropped where it was last seen, a new rabbit if it was one, and no lock on it until its next move. Never less than two of bzo's idle heartbeats (`MAX_UPDATE_INTERVAL`) |
| `_scoreSaveTime` | 120 (bzo's) | seconds a player's score is kept after they leave; back on rejoining with the same callsign from the same address. 0 keeps none. Not upstream's: it is allejo's [ScoreRestorer](https://github.com/allejo/ScoreRestorer) plugin, which many servers run; a restart for new code (nodemon, a Docker upgrade) keeps them the same way, but not one onto a changed map or changed server options (`scores.json`). A server bot's waits with no time limit |
| `_angleTolerance` | 0.05 | how far a tank's heading may drift from what its last move predicts before its client sends another, radians |
| `_endShotDetection` | 5 | read, no effect: bzfs kicks a client that reports more shot ends than this, and a bzo client reports none |
| `_coldetDepth`, `_coldetElements`, `_cullDepth` | 6, 4, 6 | read, no effect: they tune upstream's collision and cull octrees, which bzo does not build |

## Sky and scenery

| variable | default | effect |
|---|---|---|
| `_drawSky` | 1 | 0 is no sky at all -- colours, sun, moon and stars -- just black |
| `_drawMountains`, `_drawClouds`, `_drawCelestial`, `_drawGround` | 1 | whether the world draws its mountains, clouds, sun, moon and stars, and ground; a viewer's own settings can take away more, never put back |
| `_drawGroundLights` | 1 | the pools of light shots and flags cast on the ground |
| `_skyColor` | white | a tint over the whole sky; white is none |
| `_latitude`, `_longitude` | 37.5, 122 | where the sky stands: degrees north, and degrees *west* (upstream's sign) |
| `_syncTime` | -1 | hold the sky still at that many seconds past the Unix epoch; -1 is the real time now. `-synctime`'s 1 is the first second of 1970 |
| `_syncLocation` | 0 | read, always on: a browser has no place of its own, so the world's `_latitude` and `_longitude` place the sky |
| `_fogMode` | none | `none`, `linear`, `exp` or `exp2`; any but `none` is fog, and one bzo does not know is `exp`, as upstream reads it |
| `_fogDensity`, `_fogStart`, `_fogEnd` | 0.001, `0.5 * _worldSize`, `_worldSize` | the fog's density, and where linear fog starts and ends |
| `_fogColor` | 0.25 0.25 0.25 | the fog's colour |
| `_fogNoSky` | 0 | 1 keeps the fog off the sky |
| `_mirror` | none | a mirror ground: the world reflected in it under the colour as a tint, at the colour's alpha (half when it states none, or states 1, as upstream reads it) |
| `_noShadows` | 0 | no tank or building shadows |
| `_trackFade` | 3 | how long tread marks last; 0 leaves none |

On a server with `"sky": "minecraft"` (AGENTS.md) only `_syncTime` and
`_longitude` are read, and they freeze the day clock at an hour.

## Weather

`_rainType` turns weather on; the rest tune it. Each defaults to the preset's
own value. See **Weather** in [bzw.md](bzw.md) for how it is drawn.

| variable | default | effect |
|---|---|---|
| `_rainType` | none | `rain`, `snow`, `fatrain`, `frog`, `particle` or `bubble` |
| `_rainDensity` | 1000, `particle` 500 | how many drops are in the air at once |
| `_rainSpread` | 500 | how far from the map's centre a drop may fall |
| `_rainSpeed`, `_rainSpeedMod` | preset | fall speed, and how much it varies drop to drop |
| `_rainStartZ`, `_rainEndZ` | sky, ground | the top and bottom of the fall |
| `_rainTexture`, `_rainPuddleTexture` | preset | either stock texture |
| `_useRainPuddles` | preset | puddles on or off |
| `_rainMaxPuddleTime`, `_rainPuddleSpeed` | 1.5, 1 | how long a puddle lasts, and how fast it grows |
| `_rainPuddleColor` | preset | the puddles' tint |
| `_rainSpins` | preset | whether a drop tumbles as it falls |
| `_rainRoofs` | 1 | 0 lets rain fall through a roof; 1 stops it at the first roof; 2 also puddles the roof |
| `_useLineRain` | 0 | draw each drop as upstream's line streak |
| `_rainBaseColor`, `_rainTopColor` | 0.75 0.75 0.85 0.75, 0 0 0 0 | the line streak's colour at the drop and at its tail |

`_useRainBillboards`, `userRainScale` and `_rainSize` are not read: bzo draws
each preset's best-looking variant, at the preset's own size.
