# Operator panel

Design and staging plan for the operator panel: what it offers, how a change is
applied, and how it stays usable in a headset. Upstream references are paths
under `$HOME/bzflag/`.

Issue #4 is the nearest tracker (*world config to server config*); open one for
the panel itself before the first commit if that turns out to be a poor fit.

Upstream has no operator panel at all. Its equivalent is the command set, and
`docs/commands-plan.md` is the plan for that side; this is about the surface bzo
has that upstream does not, and the rule is that where both offer the same action
they call the same function.

## What the panel has now

Server name, `motd`, `shotMaxActive`, `ricochet`, a map list, a map upload,
bot fill and pilot, the game's shape -- teams, rabbit chase, jumping, a
playing limit and a limit per team -- and the match limits (`timeLimit`,
`timeManualStart`, `maxPlayerScore`, `maxTeamScore`) beside the Match Timer
buttons. Every row is staged behind one Apply/Restart button; see "Admins and
the admin channel" in `AGENTS.md`. What is left is the rules pass.

## A live change still writes `server.json`

On a dev box that restarts everyone. `applyServerConfigChanges` writes the
file for every apply and then broadcasts, and `nodemon.json` watches
`server.json` -- so changing the MOTD is live in production and a restart in
development, whatever the button said. The two-outcome button is honest about
the tier and the file write goes behind its back.

Not fixed here, because the fix is a trade rather than a tidy-up. Writing only
when a restart-tier setting changed would make the environments agree, and would
also mean `motd`, `shotMaxActive` and `ricochet` last until the next restart and
no longer -- which is upstream's own answer, since BZDB is runtime state and
`/set` persists nothing. Dropping `server.json` from nodemon's watch list is the
other end of it, and that would cost the `testSpawn` workflow in `AGENTS.md`,
which relies on a config write restarting the server. Worth deciding on purpose.

## A game mode change is a map change

Not a setting that happens to need a restart: **a new game**. A map change, a
game mode change and a match ending are one event -- every player leaves the
current game and enters a fresh one -- and from a player's side they are
indistinguishable.

So the panel presents a mode change the way it presents a map change.

## Every control has to work with two buttons

A headset is driven by left, right and select. It may also have a physical
keyboard paired to it -- that is possible and **bzo has not tested it** -- but
the panel cannot assume one, and text typed through the headset's own system
keyboard costs an opening and a dismissal either way. So a control that can avoid
needing text should. bzo already has the vocabulary for this: the
flat DOM tags rows `data-menu-kind` as `choice`, `range` or `action`, and the XR
menu mirrors it with `adjustable: true`. The entry dialog's team and tank
selectors are the pattern to copy.

| what | kind | examples |
|---|---|---|
| a number | `range` stepper with min/max/step | shot limit, max players, per-team limits, superflag count |
| a fixed set | `choice` stepper | map, teams on/off, rabbit selection |
| a boolean | a `choice` of On/Off | jumping, ricochet, no-team-kills, antidote |
| free text | a text row, in XR too | MOTD, server name, description |

**Text works in a headset, so do not block it.** `beginXRTextEntry` focuses a
hidden `#xrTextInput`, which opens the headset's own system keyboard and returns
the typed value on blur -- the XR player-name and MOTD rows already use it. The
gate is `isSystemKeyboardSupported()`, which reports what the *session* says it
can do, so *"Desktop only"* is the fallback for a session that reports no system
keyboard rather than a policy for headsets. Same rule as `capabilities.mjs`: ask
what the device can do and disable only the row it cannot serve.

Untested: a physical keyboard paired to a headset. `isSystemKeyboardSupported()`
describes the system keyboard and says nothing about one, so a paired keyboard
may well work in a text row already -- nobody has tried it. Worth a line in
`docs/webxr-validation.md` when somebody has the hardware.

**Prefer a stepper anyway, because typing costs more than stepping.** Opening a
system keyboard, typing and dismissing it to change a number you could have
nudged with one button is worse, not impossible -- so a number is a `range` and a
fixed set is a `choice`, and text is for what is genuinely free-form. MOTD,
server name and description are that; nothing else on the panel is.

