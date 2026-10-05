# Game modes

Design and staging plan for the BZFlag game types and game styles bzo does not
have yet. Upstream references are paths under `$HOME/bzflag/`.

Handicap is issue #62.

## What upstream has

Upstream splits "how does this server play" into two independent things.

**One game type per server** (`include/global.h:94`), chosen by mutually
exclusive switches and advertised in the ping reply so the server browser can
label the row:

| type | switch | shape |
|---|---|---|
| `TeamFFA` | default | colour teams, team scores move on kills, no bases |
| `ClassicCTF` | `-c`, `-cr` | colour teams, bases, team flags; team scores move on captures only |
| `OpenFFA` | `-offa` | no teams at all, every player a rogue, no team scores |
| `RabbitChase` | `-rabbit` | one rabbit against every hunter, no team scores |

**Any combination of game styles** (`include/global.h:102`), a bitmask on top of
the type: `SuperFlag`, `Jumping`, `Inertia`, `Ricochet`, `Shakable`, `Antidote`,
`Handicap`, `NoTeamKills`.

**Match end is a third thing**, tied to neither: `-mps` a player score limit,
`-mts` a team score limit, `-time` a clock, `-timemanual` to start that clock
from `/countdown`, `-g` to serve one game and exit.

## What bzo has

All four game types, the match-end switches except `-g`, and seven of the
eight game styles: superflags (`+s`/`-s`), jumping (`-j`), inertia (`-a`),
ricochet (`+r`), shakable (`-st`, `-sw`), antidote (`-sa`) and no-team-kills
(`-noTeamKills`). See "Game types", "Rabbit Chase" and "Match end" in
`AGENTS.md`. **Handicap is missing.**

## Handicap

`-handicap` gives whoever is losing a faster tank. Issue #62, which also asks
for size and agility on top of upstream's speed. Upstream splits it in half: the
server computes a number, the client turns it into speed.

- **The number is one scalar per player**, the same on every screen.
  `recalcHandicap` (`bzfs.cxx:2077`) sums, over every other present real
  non-observer player, how many times they killed me minus how many times I
  killed them, clamped at zero. The pairwise terms collapse -- that sum is just
  *deaths caused by opponents currently in the game* minus *kills of opponents
  currently in the game*. A player 10-0 against one opponent and 0-10 against
  another has a handicap of zero.
- **The kill matrix exists for what it excludes, not to be per-opponent.**
  A suicide is recorded (`victimData->player.killedBy(killerIndex)`,
  `bzfs.cxx:3360`) but the recalc loop skips `i == playerIndex`, so it never
  counts -- while `Score::losses` does increment for one. Departures are
  subtractable: `removePlayer` calls `flushKiller` on every remaining player
  (`bzfs.cxx:2872`) and then recomputes and broadcasts the whole table
  (`bzfs.cxx:3035`). Observers drop out of the sum, and a world weapon's kill
  lands under `ServerPlayer`, which the loop never visits.
- **The effect** is `playing.cxx:3010` and `LocalPlayer.cxx:1136`: the raw number
  is divided by `_handicapScoreDiff` (50) and clamped to 0..1, then scales tank
  speed by up to `_handicapVelAd` (2.0), angular velocity by `_handicapAngAd`
  (1.5) and shot speed by `_handicapShotAd` (1.75). Advantages only -- a player
  who is winning gets nothing, never a penalty. Only `LocalPlayer` reads it;
  remote tanks store the number and nothing looks at it, so the handicap changes
  nothing about how an opponent is drawn, sized or hit.
- **Upstream's own checks stay loose rather than per-player.**
  `adjustTolerances` multiplies the *global* speed tolerance by `velAd` squared
  whenever the style is on (`bzfs.cxx:4434`), and the shot-fired path uses the
  maximum multipliers (`bzfs.cxx:4149`). Nothing narrows for a particular
  player, so nothing can narrow underneath one.
- `/handicap` lists everyone's value as a percentage (`commands.cxx:2069`).

### The number bzo keeps

One new integer per player: **deaths at another player's hand**, excluding
suicides and world weapons. bzo's `wins` already excludes both those and team
kills (`killPlayer` in `server.js` scores a team killer a loss), but `losses`
counts every way to die, so it cannot serve on its own. The handicap is then
that counter minus `wins`, and it reaches clients as the two integers rather
than as a matrix.

