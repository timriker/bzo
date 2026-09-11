# Server commands

Design and staging plan for the bzfs chat commands bzo does not have. Upstream
references are paths under `$HOME/bzflag/`.

Issue #5 tracks this; reference it from every commit and changelog entry here, as
flag work references #6 and game modes reference #42.

**Steps 1, 2 and 3 are done.** `server/commands.cjs` holds the parsing and the
formatting, the table and the dispatcher are in `server.js`. The commands are
`/?`, `/help` and `/<prefix>?`; the open tier `/uptime`, `/serverquery`, `/msg`,
`/date`, `/time`, `/lagstats`; and the operator tier `/kill`, `/say`, `/mute`,
`/unmute`, `/mutelist`, `/playerlist`, `/flag` (`reset`, `up`, `show`, `drop
[player]`), `/set` and `/mv`, plus `/me`. See "Server commands" in `AGENTS.md`.

**`/mv` is bzo's own.** Upstream has no command that moves a tank -- not in bzfs,
not in `BanCommands`, not in any plugin, and there is no API call for it either.
It is here because bzo is developed by driving it: `testSpawn` in `server.json`
does this on join, and `/mv` is the same thing without a restart.

A facing is one of the eight compass points and never a number, for the reason in
`AGENTS.md`. If an exact angle is ever wanted for a test, that is the moment to
decide what a number means -- and it will need saying out loud whichever
convention wins, because bzo's rotation and a compass bearing run opposite ways.

## What upstream has

**Two layers, and the client gets first refusal.** `ComposeDefaultKey.cxx:98`
hands every composed line to `LocalCommand::execute` before anything goes to the
server, and only an unclaimed line is sent as `MsgMessage` for the server's
`parseServerCommand` to read. So a `/` line is a *client* command if one matches
and a *server* command otherwise — and three names exist on both sides, where the
local one always wins:

| local only | on both, local wins | server only |
|---|---|---|
| `/bind` `/cmds` `/diff` `/dumpvars` `/highlight` `/localset` `/retexture` `/roampos` `/savemsgs` `/saveworld` `/forceradar` `/silence` `/unsilence` | `/set` `/quit` `/debug` | everything below |

**Around sixty server commands**, in `src/bzfs/commands.cxx` and
`src/bzfs/BanCommands.cxx`, each a `ServerCommand` subclass carrying its own name
and one line of help. `/?` lists them and `/help` pages them.

**A permission per command**, not a role. `Permissions.h:44` names 60-odd
(`actionMessage`, `ban`, `countdown`, `kick`, `setVar`, `talk`, `poll`, …), and a
command asks for exactly the one it needs — `KickCommand` asks `kick`,
`CountdownCommand` asks `countdown`, `SetCommand` asks `setVar`. Groups grant
sets of them out of a users file, so an operator can hand out `/kick` without
handing out `/set`. A handful of commands ask for nothing at all and are open to
everyone: `/?`, `/help`, `/uptime`, `/serverquery`, `/msg`, `/password`,
`/handicap`, `/grouplist`, `/groupperms`, `/owner`. A few more gate through a
helper rather than `hasPerm` — `/flag` through `checkFlagMod`, `/setgroup` and
`/removegroup` through `accessInfo.canSet` — so "no `hasPerm` call" is not the
same as "open".

## What bzo has

**The transport, and the reply channel.** A client already sends
`{ type: 'message', dst, text }`, and the server already speaks back privately as
`{ type: 'message', src: -1, dst: <player>, msgType: 'server', text }` — that is
how a map's `-srvmsg` lines reach a joining player. A command's request and its
answer both have a home already.

**A command table and a dispatcher**, from steps 1 and 2: `handleServerCommand`
in `server.js` is asked before any chat destination, so a `/` line is a command
or an "Unknown command" reply and never something said out loud. The commands so
far are the open tier plus the help.

**One boolean where upstream has sixty permissions.** `isAdmin` in `server.js` is
the whole model: an authenticated player in an `adminGroups` group, or a
connection from this machine when `localAdmin` is on. `refuseNonOperator` is the
gate, and the Operator panel's four messages — `getMaps`, `setMap`, `uploadMap`,
`setOperatorConfig` — are everything behind it.

**The Operator panel is the existing answer to "an operator wants to do
something".** It is a dialog, it is admin-gated on the server, and it works in a
headset. Commands are not a replacement for it; see "Which surface" below.

