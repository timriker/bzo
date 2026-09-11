# AGENTS.md

Canonical instructions and project memory for AI coding agents working in this
repository. `CLAUDE.md` and `.github/copilot-instructions.md` both point here, so
Claude Code, GitHub Copilot, and any other agent read the same file.

## Reference: upstream BZFlag

The upstream BZFlag C++ source is checked out at `$HOME/bzflag/`. **Consult it
before designing or fixing gameplay logic.** bzo mirrors BZFlag except where the
web, mobile, or XR platform makes the upstream approach nonsensical (input
methods, rendering stack, network transport, UI shell).

Useful subtrees: `src/obstacle/` (obstacle geometry and collision),
`src/game/Intersect.cxx` (rect/circle primitives), `src/bzfs/` (server),
`src/bzflag/` (client), `include/`.

Prefer upstream naming too -- see `docs/tank-model-format.md` for tank part names.

### Capability, not cost

`public/capabilities.mjs` reads what the machine can do from the
renderer's own WebGL context, and answers only **can this run here**, never
**is this fast enough here**. Where a capability is missing, disable the feature
*and* the UI that offers it -- a row that promises what the context cannot draw
is worse than a row that is plainly unavailable. Stencil bits gate the projected
shadow pass; fragment uniform vectors gate dynamic lighting. Every launch logs
the full set as `renderer.capabilities` in `server.log`, which is how the
measurements for a future render level get collected.

Do not add a second GL context to probe with. The renderer's own context
answers everything, and a spare one is a real cost on a phone.

### Intentional deviations from BZFlag

These are deliberate. Do not "fix" them without being asked.

- **Clients rejoin without waiting for a click.** BZFlag makes the player
  confirm before respawning; bzo respawns automatically after the same 5 second
  delay.
- **The second team on a map is placed across from the first.** Upstream picks
  evenly among the teams that tie (`autoTeamSelect`, `bzfs.cxx:1902`), which
  leaves two of the three remaining teams as neighbours of the first: the team
  across the map comes up only a third of the time. bzo weights that one choice
  by the squared distance between the two teams' bases, which on a map with its
  bases at the compass points makes the far team exactly twice as likely as
  either neighbour -- 50/25/25. Only that choice: once two teams are populated
  there is no single team across the map, and a player joining teams that
  already exist is picked as upstream picks. Distance never overrides the
  balancing, only the even pick among candidates that already tie.
- **An open menu or a hidden window pauses the tank.** Upstream pauses when its
  window is iconified and resumes when it is restored (`pausedByUnmap`,
  `playing.cxx:124`). `document.hidden` is the browser's word for iconified and
  bzo pauses on it; bzo also hangs the same behaviour on the menus, which
  are the other thing that covers the screen here -- Settings, Audio, Help, Operator, Entry and
  the XR menu alike, since they all arrive as `INPUT_CONTEXT.DIALOG` or
  `INPUT_CONTEXT.ENTRY`. Walking from one into another holds the pause, because
  the context never leaves; leaving the last of them is what lifts it. Unlike
  upstream, which hides the countdown for a pause the window manager asked for,
  bzo counts it down in front of the menu that started it. The rest is upstream's:
  the pause is remembered as bzo's own, so closing a menu never resumes a pause
  the player took with the pause key, and the pause key is ignored while bzo
  holds it. Both sources reconcile through one `syncAutoPause()` rather than each
  toggling a pause: hiding the window while a menu is open and showing it again
  leaves the tank paused, because the menu still is. The pause countdown itself
  lives on the server, unlike upstream's, because the server is what decides
  whether a tank may be hit -- so the client keeps a copy of it, and
  `public/pause.mjs` holds the rules over both, which is what stops the two ways
  to pause drifting apart.

  **A pause belongs to the life it was taken in, and the asking outlives it.**
  Upstream abandons a countdown the moment the tank stops being alive
  (`playing.cxx:6866`) and so does bzo, on both ends: the server drops its
  countdown and its pause in `respawn()` without sending anything, and the client
  drops its copy off the same fact rather than waiting to be told. The next life
  then asks again for whatever is still true -- a menu still in front of the
  game, or the countdown the player was in when they died -- and the pause key
  calls that off like any other. Unlike upstream, self destruct counts down too
  (`Q`, five seconds, `cmdDestruct`), and it ends by asking the server to do the
  killing rather than blowing the tank up where it stands.

  A window that is merely unfocused is not paused for, because it is still on
  screen and upstream does not pause for that either. Sound is not muted while
  paused, which upstream does do: the game is meant to keep playing behind a
  menu, and one of the menus is the audio settings.
- **Clients reconnect directly when the server restarts**, rather than dropping
  to a menu -- unless the client code itself changed, in which case they reload.
  The server hashes `public/` and Three's build directory by content at boot and
  sends that id in the `init` message; a page keeps the id it booted with and
  reloads on any `init` carrying a different one. Without it a tab reconnects
  across restart after restart and can run code from before the edit
  indefinitely, which is how an unattended test client ends up reporting stats
  nobody can attribute. Editing `server.json` or a map does not change the id,
  so those restarts stay silent. The same id keys the service worker's cache, so
  a reload reaches new textures and audio rather than the copies a cache keyed
  to the release version would have kept alive.

- **bzo does not mirror BZFlag's client display options.** Upstream exposes
  `useFancyEffects`, `spawnEffect`, `shotEffect`, `deathEffect`, `landEffect`,
  `ricoEffect`, `tpEffect` and friends as ReadWrite BZDB, largely so the game
  degrades on old hardware. bzo needs hardware-accelerated WebGL to run at all,
  so that tradeoff does not apply -- but the direction that points is toward
  upstream's **best**-looking variant, not its default. **Implement the
  highest quality option upstream has for a given effect, and ship no
  setting for it, unless a measurement shows a real frame-rate cost** -- in
  which case the cheaper variant is what ships, still with no toggle. Do not
  default to upstream's own default on the assumption that it is the safe
  choice: upstream picked its defaults for hardware from a decade before
  bzo's, and a look most players immediately turn up in their own client is
  the one worth having here from the start.

  Render levels chosen from the hardware -- a low/balanced/high policy, scaled
  pixel ratio, budgeted effects -- are wanted **eventually**, and are what
  will eventually carry the cheaper fallback automatically on the hardware
  that needs it, rather than a manual setting. Nothing here has been measured
  on the machines that matter, and a policy built on guesses is worse than
  none: it hides the cost it claims to manage. Frame *interval* in particular
  is not the measurement to build on, since a vsync-limited client reports its
  refresh rate however much headroom it has. Land the measurements first.
- **Tanks are selectable OBJ models, not one compiled-in model.** BZFlag ships a
  single tank in `src/geometry/models/tank/` at three LODs, varied only by the
  `animatedTreads` and `treadStyle` settings. bzo loads several models from
  `public/obj/` and lets the player choose; `docs/tank-model-format.md` defines
  the part-naming contract, which keeps upstream's `body`/`turret`/`barrel`/
  `ltread`/`rtread` names. The death explosion throws the tank's own parts, so
  it differs from upstream's as a consequence. Accepted for now -- do not report
  the model set or the explosion as parity gaps.

  **A tank comes from an OBJ file or it does not exist.** There is no generic
  tank to fall back on when a model will not build: a stand-in reports a broken
  model as working and leaves the fault to be found in play, where an unfamiliar
  tank shape is the last thing anyone reads as a broken asset. A model missing
  its parts is kept out of the picker by the server as it lists `public/obj/`,
  and reaching `createTank` with one is an error on the console. Do not add a
  procedural tank, and do not substitute another model for one that failed --
  the same rule the audio has.

- **The sky follows a Minecraft clock, not real astronomy.** BZFlag computes
  where the sun and moon actually are: `SceneRenderer::setTimeOfDay` takes a
  Julian day and feeds `getSunPosition`/`getMoonPosition` in `daylight.cxx`,
  which work from Greenwich sidereal time and the server's `_latitude` and
  `_longitude`, so the arc tilts with latitude and the moon carries a real phase
  and its own position in the sky. bzo instead runs a Minecraft-style tick
  clock: `worldTime` 0..23999 sweeps the sun through a fixed arc in the world's
  X--Y plane, and the moon sits exactly opposite it, full and unphased. Sun for
  day, moon for night.

  What bzo does take from upstream is how big they look and how far away they
  are -- `2 * worldSize`, sized by the angle they subtend
  (`makeCelestialLists`) -- because that is what makes them read as the sun and
  the moon rather than as spheres in the distance. Do not report the arc, the
  missing phases, or the absence of latitude as parity gaps.

- **The radar range is not saved between sessions.** BZFlag persists
  `displayRadarRange` with the rest of BZDB. bzo starts every session at
  upstream's `0.5` default (Medium) instead, because a headset has no key,
  scroll wheel, or on-screen control to zoom the radar with -- a level left
  behind by a desktop session would strand a headset player at a range they
  cannot change.
- **Three surfaces point at what upstream points at with one.** Upstream marks
  the player's own team flags and the antidote on the heading tape alone
  (`prepareTheHUD`, `playing.cxx:6820`). It rings nothing on the radar, and the
  only tank it ever singles out there is the *hunted* one, whose blip flashes
  cyan every fifth of a second (`RadarRenderer.cxx:136`) as part of a hunt
  feature bzo does not have. bzo keeps the tape and adds two marks over the same
  things, plus the rabbit: a **ring** on the radar, pinned to the border of the
  panel when the thing is past range, and a **sky beacon** standing in the world
  over it -- a half-transparent cone hanging from the cloud layer down to a
  point just above the target.

  Upstream marks the same two things twice, not once. Two lines below the
  `addMarker` that feeds the tape, `prepareTheHUD` also calls
  `hud->AddEnhancedMarker` (`playing.cxx:6842` for a team flag, `:6855` for the
  antidote), and `HUDRenderer::drawWaypointMarker` projects that world position
  with `gluProject` and draws a triangle in **screen space**: apex on the
  target, base above it, `hudWayPMarkerSize` (15) a side at alpha 0.45, the
  team's colour for a team flag and yellow for the antidote. Off screen or
  behind, it clamps to the nearest screen edge and rotates to point inward,
  which is the pinning bzo's radar rings do. It is drawn at the tail of
  `renderBox`, after `renderStatus`, so it sits over the shot clocks and under
  the lock-on marker `drawLockonMarker` adds immediately after it. Upstream
  marks no rabbit anywhere.

  So the beacon is not a bzo invention, but it is not upstream's marker either,
  and the difference is the point: a screen-space triangle has no depth test, so
  it is drawn in front of the building the flag is behind and never says the
  flag is behind one. The beacon stands *in* the world, is occluded like
  anything else there, and works in a headset, which a mark positioned in screen
  space cannot -- there is no screen. `hudWayPMarkerSize` being ReadWrite BZDB
  also makes upstream's one of the client display options bzo implements at its
  default and ships no setting for. What bzo does not have is any flat-client
  equivalent of that triangle; the tape and the radar ring are what a flat
  client gets.

  Both exist because a headset has no room for a tape: its centre means where
  the tank points and where the player is looking at once, which are the same
  ray on a monitor and different rays in a headset. Both are drawn on flat
  clients too rather than only in a session, because the tape is somewhere to
  look *other than* the world, and a ring still leaves the player to turn a
  top-down panel into a direction to drive.

  A ring rather than upstream's flash, for the client bzo has to draw for: half
  of a flash is invisible at a low frame rate. See "Three surfaces point at the
  same things" for what decides which things get marked.
- **A hidden superflag goes over the wire as `type: null`, not upstream's
  `"PZ"`.** bzfs hides the identity of any superflag nobody is carrying
  (`bzfs.cxx:361`) and packs a fake `PZ` abbreviation in its place, so an old
  client still renders something. bzo has no wire compatibility to keep, and a
  packet that names the wrong flag is something a reader has to disprove. The
  drawn result is identical either way: every superflag is white.

- **The flag grab radius is BZFlag's, not bzo's.** `FLAG_GRAB_RADIUS` in the
  `flags` pair is `4.32 + 2.5`, built from BZFlag's tank radius rather than
  bzo's 2, for the same reason the sound reference distance keeps `86.4`: the
  figure scales with the world, not the vehicle. A bzo tank would otherwise have
  to be almost centred on a flag to take it.

- **Flags carry no wind.** Upstream's `FlagSceneNode::setWind` only turns the
  cloth when `realFlag` is on, which needs quality 3; at the default quality the
  cloth is billboarded and the wind angle is never read. Implementing the
  default variant therefore means no wind, and it saves per-flag work per frame.

- **The capture cheat check only logs.** Every `removePlayer` call in bzfs's
  `captureFlag` is commented out upstream, and bzo keeps that: a quantized
  position and a legitimate capture are hard to tell apart, and refusing an
  honest capture is worse than trusting a modified client about a base it still
  had to drive to. The mismatch is logged as `[ANTICHEAT:...] CAPTURE CLAIMED`.

- **Superflags are off until asked for, as upstream has them.** bzfs needs `-s`
  before a world has any superflags at all (`numExtraFlags(0)`,
  `CmdLineOptions.h:69`) and so does bzo: a config that never mentions
  `superFlags` carries none, so a map written without flags is played without
  them. A `superFlags` block naming no usable count is upstream's bare `-s`,
  which means sixteen, and a map's own `-s`/`+s` replaces whatever the config
  said. `allowed` defaults to every superflag in the shared `flags` table, which
  is why `example-server.json` names only `count`: an enumerated list in a
  tracked file goes stale every time a flag is added, and this one had -- it
  named 13 of the 41 flags bzo now carries. See "The world carries the
  gameplay".

- **Jumping is on by default.** bzfs needs `-j` before any tank can jump; bzo
  has had jumping since before there was a switch, so `jumping` defaults to on
  and `jumping: false` in `server.json` is what turns it off. The rest follows
  upstream: a map's `-j` can still turn it back on, exactly one of `JP` and `NJ`
  is ever in the flag pool -- `JP` forbidden while jumping is on, `NJ` while it
  is off -- and `WG` never consults it. See `docs/flags.md`.

- **A bad flag is shed by dying unless one of the three switches says
  otherwise.** Upstream's `-st`, `-sw` and `-sa` are all off by default and so
  are bzo's `flagShakeTimeout`, `flagShakeWins` and `antidoteFlags`; each is
  also reachable from a map's `options` block, and the more generous of the two
  settings wins. The timeout is client-counted and server-validated through
  `canShakeFlag`, because a modified client would otherwise shed a bad flag on
  contact. Shake wins is counted entirely on the server, since the server is
  what decides a kill happened. **The antidote's spot is picked by the server**,
  which upstream's client picks: a client-placed antidote would mean accepting
  every sticky drop on a server with `-sa` on, which would undo the timeout's
  validation. It travels to its owner alone as `antidoteFlag`, and arrival is
  detected off position updates the way Identify's sweep is.

- **`A` Agility triggers on a change of stick, not on upstream's clamped
  previous speed.** Upstream compares against the previous `desiredSpeed`
  fraction clamped to [-0.5, 1], which invents a change that never happened: a
  held partial stick around 0.4 to 0.7 re-triggers the boost forever, so an
  Agility tank holding half forward outruns anybody at full throttle without
  moving the stick. That is invisible on a keyboard, where the stick is only ever
  0 or +/-1, and bzo has analog input everywhere. Treated as an upstream bug. See
  `docs/flags.md`.

- **Damage rules are decided on the server, where upstream decides them on each
  client.** `SR` Steamroller's proximity sweep and `G` Genocide's team wipe both
  run once, in the game loop and in the kill path, rather than once per client
  reporting its own death. Same outcome, one copy, and a client cannot decide it
  was not run over. Friendly fire is asked in the same place: upstream refuses a
  teammate's shot in `LocalPlayer::checkHit`, so bzo's `-noTeamKills` covers
  shots, shock waves and being run over together. See `docs/flags.md`.

- **A game style may be switched while the server runs.** Upstream settles
  `gameOptions` from the command line at startup and never revisits it. bzo's
  Operator panel carries the ricochet switch, so anything derived from a game
  style is asked for rather than settled: the superflag pool is filtered per
  draw, and a flag the new style forbids is zapped where it stands. Shots
  already in flight keep the behaviour they were fired with, which is what every
  client was told when they began.

- **A bouncing shot does not bounce off a teleporter frame.** Frames are decided
  by the teleporter trace, which the client does not run for shots -- it has no
  frame hit to react to -- so bouncing them on the server alone would put the two
  copies of the shot on different paths. A frame stops a shot however it was
  fired. Doing it properly means moving the frame test into the shared pair.

- **The one-tap VR button on the HUD is hidden on phones.** Chrome on Android
  reports `immersive-vr` support on any phone, through Cardboard, so support
  alone does not mean a headset is present. The Settings menu still offers VR
  Mode there.