That drops upstream's *present opponents* rule deliberately. Roster membership
must not be an input, because a client whose `playerLeft` has not landed yet
would compute a different number from the same scores. It also cuts the other
way on fairness: upstream rewards a dominant player with a handicap boost as
soon as their victims quit, which reads backwards.

### Both ends derive it; neither end derives it from a derivation

The client computes its own handicap from the integers it was **told**, through
a shared pure function in the `flags` pair, exactly as it derives speed, size
and hit radius from the flag letter it was told. Integer arithmetic on identical
inputs cannot drift, so the client's multiplier and the server's bound agree by
construction.

What makes that safe is the scores being *assigned* rather than *derived*, and
today they are not. bzo has no player-score message: the client increments off
`killed`, +1 kill to the shooter and +1 death to the victim, which is already
wrong for a team kill and heals only when the killer next respawns. Upstream
sends absolute wins/losses/tks for killer and victim after every kill
(`sendPlayerScores`, `bzfs.cxx:3487`) and its client applies whatever delta
reaches that absolute value (`playing.cxx:3056`), so an upstream client never
computes a score and silently self-corrects on every kill. **bzo has to do the
same before the handicap can be derived from a score.** Team scores are already
right: `broadcastTeamScores` sends absolute values on every kill, capture, join
and part, and the client only stores them.

`handicap` still rides `getState()`, which costs nothing new -- it is the
authoritative value to reconcile the derived one against at every respawn, and
a divergence there is a bug report rather than a silent drift.

### Where it plugs in

Everything is keyed on one value already, so the composition is a handful of
signatures in the `flags` pair:

- `getMaxSpeedFactor` and `getMaxAngVelFactor` take the handicap beside the
  flag. `fs` and `rs` are fractions of the world's *base* speed and turn rate
  and a boosted tank already reports above 1 -- that is how `V`, `QT` and `A`
  work -- so raising the same bound is the whole of the anti-cheat change. No
  new tolerance mechanism.
- `getTankDimensionScale` takes it too, and size then lands everywhere at once:
  drawn tank, hit sphere, world collision, roller reach and teleporter fit, with
  no new wire field, because both ends already compute the scale from inputs
  they hold.
- **Changing mid-life needs nothing new.** `O` Obesity is `OBESE_FACTOR` 2.5 and
  is sticky and bad -- a growth the player cannot drop, arriving mid-life, that
  can wedge a tank and will not fit a teleporter. bzo already answers all of
  that by stepping the authoritative size at the moment the flag changes hands
  and easing only the drawn tank. A handicap step is a fraction of Obesity's and
  follows the same rule.

Quantize the handicap into a few notches rather than letting it move on every
kill. That is tuning rather than correctness: it keeps the rate of change in the
same range as flag changes.

### Agility already means something here

`A` Agility is `_agilityAdVel` 2.25 for `_agilityTimeWindow` after a stick
change of `_agilityVelDelta`. So issue #62's "agility" is two candidates:

- **Turn rate**, which is `_handicapAngAd` and is upstream's second multiplier.
  Ship this one.
- **The acceleration limit**, `-a` composed through `getAccelerationLimits`.
  This is the one that makes a camper feel sluggish, but it only bites on a
  world that actually sets `-a`; the default is no limit, where it does nothing.
  If it is wanted, name it for the acceleration limit rather than for agility.

### Advantage only, or a penalty for the leader

Upstream clamps at zero and says so in place. Issue #62's camper -- slower turns
and a larger hitbox for whoever is winning -- is a penalty, and giving losers a
smaller hitbox does not make the camper's bigger, so it is a deviation rather
than a reading of upstream.

Build signed, ship clamped. The wire carries the signed value, upstream's own
number before its `std::max(0, relscore)`; the shared derivation takes the
signed normalized figure; and `server.json` decides whether the negative half is
honoured or clamped to zero. Default clamped is parity, and the camper is a
config change rather than a rewrite. A negative handicap needs the scoreboard
column to show it, or a leader whose tank got worse has no way to know why.

