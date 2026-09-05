# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and versions use SemVer tags like v1.0.0.

## [Unreleased]

## [1.0.62] - 2026-09-05

### Fixed
- Anti-cheat `warning` mode still blocked. Only the two drift checks respected the mode; the collision check, the jump check, the shot checks and the flag grab, shake and capture checks refused the packet in every mode, and the acceleration limit quietly replaced the client's reported speed with the server's. So a mode whose whole purpose is to leave the game alone and write the disagreement down was rubber-banding honest players, swallowing their shots and eating their jumps -- and each of those divergences went on to generate drift warnings of its own, burying the one line that said what actually went wrong. Every rejection now routes through one `reportCheat` function that counts the finding, logs it with `REFUSED` or `ALLOWED`, and returns whether the caller must refuse; in `warning` the answer is no. The collision check also ran in `disabled` mode, which is now the one mode that does not look.
- A move or shot packet carrying a non-finite number was accepted. `NaN` fails every threshold comparison, so the drift checks passed it through and the stored position, rotation or velocity became `NaN` along with every extrapolation made from it afterwards. Malformed packets are refused in all three modes and logged as `MALFORMED`; they are not anti-cheat findings, because nothing about them is a judgement call.

### Changed
- A dropped flag launches from where the tank actually was, dead-reckoned like every other position the server judges. It read the stored position, which between packets is out of date by construction -- and worst in the air, which is where flags are most often dropped: the client sends nothing between takeoff and landing, since the heartbeat is gated on being on the ground and vertical velocity is extrapolated rather than reported. A tank shot down at the top of a jump therefore dropped its flag from the height it took off at, so the flag launched from the floor and landed under the tank instead of arcing down from it. Past a whole jump of silence the server stops believing its own extrapolation and uses the stored position, since a connection that stopped sending still carries whatever speed it had. Upstream takes this position from the client instead (`sendDropFlag` packs `myTank->getPosition()`, and `bzfs.cxx:3745` clamps it only to the world bounds); bzo reaches the same place without trusting the client for it, and the wire format already matched -- the drop broadcast carries the launch, the landing and the flight, as `flag.pack` does.
- The acceleration check allows the fastest rate any stick position could have produced, instead of picking a rate from the speed the client reported. The client chooses deceleration by the *desired* input (`updateMovement`), which is not in the packet -- what is in the packet is the speed the tank actually reached, and a tank coasting to a stop reports non-zero speeds all the way down. So the server read every key release as an acceleration and refused it at the slower rate, and since both decelerations are faster than their accelerations (2.5 against 1.8, 4.0 against 3.0), letting go of a key was always a finding. Two thirds of the warnings in a six-minute session were this, landing exactly on the deceleration rate: 0.25 in 0.100s, 0.47 in 0.117s.
- Move packets carry `sdt`, the interval the client took to get from the last packet's speeds to these ones, and the acceleration check uses it. `dt` was already sent but measures one frame -- the window `fs` and `rs` were sampled over, not the window they changed over -- and the server was using its own gap between arrivals, which is the send interval plus network jitter. When jitter shortened it an honest ramp looked impossible; that was most of the remaining warnings, all within 15% of the limit. `sdt` is a client-asserted input to a cheat check, so it may only widen the window and only by 0.25s.
- Anti-cheat warnings are counted per kind -- collision, paused, speed, shot, jump, flag -- and the five-minute summary and the disconnect line list whichever kinds actually fired instead of naming two of them.

## [1.0.61] - 2026-09-05

### Changed
- The second team on a map is founded across from the first. Upstream picks evenly among the teams that tie (`autoTeamSelect`, `bzfs.cxx:1902`), and with one team down and three empty, two of the three are neighbours -- so the team across the map came up only a third of the time and two players testing landed beside each other more often than not. That one choice is weighted by the squared distance between the two teams' bases, which on a map with its bases at the compass points makes the far team exactly twice as likely as either neighbour: 50/25/25. Which team is across from which comes from the bases rather than from the team numbering, since that is a property of the map. Only that choice is weighted -- once two teams are populated there is no single team across the map, a player joining teams that already exist is picked as upstream picks, and a map with no bases falls back to the even pick.

## [1.0.60] - 2026-09-05

### Fixed
- The on-screen fire and flag buttons do nothing on anything but a phone. The condition deciding whether to read the virtual input was written three different ways and only the driving one accounted for the controls being turned on deliberately, so turning them on gave a jump button that worked beside two that did not. All three share one predicate now.
- Toggling Virtual Controls, and Wireframe, leaves the settings row reading its old value. Those buttons stop their own click propagating, so the menu never sees it and never re-reads the row; both now tell it, as Mouse Control always has.
- The altitude tape is not attached to the targeting box. Its offset was a fixed 40px against a width in `4vmin`, so the two only agreed at one screen size: on a 1920x1080 desktop the tape sat against the box, and on a 857x411 phone a 24px gap opened. Both terms are the box's own unit now.
- The chat tabs fall off the top of the chat window on a short screen. The window packs to its bottom edge and hides its overflow, and the message area's six-line minimum meant it would not shrink, so the tabs were pushed out. Six lines is a ceiling now rather than a floor: a tall screen still fills to six, a short one shows fewer and keeps its tabs.

### Added
- The scoreboard's title carries the colour your tank is drawn in and the flag you are holding, in the shape upstream writes them -- the name, then "/", then the flag's abbreviation, with the colour changing at the slash and no space between (`ScoreboardRenderer::drawPlayerScore`). Both were otherwise readable only by finding your own row, and the colour is worth having to hand now that team mates are shaded apart rather than sharing one team colour. Clicking the flag opens Settings as clicking the name does.
- Settings closes from its heading like every other dialog. It had only a Close row at the foot of its menu, and the operator panel centred its close button beside the heading while help and audio put theirs against the right edge; the four share one layout now. Settings keeps its Close row as well, because in XR the menu is rendered as rows and the heading's button is not one of them.

### Changed
- The HUD takes its sizes from the scale upstream uses for its own -- `min(width/256, height/192)`, which bzo already had for the targeting box -- rather than from width breakpoints. A phone held in landscape is 857x411: wide enough to miss every rule meant for a small screen and short enough that none of them would have been wrong. Sizes are clamped, because upstream is scaling geometry and this is scaling text; the ceilings are what a desktop already had, so nothing changes there, and between the bounds the HUD follows the screen continuously.
- The HUD ignores `env(safe-area-inset-*)`. Honouring the camera cutout spends an edge of a screen that has none to spare, and a hole over the corner of a panel is the better trade -- the panel keeps its size and the covered part is still touchable. The margins that remain share one value, so the radar, the scoreboard, the debug HUD and the chat cannot drift apart.
- Settings is only as wide as its widest row. It shared one width with the dialogs that hold prose or a form, and a column of short label-and-value rows stretched to 820px was mostly gap.
- The settings rows centre at every width. A narrow-screen rule let the value column shrink to its content and handed the label all the slack, which with a right-aligned label pushes the pair to one side and piles the empty space on the other.

## [1.0.59] - 2026-09-05

### Fixed
- Shadows point straight down and never move when Dynamic Lighting is off. `setWorldTime` returned early on that setting, so the sun kept the `(0, 1, 0)` a `DirectionalLight` is born with -- a permanent noon -- and the sun and moon were removed from the sky as well. Neither belongs to that setting: what fragment uniforms constrain is a scene full of point lights, not one directional sun, and the sun is what the sky, the day cycle and the direction of every projected shadow are read off. The lights a shot, an explosion and a jump jet add are still gated by it, which is the cost the capability is about. (Shipped in this release but missing from its notes.)

### Added
- Team mates are shaded apart within their team's colour. Upstream gives every tank on a team the one colour (`Team::getTankColor`, `Team.cxx:30`) and has nothing per player; bzo already gave every player a colour of their own outside team mode, and the radar already drew blips in whatever the server assigned, so this narrows that same picker to a band around the team colour with only team mates to stay clear of. Two red tanks are told apart at a range where the labels are unreadable, and a red tank is still unmistakably red: the hue spread is bounded by the closest pair of team colours, red and purple, and `test:team-mode` asserts that against the colour table rather than trusting a comment. Nothing is rebalanced when a player leaves -- the gap they free is the one the next joiner is most likely to take, and a tank that changed colour mid-match would undo the only thing the shade is for.

### Changed
- A box is two draw calls, a pyramid two, and every one of them in the world is now drawn from a single merged mesh. Upstream collates the faces of one mesh that share a material into a `MeshFragSceneNode` (`MeshSceneNodeGenerator.cxx:206`); bzo collates the same way but across obstacles rather than within one, because a draw call costs far more here than it does there -- 24 to 30 microseconds on the low-power client this is measured against, with the GPU idle. On `hix.bzw` the 58 boxes and 60 pyramids were 236 draws plus 118 more for their shadows; they are now two meshes, four draws and two shadows. Bases and teleporters stay out, which is upstream's rule as much as ours: one carries a team colour and a hidden face, the other animates.
- A flag's arrival warp is built the first time it warps. A world of 200 flags carried 1600 discs that drew nothing but still had a matrix composed for each of them, twice a frame.
- Boundary walls no longer build the face that points away from the arena, so backing a tank against the border in third person shows the tank rather than the back of a wall. Nothing is made transparent: the camera meets the inward face from behind and back-face culling removes it. From every position a player can occupy the wall is as solid as it was.
- The debug HUD stops below the radar rather than scrolling underneath it.

