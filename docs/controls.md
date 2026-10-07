# Controls

One client runs on a desktop, a phone and a headset, so every action has a way
in from each of them. The keyboard has the most; touch, a gamepad and the XR
controllers carry the actions a match needs, and the Settings menu reaches the
rest -- including from a headset, where there is no keyboard at all. The in-game
help (`/` or `?`) lists the keyboard's; `npm run check:controls-docs` keeps the
two in step.

## Keyboard

### Driving

- `W` / `S` or `Up` / `Down` — move forward/backward
- `A` / `D` or `Left` / `Right` — turn left/right
- `Enter` — shoot
- `Tab` — jump
- `Space` — drop flag
- `I` or right-click — identify the tank in your sights, and lock a Guided
  Missile onto it
- `Delete` — self-destruct, after a five second countdown; `Delete` again calls
  it off
- `9` or `/autopilot [roger|ace]` — autopilot: the pilot drives, aims and
  shoots until pressed again. `Settings -> Autopilot` chooses the pilot without
  a keyboard. You can still drive while it does, to help it out of a corner --
  see [Combining inputs](#combining-inputs)
- `P` — pause/resume

### Chat

- `N` — open chat (or click the `Send` button)
- `Enter` — send chat (while chat input is focused, or click `Send` again)
- `1` / `2` / `3` / `4` / `5` — switch chat tab (`All` / `Chat` / `Server` /
  `Misc` / `Debug`)
- `[` / `]` — previous/next chat tab
- `Tab` — while typing, complete a player, command or flag name; `@` starts a
  mention and `#` a player's slot number
- `Up` / `Down` — while typing, recall earlier lines; type the start of a line
  first to recall only the ones beginning that way
- `.` — reply to last direct-message sender
- `,` — message nemesis target
- `Page Up` / `Page Down` — scroll chat history
- `End` — jump chat to newest message
- Drag across the history while chat is open to select it, then copy;
  typing carries on in the input

### View and panels

- `Esc` — back out one step: exit chat input, leave fullscreen, leave mouse
  steering, then open Settings. Pressing it again closes Settings, so it is
  always safe to press one more time
- `M` — toggle mouse steering
- `C` — cycle camera mode
- `O` — toggle operator panel
- `F` — toggle fullscreen
- `` ` `` — toggle debug HUD
- `=` or `+` or `Numpad +` — zoom radar out (increase range)
- `-` or `Numpad -` — zoom radar in (decrease range)
- `\` — reset radar zoom to the default medium range (half the world's radar
  limit, which is the world size unless the map says otherwise)
- `Settings -> Radar: ...` — cycle Short/Medium/Long radar presets
- `B` — toggle the voice microphone
- `Settings -> Audio Settings` — set the game, voice, and microphone levels,
  and choose the voice channel: All, Nearby, or Team
- `/` or `?` — show/hide help panel

### Hunting

Marking a player puts a cyan `◎` on their scoreboard row, a cyan ring on their
radar blip, and a beacon in the sky over them in their own tank colour -- so
several marked at once are still told apart at a glance. While one of them is in
your sights the HUD says `SPOTTED:` and a ping sounds once a second from where
they are. In Rabbit Chase the rabbit is marked for you, and its beacon is cyan
like its ring: everyone is hunting it, so everyone's mark over it says so.

- `U` — hunt: open the scoreboard cursor, and press it again on a running hunt
  to clear every mark
- `7` — add hunt: the same cursor, but committing adds to what is marked rather
  than replacing it, and committing on a row already marked takes it off
- `Settings -> Hunt` — the same thing without a keyboard, for a phone or a
  headset. Left and right step through `Clear` and then the players in
  alphabetical order; select marks or unmarks whoever is shown, or clears every
  mark on `Clear`. On a touch screen or with a mouse, tap a chevron to step and
  anywhere else on the row to select
- With the cursor open, the board's heading reads `*SEL*` and a pulsing `○` sits
  on the row it is on, filling in to `◎` when you commit. `Up` / `Down` move it,
  `Enter` commits, and `U` or `7` backs out keeping whatever was already marked.
  `I` and `Space` move the cursor too, so a surface without arrow keys can reach
  it

### As an observer

As an Observer you have no tank. Drive and turn fly the camera instead, `Tab`
climbs and `Space` descends, and the camera rests at the eye height of a tank on
the ground. Pausing and self-destruct do nothing.

- `Enter` or `C` — step through everything: in each view, the leader first, then
  every player, then on to the next view. The views are Free, Track, Follow,
  Driving with, and Flag where a map has team flags
- `I` or right-click — in the Free view, watch the tank in your sights
- Click a scoreboard row to watch that player; click the marked row again to go
  back to following the leader

## Mouse

`M` turns mouse steering on and off, and nothing else does: the keys never take
it away behind your back.

### The targeting box

The two boxes in the middle of the screen are the steering, as in BZFlag. Where
the cursor sits relative to their centre is what the tank does:

- **Inside the inner box, nothing.** It is the dead zone: park the cursor there
  to stop.
- **Between the boxes, more the further out.** Up is forward and down is
  reverse; left and right turn. Each grows evenly from nothing at the inner
  box's edge to full at the outer box's.
- **At or past the outer box, full.** Each axis stops growing on its own, so
  running the cursor out past the top keeps the tank at full speed and leaves
  left and right free to steer.
- **Reverse is half speed**, as it is from the keys, however far down the cursor
  goes.
- **The box sets the speed asked for, not the speed you get at once.** A world
  with an acceleration limit (BZFlag's `-a`, off by default) brings the tank up
  to it over time, the same as it does from the keys.

The boxes are BZFlag's own sizes, scaled to the window. BZFlag also holds the
cursor inside the box; a browser cannot without taking the pointer over, so in
bzo the cursor can leave it -- the steering simply stays at full, and the cost is
a longer move back to the centre.

With the keys, the mouse keeps whichever axis no key is holding -- see
[Combining inputs](#combining-inputs).

### Clicks

Left click shoots wherever the cursor is, whether mouse steering is on or not,
unless the click lands on the chat panel or a button. Right click identifies.
Mouse steering is unavailable with no mouse attached, in VR, and while the
on-screen controls are up, since those steer instead; a click that misses one
of their buttons does nothing rather than firing.

## Combining inputs

Every input drives at once, and nothing switches between them on its own:
`M` and the Settings rows are the only things that change which ones are on.

**Driving is shared out an axis at a time** -- forward/back, and turn, each on
its own. On each, the first of these with something to say wins:

1. **Keys.** A held drive key owns its axis, and holding both of a pair
   (`W` and `S`, or `A` and `D`) is a deliberate stop on that axis.
2. **The stick:** the XR controllers in VR, otherwise a connected gamepad,
   otherwise the on-screen stick. Only one of the three is read at a time --
   they are not added together.
3. **The mouse**, in the targeting box, with mouse steering on.

So you can drive with `W` while the mouse steers, turn with `A`/`D` while the
mouse sets the speed, or steer a gamepad's turn while a key holds the speed. A
stick let go reads zero and gives the axis to the mouse; the mouse box holds
whatever the cursor's place says, which is why it comes last.

**Buttons add up.** Shoot fires from `Enter`, a left click, or the stick
source's own fire button; jump from `Tab` or the stick source's; identify from
`I`, a right click, or the stick source's. Any of them will do.

**With the autopilot on**, the pilot takes the mouse's place, last in line: a
drive key or the stick you hold still owns its axis, and the pilot has the
rest. So when it is wedged against something you can hold `A` to turn it out,
or `S` to back it off, while it keeps the other axis, and let go to hand it
back -- it carries on from wherever you left it, re-planning its route if you
took it somewhere else. Your shots, jumps and drops add to its own. The mouse
box does not steer while the autopilot drives: it holds an offset wherever the
cursor is parked, so it would never hand anything back.

**Menus don't stop the autopilot.** Opening Settings, or any other menu,
normally pauses your tank. With the autopilot driving, the menu takes the keys
and the pilot goes on driving. With a pilot chosen on the
`Settings -> Autopilot` row but not driving, opening a menu turns the autopilot
on, and closing the menu turns it off again -- so a menu means "drive for me a
moment" rather than "stop". With the row on `None`, the default, or on a server
that refuses bots (`-disableBots`), menus pause as they always have. A hidden
window still pauses either way: the browser stops drawing it, and the pilot
with it.

**Three keys at once.** Many keyboards cannot report some three-key
combinations at all -- the third key's press never reaches the browser -- so a
held turn and reverse can swallow a jump (#146). The debug HUD (`` ` ``) shows
how many keys the browser saw held at once, which tells the keyboard's limit
from bzo's.