### `_handicapScoreDiff` 50 is wrong for a bzo-sized server

Fifty *net* deaths against the field is tuned for a large public server grinding
for an hour. At a relative score of 10 the normalized handicap is 0.2: speed
1.2x, turn 1.1x. On a four-player game nobody reaches 50 and the feature never
engages. All four `_handicap*` figures belong in `GAME_CONFIG`, which already
ships in `init`, rather than as constants in the `flags` pair -- both because
the client must derive from the same curve the server used, and because this one
needs retuning against a real game before parity means anything.

### The anti-cheat window

The only genuinely racy part, and it is one-sided. The handicap rising is safe:
the player died, the client keeps driving below a bound that just went up, and
`alive` carries the new state before the tank can move again. The
handicap *falling* is the problem -- it falls when the player scores a kill, the
server tightens at once, and the client goes on driving at the old factor for
half a round trip. A shockwave that takes five tanks drops it five notches in
one tick, so a fixed one-notch tolerance fails exactly when the change is
largest.

Upstream's answer to the same shape of problem is a flat amnesty:

```cpp
// Don't kick players up to 10 seconds after a world parm has changed,
if (now - lastWorldParmChange > 10.0f)
```

`bzfs.cxx:5331`, ten seconds after anything that moves the physics out from
under a client (`:5637`, `:5686`). It suspends the *kick*, not the simulation.

bzo already has the mechanism: `reportCheat(player, kind, headline, detail,
enforceable)` computes `refused = enforceable && mode === 'strict'`, so passing
`enforceable: false` logs the warning and never refuses the move. Hang a
per-player expiry on any server-originated change to a motion bound -- a flag
granted, a flag stripped by a Thief, a handicap notch, a spawn -- and pass
`enforceable: false` for the affected check kinds while it is open. Position and
collision checks keep enforcing throughout, which is what stops the window being
a free teleport.

**That window is not handicap work.** A flag taken away by a Thief drops
`getMaxSpeedFactor` from 1.5 to 1.0 on the server while the client is still
sending the old `fs`, and `mode` defaults to `strict`, so this is already live.
Check the `speedClamped` warnings on `bz.rikers.org` against flag-loss events
before building on it; if it fires today it is a bug to fix first, and the
handicap inherits the fix.

See `docs/lag-plan.md` for the clock the expiry is measured on and for the round
trip that sizes it.

### The rest

- **Where it shows.** A percentage column on the scoreboard, only when the style
  is on, and `/handicap` beside upstream's own -- one `defineCommand` at
  `COMMAND_TIER.OPEN`, sorted and formatted as `commands.cxx:2069` does.
- Config: `"handicap": true` in `server.json`, `-handicap` in a map's `options`
  block.
- XR: nothing to draw beyond the scoreboard column.

### Order

1. Absolute scores on the kill message, and delete the unused
   `getTeamScoreDeltasForCapture` export from `public/teams.mjs` -- a mirrored
   copy of authoritative scoring logic that nothing calls.
2. The bound window as `enforceable: false` (`docs/lag-plan.md` step 3),
   sized from the measured round trip.
3. The counter, the shared derivation, speed and turn.
4. Size, then the signed half behind its config.

## Publishing to the list server

Worth knowing because the score limits and the clock are fields in the
packet a public server publishes, so keeping upstream's names and units saves
a translation later.

**The list server itself is plain HTTP.** `ListServerLink` is a `cURLManager`
subclass that POSTs form-encoded bodies to `https://my.bzflag.org/db/`
(`DefaultListServerURL`, `include/Protocol.h:42`):

```text
action=ADD&nameport=<host:port>&version=BZFS0221&gameinfo=<58 hex chars>
&build=<app version>&checktokens=<callsign@ip=token...>&groups=<...>
&key=<publickey>&advertgroups=<...>&title=<url-encoded description>
```

`REMOVE` on shutdown, waiting up to three seconds for it. `ADD` again every 15
minutes (`ListServerReAddTime`, `bzfs.cxx:84`) and on every join and every part
(`bzfs.cxx:2496`, `:2997`), because the same request carries the player counts.
Clients read the list the same way -- `action=LIST&version=BZFS0221`, plus
callsign and password if they want a login token
(`src/game/ServerList.cxx:273`). No binary anywhere in that path.