Together the obstacle and flag changes take the low-power reference client from 34 to 57 frames per second at a fixed spawn, with draw calls down from 523 to 283 and the frame from 27.5ms to 16.7ms.

## [1.0.58] - 2026-09-04

### Changed
- A box is two draw calls rather than six, and a teleporter four rather than fourteen. `BoxGeometry` gives every face its own material slot, and the tiling rode on each face's own texture, so one box asked for six draws and six copies of the same two images. The tiling is baked into the geometry's UVs instead, which leaves nothing size-dependent in the material and lets every box in the world share one wall material and one cap material; a teleporter's fourteen quads accumulate per material and become one mesh each. On `hix.bzw` that takes the boxes, boundary walls and teleporters from 484 draw calls to 156, which is the cost that matters on a client that runs out of one core long before it runs out of GPU.
- The help panel scrolls on the arrow keys rather than moving focus between its links. Cycling a document's handful of links left most of the text unreachable, and in XR there is no Page Up or Page Down to reach the rest with instead. Arrows step a line, the Page keys a screen, Home and End the ends. Left and right still move focus, which is how a controller reaches the close button without a Tab key.
- Scrollbars follow the theme rather than the platform's grey, in the debug HUD, the help and every other panel that scrolls.

## [1.0.57] - 2026-09-04

### Added
- Where a frame's time goes is split further: the forced world-tree walk the shadow pass does (`matrix`), the geometry rebuilt on the CPU before anything is submitted (`worldfx`), the draw itself, and `outside` -- everything between one frame callback ending and the next starting, which is the wait for the GPU and the display, the browser painting the HUD's DOM, socket handlers and collection. The phases and `outside` are the whole frame, so a client that is slow with every phase small is saying that nothing bzo controls is the work to cut.
- `renderer.stats` carries `drawbuf`, the drawing buffer the sample was measured at; `fastest`, the shortest frame of the window, which bounds the display's refresh interval from below because no web API reports it -- a client pinned at 30fps by a 30Hz panel and one pinned there by its own cost are otherwise identical in the log; and `programsWindow`, the low-high program count, because Three keys its program cache on the light count and a count that moves during play is a recompile rather than a bigger scene.
- Two measurement knobs, `?renderScale=` and `?antialias=`, to tell the cost of the pixels bzo draws from the cost of the surface the browser presents on hardware nobody here owns. URL only, never persisted, never in the UI, and recorded in the log so a sample says which configuration produced it.
- Clients reload when the client code changes. The server hashes `public/` and Three's build directory by content at boot and sends that id when a client joins; a page keeps the id it booted with and reloads on any that differs. A tab reconnects across a server restart on purpose, so without this it can go on running code from before the edit for as long as it stays open. Editing `server.json` or a map does not change the id, and those restarts stay silent.

### Changed
- The debug grid draws before the flags rather than after. Flag cloth, poles and warp discs blend without writing depth, so a grid line standing behind one could not be depth-rejected and drew straight through it.
- The service worker's cache is keyed to that same build id rather than to the release version, and a cache miss revalidates rather than trusting the seven day `max-age` an asset carries. An edited texture used to survive the reload meant to replace it. Over HTTP/2 a full revalidation is a few tens of kilobytes of 304s rather than megabytes of assets that did not change.

### Removed
- The CSS2D label pass. Nothing in bzo ever created a `CSS2DObject` -- every label is a sprite -- so it walked the whole scene graph three times a frame to produce nothing.
- `public/test.html`, a minimal XR page that has served its purpose. `public/audio/README.md` moved to `docs/audio.md`: everything under `public/` is sent to clients, and documentation does not need to be.

## [1.0.56] - 2026-09-04

Getting rid of a bad flag, and No Jumping, are part of #6.

### Added
- The shake timeout, BZFlag's `-st`: how long a bad flag sticks before it falls off on its own. `flagShakeTimeout` in `server.json` and `-st <seconds>` in a map's `options` block both reach it, the larger of the two wins as a bzfs switch behaves, and it defaults to off as upstream has it -- with no timeout a bad flag is carried until it kills you. Values are clamped to 0.1s..300s and rounded to the tenth of a second upstream sends on the wire, so the client and the server count the same number down.
- The client owns the countdown and asks for the drop when it runs out, as `LocalPlayer::doUpdate` does. The server records when it saw the grab and puts the request through `canShakeFlag` before it agrees, because a modified client would otherwise shed a bad flag the moment it took one; a refusal is logged as `[ANTICHEAT:...] SHAKE REJECTED`. The countdown re-asks rather than latching at zero, so an honest request that arrives a fraction ahead of the server's clock still lands.
- The carried flag is named on HUD alert slot 2 for three seconds, in the warning colour when it is one you cannot put down, which is upstream's own slot and rule (`playing.cxx:1455`). A bad flag with a timeout running holds the slot and shows the time left to a tenth, which is what upstream's status line does. Both reach the XR panel, because the alert slots are shared. Pressing the drop control on a sticky flag says why it does nothing instead of sending a request the server will refuse.
- Shake wins, BZFlag's `-sw`: a count of kills, clamped 1..20, that sheds the bad flag you are carrying. `flagShakeWins` in `server.json` and `-sw <kills>` in a map's `options` block both reach it, off by default as upstream has it. Upstream counts this down on the client and asks for the drop; bzo's server is what decides a kill happened, so it counts and drops and the client is simply told. A win counts and only a win -- never a loss, never a teamkill -- which is upstream's rule too.
- Antidote flags, BZFlag's `-sa`: while you carry a bad flag a yellow flag stands somewhere in the world, and driving onto it sheds what you have. The spot is upstream's -- a random point inside a square centred on the world, half the world wide on a CTF map and the world less a base width otherwise, re-rolled while a tank would not fit there. It is drawn as a flag, on the radar in yellow over everything else, and as a yellow marker on the heading tape, which are upstream's own three.
- The antidote's spot is picked by the server rather than by the client, which is where bzo departs from upstream. Upstream can leave it on the client because its bzfs accepts any drop request; bzo's refuses a sticky one, so a client-placed antidote would mean accepting every sticky drop on a server with `-sa` on and would undo the shake timeout's validation. It reaches its owner alone as `antidoteFlag`, and driving onto it is detected off position updates the way Identify's sweep is.
- The No Jumping flag, `NJ`. Sticky and bad: a tank carrying it cannot leave a surface, whatever the world says. It is the other end of the jumping switch from `JP`, so exactly one of the two is ever in the flag pool -- `JP` forbidden while jumping is on and `NJ` while it is off, as `CmdLineOptions.cxx` has it. The altitude tape stays up under it, which is upstream's rule too.

### Changed
- Picking up a bad flag says how this world lets you put it down -- a timeout, a number of kills, the antidote, or none of them, in which case it stays until it kills you. The drop control says the same thing rather than doing nothing.
- The heading tape's flag markers no longer give up on a world with no teams, because the antidote marker does not need one.
- A flag's endurance is read off the flag table through `getFlagEndurance` rather than derived from its quality, which is what `FlagInfo::addFlag` does. The two agree for every flag upstream declares; asking the table means they cannot drift.

## [1.0.55] - 2026-09-04

Ricochet is part of #6.

### Added
- A ricochet switch, BZFlag's `+r`. `ricochet` in `server.json`, `+r` in a map's `options` block, and a checkbox on the Operator panel all reach it, and it defaults to off as upstream has it. A map may turn it on and nothing turns it back off, which is how a bzfs switch behaves. It reaches the client in the `init` config and again in `serverConfigUpdate`, so an operator can change the rules of a running game and everybody's shots change with them.
- The Ricochet flag, `R`. Shots bounce off walls until their lifetime runs out; a bounce costs range and nothing else. With the server switch on, the server forbids the flag outright and says so in the log, as `CmdLineOptions.cxx` does -- a flag that grants what every shot already does looks like it does something and does not -- and the help panel says which of the two rules the world is playing by.
- Shots reflect about real surface normals, on the client and on the server, out of one shared `traceShotStep` in the `collision` pair. It mirrors `SegmentedShotStrategy::makeSegments(Reflect)` and `ShotStrategy::reflect`, including the refraction branch upstream keeps for a normal that faces the wrong way. Buildings use `Obstacle::get3DNormal`'s rule, pyramids put a vertical component into a shot that was fired flat, the world border bounces because bzo models it as four boxes, and the ground is a surface of its own as it is upstream. A teleporter frame still stops a bouncing shot; see AGENTS.md.
- A ricocheted shot can kill the tank that fired it, which is the flag's own help text. `LocalPlayer::checkHit` tests a player's own shots like anyone else's. Killing yourself that way is a loss and nothing else, as self-destruct is.
- `SFX_RICOCHET`, with upstream's own `ricochet.wav`, and `StdRicoEffect` -- the flared cone thrown out of the surface at the point the shot bounced.
- `shotBegin` carries the flag that fired the shot, which is what upstream's `FiringInfo` does. Ricochet is the first thing bzo reads off it; every shot variant still to come reads the same field.

### Changed
- The obstacle test for a shot runs before the out-of-bounds test, so the world border is a wall a shot can bounce off rather than an edge it falls past.