- **Fewer options than BZFlag: implement upstream's best-looking variant and
  ship no setting for it.** Where upstream offers quality levels or a switch
  between two looks -- a modelled guided missile behind `useQuality() >= 3`, a
  real flag cloth behind `realFlag`, `SHELL_INSIDE_NODES` for the eighth
  dimension -- bzo builds the one a player who turns everything up would see,
  not the one upstream ships cold, and leaves the other out. These three were
  picked under the older rule (upstream's *default*) and are worth
  revisiting now that the rule has changed -- see "bzo does not mirror
  BZFlag's client display options" above. A setting is only added where a
  measurement says the frame rate needs it, which is the same rule the render
  level follows, and the fallback then is what the render level chooses
  automatically, not a manual toggle. Every option is a second code path to
  keep correct and a second thing to test on four surfaces.

- **A surface above stops a rise; upstream leaves it in place.**
  `doUpdateMotion` only ever cancels *downward* motion against a surface -- its
  test is `newVelocity[2] < 0` (`LocalPlayer.cxx:634`) -- so a tank that jumps
  into an overhang keeps its upward velocity and stays pinned under it until
  gravity turns the velocity around: up to `jumpVelocity / gravity`, near two
  seconds at bzo's defaults. bzo zeroes the rise instead, so the tank falls from
  where it hit.

  Only the vertical. Against a flat ceiling upstream's `mag` is zero, so it
  leaves the horizontal velocity alone and so does bzo -- jump into a ceiling
  while driving and you keep your speed and simply start to fall. Against a
  sloped underside the component heading into the slope is still the only one
  cancelled, which is upstream's own slide.

  This is the one place bzo's motion loop diverges from `doUpdateMotion`, and it
  replaces a bigger deviation it used to carry: `hitObstacleBottom` reversed the
  velocity at 50% energy, a bounce with no upstream counterpart at all.
  `npm run test:motion` holds the rule.

- **`WA` Wide Angle is not implemented and will not be.** It widens the field of
  view, which the headset runtime owns in VR, so the flag would be a real
  penalty in a browser and a no-op in a headset -- worse than absent, because it
  looks like it works. It is the only flag BZFlag has that bzo does not. See
  `docs/flags.md` and the Flags section of the README.

- **A face buried inside other obstacles is never built.** Upstream leaves out
  the two cases every map hits and no more: a box's bottom polygon when it sits
  on the ground (`BoxSceneNodeGenerator.cxx:66`) and a pyramid's base unless it
  is raised or stood on its point (`PyramidSceneNodeGenerator.cxx:109`). Both are
  the same question with the answer worked out by hand. bzo asks it of the whole
  world in `public/face-trim.mjs`: a triangle every point of which lies inside
  the solid part of other obstacles cannot be seen from any position outside
  them, so `_addObstacleFragment` never copies it into the world mesh.

  What makes it worth the load-time cost is the way maps fake a curve. With no
  curved obstacle to draw, a map crosses several boxes at one spot -- `hix.bzw`
  builds four octagons, its top of the world and its roof out of four planks
  each, and `flagbuffet.bzw` carries one out on the north-east ground for testing
  -- and every long face of every plank is buried in its neighbours. `hix.bzw`
  loses 112 of its 992 obstacle triangles that way. Those are also the faces a
  phased tank sees as slabs across its view, because from inside one plank the
  others are still solid, so this is as much about what the eighth dimension
  looks like inside a fake curve as about what the frame costs.

  Three rules keep it safe, and each is load-bearing:

  - **Whole triangles only.** A triangle is kept or dropped, never clipped, and
    no vertex is invented, so the buffers only ever shrink. A face half buried
    keeps both halves.
  - **Two faces in the same plane are left alone.** They hide each other equally
    and something has to be drawn there; a rule that let each subtract the other
    would leave a hole. An octagon's four plank tops are exactly this case.
  - **The tolerance is a millimetre, not a float epsilon.** The coordinates
    tested are float32 out of a BufferGeometry and a map is 800 units across,
    where float32 steps about 6e-5, so a plank's corner lands either side of the
    neighbour it should touch. A tighter tolerance leaves a hairline crack down a
    buried face, for one rosette and not the next.

  The half-spaces the module builds have to describe the same solid the colliders
  do -- `getColliderLocalPoint`'s handedness, which is also what a Three rotation
  about +Y gives the mesh. A rosette is its own mirror, so getting that wrong is
  invisible on the octagon and wrong at every other angle. `npm run
  test:face-trim` holds all of it, including a cross-check against the collider
  and a float32 case.

The first two exist so a test session can be driven from the server alone. Re-testing
otherwise means walking to every browser, phone, and headset and clicking. They
may change once that stops being the dominant cost.

## Memory Policy

- When the user asks to remember something, record it in this file so other
  sessions, other agents, and other contributors remember it too.
- Keep the corrected facts here accurate. A stale instruction is worse than a
  missing one, because agents act on it without checking.

## Coding Conventions

- **Always prefer code reuse over duplication.** When implementing new features
  or refactoring, extract and reuse shared logic instead of copying code.
- **Always remove trailing whitespace from edits.** No line ends with a space or
  tab.
- **Module file names are short.** Drop any qualifier the directory or the
  module's own role already supplies: `public/collision.mjs`, not
  `collision-geometry.mjs`; `public/motion.mjs`, not `tank-motion.mjs`. Keep a
  qualifier only where the bare noun would be ambiguous in its directory, as
  `input-context.mjs` is. Names are kebab-case, matching the rest of `public/`.
- **Do not put style information in `public/index.html`.** Presentation rules
  belong in `public/styles.css`. No inline `style` attributes, no `<style>`
  blocks. To show/hide an element, toggle a class rather than writing
  `element.style.display` from JavaScript.
- **Client/server protocol is lockstep in this repo.** Do not add defensive
  fallbacks or default values for packet fields that the shipped `client.js` +
  `server.js` protocol guarantees. Prefer explicit failure or direct field use
  over silent fallback behavior.
- **Version control is for history; source comments and documentation are not.**
  Describe what the code does now, never what it used to do. Do not write "this
  used to be X", "renamed from Y", "previously Z", or contrast the current
  behavior with an older version -- `git log` and `CHANGELOG.md` already hold
  that, and a note about code that no longer exists is noise a reader has to
  disprove. The same applies to commented-out code: delete it.
- **Preserve the AGPL license header** that already appears at the top of major
  source files when creating or modifying files.

## Repo Snapshot

Real-time BZFlag-inspired tank arena: a Node/Express/`ws` server in `server.js`,
and a browser Three.js client under `public/`.

All front-end modules are plain ES modules loaded directly by the browser. There
is **no bundler**. When adding an external module, update the
`<script type="importmap">` block in `public/index.html`.

**Serve every dependency from this origin.** Nothing in `public/` may reference a
third-party host: an installed PWA on a headset, or a phone on a LAN game server
with no internet route, must still load. Three.js is mounted from the installed
`node_modules/three` at `/vendor/three/`, so `package.json` is the only place its
version appears.

### Layout

| Path | Role |
|---|---|
| `server.js` | Express + WebSocket server, game loop, collision/shot validation, BZW parsing |
| `server/*.cjs` | Server-side copies of logic shared with the client |
| `public/client.js` | Scene setup, WebSocket handling, HUD orchestration, local prediction, XR menu screens |
| `public/render.js` | `RenderManager` class: Three.js scene, tanks, obstacles, teleporters, explosions, camera |
| `public/input.js` | All input ownership and routing; `setupInputHandlers`, `virtualInput`, `keys` |
| `public/hud.js` | HUD drawing helpers (scoreboard, altimeter, degree bar, shot status, debug) |
| `public/menus.js` | Shared dialog lifecycle, focus, and keyboard/controller navigation |
| `public/settings.js` | Declarative Settings rows + DOM renderer |
| `public/xr-menu.js` | `XRMenuRenderer`: CanvasTexture menu panel for immersive XR |
| `public/webxr.js` | XR session lifecycle and controller input |
| `public/capabilities.mjs` | What the WebGL context supports; gates features and their UI |
| `public/voice.js` | WebRTC nearby-voice manager |
| `public/audio.js` | Gameplay sound manifest, attenuation, and buffer loading |
| `public/volume.mjs` | The 0..10 audio level model shared by the Audio dialog, XR, renderer, and voice |
| `public/voice-channels.mjs` | Which players hear each other: All, Nearby, Team |
| `public/package.json` | `{"type":"module"}` only, so Node can import `public/*.js` in tests |
| `public/sw.js` | Service worker: install support and asset caching |
| `public/icons/` | Installed-app icons; see `docs/icons.md` |
| `public/*.mjs` | Client-side copies of logic shared with the server |
| `scripts/*.mjs` | Release tooling, doc checks, tests, OBJ generators |
| `maps/*.bzw` | Map files |
| `docs/` | Design plans, manual validation checklists, and asset notes |
| `cache/br/` | Brotli sidecars, derived from `public/` and Three's build; not in git |

### Where the server answers

`listen` in `server.json` carries a host and a port together, the way a proxy's
own config writes it: `[::]:3000`, `127.0.0.1:3000`, `[::1]:3000`, `:3000`, or a
bare host with no port. `port` still works and fills in whenever `listen` names
no port. Both are read from the environment first -- `LISTEN` and `PORT` -- and
`server.json` second, so a container is configured by its orchestration and a
server by its file. The `Dockerfile` deliberately sets neither, because setting
one there would make the matching key in the operator's mounted
`/data/server.json` permanently inert.

The default is `[::]:3000`: every interface in both families, which is the only
answer that is right without being told, since a container has to be reachable
on the network Docker gave it and a LAN game has to be reachable from the LAN. A
dual-stack socket takes an IPv4 peer as an IPv4-mapped address, which is why a
proxy on the same host appears in the log as `::ffff:127.0.0.1`.

Naming a loopback is how an operator behind a reverse proxy stops anyone
stepping around it to the port -- where they would reach the uncompressed,
uncertificated path, and where a browser offers neither brotli nor a service
worker, both of which need a secure context. Bind one family and point the proxy
at the same one: `127.0.0.1` with Caddy's `reverse_proxy 127.0.0.1:3000`, or
`::1` with `[::1]:3000`. `localhost` is resolved to `127.0.0.1` and says so,
because a socket binds one family and the name promises two.

### Assets are compressed once, not per request

Everything under `public/` and Three's build directory is served uncompressed by
express, and a reverse proxy in front of it compresses by mime type -- which
misses the models entirely, because express announces `.obj` as
`application/x-tgif`. `server/precompress.cjs` closes that: it builds a brotli
sidecar for each text asset and serves it to a client that asks for `br`. A cold
join measured at the wire goes from 9,958KB to 5,575KB, the models from 1,911KB
to 228KB.

Quality 11, so it is done once and kept -- three seconds for a megabyte is out
of the question per request when the game loop shares the process. The walk that
computes the client build id plans it, since that walk is already holding every
file's bytes, and a sidecar is named for the digest of those bytes:
`cache/br/obj/bzflag.obj.<digest>.br`. So a sidecar that exists is by
construction the current file's, an older one is a name nothing looks up, and
the sweep in the same pass deletes it. Never trust an mtime here: serving a stale
body is the desync the whole cache policy exists to prevent.

A missing sidecar is never an error -- the request falls through to the identity
file. That is what makes a read-only container, an unwritable `cache/`, and the
seconds before the queue drains all correct rather than broken. `npm run
precompress` does the same pass without a server, which is what the image build
runs.

### Shared client/server modules

Because the client is unbundled ESM and the server is CommonJS, logic needed on
both sides is kept as a **hand-maintained pair**: `public/<name>.mjs` and
`server/<name>.cjs`. Current pairs are `shots`, `teams`, `collision`,
`motion`, `headset`, `flags` and `voice-channels`. `npm run check:shared-pairs` enforces them: the two mirrored
pairs must match line for line, and any name a hand-written pair exports on
both sides must agree in type and arity. A pair that drifts does not throw --
the client and server just quietly disagree about geometry, which surfaces as
position corrections.

**Any such pair must have a parity test** in `scripts/` that loads both copies
and asserts they agree across a shared input table. See
`scripts/test-shots.mjs` and `scripts/test-teams.mjs`. Without one,
the copies drift silently — `teams` did exactly that, with the client
skipping the `trim()` the server performed.

### Collision geometry follows BZFlag

Obstacle geometry lives in the `collision` pair and mirrors upstream
BZFlag (`src/obstacle/`, `src/game/Intersect.cxx`). The client resolves moves and
the server rejects them -- different jobs -- but both must agree about which
volume is solid, because every disagreement is either an honest player wrongly
rejected or a cheater wrongly allowed. Both sides agree by agreeing with the
same reference implementation.

`scripts/test-collision.mjs` fuzzes the two copies against each other.

**The server must be strictly more permissive than the client.** Move packets
quantize position with `toFixed(2)`, so a transmitted position can sit ~0.007
further into an obstacle than where the client actually stood -- far more than
the ~0.001 margin the client keeps while sliding along a surface. The server
therefore tests a slightly smaller radius (`antiCheat.collisionSlack`, default
`0.05`). Without it the server rejects most frames of a slide and the player
rubber-bands down every slope. Slack may only ever remove collisions, never add
them; do not apply it to heights or to the teleporter portal interior.

bzo is BZFlag's world relabeled for Three.js: `bzo(x, y, z) = bzf(x, z, -y)`.
That is a proper rotation, not a mirror. Because the ordered pair `(x, z)` seen
from `+Y` has the opposite orientation to `(x, y)` seen from `+Z`, a Three.js
rotation about `+Y` is a negative 2D rotation in `(x, z)`; that is why
`getColliderLocalPoint` uses `+rotation` where upstream uses `-angle`. It matches
how `render.js` draws obstacles (`mesh.rotation.y = obs.rotation`).

#### One pass, as upstream has

`doUpdateMotion` (`LocalPlayer.cxx:498`) builds a velocity and hands the whole
step to a single search that resolves position, height and heading together.
`resolveTankMotion` in the `motion` pair is that loop; `resolveTankStep` in
`client.js` is only the world it looks at, and `getTankHitNormal` in the
`collision` pair is upstream's `Obstacle::getHitNormal`. The sign of that
normal's `y` is the whole of what decides a landing -- upstream's
`newPos[2] > 0 && normal[2] > 0.001` -- so there is no support surface, no snap
window, no on-top tolerance and no fall sentinel anywhere in the path.

**Do not add a second pass back.** bzo used to resolve horizontally through the
loop with `velocityY: 0` and vertically through a support model of its own, and
every bug in this path came out of the gap between the two: each was one question
with two answers, one taken from upstream and one a fudge beside it. Prefer
deleting the second number to tuning it.

Two shapes of upstream's loop are easy to get wrong and both were:

- **On meeting a surface it zeroes the vertical velocity and keeps going** with
  the time the step has left, so the next pass carries the tank along the
  surface. Ending the step at the hit makes driving on a roof feel stuck: a tank
  on a surface always carries a little downward velocity, so every frame hits,
  and the step only ever travels the fraction before the tank sank a millimetre.
- **`inBox` has no vertical slack.** A tank resting exactly on a surface is clear
  of it because the resolver stopped it exactly there. A band instead lets a tank
  sink through the top of what it is standing on, and under an inverted pyramid
  that means arriving inside a wedge where every height is solid and the search
  has no clear point to stop at -- the tank hangs.

#### What a pyramid does to a tank

Every pyramid face holds a tank up, and no pyramid face may be driven up. Both
halves come from one line: `doUpdateMotion` treats a hit as a landing whenever
`newPos[2] > 0 && normal[2] > 0.001` (`LocalPlayer.cxx:617`), and
`PyramidBuilding::getHitNormal` always angles the face upward by
`width / hypot(height, width)` -- above that threshold for any pyramid a map can
state. So there is no slope steep enough to shed a tank and none shallow enough
to climb; the slope decides only *where* on the face the tank comes to rest.
`maps/flagbuffet.bzw` carries a row of five pyramids from nearly flat to nearly
vertical to drive this rather than argue about it.

The consequences, each of which was once a bug:

- **A tank comes to rest on its own nearest corner, not under its centre.** The
  solid is the base rectangle shrunk by `shrinkFactor` at the tank's *base*
  height, so the resting height is the lowest one at which the tank box clears
  that rectangle -- which is up the slope from the centre by however far the box
  reaches toward the axis. `getPyramidTankSupportY` bisects for it, monotone in
  height because the cross-section only narrows. A box covering the axis clears
  nothing below the apex, which is what lets a tank balance on the point.
- **The whole base footprint is solid at ground level**, because `shrinkFactor`
  is 1 there. A tank driving at a pyramid stops at the base edge whatever the
  slope looks like. Upstream bumps a tank up a ledge only where the obstacle
  `isFlatTop()`, which for a pyramid is `flipz`, so only the flat-topped kind is
  ever driven onto -- and it is the only kind whose widest cross-section is its
  top.
- **A slope is the surface *and* the wall.** The shortcut that lets a tank
  standing on a roof ignore that building's walls must not fire for an upright
  pyramid: there the face reported is the one holding the tank up, and dropping
  the hit walks the tank into the pyramid a step at a time.
- **A blocked downward step stops at the surface it met.** Resolving x and z
  while gravity keeps lowering y sinks a tank through the face a frame at a
  time, which is what falling onto one used to do (issue #49).
- **Leaving a slope is a fall, every frame.** A slope drops away faster than the
  support snap can follow, so driving downhill leaves the surface on the first
  frame. The speed a fall freezes must therefore be the speed the tank is being
  driven at this frame, not the one measured from last frame's displacement:
  measured is zero for a tank that has only just been asked to move, and zero
  sustains itself.
- **One question, one threshold.** `validateMove` declares a fall as soon as the
  tank is more than `ONTOP_TOLERANCE` above the surface under it, and
  `findSupportSurface` used to take a surface back up to the wider
  `SUPPORT_SNAP_DOWN` below. Both answer "is the tank still on this surface?",
  so a gap between them is a band the tank falls out of and is grabbed back into
  on the same frame -- a landing sound and a ground ring per frame. It shows up
  on a slope and only at some frame rates, because what lands in the band is how
  far the surface drops in one frame: `speed x dt x slope`. A falling tank is
  therefore held only within `ONTOP_TOLERANCE`; the wider snap is for a tank
  still driving along a surface and following it over a step.

- **A turn is refused, not absorbed.** Upstream searches the timestep over the
  azimuth as well as the position and leaves `newAngVel = 0` when the step hit
  something (`LocalPlayer.cxx:565`), so a tank cannot turn into a wall. bzo
  settles the heading outside the resolver, so `resolveTankRotation` makes the
  same refusal after the fact. Without it a tank beside a pyramid turns its own
  corner into the slope, and then whatever pushes it back out rides it up the
  face -- so this is what lets the support rules stay free of any "lift a tank
  that got inside" case.

  **Every bug in this path has been one question with two answers.** A slope
  supported a tank only above a normal threshold bzo invented, while the solid it
  collided with had none. `validateMove` called a tank fallen past
  `ONTOP_TOLERANCE` while `findSupportSurface` grabbed it back within
  `SUPPORT_SNAP_DOWN`. `onGround` was true under 0.1 while the floor snap fired
  only at 0. In each case one number came from upstream and the other was a fudge
  either side of it, and the gap between them is where the tank flickered --
  once per frame, which is a sound and an effect per frame. Upstream has no such
  pairs, because `doUpdateMotion` decides position, landing and heading in one
  loop. Prefer deleting the second number to tuning it.

  Frame rate is a variable in every one of these. A descent is `speed x dt x
  slope` per frame against fixed thresholds, so the same drive glues at 144fps,
  falls cleanly at 60, and clears the whole pyramid at 8. Reach for
  `--window 320,240` on the headless probe before concluding anything about
  motion: at its default size it runs at ~8fps and steps over the whole band.

### Known duplication (do not add more)

`server.js` and `public/client.js` still each carry their own copy of:
`getCollisionColliders`, `getWorldBorderColliders`, `normalizeAngle`,
`rotateXZ`, `getSegmentBoxEntryTime`, `getShotTeleporterCrossing`,
`transformShotThroughTeleporter`, `traceShotThroughTeleporters`. Several have
already drifted. When touching any of them, change both sides in the same edit;
the fix is to move each into the `collision` pair, matching upstream
BZFlag, with fuzz coverage -- as the pyramid path already has.

**`checkCollision` came off that list, and it is the pattern to follow.**
`findTankObstacle` in the `collision` pair is `World::hitBuilding`, and both ends
call it: what is left on each side is only which world to look at, what the
occupant is, and -- on the server -- the logging and the tolerances. The two
copies had already drifted exactly as this section warns, twice over: the server
tested every inverted pyramid as though it were upright, and its vertical gate
carried a slack the client's did not.

The server's tolerances are *parameters* of the shared loop, not a second copy of
it. `slack` shrinks the occupant, `verticalEpsilon` widens the height gate, and
both may only ever *remove* a collision -- the server has to stay strictly more
permissive than the client, because a move packet quantizes position with
`toFixed(2)`. Anything that would make the server stricter belongs nowhere.

**What is not duplication: the server extrapolating.** It decides kills, so it
has to know where every tank is between packets, and it dead-reckons from the
velocities a client reported -- which is bzfs's own arrangement
(`getPredictedState`), not a second copy of the client's resolver. Those are
different jobs reading the same geometry. What the extrapolation is missing is a
clock it can trust: bzo sends no timestamp with a move, so network jitter lands
inside the number the anticheat judges. `docs/lag-plan.md` is the plan for that.

`getShotTeleporterDims` is the cheap half of that lesson already learned. It used
to *compute* a teleporter's frame from the stated size and the border, and three
consumers open-coded the same growth rather than asking it -- two of them wrongly,
including the debug outline whose whole job is to show the surface a tank stands
on. The importer now resolves the frame into `w`/`d`/`h` before the world goes on
the wire, so a teleporter measures like a box and a consumer that reads the
obvious field is right by default. **The delivered world should be as simple as
possible for collision**: BZW is an import format and its conventions -- a stated
size that means the opening, a half extent where bzo wants a full one, a rotation
in degrees about a different axis -- belong in the importer and nowhere else.

## Visual effects

Effects mirror BZFlag's, taking geometry and timing from upstream rather than
approximating the look. Read the relevant `draw()` before building one: several
of these are not what their names suggest. The muzzle flash is a flared cone out
of the barrel, not a billboard; the shot teleport effect is a spinning collar
that rides along with the shot for four seconds, not a flash at the portal.

| bzo | upstream | source |
|---|---|---|
| muzzle flash | `StdShotEffect` | `effectsRenderer.cxx:897` |
| shot teleport collar | `StdShotTeleportEffect` | `effectsRenderer.cxx:1665` |
| jump jets | `TankSceneNode::renderJumpJets` | `TankSceneNode.cxx:1438` |
| spawn grow-in | `Player::spawnEffect` | `Player.cxx:1056` |
| landing squish | `Player::setLandingSpeed` | `Player.cxx:1015` |
| flag cloth and pole | `FlagSceneNode` | `FlagSceneNode.cxx:113` |
| flag arrival/departure warp | `FlagWarpSceneNode` | `FlagWarpSceneNode.cxx:28` |
| tank track marks | `TrackMarks` | `TrackMarks.cxx:320` |

Textures come from `$HOME/bzflag/data/` into `public/textures/`, and belong in
the map-entry preload list in `public/client.js`. Effect timings are hardcoded
constants upstream, so keep them as constants here, each annotated with the
upstream line it came from.

### Tank tracks

Upstream keeps three kinds of track mark and bzo draws one of them. `PuddleTrack`
needs `_mirror` set to something other than "none" (`addMark`,
`TrackMarks.cxx:322`) and bzo draws no reflections; `SmokeTrack` has no producer
anywhere in the upstream tree, its texture a FIXME and nothing ever asking for
one. What is left is the treads, which is the effect the issue is about.

The split follows upstream's. `Player::updateTrackMarks` decides where a tank's
next mark goes and whether there is one to lay, and that is `public/tracks.mjs`
called from `client.js`, which is the side that knows a tank's flag, its ground
state and the obstacle list. `TrackMarks.cxx` ages the marks and draws them, and
that is `render.js`.

**The whole world's marks are one mesh and one draw.** Upstream gives each mark a
scene node of its own and walks a linked list every frame; bzo writes a mark's
two quads into a fixed slot in one buffer when it is laid and never moves them
again, so the per-frame cost is the fade and nothing else. Every mark lasts the
same `_trackFade` and they are laid in time order, so the live marks are always
one run of slots and the oldest is always the next to go -- which is what lets
the ring be walked from its tail rather than swept, bounds the colour upload to
the marks that are alive, and lets the draw range cover them rather than the
pool. A frame therefore costs one draw call, four triangles per live mark, and
one alpha per vertex of them.

The pool is a ring of 512 marks -- eight tanks driving without pause, 124KB of
vertex data whether it is used or not -- and a full pool drops its oldest mark,
so a crowded map shortens every trail rather than costing the client anything.
That is the memory question `docs/effects-plan.md` asked to answer before
building this.

Two upstream knobs are absent, per the rule of shipping the default variant and
no setting: `userTrackFade` and `trackMarkCulling`. The second is not only a
setting -- its `PhyDrvAirCull` half re-tests every mark each frame in case a
physics driver has carried it off the surface it was left on, and bzo has no
physics drivers, so where a mark is laid is where it stays. The `InitAirCull`
half is kept, and is what stops a tank leaving marks in the air off the edge of a
roof.

## Radar colours

BZFlag keeps a second colour table for the radar (`Team::radarColor`,
`Team.cxx:30`), lifted from the tank colours so a team reads against a dark
panel. bzo uses it for **flags** -- `getFlagRadarColor` -- and not for tank
blips, which keep the colour the server assigned the player: bzo gives every
player a colour of their own, which upstream has no equivalent of and no radar
entry for. Do not "fix" that -- telling two team mates apart on the radar is
the same job as telling them apart at a distance in the world, and the blip is
the easier of the two to read a colour off.

A base's own square is drawn in its team's radar colour and an obstacle a map
painted is drawn in the colour the map gave it, both shaded towards the panel's
neutral grey by the same fraction: a surface on the panel has to keep reading as
ground rather than as a tank. `getObstacleRadarFillStyle` is the one place that
decides, and `getRadarShadedFill` the one place that shades.

Outside team mode that colour comes from the whole wheel. Inside it, the server
shades team mates apart within a band around the team colour
(`TEAM_SHADE_HUE_SPREAD` and friends in `server/teams.cjs`), so a red tank is
still unmistakably red. Nothing is rebalanced when a player leaves: the gap they
free is the one the next joiner is most likely to take, and a tank that changed
colour mid-match would undo the only thing the shade is for. A restart starts
over, which is a fresh set of players to learn in any case.

Depth dimming mirrors upstream's two functions, which differ only in their floor:
`colorScale` fades objects to 0.35 and `transScale` fades the obstacles they
stand on to 0.5, both over 40 units. `getRadarDepthScale` is the shared form. Both
measure the gap to the object's *nearest* surface, so an obstacle whose top is a
few units below the player is barely dimmed at all -- that is upstream's rule,
not an oversight.

**`updateRadar` draws in layers, and the order is load-bearing.** The dark panel
goes down first, then the world border and compass, then obstacles, then shots,
tanks and flags -- gameplay last, as `RadarRenderer` orders it. Anything drawn
before the panel is washed out by it, and anything drawn before the obstacles is
buried under them.

Obstacles are painted lowest surface first, which upstream does not do: it draws
boxes then pyramids in map order and lets a pyramid cover the base beside it. A
top-down panel reads better as a height map, so `getRadarObstacles` sorts by top
altitude once per map.

## Flags

`docs/flags.md` documents the flag system: where each part of it lives, and every
place bzo's flags deliberately differ from BZFlag's. Read it before changing
flags. Per-flag mechanics are not repeated there -- they are in comments beside
the code, each citing the upstream file and line, where they cannot drift.

bzo carries every flag BZFlag has except `WA` Wide Angle, which is deliberately
absent and will stay absent: the headset owns the projection, so a field-of-view
flag is a real penalty in a browser and a no-op in VR, and keeping XR honest
matters more than carrying the flag. A `zoneflag WA` is ignored and `WA` is never
spawned, which the server says once at load.

**A flag needs an answer in XR.** bzo ships one client for desktop, mobile and
the headset, so an effect that is a desktop-camera or 2D-HUD trick is not enough:
a flag that quietly does nothing in VR looks like it works and the player cannot
tell.

**The `FLAG_TYPES` table is the list of what bzo has.** A row is what puts a flag
in `superFlags.allowed`'s default and in the help panel, which `buildFlagHelp`
generates from the same table, so a row with no behaviour behind it would be a
flag in the world that lies about what it does.

The shape of it: the server owns every flag and sends the whole flight with the
event that starts it, and the client integrates that arc locally, exactly as
`FlagInfo::dropFlag` and `World::updateFlag` split the work upstream. There is no
per-frame flag packet, and no clock sync -- the client advances `flightTime` by
its own frame delta from the value the server sent.

Flag ownership lives only in the server's `flags` array. Do not add a second
copy on the player.

A client's *knowledge* of a flag's identity lives in its own flag record, not
beside it. bzfs reveals a superflag's type only while somebody is holding it, so
an update for a dropped flag arrives with `type: null`; `keepFlagIdentity` in the
flags pair is the rule that keeps what the record already learned across such an
update, and the debug labels draw an identified flag's abbreviation over it. A
record is a slot rather than a flag, so it forgets when its flag leaves the
world.

Identify is asked for rather than pushed. The client sweeps for the nearest flag
with `findNearestGroundFlag` from the flags pair, names it from its own record
when it can, and sends a `nearFlag` only for a flag it cannot name; the server
answers by making the same sweep against its own copy of that tank's position.
Upstream sends the answer off every position update instead, which is a packet
per flag per pass along a row of them for answers the client already has.

Where a flag's rule is enforced follows one test: server-side wherever a modified
client could gain by lying, client-side wherever it only changes what its own
player sees.

Grab, drop and capture are client-initiated and server-validated, which is
bzfs's own arrangement.

CTF is on when team mode is on **and** the map has bases, which is upstream's
`ClassicCTF`. Team flags occupy the first slots of the flag array so a team's
flag index does not move when the superflag count changes, and the two kinds
behave differently in ways worth knowing before touching either: a team flag
never vanishes, appears at its base instead of flying in, comes to rest on
buildings, and leaves the world with its team, while a superflag flies in,
expires after `_maxFlagGrabs` pickups, and may only come to rest on the ground.

Note how `flagsOnBuildings` reaches each path. It gates the `maxZ` that
`resetFlag` passes, so it decides whether a flag may *spawn* off the ground;
`dropFlag` always casts the full downward ray, so a *dropped* flag finds the
surface under the tank either way and the setting only decides whether a
superflag may stay there. With it off, a superflag dropped on a roof rises out of
the world from the roof rather than falling to the floor. bzo takes it from a
map's `options` block as upstream's `-fb`, or from `flagsOnBuildings` in
`server.json`; `maps/hix.bzw` turns it on. Team flags ignore it.

### The roster

**A connection is not a player until it joins.** bzfs's `sendPlayerUpdate`
returns early unless the player `isPlaying()` (`bzfs.cxx:518`), so a socket
sitting in limbo before `MsgEnter` is in nobody's roster. bzo names its limbo
player `Player n`, which is exactly the placeholder that used to appear on
everyone else's scoreboard, so it follows the same rule: `getRosterFor` gives a
client the joined players plus itself, nothing is broadcast on connect, and a
connection that never joined is not announced when it leaves either.

**The `init` roster is a snapshot applied late, so it must not overwrite what
arrived since.** `prepareInitialRender` waits for the models, textures and audio
the roster names before it can build anyone's tank -- seconds on a cold start --
and clients reconnecting alongside this one are joining through that window.
`handleServerMessage` holds every roster message that lands in it and
`applyRosterSnapshot` replays them over the snapshot in order, so the last word
about a player is whichever message actually came last. Without that the
snapshot put back the name each player had when it was taken, and nothing
corrected it: movement packets carry no name.

**`queryPlayers` is the backstop.** Upstream answers `MsgQueryPlayers`
(`bzfs.cxx:3145`) with the team table and one `MsgAddPlayer` per player -- the
whole roster on demand -- though its game client never asks, because its world
arrives before it enters and nothing can land in between. A bzo client builds
its world while already receiving, so it asks once, on entering a map, and
reconciles in both directions: anyone the answer does not name is gone.

A BZW `options` block is read twice: `parseBZWTeamMode` in the `teams` pair takes
the switches both sides need, and `parseBZWServerOptions` in `server.js` takes
the ones only the server acts on. Add a new switch to whichever of those matches
who needs to know.

`docs/bzw.md` is the list of every `.bzw` keyword bzo reads and every one it
ignores, including the coordinate conversion. Update it in the same commit as
`parseBZWMap`: a map that uses something bzo skips still loads, so the doc is
the only place a mapper can find out what will and will not survive the import.
`maps/bzo.bzw` carries a labelled example of each obstacle keyword.

**A guided missile is the one shot whose path both ends integrate.** Every other
shot is a direction and a speed decided at the muzzle; `GM`'s heading is turned
toward its locked target every simulation step, so `steerGuidedShot` lives in the
flags pair and the server and each client run it against the same target. The
lock itself is the *server's* -- upstream picks it on the shooter's client, but a
lock steers a real weapon -- and it is broadcast as `lockTarget` because every
client steers every missile. Whether a lock is still live (`canLockOn`,
`canLockOnto`) is asked wherever it is read rather than only where it is set, so
both ends drop a dead or unlockable target on the same step with no packet. See
the plan's phase 12 for the whole of it, including why the lock-on bracket stands
in the world rather than on the screen.

Shots against solid geometry live in the `collision` pair, not in either
`server.js` or `client.js`: `traceShotStep` advances a shot over one fixed step,
finds what it met, and reflects it about the surface normal when the shot
ricochets. Both sides call it, because a bounce the client draws one way and the
server hits with the other way is worse than no bounce at all. Only a bouncing
shot is traced on the client; an ordinary one still flies straight until the
server says where it ended.

Which team's base a point stands on is `getBaseTeamAtPoint` in the `collision`
pair, because it is obstacle geometry both sides need: the client detects a
capture with it, and the server validates one. Team identity itself -- the
mapping between bzo's team names and BZFlag's colour indices, and the capture
score rule -- lives in the `teams` pair. A team flag's `team` field is a BZFlag
colour index, never a bzo team name.

The heading tape carries a marker per flag of the player's own team, unless the
player is the one carrying it -- `HUDRenderer::addMarker` and
`prepareTheHUD()`. It takes the team's *tank* colour, because the tape is not the
radar. `updateDegreeBar` takes the markers as an argument, so the flag list stays
in `client.js`.

### Three surfaces point at the same things

Upstream has one bearing surface, the heading tape. bzo has three, and the two
it added exist because a headset has no room for a tape and a flat client has to
look away from the world to read one:

- **The heading tape**, upstream's, marking the player's own team flags, the
  antidote, and -- bzo's own -- the tank the player has locked on to.
- **A radar ring** around the same flags and around the rabbit, pinned to the
  border of the panel when the thing is past radar range. The XR radar panel is
  textured from that canvas, so the rings arrive in a headset for free.
- **A sky beacon**, a coloured wedge hanging out of the cloud layer down to a
  point just above the thing itself, over exactly what the radar rings. A ring
  says where something is on a top-down panel and leaves the player to turn that
  into a direction to drive; a mark standing in the world has already done it.
  `updateSkyBeacons` in `client.js` picks the targets and `showSkyBeacons` in
  `render.js` draws them. Upstream's own second mark is a screen-space triangle
  rather than anything standing in the world; the bearing-cue entry under
  "Intentional deviations from BZFlag" describes it and how it differs.

The marks are drawn by three different pieces of code, so what they mark is
decided by one: `isSoughtTeamFlag` for a team flag and `isMarkedRabbit` for the
rabbit. Add a target to a surface by teaching those, never by asking the
question again where it is drawn -- two copies drift, and the drift shows up as
a panel and a world that disagree about which tank is the rabbit.

A beacon hangs from the lowest cloud, because the server puts the cloud layer a
jump above the tallest thing in the world. So a beacon over a tank in the air is
shorter than one over the ground, which is the altitude a top-down panel cannot
show, and one over a target already at cloud height keeps a length of its own
and climbs past the clouds. It fades out within about 45 units, where the thing
itself is in view and a wedge over every spawn would be clutter.

Both scoreboards name a carried flag after the callsign, as
`ScoreboardRenderer::drawPlayerScore` does: a superflag by its abbreviation, in
the flag's colour. A team flag is named by its colour alone -- `Red`, not
upstream's `Red Team` -- because the label already carries that team's colour, so
the word is redundant. `getPlayerFlagLabel` in `client.js` is the single source
for both panels. The DOM one repaints on events, so a change of ownership has to
call `callUpdateScoreboard`; the XR panel repaints every frame and does not.

Work tracked as GitHub issue #6; reference it from flag commits.

## Observer

An observer has no tank. It joins, chats, and flies a
roaming camera over the map. Work tracked as GitHub issue #33; reference it from
observer commits.

### What upstream does

**An observer always roams.** `Roaming::setMode` (`Roaming.cxx:54`) refuses
`roamViewDisabled` for `ObserverTeam`, so there is no way to leave roaming, and
refuses every other mode for a player. There are five views (`Roaming.h:36`):

| view | eye | look at |
|---|---|---|
| `free` | roaming camera | its own heading |
| `track` | roaming camera | target's muzzle |
| `follow` | 40 behind the target's forward, `6 * muzzleHeight` up | target's base |
| `fps` | target's muzzle | target's forward |
| `flag` | roaming camera | a **team** flag (`flagTeam != NoTeam`) |

**"Track the leader" is not a view, it is the null target of one.**
`targetManual == -1` means auto, and `buildRoamingLabel()` re-resolves it every
frame to the rabbit, else `ScoreboardRenderer::getLeader()`, which prefixes
`"Leader "` to the callsign. Cycling past either end returns to auto, and a
target that leaves the game drops you back there because `changePlayer()` clears
a target it cannot find in the scoreboard list.

**The roam camera eats the tank's own two axes.** `setupRoamingCamera()`
(`playing.cxx:6666`) reads `myTank->getSpeed()` and `getRotation()` and remaps
which camera axis each feeds with Ctrl/Alt/Shift. Rates, with bzo's
`TANK_SPEED: 25`: translate `4 * tankSpeed` = 100 u/s, yaw `zoom * turn` deg/s
(60 at the default zoom, so it slows as you zoom in), vertical `4 * tankSpeed`.
`z` is floored at muzzle height; x and y are never clamped and there is no
collision, so the camera flies through buildings and past the world border.

**Identify picks the tank centred in the sights.** `setTarget()`
(`playing.cxx:4390`), bound to `I` and Right Mouse -- see the Keyboard section.

**Defaults are narrower than the code looks.** `trackShots`, `displayLabels`
and `slowKeyboard` are all unset in `defaultBZDB.cxx`, so upstream's defaults are
no shot-riding camera, no tank labels, and no delta smoothing. Because the
smoothing branch is off, `roamSmoothFollow()` never runs and its `followDist` /
`followHeight` / `followSpeed*` knobs are dead: `follow` takes the hard rig in
the table above. Under the rule to implement upstream's default variant and ship
no setting, all of that is out of scope, as are `roamMouseWheelSwap` and
`/roampos`.

### How bzo does it

An observer joins with `health = 0`, which is the state the Join/Entry flow
already renders as a scoreboard entry with an invisible tank, and every path that
tests health then refuses on its own. It still gets a **spawn position**, because
that is where its camera starts -- an observer should arrive standing on the field
facing the way a tank would, not at the origin, which is where upstream's
`resetCamera()` puts it. Upstream gets away with the origin because its default
view is `fps` and never `free`.

The camera lives only on the client: `public/roam.mjs`, pure and covered by
`scripts/test-roam.mjs`. Each frame the tank mesh is moved to the eye point,
which is upstream's `myTank->move(virtPos, roamViewAngle)`, because the radar,
the heading tape and the position other clients place this observer at all read
that transform and so follow the camera without knowing roaming exists.
**Nothing draws that mesh** -- not the tank, not its server-position ghost, which
hangs off `worldGroup` rather than off the tank and so has to be hidden
separately.

**The eye is the running view's, not the roaming camera's.** `track`, `follow`,
`fps` and `flag` all frame themselves off something other than `roamCamera`,
which keeps sitting wherever free roam last parked it, so reading the mesh off
the camera pins the radar to a place the observer left. The heading that goes
with it is upstream's `roamViewAngle` -- `atan2` from the eye to the look point,
`getRoamViewAngle` in `roam.mjs` -- so a tracking view faces what it is watching.
The mesh stands an eye height *under* the eye rather than at it, which is bzo's
own: upstream flattens `virtPos` to `z = 0`, and standing under the eye is
instead the same relation a driver's tank has to their camera, so a client
adding an eye height to what it receives lands back on the camera.

**An observer sends a heartbeat and nothing else.** Upstream does the same:
`sendObserverHeartbeat` (`playing.cxx:7415`) gates a normal player update behind
`observerHeartbeat`, default 30 seconds. bzo sends one every
`MAX_UPDATE_INTERVAL`, the same 5 seconds a driving tank uses as its own
heartbeat, because the nearby voice roster reads the position and 30 seconds is
too coarse to place a voice.

**An observer is not tracked through its movements.** Roughly where is the only
question anything asks of the position, and 5 seconds answers it for a camera
that is parked or flown by hand. It does not answer it for a tracking view, which
rides a tank that drives while the observer touches nothing: 5 seconds of that
covers more than the whole nearby radius, so the observer is heard from a place
they have entirely left. One drift check handles that and nothing else -- if the
camera is more than a quarter of the nearby radius from the position last sent,
the update goes early, at most one a second. Everything else keeps the heartbeat.

The packet carries a position and a heading. **Every velocity is zero**, so
neither end dead reckons a camera -- there is no prediction to run and none to
correct. The server takes it as sent: `applyObserverHeartbeat` checks only that
the numbers are numbers, since a
NaN would poison the distance maths. That is parsing, not validation, and no
validation belongs there. An observer has no collision, no shots and no score,
so there is no state a lie could corrupt -- only being heard from somewhere you
are not, which is small beside what an observer may already watch.

**It goes out to every client as an ordinary `pm`.** The server's own roster is
not the only thing that needs it: voice is peer to peer, so each client decides
for itself how loud a peer is and where it stands, and it cannot do that for an
observer it cannot locate. Reusing `pm` means no client-side special case -- the
mesh it moves is the invisible one every observer already has at health 0, and
the zero velocities give the receiving end nothing to extrapolate.

**`?follow=leader` is the link to hand somebody who wants to watch.** It joins
as an observer in the `follow` view on whoever is leading, and does not stop to
ask for a name: a browser that already has one keeps it, and one that has never
been here joins under the name the server gave the connection. It is the entry
dialog's own staging underneath -- the team is selected and the join is sent, so
nothing about the join path is special-cased -- and nothing is saved, so a plain
reload of `/` is an ordinary player again. `C` leaves the view like any other.

The value names **who** to watch, because that is the axis that will want more:
a callsign is the obvious next value, and `leader` is simply the one target the
roaming views can already resolve without being told an id. Which rig to watch
from is the other axis and would be a parameter of its own -- one value cannot
carry both. A value bzo cannot resolve is **refused** rather than guessed at, so
a typo joins the game normally instead of silently watching the wrong tank, and
so does a server that does not offer the observer team. The view is re-applied on
every join rather than once, because a reconnect is how a client comes back from
a server restart and a link left running on a screen should come back watching.

**An observer uses voice on the same terms as everybody else.** It could
always text chat, so the microphone ban was the odd rule out, and it lived
hardcoded in three places at once. Whether an observer may chat at all belongs
in a server option covering text and voice together; that is not built yet.

`gatherDriveInput()` in `client.js` is the one place the drive axes are read, so
a tank and the camera see the same controls from every input surface. Each view
resolves to a concrete eye and look point in `getRoamFraming()`, so `render.js`
only applies one and the rigs stay with the game state.

`compareScoreboardPlayers` is exported from `hud.js` and drives both the
scoreboard order and the leader that roaming falls back to. Upstream reads the
leader off the scoreboard's own order, and two orderings would let the tracked
player and the top row disagree.

### One roster, however many surfaces draw it

Two surfaces draw the scoreboard -- the flat HUD's DOM list and the headset's
canvas panel -- and **neither gathers its own inputs.** `buildScoreboardRows()`
in `hud.js` builds the rows, `getScoreboardModel()` in `client.js` wraps them
with the team rows and the roaming target, and `refreshScoreboards()` is the
only entry point. It takes no arguments, so there is nothing for a caller to
leave out: a repaint that reached the board without the flag lookup dropped
every carried flag off it, and a team score change is a repaint, so a player
joining blanked the column for everyone.

The headset's panel is painted from the render loop, so it reads the model on
its next frame. The model carries a version and the panel remembers which one
is on its canvas: an unchanged roster costs a placement and nothing else, where
rebuilding and re-sorting the rows every frame is real work in the one frame
that can least afford it. Placement still runs every frame, because it is what
sets `mesh.visible` and hides the panel behind the XR menu.

| observer action | desktop | mobile | gamepad | XR |
|---|---|---|---|---|
| translate / yaw | WASD, arrows, mouse box | joystick | left stick | thumbstick |
| step the selection | Enter, C, left click | `●`, Camera row | A / RT | either trigger |
| up | Tab | `⤒` | B / LT | grip |
| down | Space | `⚑` | X | A |
| identify | I, right click | `◎` | shoulder | thumbstick press |

**The XR budget is full, and every action stays reachable from one controller.**
Either trigger fires, and grip, A, B -- the settings menu -- and the thumbstick
press are each OR'd across both hands by `getXRControllerInput()`
(`webxr.js:628`). That invariant is why those merged accessors exist: a new XR
action may only ever be added by taking a binding, never by splitting one across
hands.

**Identify is on the thumbstick press and the menu is on B, not the other way
round.** A stick is under a thumb that is already steering, so it is the control
that gets pressed by accident, and what sits behind it has to be the action that
costs nothing when it fires unasked. Identify picks a roaming target; the menu
takes over the view.

### Intentional deviations

- **A bad flag is named in the warning colour on both scoreboards.** Upstream
  leaves the carried flag in the player's own colour there and separates the bad
  ones onto a help page instead (`Help6Menu`, "Bad Flags"). The red is the one
  upstream already uses for the same fact -- `hud->setAlert(2, flagName, 3.0f,
  endurance == FlagSticky)` (`playing.cxx:1455`) -- so the colour a player sees
  when they pick a penalty up is the colour it keeps on the roster. The flag in
  the world and on the radar is untouched: `FlagType::getColor` is white for
  every superflag, and that is what bzo draws.

- **One flattened cycle, not two.** Upstream spends two bindings here: F8 cycles
  the view type and F6/F7 cycle the subject. bzo binds nothing to changing the
  subject on its own, so fire, `C`, and the Settings/XR Camera row all walk the
  same list -- within a view that takes a subject, the leader first and then
  every player, then on to the next view. While roaming those replace the
  first/third/overview cycle, which does nothing for an observer; the player's
  own choice is left untouched underneath for when they join a team.
- **The camera is level, like a tank's.** There is no pitch axis: altitude is on
  a button and no axis is left, and the look point sits one unit ahead at the
  eye's own height, so it travels with the camera forward, sideways and
  vertically. Climbing raises what you are looking at rather than tilting the
  view down. Upstream has pitch on Ctrl+forward.
- **Vertical moves at tank speed, not upstream's `4 *`.** Upstream's vertical is
  a proportional axis under Shift; a button has no proportional control, and
  100 u/s off one overshoots badly.
- **`identify` acts only in the free view.** It means "whoever is centred in my
  sights", which is only a choice where the player aims the camera; every other
  view is already pointed at its target, so identifying from one would re-pick
  the tank already being watched. Upstream never meets this because it changes
  subject with F6/F7 rather than by looking. In a following view it says so, and
  the cycle or the scoreboard is how the subject changes there.
- **XR keeps a level frame and no zoom.** Tilting `worldGroup` tilts the horizon,
  which is the nausea case, and the head already looks around; the runtime owns
  the stereo projection, so zoom is not offered there at all.
- **Roam zoom ships unbound everywhere.** Every key that would carry it is spent,
  `=`/`-`/`\` on radar range in particular. `ROAM_ZOOM_DEFAULT` equals bzo's
  `BZFlag_DEFAULT_HORIZONTAL_FOV`, so a roaming view is exactly as wide as a
  playing one, and the yaw rate still scales with it.
- **A click over the click-through chat panel steps the selection**, because the
  left button fires and fire steps. Accepted rather than special-cased.

### TODO

- **Switching teams on the live connection.** Any team to any team, including in
  and out of observer and rogue, without reconnecting. Stock BZFlag has no team
  switch at all -- `JoinMenu` runs before the connection exists -- but a page
  reload is a much worse price than a menu.

  Most of it exists: `joinGame` handles a second arrival on the same connection,
  reading `previousTeam`, resetting and retiring team flags either side of the
  move, resetting the score, and refreshing the voice roster.
  `applyXRJoinSelection()` already re-sends it, so the XR Player Options screen
  is wired for it today. What is missing is the 2D path, which never re-sends:
  `maybeSendPendingJoinRequest()` returns early once `gameplayJoinConfirmed` is
  set.

  **A join always respawns and zeroes the score, even onto the same team.** That
  matches a rejoin upstream, but Player Options carries name, team and tank on
  one screen and re-sends all three, so a *tank-only* change costs the player
  their position and score. The carried flag already survives it, because the
  flag drop keys off `previousTeam !== assignedTeam` rather than off the join.
  The fix is for Player Options to route an unchanged team through
  `setTankModel`, which touches neither flags nor position.

  Also unsettled: switching to observer while alive must not become a way to
  dodge an incoming shot. Upstream's answer is the rejoin wait, which bzo has no
  equivalent of; losing the score may be disincentive enough.
- Observers keep upstream's scoreboard order (`obsLast`) but the XR menu panel
  has no target list, so in XR the cycle and `identify` are the only pickers.
- `follow` does not reuse the death camera rig (`render.js`), which is the same
  look-at-a-moving-target shape.
- `XR_HELP_ITEMS` is one flat frozen list, so it cannot show the observer
  meanings of grip and A. That wants observer-conditional rows, which is what
  issue #27 is for.
- Whether continuous stick yaw is comfortable in XR roam. It matches what bzo
  already ships when driving; a comfort option is a measurement, not a guess.

## HUD alerts and the status line

`renderRoaming()` draws **both**, and so does every other mode: `renderStatus()`
puts a persistent line at the very top and `renderAlerts()` stacks up to three
timed slots just under it. They share the `#hudNotices` column in bzo, and one XR
panel draws the same column so an immersive session sees it too.

`HUDRenderer::setAlert` / `renderAlerts` (`HUDRenderer.cxx:398`, `:767`): three
slots, each with its own clock, large and centred with slot 0 highest, a warning
in the warning colour. `gotBlowedUp()` puts the death notice there for four
seconds as a warning (`playing.cxx:4028`), worded from `blowedUpMessage[]` --
"Got shot by <callsign>", "Tank Self Destructed". bzo keeps the slots, the
timing and the wording, and adds a kill notice upstream has no equivalent of:
upstream only ever warns you about your own death, but the two read as a pair.

Alerts deliberately sit over the scoreboard and radar. They last seconds, and
reading them matters more than what they briefly cover. An observer cannot die or
score, so the kill and death notices never fire for one, but server and game
alerts do.

The roaming label is the status line, not an alert -- it persists. It reads
`Leader <callsign>` for the automatic target, from
`ScoreboardRenderer::getLeader`'s own prefix, so watching whoever is winning is
distinguishable from having picked that same player by hand.

### A flag is named three ways, one per surface

| surface | form | function |
|---|---|---|
| HUD alert | `Identify` | `describeFlag` |
| chat notice | `ID/Identify` | `describeFlagForChat` |
| beside a callsign | `Orin/ID` | `getFlagLabelForAbbreviation`, `formatPlayerLabel` |

Upstream prints the name alone in chat (`playing.cxx:2734`) and bzo's kill
notices print the abbreviation alone, so nothing connected the `/ID` on the
scoreboard with the flag that does the identifying. The grab, drop and theft
lines pair both, because that is where a player learns the mapping: they fire
once per pickup rather than every frame, so three characters buy something
there. Alerts and the shake countdown keep the short name -- `ID/Identify 4.3`
is a countdown made worse.

Team flags are name-only in every form. Their abbreviations are `R*` through
`P*`, which nothing displays anywhere, so `R*/Red Team` would teach a string
that appears nowhere else.

The fourth surface is the debug label a flag standing in the world wears with
the labels on, which is the abbreviation alone -- and it is drawn in the colour
of the cloth beneath it, `getKnownFlagColor`: a team's colour for a team flag,
bzo's bad-flag orange for one this client has identified as bad, and white for
every other superflag, which is what upstream draws all of them and what an
unidentified one stays. One source for the colour, so a label can never disagree
with the flag it names.

### A phasing tank is clipped at the wall and sprays light out of the seam

Two effects, one plane. `getBoxCrossingPlane` (`collision.mjs`) is `isCrossing`
(`BoxBuilding.cxx:143`), whose three upstream bodies -- box, pyramid, base -- are
the same function, so bzo has one. It answers with the face the tank is
straddling, normal pointing **out** of the building, and null in two cases that
look alike from outside: clear of the obstacle, and swallowed whole. The second
is why the lights appear on the way in, vanish inside a thick building and
appear again on the way out.

- **The clip plane** cuts the buried half away, so the tank reads as sliced flat
  at the wall rather than as a tank with its nose in geometry.
- **The interdimensional lights** (`TankIDLSceneNode`, upstream's own `showIDL`)
  streak white out of the cut edge, opaque at the seam and transparent at the
  tips, re-rolled every frame so they flicker.

Not OO's alone: upstream's condition takes `crossingTeleporter` too, so PZ gets
it. bzo already had the *other* half of the OO visual -- the eighth dimension,
which is what the phasing tank sees of the building -- and these are what
everyone else sees of the tank.

**Three things about the implementation are deliberate.**

`isCrossing` guesses which wall -- the one nearest the tank's centre -- and
upstream calls it a guess: *"this is a guestimate, should really do a careful
test"*. Wrong only at a corner, where either wall is defensible, and the careful
test would be paid for by every phasing tank every frame to improve decoration.

**The silhouette is upstream's table, not bzo's tank mesh.** 40 vertices and 26
faces standing in for body, turret, barrel and treads, in world units, which bzo
shares. bzo has several tank models where upstream has one, so a table that
suits all of them roughly beats a silhouette exact to one -- and it caps the
per-frame cost at a known number where the real meshes vary.

**The clip plane is assigned once per tank and then mutated.** Assigning or
removing `material.clippingPlanes` changes the plane count and recompiles every
program the tank draws with. So the array goes on at the first wall and stays,
holding a plane that cuts nothing when the tank is clear -- toggling it would
recompile on the way out and again on the next wall, which is the pattern
`noteProgramCount` exists to catch. `localClippingEnabled` is set at
construction for the same reason, one size larger.

**No protocol change.** Upstream computes this on the tank's own client and
ships a `CrossingWall` status bit for the rest to redraw from. bzo's client
already knows every player's flag, because the server owns flags, and already
holds the obstacle list -- so every client answers for every tank and the wire
says nothing.

### A tank's siblings have to be let go by name

Several things are drawn *for* a tank but parented to `worldGroup` beside it
rather than under it, because a child would inherit the tank's landing squish,
spawn grow and dimension scaling:

| sibling | released by |
|---|---|
| the server-position ghost | `discardTank` |
| the projected shadows | `renderManager.dropProjectedShadows` |
| the crossing-wall clip plane and lights | `renderManager.dropTankCrossingEffect` |
| the jump-prediction debug geometry | `clearJumpPredictionDebug` |

**`discardTank` is the only place that releases them, and it has three callers**
-- a player quits, a new world arrives, and `addPlayer` throws a tank away to
rebuild it in another colour or model. Those were three copies of the same
teardown and they had already drifted, only the quit path dropping the shadows,
so the crossing lights were left behind by two of the three on the day they were
added. Anything new hanging off a tank goes in that function.

**Player state is not tank state.** The paused sphere and the missile lock belong
to `removePlayer`, not to `discardTank`: `addPlayer`'s rebuild discards a tank
mesh while the player is still sitting there, and a rebuild that cleared their
lock would be a bug of its own.

**Not being drawn is the other path, and it is not teardown.** A tank that dies
or cloaks to nothing keeps its object and stops being drawn, which is upstream's
two early returns in `Player::addToScene`. `tank.visible` is exactly that
condition in bzo, so a per-frame effect tests it -- a tank killed inside a wall
is the case that catches this, since it stops being drawn where it stood and it
still holds its flag on this client until the server's drop arrives.

## Anti-cheat modes

`antiCheat.mode` in `server.json` is `strict`, `warning`, or `disabled`, and it
decides what happens to a packet the server believes an unmodified client could
not have sent:

- **strict** refuses the packet.
- **warning** honours the packet and writes the disagreement to the log.
- **disabled** does not look.

**`warning` must never change the game.** A refusal in warning mode defeats the
only thing the mode is for: you cannot work out why the server disbelieved a
packet if the server has already hidden the evidence behind a rubber-band, a
swallowed shot, or a jump that never happened -- and each of those goes on to
produce warnings of its own, because the client's state and the server's have
now diverged for a second reason. Every rejection therefore routes through
`reportCheat` in `server.js`, which counts the finding, logs it as
`[ANTICHEAT:<MODE>] Player "<name>" <what> | REFUSED|ALLOWED | Warnings: <n>`,
and returns whether the caller must refuse. Callers must obey the return value
rather than deciding for themselves. Silently substituting a server-computed
value for the client's counts as refusing it.

The findings are: linear drift, angular drift, collision, moving while paused, a
speed that changed faster than the configured acceleration, a rejected shot, a
rejected jump, and the flag grab, shake and capture checks.

**A malformed packet is not an anti-cheat finding.** A non-finite coordinate or
velocity, a zero-length shot direction, or a shot from an observer cannot be
turned into game state in any mode, so those are refused in every mode and
logged as `[ANTICHEAT] Player "<name>" MALFORMED ...` without counting as a
warning. The distinction is whether the server is exercising judgement: a
tolerance it drew and the client did not is a finding, and a packet it cannot
act on is not.

### Inertia is BZFlag's, and both ends run the same model

There is one acceleration model, `doMomentum`, and it lives in the flags pair so
the client that drives the tank and the server that checks it are running the
same code against the same numbers. The rule is upstream's: a limit in units per
second squared, applied to the *velocity*, with **zero meaning no limit at all**.

**No inertia is the default**, because it is upstream's. bzfs takes `-a <vel>
<rot>` and defaults it to `0 0`, and `doMomentum` only clamps `if (acc > 0.0f)`,
so a stock BZFlag tank reaches full speed in one frame. bzo now does the same,
and takes `-a` in `server.json` (`linearAcceleration`, `angularAcceleration`) and
in a map's `options` block, as upstream takes it on a command line and in the
same block.

bzo used to smooth the *stick* instead, through five rates of its own --
`forwardAccel`, `reverseAccel`, `forwardDecel`, `turnAccel`, `turnDecel` -- with
no upstream counterpart. That gave every tank inertia BZFlag does not have, at
roughly `-a 2.25 2.36`, with no way for a server or a map to say otherwise. Those
five keys are gone. **Do not reintroduce a second acceleration model**: the point
of one model is that "feels like BZFlag" is a thing that can be checked rather
than tuned by ear.

`M` Momentum composes with the world's limit rather than replacing it -- see the
flags pair -- so it is a handicap on every map instead of upstream's
do-nothing-here, upgrade-there.

### The acceleration check cannot see the stick

`fs` and `rs` in a move packet are not the client's input. `updateMovement` in
`client.js` derives them from the *resolved* displacement of the last single
frame, after collision, so they are a measurement of where the tank got to and
not a statement of where it was asked to go. Several things follow, and some have
already been got wrong once:

- **With no inertia there is nothing for this check to find**, which is correct
  rather than lax: a tank with no acceleration limit really can reach full speed
  in a frame. What bounds it then is the `fs`/`rs` clamp, which is the flag's own
  maximum. bzfs makes the mirror-image trade -- it skips its high-speed check
  when inertia *is* on (`bzfs.cxx:5395`).
- **A speed change caused by geometry is not bounded by the tank's limits.** A
  tank sliding along a wall reports whatever the collision resolver left it,
  which can swing across the whole range in one packet while the input holds
  steady. The acceleration model has no term for this.
- **Air control has no ramp to bound.** A `WG` Wings tank steers in mid air, and
  with `_wingsSlideTime` 0 -- upstream's default and bzo's -- its velocity
  follows the stick with no ramp at all, so a full reversal in one frame is
  correct rather than impossible. The check therefore does not apply while a tank
  with air control is off the ground. Refusing it in strict mode would rubber-band
  the one flag whose whole point is steering where nothing else can.
- **`A` Agility has no ramp either.** Its window opens and the tank is 2.25x
  faster in the same frame, which is the flag's whole point. The forward half of
  the check therefore does not apply to a tank carrying it; the turn half still
  does, because Agility does not touch turning.

### `fs` and `rs` are fractions of the *world's* speed, not of the tank's

A tank carrying `V`, `QT` or `A` reports more than 1, and both ends multiply by
the world's `TANK_SPEED` or `TANK_ROTATION_SPEED` to get the real thing. That is
what keeps `getExtrapolatedPosition`, the remote extrapolation on the client and
the tread animation all correct with no flag state of their own -- the number on
the wire already says how fast the tank is going.

The server holds the reading to the flag's *largest* factor rather than its
instantaneous one (`getMaxSpeedFactor` in the flags pair). Agility's window is
the client's to run: a bound costs no state, and the alternative is the server
mirroring a one-second timer off packets that do not carry the stick. It is a
looser gate than upstream's -- a modified client could hold the boost -- and it
is the same trade as the shot position tolerance above it.

The window comes from `sdt`, the interval the client reports between its own
move packets, bounded by `getAccelerationWindow`. `dt` in the same packet is one
frame and is not the same thing. The server's gap between arrivals is the send
interval plus jitter, and jitter that shortens it makes an honest ramp look
impossible.

`sdt` is a client-asserted input to a cheat check, which is allowed here only
because it is bounded: it may widen the window and only by
`SDT_JITTER_ALLOWANCE`. Do not add an unbounded one -- in particular do not let
the client name the obstacle it hit, which would let any client turn the check
off by asserting a collision.

The capture check never refuses even in strict mode -- see the intentional
deviations above -- so it passes `enforceable = false` and always logs ALLOWED.

## Shot timing

BZFlag derives shot timing from `_reloadTime`, which itself defaults to
`_shotRange / _shotSpeed`:

- `ShotPath.cxx:48` — a shot's lifetime is `_reloadTime`
- `LocalPlayer.cxx:1311` — a slot reloads after `_reloadTime / numShots`

So firing continuously sustains exactly `maxShots` shots in flight. bzo derives
`SHOT_RELOAD_TIME` the same way, after the `server.json` overrides are applied
and again after a map's `-ms`, so changing `shotMaxActive`, `shotSpeed`, or
`shotDistance` keeps the relation intact. With the defaults and one slot that is
3500ms; `maps/hix.bzw` asks for five and gets 700ms.

### The server does not enforce a reload timer

Fire rate is limited by shot slots alone. `bzfs.cxx` `shotFired()` has no
elapsed-time check at all, and `GameKeeper.cxx` `addShot()` refuses a shot only
when that shot's own slot is still live. Each slot expires a full shot lifetime
after it was filled, so two consecutive shots never share a timer.

**Do not add a global cooldown back.** A reload timer compares shots that are
one reload apart, which is the interval network jitter actually lands in: the
client starts its window when it sends and the server started its window when it
received, so any dip in latency between two shots makes an honest one look
early. Slot expiry compares shots a full lifetime apart, where jitter is noise.
The sustained rate is identical either way -- `maxShots` slots each held for one
shot lifetime is one shot per `SHOT_RELOAD_TIME`.

### Open question: a variant's slot frees on its life, not its reload

Upstream keeps the two apart. `ShotPath::reloadTime` starts at `_reloadTime` and
each segmented strategy scales it in its own constructor -- `setReloadTime(reload
/ adRate)` -- while `FiringInfo::lifetime` is scaled by the flag's `adLife`. The
slot frees on the reload; the shot dies on the life. For `F` Rapid Fire and `MG`
Machine Gun the two coincide, because their life is declared as the reciprocal of
their rate, and that is the coincidence bzo built on: the server holds a slot for
`lifetimeSeconds` and the client gates firing on `SHOT_RELOAD_TIME / rateFactor`.

Three flags break the coincidence. `L` Laser has `_laserAdLife` 0.1 against
`_laserAdRate` 0.5, `SW` Shock Wave has `_shockAdLife` 0.2 against no rate
scaling at all, because `ShockWaveStrategy` is the one strategy that never calls
`setReloadTime`, and `TH` Thief has `_thiefAdLife` 0.05 against `_thiefAdRate` 12.
So an honest client fires a laser every 7s, a shock wave every 3.5s and a thief
beam every 0.29s, exactly as upstream does, while the server's slot check would
let a modified one fire a laser every 0.35s, a wave every 0.7s and a thief beam
every 0.18s. Honest play is right; the anti-cheat gate is loose.

The fix is to give `Projectile` a slot expiry separate from its lifetime -- the
reload scaled by `rateFactor` -- and check shot slots against that rather than
against how long the shell lives. Deferred rather than folded into the phase that
found it, because it touches every shot variant and the two the gap is visible on
are already in.

### Open question: shot position tolerance

bzo allows a shot origin `barrelLength + SHOT_POSITION_TOLERANCE` (~5 units)
from the extrapolated tank position. bzfs allows
`tankSpeed * _velocityAd + 2 * _muzzleFront` -- tens of units -- deliberately
absorbing a frame of tank motion and flag effects. bzo is much stricter than
upstream here. Rejections now log as `[ANTICHEAT:...] SHOT REJECTED`; if honest
shots are being refused on position during testing, widen the tolerance toward
upstream's rather than assuming a client bug.

`shotReloadTime` in `server.json` pins the value and disables the derivation.
Leave it unset unless an operator deliberately wants a non-BZFlag fire rate --
in particular do not add it to `example-server.json`, which is copied to
`server.json` on first start.

## Keyboard

`GAMEPLAY_OWNED_KEYS` in `public/input.js` lists every key gameplay consumes,
and the keydown listener calls `preventDefault` on the whole set once the
guards have established that no dialog or text field wants the event. **Add a
key there in the same change that binds it.** Several defaults break play
outright: Tab walks focus onto the HUD buttons, where Space then presses one
instead of firing, and Firefox opens quick find on `/` and swallows the
keyboard. The rest have no default worth naming today, which is what quick find
looked like until someone played in Firefox.

Nothing carrying Ctrl, Meta, or Alt is ours, whatever key it is built on:
Ctrl+W, Cmd+Q and Alt+Left pass straight through. Escape is deliberately absent
from the set: a browser will not let go of it, and leaving fullscreen is the
first rung of the ladder below rather than something to fight.

### Escape backs out one rung at a time

Upstream's Escape opens the main menu (`MainMenu.cxx`), and Settings is the
nearest thing bzo has -- but the web spends Escape on its own state first, so
`handleGameKey` makes a ladder of it and each press undoes exactly one thing:

| state | Escape does |
|---|---|
| chat entry focused | leaves chat (handled earlier, in the chat input's own handler) |
| a dialog open | dismisses it (`handleDialogKeydown`, earlier still) |
| `document.fullscreenElement` set | nothing: the browser is already leaving fullscreen |
| mouse steering on | turns it off, through `toggleMouseMode` so the row, the button and the preference all follow |
| otherwise | `openSettingsDialog()` |

Settings is one press from a plain client and three from a fullscreen
mouse-steering one, in the order somebody would want them undone -- and the
press after the last one closes Settings again, so pressing Escape once too
often never leaves a player somewhere they did not ask to be. That recoverability
is what makes a multi-press ladder acceptable; without it, guessing wrong would
cost something.

### Sideways operates a row, up and down move between rows

`handleDialogKeydown` in `public/menus.js` is the one focus model every dialog
shares, and the split is the same one an XR thumbstick reads -- one habit works
on every surface:

| key | in a dialog |
|---|---|
| Up/Down | previous/next control, **from any row including a text field** |
| Left/Right | adjust the focused control -- `adjustFocusedControl`, the same `menuadjust` event XR sends |
| Tab/Shift+Tab, Home/End | previous/next, first/last |
| Escape | dismiss |

Up and down are handled *before* `canCycleWithArrowKeys`, which a text field
fails on purpose: left, right, Home and End stay native there because that is
what editing needs, but a single-line input has no use for up and down and the
browser would spend them jumping the caret to the ends of the text, stranding
the focus in the field. That is what the MOTD row did before.

A dialog tagged `data-dialog-kind="document"` -- the help panel -- is read rather
than operated, so its arrows scroll and only left/right move focus. Cycling
focus through its handful of links would leave most of the text unreachable, and
in XR there is no Page Up to reach the rest with.

Verified in a real browser rather than a stub: `scripts/headless-client.mjs
--eval` can force `operatorOverlay` visible, focus `motdInput` and dispatch the
keys. There is no jsdom here, and a DOM stub deep enough for `activeElement`,
focus and visibility would mostly test itself.

The fullscreen rung claims the press rather than letting it fall through.
Whether a browser also delivers the keydown that exits fullscreen is up to the
browser, and claiming it means the rung is spent either way instead of doubling
up with mouse steering on the browsers that do deliver it. bzo does not use
pointer lock, which is why mouse steering needs a rung at all.

bzo matches upstream on every binding it has taken so far
(`ActionBinding.cxx:91-98`):

| upstream | key | in bzo |
|---|---|---|
| `fire` | Enter, Left Mouse | matches |
| `drop` (drop flag) | Space | matches |
| `identify` | I, Right Mouse | matches |

**`I` and Right Mouse carry `identify`. Do not spend either on anything else.**
The debug HUD sits on the backtick instead, which is unbound in upstream BZFlag and
is the console key by convention everywhere else. It is matched on
`event.code === 'Backquote'` rather than `event.key`, because AZERTY and QWERTZ
do not produce a backtick from that physical key -- the rest of the dispatch in
`input.js` matches on `key`, and this is the one binding where the two diverge.

Upstream binds `I` and Right Mouse to **both** `identify` and `restart`, gated on
whether the tank is alive: `cmdIdentify` acts only when alive, `cmdRestart` only
when dead. bzo rejoins without waiting for a click, so the `restart` half has
nothing to do here and the binding is purely `identify`.

`identify` targets the tank centred in the sights -- nearest player within
`_targetingAngle` 0.3, about 17.5 degrees, anything behind ignored -- and sets
nemesis as a side effect (`setTarget`, `playing.cxx:4390`). It is one action with
two meanings, not two bindings: the roam target picker in observer mode, and the
guided-missile lock once those land. `pickTargetInSights` in `public/roam.mjs`
holds the cone, so the missile path reuses it rather than growing a second copy.
It also rides `virtualInput.identify`, which is where the touch button, the
gamepad shoulders, the XR B button and a right click arrive. The mouse is not
one of the three sources `syncVirtualInput()` chooses between -- it coexists
with them -- so `setPointerIdentify()` is OR'd in rather than replacing the
chosen one, which is what makes a right click work with a gamepad plugged in.
bzo also claims `contextmenu` so the browser's own menu cannot have the button,
but only while gameplay owns input and only outside the chrome: a right click in
the chat box or the name field is still a paste. See the Observer section.

## Mouse steering is the targeting box

The two boxes drawn at the centre of the screen are the mouse mapping, not
decoration, and bzo takes the mapping from `doMotion()`
(`playing.cxx:1088-1131`):

- Inside the inner box the tank does nothing.
- From there the input ramps linearly, reaching full deflection exactly at the
  outer box edge: `(|offset| - noMotionSize) / (maxMotionSize - noMotionSize)`.
- Each axis clamps on its own, so running the cursor past the box pins that axis
  at full and leaves the other free -- driving flat out while still steering.
- Reverse stops at half speed, which `REVERSE_SPEED_RATIO` already applies.

The box sizes are upstream's too: `MaxMotionSize` 37 and `NoMotionSize` 10
(`global.h:88-91`) scaled by `min(width / 256, height / 192)`, which is what
`HUDRenderer::resize` computes at the default `mouseboxsize` of 5, where its
`effScale` equals that scale. They live in `--motion-box` and
`--motion-dead-box` in `styles.css`, and `client.js` reads the geometry back off
the elements rather than keeping a second copy of the numbers. The heading bar,
altimeter, and voice readout hang off the same variable, as upstream hangs them
off `maxMotionSize`.

**Upstream also confines the cursor to the box** (`mouseClamp`, using
`confineToMotionbox`); a browser cannot without pointer lock, so bzo lets the
cursor leave. The mapping saturates either way -- the only cost is a longer drag
back to centre.

### Keyboard and mouse drive together

Upstream's input method is exclusive -- Keyboard, Mouse or Joystick -- and under
`allowInputChange` (default on) it bumps between them on its own: a drive key
selects Keyboard (`playing.cxx:821`), moving the mouse selects Mouse
(`playing.cxx:1296`). bzo does not autoswitch at all. `M`, the Mouse Steering
row and Escape's mouse rung are the only things that change the setting, and `gatherDriveInput()`
mixes instead: **per axis, the first source with something to say wins --
keys, then a stick, then the mouse box.** Hold a drive key and it owns that axis
while the mouse keeps the other, so a player steers with the mouse while holding
`W`. Holding W and S together is a deliberate stop, so a held pair still owns its
axis at zero, as upstream's `keyboardSpeed` does.

The order matters: a released stick reads zero and falls through to the mouse,
while the mouse box legitimately holds an offset with the cursor parked away from
centre. Upstream mixes the same way where it mixes at all -- its joystick branch
takes rotation from the keyboard and speed from the stick (`playing.cxx:1048`).

**Do not add an autoswitch.** Upstream needs one because its input methods are
exclusive and something has to pick between them; here both drive at once, so
there is nothing left to pick. An autoswitch that also wrote its choice to
`localStorage` -- which upstream never does -- would throw away a preference the
player set by hand, on a keypress they meant as a turn.

### A mouse is a capability, not a platform

`isMobile` is a user-agent guess, and a phone with a mouse paired to it steers
exactly as a desktop does. So the question goes to the browser:
`isMouseSteeringAvailable()` asks `(any-pointer: fine)`, the same way
`capabilities.mjs` asks the GL context what it can do, and the query is live --
plugging a mouse into a phone lights the row up without a reload. **A real
mouse event outranks the query**, because the query does get it wrong: headless
Chrome has no input devices attached and answers `false` on a machine with a
mouse on the desk. A `pointermove` or `pointerdown` carrying
`pointerType === 'mouse'` latches the answer on and the listeners take
themselves off; `pointerType` is what separates a mouse from a finger, since a
touch produces mouse events too but never a mouse pointer. Two contexts
close the gate whatever the pointer says: **VR**, where there is no cursor to
read, and **the on-screen controls**, which steer instead while they are up.

The row goes dead rather than inert -- visible, reading `Unavailable`, skipped by
the focus -- which the settings menu already does for any `disabled` toggle. The
stored preference is untouched by an unavailable context and comes back when the
context does; only `mouseControlEnabled` is the player's answer, and
`mouseSteeringActive()` is whether the box is steering right now.

Keyboards need none of this. There is no media query for one and no gate worth
writing: the keys arrive from `keydown` on any device that sends them, so a
keyboard paired to a phone or a headset simply drives. The one thing that stood
in the way was a `!isMobile` on the fire key, which also meant a canvas tap could
never shoot.

A left click fires wherever the cursor is, with mouse steering on or off. It is
`mouseGameplayClickActive()` that decides whether a click is a shot at all, and
it says no in VR -- a paired mouse cannot aim there -- and no while the
on-screen controls are up, because those own the whole screen and a tap that
misses the fire button is a miss, not a shot.

## The ground follows the eye

The ground is not one enormous quad. It mirrors `drawGroundCentered()`
(`BackgroundRenderer.cxx:1132`), which is upstream's default at quality 2: a
patch of `centerSize` 128 that follows the eye, skirted by four quads reaching
`10 * worldSize`. Texture coordinates are the world position times
`groundHighResTexRepeat` (0.05, which bzo already used), so the texture is
pinned to the world rather than to the patch sliding under it.

**Do not replace it with a single large plane.** Everything near the camera then
falls on one triangle kilometres across, and the texture coordinates
interpolated across it drift as the view moves -- the ground visibly swims
against the obstacles standing on it, worst at low speed. The centre patch keeps
the near ground on a small triangle, where that error is nothing.
`updateGroundCenter()` re-centres it once per frame from the eye in
`worldGroup` space, so it works in XR, where the world moves instead of the
camera.

## Frame timing

`animate()` takes the timestamp the animation loop hands it -- rAF's, or the
frame's predicted display time inside an XR session -- and never samples
`performance.now()` for the step. Those timestamps land on the display's
cadence; a clock reading taken inside the callback also carries however long the
main thread took to get there. Measured on this client, frame timestamps sit
0.05ms off the vsync grid and a `performance.now()` reading sits 3.8ms off it.
Spent as movement, that noise makes each displayed frame advance slightly too
far or not far enough, which reads as the ground jittering -- worst at low
speed, where the eye tracks the motion and expects it to be even.

The step is also clamped to `MAX_FRAME_DELTA_SECONDS`, because a hidden tab
delivers no frames and the first one back would otherwise spend the whole gap at
once.

**The local position is never rounded.** `playerX/Y/Z` carry full precision;
`toFixed(2)` belongs to the move packet, the debug ghost mesh, and the teleport
packet. The only rounded values that come back into the local state are
server-authored ones -- `positionCorrection` and teleport echoes -- and those
are events, not something every frame pays.

### Reading a `renderer.stats` line

`public/perf.js` splits each frame into phases and averages them over a second.
The phases run in frame order -- `xr`, `hud`, `input`, `matrix`, `shadows`,
`sim`, `radar`, `worldfx`, `draw` -- and `outside` is everything between one
frame callback ending and the next starting: waiting for the GPU and the
display, the browser laying out and painting the HUD's DOM, socket handlers,
collection. The phases plus `outside` are the whole frame, so they sum to
1000/fps.

That split is the point. A client can be slow with every phase small, and then
nothing bzo controls is the work to cut -- measured on t5810, `outside` of 60ms
against a `draw` of 10ms, which turned out to be Chrome compositing its WebGL
canvas through a readback path. Only adapt the phases bzo owns, and only when
they are the majority of the frame.

**Frame rate on its own decides nothing.** It is quantised by the display: a
client pinned at exactly 30 or 60 is telling you its refresh interval, not its
headroom, and every saving below the threshold reads as "no difference". That is
what `fastest` is for -- the shortest frame in the window, which bounds the
refresh interval from below, because there is no web API for it. `fastest=33`
is a 30Hz panel; `fastest=16.7` is not. To A/B anything, take vsync out first
(`--disable-gpu-vsync --disable-frame-rate-limit` in Chrome).

The other fields: `drawbuf` is the drawing buffer, which moves with the window
and with `renderScale`; `programsWindow` is the low-high program count over the
window, and a count that moves during play is Three recompiling rather than a
bigger scene, since its program cache key includes the light count.

**Finding a leak: read `grew`, not the counters.** A leak is a trend, and no
single sample can show one -- which is why a client whose frame rate drifts down
over an idle hour had no evidence behind it. So every counter that could climb is
baselined at the page's first sample and reported as movement since then:
`grew=objects+240,heap+38.5`, and the field is absent entirely while nothing
moves. The baseline deliberately outlives a reconnect, because a leak the
reconnect *clears* is exactly the case worth catching -- resetting it there would
hide the finding.

- `objects` is every node in the scene graph, the one aggregate that catches
  "something is being added and not removed" whatever the something is.
  `textures` and `geometries` count what Three has uploaded and miss a node
  holding a shared one. It is a `deep` field: the debug HUD polls
  `getRenderStats` twice a second while it is open, and that is exactly when
  somebody is measuring, so the scene walk is asked for by the logged series and
  not by the HUD. An instrument that costs what it measures is worse than one
  field short.
- `tanks`, `shots`, `worldFlags`, `spheres` and `labels` are bzo's own
  collections. Each is added to on one event and has to be removed from on
  another, so a count that climbs while a client sits idle names which one
  forgot.
- `heap` is `performance.memory.usedJSHeapSize` in MB, Chrome and Edge only. It
  is coarse and lags collection, so read the slope and not the value. Absent
  rather than zero where the browser does not expose it: a zero would read as
  "no memory used" beside another browser's figure.

**A slow series runs on every client**, five minutes apart, so a flat page left
open produces a trend rather than the single sample at map entry it used to. The
XR series stays at twenty seconds and suppresses the slow one, since a session is
short and two interleaved series read as noise.

**`contextLost` appears only when it has happened.** A lost GL context is how a
client ends up drawing black: the browser takes the context away -- a driver
reset, a background tab reclaimed, too many live contexts across tabs -- and
every texture in it goes with it. That failure used to be entirely silent; the
listeners log it with the resource counts at that moment, and the count rides
every later stats line.

**A restore reloads the page**, because logging alone left a player looking at
black tanks. Observed once and diagnosed from what survived: on a tank in third
person the barrel looked right and the body, turret and treads were all black --
and the barrel is the one part with **no texture**, a flat
`MeshLambertMaterial({ color: 0x333333 })`. So every textured surface was dead and
the only survivor was the one that never sampled anything. Wholesale, which is
the context-loss signature rather than one asset failing.

Three does clear its caches on restore and re-upload from `texture.image`, so why
these did not come back is **unresolved** -- and the reload makes it moot, which
is why the reload is the fix rather than a smaller repair nobody can verify. Once
per session and remembered across it: a driver that keeps taking the context away
would otherwise reload forever, which is worse than black tanks because it never
settles anywhere the log can be read.

### The HUD ignores the safe-area insets

Every panel positioned itself with `max(10px, env(safe-area-inset-*))`. They use
a plain `--hud-edge` now. On a phone in landscape -- 857x411 on the Pixel that
this was measured against -- honouring the cutout inset spends an edge of a
screen that has none to spare. A camera hole over a corner of the scoreboard is
the better trade: the panel keeps its size, and the covered part is still
touchable. `viewport-fit=cover` stays in the meta tag, because drawing under the
cutout is the point rather than an oversight.

One value for the same reason the sizes share one unit: the radar, the
scoreboard, the debug HUD and the chat cannot drift apart if they read the same
variable.

### Measurement knobs

URL parameters exist to tell costs apart on hardware nobody here owns, since a
player can be asked to load a link:

- `?renderScale=0.5` -- draw into a buffer that fraction of the window on each
  axis, presented across the whole window. Separates the pixels bzo draws from
  the surface the browser presents, which resizing the window cannot, because
  that moves both at once. It does nothing inside an XR session, where the
  framebuffer belongs to the headset rather than to the page.
- `?antialias=0` -- drop MSAA. Chrome carries a driver workaround saying MSAA is
  not acceptable on Intel GPUs, so its cost has to be measurable rather than
  assumed. An immersive session inherits the context's attribute for its own
  framebuffer, so this one reaches a headset.
- `?shadows=0` -- drop the projected shadow pass: the caster stencil draws, the
  darkening overlay and the per-frame projection.
- `?celestial=0` -- drop the sun and moon discs, which are three draws but large
  ones.
- `?xrRate=90` -- the cadence asked of the XR runtime through
  `updateTargetFrameRate`. bzo asks for 72 by default, the Quest's own rate; the
  knob is here because which rate is best is a measurement. A runtime asked for
  nothing picks one and reports `frameRate=0`, and whatever it picked is the
  rate its compositor runs at.
- `?xrScale=0.7` -- a fraction of the resolution the XR runtime recommends,
  through `setFramebufferScaleFactor`. It is a separate knob from `renderScale`
  because that one works through `setPixelRatio`, and the framebuffer a session
  draws into belongs to the headset: a sample taken in a session reports the
  headset's own resolution whatever the page asked for. Set before a session
  starts, since it is read when the session builds its framebuffer.

One URL parameter is not a measurement knob: `?follow=leader` is a feature, the
spectator link described in the Observer section. It is listed on the same page
because that page is what a URL can ask bzo for, and it follows the same rules
otherwise -- URL only, never persisted, never in the UI.

They are prototypes of settings bzo may one day pick from measurement, which is
the other reason to keep them. A knob added here follows the same rules: URL
only, never persisted, never in the UI, clamped on the way in, and **visible in
the log** -- `renderScale` and `xrScale` in `renderer.init.ok`, `antialias` in
`renderer.capabilities`. A knob a sample does not record is a knob that produces
data nobody can attribute later.

**Every knob goes on `public/test.html`**, which is the list of them as links,
one press each and Back to return. Typing a query string is not something a
player does on a headset, so a knob missing from that page is a knob that will
not be measured on the device that most needs measuring.

## Chat entry owns the keyboard, not the mouse

The chat panel sits along the bottom of the screen, which is exactly where mouse
control puts the cursor to drive backwards. So while chat is idle the panel is
click-through: only the tabs and the Send button take the pointer, and a click
anywhere else over it -- the input included -- fires the tank. **The Send button
is the only pointer that opens chat entry.** It is named Send rather than Chat
because the tab strip already spends that word on the Chat tab. Clicking the input must not,
because the input covers ground the player is aiming over.

Chat entry -- focus in `#chatInput` -- ends on Enter, Escape, or the Send
button, and nothing else. A click on the battlefield while typing is swallowed
with `preventDefault`, which is what keeps focus, and so keeps the keyboard, in
the input. Focus is the single source of that state: `setChatEntryActive` runs
off the input's own focus and blur, so no code path may set `chatActive` by
hand.

## Admins and the admin channel

Upstream reads `PlayerAccessInfo` out of a file keyed to a registered,
password-checked callsign. bzo's equivalent is a bzflag.org global login, and
`isAdmin` in `server.js` is the whole rule. It answers yes for either of two
things:

- **An authenticated player in an admin group.** The session is looked up from a
  cookie the server issued and the groups are what bzflag.org answered, so
  neither half is client-supplied. `adminGroups` in `server.json` names the
  groups; the session is re-read on every question rather than trusted from
  connect, because an 8 hour session can expire mid-game.
- **A connection from this machine, if the operator asked for it.**
  `"localAdmin": true` in `server.json`, off by default. It exists so a test
  client -- a headless browser, a raw WebSocket probe -- can drive the Operator
  panel and the server commands without a bzflag.org account.

  **The rule is not "the peer is loopback", and it must not be.** bzo does not
  terminate TLS, so a public deployment sits behind a reverse proxy, and a proxy
  on the *same host* makes every request in the world arrive from `127.0.0.1`.
  So `isLocalAdminRequest` in the `sessions` module wants a loopback peer **and**
  no `X-Forwarded-*` header at all. That second half is the one a remote client
  cannot forge: it can add a header but not remove one, and a proxy following the
  deployment notes in the README sets `X-Forwarded-For` on every hop with
  `RequestHeader set`, so a client's own copy never survives. A proxy that omits
  it entirely is the case this cannot see, which is exactly why an operator has
  to ask for this rather than get it by default. Every grant is logged.

Whichever way it is reached, it is checked on the server for everything it
guards. Today that is the admin channel and the Operator panel; `/`-commands are
the next thing behind it, and `docs/commands-plan.md` is the plan for them --
including why bzo should not port upstream's sixty permissions.

It is checked on the server for everything it guards:

- **The admin chat channel**, both ways. Upstream gates sending on
  `adminMessageSend` and receiving on `adminMessageReceive` (`bzfs.cxx:1546`,
  `:1745`), and answers a sender with no permission in its own words rather than
  dropping the message -- somebody typing into a channel nobody hears should be
  told. bzo says the same sentence.
- **The Operator panel's four messages** -- `getMaps`, `setMap`, `uploadMap`,
  `setOperatorConfig` -- each refused by `refuseNonOperator`. The client disables
  the Operator button for a non-admin, but that is presentation: a client can
  draw itself whatever it likes.

The client is *told* whether it is an admin, in `admin` on its own player state,
rather than deriving it. Authority questions are the server's alone in bzo, and a
greyed-out button is reading an answer rather than keeping a second copy of the
question.

**Chat destinations are small negatives**, because upstream spends reserved
PlayerIds on the ones that are not players and bzo spends ids on players alone:

| bzo | upstream | who sees it |
|---|---|---|
| `0` ALL | `AllPlayers` 254 | everyone |
| `-1` SERVER | `ServerPlayer` 253 | the server log only |
| `-2` TEAM | 251 and down | the sender's team, sender included |
| `-3` ADMIN | `AdminPlayers` 252 | every admin, sender included |
| a player id | the player id | that player and the sender |

An admin message is marked `[ADMIN]` and goes to the Chat tab, as a team message
goes there: upstream has no admin tab and neither does bzo. The ADMIN option is
hidden in the destination dropdown for anybody the server would refuse.

**Three message sounds, each on its own two-second clock.** Upstream keeps a
separate `static lastMsg` in each of its three branches (`playing.cxx:3260`,
`:3277`, `:3299`), so a team message does not silence the private one that
arrived beside it. All three only fire when somebody else sent it. A message from
the *server* is silent, which is upstream's default -- its private sound is gated
on `beepOnServerMsg`, a setting bzo does not ship.

### What a real login would look like

Not implemented, and recorded here because it is the one thing that would
replace `isAdmin` rather than dress it up. bzflag.org's global registration is
**two different token flows**, and only one of them suits a browser:

- **The one bzfs uses.** The client POSTs
  `action=GETTOKEN&callsign=&password=&nameport=` to `https://my.bzflag.org/db/`
  and gets back `TOKEN: <token>` or `NOTOK:`/`ERROR:`
  (`src/game/ServerAuth.cxx:37`), sends the token when it joins, and the server
  passes it to the list server as `checktokens=callsign@ip=token` riding on its
  `ADD` request, reading `TOKGOOD:`, `TOKBAD:`, `UNK:` and `BZID:` out of the
  reply (`ListServerConnection.cxx:118`). The client holds the player's global
  password to do this. **Not for bzo**: bzo's client is a web page, and a web
  page asking for someone's bzflag.org password is the thing the next flow
  exists to avoid.
- **The one for websites**, which is what bzo is. `misc/checkToken.php` in the
  upstream tree documents it: send the browser to
  `https://my.bzflag.org/weblogin.php?action=weblogin&url=<url-encoded callback
  containing %TOKEN% and %USERNAME%>`, let bzflag.org do the login, and verify
  what comes back server-side with
  `https://my.bzflag.org/db/?action=CHECKTOKENS&checktokens=<username>@<ip>%3D<token>&groups=<GROUP%0D%0AGROUP>`.
  The reply carries `TOKGOOD: <callsign>:<GROUP>:<GROUP>` and
  `BZID: <numeric id> <callsign>`. HTTPS both ways, a redirect the browser
  already knows how to do, and bzo never sees a password.

**The redirect half is confirmed working against bz.rikers.org**, 2026-09-08.
Sending a browser to

```
https://my.bzflag.org/weblogin.php?action=weblogin&url=https://bz.rikers.org?t=%TOKEN%:%USERNAME%
```

logs in at bzflag.org and lands back on
`https://bz.rikers.org/?t=700838849:Tim+Riker`. Three things that test settled:

- **Pack the values into one query parameter.** `%TOKEN%` and `%USERNAME%` may
  be placed anywhere in `url=`, but an unencoded `&` between two parameters
  belongs to `weblogin.php`'s own query string, not to the callback's -- so
  `...&url=https://bz.rikers.org?username=%USERNAME%&token=%TOKEN%` loses the
  token. Either url-encode the whole `url=` value, as `checkToken.php` says to,
  or carry both in one parameter with a separator, which is what the confirmed
  URL above does.
- **The callsign is form-encoded, so a space arrives as `+`.** Read the
  parameter with `URLSearchParams`, which turns `+` back into a space;
  `decodeURIComponent` does not, and would leave a player called `Tim+Riker`.
  A callsign may contain a space, so this is not a corner case.
- **The token is a ten-digit number** in practice, which matches upstream's own
  note on `TokenLen` -- "opaque string (now int(10))". Treat it as opaque
  anyway; the field is sized for 21 characters.

**The verify half is a live probe**, `/login` in
`server.js`, reachable from the "Global login probe" section of
`public/test.html`. It grants nothing and stores nothing: it redirects, reads
the token back, asks `CHECKTOKENS` about it, and prints the raw reply as plain
text and as `[LOGIN]` lines in the server log. One route serves both halves,
because the query string already says which is wanted: no `t` parameter is
someone who has not been to bzflag.org yet and gets the redirect, and a `t` is
bzflag.org sending them back. A `t` that is present but unusable is an error
rather than a fresh start -- redirecting on it would come back with the same
empty parameter, forever. What the probe has settled so far:

- **A real token verifies with no IP supplied**, which is the question the probe
  was built to answer. `CHECKTOKENS` echoes the request back as
  `MSG: checktoken callsign=… , ip=, token=…` -- the empty `ip=` is what
  omitting the `@<ip>` looks like from the far side -- and answers `TOKGOOD:`
  anyway. bzo can keep its AAAA record.
- **A bad token answers `TOKBAD: <callsign>`** and HTTP 200, so the status code
  says nothing -- the reply body is the whole answer.
- **Groups are answered only if asked about.** `&groups=` carries the names
  joined by an already-encoded CRLF, `%0D%0A`, as both `checkToken.php` and
  bzfs's own ADD write it, and membership comes back on the `TOKGOOD:` line
  after the callsign, colon separated:
  `TOKGOOD: Tim Riker:BBMODERATORS:BRYJEN.OPER:…`. Asking about 15 groups
  returned the 14 the player belongs to and dropped the one that does not
  exist, silently. So a group left out of the question, a group the player is
  not in, and a group nobody has ever created are one answer, and **the
  asked-for list is the whole permission model** -- there is no "tell me
  everything they are in".
- **The reply is colon delimited and the callsign sits inside it**, so a
  callsign containing a colon would be ambiguous. Upstream splits the same way,
  so bzo is no worse off than bzfs, but a callsign is not a safe field to parse
  around.
- **Key on the BZID, not the callsign.** The reply's last line is
  `BZID: 1037 Tim Riker` -- a small stable integer, and the callsign after it is
  a display name a player can change on the forum. Storing the name as the
  identity would silently transfer a permission on a rename.
- **A callback with a path works.** Confirmed with a 15-group list, a callback
  around 230 characters -- weblogin.php substituted the placeholders and
  returned to the path unchanged. That matters beyond the probe: the callback
  may carry only one *query* parameter, since a second would need an `&` that
  belongs to weblogin.php, so a real login's return-to and nonce have to travel
  in the path as the group list does.
- **The token lands in the browser's address bar and history.** The probe's
  reply is `text/plain` with no subresources, so nothing leaks it through a
  `Referer` header, but a real login should consume the token and redirect to a
  clean URL rather than leave it sitting in history.
- **Express decodes the callsign's `+` to a space** for `req.query`, so
  `t=1234567890:Tim+Riker` arrives as the callsign `Tim Riker`.
- **`res.redirect` cannot be used for the outbound leg.** It runs the URL
  through `encodeurl`, and a lone `%` is not a valid escape, so `%TOKEN%`
  becomes `%25TOKEN%25` and weblogin.php has nothing it recognises to
  substitute. The route sets the `Location` header itself.

**Where a session would live, once there is one.** Decided, not built. The
browser gets **one opaque value and nothing else**: 32 random bytes in an
`HttpOnly; Secure; SameSite=Lax` cookie. Every attribute -- the BZID, the
callsign, the group memberships, whether any of them grants admin -- stays in a
server-side record that the cookie is a key to.

The reason is that a player can write their own cookies and their own
`localStorage`, so anything stored there is attacker-chosen. That is harmless
only as long as the server never *parses* trust out of it but *looks it up*: an
invented id matches no record and is anonymous. A signed client-side claim -- a
JWT carrying the groups -- would break exactly this, and could not be revoked
either. `isAdmin` becomes a lookup against `adminGroups` at the moment an action
is checked, and the client is still only *told* the answer, for the reason given
above: a greyed-out button reads an answer rather than keeping a second copy of
the question.

A cookie is auto-sent and a WebSocket handshake is not subject to CORS, so an
attacker's page can open a socket to bzo and the browser attaches the victim's
cookie -- the value is never seen, and its randomness never comes into it. What
stops that is `SameSite=Lax`, which rides only top-level navigations and so
keeps the cookie off a cross-site upgrade. An `Origin` check is a second layer
rather than the only one, and it earns its five lines in two cases: a browser
old enough to predate Lax-by-default, and the day bzo is wanted inside another
origin's iframe, which forces `SameSite=None` and removes the first layer
entirely.

Every handshake is logged as a `[WS]` line -- `origin`, `host`, cookie *names*
only, scheme and user agent -- so the rule is written against what devices
actually send. So far: desktop Chrome and Firefox both send
`origin="https://bz.rikers.org"` matching the host, and a plain `ws` client
sends `origin=absent`. That is the rule to use -- **reject only when `Origin`
is present and does not match** -- since a non-browser client has no victim
cookie to borrow. Phone and headset browsers still need sampling.

Note the same lines show `secure=http`: the reverse proxy forwards
`x-forwarded-for` but not `x-forwarded-proto`, so `req.secure` is false and
nothing server-side should key on it. The browser leg is HTTPS regardless --
`Origin` says so -- and a `Secure` cookie is honoured by the browser without
the server needing to know.

The probe is unauthenticated, so anyone who finds it can make bzo send one
request to my.bzflag.org. That is acceptable for a probe on a dev server and is
a reason it should not survive as-is into anything that grants a permission.

What is left to build is a real callback and session -- and everything under
"what it would cost" below. The login form is not the part that needs designing.

What it would buy: a **BZID**, a stable numeric identity bzo could key
permissions to, and **group membership**, which is what upstream's
`PlayerAccessInfo` keys to -- so the admin gate would become a real question
with a real answer.

What it would cost, and why it is not a small change:

- The script's own rule is that the site **must** redirect the user to
  bzflag.org's form; login info arriving from any other form is rejected. So
  this is a page navigation, not a dialog, and bzo needs a callback route and a
  session of its own to survive the round trip.
- Identity has to be bound to the WebSocket, which is opened after the redirect
  is over. The verified BZID lives in bzo's session and the join has to present
  it.
- Tokens are single use and short-lived -- 22 bytes including the NUL
  (`TokenLen`, `global.h:33`), erased by bzfs the moment it has used one
  (`playing.cxx:5649`). Verify at the callback, then trust bzo's own session.
- **Do not send the IP in `CHECKTOKENS`.** The address is supplied by the site,
  not observed by bzflag.org: `checkToken.php` writes it into the query as
  `checktokens=<callsign>@<ip>%3D<token>`, and bzflag.org compares it with the
  address the token was issued to. Those two cannot match for bzo.
  `my.bzflag.org` is a CNAME to `my.bzflag.bzexcess.com`, which publishes **A
  records only**, so a browser reaches the login over IPv4 and the token is
  bound to its v4 address. `bz.rikers.org` publishes both, and a browser that
  can use IPv6 does -- `server.log` shows connects like `from 2607:fa18:…
  (via ::ffff:166.70.97.196) (x-forwarded-for)`. The token's address and the
  player's address are then different families, and no amount of
  forwarded-for parsing reconciles them.

  Upstream never meets this because released bzfs has no IPv6 either, so both
  legs are v4 by construction. bzo has a choice bzfs does not:

  - **Omit the `@<ip>`** -- `checkIP` false, in `checkToken.php`'s terms -- and
    keep IPv6. What still binds the token is that it is single use, short
    lived, and only ever handed to the browser that just authenticated, over
    TLS. This is the cheaper side of the trade.
  - **Drop bzo's AAAA record**, which makes both legs v4 and the check work as
    upstream intends. It costs IPv6 reachability, and it does not make the
    check reliable: a player behind CGNAT, a carrier proxy or a VPN can still
    change address between fetching the token and joining, which shows up as
    logins that fail for no visible reason.

  This is only about the token check. A list-server row cannot hold an IPv6
  address, but it does not need to: `bz.rikers.org` publishes both families, so
  a row would simply carry the v4 one. Keeping AAAA costs nothing there.
- Groups only come back if you ask for them by name, so bzo would have to name
  the group it treats as admin -- and getting a bzo group created is somebody
  else's permission. A BZID allowlist in `server.json` needs nobody's.

The wiki page for this (`https://wiki.bzflag.org/Global_Registration`) has been
read-only for years and carries none of the details above; the source and
`misc/checkToken.php` are the reference.

## Game types

Upstream names one of four game types per server (`include/global.h:94`) and
several rules read that name rather than re-deriving it. bzo has a switch only
for Rabbit Chase, and otherwise derives the type from the two questions it
already asks about a world -- so `getGameType` in the `teams` pair is
`RABBIT_SELECTION`, then colour teams, then bases, and `GAME_TYPE` in
`server.js` is what everything downstream reads.

`CTF_ENABLED` and `TEAM_MODE` stay the ones to ask about bases and about colour
teams, which is what most of their callers want. `GAME_TYPE` is for the rules
upstream writes in terms of the type as a whole: kill scoring, the forbidden
flag set, anointing, and `allowTeams`.

**`allowTeams` is not `TEAM_MODE.enabled`.** `bzfs.cxx:3334` is
`gameType != OpenFFA`: every type but OpenFFA has sides. Rabbit Chase has sides
-- the rabbit against the hunters -- while having no colour teams at all, so the
two questions come apart there and only there. `TEAMS_ALLOWED` is what every
`areFoes` call passes, and passing `TEAM_MODE.enabled` instead would make Rabbit
Chase a free-for-all in which nothing was ever a team kill.

Match end -- `-mps`, `-mts`, `-time`, `-timemanual` -- and the `Handicap` game
style are still missing; see `docs/game-modes-plan.md`.

## Rabbit Chase

`"rabbit": "score" | "killer" | "random"` in `server.json`, `-rabbit
[score|killer|random]` in a map's `options` block. One rabbit against every
hunter, upstream's `RabbitChase`.

- **Turning it on turns the colour teams off**, whatever the config or a map's
  `-c` asked for, which is `CmdLineOptions.cxx:1586` and is what makes Rabbit
  Chase and CTF mutually exclusive without a check for it. `resolveTeamMode` is
  where that happens, so there is one answer to "what teams does this world
  have"; the rabbit's limit is 1 and the hunters inherit the rogue limit, as
  upstream sets them. `colorTeamsRefused` is what the startup log reads.
- **Nobody picks a team.** `selectPlayerTeam` returns observer for an observer
  and hunter for everyone else (`bzfs.cxx:1923`), and a request for a colour
  team is read as "play" rather than refused -- which is why the join path skips
  its availability check here. Rabbit and hunter are in `ALL_PLAYER_TEAMS` and
  not in `PLAYER_TEAMS`, so the entry dialog cannot offer either.
- **Anointing** is `anointNewRabbit` in `server.js` over `pickNewRabbit`,
  `anointRabbit`, `canBeRabbit` and `getPlayerRanking` in the `teams` pair, all
  pure and all held against upstream's numbers in `scripts/test-teams.mjs`. It
  runs when the rabbit dies, self-destructs, pauses, leaves, goes to observer or
  rejoins, and whenever a player spawns while there is no rabbit. bzo's
  self-destruct is its own path rather than a call into `killPlayer`, so it says
  so separately -- upstream's suicide runs through `playerKilled` like every
  other death.
- **`-rabbit random` is not a fourth code path.** `Score::setRandomRanking`
  replaces the ranking with a random number and the selection runs unchanged, so
  the caller owns that choice and `anointRabbit` stays deterministic and
  testable.
- **Hunters are team mates.** Hunter-on-hunter fire *is* team killing, except on
  the rabbit and except for a deposed rabbit until its next spawn --
  `isARabbitKill`, over the `wasRabbit` flag set by `wasARabbit()` and cleared on
  the next spawn. That window is the whole exception. Team scores never move
  (`teamScoreMovesOnKill`); player scores work as usual.
- **`newRabbit`** carries the rabbit's player id or `null`, broadcast on every
  anointing and riding in `init` -- who the rabbit is is world state, not an
  event, so a client arriving mid-game has to be told. The client paints that
  player the rabbit and every other non-observer a hunter, as
  `playing.cxx:2851` does. bzo needs no client-to-server `MsgNewRabbit`: upstream
  sends one so a paused rabbit can refuse the post, and bzo's server already
  knows who is paused.

### Intentional deviations

- **Only the rabbit gets a reserved colour.** Upstream paints the rabbit light
  grey and every hunter orange; bzo keeps the per-player colours for hunters,
  because one colour for the crowd is exactly what hunter orange was for and
  bzo already has a better answer to it. The rabbit is the one thing in the
  world that has to be identifiable at a glance, so it is the one thing with a
  colour taken out of the pool -- and it is the one tank in bzo that wears a
  team's colour rather than its own, on your own tank as well, because being the
  rabbit is not a disguise.
- **The radar rings the rabbit rather than flashing it.** Upstream flashes the
  *hunted* blip cyan every fifth of a second (`RadarRenderer.cxx:136`) as part of
  its hunt feature, which bzo does not have -- Rabbit Chase wants the marker and
  not the feature. A steady ring in upstream's own hunt cyan, because a flash is
  half invisible on a client running at a low frame rate, which is the client bzo
  has to draw for. The blip inside it takes upstream's rabbit *radar* colour,
  white, which is the one place that table entry is used. Both go under
  Colourblindness, for upstream's reason: there every tank reads as rogue and the
  rabbit is not meant to be findable.
- **The ring is never on your own blip**, which is always dead centre and always
  you. Upstream marks only its remote players and clears the scoreboard's hunt
  state outright when the rabbit is you (`playing.cxx:2880`).
- **The scoreboard marks the rabbit's row**, including your own -- upstream's
  scoreboard hunt marker says "I have chosen to hunt this player", a viewer-side
  selection, while `(rabbit)` is a fact about the world. It replaces upstream's
  ten-second alert as the standing answer to "am I the rabbit".
- **The board is sorted by rank, not by score.** `newSortedList`'s default case
  (`ScoreboardRenderer.cxx:1003`) reads `getRabbitScore()` rather than
  `getScore()` on a Rabbit Chase world, so the order says who is next in line for
  the rabbit, and a `%` column in front of the score says it out loud
  (`:675`). The two rules agree often enough to hide the difference and then
  disagree: a player with no record ranks 0.5, above anyone whose *rate* is worse
  than even however far ahead they are on kills. `rank` is set on a row only on
  such a world, so its presence is the `allowRabbit()` upstream asks -- and
  `compareScoreboardPlayers` reads it rather than taking a mode, so the roaming
  leader cannot disagree with the top row.
- **XR reads both through the panels it already draws.** The XR radar panel is
  textured from the same canvas, so the ring arrives there on the same frame, and
  the XR scoreboard reads the same rows. The same ring marks the player's own
  team flags and the antidote, which is what an immersive session has instead of
  the heading tape; `docs/game-modes-plan.md` carries what a world-space bearing
  cue would add on top of it.

## One label for a player, however many surfaces write it

`formatPlayerLabel` in `hud.js` composes a callsign, the flag it carries and the
Rabbit Chase mark into one string plus `segments`. The scoreboard draws the three
as separate elements because it colours each; anything writing a line of plain
text -- an Identify alert today -- takes the composition from here, so two
surfaces cannot describe the same tank differently.

Upstream's Identify writes `<callsign> (<Team>) with <Flag name>`
(`playing.cxx:4488`). bzo names the team only where it says something: in Rabbit
Chase, where `(rabbit)` is exactly upstream's `(Rabbit)`. Every bzo player has a
colour of their own, so `(Rogue)` on every line of an OpenFFA server would be
noise, and the flag keeps the scoreboard's abbreviation rather than upstream's
full name because that is the form a player reads everywhere else in bzo.

**Alerts carry `segments` as chat lines do.** `setHudAlert` takes an optional
`[{ text, color }]`, a segment with no colour of its own inheriting the alert's,
and `text` stays the whole line so a renderer that ignores segments still draws
something correct. Both surfaces honour them: the DOM column builds one span per
run, and the XR panel draws run by run -- measuring the whole line first, because
that column is centred and there is no per-run alignment that adds up to a
centred line. Colourblindness still costs Identify its whole answer, not just the
name (`playing.cxx:4479`): naming the flag or marking the rabbit would hand back
what the colour no longer says.

## Server commands

A chat line beginning with `/` is a command. `handleServerCommand` in `server.js`
is asked **before any chat destination**, so such a line is either a command or
an "Unknown command" reply and is never said out loud, whichever channel it was
aimed at. The parsing and the formatting are in the `commands` module,
server-only; the table and what each command does are in `server.js`, beside the
roster and the clock they read.

Upstream makes each command a `ServerCommand` subclass carrying its name, one
line of help and a permission (`src/bzfs/commands.cxx`). bzo keeps the same three
per entry, with `help` in upstream's own wording where the command is upstream's,
and `tier` in place of the permission. `docs/commands-plan.md` is the plan for the
rest of the set, and says why bzo does not port upstream's sixty permissions:
they exist to be granted out of a users file bzo has no equivalent of, since its
groups come from bzflag.org and the server cannot edit them.

**Two tiers.** `COMMAND_TIER.OPEN` is anybody who has joined; `OPERATOR` is
`isAdmin`, which is the same gate as the admin channel and the Operator panel. A
refusal is upstream's own sentence, naming the command.

**The Operator panel stays the primary surface for anything an operator does more
than once**, because it is the one that works in a headset. Commands are for
one-offs, for questions, and for a test client -- which is what `localAdmin` is
for. Where both exist they must call the same function: `/msg` and the chat entry
both go through `deliverChatMessage`, so the admin channel's permission check
cannot exist in only one of them.

**`/mv` is bzo's own**, and the only command here upstream has no version of --
not in bzfs, not in any plugin, and no API call to move a tank either. bzo is
developed by driving it, and `testSpawn` in `server.json` already does this on
join; `/mv` is the same thing without a restart, which is why it exists.

**Not `/tp`.** That spelling is reserved: bzo has teleporters as named obstacles
with linked faces, and a command that named one would want it. Moving a tank to a
coordinate is a different thing.

Its coordinates are bzo's world coordinates, the ones `testSpawn` takes and every
log line prints: `+X` east, `-Z` north, `+Y` up. Two values are `x,z`; three are
`x,y,z`, the order the rest of bzo writes a position in, so the second value
never changes axis between forms.

A facing is **one of the eight compass points and nothing else** -- `n`, `ne`,
`e` and so on -- either in a fourth slot after all three coordinates, or as a
word after them. A number is deliberately refused: bzo's rotation runs
anticlockwise from north while a compass bearing runs clockwise, so `90` is
ambiguous in the one direction that matters and a letter cannot be misread.
`bearingToRotation` is that conversion, and the reply names the resulting facing
back so it is visible either way.

Height is the interesting part, and it is `dropSpawnPosition` -- the same
resolver `testSpawn` uses:

- **Given and clear**, it is honoured: `/mv 0,30,0` puts you thirty units up to
  watch yourself fall.
- **Given and blocked**, it climbs to the lowest surface above, so a coordinate
  inside an elevated obstacle comes out on the roof rather than stuck in it.
- **Not given**, it starts from the ground: `/mv 0,0` lands on the grass on
  `hix` and on top of the centre block on `fountains`.

The move goes out as a `positionCorrection` to the tank that moved -- that packet
already clears the air velocity, the jump state and the teleporter blocks on that
client -- and a plain `pm` to everyone else, which snaps the remote copy without
the teleporter sound a `pt` would play. The tank arrives stopped, and
`lastUpdate` is reset so the drift check does not integrate the old velocities
across the jump.

**`/me` is not dispatched as a command.** It is reformatted in the message path,
before the dispatcher, and upstream says why in its own comment
(`bzfs.cxx:1490`): *"this is here instead of in commands.cxx to allow
player-player/player-channel targeted messages"*. A dispatcher has already thrown
the destination away, so `/me` handled there could only reach one channel --
here `/me waves` works to ALL, to a team, to the admin channel and to one player.

**The wire carries a type, not the words.** Upstream strips `/me ` and sets
`ActionMessage` (`global.h:88`); bzo already had `msgType: 'action'` and a client
that renders it as `<name> <text>`, so `/me` added the entry point and nothing
else. Sending the literal `/me` text and letting each client parse it would mean
trusting the text -- which is the spoof upstream explicitly guards against three
lines earlier, refusing an inbound message shaped like its own rendered
`*text\t*` form. A typed field has nothing to forge.

`/me` with no argument answers upstream's sentence, and `/mefoo` is not `/me` and
falls through to the dispatcher -- upstream's *"don't intercept other messages
beginning with /me..."*. It is listed in `/?` for discoverability, which upstream
does not do because it has no `ServerCommand` for it.

### Intentional deviations

- **`/help` lists commands, not help pages.** Upstream's pages come from the
  files `-helpmsg` names, which `docs/bzw.md` already lists as not read, so there
  are no pages to page. bzo answers with every command the asking player may run
  and upstream's one line of help each. `/<prefix>?` narrows it, which *is*
  upstream's `CmdHelp` (`commands.cxx:476`) and the only per-command help either
  of us has -- bzo takes the `?` half and not the `/co*` run-the-one-match half.
- **`/serverquery` says `bzo Version:`, not `BZFS Version:`**, and adds the build
  id. Two bzo servers on the same release differ by that and by nothing else a
  player can see.
- **`/date` and `/time` are open**, where upstream spends a `date` permission on
  them. The server's clock is not a secret, and a permission per command is the
  model the plan declines.
- **`/set` reaches three settings, not all of BZDB.** Upstream's `/set` walks the
  whole database; bzo's world values are compiled-in constants, and the honest
  set is narrower still than a map's `-set`: it is what the Operator panel
  *propagates* to clients (`motd`, `shotMaxActive`, `ricochet`), because a value
  changed only on the server leaves every client predicting against the old one.
  Both the panel and `/set` write through `applyServerConfigChanges`, which
  validates, persists to `server.json`, applies and broadcasts as one
  transaction. `/set` with no argument lists them and says outright that
  everything else is a constant, rather than accepting a name and doing nothing.
- **`/me` is open to everyone.** Upstream gates it on an `actionMessage`
  permission and answers "you are not presently authorized to perform /me
  actions"; bzo has two tiers and an action is talking, so the mute check is what
  stops it -- a muted player gets the same refusal for `/me` as for anything else
  they try to say, which is the same place upstream's `talk` check sits.
- **A mute lasts the session.** Upstream revokes the `talk` permission out of a
  users file; bzo keeps a flag, with upstream's own sentence for the refusal
  ("We're sorry, you are not allowed to talk!", `bzfs.cxx:1667`) and upstream's
  own exception -- somebody who may still send on the admin channel does, which
  is what leaves a muted player a way to ask about it.
- **No client-local command table yet.** Upstream's client claims `/silence` and
  friends before the server sees them; bzo's client sends every line. That is
  step 4 of the plan, and it changes nothing about the above -- bzo's chat entry
  does not echo locally, which is why step 1 needed no client work at all.

## Team scores

In team mode the server keeps a score per colour team, exactly as bzfs does:

- `bzfs.cxx:3539` -- **only a free-for-all game scores team points for a kill.**
  In `ClassicCTF` a capture is the only thing that moves the team score, which
  is what makes a capture worth crossing the map for; upstream gates the whole
  per-kill block on `gameType == OpenFFA || TeamFFA`. `teamScoreMovesOnKill` in
  the `teams` pair is that gate, asked of `GAME_TYPE`.
- `bzfs.cxx:3540` -- when a kill does score, one win for the killer's team and
  one loss for the victim's; a kill inside a team only loses, two for a team
  mate and one for yourself. Rogues and observers score for nobody, either as
  killer or as victim.
- `bzfs.cxx:2377` -- a team's tally resets when its first player joins an empty
  team. Losing its last player does **not** reset it: `removePlayer` decrements
  the size and sends a team update, leaving wins and losses where they were, so
  a score outlives the team until someone joins it again. A map change restarts
  the process here, which is what resets the rest.
- `ScoreboardRenderer.cxx:341` -- the scoreboard shows `score (wins-losses)
  size` per team, sorted by score, skipping teams with nobody on them. bzo adds
  the team's name to that row; upstream relies on the row's colour alone.

The rule itself is `getTeamScoreDeltasForKill` in the `teams` pair, kept
pure so `scripts/test-teams.mjs` can hold it against upstream's without
a server around it. `MsgTeamUpdate` carries size, wins and losses per team
upstream; bzo sends the same fields as `teamUpdate`, and the same array rides
along in the `init` payload so a joining player starts with the current
standings.

## Audio

Gameplay samples live in `public/audio/` and come from upstream BZFlag
(`$HOME/bzflag/data/*.wav`), so bzo sounds like the game it mirrors;
`docs/audio.md` lists which sample answers which `SFX_*` code. The
manifest in `public/audio.js` maps each logical name to its file, its BZFlag
`SFX_*` code, and its distance/volume; `render.js` plays everything through
`playSound()` / `playLocalSound()` rather than bespoke per-sound methods.

All samples are preloaded by `preloadGameplayAudio()` during map entry. **Both
halves of the game ship from this repo, so the files are always present. Do not
add fallbacks for missing audio** -- a failed load is a broken build and should
surface as an error, not a silent degradation.

| bzo name | file | BZFlag SFX | event |
|---|---|---|---|
| `fire` | `fire.wav` | `SFX_FIRE` | a shot is fired |
| `shotBoom` | `boom.wav` | `SFX_SHOT_BOOM` | a shot expires or hits an obstacle |
| `laser` | `laser.wav` | `SFX_LASER` | a laser is fired |
| `shock` | `shock.wav` | `SFX_SHOCK` | a shock wave is fired |
| `thief` | `thief.wav` | `SFX_THIEF` | a Thief's beam is fired |
| `ricochet` | `ricochet.wav` | `SFX_RICOCHET` | a shot bounces off a building |
| `explosion` | `explosion.wav` | `SFX_EXPLOSION`, `SFX_DIE` | a tank is destroyed |
| `runOver` | `steamroller.wav` | `SFX_RUNOVER` | a tank is run over by a Steamroller |
| `jump` | `jump.wav` | `SFX_JUMP` | a tank jumps |
| `flap` | `flap.wav` | `SFX_FLAP` | a tank flaps its Wings |
| `land` | `land.wav` | `SFX_LAND` | a tank lands |
| `teleport` | `teleport.wav` | `SFX_TELEPORT` | a tank passes through a teleporter |
| `pop` | `pop.wav` | `SFX_POP` | a tank appears (spawn) |
| `flagGrab` | `flag_grab.wav` | `SFX_GRAB_FLAG`, `SFX_GRAB_BAD` | a flag is picked up |
| `flagDrop` | `flag_drop.wav` | `SFX_DROP_FLAG` | a flag is dropped |
| `flagWon` | `flag_won.wav` | `SFX_CAPTURE` | my team captured an enemy team's flag |
| `flagLost` | `flag_lost.wav` | `SFX_LOSE` | my team's flag was captured |
| `flagAlert` | `flag_alert.wav` | `SFX_ALERT` | an enemy picked up my team's flag |
| `teamGrab` | `teamgrab.wav` | `SFX_TEAMGRAB` | a team mate picked up an enemy team's flag |
| `killTeam` | `killteam.wav` | `SFX_KILL_TEAM` | I captured my own team's flag |

**Levels mirror BZFlag exactly, and there is no per-sound volume.** BZFlag scales
every sample only by distance and one global setting; the samples are pre-mixed
relative to each other, so adding per-sound gain undoes that balance. Its
attenuation, from `getWorldStuff()` in `src/bzflag/sound.cxx`, is
`amplitude = d < 86.4 ? 1 : 86.4 / d`, where `86.4` is 20 BZFlag tank radii
(`20 * 4.32`). That is the Web Audio `inverse` distance model with
`refDistance = 86.4` and `rolloffFactor = 1`, which reproduces the curve exactly.
The constant scales with the world, not the vehicle, so it stays `4.32` even
though a bzo tank has radius 2. Tune `MASTER_VOLUME` in `public/audio.js`, not
individual sounds.

Every remaining BZFlag sound is gated on a feature bzo does not have yet:
`bounce` needs a tank bouncing off a wall, `hunt`/`hunt_select` need hunting,
`message_*` need per-kind chat sounds, and `burrow`/`phantom` need the superflags
they belong to. When adding one of those features, take its sound from upstream
at the same time. The BZFlag sound codes are in `src/bzflag/sound.h`, resolved
through the `soundFiles[]` table in `src/bzflag/sound.cxx`.

## WebXR

- **An immersive session shows no DOM.** Anything the player must read or answer
  while in XR belongs on the `XRMenuRenderer` canvas panel, not in a dialog. The
  Player Options screen doubles as the entry dialog: before the player joins it
  is titled Join Game and carries name, team, and tank.
- **The launch grant has not been observed.** Meta documents an app-icon launch
  as counting for the user activation `requestSession` demands, but a Quest 2
  installed from the browser reports `navigator.userActivation` as
  `false/false` half a second into the launch and refuses the request.
  `public/xr-launch.js` runs ahead of `client.js`, on a module graph small
  enough to execute before three finishes loading, asks immediately, and then
  again on window load, focus, page show, visibility change, and the Launch
  Handler; `startXRSession` adopts whichever session results. Read
  `server.log` for the `Launch session:` line, which names the signal and the
  activation state at the time. Do not move that request into the client's own
  startup. When every signal is refused the player enters VR from the button,
  which is the whole fallback: **do not add one that reads a click on the page
  as a request for VR.** The flat window is a legitimate place to be -- chat,
  settings, a name typed on a real keyboard -- and the canvas covers most of it,
  so such a fallback fires on clicks meant for the game.
- **Leaving VR must not close the window.** An app launched from a headset icon
  has little use for the flat window behind the session, but a player asking to
  leave VR is asking for that window, not to quit. Nothing distinguishes the
  headset ending a session from the player ending one, so closing on either quit
  the app out from under Exit VR.
- **Text entry is the headset's system keyboard.** Focusing a DOM text field
  during a session raises it where the runtime offers one (`isSystemKeyboardSupported`,
  Quest Browser 26.1+). `#xrTextInput` exists to receive that focus, because a
  field inside a hidden dialog cannot take it and an off-screen field makes the
  page scroll. The keyboard sends no key events -- only the field's value is
  readable -- and each showing starts a new edit, so the first key replaces the
  whole value. Do not build an in-panel keyboard for a case the runtime covers.
- **Controller input is neutralized whenever `visibilityState` is not
  `visible`.** The system keyboard and the headset's own menus both report
  `visible-blurred`, and a stick left at full deflection behind either would
  drive the tank blind.

## Dev Workflow

- Install dependencies once with `npm install`.
- `npm run dev` starts `server.js` via nodemon, wrapped in a loop that brings it
  back if it exits; `npm start` runs it once, without auto-restart. Ctrl-C stops
  the loop.
- The server watches `public/` and `server.js`, forcing connected clients to
  reload on any `public/` change and restarting itself when `server.js` changes.
- Because `npm run dev` is used, edits to watched files usually restart or reload
  the running server automatically. **Do not start duplicate dev servers** unless
  explicitly asked.
- The development server is typically already running in GNU Screen session `0`.
- Gameplay logs stream to `server.log`, which is cleared on each server boot.
- **A quoted name in a log line is a player; do not also write "Player".**
  `"Orin" grabbed Shock Wave flag 12`, not `Player "Orin" grabbed ...`. The quotes
  are what identify it, and the word only makes every line longer. `Player 3` with
  a bare number is different and stays -- that is an id or a connection that has
  not given a name yet, where the word is the only thing saying what the number
  counts. This holds wherever a line names two players -- `[Voice] "t5810" (1)`
  reads as a player because of the quotes, and unquoted it reads as a word.
- **A team is in brackets, for the same reason.** `[ROGUE]`, as the join line
  already writes it, so `[CHAT] "t5810"->[ROGUE]:` needs no word "team" in it --
  the bracket is what says which of the two a name is.

## Checks and Tests

Run before proposing a change as done:

```bash
npm run check
```

That runs, in order:

| Command | What it covers |
|---|---|
| `npm run check:server` | `node --check server.js` |
| `npm run lint` | ESLint across server, `public/`, and `scripts/` |
| `npm run check:controls-docs` | README controls section matches the in-game help panel |
| `npm run check:shared-pairs` | Each `public/<name>.mjs` and `server/<name>.cjs` still agree |
| `npm run test:volume` | Audio level clamping, curve, formatting, and persistence |
| `npm run test:voice-volume` | Remote playback gain and the microphone gain stage |
| `npm run test:voice-channels` | Which players each channel pairs, both directions |
| `npm run test:input-context` | `InputContextManager` ownership rules |
| `npm run test:teams` | Team normalization, plus client/server parity |
| `npm run test:team-mode` | Server team-mode config and BZW `options` parsing |
| `npm run test:server-name` | Host-derived server name and document title |
| `npm run test:motion` | Tank motion resolution, plus client/server parity |
| `npm run test:shots` | Shot slot limits, plus client/server parity |
| `npm run test:flags` | Flag types and flight math, plus client/server parity |
| `npm run test:collision` | Obstacle geometry, fuzzed for client/server parity |
| `npm run test:capabilities` | WebGL capability detection and feature gating |

CI runs the same checks on pushes and pull requests, and additionally runs
`npm audit --omit=dev --audit-level=high` and a Node 18.19.1 / 24.19.0
compatibility matrix.

**Node is pinned to what Ubuntu 24.04 and 26.04 ship**: 18.19.1 and 24.19.0. Do
not upgrade it, and do not write code that needs a newer one. Note that CI's main
lint job runs on 24, so a check that passes on a local 18 has not been fully
tested -- `globalThis.navigator` exists on 24 and not on 18, and that difference
has already broken a release. Where a test has to reach for a browser global,
`Object.defineProperty` rather than assignment, so it works whichever Node owns
the name.

**`overrides.qs` in `package.json` is deliberate.** express 4.22.2 is the last
4.x and pins `body-parser` to `qs ~6.15.1`, which two moderate advisories cover
and which no 4.x release fixes; express 5 is the only upstream path and is a
breaking change. The override lifts qs to 6.16.0 inside express's tree, which is
a semver-minor bump. Drop it when express 4 ships a body-parser that allows
6.16, and re-run `npm audit`.

There is no automated browser or gameplay test. Manual play sessions remain the
regression check for rendering, prediction, and XR. Use
`docs/webxr-validation.md` for XR changes.

### Test against the running server

**A dev server is already running on port 3000. Use it.** Do not start a private
instance on another port to keep a test tidy. The point of the shared one is that
the user, a phone, and a headset are watching the same game: a scripted client
that joins it can be *seen*, which is most of the value of running it at all. A
private instance proves the code compiles and nothing more.

Test players appearing briefly on the scoreboard are expected and are not a
reason to move off it. Name them so they are obviously yours, and disconnect them
when the check is done. `scripts/headless-client.mjs` is the scripted client that
does this; see **Testing** below.

**To put a test player somewhere specific, use `testSpawn`.** `getTestSpawn` in
`server.js` matches one player by name and hands it a fixed `x`, `y`, `z` and
`rotation` instead of a random spawn:

```json
"testSpawn": { "name": "TestRogue", "x": 0, "y": 0, "z": 0, "rotation": 0 }
```

It is absent from `example-server.json`, so a real server never has one.

**The `y` you write is a hint, not the answer.** The coordinates are typed
against one map, so `rebuildTestSpawns` resolves each one against the geometry
that actually loaded, once, when the world loads -- upstream's
`DropGeometry::dropPlayer`, whose two branches both matter here: a clear point
falls to the highest flat top under it, and a point *inside* a building climbs to
the lowest flat top it fits on. A spawn at the origin on a map with a box there
lands on the roof, and the load says so:

```
Test spawn "Orin" dropped from y 0.00 to 10.00 at 0.00,0.00
```

`server.json` is never written back to -- the coordinates in it are what you
meant -- and a spawn with nowhere at all to stand is named on load, with that
player spawning at random instead. Watch for the roof you land on being under
something: on `fountains.bzw` the origin drops onto the box whose shock wave is
mounted on that very roof.

Do not
instead fake movement packets to walk a test player into place -- a live player's
moves are validated, so the server will reject the jump and correct it, and the
test then measures the anticheat rather than whatever it was written for. A test
that appears to pass because a random spawn happened to land nearby is worse than
one that fails.

An observer is the exception, and often the easier probe: its heartbeat is
unvalidated by design, so a scripted observer can be flown anywhere without a
`testSpawn` at all. Where a test needs a *tank* at a known spot relative to
something, it is usually simpler to read the tank's spawn out of the join
response and fly the observer to it.

`server.js` watches itself, `public/` and the loaded map, and restarts or reloads
clients on a change -- so it is already serving the working tree. It does **not**
watch `server.json`, so a new `testSpawn` needs the server restarted by hand, and
that interrupts whoever is playing. Undo the `testSpawn` afterwards.

## Committing

**Do not `git commit` or `git push` unless explicitly asked.** Make the changes,
run `npm run check`, and stop, leaving the working tree for the user to review
and play-test. Say plainly that the work is uncommitted.

The one standing exception is an explicit release request, below -- that is
itself an instruction to commit, tag, and push.

## Release Process

**The steps live in the README, under "Release process", and that is the only
copy.** Follow them there rather than repeating them here: this file and the
README both held the sequence once, they drifted, and the release that followed
the stale copy shipped a client reporting the previous version.

What is here is only what a maintainer reading the README does not need:

- **A release request is an instruction to commit, tag and push.** When the user
  says "release now" or "do/make a release", execute the README's steps end to
  end unless they explicitly ask for a dry run, prepare-only, or no-commit. This
  is the one standing exception to **Committing** above.
- **Do not wait for the release workflow to finish.** Pushing the tag completes
  the task; the result arrives by email. Stop at a concise confirmation of
  outcomes once the tag is pushed, and do not append optional follow-up
  suggestions.
- **The work itself gets its own commit before the release commit**, described
  the same way the README asks the release commit to be described.

## Debugging Tips

- **Client-side logging to server**: send debug messages from the client with
  `ws.send(JSON.stringify({ type: 'debug', message: 'your debug info' }))` and
  they appear in `server.log`. This is especially useful on headsets like Quest 2
  where browser console access is limited.
- **Do not `grep`, `tail`, or `cat` `server.log` for its contents.** It is always
  open in the editor as an addressable buffer, so read it with `read_file` and an
  offset. Repeatedly grepping it wastes tokens re-reading text that can be
  addressed directly. Cheap metadata commands are fine -- `wc -l` to watch it
  grow is useful.
- `server.log` is the primary runtime output surface during development. Assume
  it is already open and read it directly whenever runtime diagnostics are
  needed. Do not ask the user to re-open it.

## Testing

Three things to reach for, in the order they cost:

- **`npx eslint`** over what you changed, and `node --check server.js`. The
  pre-commit hook runs eslint with `--max-warnings=0` over staged JS, so a commit
  will refuse work that does not pass anyway.
- **`node scripts/check-controls-docs.mjs`**, which holds the controls list in
  `index.html` to the bindings in `input.js`.
- **`node scripts/headless-client.mjs`**, which joins the running server in a
  headless Chrome and reports every console error and uncaught exception. Chrome
  is installed and speaks CDP over a WebSocket, and `ws` is already a dependency,
  so there is no browser automation library to add and nothing to install. Give
  it `--shot /tmp/x.png` for a screenshot to look at, or `--eval '<expression>'`
  to read something out of the page:

  ```
  node scripts/headless-client.mjs --shot /tmp/bzo.png
  node scripts/headless-client.mjs --eval 'document.getElementById("playerName").textContent'
  ```

  It renders through SwiftShader, so it answers **does this draw without
  throwing, and what does it look like** and never **how fast is this**: a
  software rasteriser reports single-digit fps on a frame a GPU spends two
  milliseconds on.

  It defaults to `http://localhost:3000`, which is the running dev server, and
  joins it as a real player named `headless` -- see **Test against the running
  server** above, which is the rule it follows: do not point it at a private
  instance started to keep a test tidy, and let it disconnect when it is done.
  Use `testSpawn` to put it somewhere specific.

### Testing a flag with `maps/flagbuffet.bzw`

**That map exists for this.** It puts three of every flag in its own one-unit
zone at a known coordinate, so a flag can be put in a probe's hands on purpose
rather than waited for. A `zoneflag` slot is pinned to its type -- upstream's
`setRequiredFlag`, and `addFlag` never draws from the pool for one -- so it
always comes back as the flag its zone declared and repeated runs cannot exhaust
it, even with the map's `-set _maxFlagGrabs 1`.

**Point `testSpawn` at the zone.** `testSpawn` in `server.json` spawns a named
player at a fixed point, and a tank that spawns on a flag grabs it before it does
anything else. It takes one entry or a list of them, so moving a probe from zone
to zone does not disturb anybody else's fixed spawn -- add and remove the probe's
entry and leave the rest alone. The zone coordinates are in the `.bzw`, which is BZW's axes:
`bzo.x = bzw.x` and **`bzo.z = -bzw.y`**. `nodemon` watches `server.json`, so
writing it restarts the server on its own -- and **put it back when the run is
over**, since it is the running dev server's config and the name in it belongs to
somebody's real client.

**Or `/mv` there, which needs no restart at all.** `/mv` moves a tank anywhere
from the chat line, so a probe can put itself on a zone, pick the flag up, and go
somewhere else to use it -- all inside one `--eval`, with nothing written to
`server.json` and nobody else's spawn touched. It is the first thing to reach
for now; `testSpawn` is for the case where the tank has to *start* somewhere.

**`/flag drop [player]` is the other half of it.** A tank already holding the
wrong flag will not take the one it is parked on, and upstream has no way to take
a flag off a single player -- its `/flag up` sends every superflag in the world
away, which on this map empties the zone you are standing on. So `/mv` to the
zone you want and `/flag drop`, and the tank takes what is there. A sticky flag
is zapped rather than dropped, which is what dying with it does, so the command
cannot be used to plant a bad flag on somebody.

**A probe has admin, so the pair is the whole workflow: `/mv` to the zone you
want, then `/flag drop` to shed whatever you are already holding.** Reach for the
second half whether or not you meant to pick anything up. `flagbuffet` is wall to
wall flag zones -- the good ones on the inner loop at +/-40, the bad ones on the
outer at +/-80 -- and a probe driving anywhere across them collects flags by
accident. That is not a cosmetic problem: `O` Obesity and `T` Tiny resize the tank
box, so every collision height a run measures comes out wrong, and `BY` Bouncy
jumps the tank on its own, which reads exactly like a motion bug you did not
write. Two runs in this repo's history were thrown away to each of those. Drop
first, then measure -- and the empty ground past the rings, or the slope row
south of them, is where a motion test belongs in the first place.

```
say('/mv 40,0,25');   // x,y,z -- and `/mv 40,25` is x,z at y=0
say('/mv 61,12,80,e');  // x,y,z,facing, cardinals only
```

Three things about it that cost a probe time to rediscover:

- **The coordinates are bzo's, not the `.bzw`'s.** A zone at `position 40 -25 0`
  in the map is `/mv 40,0,25`, by the `bzo.z = -bzw.y` rule above. Two arguments
  are `x,z`; three are `x,y,z`; four add the facing. Passing `x,z,0,e` when you
  meant `x,0,z,e` puts the tank in the air at *y* = your z, which lands
  somewhere plausible and wastes the run.
- **It will not put a tank inside an obstacle.** The landing resolution lifts it
  to the surface above, which is the whole point of the command -- so to get a
  phasing tank *inside* a wall, move it onto the roof and let it sink through.
- **The flag on a zone is not guaranteed to be there yet.** Read the flag back
  (`#playerName` ends in `/OO`) and poll rather than trusting the pickup. Real
  players take flags, and both flag commands leave a gap: `/flag reset` does put
  a required flag back in its own zone -- `resetFlag` picks the position from
  `findFlagSpawnPosition` and re-adds it, because "required flags mustn't just
  disappear" -- but `addFlag` gives it a *flight*, so for a second or two it is
  in the air above the zone and a tank standing there has nothing to grab.
  `/flag up` is the same wait, and longer. So sit on the zone and poll the label
  instead of moving away and back. `/flag show` reports every flag's real
  position, but its output overflows the chat history on flagbuffet.

**Drive by the input module, not by events.** Synthetic `KeyboardEvent`s
dispatched from `--eval` do **not** reach the game -- dispatch the fire key and
no shot is fired. Import the live module instead:

```
node scripts/headless-client.mjs --name probe --seconds 4 --eval '(async () => {
  const input = await import("/input.js");
  input.setGameplayKeyState("KeyW", true);
  await new Promise(r => setTimeout(r, 4000));
  input.setGameplayKeyState("KeyW", false);
})()'
```

ES modules are cached, so that is the same instance `client.js` is reading, and
everything downstream of the key is the real code path.

**Chat needs a focus event raised by hand.** `/mv` and `/flag` are typed, so a
probe has to send chat, and two things stop the obvious code working. A headless
window is never focused, so `chatInput.focus()` raises no `focus` event and the
client never enters chat entry; and the Send button sends on `mousedown`, so
`click()` alone only toggles focus. Both together:

```
const say = (text) => {
  const input = document.getElementById('chatInput');
  input.dispatchEvent(new FocusEvent('focus'));
  input.value = text;
  document.getElementById('sendBtn')
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
};
```

The HUD keys are a plain `keydown` listener rather than gameplay input, so those
*do* answer a synthetic event on `document` -- `Minus` and `Equal` step the radar
range, which is how a probe puts something outside the panel to see it pinned to
the border.

**Measure from the server, not from the page.** Join a second raw `ws` client as
an observer and read the `pm` broadcasts: they carry `x`, `z`, `fs` and `rs` for
every other player, which is what the server actually believes about the probe.
Nothing inside the probe's own page has to be reachable, and the number under
test is the one the server acted on. Joining is one message --
`{ type: 'joinGame', name, team: 'observer', tankModel: 'bzflag' }` -- and
`queryPlayers` gets the id-to-name map.

**Three things that will waste a run:**

- **Do not spawn inside geometry.** A wedged tank sends no move packets at all
  and the run looks like the client is broken. On this map the platform box
  covers bzo `x` 60..100, `z` 60..100.
- **A probe with no flag grabs the first zone it drives through**, which is how a
  baseline run ends up carrying Super Bullet. A probe that already has one never
  grabs another (`if (getMyFlag()) return;`), so only the baseline needs a route
  that misses everything. bzo `z = 30` is the lane that does: the flag columns
  span `z` -35..25 and the rows sit at `z` +/-40 and +/-80.
- **Chrome takes the better part of a minute** to launch, load and join before
  `--eval` runs at all, so an observer window measured in seconds will close
  before the probe exists.

**For anything about frame cost, read `renderer.stats` in `server.log`** rather
than measuring here. Every client logs one ten seconds into a map, with the
`draws` breakdown, the frame phases and what the machine is. That is a real GPU
on a real client, which is the only place the question can be answered -- and it
is how a change like "the bases are one mesh now" is confirmed, by watching
`base:24` become `base:2` on somebody else's machine.

## Server Architecture (`server.js`)

- A single Express app serves static assets and hosts a `ws` WebSocket server
  that drives gameplay.
- The game loop (`setInterval(gameLoop, 16)`) updates projectile travel and
  collision checks. The server only *verifies* player `move` messages and never
  originates `playerMoved` messages itself; movement updates are broadcast only
  in response to client `move` messages.
- Player lifecycle: connection emits `init`, `newPlayer`, and `playerJoined`;
  `joinGame`, `move`, `shoot`, `pause`, and `chat` are validated server-side
  before broadcasting.
- Movement and shot validation rely on `GAME_CONFIG` thresholds and obstacle
  collision helpers. Keep new mechanics in sync with these checks.
- Map loading reads `server.json` to choose between procedural obstacles and
  `.bzw` files parsed by `parseBZWMap`. Add maps to `maps/` and update the config
  or use the operator panel to switch. `docs/bzw.md` documents what the import
  reads and what it drops.
- Admin/operator overlay messages share the WebSocket channel; reuse that pattern
  for additional operator tools.
- `forceClientReload()` broadcasts a `reload` message and closes sockets. It is
  exposed globally and triggered on `SIGUSR1` or watched file changes.

## Client Architecture (`public/`)

- `client.js` owns scene setup, Three.js assets, WebSocket handling, HUD
  orchestration, and per-frame prediction. Any protocol change must be reflected
  in its `handleServerMessage` switch.
- Input is centralized in `input.js`, which exports `setupInputHandlers`,
  `virtualInput`, and `keys` for desktop, mobile, gamepad, and XR controls.
- HUD helpers live in `hud.js`; extend those utilities rather than duplicating UI
  logic in `client.js`.
- Audio buffers are generated procedurally in `audio.js` for shooting,
  explosions, jumping, and landing.
- `styles.css` and `index.html` define HUD layout, mobile overlays, and the
  import map.
- The client connects back to the host that served it (`ws://<host>`, or
  `wss://` when the page is HTTPS). Never hardcode URLs, so the same build runs
  locally and in production.

## Configuration & Data

- Runtime settings (name, MOTD, default map, team mode, voice ICE servers) live
  in `server.json`; `example-server.json` documents the expected shape.

### The world carries the gameplay

`server.json` is gitignored; `example-server.json` is the tracked template copied
to it on first start. The two answer different questions, and the dev server's
`server.json` answers its one by holding **bzfs's own defaults** for every
gameplay switch a map can set: no jumping, no ricochet, one shot slot, no
superflags, and a bad flag shed only by dying. Those are `CmdLineOptions`'s
constructor values -- `maxShots(1)`, `numExtraFlags(0)`, `shakeWins(0)`,
`shakeTimeout(0)`, `gameOptions(0)` -- so reading that config tells you nothing
about how a given world plays, which is the point: it cannot, because the world
decides.

What makes the dev server worth playing lives in the world instead, where a bzfs
mapper would put it. `maps/hix.bzw` carries `-j`, `+r`, `-ms 5`, `-s 200`,
`-st 50`, `-sw 2` and `-sa`, each with a comment saying what it does, and that is
the file to edit to change how the dev server plays. Switching maps switches the
rules with them.

`example-server.json` is deliberately *not* aligned that way. A first start has
whatever map it names and nothing else, so it keeps bzo's two documented
deviations -- jumping on, 16 superflag slots -- and a fresh install is playable
without editing a map first.

Two settings cannot move to a world at all, because both are BZDB variables
reached only through `-set` and bzo does not read `-set`: `wingsJumpCount` and
`wingsSlideTime` stay in the config at upstream's `_wingsJumpCount` and
`_wingsSlideTime`. Raising the flap count to test `WG` means editing the config.
- `SERVER_CONFIG_PATH` overrides the config path; `MAPS_PATH` overrides the
  writable runtime maps directory.
- Obstacles are generated and resolved server-side and sent in the `init`
  payload. The client recreates meshes from that data, so keep the schema stable
  when extending obstacle properties.
- **Map scale**: `maps/*.bzw` use standard BZFlag coordinates at 1:1 scale. Box
  `x`/`y` in BZW are half-extents, which the parser multiplies by 2 to get full
  width and depth. 1 bzo unit = 1 BZFlag unit. `docs/bzw.md` has the whole
  conversion table and the keyword list.
- **Obstacle passability**: `drivethrough`, `shootthrough`, `passable` and
  `ricochet` are read per obstacle as upstream's `WorldFileObstacle::read` takes
  them, and honoured in `checkCollision`, `findShotObstacle`,
  `findShotSegmentImpact` and `traceShotStep`. The world border is built out of
  the first two rather than out of a special case: see `getWorldBorderColliders`.

## Conventions & Testing

- When adding network messages, document them in both the server switch
  statements and the client handlers, and update debug HUD counters if needed.
- The controls list currently exists in several places: the README "Controls"
  section, the help `<ul>` in `public/index.html`, `XR_HELP_ITEMS` in
  `public/client.js`, and the regex pairs in `scripts/check-controls-docs.mjs`.
  Only the first two are cross-checked. When changing a control, update all four.

## Persistent Project Decisions

- Operator controls are part of the single-page app and stay in-game. Do not
  reintroduce a separate `/admin` page for operator tools, because navigating
  away from the SPA drops active game state and the WebSocket connection.
- The old `/admin` server route was an abandoned experiment and has been removed.
  Keep future operator/admin UX inside the existing overlay/HUD flow unless the
  user asks for a different architecture.
- **Operator controls are gated on being an admin, and an admin is a player who
  typed a name.** See "Admins and the admin channel" below. It is a courtesy
  gate and not a security one; what makes it safe enough is that every
  privileged message is refused on the server, so a modified client that draws
  itself the Operator panel still cannot change the map. A real login may come
  later; `isAdmin` in `server.js` is the one function it would replace.
- The client should ALWAYS send valid data.
- The server checks are ONLY in place to detect modified clients.
- With unmodified client code, the server should never have to correct client
  actions.
- Project distribution is public by default: source code (AGPL), Docker images,
  release downloads/artifacts, and install endpoints stay publicly accessible
  unless the user explicitly requests a temporary exception.
- Deferred XR hand-control options are tracked in `docs/webxr-validation.md`
  under `Deferred TODO: Hand Controls`. Do not change current physical controller
  mappings unless cross-device compatibility requires it.

---

# Player Join / Entry / Scoreboard Flow

1. **Player connects to server**
   - Server adds them to the player list, but they have not yet joined (not
     spawned).
   - Server includes them in the `init` message to all clients with `health = 0`
     and a placeholder position (`x: 0, y: 0, z: 0`).
   - Server broadcasts `playerJoined` with `health = 0` and position (0,0,0).

2. **Client receives `init` or `playerJoined` with `health = 0`**
   - Adds the player to the scoreboard.
   - Creates their tank in the world, but sets `tank.visible = false`.
   - Shows their name and stats in the scoreboard, but no tank in the 3D world.

3. **Player sends `joinGame` (with their name)**
   - Server updates their player object with name, position, and `health > 0`.
   - Server broadcasts a new `playerJoined` for that player with `health > 0` and
     their spawn position.

4. **Client receives `playerJoined` with `health > 0`**
   - Updates the tank: `tank.visible = true`, updates position, name, and stats.
   - Scoreboard is already correct, but update if needed.

5. **Player leaves before joining**
   - Server sends `playerLeft` to all clients.
   - Client removes them from the scoreboard and world.

| Event | Scoreboard | Tank in World | Tank Visible | Notes |
|---|---|---|---|---|
| Connect (not joined) | Yes | Yes | No | `health = 0` |
| JoinGame | Yes | Yes | Yes | `health > 0`, set position |
| Leave (not joined) | No | No | N/A | Remove from all |

Notes:

- All connected players are always visible in the scoreboard, even if not joined.
- Tanks for unjoined players exist in the scene but are invisible.
- No need to remove and re-add tanks or scoreboard entries — just update
  visibility and state.

**This flow is project memory and should be followed for all future
join/entry/scoreboard logic.**

---

# World Coordinate System

Standard Three.js coordinates for the game world (top-down view):

- **+X = East** (right), **-X = West** (left)
- **+Z = South** (toward camera), **-Z = North** (away from camera)
- **+Y = Up**

Rotation `r`, player facing direction:

- `r = 0` → **North** (-Z)
- `r = π/2` (1.57) → **West** (-X)
- `r = π` (3.14) → **South** (+Z)
- `r = 3π/2` (4.71) → **East** (+X)

Movement vectors:

- Moving north: Z becomes **more negative** (-10 to -20)
- Moving south: Z becomes **more positive** (-10 to -5, or 0 to 10)
- Moving east: X becomes **more positive**
- Moving west: X becomes **more negative**

Examples:

- Position (30, -30): 30 units east of origin, 30 units north
- Position (50, 10): 50 units east, 10 units south of origin
- Intended vector (0, -5): moving north
- Intended vector (0, 5): moving south

---

# Movement Direction Vector (`d`)

**Status: IMPLEMENTED.**

## Problem

When sliding along obstacles or boundaries, the player's actual movement
direction differs from their rotation, but no packet is sent because `fs` and
`rs` do not change. That gives the server a stale position (incorrect hit
detection) and makes other clients extrapolate in the wrong direction (ghosting
through obstacles). It is most noticeable when sliding along walls or jumping
diagonally into obstacles.

## Solution

An optional `d` (direction) field on `move` messages, sent when actual movement
direction differs from expected direction.

Send `d` when:

- `validateMove()` returns `altered: true` (a slide occurred), and
- the actual direction from `(newX - oldX, newZ - oldZ)` differs from the
  expected direction by more than `0.01` radians.

Expected direction is `r` (rotation) on the ground, or `jumpDirection` (the
frozen direction) in the air.

```javascript
// Normal movement (no slide):
{ type: 'move', x, y, z, r, fs, rs, vv }

// Sliding movement:
{ type: 'move', x, y, z, r, fs, rs, vv, d: actualDirection }
```

Server handling: if `d` is present, use it for extrapolation instead of `r`;
validate it is reasonable (perpendicular to the collision normal when near
obstacles); store as `player.slideDirection`; broadcast `d` in the `pm` message.

Client extrapolation:

```javascript
const moveDirection = player.slideDirection !== undefined
  ? player.slideDirection
  : (player.jumpDirection !== null ? player.jumpDirection : player.r);
const dx = -Math.sin(moveDirection) * fs * speed * dt;
const dz = -Math.cos(moveDirection) * fs * speed * dt;
```

---

# WebXR

See `docs/webxr-validation.md` for the manual validation checklist and
`docs/settings-dialog-plan.md` for the dialog/menu architecture and its current
status.

## Modules

`webxr.js` owns XR session and controller management:

- `initXR()` — detects support via `navigator.xr.isSessionSupported('immersive-vr')`
- `toggleXRSession(renderer, animationCallback)` — creates/ends the session
- `updateXRControllerInput()` — reads gamepad data from input sources each frame
- `getXRControllerInput()` — returns thumbstick/trigger/button state
- `xrState` — enabled flag, head pose, controller map

Integration points:

- **`render.js`** — renderer created with `xrCompatible: true` and
  `renderer.xr.enabled = true`; `getRenderer()` exposes it; `updateCamera()`
  handles XR first-person positioning.
- **`input.js`** — `updateVirtualInputFromXR()` maps controller input into
  `virtualInput`, gated by the active input context.
- **`client.js`** — calls `initXR()` on `DOMContentLoaded`,
  `updateXRControllerInput()` each frame before input handling, and drives the XR
  settings menu screens.

## Controller mapping

| Input | Effect |
|---|---|
| Either thumbstick up/down | Forward/backward movement (right stick preferred) |
| Either thumbstick left/right | Tank rotation (right stick preferred) |
| Either trigger | Fire, or activate a menu row |
| Either primary face button (A/X) | Drop the carried flag, or activate a menu row |
| Either grip or secondary face button | Jump / menu back |
| Press either thumbstick | Open or close XR Settings |

Tank rotation is independent of head direction. Three.js positions the camera for
stereo rendering and head tracking automatically.

## Future work

Phases 1 and 2 (head tracking, joystick input, trigger firing) are implemented.
Remaining, none of which are current priorities:

- Hand tracking. Tracked in detail under `Deferred TODO: Hand Controls` in
  `docs/webxr-validation.md`.
- Controller haptic feedback.
- Voice commands in XR.

## XR coordinate system mapping

**Problem:** in XR mode Three.js ignores manual camera positioning and uses the
XR reference frame, whose origin is the tracked head position. Game objects
positioned relative to the tank become unreachable.

**Solution:** a `worldGroup` (Three.js `Group`) contains all game content.

1. `renderManager.worldGroup` is a group in the scene holding all game objects.
2. Add tanks to `renderManager.getWorldGroup()` rather than to the scene.
3. `updateCamera()` checks `xrState.enabled`. In XR it translates `worldGroup` to
   `(-tankX, -tankY + eyeHeight, -tankZ)`, effectively placing the tank at the XR
   origin. Otherwise `worldGroup` stays at (0,0,0) and the camera moves normally.
4. Result: the same world appears the same from the player's perspective in both
   VR and desktop.
