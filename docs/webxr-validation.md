# WebXR validation checklist

This checklist covers the current WebGL-based WebXR path. It is intended for
manual regression checks after changes to controller input, session lifecycle,
or deployment configuration.

## Preconditions

- Install dependencies with `npm install`.
- Run `npm run check` and resolve any failure before starting a session.
- Use `http://localhost:3000` for local checks, or an HTTPS deployment for a
  remote headset.
- Record the browser, headset, browser version, page origin, and test date.
- `/test.html` lists the measurement knobs as links, so a headset can pick one
  without typing a query string and press Back to pick another.

## Desktop regression

- Open the game without a headset.
- Confirm that the game joins normally and that keyboard, mouse, and gamepad
  controls still work.
- Confirm that the VR Mode button is disabled when WebXR is unavailable.

## Entry points

- On an Android phone in Chrome, confirm that the VR button beside the settings
  gear is absent and that Settings still lists VR Mode.
- On a headset, confirm that the VR button beside the settings gear is present.
- Install the app on a headset, join once so a name is saved, then launch it
  from its icon and confirm that it opens in VR without touching a button.
  `server.log` records the outcome as `Launch session: granted` or `refused`.
- Reload the page in the installed app and confirm that the refused request
  leaves the game playable in 2D, and that clicking the page does not enter VR.
- Leave VR in the installed app and confirm the flat window is still there and
  still playable.
- Clear the saved name, launch the installed app again, and confirm that the
  session starts and the menu opens on Join Game rather than on Settings.
- From Join Game, activate Name and confirm the system keyboard appears, that
  the typed name reaches the row, and that Join enters the game under it.
- Confirm the name survives a restart, and that the app then joins straight into
  VR without opening the menu.
- Exit VR before joining and confirm the 2D entry dialog appears.
- On a headset with no system keyboard, confirm Name reads Desktop only and that
  Join still works under the server-assigned name.
- While the system keyboard is up, hold a thumbstick and confirm the tank does
  not move.
- In Operator, activate MOTD, type a message, and confirm the server adopts it.

## Session startup and head tracking

- On a supported headset, start VR Mode from the in-game button.
- Confirm that the scene enters immersive VR and that head movement changes the
  view without moving the tank.
- Confirm that the tank remains centered at the XR origin while the world moves
  relative to the player.

## HUD panels

The DOM HUD keeps every panel one `--hud-edge` from the edge of the viewport. A
session has no viewport edge, so `XR_HUD_ANGLE_X`, `XR_HUD_ANGLE_UP` and
`XR_HUD_ANGLE_DOWN` bound the panels in degrees off the gaze axis instead, and
`placeXRHudPanel` holds every panel inside that box. Those three numbers are the
only thing to change if the HUD sits wrong; nothing else encodes a position.

- Look straight ahead without moving your head and confirm that the radar, the
  scoreboard, the shot slots, the notices and the chat are all readable -- no
  panel should need a glance down or out to the side to reach.
- Confirm no panel is clipped by the edge of the display or lost in the blur at
  the edge of the lens.
- Confirm the chat panel sits above the bottom edge of the box with its caption
  and all six message lines visible.
- Send chat of each kind and confirm each line is the colour the desktop window
  gives it: server yellow, misc blue, action peach, direct messages cyan and
  purple, ordinary chat white.
- With a keyboard attached, switch tabs with the digit keys and confirm the
  caption follows. Let a message arrive on another tab and confirm the caption
  row reports it as unread on the right.

## Controller mapping

- Move either thumbstick forward and backward; the tank should move along its
  current heading, with the right stick preferred when both are active.
- Move either thumbstick left and right; the tank should rotate without
  changing its heading from head movement, with the right stick preferred.
- Press either trigger to fire.
- Press either grip button to jump. The secondary face button no longer jumps.
- Press either primary face button (A) to drop a carried flag.
- Press either thumbstick in to identify. As an observer this picks the tank
  centred in the view; for a tank it does nothing yet. Confirm that a stray
  press while steering does nothing worse than that.
- Press either secondary face button (B) to open Settings.
- Release every control and confirm that no stale input continues to act.

Every gameplay action must stay reachable from **one** controller alone, which is
what the merged accessors in `getXRControllerInput()` exist for. Check each of
the above with the other controller set down.

## Movement

