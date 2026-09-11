# Lag measurement

Design and staging plan for measuring each player's lag, jitter and packet loss
the way bzfs does, and for acting on it. Upstream references are paths under
`$HOME/bzflag/`.

Nothing here is built yet, but less is missing than it looks. A move already
carries `sdt`, the client's own interval since its last send, and the server
already round-trips a WebSocket ping. Between them, jitter and a round trip are
measurable without changing the protocol at all. Only a sequence number is
genuinely absent, and TCP means bzo does not need one.

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

**Upstream's client never sees any of it.** There is no lag column on the
scoreboard, no `Player::setLag`, and `MsgLagState` (`Protocol.h:86`) is declared
and referenced nowhere. The only path to a player is `/lagstats`
(`commands.cxx:1979`), which sorts the roster by lag, formats each row with
`LagInfo::getLagStats` and sends each as a chat message to whoever asked:

```
callsign                : 123 +- 12ms 3% lost/ooo
```

An admin gets a `[idx]` prefix; an observer gets only the lag, since it sends no
updates to measure jitter from. Anyone may run it
(`nonAdminModes`, `ServerCommandKey.cxx:24`). One detail is worth keeping: with
a ping outstanding the row reports the *provisional* higher figure --
`max(lagavg, lagavg blended with time since the ping went out)` -- so a client
that has gone quiet does not read as healthy.

## What bzo already has

**`sdt` is upstream's update timestamp in a different shape.** A move carries
`dt`, the frame it was measured over, and `sdt`, how long the client took to get
from the previous packet's speeds to these. The server measures its own arrival
gap for the same pair of packets. Upstream's jitter is exactly the disagreement
between those two:

```
jitter = |arrival gap - sdt|
```

`getAccelerationWindow(deltaTime, message.sdt)` in `server.js` already holds both
numbers and already bounds how far it trusts the client's half
(`SDT_JITTER_ALLOWANCE`). So jitter needs no new field, and upstream's absolute
timestamp is only needed if the extrapolation is ever moved onto the client's
clock.

**The round trip is already being thrown away.** `WS_PING_INTERVAL` sends
`ws.ping()` and the handler records `lastPongTime` for liveness only. Recording
the send time makes the round trip fall out, with no new message -- ping and
pong are WebSocket frames. The interval is 30 seconds against upstream's 10
(`nextping += 10.0f`), which is too slow to watch a connection change.

**Packet loss and out-of-order are the transport's to give back.**
`PlayerState::order` exists because `MsgPlayerUpdate` rides UDP and can arrive
twice, late or never. bzo is WebSocket over TCP, which delivers in order or not
at all, so there is nothing for an `order` field to detect *today* and no loss
average to keep from the update stream. What TCP gives instead is head-of-line
blocking: a stalled socket delivers a burst of stale moves, which is what `sdt`
and the jitter figure are for. A missed pong is the only loss bzo can currently
see.

**That is a property of the transport, not a decision.** Write the measurement
so an `order` field can be added without rearranging it, and know what would
require one:

- **HTTP/3 on its own changes nothing.** A QUIC stream is still reliable and
  ordered, and so is a WebSocket bootstrapped over HTTP/3 (RFC 9220). Moving
  the existing traffic onto H3 would remove *cross-stream* head-of-line blocking
  and nothing else.
- **WebTransport is the one that matters.** Its datagrams are unreliable and
  unordered, which is upstream's UDP in a browser. The moment a move rides one,
  `order` becomes necessary, `lostavg` from the update stream becomes real, and
  upstream's `state.order <= lastState.order` stale-packet drop has to exist or
  an old position will overwrite a new one.
- **An intermediate step exists**: one QUIC stream per concern keeps reliability
  while stopping a stalled bulk transfer from delaying a move.

None of that is buildable now -- Express does not speak H3 and Node's QUIC is
experimental -- so the field is not worth adding yet. It is worth not designing
it out.

## One clock read per frame, one per handler

**Upstream's client does exactly this and calls it a tick.**
`TimeKeeper::setTick()` / `getTick()` -- "returns a timekeeper that is updated
periodically via setTick" (`TimeKeeper.h:71`) -- sampled once at the top of the
play loop (`playing.cxx:6999`) and read 64 times against 39 direct
`getCurrent()` calls. The cached value is the default and the fresh read is the
exception.

**Upstream's server does not.** `bzfs` calls `getCurrent()` 90 times and never
calls `setTick()`. Its only cached sample is `PlayerInfo::now`
(`setCurrentTime`, `bzfs.cxx:7060`), read by `LagInfo` alone. So the server half
of this is an improvement on upstream rather than parity.

The rule, and it is what upstream's own exceptions follow: **read the cached
value unless the fresh reading is itself the measurement.** Upstream's remaining
direct calls are network measurement -- `ServerLink`'s connect and packet
timing, and `LocalPlayer.cxx:1265`, the shot timestamp the server differences.
Its effect start times, cursor blink and rain timing are drift from its own
discipline, not counter-examples.

For bzo:

- **The client** samples once per frame. Every `Date.now()` in `client.js` reads
  that instead, logging excepted. The move packet is assembled inside the frame
  loop, so `sdt` is already frame-quantized and loses nothing by it.
