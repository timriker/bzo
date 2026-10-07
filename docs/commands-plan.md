# Server commands

Design and staging plan for the bzfs chat commands bzo does not have. Upstream
references are paths under `$HOME/bzflag/`.

Issue #5 tracks this; reference it from every commit and changelog entry here, as
flag work references #6 and game modes reference #42.

`server/commands.cjs` holds the parsing and the formatting; the table and the
dispatcher are in `server.js`. The commands are `/?`, `/help` and
`/<prefix>?`; the open tier `/uptime`, `/serverquery`, `/msg`, `/date`,
`/time`, `/lagstats`, `/pos`; and the operator tier `/kill`, `/say`, `/mute`,
`/unmute`, `/mutelist`, `/playerlist`, `/flag` (`reset`, `up`, `show`, `take`,
`give`, `drop [player]`), `/set`, `/reset`, `/mv`, `/setteam`, `/bot`,
`/countdown` and `/gameover`, plus `/me`. The client-local table -- `/silence`, `/unsilence`,
`/highlight`, `/savemsgs`, `/cmds` -- lives in `public/client.js` and never
reaches the server. See "Server commands" in `AGENTS.md`.

**`/mv` is bzo's own.** Upstream has no command that moves a tank -- not in bzfs,
not in `BanCommands`, not in any plugin, and there is no API call for it either.
It is here because bzo is developed by driving it: `testSpawn` in `server.json`
does this on join, and `/mv` is the same thing without a restart. On an
observer it moves the roaming camera, into free roam, and a fifth value -- a
Share View Link's pitch -- tilts it. Whoever was moved is told who did it.

**`/setteam` is bzo's own too.** 2.5 lets a client change its own team
(`MsgSetTeam`); nothing lets an operator. `/setteam <player> <team>` moves a
player between playing teams in place: the flag drops, the tank takes the new
colour and keeps driving. Observer, rabbit and hunter are out of its reach.
A BZFlag client is covered in [bzflag-clients.md](bzflag-clients.md).

A tank holding Oscillation Overthruster is placed exactly where it was asked
to go, with no altitude resolved for it. Every other tank has its height
settled the way a spawn does -- falling to the ground where it fits and
climbing to the roof where it does not -- and resolving it for a phased tank
would refuse the one placement worth asking for, since being inside the wall is
where an OO tank is supposed to be able to sit and is how the sealed state is
reached on purpose.

A facing is one of the eight compass points, or an exact angle. The angle is
bzo's own rotation in degrees rather than a compass bearing, which is the
convention a Share View Link's `pos=` tail already carries and the reason a
number is taken at all (issue #109). The two run opposite ways, so that is said
out loud in `AGENTS.md` and the reply names the facing the tank ended up with.

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

**A command table and a dispatcher**: `handleServerCommand` in `server.js` is
asked before any chat destination, so a `/` line is a command or an "Unknown
command" reply and never something said out loud.

**One boolean where upstream has sixty permissions.** `isAdmin` in `server.js` is
the whole model: an authenticated player in an `adminGroups` group, or a
connection from this machine when `localAdmin` is on. `refuseNonOperator` is the
gate, in front of the operator-tier commands and the Operator panel's
messages.

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
  `/silence`, `/unsilence`, `/highlight`, `/savemsgs` and `/cmds` (**all done**
  -- see "Server commands" in `AGENTS.md`), plus `/localset`-shaped settings, which
  wait on bzo having client-local settings worth naming this way. These need
  no server work at all and could land first, which is why they did.
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
| `/flag up`, `/flag show`, `/flag reset` | `flagMod` | `zapFlag`, `resetFlag` and the flag table are all there. `show` prints upstream's own line (`FlagInfo::getTextualInfo`) and nothing else, as upstream does: a superflag nobody holds travels anonymous, and the asking operator's own map fills in because their client reads those lines back (`parseFlagInfo` in the `flags` pair) and keeps every identity it is told. One reader, so a proxied server's reply fills the map in too. `reset` still takes no argument and means upstream's `reset all`; its arguments (`all`, `unused`, `team`, `#flagId`, a flag abbreviation, `noteam`) are not ported |
| `/flag take <player>`, `/flag give <player> <flag> [force]` | `flagMaster` | upstream's own, whole, `flag` being a `#flagId` or an abbreviation: `take` resets the flag off a tank, `give` resets or drops whatever the tank was carrying, takes the flag off its current holder when `force` says so, and refuses a dead player. bzo's two tiers put them behind OPERATOR with the rest rather than porting the `flagMod`/`flagMaster` split |
| `/flag drop [player]` | `flagMod` | **bzo's own, and deliberate.** Upstream can take a flag off a tank (`take`) but only by sending it back to a spawn point; `drop` throws it on the ground where the tank is standing, which is what `/mv` to a zone needs to be useful for testing. A sticky flag is zapped, as dying with it is |
| `/set` | `setVar` | any world variable, formulas included, in upstream's words: `_name set` to the setter and a Variable Modification Notice to everyone, `_name is <value>` to ask, `does not exist` and `is not writeable` as upstream refuses. Every client is told as `MsgSetVar` tells it (`setVar`) and evaluates the change itself, so it is live everywhere. bzo's own `motd`, `shotMaxActive` and `ricochet` keep working beside them |
| `/reset` | `setVar` | `/reset _name` or `/reset *`, back to upstream's own default, with the Variable Reset Notice to admins |

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
| `/modcount` | adjusting a running match clock, beside `/countdown` and `/gameover` |
| `/handicap` | the Handicap game style in `docs/game-modes-plan.md` |
| `/lagwarn`, `/lagdrop`, `/jitterwarn`, `/jitterdrop`, `/packetlosswarn`, `/packetlossdrop` | the warn/kick machinery `docs/lag-plan.md` calls step 6: `lagwarn`/`lagdrop` and `jitterwarn`/`jitterdrop` thresholds in `server.json` and on the Operator panel, with these commands as their front end. A packet-loss threshold still waits on a transport that can lose more than a pong |
| `/idlestats`, `/idletime` | last-input time per player, which the anti-cheat code nearly keeps already |
| `/clientquery` | a client version reply; `init` carries the build id, so this is a round trip bzo could answer without asking the client |
| `/showgroup`, `/showperms`, `/grouplist`, `/groupperms` | read-only against what bzflag.org returned for the session. Useful, and honest, as long as nobody expects to *set* anything |

### Needs a whole subsystem

- **Bans** — `/ban`, `/unban`, `/banlist`, `/checkip`, `/idban`,
  `/idunban`, `/idbanlist` and `/kick` are built, kept in `bans.json`
  (`server/bans.cjs`; [ban-plan.md](ban-plan.md)). `/hostban` and
  `/masterban` are not.
  `/poll kill|set|flagreset`, `/vote` and `/veto` are built
  (`server/polls.cjs`); the `antipoll*` counter-permissions have no group to
  live in yet.
- **Recording** — `/record` is built, and `/replay stats` and `list` in a
  replay room ([replay.md](replay.md)); the rest of `/replay` is
  [replay-plan.md](replay-plan.md).
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

## Address bans

[ban-plan.md](ban-plan.md).

## Suggested order

1. `/modcount`; `/handicap` with Handicap.
2. `/lagwarn` and friends with `docs/lag-plan.md` step 6; the idle commands
   with last-input tracking.
3. Reports, when something wants them.