**Grey a row the mode cannot honour**, which is `capabilities.mjs`'s rule applied
to gameplay: `resolveTeamMode` zeroes the colour teams when rabbit chase is on and
when teams are off, so the panel greys those four rows there -- and greys the
Teams row itself under rabbit chase, which is the switch that overrules it
(`CmdLineOptions.cxx:1586`). A UI that offers a combination the server would
silently override is worse than one that offers less. The greying reads from the
*staged* mode, so turning teams on brings the colour rows back before anything is
applied.

## What to offer

**The game's shape -- built.** These are the new game tier: staging any of them
turns the button to *Restart*, because bzo resolves the team layout and the flag
pool once at boot.

| option | control | note |
|---|---|---|
| map | `choice` | already there |
| teams | `choice` off/on | bzo derives ClassicCTF from whether the map has bases, so there is no separate CTF row |
| rabbit chase | `choice` off/score/killer/random | greys the teams row and the colour team rows when on |
| playing limit | `range` 1-200 | the tanks, observers excluded; caps every playing team's own limit |
| per-team limits | `range` 0-200 | one row per team; which rows are live depends on the mode, below |
| jumping | On/Off | |

The panel's rows are flat where `server.json` is nested, so each team limit is
one key of its own -- `rogueLimit`, `observerLimit` -- mapped back to
`teamMode.limits` on the way in. **A team limited to zero is off**, which is
upstream's own rule ("not putting in not enabled teams", `bzfs.cxx:1935`) and
already how a map's `-mp 10,0,4,0,2,8` reads, so the written team list follows
the limits rather than being a second place a team's presence is decided.

**Which team rows are live, by mode.** The panel should offer exactly the teams
the mode can put a player on, which is what `resolveTeamMode` decides:

| row | when |
|---|---|
| observer | **always.** Every mode has observers, including Rabbit Chase, where it is the only team anyone may ask for |
| rogue | every mode **except** Rabbit Chase -- but see below, because the number still matters there |
| red, green, blue, purple | team modes only. Rabbit Chase zeroes them and so does turning teams off, so those rows grey out |

**The rogue row is the player cap in Rabbit Chase.** `resolveTeamMode` sets the
hunter limit *from* the rogue limit, which is upstream's own derivation
(`CmdLineOptions.cxx:1596`). Greying the rogue row there would leave an operator
with no way to limit how many people can play, so relabel it -- "Hunters" --
rather than disabling it, and write the same `teamMode.limits.rogue` behind it.

**A player limit has to cap something.** A row labelled "max players" that
caps nothing is the one thing not to offer.

Upstream has **two** limits, and the relationship between them is the answer to
"does the player limit include observers":

```text
maxPlayers = maxRealPlayers + maxTeam[ObserverTeam]   // CmdLineOptions.cxx:458
```

- **`maxRealPlayers`** caps the tanks -- rogue and the four colour teams -- and
  **excludes observers**. It is the configured one: `-mp 8` sets it, and `-mp`
  with all five counts listed makes it their sum (`:423`). Each team's own limit
  is then clamped down to it (`:453`).
- **`maxPlayers`** is *derived*, never configured, and **includes observers**.
  The default observer limit is 5 (`:376`).

Both are enforced, and differently: reaching `maxRealPlayers` makes
`autoTeamSelect` hand out `ObserverTeam` instead of refusing (`bzfs.cxx:1899`),
so a full game turns arrivals into spectators; reaching `maxPlayers` rejects the
connection outright with "This game is full" (`:2339`).

**So the panel exposes two numbers, not three:** a playing limit and an observer
limit. The total is arithmetic and is nowhere in the UI.

bzo's `maxPlayers` is the playing limit -- upstream's `maxRealPlayers`, and
upstream's single-number `-mp N` form of it, which is the form where every
playing team's own limit is clamped down to it (`:453`). Both of upstream's
enforcements are bzo's too: `selectPlayerTeam` hands out observer once the tanks
between them reach it, and the `joinGame` handler refuses an arrival with "This
game is full" once the tanks and the observers together reach the derived total.