## Which surface a command belongs to

Both, and the split is not the same as upstream's.

- **The Operator panel stays the primary surface for anything an operator does
  more than once**, because it is the one that works in XR. A headset has no
  keyboard worth typing `/setgroup` into, and bzo's chat entry is a text field
  behind an input context. Upstream has no headset to answer for and made chat
  the only surface; bzo should not inherit that constraint as a design.
- **Commands are the surface for anything the panel would be silly for** — a
  one-off `/kick`, a question like `/uptime`, anything a script or a test client
  wants to drive. This is also why `localAdmin` landed first: a raw WebSocket
  probe can hold operator rights, so commands are testable without a browser.
- **Every command that the panel also offers must call the same function.** The
  panel's `setMap` and a future `/map` are one action with two front ends, and
  the moment they are two functions they will disagree.

**Where the parsing goes: the server, with a small client-local set.** Upstream's
layering is worth keeping — a line starting with `/` is tried locally, then sent
— because the local commands are genuinely local: `/silence` is one client's
choice to ignore somebody, and asking the server about it would be inventing
state. So:

- The client keeps a **local** table for things that are only its own:
  `/silence`, `/unsilence`, `/highlight`, `/localset`-shaped settings, `/cmds`.
  These need no server work at all and can land first.
- Everything else goes to the server as a message whose text begins with `/`, and
  the server parses it. **A `/` line is never broadcast as chat**, whether or not
  a command matches: an unmatched one gets "Unknown command" back, as upstream
  does, rather than being said out loud. That is one line in the `message`
  handler and it should land before any command does, because it is the
  behaviour change players would otherwise notice.

## Permissions

bzo has one boolean and upstream has sixty names. Do **not** port the sixty.

The reason is not effort: it is that upstream's permissions exist to be granted
out of a users file that bzo has no equivalent of. bzo's groups come from
bzflag.org and the server cannot edit them, so `/setgroup` and `/removegroup`
have nothing to write to and the fine grain has nowhere to live.

**Three tiers, keyed on what bzo already knows:**

| tier | who | commands |
|---|---|---|
| open | anybody who has joined | `/?`, `/help`, `/uptime`, `/serverquery`, `/msg`, `/owner`, `/date`, `/time`, `/lagstats`, `/report` |
| operator | `isAdmin` | everything else |
| absent | nobody | see "Deliberately out of scope" |

`/report` sits in the open tier deliberately: upstream gates it on `report`,
which ordinary players hold, and a report nobody can file is worse than no
report command. Same for `/part` and `/quit`, which upstream gates on `talk`.

A `permissions` map in `server.json` — bzflag.org group to a set of command names
— is the shape to grow into **if somebody asks for delegation**, and not before.
It is a config surface, not a rule, and bzo has done this before: team limits
took the shape and skipped the surface until a map needed it.

**Finer grain is expected eventually, and deliberately deferred.** That is a
decision, not an oversight: the two tiers answer every command bzo has, and a
permission model with nothing to grant out of is machinery in front of a boolean.
Revisit it when a real server wants to hand out `/kick` without `/set`.

## The commands, by what bzo has to build

### Needs nothing new (a parser and a reply)

These read state bzo already keeps, or do something bzo already does behind the
Operator panel.