### Fixed
- A client that reconnected alongside others could keep showing them as `Player n` for the rest of the session. The roster in `init` is a snapshot, and it was applied only after the models, textures and audio it names had loaded -- a window seconds wide, during which the other clients were joining and their real names arrived and were applied. Replaying the snapshot afterwards put the placeholders back, and nothing corrected it, because movement packets carry no name. Roster messages that land in that window are now held and replayed over the snapshot in the order they came.
- A connection is no longer a player on anyone else's scoreboard until it joins. bzfs's `sendPlayerUpdate` returns early unless the player `isPlaying()`, so a socket in limbo before `MsgEnter` is in nobody's roster; bzo was broadcasting one on connect, under the `Player n` name it had not yet replaced. It is not announced when it leaves either, and a tank chosen in the entry dialog before joining travels with the join instead of being broadcast on its own.
- `queryPlayers`, BZFlag's `MsgQueryPlayers`. The client asks once on entering a map and the server answers with the whole roster, so a fully populated scoreboard no longer depends on every incremental message having arrived. Anyone the answer does not name is removed, so it reconciles in both directions.

## [1.0.54] - 2026-09-03

Part of #6.

### Added
- A jumping switch, BZFlag's `-j`. `jumping` in `server.json` and `-j` in a map's `options` block both reach it, and it defaults to on, because every bzo tank could jump before there was a switch. A map's `-j` can still turn it back on where the config turned it off, which is how a bzfs switch behaves -- it never turns anything off. It reaches the client in the `init` config.
- The Jumping flag, `JP`. On a world where jumping is off it is the only way an ordinary tank leaves the ground; on one where it is on, the server forbids it outright and says so in the log, as `CmdLineOptions.cxx` does -- a flag that grants what every tank already has looks like it does something and does not.
- The Wings flag, `WG`. It takes off whatever the world says about jumping, and it is the one flag that drives and steers in the air: every other tank keeps the velocity it took off with.
- Wings' four BZDB variables, as `wingsJumpCount`, `wingsJumpVelocity`, `wingsGravity` and `wingsSlideTime` in `server.json`. All four are `Locked` upstream -- the server sets them and the client obeys -- so they travel in the `init` config with the rest of the world's physics, and bzo reads them from its config the way it already reads `tankSpeed` and `gravity`. The count is what decides whether Wings flies or only steers: a surface refills it every tick and the take-off spends one, so at BZFlag's stock 1 there is one jump and no flaps left. Leave `wingsJumpVelocity` and `wingsGravity` out to get a wings jump identical to an ordinary one, which is what upstream's aliased defaults give you; `wingsSlideTime` above zero puts momentum in the air.
- The server re-asks whether a tank may jump on every jump it sees, and logs a refusal as `[ANTICHEAT:...] JUMP REJECTED`. bzfs does not check jumping at all; without this a modified client would simply fly on a world that forbids it.
- A flap is BZFlag's `SFX_FLAP` rather than `SFX_JUMP`, with upstream's own `flap.wav`. Upstream announces it to the other clients through `PlayerState::WingsSound`; bzo already knows who is carrying what, so the flag answers and nothing is added to the packet.
- The altitude tape follows BZFlag's own rule and is up only where there is altitude to read: a world that allows jumping, or `JP` in hand.

### Changed
- The jump control is one press, one jump. BZFlag re-sets its jump request at the operating system's key-repeat rate, which with `_wingsJumpCount` above 1 dumps every flap in a fraction of a second; bzo has no key-repeat event and samples a held boolean once a frame, so it takes the rising edge instead. A coasting tank does not sample the sticks, so landing re-arms the control and holding jump still bounces a tank down a building.
- Flag messages use BZFlag's own names in both directions. `MsgGrabFlag` is one message upstream, sent by the client to ask and by the server to say what it decided, so bzo's `flagGrabbed`, `flagDropped` and `flagCaptured` are now `grabFlag`, `dropFlag` and `captureFlag` -- the name upstream's minus the redundant `Msg`, and the direction says which copy is which.

## [1.0.53] - 2026-09-03

### Fixed
- The voice volume test assigned to `globalThis.navigator`, which Node 21 turned into a getter with no setter. It worked on the pinned Node 18 and threw on 24, and since CI's main lint job runs on 24, it failed the whole v1.0.52 release. It now installs the stub with `Object.defineProperty`, which works whichever Node owns the name.
- `scripts/test-server-name.mjs` no longer names real deployment hosts. It is testing how a hostname is shortened, not a particular site, and it runs on whatever machine somebody checked the repo out on, so it uses reserved example names instead.

### Security
- `qs` is lifted to 6.16.0 through an `overrides` entry, clearing two moderate advisories that reach bzo through express. express 4.22.2 is the last 4.x and pins `body-parser` to `qs ~6.15.1`, so no 4.x release fixes this and express 5 is a breaking change; the override is a semver-minor bump inside express's own tree. `npm audit` now reports no vulnerabilities at all, dev included.

## [1.0.52] - 2026-09-03

Closes #29.

### Added
- Game, voice, and microphone levels in Settings, on the renamed Audio Settings screen. Each is a slider from Off to 100%, usable with the mouse, with Left/Right on a focused row, and with an XR controller thumbstick on the XR Audio screen, and each is remembered between sessions. The scale is BZFlag's: an integer 0..10 with upstream's squared curve, `volumeAtten = 0.02 * level * level` in `src/bzflag/sound.cxx`, scaled so the top of the range is unity rather than upstream's 2.0, because Web Audio has no mixer stage to clip into.
- Microphone level is a gain node between capture and the track sent to peers, since `getUserMedia` has no volume control of its own. It runs in the renderer's existing AudioContext rather than opening a second one.
- Three voice channels, chosen in Audio Settings and on the XR Audio screen and remembered between sessions. **All** is every player on the server, however far away. **Nearby** is only players within earshot, whatever team they are on. **Team** is your own team, however far away -- and rogue and observer count as teams, which is what upstream does, since bzfs's team message dispatch sends to every player whose `isTeam` matches with no exception for either. A channel is a room: two players are peers only when they are in the same one, so the rule reads the same from both ends of a connection. It lives in the `voice-channels` client/server pair, and the server is what enforces it -- withholding the roster and the signalling is the only lever there is, because the media never passes through the server.
- WebRTC peer activity is visible at last. The voice manager always tracked its peers and always offered them through callbacks; nothing listened, so a voice link that never came up, or quietly died, left no trace. Roster joins and departures, connection and ICE state changes, and remote audio attaching now reach the console, and the debug chat tab and server log when the debug HUD is on. The debug HUD also carries a row per peer: connection state, ICE state, and whether audio is flowing.

### Changed
- The Voice dialog is now Audio Settings, and holds the three levels above the existing voice channel, microphone input, and browser audio-processing controls. The XR Voice screen is likewise XR Audio.
- Observers report where they are. The roaming camera sends a position and a heading every five seconds -- the same `MAX_UPDATE_INTERVAL` heartbeat a driving tank already uses -- with every velocity zero, so there is nothing for either end to dead reckon and no prediction to correct. Upstream has the same idea in `sendObserverHeartbeat`, at a default of 30 seconds, which is coarse enough to list an observer and too coarse to place its voice. The server takes the position as sent: an observer has no collision, no shots and no score, so there is no state a lie could corrupt. It is relayed to the other clients as an ordinary `pm`, because voice is peer to peer -- each client decides for itself how loud a peer is and where it stands, so it has to be able to locate an observer too.
- Observers use voice on the same terms as everybody else. They could already text chat, so the microphone ban was the odd one out. Whether an observer may chat at all belongs in a server option alongside the text-chat equivalent, not in a rule the client and server each hardcode.

## [1.0.51] - 2026-09-03

Part of #6.

### Added
- The Identify flag, `ID`. While you carry it, the nearest flag lying on the ground within 50 units names itself -- "Closest Flag: Useless" on the HUD for five seconds and in the chat log -- and it says so once per flag rather than once per frame. It is entirely server-side and passive, as it is in BZFlag: the flag has no key, and it tells only its carrier, so the flag it names is still anonymous to everybody else. It is nothing to do with bzo's existing `identify` on `I` and right click, which picks the tank in your sights.
- The client remembers which flags it has identified. bzfs reveals a superflag's type only while somebody is holding it, so a flag picked up and dropped goes anonymous again on the wire even though you watched it happen -- the client now keeps what it learned, whether from Identify or from anyone's grab. It forgets a slot when that flag leaves the world, because the next flag to arrive there is a fresh roll.
- With the debug labels on, every flag whose identity this client knows carries its abbreviation over it -- `ID`, `US`, or `B*` for the blue team flag. A flag nobody has identified carries nothing, which is what makes the label worth having.
- The help panel documents every flag bzo implements, with BZFlag's own descriptions, split into team flags and superflags and each named in the flag's own colour. It is generated from the shared flag table, so it cannot promise a flag the server will not hand out or miss one it will.

### Changed
- `superFlags.allowed` now defaults to every superflag in the shared flag table rather than to a hardcoded list. The table carries only the flags bzo implements, so the default cannot put a flag in the world that does nothing.

## [1.0.50] - 2026-09-02

Closes #33.