- **The server** samples once per handler entry. Node's message handlers are
  their own event-loop turns, so there is no single pass that both reads sockets
  and steps the game, and "once per loop" is not available. The win here is
  consistency rather than cost -- several checks inside one move handler read the
  clock independently today and can straddle a millisecond, disagreeing about
  *now* within one packet. That is the same reason upstream caches
  `PlayerInfo::now`: its jitter formula differences two timestamps and would
  otherwise be measuring its own execution.
- **Do not coarsen past a handler.** `getAccelerationWindow` returns 0 when the
  arrival gap is not positive, and the caller skips the whole acceleration check
  when it does. Two packets sharing one cached timestamp would silently disable
  the second one's check.

Measured on one development machine: `Date.now()` 75ns, a counter read 1.4ns,
`process.hrtime.bigint()` 145ns. The last of those rules itself out as the
monotonic alternative. A tick counter bumped beside the cached timestamp is
worth having wherever a value is only ever compared with other ticks, because a
wall clock can step under an interval and a counter cannot.

## The bound window

Any server-originated change to what a tank may do opens a race the client
cannot avoid: the server applies it at once, the client hears half a round trip
later, and every packet in between is driven against the old value. It is
one-sided -- a bound going *up* is safe, because the client merely under-drives
-- and it is already live, because losing a speed flag to a Thief drops
`getMaxSpeedFactor` from 1.5 to 1.0 on the server while the client is still
sending the old `fs`, and `antiCheat.mode` defaults to `strict`.

Upstream's answer is a flat amnesty:

```cpp
// Don't kick players up to 10 seconds after a world parm has changed,
if (now - lastWorldParmChange > 10.0f)
```

`bzfs.cxx:5331`, set on any world-parameter change (`:5637`, `:5686`). It
suspends the *kick*, not the simulation.

bzo has the mechanism already: `reportCheat(player, kind, headline, detail,
enforceable)` computes `refused = enforceable && mode === 'strict'`. Hang a
per-player expiry on any server-originated bound change -- a flag granted, a
flag stripped, a spawn, a handicap notch -- and pass `enforceable: false` for
the affected check kinds while it is open. Position and collision checks keep
enforcing throughout, which is what stops the window being a free teleport.
Size the window from the measured round trip rather than a constant, which is
the first thing this plan buys that nothing else can.

Before building on it, read the `speedClamped` warnings off a live server and
correlate them against flag losses. If it already fires there, that is a bug to
fix rather than a window to widen.

## Staging

1. **Server tracking and `/lagstats`.** The round trip off the existing
   ping/pong at upstream's 10 second cadence, jitter off the `sdt` already in
   every move, missed pongs as loss, and upstream's smoothing. A `lag` module on
   the server holds the arithmetic with a test beside it. `/lagstats` is one
   `defineCommand` at `COMMAND_TIER.OPEN`, sorted by lag and formatted as
   `getLagStats` formats it, because a number nobody can read is a number nobody
   will notice is wrong.

2. **The cached clock**, per the section above: once per frame on the client,
   once per handler entry on the server, with a tick counter beside it.

3. **The bound window** as `enforceable: false`, sized from step 1's round trip.
   It stands on its own and is not handicap work.

4. **A scoreboard column.** bzo shows lag where upstream only answers a command,
   which is the deviation worth taking -- a column is read continuously and a
   command is read once. It cannot ride `getState()` alone, since that fires
   only at join and respawn and the column would freeze; broadcast the table
   after each ping round, so the push rate is the measurement rate and there is
   no second timer, and carry the figures in `getState()` as well so a joining
   client starts populated rather than blank.

5. **Extrapolate on the client's clock, not ours.** `validateMovement` and
   `getExtrapolatedPosition` take the interval between the client's own
   timestamps, and the server's receive time becomes what it is upstream: an
   input to jitter, not to physics. This is the step that needs upstream's
   absolute timestamp rather than `sdt`, and the step that lets the drift
   thresholds be tightened -- which is the point of the exercise. Re-derive them
   once the measurement exists, not before.

6. **Warn and kick.** `lagwarn`/`lagdrop` and `jitterwarn`/`jitterdrop` in
   `server.json` and on the Operator panel, with the matching commands. A
   packet-loss threshold waits on a transport that can lose one: today the loss
   figure counts missed pongs only, which is too coarse to kick on.

**Order matters between the measurement and the kicking.** Kicking on a number
bzo has never measured is how an honest player on a bad connection gets thrown
out; get the measurement right and read it for a while first. `mode: "warning"`
in `antiCheat` exists for exactly that reason and should be the default here
too.

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
- **Which clock does the client sample from?** `performance.now()` is monotonic
  and immune to an adjustment mid-game; `Date.now()` is a wall clock and is what
  the rest of `client.js` uses. Only intervals are ever compared, so an
  arbitrary origin costs nothing and monotonicity is worth more -- but the two
  must not be mixed within one measurement, and the per-frame sample is the
  place to settle which one wins.
- **What does a headset do here?** An XR session's frame pacing is the runtime's,
  and a dropped frame there is not a network event. Whatever kicks on jitter has
  to not fire on a headset that is merely busy.