| command | upstream perm | notes for bzo |
|---|---|---|
| `/?`, `/help` | open | `/?` lists the table; `/help` needs pages, and bzo's Help menu is where the text already lives |
| `/uptime` | open | process start time |
| `/serverquery` | open | bzo's version is `public/version.mjs` and rides `init` already |
| `/msg <nick> text` | open | bzo already has private messages by `dst`; this is the same action typed |
| `/me <action>` | `actionMessage` | **not a command**: upstream reformats it in the message path so it keeps its destination (`bzfs.cxx:1490`), and bzo does the same. The wire already carried `msgType: 'action'` and the client already rendered it, so this was an entry point and nothing more |
| `/owner` | open | a `serverOwner` string in `server.json`, or drop it |
| `/date`, `/time` | `date` | trivial, and `date` being a *permission* upstream is worth ignoring |
| `/playerlist` | `playerList` | bzo knows names, slots and addresses; see the IP caveat below |
| `/idlist` | `playerList` | BZIDs, which bzo has from the login |
| `/kill <player>` | `kill_` | `killPlayer` exists and every death goes through `applyDeath` |
| `/say <message>` | `say` | a server-channel broadcast, which bzo already sends |
| `/mute`, `/unmute`, `/mutelist` | `mute` | a per-player flag the `message` handler checks; no persistence needed while it lasts one session |
| `/flag up`, `/flag show`, `/flag reset` | `flagMod` | `zapFlag`, `resetFlag` and the flag table are all there |
| `/flag drop [player]` | `flagMod` | **bzo's own, and deliberate.** Upstream's FlagCommand cannot take a flag off one player, only send every superflag in the world away. Testing a flag means being handed the right one, so this is what `/mv` to a zone needs to be useful. A sticky flag is zapped, as dying with it is |
| `/set` | `setVar` | **only over what bzo already keeps configurable**, which turned out to be narrower than a map's `-set`: it is the three the Operator panel *propagates* (`motd`, `shotMaxActive`, `ricochet`), because anything else would move on the server and leave every client predicting against the old value. `/set` naming anything else says so rather than pretending. `/reset` has nothing to reset to and is not implemented |

### Moving a player between teams -- bzo's own, and wanted

**Upstream cannot do this at all.** There is no `/setteam`, no
`bz_setPlayerTeam`, and no API event for it; `player.setTeam` is called in
exactly three places -- at join (`bzfs.cxx:2309`), for the rabbit anointing
(`:2764`), and for a server-side bot. A player changes team upstream by leaving
and rejoining, which is why every team choice there is made in the join dialog.

bzo already has the mechanism upstream lacks. Rabbit Chase moves a player between
teams server-side every time it anoints, and `newRabbit` is the message that
tells the clients to repaint -- so "set this player's team and broadcast it" is
built and in use. A `/team <player> <team>` is that function with a different
trigger.

**What it unlocks is a match workflow**: everyone arrives as an observer, the
players talk it over, and an operator puts the competitors on teams without
anybody rejoining. That is not something upstream can express, and it is a better
fit for bzo's auto-rejoin than "leave and come back on the right team" is.

Two things it has to decide:

- **The limit is a join-time gate, not an invariant.** `selectPlayerTeam` runs
  only in the `joinGame` handler and nothing rechecks afterwards; team state is
  keyed by team name in `Map`s and counted from the live roster, so no fixed array
  can overflow and a team over its limit is simply a team of that size. So this
  command must apply the limit itself, and decide whether an operator may
  *exceed* it -- overriding is arguably the point of moving people by hand, but it
  should be a decision rather than an accident.
- **A team change is a life change.** The join path already drops the flag,
  re-picks the colour and respawns; moving a player has to do the same, and
  `getJoinPlayerColor` is where the colour rule lives. An observer becoming a
  player also has to stop being white.

### Needs a small piece of machinery first

| command | needs |
|---|---|
| `/kick <player> <reason>` | nothing technically — but see the rejoin note below |
| `/countdown`, `/gameover`, `/modcount` | the match-end machinery in `docs/game-modes-plan.md`. They are that feature's front end and should land with it, not before |
| `/handicap` | the Handicap game style, also in `docs/game-modes-plan.md` |
| `/lagwarn`, `/lagdrop`, `/jitterwarn`, `/jitterdrop`, `/packetlosswarn`, `/packetlossdrop` | **`/lagstats` is done.** Every connection is measured with a `ping`/`pong` round trip (`createLagTracker`, `server.js`), which gives lag, jitter and a loss figure counted off missed pongs; `/lagstats` reports them per player, sorted worst first, with the player index shown to an operator only. What is left is the warn/kick machinery `docs/lag-plan.md` calls step 6: `lagwarn`/`lagdrop` and `jitterwarn`/`jitterdrop` thresholds in `server.json` and on the Operator panel, with these commands as their front end. A packet-loss threshold still waits on a transport that can lose more than a pong |
| `/idlestats`, `/idletime` | last-input time per player, which the anti-cheat code nearly keeps already |
| `/clientquery` | a client version reply; `init` carries the build id, so this is a round trip bzo could answer without asking the client |
| `/showgroup`, `/showperms`, `/grouplist`, `/groupperms` | read-only against what bzflag.org returned for the session. Useful, and honest, as long as nobody expects to *set* anything |

### Needs a whole subsystem