### Added
- Kill and death notices on the HUD, in BZFlag's shape: large centred text at the top of the screen for a few seconds, red when it is about you. "Got shot by <player>" and "Tank Self Destructed" are upstream's own wording; the matching "You killed <player>" is new here. It shows in VR as well as on the desktop HUD, and deliberately sits over the scoreboard and radar -- it is gone in four seconds and reading it matters more.
- Observer mode. Joining as an Observer no longer parks an invulnerable, immobile tank on the field: an observer now has no tank at all and flies the map instead, starting from a spawn point facing the way a tank would. Drive and turn work exactly as they do in a tank, from the keyboard, the touch stick, a gamepad, or either VR controller, with Jump and Drop Flag climbing and descending. The camera rests at the eye height of a tank on the ground and never goes below it, and it looks level, like a tank does -- climbing carries what you are looking at up with you. Observers can already chat, and the radar follows the camera. Nothing draws the observer's own tank -- not the mesh, not its debug ghost.
- Observer views: Free, Track (the camera holds still and turns to keep a tank in frame), Follow (a chase camera behind it), Driving with (through its own eyes), and Flag, which watches a team flag where the map has them. Fire, `C`, the Camera button and the Settings row all walk the same list -- in each view the leader first, then every player, then on to the next view -- replacing the first/third/overview modes that do nothing for an Observer. A status line at the top names the view and who is being watched, on the desktop HUD and in VR alike.
- `identify`, on `I`, right-click, either VR B button, either gamepad shoulder, and a new touch button. It picks out whichever tank is centred in your sights -- BZFlag's targeting cone, about 17.5 degrees -- and in the Free view an Observer starts watching it, answering "Looking at <player>" on the HUD as BZFlag does. The other views are already pointed at someone, so it says so there instead. It also sets your nemesis, so `,` messages the player you just looked at; previously only a kill could set that. It will lock a guided missile once those exist.
- Click a scoreboard row to watch that player, and click the marked row again to go back to following the leader. A status line names the view and who is being watched.

### Fixed
- The service worker no longer serves files from another version's cache. Both lookups used the global `caches.match()`, which searches every cache present on the device -- including one left behind by a previous worker -- so a stale copy could be served even though the server, the response headers and a hand-run fetch all looked correct. Lookups are now scoped to the running version's own cache, and older caches are dropped when a new worker installs rather than only when it activates, since without `skipWaiting` a worker can wait indefinitely behind an installed app that never closes.
- The touch control buttons no longer run off the top of the screen. They were laid out on a fixed 80px button and a 90px pitch, which needs more height than a phone held in landscape has, so the Drop Flag button sat stranded near the top corner and anything above it was off-screen entirely. Button size and spacing now scale with the viewport, and every button's position derives from one pitch so the margins stay equal.

### Changed
- Observers now sort last on the scoreboard, as they do in BZFlag: they score for nobody, so ranking them among the players said something untrue.
- In VR, Jump is the grip alone and the B button is now `identify`. The thumbstick press still opens the menu on either controller, so every action is still reachable one-handed.
- The debug HUD moved from `I` to the backtick, which is unbound in upstream BZFlag and is the console key by convention elsewhere. `I` and Right Mouse now carry BZFlag's `identify`, as they do upstream.
- Switching teams now drops a carried flag, as every other way of leaving play already did. It keys off the team actually changing, so changing only your tank keeps the flag.
- A carried team flag is named on both scoreboards by its colour alone -- `Red` rather than `Red Team`. The label already carries that team's colour, so the word said nothing.

## [1.0.49] - 2026-09-01

Part of #6.

### Added
- Flags, in BZFlag's shape. A world now carries 16 superflag slots -- upstream's `-s` default count, all Useless for now -- and each one arrives through the same animation BZFlag uses: hovering at `_flagAltitude` inside a stack of coloured warp discs, fading in, then falling to the ground. Drive over one to pick it up, and it rides on top of your tank with its cloth rippling on BZFlag's two out-of-phase waves.
- `Space` drops the carried flag, which is upstream's `drop` binding and the key bzo has been holding unbound for it. In VR the primary face button (A) drops, so firing is now the trigger alone; a gamepad drops with X/Square, and touch play gets a Drop button above Jump.
- A dropped flag flies upstream's parabola to whatever surface is under the tank. On its fourth pickup, or anywhere but the ground, it rises out of the world instead and a fresh flag appears elsewhere on BZFlag's halflife schedule -- so a superflag dropped on a roof leaves rather than falling off it. Dying, pausing, self-destructing or disconnecting all give the flag up where you stood.
- The radar draws flags as BZFlag does: a cross a flag radius across for each one on the ground, and a larger cross on your own blip while you are carrying.
- The server hides which superflag is which until somebody picks it up, exactly as bzfs does -- so an unidentified flag on the ground tells you nothing but where it is.
- `superFlags` in `server.json` sets how many slots a world has and which flag types may fill them.
- Team flags and capture the flag. A team-mode map with bases now gives every colour team a flag on its base, in the team's own colour. Carry an enemy flag home, or your own onto their base, and it is a capture: everyone on the losing team blows up and respawns on their base, and the team score moves. Capturing your own flag wins nobody anything and costs your team the same loss, which is what the "Don't capture your own flag!!!" alert is for.
- In capture the flag every spawn is on your own team's base, as BZFlag spawns them.
- A team flag behaves like BZFlag's rather than like a superflag: it never expires, it appears at its base instead of flying in, it lands on buildings, and it will not come to rest on another team's base. It leaves the world when its team empties and returns when the team's first player arrives -- or, if an enemy carried it off first, after `teamFlagTimeout` seconds.
- BZFlag's flag alerts and their sounds: "Flag Alert!!!" when an enemy takes your team's flag, "Team Grab!!!" when a team mate takes somebody else's, and the capture-won, capture-lost and own-goal sounds.
- `teamFlagTimeout` in `server.json` sets how long an abandoned team flag survives.
- The heading tape above the targeting box carries a marker pointing at your own team's flag, as BZFlag's does -- a diamond where its bearing falls on the tape, or an arrow pinned to the edge it is past. It keeps pointing while an enemy carries your flag off, which is when it matters most.
- Both scoreboards name the flag a player is carrying, after their callsign and in the flag's colour, as BZFlag's does: a team flag in full, a superflag by its abbreviation.
- BZFlag's `-fb` is supported: superflags may spawn on and come to rest on buildings. A map's `options` block turns it on, as it does in bzfs, or `flagsOnBuildings` in `server.json` does it server-wide. `maps/hix.bzw` now sets it, so its roofs and walkways carry flags.

### Changed
- The radar draws its layers in the right order. The dark panel used to be painted *over* the flags and shots already drawn under it, and the obstacles on top of that, so a flag standing on a base was buried under the base and a shot passing over a building was hidden by it. Panel first now, then the world border and compass, then obstacles, then shots, tanks and flags -- gameplay last, as BZFlag orders it.
- Radar obstacles are painted lowest surface first, so where two overlap the higher one wins. The ring of supports around a hix base no longer looks like it is sitting on top of the base.
- Flags on the radar use BZFlag's radar colour table rather than its tank colours. Upstream keeps the two apart on purpose -- red, green and purple are lifted so a team flag reads against a dark panel instead of sinking into it. Radar depth fading also matches upstream now, which stops at 0.35 for objects and 0.5 for obstacles rather than fading almost out.

## [1.0.48] - 2026-09-01

### Added
- The debug HUD and the `renderer.stats` log line break the frame down by phase -- XR, HUD, input, shadows, world simulation, radar, render -- in milliseconds per frame averaged over a second. One saturated core is the budget on the machines that matter, and the split between simulation, HUD painting and draw submission is what decides which cost is worth attacking.

### Changed
- Projected shadows are placed by a matrix rather than by moving vertices, as `BackgroundRenderer::drawGroundShadows` does upstream. A shadow now shares its caster's geometry and costs one matrix multiply per frame, where it used to re-transform every vertex on the CPU, re-upload a buffer, and walk the whole world's matrices once per shadow. Measured on a Jetson Orin Nano, where one CPU core is the budget: the shadow phase fell from 13.7ms to 0.74ms per frame, and the client went from 36 frames a second to its refresh rate.
- Nothing gates the shadow update on the light having moved any more. That check made the cost rise as the frame rate fell -- below about 5fps the sun moved far enough every frame to rebuild every obstacle shadow, which held the frame rate down, which kept it rebuilding. A client could sit at 1-4fps until something else happened to lift it out.

## [1.0.47] - 2026-09-01

Closes #30.

### Added
- README lists the two public test servers: `bz.rikers.org` for development and `orin-bzo.rikers.org` for the nightly `linux/arm64` image.
- Shots, impacts and explosions cast a pool of light on the ground again, drawn as BZFlag draws it: an additive fan under each dynamic light whose falloff is computed per vertex from the light's own attenuation, dimmed in daylight (`BackgroundRenderer::drawGroundReceivers`). It reaches 19 units where the point light alone faded out inside three, and costs forty triangles rather than a per-fragment light.
- The launch `renderer.capabilities` line names the GL driver that answered. A frame rate means something entirely different when the string says llvmpipe or SwiftShader than when it names a GPU, and it is the one thing needed to read every other measurement against the machine that produced it.
- The debug HUD reports what the last frame cost: draw calls, triangles, shader programs, and the GPU textures and geometries currently allocated. The same figures go to `server.log` as `renderer.stats` a few seconds into every map, and again when the debug HUD is closed, so the phones and headsets nobody opens that panel on still report their numbers.

