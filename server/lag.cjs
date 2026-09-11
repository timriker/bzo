/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// LagInfo (`src/game/LagInfo.cxx`), server side. How long a player's packets
// take to come back, how steady their sending is, and how much of it goes
// missing -- measured here and nowhere else, because it is the server that
// judges every position against a clock and the server that has to know how
// much of a disagreement was the network.
//
// Server-only. A client that measured its own lag would be reporting on the
// thing it is being judged by, which is the one number it must not supply.
// The client is *shown* the answer (see docs/lag-plan.md), never asked for it.

// `lagalpha = lagalpha / (0.9f + lagalpha)` and its 0.99 sibling for jitter and
// loss (LagInfo.cxx:106, :227). The smoothing factor is dynamic: it starts at 1
// so the first sample is taken whole, and decays toward the fixed point of
// `a = a / (decay + a)` -- 0.1 for lag, 0.01 for the other two. So an average is
// responsive while a player is new and steady once there is history behind it,
// without anyone choosing a window length.
const LAG_DECAY = 0.9;
const JITTER_DECAY = 0.99;
const LOSS_DECAY = 0.99;

// "don't calc jitter if more than 2 seconds between packets" (LagInfo.cxx:222) --
// upstream's threshold, but not upstream's number, because it is a statement
// about a client's send cadence and bzo's is different. A bzflag client sends
// continuously, so two seconds of silence means a pause; a bzo client that is
// not being driven sends a heartbeat every `MAX_UPDATE_INTERVAL` (5 seconds,
// `public/client.js`), and gating at two would throw away every sample from
// every idle tank and freeze the average at whatever it last held. This is that
// heartbeat with half as much again for the network, so an ordinary quiet tank
// is measured and a genuinely interrupted stream is not.
const JITTER_MAX_GAP_SECONDS = 7.5;

// `nextping += 10.0` (LagInfo.cxx:263). bzo's keep-alive ran at 30 seconds,
// which is liveness cadence rather than measurement cadence: a connection that
// degrades is interesting within seconds.
const PING_INTERVAL_MS = 10000;

// `if (lostavg >= 0.01f)` (LagInfo.cxx:87). Below one percent the figure is
// noise from the dynamic alpha rather than a connection worth mentioning.
const LOSS_REPORT_FLOOR = 0.01;

// One exponential step with a dynamic factor. Returns the pair rather than
// mutating, so the arithmetic is testable without a player around it.
function blend(average, alpha, sample, decay) {
  return {
    average: (average * (1 - alpha)) + (alpha * sample),
    alpha: alpha / (decay + alpha),
  };
}

// A good event decays an average toward zero without contributing a sample:
// upstream's `lostavg = lostavg * (1 - lostalpha)` on every answered ping and
// every measured update. It is how loss falls back off after a bad patch.
function decayTowardZero(average, alpha, decay) {
  return {
    average: average * (1 - alpha),
    alpha: alpha / (decay + alpha),
  };
}

// `str_trunc_continued` (TextUtils.cxx): cut to `len`, and if the cut actually
// happened mark the last character so a truncated callsign cannot be mistaken
// for a short one.
function truncateContinued(text, len) {
  const cut = String(text).slice(0, len);
  if (cut.length < len) return cut;
  return `${cut.slice(0, len - 1)}~`;
}

