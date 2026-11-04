# Keys, chat and HUD layout

Bringing bzo's keyboard, chat panel and desktop HUD closer to BZFlag's, so a
veteran's hands work here, without giving up WASD
([#201](https://github.com/timriker/bzo/issues/201)). The keys and silencing
from the scoreboard are built; the rest is not yet.
Upstream references are paths under `$HOME/bzflag/`; its default bindings are
`src/bzflag/ActionBinding.cxx`. The current keys are in
[help/controls.md](help/controls.md).

## Every key is a position

A key is read by where it is (`event.code`), never by the character it types
(`event.key`), for every binding. A mix fails: on AZERTY the key in the W
position is labelled Z, so "forward by position" and "Z by character" would
both fire on one press. WASD needs position, so everything is position.

- A binding names a key on a US layout. On AZERTY, `Z` (admin chat) is the
  key labelled W; on QWERTZ it is the one labelled Y.
- A Shift variant is that position with `shiftKey` held, so Caps Lock and the
  layout never change which binding fires.
- Help and the controls list show the player's own label for each key where
  the browser can say (`navigator.keyboard.getLayoutMap()`, Chromium), and the
  US label elsewhere. Display only: the binding stays the position.

## The keys

Function keys are not used: browsers and operating systems take several
(`F1` help, `F5` reload, `F11` fullscreen, `F12` developer tools) and Mac
laptops need `Fn` for all of them. Upstream's Shift+F-keys become Shift plus a
digit.

| Key | bzo now | Planned | Upstream |
|---|---|---|---|
| `1` `2` `3` | chat tabs | radar range ¼, ½, full | same |
| `4` / `5` | chat tabs | radar zoom in / out | same |
| Shift+`1`–`4` | -- | chat tab All, Chat, Server, Misc | Shift+F1–F4 |
| Shift+`5` | -- | Debug tab, while the debug HUD is on | -- |
| `B` | voice microphone | binoculars | same |
| `V` | -- | voice microphone | -- |
| `M` | mouse steering | message to team | same |
| Shift+`M` | -- | mouse steering | -- |
| `Z` | -- | message to admins | same |
| `F` | fullscreen | flag help | same |
| Shift+`F` | -- | fullscreen | `F1` |
| `O` | operator panel | message prompt opened with `/` | same |
| Shift+`O` | -- | operator panel | -- |
| `/` `?` | help | unchanged | -- |
| `Q` | claimed, unbound | radar on or off | same |
| `K` | -- | silence cursor on the scoreboard | silence a player |

Upstream's `S` and `W` show and hide the scoreboard and chat. They have no
key here: WASD takes the letters, and Shift with W and S already tilts an
observer's view. The ▲ button beside the gear does it.

`[` and `]` keep cycling the chat tabs. `N`, `,`, `.`, `Page Up`, `Page Down`
and `End` already match upstream.

The radar keys need no new ranges: `1`–`3` are bzo's Short, Medium and Long,
already upstream's ¼, ½ and full of `_radarLimit`, and `4` / `5` are the
×1.05 steps `+` / `-` take today.

### Silencing from the scoreboard

Upstream's `K` prompts `[Un]Silence:`, and Enter with nothing typed toggles
whoever was last messaged or picked (`SilenceDefaultKey.cxx`) -- so a stray
`K` and Enter silences somebody, and the player is left wondering why they
went quiet. bzo's `K` opens the hunt cursor (`U`, `7`) in a silence mode
instead:

- The heading names the mode, as `*SEL*` does for a hunt. `Up` / `Down` move
  the cursor, `Enter` toggles silence on its row, `K` or `Esc` closes it.
- The cursor opens on a row that does nothing, as the hunt's `Clear` does, so
  `K` then `Enter` changes nothing.
- A silenced player's row carries 🔇 whether the cursor is open or not, from
  the system's emoji font, as the 🎤 button already relies on. Upstream's
  scoreboard shows no such mark.
- `Settings -> Silence` is the same cursor without a keyboard, as
  `Settings -> Hunt` is, for touch and XR.

The list stays the one `/silence` and `/unsilence` already keep (`client.js`,
in `localStorage`).

### The mouse wheel

Documented as it is, which is upstream's in spirit:

- over chat: scrolls it
- over the radar: zooms it
- over the scoreboard, the debug HUD and any dialog: scrolls it
- over the game view: nothing

## Binoculars

Upstream's `viewZoom` narrows the field of view (`B`, and Ctrl+wheel to zoom).
That is desktop only: in a headset the device owns the projection, and
scaling the world makes people sick. The XR answer is a scope -- a second,
narrow camera drawn onto a small panel at the gunsight -- built separately,
since it costs a render pass while it is up. Ctrl+wheel is the browser's page
zoom, so the game has to take it before the browser does.

## The chat panel

Upstream puts the input line outside the message panel. bzo keeps it inside
the shaded panel, because white text on a snowy map is unreadable.

```text
[Send][ALL ▾]   (input opens here)        [All][Chat][Server][Misc]
<message lines>
```

- One header row: Send and the target on the left, the tabs on the right.
- The input is hidden until opened -- `N`, `M`, `Z`, `,`, `.`, `O` or the Send
  button -- and appears between them, so the line it takes today goes to
  messages while nobody is typing.
- The tabs hide while the input is open.
- Enter sends and closes the input. Escape closes it and keeps the draft.
- Send opens the input when it is closed, and sends when it is open. On touch
  it is the only way in, and it brings up the keyboard.
- Full tab names when Send, the target selector and the tabs all fit in the
  header at their text size; otherwise single letters (`A C S M D`), each
  with its name as a tooltip. Measured, not a breakpoint, so a translation's
  longer words fall back on their own.
- XR keeps its own chat panel and keyboard.

## Desktop layout

With the virtual controls on, the layout stays as it is: radar top right,
clear of the joystick and buttons. With them off (`virtual-controls-active` is
absent from `<body>`), the radar goes back to upstream's lower left, at its
current size, with chat beside it along the bottom -- upstream's control
panel. The debug HUD moves to the top right. The switch is the player's own
toggle, so the layout never changes mid-fight. A window too narrow for radar
and chat side by side keeps today's layout.

## Open questions

- The width at which the desktop layout falls back.
- Settings, the silence list included, live in each server's own
  `localStorage`, so a callsign silenced on one bzo is not silenced on
  another. No plan yet.

## Later

- The XR radar's size: options are kept in the project notes, not settled.
- The XR binocular scope.