### Changed
- Shot, impact, explosion and jump-jet lights are as bright as BZFlag's. Every one of them derives from upstream's shared attenuation and its own colour scale, so a shot lights a wall it passes out to tens of units instead of fading out inside three, and the ground receiver stays in the same proportion to the real light that upstream has it in.
- The ground is drawn with the same diffuse material as every other surface, rather than the only metalness/roughness shader in the scene, and only its front faces are drawn. It is the largest thing on screen, so it was the most expensive shader over the most fragments; upstream lights it diffuse-only.
- The projected shadow darkening pass covers the ground a shadow can actually reach -- the world border plus the longest shadow the lowest accepted light can cast -- instead of the full ground, which reaches ten times the world in every direction. It is also frustum culled now that it is bounded.
- Obstacle, wall, and base textures share one GPU upload per image instead of one per face. A map's world geometry now holds a handful of textures rather than several hundred copies of the same few pictures, and a team base tints its image once per team rather than once per face.
- The XR HUD overlays stop repainting their canvases when no XR session is running. Outside a headset they were redrawing the chat, scoreboard, shot slot, and settings panels every frame for nothing.

### Removed
- Unreachable code: `RenderManager.updateSunLighting`, `getLabelRenderer`, `getTankModel` and `createCelestialBodies`; `getInputContext` and `hideHelpPanel`; `subscribeToXRState` along with the subscriber set and publish call sites no listener could ever reach; the `createWallTexture` and `createObstacleTexture` aliases; and two frame counters that existed only to feed commented-out logging.

### Fixed
- Sprite labels no longer leak a GPU texture every time they are relabelled. With debug geometry on, the packet motion gizmo relabels itself on every movement packet, so the leak grew for as long as the tank was driven -- a session could reach a thousand abandoned textures. A label now keeps one canvas for the life of its sprite and repaints it only when the text changes.
- A shot impact no longer re-uploads its 512x512 explosion sheet on every frame of the effect. Walking the atlas moves the sampler, which reaches the shader as a uniform.
- The sun and moon are visible again. They were placed at two thirds of the ground's extent -- 6.7 times the world size -- which put them beyond the far plane the mountains size, so they were clipped at every hour of the day, and would have been a few pixels across even in range. Both now sit at twice the world size and are sized by the angle they should subtend, taking those two figures from `makeCelestialLists` upstream while keeping bzo's own Minecraft-clock arc, and they draw before the world so the mountains stand in front of a low sun.

## [1.0.46] - 2026-09-01

Housekeeping. Nothing in this release changes how the game plays or looks.

### Changed
- Shared client/server modules carry short names: `collision`, `motion`, `teams`, `shots`, and `headset`, alongside `capabilities` and `settings` on the client. Their test scripts and `npm run test:*` targets follow.
- The four XR HUD overlays -- radar, chat, shot slots, scoreboard -- are built by one helper instead of each repeating the same canvas, texture, and camera-parented plane setup.
- HUD toggle buttons declare what they read, write, and persist rather than each wiring its own click handler and label logic. A button whose capability gate is closed goes dead the same way for all of them.
- Tank treads and wheels are assembled by one builder per part rather than mirrored left and right blocks, and the tinted BZFlag textures share one creator.
- Random obstacle generation places boxes and pyramids through one routine. A procedurally generated map still follows the same rules, but will not come out identical to one from the previous release.

## [1.0.45] - 2026-09-01

### Added
- A Send button in the chat panel. It starts chat entry, and pressing it again sends the message and hands the keyboard back to the game, as Enter does.

### Changed
- The chat panel no longer swallows the mouse. Only its own controls take the pointer, so a click over the transcript fires the tank -- which is where mouse control puts the cursor to drive backwards. While chat entry is active the panel takes the pointer back, and clicks stop firing.
- Chat entry now ends only on Enter, Escape, or the Send button. A click on the battlefield leaves it typing rather than quietly dropping out.
- Clicking the chat panel no longer starts chat entry. The Send button opens it, and until it does a click over the panel -- the input included -- fires the tank.
- Mouse steering now follows BZFlag's targeting box exactly. The inner box is a dead zone where the tank holds still, the outer box edge is full turn and full speed, and each axis clamps on its own, so pushing the cursor past the box keeps the tank flat out while still steering. The boxes themselves are now upstream's size, and the heading bar, altimeter, and voice readout follow them.

### Fixed
- The ground texture no longer swims against the obstacles standing on it. The ground was one 8000 unit quad, so everything near the camera fell on a single enormous triangle whose texture coordinates drift as the view moves. It now follows BZFlag's own ground: a 128 unit patch that tracks the eye, skirted out to the edge of the world, with the texture pinned to world coordinates.
- Ground jitter while driving. Every frame spent the time between animation callbacks as movement, which includes however long the main thread took to reach the callback, rather than the frame's own timestamp; each displayed frame therefore advanced slightly too far or not far enough. The step now comes from the frame timestamp, and is capped so returning to a hidden tab no longer spends the whole gap at once.
- The mouse mapping ignored the targeting box it was drawn against: full deflection sat at 35% of the window's width and 33% of its height instead of the box edge, and there was no dead zone, so the tank crept whenever the cursor was a pixel off centre.
- Opening the debug HUD moved the chat panel's left edge, and moved its right edge one toggle late -- chat cleared the panel's corner only after the panel had closed again. Chat now keeps its left edge where it is and gives up its right edge exactly while the panel is open.

## [1.0.44] - 2026-09-01

### Added
- Team scores in team mode, kept the way bzfs keeps them: a kill across teams wins one for the killer's team and loses one for the victim's, killing a team mate costs two and killing yourself costs one, and rogues and observers score for nobody. A team's tally resets when its first player joins an empty team, and survives the team emptying out.
- A team scoreboard above the player list, in the HUD and in XR, showing `score (wins-losses) size` per team sorted by score, the way BZFlag's does.
- Team standings reach a joining player in the `init` payload, and every change broadcasts a `teamUpdate` carrying the same size, wins, and losses per team that BZFlag's `MsgTeamUpdate` does.

### Changed
- Radar zoom out no longer needs the shift key. It answered to `+` alone, which is Shift and `=`, while zoom in answered to a bare `-`; both are now one unshifted key.
- Firing moved from the space bar to Enter, as BZFlag does it, leaving the space bar free for dropping a flag. The left mouse button still fires, and so do a trigger in XR, a gamepad, and the on-screen button.

### Fixed
- The browser no longer acts on the keys the game uses. Tab moved focus onto the HUD buttons, where the next Space press pushed a button instead of firing, and Firefox opened quick find on `/` and kept the keyboard. Modified keys are untouched, so browser and OS shortcuts still work.

## [1.0.43] - 2026-08-31

### Added
- Render capability detection, read from the renderer's own WebGL context. A feature the context cannot support is now switched off along with the UI that offers it: no stencil bits means no projected shadows, and a context near the WebGL 1 floor for fragment uniforms means Dynamic Lighting reads Unavailable rather than silently drawing nothing.
- Every launch logs its `renderer.capabilities` line, so the machines this runs on can be compared before any quality policy is built on them.

## [1.0.42] - 2026-08-31

### Removed
- Clicking the page no longer enters VR when a headset launch could not open the session on its own. The canvas covers most of the window, so a click meant for the game put the player in VR uninvited, and the VR button was already there for anyone who wanted it.
- Leaving VR no longer closes the window on a headset launch. It could not tell a player asking to leave VR from the headset ending the session, so Exit VR quit the app.

## [1.0.41] - 2026-08-31

### Added
- A headset browser launching the installed app asks for an immersive session ahead of the rest of the client, so an app launched from its own icon can open in VR with no 2D landing page.
- The XR menu asks for a name, team, and tank before an unjoined player joins, standing in for the entry dialog, which an immersive session cannot show.
- Name and MOTD can be typed in XR through the headset's system keyboard. Headsets without one mark those rows Desktop only.
- `[INSTALL]` log lines record the manifest and icon fetches that make up an install, with the browser that asked, since which icon a launcher takes is documented nowhere.

### Fixed
- Icons revalidate instead of being cached for a week, and the manifest points at a URL carrying each file's timestamp. A launcher keeps whichever icon it was shown at install time, so a stale one outlived every cache it came from.
- The Settings Install row reads Installed inside the installed app. It asked whether the display mode was `standalone`, which an app launched from a `display: fullscreen` manifest is not, so the app reported itself uninstallable.

### Changed
- Every icon is green. BZFlag's marks are red and its forums are blue, so the colour is what tells a bzo icon from a BZFlag one; the manifest and page theme colour follow it.
- Icon files are named for the manifest role they fill -- `any-`, `maskable-`, `tile-` -- with no product prefix, since nothing but icons lives in that directory.
- The Settings Install row reads Browser menu where the browser never offers the install event, rather than Unavailable. Safari, Firefox and the headset browsers all install from their own menus.
- Headset browsers are served their own app icons. A phone launcher crops a maskable icon and needs the art padded inside it; the Meta Quest app library letterboxes the same file and needs it padded not at all, which left the mark at half the tile inside a ring. The manifest, already generated per request, now branches on the user agent.
- Leaving VR closes the window when the app was launched from a headset icon, instead of dropping the player onto a flat window they have no use for.
- A headset launch keeps asking for its immersive session on each signal that could carry the activation it needs -- window load, focus, page show, visibility, and the Launch Handler -- rather than only once at load. If none of them lands, the first click in the window enters VR.
- The radar range starts at Medium every session and is no longer remembered. It matches BZFlag's `displayRadarRange` default, and a headset has no way to zoom the radar, so a level saved on a desktop no longer follows the player into VR.
- The one-tap VR button beside the settings gear is shown only on a device with a headset. Chrome on Android reports VR support on any phone through Cardboard, which put the button under the player's thumb during play; VR Mode is still in the Settings menu there.
- Controller input is dropped whenever the headset reports the session unfocused, rather than only when it is hidden, so a stick held while the system keyboard or the headset's own menu is up no longer drives the tank.

