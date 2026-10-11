# Observer

What an observer cannot do yet. AGENTS.md's Observer section is what it does:
the roaming views, how the eye and the roster work, and where bzo deliberately
differs from upstream's `Roaming`.

Nothing here has an issue of its own.

## Smaller things

- **No target list in XR.** Observers keep upstream's scoreboard order
  (`obsLast`), but the XR menu panel has no list of who to watch, so in a
  headset the cycle and `identify` are the only pickers.
- **`follow` does not reuse the death camera rig** (`render.js`), which is the
  same look-at-a-moving-target shape.
- **`XR_HELP_ITEMS` is one flat frozen list**, so it cannot show the observer
  meanings of grip and A. That wants observer-conditional rows. Issue #27,
  "Rework menus", is closed, so nothing tracks this now.
- **Whether continuous stick yaw is comfortable in XR roam.** It matches what
  bzo already ships when driving; a comfort option is a measurement, not a
  guess.
