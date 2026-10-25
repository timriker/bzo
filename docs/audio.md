# Audio

The sound effects in `public/audio/` come from upstream BZFlag
(`bzflag/data/*.wav`) so that bzo sounds like the game it mirrors. Below is
every sample, the name `playSound()` asks for it by, the BZFlag `SFX_*` code
it answers, and the event bzo plays it for. The manifest in `public/js/audio.js`
holds the same mapping in code, with each sound's distance and volume.

This lives here rather than beside the samples because everything under
`public/` is a document root: a README next to the assets it describes is served
to every client, and every edit to it changes the build id and reloads them.

| bzo name | file | BZFlag SFX | bzo event |
|---|---|---|---|
| `fire` | `fire.wav` | `SFX_FIRE` | a shot is fired |
| `shotBoom` | `boom.wav` | `SFX_SHOT_BOOM` | a shot expires or hits an obstacle |
| `laser` | `laser.wav` | `SFX_LASER` | a laser is fired |
| `shock` | `shock.wav` | `SFX_SHOCK` | a shock wave is fired |
| `missile` | `missile.wav` | `SFX_MISSILE` | a guided missile is fired |
| `thief` | `thief.wav` | `SFX_THIEF` | a Thief's beam is fired |
| `lock` | `lock.wav` | `SFX_LOCK` | a guided missile has locked onto me |
| `ricochet` | `ricochet.wav` | `SFX_RICOCHET` | a shot bounces off a building |
| `messageTeam` | `message_team.wav` | `SFX_MESSAGE_TEAM` | a team message arrives from somebody else |
| `messagePrivate` | `message_private.wav` | `SFX_MESSAGE_PRIVATE` | a direct message addressed to me arrives |
| `messageAdmin` | `message_admin.wav` | `SFX_MESSAGE_ADMIN` | a message on the admin channel arrives |
| `explosion` | `explosion.wav` | `SFX_EXPLOSION`, `SFX_DIE` | a tank is destroyed |
| `runOver` | `steamroller.wav` | `SFX_RUNOVER` | a tank is run over by a Steamroller |
| `jump` | `jump.wav` | `SFX_JUMP` | a tank jumps |
| `flap` | `flap.wav` | `SFX_FLAP` | a tank flaps its Wings |
| `land` | `land.wav` | `SFX_LAND` | a tank lands |
| `bounce` | `bounce.wav` | `SFX_BOUNCE` | a tank stands on an upward physics driver |
| `teleport` | `teleport.wav` | `SFX_TELEPORT` | a tank passes through a teleporter |
| `burrow` | `burrow.wav` | `SFX_BURROW` | a Burrow tank digs in below ground level |
| `phantom` | `phantom.wav` | `SFX_PHANTOM` | a Phantom Zone tank crosses a teleporter |
| `pop` | `pop.wav` | `SFX_POP` | a tank appears (spawn) |
| `flagGrab` | `flag_grab.wav` | `SFX_GRAB_FLAG`, `SFX_GRAB_BAD` | a flag is picked up |
| `flagDrop` | `flag_drop.wav` | `SFX_DROP_FLAG` | a flag is dropped |
| `flagWon` | `flag_won.wav` | `SFX_CAPTURE` | my team captured an enemy team's flag |
| `flagLost` | `flag_lost.wav` | `SFX_LOSE` | my team's flag was captured |
| `flagAlert` | `flag_alert.wav` | `SFX_ALERT` | an enemy picked up my team's flag |
| `teamGrab` | `teamgrab.wav` | `SFX_TEAMGRAB` | a team mate picked up an enemy team's flag |
| `killTeam` | `killteam.wav` | `SFX_KILL_TEAM` | I captured my own team’s flag |
| `huntSelect` | `hunt_select.wav` | `SFX_HUNT_SELECT` | every step of a hunt that is not its first or its last: a target marked or unmarked, the scoreboard cursor opened or closed, and being made the rabbit |
| `hunt` | `hunt.wav` | `SFX_HUNT` | hunting begins or ends -- the first target, the last one gone, hunting turned off -- and, positioned at the tank, once a second while a hunted tank is in your sights |

**Levels mirror BZFlag exactly, and there is no per-sound volume.** BZFlag scales
every sample only by distance and one global setting; the samples are pre-mixed
relative to each other, so adding per-sound gain undoes that balance. Its
attenuation, from `getWorldStuff()` in `src/bzflag/sound.cxx`, is
`amplitude = d < 86.4 ? 1 : 86.4 / d`, where `86.4` is 20 BZFlag tank radii
(`20 * 4.32`). That is the Web Audio `inverse` distance model with
`refDistance = 86.4` and `rolloffFactor = 1`, which reproduces the curve exactly.
The constant scales with the world, not the vehicle, so it stays `4.32` when a
world resizes the tank. Tune `MASTER_VOLUME` in `public/js/audio.js`, not
individual sounds.

**A limiter holds the mix** (`GAME_LIMITER`, `public/js/audio.js`). The samples
peak at full scale, so an explosion beside another sound sums past it; clipped,
that is a pop, and on some outputs a second of near silence after. A
compressor just under full scale between the Game volume and the speakers
catches only those pile-ups. Upstream's mixer clamps the sum instead. Voice
does not go through it.

## Shipped but not triggered

`public/audio/` holds every `.wav` upstream's `data/` does, so the two sets can
be compared file for file. Four of them have nothing in bzo that plays them, and
so are deliberately absent from `GAME_SOUNDS`: only what is registered there is
preloaded, and the service worker caches `/audio/` on first use rather than up
front, so an unregistered file is never fetched.

| file | BZFlag SFX | why bzo has no trigger |
|---|---|---|
| `spree1.wav` | -- | upstream ships all four and references none of them anywhere in its tree: they appear only in `data/Makefile.am`. There is no upstream behaviour to mirror |
| `spree2.wav` | -- | as above |
| `spree3.wav` | -- | as above |
| `spree4.wav` | -- | as above |