## [1.0.40] - 2026-08-31

### Added
- Installable as an app on mobile, desktop, and Meta Quest. The web app manifest is generated per request, so a server installs under the host it was reached at and two servers appear as separate apps.
- Added the BZFlag application icon at up to 1024x1024 for launchers and home screens, including maskable variants that survive Android's circular crop and an Apple touch icon. The simple tank mark stays the browser tab icon.
- Added a service worker. Images, audio, models, and Three.js load from disk; HTML and JavaScript revalidate on every start, so a cached client can never outlive the server it talks to.
- Added an Install App row to Settings, offered only when the browser reports the game is installable and not already installed.
- Added `maps/collision-test.bzw` and an optional `testSpawn` block in `server.json`, which place a named player at a fixed position for automated collision testing.
- Added `npm run check:shared-pairs`, which fails when a `public/*.mjs` and `server/*.cjs` pair drift apart. A drifted pair does not throw; the client and server just disagree about geometry.

### Changed
- Tanks collide as BZFlag's oriented 2.8 x 6.0 box rather than a 4-unit circle, so a tank is narrower across and longer front to back, and turning near a wall behaves as it does upstream. Every tank uses this box whatever model is selected, so the model stays cosmetic.
- Movement resolves the way BZFlag does: on contact the timestep is searched for the last moment the tank was clear, then the velocity component along the surface normal is cancelled and the rest of the step is spent sliding. This replaces expanding obstacles by the tank radius, which cannot work for a rotated box.
- Serve Three.js from the installed dependency instead of a CDN, so the game has no third-party origins and loads on a headset or a LAN with no route to the internet.
- Fire rate is limited by shot slots alone, matching bzfs, which has no elapsed-time check. The previous reload timer compared consecutive shots one reload apart, the interval network jitter lands in, and rejected honest shots.
- Rejected shots are logged as anti-cheat events and counted in the periodic summary, and shot logs use the `shotBegin` and `shotEnd` names the protocol already uses.
- `npm run dev` restarts the server if it exits, so a crash no longer leaves it stopped.
- Settings toggles show On in green and Off in red. Off was previously green, which read as backwards.

### Fixed
- A malformed WebSocket frame from any client crashed the whole server. Sockets had no error listener, so a protocol violation became an uncaught exception.
- Clicking the settings, VR, or player-name controls no longer fires the tank.
- Clicking outside a dialog closes it without firing, and the next click fires normally.
- Driving off the edge of an obstacle no longer strands the tank. Support and standing-on-top now use the same test, rather than a margin tuned for the old circular footprint.
- `public/favicon.ico` was a text file containing a data URI, so any client requesting the default icon path received garbage. It is now a real multi-size icon.
- Styles are revalidated rather than cached for a week, so a CSS change reaches players without a forced reload.
- The page title and iOS home-screen name identify the server rather than reading "Battlezone Online" on every host.

## [1.0.39] - 2026-08-30

### Added
- Added the BZFlag tank-appeared sound when a tank spawns, which had no sound before.
- Added BZFlag's spawn animation, growing a tank in from 1% to full size over 0.64 seconds.
- Added a muzzle flash when a shot is fired.
- Added BZFlag's jump jets: four flames under the tank that fire on a jump and fade as it rises, with a warm light while they burn.
- Added a spinning collar that rides along with a shot after it passes through a teleporter.

### Changed
- Matched BZFlag's reload timing: a shot slot now returns after the shot lifetime divided by the number of slots, 700ms with the shipped settings rather than a flat 1000ms. Set `shotReloadTime` in `server.json` to override.
- Replaced the procedurally generated shot, explosion, jump, and landing sounds with the BZFlag samples they were imitating.
- Moved gameplay audio into `public/audio/` and preloaded every sample on map entry.
- Matched BZFlag's sound attenuation, using inverse rolloff from a reference distance of 20 tank radii.
- Removed per-sound volume levels, so samples keep the relative balance they were mixed with, as in BZFlag. Landing volume no longer varies with impact speed.
- Logged every rejected shot as `[SHOT_REJECT]` with its reason. Observer, dead-player, and malformed-direction rejections previously failed silently, hiding exactly the cases where the client and server disagree.

## [1.0.38] - 2026-08-30

### Fixed
- Fixed players rubber-banding down pyramid slopes. The server rejected moves with no tolerance, but positions are sent rounded to 0.01, which is coarser than the margin the client keeps while sliding, so most frames of a slide were rejected and rolled back.
- Fixed tanks being held in mid-air by a distant inverted pyramid, and being unable to fall anywhere on the map afterwards.
- Fixed tanks freezing against steep pyramid faces, including in mid-air while falling, when no slide surface was reported.
- Fixed inverted pyramid collision on the server, which treated every inverted pyramid as upright and disagreed with the client about roughly a fifth of the space around it.
- Fixed tanks clipping into the edges of pyramids, where a tank whose centre sat outside the base footprint was not tested at all.

### Changed
- Added `antiCheat.collisionSlack` so the server validates movement slightly more permissively than the client, as the protocol's rounded positions require.
- Replaced both ad-hoc pyramid collision routines with shared geometry that mirrors BZFlag, so the client and server evaluate the same solid volume.

## [1.0.37] - 2026-08-30

### Added
- Added immersive XR Join, Help, Voice, and Operator screens linked from XR Settings.
- Added XR team/tank selection with authoritative rejoin, voice controls, and controller-accessible operator map and shot-limit actions.
- Added client/server parity checks for player team normalization so the two copies of the rules cannot drift apart.

### Changed
- Increased dialog and control text sizes across desktop, mobile, and XR, with scrolling XR menu rows to preserve readability.
- Disabled Anaglyph 3D while XR is active because the rendering modes are incompatible.
- Added Player Options as the first Settings destination and changed the player-name shortcut to open the main Settings menu.
- Moved agent instructions and project memory into a single `AGENTS.md` shared by all coding agents.

### Fixed
- Fixed the reported client version, which was pinned to an old release and is now derived from the release tooling.
- Fixed team names with surrounding whitespace being rejected by the client while the server accepted them.

## [1.0.36] - 2026-08-30

### Added
- Added shared dialog navigation and input ownership for keyboard, mouse, touch, gamepad, and XR controllers.
- Added a BZFlag-style Team selector with Automatic, Rogue, Observer, and enabled color teams.
- Added authoritative team-mode configuration through server JSON and BZW `-c`, `-offa`, `-autoTeam`, and six-team `-mp` options.
- Added an immersive XR Settings panel opened by either controller stick, with `Exit VR` as the first choice.
- Added focused input-context, player-team, team-mode, and shot-limit checks to the release validation suite.

### Changed
- Updated HiX to enable team play with ten slots each for Rogue, Red, Green, Blue, Purple, and Observer.
- Updated XR controls so either controller can navigate menus, activate actions, fire, and jump.
- Updated Settings, Help, Voice, Operator, and Entry dialogs to use a consistent responsive presentation and shared navigation behavior.
- Updated player and voice state terminology from role/spectator to team/observer.

### Fixed
- Fixed dialog input leaking into gameplay and stale controls continuing after input-context changes.
- Fixed the Entry Team selector being skipped by Tab after reopening the join dialog.
- Fixed automatic team assignment, per-team capacity enforcement, and BZFlag-compatible balancing behavior.
- Fixed team colors not propagating to reused tank and ghost meshes after joining or changing teams.
- Fixed team mode temporarily assigning random tank colors before join confirmation; random pastel colors are now limited to non-team-mode Rogues.

## [1.0.35] - 2026-08-29

### Added
- Added camera-attached WebXR HUD overlays for the radar, chat tabs, scoreboard, and shot cooldown indicators.
- Added an empty test world for focused rendering and WebXR diagnostics.

### Changed
- Updated WebXR session state handling to publish consistent lifecycle snapshots to subscribers.
- Aligned WebXR HUD overlays on a shared camera plane with headset-oriented sizing and placement.

### Fixed
- Fixed projectile heads, trails, and impact effects rendering behind the ground debug grid.
- Fixed WebXR HUD visibility by rendering overlays through the camera-attached XR path.

## [1.0.34] - 2026-08-28

### Changed
- Updated projected ground shadows to use a BZFlag-style stencil path so overlapping casters do not over-darken by object count.
- Updated ground debug grid visibility to follow the existing debug-geometry toggle.

### Fixed
- Fixed horizon and movement-related shadow flashing by preserving last valid projected shadow meshes and hardening stencil/decal layering.
- Fixed shadow occlusion so obstacle geometry correctly blocks ground shadow darkening.
- Fixed ground/grid/shadow draw ordering so debug grid rendering can be layered beneath shadow darkening when enabled.
- Follow-up on closed issue #22 for ground/shadow visual stability.

## [1.0.33] - 2026-08-28

### Added
- Added explicit BZFlag-style player teleport packets (`tp`/`pt`) so teleports are replicated as authoritative events instead of being inferred from movement.
- Added the shipped BZFlag teleport sound asset at [public/teleport.wav](public/teleport.wav) and preload/caching for required gameplay audio during map initialization.

### Changed
- Updated player teleports to validate from the client's predicted source-side state and preserve turn, jump direction, vertical velocity, and airborne horizontal velocity through teleport exits.
- Updated server debug packet logging to use a consistent `[DEBUG] Player "name": ...` format.

