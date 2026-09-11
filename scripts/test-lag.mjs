import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LAG_DECAY,
  JITTER_DECAY,
  JITTER_MAX_GAP_SECONDS,
  PING_INTERVAL_MS,
  blend,
  decayTowardZero,
  truncateContinued,
  createLagTracker,
  formatLagStats,
  compareByLag,
} = require('../server/lag.cjs');

// Upstream's own figures: `lagalpha / (0.9f + lagalpha)` for lag and the 0.99
// sibling for jitter and loss, and a ping every ten seconds.
assert.equal(LAG_DECAY, 0.9);
assert.equal(JITTER_DECAY, 0.99);
// Not upstream's 2: bzo's idle client heartbeats every 5 seconds
// (`MAX_UPDATE_INTERVAL`), so a two second gate would discard every sample from
// every tank nobody is driving and freeze the average.
assert.equal(JITTER_MAX_GAP_SECONDS, 7.5);
assert.equal(PING_INTERVAL_MS, 10000);

// The whole point of starting alpha at 1: the first sample is the average, so a
// player who has just arrived is not reported as having no lag.
{
  const first = blend(0, 1, 0.25, LAG_DECAY);
  assert.equal(first.average, 0.25);
  assert.equal(first.alpha, 1 / 1.9);
}

// And it converges to the fixed point of `a = a / (decay + a)` rather than to
// zero, so the average stays responsive forever instead of freezing.
{
  let alpha = 1;
  for (let i = 0; i < 500; i++) alpha = alpha / (LAG_DECAY + alpha);
  assert.ok(Math.abs(alpha - 0.1) < 1e-9, `lag alpha settles at 0.1, got ${alpha}`);
  let jitterAlpha = 1;
  for (let i = 0; i < 5000; i++) jitterAlpha = jitterAlpha / (JITTER_DECAY + jitterAlpha);
  assert.ok(Math.abs(jitterAlpha - 0.01) < 1e-9, `jitter alpha settles at 0.01, got ${jitterAlpha}`);
}

// A steady sample is a fixed point of the average too -- 100ms forever reads as
// 100ms, which is what makes the number mean anything.
{
  let state = { average: 0, alpha: 1 };
  for (let i = 0; i < 200; i++) state = blend(state.average, state.alpha, 0.1, LAG_DECAY);
  assert.ok(Math.abs(state.average - 0.1) < 1e-9);
}

// A good event pulls an average down without contributing a sample.
{
  const decayed = decayTowardZero(0.5, 0.5, JITTER_DECAY);
  assert.equal(decayed.average, 0.25);
}

// str_trunc_continued: a name that fits is untouched, one that does not is
// marked, so a truncated callsign cannot be read as a shorter real one.
assert.equal(truncateContinued('short', 22), 'short');
assert.equal(truncateContinued('x'.repeat(22), 22), `${'x'.repeat(21)}~`);
assert.equal(truncateContinued('x'.repeat(40), 22), `${'x'.repeat(21)}~`);

// A round trip becomes the lag, in milliseconds.
{
  const lag = createLagTracker();
  assert.equal(lag.hasSamples(), false, 'nothing measured yet is not the same as zero lag');
  lag.pingSent(1000);
  lag.pongReceived(1120);
  assert.equal(lag.getLag(), 120);
  assert.equal(lag.hasSamples(), true);
  assert.equal(lag.getLoss(), 0);
}

// An unanswered pong is ignored: there is no interval to measure against.
{
  const lag = createLagTracker();
  lag.pongReceived(5000);
  assert.equal(lag.hasSamples(), false);
  assert.equal(lag.getLag(), 0);
}

// A ping going out while the last is unanswered counts that one lost, at send
// time rather than on a timeout -- so a connection that has stopped answering
// shows it instead of merely going quiet.
{
  const lag = createLagTracker();
  lag.pingSent(0);
  lag.pingSent(10000);
  assert.equal(lag.getLoss(), 100);
  lag.pongReceived(10100);
  assert.ok(lag.getLoss() < 100, 'an answered ping decays the loss figure back down');
}

// "don't wait for ping to come back": with one outstanding, the reported lag is
// at least what it would be if the answer arrived now.
{
  const lag = createLagTracker();
  lag.pingSent(0);
  lag.pongReceived(50);
  assert.equal(lag.getLag(0), 50);
  lag.pingSent(1000);
  assert.equal(lag.getLag(1050), 50, 'a ping that is not yet late does not move the figure');
  assert.ok(lag.getLag(4000) > 50, 'a ping still outstanding after 3s reports worse than the old average');
}

