# Settings Dialog Migration Plan

Issue: #27

## Goal

Move the current settings/help/audio/operator overlays toward one shared dialog system that is usable with mouse, keyboard, touch, attached mobile peripherals, and XR controllers.

## Target Shape

- One shared dialog/menu system for help, entry and tank selection, audio settings, operator tools, and future team selection.
- A common focus model so dialogs are navigable with Tab, Arrow keys, Enter, Space, and Escape on any device with a keyboard.
- Input adapters for mouse/pointer, touch, keyboard, and XR controller thumbsticks/buttons.

## Module Boundaries

- `public/menus.js`: shared menu lifecycle, focus, keyboard navigation, controller navigation, and back/close behavior.
- `public/settings.js`: declarative Settings rows, values, and the DOM renderer. A future XR renderer will consume the same rows.
- `public/input.js`: input ownership and routing; it does not define menu contents.
- Feature modules continue to own the actions and state behind individual settings until those features have a natural smaller owner.

## Input Ownership Architecture

`InputContextManager` is the single authority for the active input owner:

1. `entry`
2. `dialog`
3. `chat`
4. `gameplay`

Only the active context receives input. Opening or closing a context clears gameplay keyboard, mouse, touch, gamepad, and XR state. The gameplay frame also checks the context and consumes neutral input unless gameplay owns input.

Keyboard events have one document listener in `public/input.js`. Application commands are callbacks registered with that input layer rather than separate document listeners. Gamepad and XR polling use the same context and route navigation, activation, and back actions to the active dialog.

## Migration Strategy

1. Keep the current overlays working while input ownership is centralized.
2. Route all input sources and gameplay consumption through `InputContextManager`.
3. Remove duplicate document listeners and direct gameplay-state writes from feature code.
4. Wrap existing panels as dialog screens instead of rewriting their content.
5. Move visibility rules into the shared dialog state so desktop, mobile, and XR all use the same menu model.
6. Gate operator-only options later without changing the menu architecture.

## Current Status

- Central context ownership and gameplay-state reset are implemented.
- Keyboard state has one document listener.
- Mouse movement/fire, touch, gamepad, and XR gameplay inputs are context-gated.
- Gamepad and XR controls route focus, activation, and back actions to open dialogs.
- The gameplay frame consumes no control input while another context owns input.
- Shared lifecycle and navigation now live in `public/menus.js`.
- Settings rows and DOM rendering now live in `public/settings.js` and reuse existing feature actions.
- Settings use a vertical label/value layout with keyboard, pointer, touch, gamepad, and XR-controller navigation.
- Settings labels and values align around the dialog center so related text stays visually adjacent.
- Settings, Help, Audio, Operator, and Entry share one responsive screen footprint and a lightweight translucent background.
- Entry stages every choice it offers and applies them on OK. Cancel, the `[X]`
  and Escape put the draft back; Default resets the fields without applying them.
- Entry follows BZFlag's `Team:` choice pattern, defaulting to Automatic and offering Rogue, Observer, Red, Blue, Green, and Purple, while retaining the BZO tank selector.
- Player tanks and related HUD effects use the selected team's BZFlag-compatible color.
- Server team policy is configured with `teamMode.enabled`, `teamMode.autoTeam`, `teamMode.teams`, and `teamMode.limits` in `server.json`.
- BZW `options` blocks support BZFlag's `-c`, `-offa`, `-autoTeam`, and six-slot `-mp rogue,red,green,blue,purple,observer`; map options override corresponding server settings.
- When team mode is disabled, only Rogue and Observer are offered and player colors remain random. Enabled team mode uses BZFlag-compatible team colors.
- Choice selectors use the shared Left/Right and activation model instead of native dropdowns so DOM and XR menus can share interaction semantics.
- Up/Down and Tab move focus; Left/Right adjusts the focused settings row; activation and back behavior remain shared.
- Immersive XR Settings use a CanvasTexture renderer backed by the shared Settings values and actions.
- Pressing either controller stick opens or closes XR Settings without ending the session.
- Player-name activation opens Settings, where `Player Options` is the first destination for name, Team, and Tank changes.
- XR Settings place `Exit VR` first, followed by `Player Options`, Help, Audio, and Operator screens, with `Close` last.
- XR Player Options changes Team and Tank selections and applies team changes through an authoritative rejoin.
- XR Audio exposes the voice channel and the game, voice, and microphone levels as adjustable rows, then permission, microphone, input-device, and browser audio-processing controls.
- Volume rows are `input[type=range]` in the DOM dialog and adjustable rows in XR, driven by the same `menuadjust` event: Up/Down leaves the row, Left/Right moves one step, and pointer drag works as the browser's own slider.
- XR Operator exposes map selection/restart, shot-limit updates, server-data refresh, and read-only MOTD. Text editing and map upload remain desktop-only.
- Either stick navigates, either trigger or primary face button activates, and either grip or secondary face button closes the menu.

## Interaction Rules

- Desktop: mouse remains primary, but keyboard navigation must work everywhere a dialog is open.
- Mobile: touch remains primary, but a connected mouse or keyboard should work the same as on desktop.
- XR: controller navigation is the default, but attached keyboard and mouse should still work.
- Keep the control surface small and predictable because XR and mobile do not have the same key coverage as a desktop browser.

## Resume Point

Add optional controller-ray pointing and richer XR text entry when portable browser APIs are available.

## XR Menu Direction

- Enter XR from the DOM Settings menu because browsers require a user gesture to start an immersive session.
- While immersed, open or close Settings by pressing either thumbstick; use a controller menu button when the runtime exposes one reliably.
- Place the menu about 1.25 meters ahead at eye level.
- Keep thumbstick navigation primary: either stick selects, either trigger or primary face button activates, and either grip or secondary face button closes the menu.
- Add optional controller-ray pointing and trigger selection after the focus-based path works; both should drive the same menu selection state.
- Show `Exit VR` as the first Settings row only during XR.
- Continue moving remaining DOM-backed actions into renderer-neutral feature APIs as XR interaction expands.