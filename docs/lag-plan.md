# Lag measurement

Design and staging plan for measuring each player's lag, jitter and packet loss
the way bzfs does, and for acting on it. Upstream references are paths under
`$HOME/bzflag/`.

Nothing here is built yet. bzo sends no timestamp and no sequence number with a
move, so it cannot measure any of this today.

## Why bzo needs it more than bzfs does

The server decides kills, so it extrapolates every tank between packets and
compares what a client claims against where it believed that tank was. Both of
those read a clock, and today the only clock either reads is the server's own
receive time -- so network jitter lands inside the number the anticheat judges.

`validateMovement` in `server.js` takes `(now - player.lastUpdate) / 1000` as the
time a client had to move in. A packet that spent an extra 80ms in the network
buys its sender 80ms of travel against `linearDriftThreshold`, and a burst of
jitter looks exactly like a client that teleported. The thresholds in
`server.json` (`linearDriftThreshold` 3, and 20 when the velocity changed) are
wide enough to swallow that, which is the same thing as saying they are too wide
to catch what they are for.

Upstream does not have this problem in the same shape, because bzfs lets each
client report its own hits and only sanity-checks positions. bzo moved that
decision to the server on purpose (see "Damage rules are decided on the server"
in `AGENTS.md`), and this is the part of the bill that has not been paid.

## What upstream has

**A client timestamp is the first field of a player update.**
`MsgPlayerUpdate` and `MsgPlayerUpdateSmall` unpack a float before anything else
(`bzfs.cxx:5288`), and it is the client's own clock, not the server's.

**`PlayerState` carries an `order`** -- "packet ordering", a monotonically
increasing sequence number (`PlayerState.h:51`). A gap in it is a lost or
reordered update.

**Both land in one call.** `GameKeeper::Player::setPlayerState`
(`GameKeeper.cxx:501`) keeps the client's stamp and the server's side by side:

```cpp
lagInfo.updateLag(timestamp, state.order - lastState.order > 1);
lastState       = state;
stateTimeStamp  = timestamp;                                   // the client's clock
serverTimeStamp = (float)TimeKeeper::getCurrent().getSeconds(); // ours
```

**Jitter is the disagreement between the two clocks' intervals.**
`LagInfo::updateLag` (`src/game/LagInfo.cxx`):

```cpp
const float jitter = fabs((float)(info->now - lastupdate) - (timestamp - lasttimestamp));
jitteravg   = jitteravg * (1 - jitteralpha) + jitteralpha * fabs(jitter);
jitteralpha = jitteralpha / (0.99f + jitteralpha);
```

Two details worth keeping, because they are the difference between a usable
number and a noisy one:

- **The smoothing factor is dynamic.** `alpha = alpha / (0.99 + alpha)` decays
  toward zero, so an average is responsive while a player is new and steady once
  there is history behind it. Packet loss runs its own `lostavg`/`lostalpha`
  pair on the same scheme.
- **A gap over two seconds is not measured at all.** `lasttimestamp > 0 &&
  timestamp - lasttimestamp < 2.0` -- across a pause, a menu or a tab in the
  background there is no interval worth comparing, and folding one in would
  poison the average with something that is not lag.

**Lag itself is measured by a ping, not by the update stream.** `MsgLagPing`
round-trips and `LagInfo::updatePingLag` records it; the update timestamp feeds
jitter and loss. Keeping those separate matters: an update interval cannot
distinguish a slow network from a slow frame rate.

**And upstream acts on all three.** `-lagwarn`/`-lagdrop`,
`-jitterwarn`/`-jitterdrop` and `-packetlosswarn`/`-packetlossdrop`, with
`/lagwarn`, `/lagdrop` and friends to change them while the server runs
(`commands.cxx:595`). A player is warned some number of times and then kicked.
`/lagstats` prints the table.

## Staging

1. **Send the two fields.** A client timestamp and an `order` on every move
   packet. The protocol here is lockstep, so both ends change in the same edit
   and neither side defaults a missing field -- see "Client/server protocol is
   lockstep" in `AGENTS.md`.

2. **A `lag` shared pair.** `public/lag.mjs` and `server/lag.cjs`, holding
   `updateLag`'s arithmetic -- the dynamic alpha, the two-second gate, the
   jitter and loss averages -- with a parity test in `scripts/test-lag.mjs`, as
   every pair must have. The client wants the same numbers to show the player
   their own lag, which is what makes it a pair rather than server-only code.

3. **Extrapolate on the client's clock, not ours.** `validateMovement` and
   `getExtrapolatedPosition` take the interval between the client's own
   timestamps, and the server's receive time becomes what it is upstream: an
   input to jitter, not to physics. This is the step that lets the drift
   thresholds be tightened, and tightening them is the point of the exercise --
   they should be re-derived once the measurement exists, not before.

4. **A lag ping.** `MsgLagPing`'s equivalent, so lag is measured by a
   round-trip rather than inferred from the update stream.

5. **Warn and kick.** `lagwarn`/`lagdrop`, `jitterwarn`/`jitterdrop`,
   `packetlosswarn`/`packetlossdrop` in `server.json` and on the Operator panel,
   with `/lagwarn`, `/lagdrop`, `/lagstats` to match upstream's commands. Report
   it in the scoreboard the way upstream's does.

**Order matters between 1-3 and 5.** Kicking on a number bzo has never measured
is how an honest player on a bad connection gets thrown out; get the measurement
right and read it for a while first. `mode: "warning"` in `antiCheat` exists for
exactly that reason and should be the default here too.

## Open questions

- **Whose clock, and can it be trusted?** The timestamp is a *client's* number
  and a modified client can send whatever it likes. Upstream accepts that,
  because a lie only distorts that player's own lag statistics. It stops being
  harmless the moment step 3 lets the timestamp decide how far a tank was
  allowed to travel: a client that inflates the interval buys itself speed. The
  answer is probably to clamp the interval to the server's own measurement plus
  a jitter allowance -- so the client's clock can refine the number but never
  exceed what the server saw -- but that needs stating and testing before it is
  relied on.
- **`performance.now()` or `Date.now()`?** The first is monotonic and immune to
  a clock adjustment mid-game, which is what this wants, but it is an origin per
  page rather than a wall clock. Only intervals are ever compared, so an
  arbitrary origin is fine and monotonicity is worth more.
- **What does a headset do here?** An XR session's frame pacing is the runtime's,
  and a dropped frame there is not a network event. Whatever kicks on jitter has
  to not fire on a headset that is merely busy.
