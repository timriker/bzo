# Audio

The sound effects in `public/audio/` come from upstream BZFlag
(`bzflag/data/*.wav`) so that bzo sounds like the game it mirrors. See
`AGENTS.md` for the mapping between BZFlag's `SFX_*` codes and the events bzo
plays them for.

This lives here rather than beside the samples because everything under
`public/` is a document root: a README next to the assets it describes is served
to every client, and every edit to it changes the build id and reloads them.

| file | BZFlag SFX | bzo event |
|---|---|---|
| `fire.wav` | `SFX_FIRE` | a shot is fired |
| `boom.wav` | `SFX_SHOT_BOOM` | a shot expires or hits an obstacle |
| `laser.wav` | `SFX_LASER` | a laser is fired |
| `shock.wav` | `SFX_SHOCK` | a shock wave is fired |
| `missile.wav` | `SFX_MISSILE` | a guided missile is fired |
| `thief.wav` | `SFX_THIEF` | a Thief's beam is fired |
| `lock.wav` | `SFX_LOCK` | a guided missile has locked onto me |
| `ricochet.wav` | `SFX_RICOCHET` | a shot bounces off a building |
| `message_team.wav` | `SFX_MESSAGE_TEAM` | a team message arrives from somebody else |
| `message_private.wav` | `SFX_MESSAGE_PRIVATE` | a direct message addressed to me arrives |
| `message_admin.wav` | `SFX_MESSAGE_ADMIN` | a message on the admin channel arrives |
| `explosion.wav` | `SFX_EXPLOSION`, `SFX_DIE` | a tank is destroyed |
| `steamroller.wav` | `SFX_RUNOVER` | a tank is run over by a Steamroller |
| `jump.wav` | `SFX_JUMP` | a tank jumps |
| `flap.wav` | `SFX_FLAP` | a tank flaps its Wings |
| `land.wav` | `SFX_LAND` | a tank lands |
| `bounce.wav` | `SFX_BOUNCE` | a tank stands on an upward physics driver |
| `teleport.wav` | `SFX_TELEPORT` | a tank passes through a teleporter |
| `burrow.wav` | `SFX_BURROW` | a Burrow tank digs in below ground level |
| `phantom.wav` | `SFX_PHANTOM` | a Phantom Zone tank crosses a teleporter |
| `pop.wav` | `SFX_POP` | a tank appears (spawn) |
| `flag_grab.wav` | `SFX_GRAB_FLAG`, `SFX_GRAB_BAD` | a flag is picked up |
| `flag_drop.wav` | `SFX_DROP_FLAG` | a flag is dropped |
| `flag_won.wav` | `SFX_CAPTURE` | my team captured an enemy team's flag |
| `flag_lost.wav` | `SFX_LOSE` | my team's flag was captured |
| `flag_alert.wav` | `SFX_ALERT` | an enemy picked up my team's flag |
| `teamgrab.wav` | `SFX_TEAMGRAB` | a team mate picked up an enemy team's flag |
| `killteam.wav` | `SFX_KILL_TEAM` | I captured my own team’s flag |
| `hunt_select.wav` | `SFX_HUNT_SELECT` | every step of a hunt that is not its first or its last: a target marked or unmarked, the scoreboard cursor opened or closed, and being made the rabbit |
| `hunt.wav` | `SFX_HUNT` | hunting begins or ends -- the first target, the last one gone, hunting turned off -- and, positioned at the tank, once a second while a hunted tank is in your sights |

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