// Jitter is the disagreement between the gap the server waited and the gap the
// client claims it took. A sender that is exactly as steady as the network has
// none.
{
  const lag = createLagTracker();
  let t = 1000;
  for (let i = 0; i < 50; i++) { t += 50; lag.recordUpdate(t, 0.05); }
  assert.equal(lag.getJitter(), 0);
}

// The first update after a reset opens an interval rather than being one, so
// nothing is measured against a clock that was never set.
{
  const lag = createLagTracker();
  lag.recordUpdate(1000, 0.05);
  assert.equal(lag.getJitter(), 0, 'the first packet has nothing to be measured against');
  lag.recordUpdate(1080, 0.05);
  assert.equal(lag.getJitter(), 30, 'the first real sample is taken whole');
}

// An idle tank heartbeating every five seconds is measured, which is the whole
// reason bzo's gate is not upstream's two.
{
  const lag = createLagTracker();
  lag.recordUpdate(0, 5);
  lag.recordUpdate(5040, 5);
  assert.equal(lag.getJitter(), 40, 'a five second heartbeat is an ordinary sample');
}

// A gap either side that is too long to mean anything is skipped rather than
// folded in: a backgrounded tab is not jitter.
{
  const lag = createLagTracker();
  lag.recordUpdate(0, 0.05);
  lag.recordUpdate(30000, 0.05);
  assert.equal(lag.getJitter(), 0, 'thirty seconds of silence is not a measurement');
  lag.recordUpdate(30050, 30);
  assert.equal(lag.getJitter(), 0, 'nor is a client claiming thirty seconds');
  lag.recordUpdate(30100, Number.NaN);
  assert.equal(lag.getJitter(), 0);
  lag.recordUpdate(30150, 0);
  assert.equal(lag.getJitter(), 0);
}

// Whatever resets a player's physics clock resets this one, so an unpause, a
// teleport or a spawn does not arrive as a fabricated sample.
{
  const lag = createLagTracker();
  lag.recordUpdate(0, 0.05);
  lag.resetUpdateGap();
  // A tank unpaused after four seconds: the client says four seconds since its
  // last send, and the server waited four seconds, but the interval spans the
  // pause rather than the network.
  lag.recordUpdate(4000, 4);
  assert.equal(lag.getJitter(), 0, 'the packet after a reset seeds the next interval');
  lag.recordUpdate(4050, 0.05);
  assert.equal(lag.getJitter(), 0, 'and measuring resumes cleanly from there');
}

// The row, to upstream's widths: 24 columns of name, a colon, three of lag.
{
  const row = formatLagStats({ callsign: 'someone', lag: 42, jitter: 7, loss: 0 });
  assert.equal(row, 'someone                 :  42 +-  7ms');
}
{
  const row = formatLagStats({ callsign: 'someone', lag: 42, jitter: 7, loss: 0, index: 3, showIndex: true });
  assert.equal(row, '[  3] someone                 :  42 +-  7ms');
}
// An observer sends no updates, so there is no jitter to claim for it.
{
  const row = formatLagStats({ callsign: 'watcher', lag: 8, jitter: 99, loss: 50, observer: true });
  assert.equal(row, 'watcher                 :   8ms');
}
// Loss appears only once it is worth mentioning.
{
  assert.ok(!formatLagStats({ callsign: 'a', lag: 1, jitter: 1, loss: 0 }).includes('lost'));
  assert.ok(formatLagStats({ callsign: 'a', lag: 1, jitter: 1, loss: 3 }).includes('3% lost'));
}

// A connection whose first ping has not come back says so, rather than showing
// a zero that reads as perfect.
{
  const row = formatLagStats({ callsign: 'arriving', lag: 0, jitter: 0, loss: 0, measured: false });
  assert.equal(row, 'arriving                :  --');
  assert.ok(!row.includes('ms'));
}

// lagCompare: observers first, then ascending, so the worst connection is the
// last line a chat window leaves on screen.
{
  const rows = [
    { callsign: 'bad', lag: 300, observer: false },
    { callsign: 'good', lag: 20, observer: false },
    { callsign: 'watcher', lag: 999, observer: true },
  ];
  assert.deepEqual(
    [...rows].sort(compareByLag).map((row) => row.callsign),
    ['watcher', 'good', 'bad'],
  );
}

console.log('lag: all assertions passed');