**`gameinfo` is `PingPacket::packHex`** (`src/game/Ping.cxx:228`): eight
`uint16` then thirteen `uint8`, each written most significant nibble first as 4
and 2 hex digits, 58 characters exactly, in this order --

`gameType`, `gameOptions`, `maxShots`, `shakeWins`, `shakeTimeout` (**tenths of
a second**), `maxPlayerScore`, `maxTeamScore`, `maxTime` (seconds),
`maxPlayers`, then a count and a maximum for each of rogue, red, green, blue,
purple and observer.

`gameType` is the enum value 0..3 and `gameOptions` the bitmask: `SuperFlag`
`0x0002`, `Jumping` `0x0008`, `Inertia` `0x0010`, `Ricochet` `0x0020`,
`Shakable` `0x0040`, `Antidote` `0x0080`, `Handicap` `0x0100`, `NoTeamKills`
`0x0400`. Rabbits and hunters are counted as rogues (`bzfs.cxx:864`), and a
server whose automatic countdown has ended reports **no players at all** so it
can empty and start a new game (`bzfs.cxx:839`).

**But the row is a raw TCP endpoint, and that is the blocker.** `nameport` is a
host and port -- 5154 by default -- and a client that reads the row dials it
directly with the binary protocol; the server answers by writing eight bytes of
`BZFS0221` and a player id before any message (`bzfs.cxx:1399`). The row has no
URL field, no transport field, and nothing in the path proxies: the list server
is a directory of host:port pairs. A client also drops any row whose version
string is not exactly its own and whose `gameinfo` is not exactly 58 characters
(`ServerList.cxx:112`).

**The whole path is IPv4 only.** The client reads a row's address with
`sscanf(address, "%d.%d.%d.%d")` and range checks four bytes
(`ServerList.cxx:120`), so there is nowhere to put an IPv6 address; released
bzfs does not listen on IPv6 either, and `my.bzflag.org` publishes no AAAA
record. That is a constraint on the row, not on bzo: `bz.rikers.org` publishes
both families, so a row would carry the v4 address and the AAAA record would go
on serving browsers as it does now. Dual stack is not what stands in the way --
the transport is.

So bzo cannot usefully be listed as it stands. Publishing is easy -- one HTTPS
POST and a 58-character string -- but being listed is a *promise to accept a
binary TCP connection*, and bzo speaks WebSocket and JSON over TLS. A row would
put an address in front of every BZFlag client claiming protocol `0221`
compatibility that bzo does not have. **The packet format is not what stands in
the way**, which is why there is nothing to build here yet.

The ways out, none of them small: speak the binary protocol on a TCP port beside
the web server, which is a second server and the ping packet is the least of it;
publish to a bzo-specific directory, where reusing this exact blob costs nothing
and buys tooling that can read either; or get a web-client field into the list
server, which is a conversation upstream rather than a patch here.

The middle one is built: `docs/list-server.md`, issue #46. `my.bzflag.org`
itself never did support adding a bzo server, for exactly the reasons above.

What to do meanwhile: keep upstream's field names and units --
`shakeTimeout` in tenths of a second, `maxTime` in seconds -- because bzo
already holds every field in that packet, and a publisher would then be a
pure formatting function. Do not write the packer.

The `checktokens=` parameter above is the other half of the same API, and the
one part of it bzo could use today: see "Admins and the admin channel" in
`AGENTS.md` for what a real login would look like.

## Adjacent switches, deliberately out of scope

- **`-g`**, serve one game and exit. Not worth having: bzo's server is a web
  server that reloads its clients on restart. Read the switch, log that it is
  ignored, and say so in `docs/bzw.md`'s ignored list.
- **`-sb`**, tanks respawning on buildings. A spawn rule rather than a game
  mode, but it is the one remaining spawn switch bzo does not read; worth its
  own small change alongside the spawn code, not here.
- **`-tkkr`** and **`-tkannounce`** -- kicking and announcing team killers. Both
  are cheap now that there is an admin channel to announce into, and both belong
  with the team-kill code rather than with game modes.
- **`-mp`** is already read, per team, from `server.json` and from a map.
