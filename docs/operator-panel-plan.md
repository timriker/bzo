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

`motd`, `shotMaxActive`, `ricochet`, a map list with **Restart with Map**, and a
map upload. Every setting carries **its own apply button**, and that shape is the
thing to change first.

## Stage the edits, apply once

**OK and Cancel, like the entry dialog.** Every row edits a staged value and
nothing reaches the server until OK; Cancel and the `X` commit nothing. The
entry dialog already works this way -- it stages a name, a team and a tank and
pays for all three on OK -- so the panel is the odd one out rather than the
innovation.

**It removes rows, which is why it matters in XR.** The XR operator menu today
reads:

```
MOTD                 Desktop only
Map                  <adjustable>
Restart with Map     <- apply row
Shot Limit           <adjustable>
Apply Shot Limit     <- apply row
All Shots Ricochet   On
Refresh Server Data
Upload Map           Desktop only
Back
```

Two rows per setting, because per-row apply leaked onto a surface scrolled with a
thumbstick. One OK and one Cancel collapse every apply row, and each setting
becomes a single line. Fourteen settings with per-row apply is unusable in a
headset; fourteen settings plus OK and Cancel is a list.

## Apply, or Restart

One button with two labels, decided by what has been staged:

- **Only live-capable settings changed** -- `motd`, `shotMaxActive`, `ricochet`
  today -- so apply them, broadcast `serverConfigUpdate`, and nothing else
  happens. It reads **Apply**.
- **Anything else changed**, so this is a new game: write `server.json` and
  `requestServerRestart`. It reads **Restart**.

The label changes the moment a staged edit needs one, so an operator sees what
the button is about to do before pressing it rather than learning from the
result. **Cancel** and the `X` abort every staged change either way, and
re-opening the dialog starts again from what the server currently has -- so
changing a row, seeing the label turn to Restart and thinking better of it costs
nothing.

`requestServerRestart` already handles both environments -- it touches
`server.js` under nodemon and calls `process.exit(0)` otherwise, so a Docker
restart policy relaunches it. Nothing new is needed to restart.

**This also fixes a live inconsistency.** `applyServerConfigChanges` writes
`server.json` *and* broadcasts a live update. nodemon watches `server.json`, so
on a dev box changing the MOTD restarts everyone, while the same change in
production applies live and does not. Deciding the outcome from what changed --
rather than writing the file every time -- makes the two environments behave the
same.

## A game mode change is a map change

Not a setting that happens to need a restart: **a new game**. A map change, a
game mode change and a match ending are one event -- every player leaves the
current game and enters a fresh one -- and from a player's side they are
indistinguishable. See "Game over is the same event as a map change" in
`docs/game-modes-plan.md`, which is the other half of this.

So the panel presents a mode change the way it presents a map change, and when
match end lands its **start**, **pause** and **set limit** controls belong on the
same surface and go through the same path.

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
to gameplay: `resolveTeamMode` zeroes the colour teams when rabbit chase is on,
so the panel greys the per-team rows there. A UI that offers a combination the
server would silently override is worse than one that offers less.

## What to offer

**The game's shape.** These are the new game tier: staging any of them turns the
button to *Restart*.

| option | control | note |
|---|---|---|
| map | `choice` | already there |
| teams | `choice` off/on | bzo derives ClassicCTF from whether the map has bases, so there is no separate CTF row |
| rabbit chase | `choice` off/score/killer/random | greys the team rows when on |
| per-team limits | `range` 0 upward | one row per team; which rows are live depends on the mode, below |
| jumping | On/Off | |

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

**A global player limit needs a prerequisite bzo does not have.** In bzo
`maxPlayers` is read once, at `server.js:2055`, and used only to supply the
*default* per-team limit; nothing enforces it as a cap. The real cap today is the
sum of the per-team limits. Offering a row labelled "max players" that caps
nothing is the one thing not to do.

Upstream has **two** limits, and the relationship between them is the answer to
"does the player limit include observers":

```
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

**So the panel exposes two numbers, not three:** a playing limit
(`maxRealPlayers`) and an observer limit. The total is arithmetic and belongs
nowhere in the UI. That also settles Rabbit Chase: with the colour teams zeroed,
upstream's `maxRealPlayers` reduces to the rogue count and `resolveTeamMode`
derives the hunter limit from the same number -- so a playing limit and a
"hunters" limit there are *the same value*, and showing both would be showing one
number twice. Show the observer limit and one playing limit, labelled **Hunters**
in that mode.

**Team limits are a join-time gate, not an invariant.** `selectPlayerTeam` is
called from exactly one place in bzo -- the `joinGame` handler -- and nothing
rechecks a limit afterwards. Nor is anything sized by one: team state is
`teamScores` (a `Map` keyed by team name), `BASES_BY_TEAM` (the same), and
`getTeamSizes()`, which counts the live roster on demand. There are no fixed
per-team arrays on either side, so a team holding more players than its limit is
simply a team of that size -- the count reports it, the scoreboard draws it, and
nothing overflows. Any future way of putting a player on a team has to apply the
limit itself, because no other code path will.

**Rules worth having, in a second pass.**

| option | control |
|---|---|
| `superFlags.count` | `range` 0-32 -- zero turns superflags off, a large lever for one number |
| `noTeamKills`, `teamKillerDies` | On/Off, a pair, and only meaningful where there are sides |
| `flagShakeTimeout`, `flagShakeWins`, `antidoteFlags` | the bad-flag group |
| `serverName`, `description` | text, beside MOTD, and editable in XR as it is |

## Deliberately not offered

The rule: **nothing that can lock the operator out or make the server
unjoinable.** The only recovery is editing `server.json` on the box, which is
exactly what somebody using a panel does not have to hand.

- **`adminGroups`, `localAdmin`.** An operator editing who is an operator is a
  privilege-escalation path.
- **The physics constants** -- `tankSpeed`, `tankRotationSpeed`, `gravity`,
  `jumpVelocity`, `shotSpeed`, `shotRange`, the `wings*` set, the inertia pair.
  Clients predict against every one of them, so a wrong value makes the game
  unplayable with no in-game way back. They are also rarely changed, and a
  stepper over a continuous physics value is a poor control on any surface -- so
  the reasons point the same way.
- **`antiCheat`.** Disabling the cheat checks from a panel a modified client can
  draw itself is the wrong direction, whatever the server-side gate.
- **`testSpawn`, `voiceIceServers`, `port`, `mapFile` paths.** Development and
  infrastructure, not gameplay. `testSpawn` in particular is answered by `/mv`
  now.

Note that none of these are excluded for being hard to type in a headset. Text
entry works there; the exclusions above are about what an operator should be able
to break from a panel, and about controls that would be poor on any surface.

## Suggested order

1. **OK and Cancel**, with the two-outcome button, over the four settings the
   panel already has. Nothing new is offered; this is the restructure, and it is
   the part that has to be right.
2. **Convert the existing rows to `choice` and `range`**, so shot limit stops
   being a text box and the XR menu loses its apply rows.
3. **The game's shape**: teams, rabbit chase, max players, per-team limits,
   jumping.
4. **The rules pass**: superflags, team kills, the bad-flag group, identity text.
5. Match-end controls, with match end (`docs/game-modes-plan.md`).

Step 1 is worth doing alone: it changes no setting and makes every later row
cheaper, because a new row is then one entry in a list rather than a row plus a
button plus a handler.