A headset frame runs long where a desktop frame does not, and one frame is one
step of tank motion, so the collision tests here are the ones a low frame rate
breaks first. Do these with the render level showing a poor frame rate -- a busy
part of the map, or several tanks firing -- rather than on an empty one.

- Jump and land on the roof of a box. Confirm the tank stops on the roof rather
  than sinking into the building or through it.
- Drive off a tall building and land on a lower one on the way down. Confirm the
  lower roof catches the tank.
- Land on a thin deck or a base platform, which a long enough step passes
  through body and all.
- Jump up into the underside of a deck and confirm the tank is turned back.
- With `antiCheat` in `warning` mode, confirm the server log records no
  `COLLISION` findings for any of the above: a landing the client gets wrong is
  a position the server disagrees with.

## XR Settings menu

- Press either secondary face button (B) and confirm that Settings opens without
  ending the XR session, and that a thumbstick press does not open it.
- Confirm that `Exit VR` is the first selected row and `Close` is the last row.
- Navigate up and down with either thumbstick.
- Activate a setting with either trigger and either primary face button.
- Open Join, change Team and Tank with left/right, select `Apply & Rejoin`, and
  confirm that the server returns the requested model and assigned team.
- Open Help and confirm that all control rows are readable without overlap.
- Open Audio, adjust the game, voice, and microphone levels with left/right,
  cycle microphone inputs, toggle browser audio processing, and confirm
  permission/microphone states refresh after activation.
- Open Operator, cycle maps and shot limits, refresh server data, and confirm
  restart/apply actions affect the selected values. Confirm MOTD and desktop-only
  controls remain readable but cannot be activated.
- From each submenu, use grip or the secondary face button (B) and confirm that
  focus returns to Settings rather than closing the entire menu.
- Close Settings from the top level with either secondary face button (B).
  Confirm one press does not open and close it again.
- Confirm that movement, firing, and jumping remain neutral until all controls
  are released after closing.
- Reopen Settings, activate `Exit VR`, and confirm that the normal desktop
  render loop resumes.

## Observer

- Join as an Observer and confirm no tank of your own is drawn, including with
  Debug Geometry on.
- Fly with either thumbstick; grip climbs and the primary face button descends.
  The view stays level as you climb.
- Press either trigger to step the selection: the leader, each player, then the
  next view. The notice panel names the view and who is being watched.
- Press the secondary face button in the Free view and confirm the tank centred
  in the view is picked, and that it answers on the notice panel in another view.
- Confirm the notice panel shows kill and death alerts from other players.

## Session lifecycle

- Exit VR Mode using the in-game button and confirm that the normal render loop
  resumes.
- End the session from the headset or browser system UI and confirm that the
  normal desktop loop resumes without a page reload.
- Hide and restore the headset view, then confirm that controllers and movement
  continue to work after visibility returns.
- Enter and exit VR Mode a second time and confirm that no duplicate input or
  animation callbacks are active.

## Deployment checks

- Confirm that a remote deployment uses HTTPS.
- Confirm that the WebSocket connection uses `wss://` when the page uses HTTPS.
- If a `Permissions-Policy` header is configured, confirm that
  `xr-spatial-tracking=(self)` is allowed.
- Confirm that a browser without WebXR fails gracefully and leaves desktop play
  available.

## Result

Record each check as pass, fail, or not applicable. Include the failing step,
browser and headset details, page origin, and any relevant debug output so the
result can be reproduced.

## Deferred TODO: Hand Controls

These are deferred options to revisit later. Do not change current physical
controller mappings without being asked: the set above is deliberate, and the
one-controller rule constrains any addition to taking a binding rather than
splitting one across hands. Jump moved to grip alone so that B could carry
`identify`; see the Observer section of `AGENTS.md`.

- Keep current controller bindings as primary where gamepad axes/buttons are
  available.
- Add visible hand/controller rendering with fallback order:
  hand model -> controller model -> ray/pointer only.
- Implement optional hand-driven actions when `inputSource.hand` is available:
  pinch-to-fire, grab-or-double-pinch jump, and a reliable exit/settings
  gesture.
- For locomotion with hands only, prototype a non-dominant pinch-and-drag
  virtual stick and compare to wrist-twist turn alternatives.
- Require a guaranteed escape path that does not depend solely on gesture
  recognition when controller buttons are present.
- Validate portability across Quest and other WebXR runtimes before changing
  defaults.