## Touch: the on-screen controls

A phone starts with them on; anywhere else `Settings -> Virtual Controls` turns
them on and off.

- **The stick**, bottom left: push it to drive and turn, as far as you push it.
  A mouse can drag it too.
- **`●`** — shoot. Tapping fires as fast as clicking a mouse; holding fires at
  the world's sustained rate
- **`⤒`** — jump
- **`⚑`** — drop flag
- **`◎`** — identify, and lock a Guided Missile

Everything else -- camera, radar range, chat, hunting, autopilot, pausing -- is a
row in Settings, which a tap reaches.

## Gamepad

Any controller the browser reports in the standard layout (most USB and
Bluetooth pads, and iOS MFi controllers). Plugging one in turns it on; nothing
needs setting up.

| Control | Driving | In a menu |
|---|---|---|
| Left stick | forward/backward and turn | move between rows, change a row |
| `A` / Cross, or right trigger | shoot | select |
| `B` / Circle, or left trigger | jump | back |
| `X` / Square | drop flag | |
| Either shoulder | identify | |

The sticks have a dead zone of a fifth of their travel, so a pad left on the
desk does not creep. The right stick is free.

The pad rumbles when you fire and when your tank dies, as BZFlag's does: a
short buzz for a shot, longer for a shock wave, both motors for a laser, and
one long, strong shake for a death. It rumbles only while it is what you are
playing with -- a key or a click hands control back and keeps it quiet -- and
never for an observer. **Rumble** in Settings turns it off. The browser has to
support it; Chrome and Edge do.

## XR controllers

In VR the controllers are the only input. Turning the tank is independent of
where you look.

| Control | Driving | In the XR menu |
|---|---|---|
| Either thumbstick | forward/backward and turn -- the right stick if both are pushed | move between rows, change a row |
| Either trigger | shoot | select |
| `A` / `X` (primary face button) | drop flag | select |
| `B` / `Y` (secondary face button) | open the XR menu | back, and close it from the top |
| Either grip | jump | back |
| Press either thumbstick | identify | |

Both controllers pulse for the same events as a gamepad's rumble.

Identify is on the thumbstick press because a thumb that is steering presses it
by accident, and identifying costs nothing; the menu is on `B` for the same
reason. Typing -- a name, a MOTD -- uses the headset's own system keyboard,
raised when the row takes focus; see the README's WebXR section for headsets
that have none.