// One player's measurements. Lag comes from a round trip and jitter from the
// update stream, and keeping them apart is upstream's point: an update interval
// cannot tell a slow network from a slow frame rate, and a round trip cannot
// tell a steady connection from a lumpy one.
function createLagTracker() {
  let lagAverage = 0;
  let lagAlpha = 1;
  let jitterAverage = 0;
  let jitterAlpha = 1;
  let lossAverage = 0;
  let lossAlpha = 1;
  let pingPending = false;
  let pingSentAt = 0;
  let samples = 0;
  // `LagInfo::lastupdate`, and deliberately not the player's own `lastUpdate`.
  // That one is a physics timestamp several things reset on purpose -- an
  // unpause, a teleport, a spawn, an operator move all zero it so the drift
  // check does not read a discontinuity as travel. Measuring an interval from
  // it would turn each of those into a fabricated jitter sample. This clock is
  // written by the update stream and by `resetUpdateGap` alone. `null` rather
  // than zero, because "no interval open" has to be distinguishable from a
  // timestamp and not merely unlikely to collide with one.
  let lastUpdateAt = null;

  return {
    // A ping going out while the last one is still unanswered is that one lost.
    // Upstream counts it at send time rather than waiting for a timeout, which
    // is what makes loss visible on a connection that has stopped answering
    // rather than only on one that answers late.
    pingSent(now) {
      if (pingPending) {
        ({ average: lossAverage, alpha: lossAlpha } = blend(lossAverage, lossAlpha, 1, LOSS_DECAY));
      }
      pingPending = true;
      pingSentAt = now;
    },

    // Ignored unless a ping is outstanding: a pong bzo did not ask for carries
    // no interval to measure.
    pongReceived(now) {
      if (!pingPending) return;
      pingPending = false;
      const seconds = Math.max(0, (now - pingSentAt) / 1000);
      ({ average: lagAverage, alpha: lagAlpha } = blend(lagAverage, lagAlpha, seconds, LAG_DECAY));
      ({ average: lossAverage, alpha: lossAlpha } = decayTowardZero(lossAverage, lossAlpha, LOSS_DECAY));
      samples++;
    },

    // Upstream's jitter, from the two numbers bzo already has on every move: how
    // long the server waited for this packet against how long the client says it
    // took to send it. A steady sender makes those agree whatever the latency
    // is, so what is left is the variation.
    //
    // `nowMs` is the server clock; `clientGapSeconds` is the move's `sdt`. The
    // arrival gap is measured here rather than passed in, so there is one
    // definition of it and nothing else can reset it.
    recordUpdate(nowMs, clientGapSeconds) {
      if (!Number.isFinite(nowMs)) return;
      const previous = lastUpdateAt;
      lastUpdateAt = nowMs;
      // The first update after a reset starts an interval rather than being one.
      if (previous === null) return;
      if (!Number.isFinite(clientGapSeconds) || !(clientGapSeconds > 0)) return;
      const arrivalGapSeconds = (nowMs - previous) / 1000;
      if (!(arrivalGapSeconds > 0)) return;
      if (arrivalGapSeconds >= JITTER_MAX_GAP_SECONDS) return;
      if (clientGapSeconds >= JITTER_MAX_GAP_SECONDS) return;
      const jitter = Math.abs(arrivalGapSeconds - clientGapSeconds);
      ({ average: jitterAverage, alpha: jitterAlpha } = blend(jitterAverage, jitterAlpha, jitter, JITTER_DECAY));
      ({ average: lossAverage, alpha: lossAlpha } = decayTowardZero(lossAverage, lossAlpha, LOSS_DECAY));
    },

    // The update stream was deliberately broken, so the next packet begins a new
    // interval instead of measuring across the break. Called wherever the server
    // resets a player's physics clock -- a spawn, an unpause, a teleport, an
    // operator move -- because in each of those the next `sdt` describes a span
    // the server did not spend waiting.
    resetUpdateGap() {
      lastUpdateAt = null;
    },

    // "don't wait for ping to come back" (LagInfo.cxx:67). With a ping
    // outstanding, report what the average *would* be if it came back now,
    // whenever that is worse -- so a client that has gone silent shows the
    // silence instead of its last good figure.
    getLag(now = 0) {
      let lag = lagAverage;
      if (pingPending && now > 0) {
        const pending = blend(lagAverage, lagAlpha, Math.max(0, (now - pingSentAt) / 1000), LAG_DECAY);
        if (pending.average > lag) lag = pending.average;
      }
      return Math.round(lag * 1000);
    },

    getJitter() {
      return Math.round(jitterAverage * 1000);
    },

    // Percent. Missed pongs only, because TCP delivers an update in order or
    // not at all -- so there is nothing else to count *on this transport*. A
    // move riding WebTransport datagrams would make update loss real and this
    // the place to add it; see docs/lag-plan.md.
    getLoss() {
      return Math.round(lossAverage * 100);
    },

    // Whether anything has been measured yet, which is what separates "0ms" from
    // "not known".
    hasSamples() {
      return samples > 0;
    },
  };
}

// `LagInfo::getLagStats` (LagInfo.cxx:61), one row per player. The width is
// upstream's so the rows line up in a chat window the way they do in bzfs.
//
// Upstream says "lost/ooo" because its loss average mixes lost updates with
// out-of-order ones, both of which UDP hands it. TCP hands bzo neither, so what
// is left is missed pongs and the row says "lost".
// `measured` is bzo's: upstream prints a flat 0 for a player whose first ping
// has not come back, which reads as a perfect connection rather than as an
// unanswered question. A dash says which it is, and costs a column nobody was
// using.
function formatLagStats({
  callsign, lag, jitter, loss, observer = false, index = null, showIndex = false, measured = true,
}) {
  const name = truncateContinued(callsign, 22).padEnd(24, ' ').slice(0, 24);
  const figure = measured ? String(lag) : '--';
  const head = showIndex
    ? `[${String(index).padStart(3, ' ')}] ${name}: ${figure.padStart(3, ' ')}`
    : `${name}: ${figure.padStart(3, ' ')}`;
  if (!measured) return head;
  if (observer) return `${head}ms`;
  let row = `${head} +- ${String(jitter).padStart(2, ' ')}ms`;
  if (loss >= LOSS_REPORT_FLOOR * 100) row += ` ${loss}% lost`;
  return row;
}

// `lagCompare` (commands.cxx:1949). Observers first, then by lag ascending --
// so the worst connection is the last line, which is where a chat window leaves
// it on screen.
function compareByLag(left, right) {
  if (left.observer !== right.observer) return left.observer ? -1 : 1;
  return left.lag - right.lag;
}

module.exports = {
  LAG_DECAY,
  JITTER_DECAY,
  LOSS_DECAY,
  JITTER_MAX_GAP_SECONDS,
  PING_INTERVAL_MS,
  LOSS_REPORT_FLOOR,
  blend,
  decayTowardZero,
  truncateContinued,
  createLagTracker,
  formatLagStats,
  compareByLag,
};
