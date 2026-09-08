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
| `thief.wav` | `SFX_THIEF` | a Thief's beam is fired |
| `ricochet.wav` | `SFX_RICOCHET` | a shot bounces off a building |
| `explosion.wav` | `SFX_EXPLOSION`, `SFX_DIE` | a tank is destroyed |
| `steamroller.wav` | `SFX_RUNOVER` | a tank is run over by a Steamroller |
| `jump.wav` | `SFX_JUMP` | a tank jumps |
| `flap.wav` | `SFX_FLAP` | a tank flaps its Wings |
| `land.wav` | `SFX_LAND` | a tank lands |
| `teleport.wav` | `SFX_TELEPORT` | a tank passes through a teleporter |
| `pop.wav` | `SFX_POP` | a tank appears (spawn) |
| `flag_grab.wav` | `SFX_GRAB_FLAG`, `SFX_GRAB_BAD` | a flag is picked up |
| `flag_drop.wav` | `SFX_DROP_FLAG` | a flag is dropped |
| `flag_won.wav` | `SFX_CAPTURE` | my team captured an enemy team's flag |
| `flag_lost.wav` | `SFX_LOSE` | my team's flag was captured |
| `flag_alert.wav` | `SFX_ALERT` | an enemy picked up my team's flag |
| `teamgrab.wav` | `SFX_TEAMGRAB` | a team mate picked up an enemy team's flag |
| `killteam.wav` | `SFX_KILL_TEAM` | I captured my own team's flag |
| `hunt_select.wav` | `SFX_HUNT_SELECT` | I have just been made the rabbit |
