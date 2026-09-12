# Not responding players

bzo has no safety net for a client that stops sending updates -- buggy,
crashed, or just a dropped tab -- and that gap was found while chasing a
live teleporter-collision bug that made a real client go quiet for good.
That bug is its own, separate fix, in progress directly in the collision
code; this plan is only about the general case, which will still exist once
it's fixed -- a future bug, a real crash, a dropped connection nobody has
found yet. Upstream references are paths under `$HOME/bzflag/`.

## What's needed: a "not responding" safety net

Upstream has exactly this problem and a known answer for it that bzo has
none of.

**Upstream's mechanism.** `_notRespondingTime` (`global.cxx:103`) is a
`Locked` BZDB constant, 5.0 seconds, not map- or server-settable.
`Player::doDeadReckoning` (`Player.cxx:1329`) sets `notResponding = (dt >
_notRespondingTime)` where `dt` is time since that player's last update --
measured by the *receiver*, not asserted by the sender. When it flips:

- Scoreboard: `[nr]` appended after the callsign (`ScoreboardRenderer.cxx:802`).
- Radar: blip dimmed to 40%, same as a paused player (`RadarRenderer.cxx:114`).
- Chat: `"<player> not responding"`, and `"<player> okay"` on recovery
  (`playing.cxx:7323-7329`).
- Not a valid lock-on target while flagged (`playing.cxx:4426`).
- Server side (`bzfs.cxx:5808`): if the player was the rabbit, a new one is
  anointed; if they're holding a flag, it's dropped at their last known
  position, so a flag can't ride a hung player forever.

Notably, upstream does **not** cap or freeze dead reckoning itself once
`notResponding` -- extrapolation keeps running on the same unbounded `dt` it
always used. The mechanism is entirely about *signalling* the problem and
protecting shared game state (the flag, the rabbit slot), not about bounding
how far a guess is allowed to drift. bzo already treats that drift as
accepted, intentional dead-reckoning behaviour, so this plan does not
propose changing that.

**bzo's version.** Reuse the existing heartbeat constant rather than invent
a new number: `MAX_UPDATE_INTERVAL` (`client.js:2963`, 5000ms) is already
bzo's "an idle client still says something at least this often" figure --
it's what `server/lag.cjs`'s jitter gate and the observer heartbeat both
already assume. A hung-player timeout of **twice that (10s)** is a
reasonable default: an honest client heartbeats at 5s, so silence past 10s
is a real signal rather than jitter. Measured server-side, from
`player.lastUpdate`, independent of whether the client claims to be airborne
-- that independence is the whole point, since the teleporter bug above is
airborne-only and the current heartbeat rule explicitly excludes airborne
tanks (`client.js:8282`, `!airborneState && ...`).

What bzo's version should do once a player crosses the threshold:

1. Track it per player (`player.lastUpdate` already exists; just needs the
   threshold check, likely alongside where lag is already tracked).
2. Broadcast the state change so other clients can render *something* --
   bzo has no radar-dimming or scoreboard-tag convention yet for this, so
   this needs its own small design pass, but the shape (a boolean flag in
   `getState()`, flip a class/tint client-side) is the obvious start.
3. Drop any flag the player is holding, at their last known position --
   direct parity with upstream, and it's the part that actually protects
   other players' games rather than just decorating one player's screen.
4. Reassign the rabbit if the hung player held that role -- bzo has rabbit
   chase mode (`RABBIT_SELECTION`), so this applies directly.
5. Clear the state and (optionally) chat-announce recovery the moment a new
   move arrives, mirroring upstream's `"okay"` message.

## Testing

Unclear how to test this well, and worth being honest about that up front.
The *notResponding* timeout is a real-time behaviour by definition -- it
needs a client that connects, does something, and then genuinely goes quiet
for the length of the timeout.

Two ideas, neither fully worked out yet:

- A scripted raw-WebSocket test client (same shape as the existing
  `scripts/test-*.mjs` server-side tests, or `headless-client.mjs`'s
  approach but without the browser) that joins, grabs a flag, then simply
  stops sending `'m'` messages and asserts the server flags it and drops
  the flag. Honest cost: this test either takes as long as the timeout
  (slow) or needs the threshold to be overridable per-test (a server.json
  or query-param override for the test run only, not a real map-facing
  knob).
- Structuring the detection as a pure function of `(now, lastUpdate,
  threshold)` -- easy to unit test in isolation -- and trusting a live
  manual check (join, background the tab, watch `/api/players` or the
  scoreboard) for the end-to-end wiring, the way `/api/players` was used to
  confirm the teleporter bug live rather than only in simulation.
