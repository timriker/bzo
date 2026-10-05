# Settings Dialog Migration Plan

Issue: #27, closed. The architecture it tracked is in place; what is left is the
Resume Point below, which is small and unscheduled.

## Goal

Move the current settings/help/audio/operator overlays toward one shared dialog
system that is usable with mouse, keyboard, touch, attached mobile peripherals,
and XR controllers.

## Target Shape

- One shared dialog/menu system for help, entry and tank selection, audio
  settings, operator tools, and future team selection.
- A common focus model so dialogs are navigable with Tab, Arrow keys, Enter,
  Space, and Escape on any device with a keyboard.
- Input adapters for mouse/pointer, touch, keyboard, and XR controller thumbsticks/buttons.

## Module Boundaries

- `public/menus.js`: shared menu lifecycle, focus, keyboard navigation,
  controller navigation, and back/close behavior.
- `public/settings.js`: declarative Settings rows, values, and the DOM
  renderer. The XR renderer consumes the same rows.
- `public/input.js`: input ownership and routing; it does not define menu contents.
- Feature modules continue to own the actions and state behind individual
  settings until those features have a natural smaller owner.

## Input Ownership Architecture

`InputContextManager` is the single authority for the active input owner:

1. `entry`
2. `dialog`
3. `chat`
4. `gameplay`

Only the active context receives input. Opening or closing a context clears
gameplay keyboard, mouse, touch, gamepad, and XR state. The gameplay frame also
checks the context and consumes neutral input unless gameplay owns input.

Keyboard events have one document listener in `public/input.js`. Application
commands are callbacks registered with that input layer rather than separate
document listeners. Gamepad and XR polling use the same context and route
navigation, activation, and back actions to the active dialog.

## Migration Strategy

1. Keep the current overlays working while input ownership is centralized.
2. Route all input sources and gameplay consumption through `InputContextManager`.
3. Remove duplicate document listeners and direct gameplay-state writes from
   feature code.
4. Wrap existing panels as dialog screens instead of rewriting their content.
5. Move visibility rules into the shared dialog state so desktop, mobile, and
   XR all use the same menu model.
6. Gate operator-only options later without changing the menu architecture.

## Interaction Rules

- Desktop: mouse remains primary, but keyboard navigation must work everywhere
  a dialog is open.
- Mobile: touch remains primary, but a connected mouse or keyboard should work
  the same as on desktop.
- XR: controller navigation is the default, but attached keyboard and mouse
  should still work.
- Keep the control surface small and predictable because XR and mobile do not
  have the same key coverage as a desktop browser.

## Resume Point

Add optional controller-ray pointing and richer XR text entry when portable
browser APIs are available.

## XR Menu Direction

- Enter XR from the DOM Settings menu because browsers require a user gesture
  to start an immersive session.
- While immersed, open or close Settings by pressing either thumbstick; use a
  controller menu button when the runtime exposes one reliably.
- Place the menu about 1.25 meters ahead at eye level.
- Keep thumbstick navigation primary: either stick selects, either trigger or
  primary face button activates, and either grip or secondary face button
  closes the menu.
- Add optional controller-ray pointing and trigger selection after the
  focus-based path works; both should drive the same menu selection state.
- Show `Exit VR` as the first Settings row only during XR.
- Continue moving remaining DOM-backed actions into renderer-neutral feature
  APIs as XR interaction expands.