**Rabbit Chase keeps both rows, because in bzo they are two numbers.** Upstream's
identity between a playing limit and a hunter limit comes from `-mp` with all
five counts listed, where `maxRealPlayers` *is* their sum; with a single number it
keeps both, the playing limit clamping the hunter limit rather than being it. bzo
has only the single-number form, so the Hunters row is the hunter limit and the
playing limit is what it may be raised to -- greying either one would take away a
number an operator can really set.

**The clamp is visible before the button is pressed.** Lowering the playing limit
lowers every playing team's row with it, in the panel, rather than letting the
write correct them silently afterwards -- and a playing team's row cannot be
stepped above it in the first place. The observer row is outside the clamp, as
upstream's observer limit is.

**Team limits are a join-time gate, not an invariant.** `selectPlayerTeam` is
called from exactly one place in bzo -- the `joinGame` handler -- and nothing
rechecks a limit afterwards. Nor is anything sized by one: team state is
`teamScores` (a `Map` keyed by team name), `BASES_BY_TEAM` (the same), and
`getTeamSizes()`, which counts the live roster on demand. There are no fixed
per-team arrays on either side, so a team holding more players than its limit is
simply a team of that size -- the count reports it, the scoreboard draws it, and
nothing overflows. Any future way of putting a player on a team has to apply the
limit itself, because no other code path will. The playing limit and the total
are gates in the same one place and answer for no more than that: lowering either
one from the panel starts a new game, so nobody is ever over a limit that was
lowered under them.

**Rules worth having, in a second pass.**

| option | control |
|---|---|
| `superFlags.count` | `range` 0-32 -- zero turns superflags off, a large lever for one number |
| `noTeamKills`, `teamKillerDies` | On/Off, a pair, and only meaningful where there are sides |
| `flagShakeTimeout`, `flagShakeWins`, `antidoteFlags` | the bad-flag group |
| `description` | text, beside MOTD and server name, and editable in XR as they are |

## Deliberately not offered

The rule: **nothing that can lock the operator out or make the server
unjoinable.** The only recovery is editing `server.json` on the box, which is
exactly what somebody using a panel does not have to hand.

- **`adminGroups`, `localAdmin`.** An operator editing who is an operator is a
  privilege-escalation path.
- **The physics variables** -- server.json's `bzdb` block (`_tankSpeed`,
  `_tankAngVel`, `_gravity`, `_jumpVelocity`, `_shotSpeed`, `_shotRange`, the
  `_wings*` set) and the inertia pair. `/set` reaches the variables.
  Clients predict against every one of them, so a wrong value makes the game
  unplayable with no in-game way back. They are also rarely changed, and a
  stepper over a continuous physics value is a poor control on any surface -- so
  the reasons point the same way.
- **`antiCheat`.** Disabling the cheat checks from a panel a modified client can
  draw itself is the wrong direction, whatever the server-side gate.
- **`testSpawn`, `voiceIceServers`, `port`, `mapFile` paths.** Development and
  infrastructure, not gameplay. `testSpawn` in particular is answered by `/mv`.

Note that none of these are excluded for being hard to type in a headset. Text
entry works there; the exclusions above are about what an operator should be able
to break from a panel, and about controls that would be poor on any surface.

## Suggested order

1. **The rules pass**: superflags, team kills, the bad-flag group, identity
   text.

## A map's options still win, and the panel does not say so

The panel edits `server.json`, and a map's own `options` block overrides it at
boot: `maps/bzo.bzw` carries `-ms 5` and `-j`, so on that map the shot limit and
the jumping switch the panel shows are the config's and the world is running the
map's. The rows are honest about what they write and silent about what will
happen to it, which is the same gap the shot limit row has had since it was a
text box.

Fixing it means telling the client which keys the running map overrides and
greying those rows -- but a *staged* map change moves the answer, and the server
cannot say what a map it has not loaded will override. Worth its own pass, after
the rules pass, and worth deciding then whether the panel greys the row or shows
both numbers.