- **Bans** — `/ban`, `/unban`, `/banlist`, `/checkip`, `/hostban`, `/hostunban`,
  `/hostbanlist`, `/idban`, `/idunban`, `/idbanlist`, `/masterban`. A persistent
  store, which `sessions.json` is the pattern for, plus the address problem
  below. **BZID bans are the ones worth building first**: bzo gets a BZID from a
  verified login, it is stable, and it needs no address at all.
- **Polls** — `/poll`, `/vote`, `/veto`. A vote with a quorum, a clock, and the
  `antipoll*` counter-permissions. Sizeable, and worth nothing until a bzo server
  has enough strangers on it to need one.
- **Recording** — `/record`, `/replay`. bzo records nothing.
- **Reports** — `/report`, `/viewreports`. A file to append to and read back;
  small, but it is state.
- **Help pages** — `/help <page>`, `/sendhelp`. Upstream reads chunks out of
  files named by `-helpmsg`, which `docs/bzw.md` already lists as not read.

### Deliberately out of scope

- **`/password`.** Upstream's "become an admin by typing a shared secret". bzo
  has a real login and `localAdmin`; adding a shared password would be a weaker
  gate beside a stronger one, and the weaker gate is the one that gets used.
- **`/setgroup`, `/removegroup`.** Nothing to write to. bzo's groups are
  bzflag.org's.
- **`/shutdownserver`.** Same reasoning as `-g` in `docs/game-modes-plan.md`:
  bzo's server is a web server that reloads its clients on restart, so "stop
  serving" is not an in-game action. Read it and say it is ignored.
- **`/superkill`.** Kicks everyone. It exists upstream so an operator can clear a
  wedged server; bzo restarts in a second and reconnects every client.
- **`/plugins`, `/listplugins`.** No plugin system.
- **`/serverdebug`.** bzo's logging is a file and a level, not a runtime dial.

## Two findings worth knowing before the ban work

**bzo's client address is forgeable as read.** `server.js` takes
`forwardedFor.split(',')[0]` — the *first* element — which is the value a client
prepended if the proxy appended rather than replaced. The README's Apache config
pins it with `RequestHeader set`, so a correctly configured deployment is fine
today and the address is only used for logging anyway. A **ban** cannot rest on a
deployment note: before banning on an address, bzo needs an explicit
trusted-proxy setting and to read the element that proxy contributed, not the
first one in the list. This is the same header `localAdmin` reasons about, and
the two should end up reading it through one function.

**A kick needs an answer to auto-rejoin.** bzo reconnects without waiting for a
click, on purpose (AGENTS.md). A kicked player is therefore back in a few
seconds, so `/kick` has to leave something behind — a short refusal keyed to the
session or the BZID — or it is a no-op with a rude message attached. That makes
`/kick` a *ban* feature wearing a kick's name, and it is why the two are one
piece of work here rather than two.

## Suggested order

1. ~~**`/` never reaches public chat**, plus `/?` and `/help`.~~ **Done.** It
   needed no client work at all: bzo's chat entry does not echo locally, so the
   server declining to broadcast a `/` line is the whole of it.
2. ~~**The open tier**: `/uptime`, `/serverquery`, `/msg`, `/date`, `/time`.~~
   **Done**, with `/<prefix>?` as well -- upstream's `CmdHelp`, and the only
   per-command help either of us has.
3. ~~**The operator tier over things that already exist**: `/kill`, `/say`,
   `/mute`, `/flag`, `/playerlist`, `/set`.~~ **Done**, plus `/mv`. `/set`
   reaches the three settings the Operator panel already propagates, and both now
   write through one `applyServerConfigChanges` -- the rule above, honoured.
4. **The client-local set**: `/silence`, `/unsilence`, `/highlight`, `/cmds`.
   Independent of everything above, and pure client work.
5. ~~**Lag measurement**~~ **Done**: every connection's lag, jitter and loss are
   tracked and `/lagstats` reports them. `/lagwarn`, `/lagdrop`, `/jitterwarn`,
   `/jitterdrop` and the idle commands still wait on the warn/kick machinery
   (`docs/lag-plan.md` step 6) and on last-input tracking, respectively.
6. **BZID bans**, then `/kick` on top of them.
7. Match-end commands with the match-end feature; `/handicap` with Handicap.
8. Polls, reports, recording — each when something wants them.

Steps 1 to 4 are all reachable without new state, which is most of the value.