### Fixed
- Fixed teleporter frame/interior collision handling so tanks pass through active portals instead of sliding on them.
- Fixed blocked or out-of-bounds teleporter exits by rejecting invalid destinations instead of placing players outside the map.
- Fixed jump-through-teleporter kinematics so falling/rising state, turning, and post-teleport extrapolation stay aligned without false anticheat spikes.
- Fixed projectile teleport ping-pong on stacked upper/lower teleporters by extending shot re-entry blocking to cover the portal breadth after exit.

## [1.0.32] - 2026-08-28

### Added
- Added BZFlag-style tabbed chat panel with `All`, `Chat`, `Server`, `Misc`, and `Debug` tabs plus per-tab scrollback and unread indicators.
- Added chat navigation and compose shortcuts: direct tab select (`1`-`5`), tab cycling (`[`/`]`), reply to last direct sender (`.`), and message-nemesis targeting (`,`).

### Changed
- Aligned chat packet naming/content toward BZFlag semantics by replacing `chat` packets with `message` packets carrying `src`, `dst`, `msgType`, and `text`.
- Updated chat rendering to distinguish message categories and direct-message direction in the panel (`[->name]` outbound and `[name->]` inbound) similar to BZFlag formatting.
- Updated radar zoom hotkeys to use `+`/`-` (and numpad equivalents), freeing `[`/`]` for chat tab cycling.

### Fixed
- Fixed private-message delivery and sender-name display by handling player IDs as string identifiers in both client and server message routing.
- Fixed message misclassification where normal chat could appear as `[SERVER]` when legacy/alternate message fields were received.
- Fixed chat panel click propagation so selecting chat tabs no longer triggers firing.
- Fixed cross-monitor chat text clipping and improved desktop layout so chat shrinks away from the debug HUD when there is sufficient horizontal space.

## [1.0.31] - 2026-08-27

### Added
- Added a unified radar world-to-panel transform path so obstacle, projectile, and tank rendering now share one conversion pipeline.

### Changed
- Simplified radar math by centralizing world-relative rotation and panel scaling into shared helpers used by all radar entities.

### Fixed
- Fixed radar obstacle orientation regression for large rotated walls (for example `ne_xwall`) introduced by the polygon clipping rewrite.

## [1.0.30] - 2026-08-27

### Added
- Added authoritative shot lifecycle diagnostics in `server.log` with `[SHOT_START]`, `[SHOT_TP]`, and `[SHOT_END]` entries to trace teleporter traversal and termination causes.

### Changed
- Updated shot lifecycle packet names to BZFlag-style semantics: `shotBegin` and `shotEnd` replace `projectileCreated` and `projectileRemoved`.
- Updated shot expiration to use lifetime-budget semantics (`shotRange / shotSpeed`) so teleport traversal does not incorrectly shorten lifetime based on straight-line displacement from spawn.
- Updated teleporter frame/crossing classification to use BZFlag-matching tolerance (`1e-6`) and harmonized server/client teleporter aperture math with rendered teleporter geometry.

### Fixed
- Fixed false shot-end explosions on valid teleporter traversals by separating teleporter frame-hit detection from generic obstacle collision checks and excluding teleporter solids from post-teleport projectile collision tests.
- Fixed immediate teleporter ping-pong loops by adding short re-entry blocking for the destination teleporter after teleport exit.
- Fixed radar obstacle clipping for large rotated structures (for example corner x-walls) by clipping obstacle polygons to the radar square instead of culling by coarse bounds.

## [1.0.29] - 2026-08-26

### Fixed
- Fixed Docker image missing the `server/` directory, causing a crash on startup with `Cannot find module './server/shot-limits.cjs'`.

## [1.0.28] - 2026-08-25

### Added
- Added radar zoom controls with keyboard bindings and a settings-panel preset toggle.

### Changed
- Updated the radar to a square-style panel layout with square-consistent world scaling.
- Updated radar culling for tanks, shots, and obstacles to use rectangular visibility rules that match the square display.
- Updated off-range tank indicators to sit closer to the panel edge while preserving stable edge projection.

### Fixed
- Fixed near-edge radar transitions so tanks remain rendered as arrows (including partial clipping) before switching to edge dots.

## [1.0.27] - 2026-08-25

### Added
- Added a Quest-friendly XR shortcut: pressing either controller thumbstick button exits XR and opens the browser settings HUD.

### Changed
- Updated XR locomotion to be right-stick-primary for forward/back movement, with left-stick fallback, so turning and movement can be handled with one thumb.
- Updated XR session toggle UX messaging so intentional XR exits do not display a false "request failed" error.

### Fixed
- Fixed XR controller axis handling robustness across WebXR gamepad layouts by adding stick-axis fallback support for both `[0,1]` and `[2,3]` axis pairs.

## [1.0.26] - 2026-08-25

### Added
- Added subtle team-color shading for base tiles on the radar while preserving vertical opacity tracking.

### Changed
- Updated cardinal indicator colors to fixed team-color mapping independent of map layout: north=red, east=green, south=blue, west=purple in both 3D markers and radar.
- Increased radar base tint strength so team ownership is easier to read at a glance.
- Updated `hix.bzw` object naming to use directional prefixes consistently and keep team names on bases only.
- Renamed base source texture assets to shorter filenames: `base_top_source.png` -> `base_top.png`, `base_wall_source.png` -> `base_wall.png`.

### Fixed
- Fixed inconsistent directional naming in `hix.bzw`, including mixed prefix/suffix patterns and duplicate platform direction labels.

## [1.0.25] - 2026-08-25

### Added
- Added BZFlag teleporter textures (`caution.png`, `telelink.png`) and BZ-inspired teleporter frame/portal rendering with animated portal visuals.
- Added base source textures (`base_top.png`, `base_wall.png`) and team-aware base rendering assets for map-defined bases.

### Changed
- Updated teleporter geometry and face rendering toward BZFlag parity, including border framing, portal face behavior, and map-driven placement/orientation.
- Updated mountain rendering visibility on large maps by expanding view-distance handling so mountains remain visible at BZFlag-like perimeter placement.
- Updated base texture mapping to match BZFlag behavior: top/bottom fixed UV mapping (single texture repeat) and side faces using size-based repeats.

### Fixed
- Fixed a client texture colorization TypeError in base tint generation (`drawImage` source type mismatch).
- Fixed base team colorization so map teams render distinctly as red/green/blue/purple instead of all appearing red/gray.

## [1.0.24] - 2026-08-25

### Added
- Added deterministic projectile impact-point refinement on the server for obstacle and map-edge hits, so impact billboards render at stable contact points.

### Changed
- Updated remote projectile spawn handling to use authoritative server coordinates instead of wall-clock lead compensation.
- Updated remote extrapolation stop handling to clamp only when the replicated remote state is an explicit full stop.

### Fixed
- Fixed missing shot-end billboard effects for other players by always honoring authoritative projectile removal coordinates.
- Fixed impact visuals landing inside geometry by backtracking projectile/map-edge collision points before broadcast.
- Fixed delayed remote stop visibility by forcing a dead-stick move update at local inertial stop (`fs=0`, `rs=0`) and replicating that stop state immediately.

## [1.0.23] - 2026-08-25

### Added
- Added BZFlag explosion atlas assets (`explode1.png`, `explode2.png`) and a billboarded shot-impact animation path for projectile termination effects.

### Changed
- Updated local firing visuals so your own shots render immediately on send, then reconcile to the server projectile ID when the authoritative echo arrives.
- Updated shot-impact protocol handling to carry an explicit projectile end reason code and impact position data.

### Fixed
- Fixed delayed local shot visibility that previously made shots appear far from the barrel under network latency.
- Fixed shot-end visuals to only trigger explosion billboards for BZFlag-style explode reason (`reason === 0`).

## [1.0.22] - 2026-08-24

### Added
- Added an explicit naming migration note in the README for `compose.yml`, `server.json`, and `example-server.json`.

### Changed
- Renamed `docker-compose.yml` to `compose.yml`.
- Renamed `example-server-config.json` to `example-server.json`.
- Standardized default runtime config paths and examples to use `server.json` naming.

### Fixed
- Fixed Docker bind-mount ownership friction by pinning the container runtime user to UID/GID `1000:1000`.
- Fixed dev watcher config to watch `server.json` after the naming migration.

## [1.0.21] - 2026-08-24

### Added
- Added persistent runtime map storage for uploads and operator-managed maps via a runtime maps directory (defaulting to `/data/maps` in Docker).

### Changed
- Updated map discovery and selection to merge runtime-uploaded maps with bundled image maps.
- Updated Docker documentation to explain where server config and uploaded maps persist by default.

### Fixed
- Fixed Docker map switching reload behavior by restarting the process after operator map changes when not running under nodemon.
- Fixed silent operator failures by surfacing generic server success/error responses in the client and logging config write errors with paths server-side.

## [1.0.20] - 2026-08-24

### Added
- Added an explicit project policy that distribution artifacts remain public by default, including container images and release downloads.

### Changed
- Migrated repository and container registry references from `BZFlag-Dev` to `timriker` across docs, scripts, runtime links, and Docker defaults.

### Fixed
- Fixed post-transfer pull failures caused by stale owner paths by updating published image references to `ghcr.io/timriker/bzo`.

## [1.0.19] - 2026-08-24

