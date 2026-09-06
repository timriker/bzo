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
  whether a tank may be hit.

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
  so that tradeoff does not apply. **Implement upstream's default variant and
  no setting.** Add a toggle only when a measured frame-rate impact justifies
  it, not for parity with the upstream options list.

  Render levels chosen from the hardware -- a low/balanced/high policy, scaled
  pixel ratio, budgeted effects -- are wanted **eventually**, and are not ready
  now. Nothing here has been measured on the machines that matter, and a policy
  built on guesses is worse than none: it hides the cost it claims to manage.
  Frame *interval* in particular is not the measurement to build on, since a
  vsync-limited client reports its refresh rate however much headroom it has.
  Land the measurements first.
- **Tanks are selectable OBJ models, not one compiled-in model.** BZFlag ships a
  single tank in `src/geometry/models/tank/` at three LODs, varied only by the
  `animatedTreads` and `treadStyle` settings. bzo loads several models from
  `public/obj/` and lets the player choose; `docs/tank-model-format.md` defines
  the part-naming contract, which keeps upstream's `body`/`turret`/`barrel`/
  `ltread`/`rtread` names. The death explosion throws the tank's own parts, so
  it differs from upstream's as a consequence. Accepted for now -- do not report
  the model set or the explosion as parity gaps.

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

- **Superflags are on by default.** bzfs needs `-s` before a world has any
  superflags at all. bzo defaults `superFlags` to 16 slots drawn from every
  superflag in the shared `flags` table, so the feature is not invisible
  without editing `server.json`.

- **Jumping is on by default.** bzfs needs `-j` before any tank can jump; bzo
  has had jumping since before there was a switch, so `jumping` defaults to on
  and `jumping: false` in `server.json` is what turns it off. The rest follows
  upstream: a map's `-j` can still turn it back on, exactly one of `JP` and `NJ`
  is ever in the flag pool -- `JP` forbidden while jumping is on, `NJ` while it
  is off -- and `WG` never consults it. See `docs/flags-plan.md`.

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

### Known duplication (do not add more)

`server.js` and `public/client.js` still each carry their own copy of:
`checkCollision`, `getCollisionColliders`, `getWorldBorderColliders`,
`getBoxCollisionDistanceSquared`, `normalizeAngle`, `rotateXZ`,
`getSegmentBoxEntryTime`, `getShotTeleporterDims`, `getShotTeleporterCrossing`,
`transformShotThroughTeleporter`, `traceShotThroughTeleporters`. Several have
already drifted. When touching any of them, change both sides in the same edit;
the fix is to move each into the `collision` pair, matching upstream
BZFlag, with fuzz coverage -- as the pyramid path already has.

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

Textures come from `$HOME/bzflag/data/` into `public/textures/`, and belong in
the map-entry preload list in `public/client.js`. Effect timings are hardcoded
constants upstream, so keep them as constants here, each annotated with the
upstream line it came from.

## Radar colours

BZFlag keeps a second colour table for the radar (`Team::radarColor`,
`Team.cxx:30`), lifted from the tank colours so a team reads against a dark
panel. bzo uses it for **flags** -- `getFlagRadarColor` -- and not for tank
blips, which keep the colour the server assigned the player: bzo gives every
player a colour of their own, which upstream has no equivalent of and no radar
entry for. Do not "fix" that -- telling two team mates apart on the radar is
the same job as telling them apart at a distance in the world, and the blip is
the easier of the two to read a colour off.

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

`docs/flags-plan.md` is the design and staging plan: what upstream does, the
data model, the protocol, which phase each piece belongs to, and the full list
of the superflags still missing. Read it before extending flags. Phases 1 to 3
and 9 are implemented -- the Useless superflag with its flight animation and drop
key, team flags and capture, Identify, and Ricochet -- along with the jumping
switch, its three flags (`JP`, `NJ`, `WG`) and all three of upstream's ways out
of a bad flag. Phase 4's own four flags, phases 5 to 8, and 10 onward are not.

**A flag needs an answer in XR before its row is added.** bzo ships one client
for desktop, mobile and the headset, so a flag whose effect is a desktop-camera
or 2D-HUD trick -- `WA` Wide Angle is the type case -- is held back and given its
own XR design rather than shipped doing nothing in VR.

**The `FLAG_TYPES` table holds only the flags bzo implements.** Adding a row is
the last step of implementing a flag, not the first: the row is what puts the
flag in `superFlags.allowed`'s default and in the help panel, which
`buildFlagHelp` generates from the same table. An unimplemented row would be a
flag in the world that lies about what it does, and a help entry promising it.
The plan is the list of what is missing; the code is not.

The shape of it: the server owns every flag and sends the whole flight with the
event that starts it, and the client integrates that arc locally, exactly as
`FlagInfo::dropFlag` and `World::updateFlag` split the work upstream. There is no
per-frame flag packet, and no clock sync -- the client advances `flightTime` by
its own frame delta from the value the server sent. Grab, drop, and (later)
capture are all client-initiated and server-validated, which is the same
arrangement bzfs uses.

Flag ownership lives only in the server's `flags` array. Do not add a second
copy on the player.

A client's *knowledge* of a flag's identity is separate, because bzfs reveals a
superflag's type only while somebody is holding it: `rememberFlagIdentity` in
the flags pair keeps what each client has learned, and the debug labels draw an
identified flag's abbreviation over it. The memory is keyed by flag index, which
is a slot rather than a flag, so it is forgotten when the slot's flag leaves the
world.

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
the heading tape and the sound listener all read that transform and so follow the
camera without knowing roaming exists. **Nothing draws that mesh** -- not the
tank, not its server-position ghost, which hangs off `worldGroup` rather than off
the tank and so has to be hidden separately.