### Added
- Added a repository security policy in `SECURITY.md` covering reporting flow, support scope, and update guidance.

### Changed
- Added a controls documentation consistency check (`npm run check:controls-docs`) and integrated it into `npm run check`.

### Fixed
- Applied safe dependency security updates in the lockfile to address known advisories in `express`, `body-parser`, `qs`, `js-yaml`, and `brace-expansion`.
- Aligned README and in-game Help controls so documented keybindings match the current implementation.

## [1.0.18] - 2026-08-24

### Added
- Added release-time Node.js compatibility validation on both Node.js `18.19.1` and `24.19.0`.

### Changed
- Switched container publishing to a single Ubuntu `26.04` image lane while keeping multi-arch (`linux/amd64`, `linux/arm64`) manifests.
- Updated the Docker runtime install path to pinned Node.js `24.19.0` binaries on Ubuntu `26.04`.

### Fixed
- Fixed release process drift by aligning CI, release workflow, Dockerfile, and README with the current Node compatibility and Docker publishing policy.

## [1.0.17] - 2026-08-24

### Added
- Added clone-safe ghost label binding so ghost name labels stay connected after tank cloning.

### Changed
- Updated jump-path debug rendering to use a momentum-only airborne projection and always terminate on ground impact.

### Fixed
- Fixed stale ghost player names (for example showing "Player 1") by ensuring ghost labels receive the same name updates as tank labels.
- Removed unnecessary per-update name prefix churn from packet-motion debug labels.

## [1.0.16] - 2026-08-24

### Added
- Added Nearby WebRTC voice chat with in-game microphone controls and per-player nearby peer routing.
- Added a dedicated Voice settings dialog opened from the main Settings HUD.

### Changed
- Moved the main browser entrypoint from `game.js` to `client.js`.
- Updated HUD panel behavior so opening Help, Voice, or Operator hides the Settings HUD.

### Fixed
- Fixed mobile/desktop firing cadence so holding fire respects `shotReloadTime` on the client and server.
- Fixed Help panel usability by adding proper scrolling and a close button.
- Fixed movement collision precedence so driving on top of one obstacle no longer allows moving through overlapping obstacles or world boundaries.

## [1.0.15] - 2026-08-23

### Added
- Added a more stable WebXR foundation with cleaner session lifecycle handling and controller/input state isolation.

### Changed
- Updated the client to Three.js 0.185.1 and synced the browser import map and dependency versions to match the updated renderer.
- Improved renderer scheduling so the app handles normal playback and XR sessions more predictably.

### Fixed
- Fixed wall impacts while jumping so tanks keep the vertical component of their jump and resume a valid horizontal trajectory after contact instead of sticking to the obstacle.
- Stabilized WebXR startup, visibility changes, controller changes, and session teardown paths to reduce stale input and renderer issues.

## [1.0.14] - 2026-04-08

### Fixed
- Synchronized release metadata so `package-lock.json` now matches `package.json` versioning for the published package (`1.0.14`).
- Cut a follow-up patch release to carry the metadata correction without rewriting the previously published `v1.0.13` release.

## [1.0.13] - 2026-04-07

### Added
- Added projected planar (stencil-style) shadows for tanks: each visible tank casts a soft ground shadow computed by projecting its geometry onto the ground plane along the sun direction.

### Changed
- Switched from real-time Three.js shadow mapping (PCFSoftShadowMap) to projected planar shadows for better performance; shadow map generation on lights is now disabled.
- Updated npm dependencies to address audit findings.

## [1.0.12] - 2026-04-01

### Changed
- Updated projectile/shot behavior to better match classic BZFlag feel and timing.
- Refined shot handling so client and server behavior stays aligned with the BZFlag-style firing model.

## [1.0.11] - 2026-04-01

### Added
- Added BZFlag mountain, ground, bolt, and shot-tail textures to the client asset set.
- Added BZFlag-style onscreen shot-slot indicators beside the target HUD.

### Changed
- Updated mountains and ground to use BZFlag-style placement, scale, and texture repetition for a closer classic battlefield look.
- Retuned world lighting toward BZFlag day/night colors while keeping `bzo`'s world-time cycle.
- Switched projectile rendering from simple glowing spheres to BZFlag-inspired tinted bolt sprites with matching colored tails.
- Updated shot speed/range handling so server simulation, client rendering, radar visibility, and config defaults all use the same BZFlag-style values.
- Switched firing behavior from cooldown-only shooting to BZFlag-style shot slots, with the example config defaulting to one slot and the runtime server config set to three.

### Fixed
- Fixed projectile desync that made local shots appear much slower than the server-tracked projectile speed.
- Fixed shot-slot HUD behavior so each slot tracks its actual active projectile instead of multiple slots animating together.

## [1.0.10] - 2026-03-31

### Added
- Added BZFlag obstacle textures for boundaries, boxes, pyramids, tank treads, and tank body detailing.
- Added a BZFlag-style loading overlay that keeps chat available while delaying active join until render-critical world and tank assets are ready.
- Added a new `wheeled6` tank model option with a six-wheel armored-car silhouette.
- Added documentation for the supported tank OBJ naming contract in `docs/tank-model-format.md`.

### Changed
- Switched the default player tank model to `bzflag`, renamed the old default model to `modern`, and renamed the split BZFlag model asset to `bzflag`.
- Updated tank model selection and server-side model discovery to prefer the supported selectable models and hide source-only OBJ assets from the menu.
- Updated cloud height placement to float above the tallest obstacle by roughly one jump height.
- Added configurable BZFlag-style fog mode, density, start, and end settings while keeping fog color driven by time-of-day.

### Fixed
- Fixed startup races that could leave the local tank partially initialized until switching models by gating gameplay join on render readiness.
- Fixed blank tank selection states caused by exposing `tank.obj` as a selectable model.
- Fixed wheel-face clipping on treaded models by nudging wheel meshes slightly outward from the tread surfaces.
- Fixed the `wheeled6` model so it renders as a true wheel-only vehicle without fake tread geometry.

## [1.0.9] - 2026-03-27

### Changed
- Increased scene fog start/end distances (120–500) to better match the 1:1 BZFlag world scale.

### Fixed
- Fixed obstacle rotation for all rotated boxes, walls, and teleporters parsed from `.bzw` maps by correcting the BZFlag +Y→Three.js -Z axis-flip compensation in the rotation formula.

## [1.0.8] - 2026-03-27

### Added
- Added BZFlag-style spawn visuals with a short ground flash ring and vertical spawn burst on join and respawn.

### Changed
- Updated first-person camera and shot origin alignment to use model-derived muzzle offsets for closer BZFlag parity.
- Updated first-person FOV behavior to use BZFlag-style horizontal FOV conversion by display aspect.
- Updated jump defaults to BZFlag-like values (`jumpVelocity: 19`, `gravity: 9.8`) and aligned landing flash/squish timing to BZFlag feel.

### Fixed
- Fixed server/client gravity configuration flow so gravity is configurable server-side and propagated through game config.
- Fixed landing feedback consistency by triggering effects on landing transitions without local threshold suppression.

## [1.0.7] - 2026-03-26

### Fixed
- Make the `prepare` script skip Husky installation when dev dependencies are omitted so container builds using `npm ci --omit=dev` no longer fail with `sh: 1: husky: not found`.

## [1.0.6] - 2026-03-26

### Fixed
- Replace `docker/build-push-action` (Buildx) with plain `docker build` + `docker push` commands to eliminate unexplained BuildKit exit code 127 failures and get clear build output in CI logs.

## [1.0.5] - 2026-03-26

### Fixed
- Add `no-cache: true` to Docker build step to prevent stale BuildKit layer cache from masking base image changes.
- Remove unused QEMU setup step; only `linux/amd64` is targeted so QEMU is not needed.

## [1.0.4] - 2026-03-26

### Changed
- Switch Docker base image from `node:20-slim` to `ubuntu:24.04` with OS-provided Node.js 18 and npm, matching the Ubuntu 24.04 development environment and avoiding mysterious `npm ci` exit code 127 failures in GitHub Actions Buildx.

## [1.0.3] - 2026-03-26

### Fixed
- Restrict Docker image build to `linux/amd64` to avoid QEMU emulation failures that caused `npm ci` to exit with code 127 when building `linux/arm64` on GitHub Actions runners.

## [1.0.2] - 2026-03-26

### Fixed
- Switch Docker base image from `node:20-alpine` to `node:20-slim` so that `npm` is available during the container build step and the release workflow succeeds.

## [1.0.1] - 2026-03-26

### Added
- Local Git hooks now lint staged JavaScript before commit and run full checks before push.

### Changed
- Release workflow now initializes QEMU before Buildx to support multi-architecture Docker image publishing.

### Fixed
- Fixed release automation gap that could fail container publishing during tagged releases.

## [1.0.0] - 2026-03-26

### Added
- Tag-gated release automation that validates `package.json` and `CHANGELOG.md` before publishing.
- GitHub Container Registry publishing for versioned Docker images.
- Docker packaging with a persistent `/data` volume for runtime config.
- `/source` route and in-app source-code link to satisfy AGPL network source availability.
- Release helper scripts for preparing, validating, and extracting changelog entries.

### Changed
- Updated licensing headers across source files with copyright and source references.
- Expanded documentation for releases, installation, configuration, and update strategy.
- Server startup now bootstraps a runtime config from `example-server.json` when no config exists.

### Fixed
- Cleaned up release metadata and project packaging details so shipped artifacts are consistent.