**An observer sends a heartbeat and nothing else.** Upstream does the same:
`sendObserverHeartbeat` (`playing.cxx:7415`) gates a normal player update behind
`observerHeartbeat`, default 30 seconds. bzo sends one every
`MAX_UPDATE_INTERVAL`, the same 5 seconds a driving tank uses as its own
heartbeat, because the nearby voice roster reads the position and 30 seconds is
too coarse to place a voice.

The packet carries a position and a heading. **Every velocity is zero**, so
neither end dead reckons a camera -- there is no prediction to run and none to
correct, and the position is five seconds stale at worst. The server takes it as
sent: `applyObserverHeartbeat` checks only that the numbers are numbers, since a
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

### The acceleration check cannot see the stick

`fs` and `rs` in a move packet are not the client's input. `updateMovement` in
`client.js` derives them from the *resolved* displacement of the last single
frame, after collision, so they are a measurement of where the tank got to and
not a statement of where it was asked to go. Two things follow, and both have
already been got wrong once:

- **The server cannot tell which acceleration rate applied.** The client picks
  deceleration from the desired input, which is not on the wire. The server
  therefore allows the fastest rate any stick position could have produced.
  Anything tighter refuses a tank that is merely letting go of a key, because
  both decelerations are faster than their accelerations.
- **A speed change caused by geometry is not bounded by the tank's limits.** A
  tank sliding along a wall reports whatever the collision resolver left it,
  which can swing across the whole range in one packet while the input holds
  steady. The acceleration model has no term for this.

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
`SHOT_RELOAD_TIME` the same way, after the `server.json` overrides are applied,
so changing `shotMaxActive`, `shotSpeed`, or `shotDistance` keeps the relation
intact. With the defaults and five slots that is 700ms.

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
Ctrl+W, Cmd+Q and Alt+Left pass straight through. Escape is deliberately left
alone -- a browser will not let go of it, and it also leaves pointer lock.

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
gamepad shoulders, and the XR B button arrive. See the Observer section.

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

## Team scores

In team mode the server keeps a score per colour team, exactly as bzfs does:

- `bzfs.cxx:3540` -- a kill across teams wins one for the killer's team and
  loses one for the victim's; a kill inside a team only loses, two for a team
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
| `ricochet` | `ricochet.wav` | `SFX_RICOCHET` | a shot bounces off a building |
| `explosion` | `explosion.wav` | `SFX_EXPLOSION`, `SFX_DIE` | a tank is destroyed |
| `jump` | `jump.wav` | `SFX_JUMP` | a tank jumps |
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
`bounce` needs a tank bouncing off a wall, `thief` needs the Thief flag,
`hunt`/`hunt_select` need hunting, `message_*` need per-kind chat sounds, and
`laser`/`shock`/`missile`/`burrow`/`phantom`/`steamroller`/`lock` need superflag
effects. When adding one of those features, take its sound from upstream
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

It is absent from `example-server.json`, so a real server never has one. Do not
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

Full steps also live in the README. When the user says "release now" or "do/make
a release", execute this end to end unless they explicitly ask for a dry run,
prepare-only, or no-commit. After completing it, stop at a concise confirmation
of outcomes; do not append optional follow-up suggestions.

```bash
npm run release:prepare -- 1.0.37
```

That updates `package.json`, `package-lock.json`, `public/version.mjs`, and opens
a new `CHANGELOG.md` section from `[Unreleased]`.

Then edit the new changelog section so it contains the real user-visible changes,
and validate:

```bash
npm run check
npm run release:check -- v1.0.37
npm run release:check:increment -- v1.0.37
```

Then commit, tag, and push:

```bash
git add package.json package-lock.json public/version.mjs CHANGELOG.md
git commit -m "Release v1.0.37"
git tag v1.0.37
git push
git push origin v1.0.37
```

`.github/workflows/release.yml` then gates on: tag commit is on `main` →
`npm run check` → `npm audit` → release metadata → tag increment → CodeQL →
Node 18/24 compatibility → multi-arch Docker build and smoke test → GHCR tag
promotion → GitHub release with notes extracted from `CHANGELOG.md`.

**Do not wait for that workflow to finish.** Pushing the tag completes the
release task; the workflow result arrives by email. Stop at a concise
confirmation once the tag is pushed.

**A release that fails its workflow is left alone.** bzo is in development and
not every tag produces artifacts. Fix the cause and move to the next version --
do not delete or move a published tag, and do not backfill a GitHub release for
one that never built. `CHANGELOG.md` is the record either way, and it already
carries the section for the version that failed.

- Release tags are stable `vX.Y.Z` SemVer only. Prereleases and build metadata
  are not published.
- `public/version.mjs` is written by `scripts/prepare-release.mjs` and verified
  against the tag by `scripts/check-release.mjs`. Do not edit it by hand, and do
  not reintroduce a hardcoded client version string elsewhere.

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
  or use the operator panel to switch.
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
- `SERVER_CONFIG_PATH` overrides the config path; `MAPS_PATH` overrides the
  writable runtime maps directory.
- Obstacles are generated and resolved server-side and sent in the `init`
  payload. The client recreates meshes from that data, so keep the schema stable
  when extending obstacle properties.
- **Map scale**: `maps/*.bzw` use standard BZFlag coordinates at 1:1 scale. Box
  `x`/`y` in BZW are half-extents, which the parser multiplies by 2 to get full
  width and depth. 1 bzo unit = 1 BZFlag unit.

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
- During development it is intentional that any connected player may use operator
  controls such as map switching. OAuth or stronger authorization may come later
  but is not a current priority.
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
