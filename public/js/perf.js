/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Where the frame's time goes, in milliseconds per frame averaged over a
// second. One saturated core is the budget on the machines that matter, so the
// split between world simulation, HUD painting and draw submission is what
// decides which cost is worth attacking -- a figure no frame rate can give on
// its own. Sampled with performance.now() on purpose: this measures work done,
// not the display cadence the frame timestamp carries.
//
// The renderer marks phases of its own, so the accumulator lives here rather
// than in the frame loop that opens it. A phase runs from the previous mark to
// its own, whichever module made either.
const FRAME_PHASE_WINDOW_MS = 1000;
const FRAME_PHASES = Object.freeze([
  'xr', 'hud', 'input', 'matrix', 'shadows', 'sim', 'radar', 'worldfx', 'draw',
]);
const framePhaseTotals = new Map();
let framePhaseMark = 0;
let framePhaseWindowStart = performance.now();
let framePhaseFrames = 0;
let framePhaseReport = null;
let framePhaseProgramsLow = null;
let framePhaseProgramsHigh = null;
let framePhaseProgramRange = null;
// The shortest frame in the window. There is no web API for the display's
// refresh rate, and without it a client at 30fps because its panel is running
// at 30Hz is indistinguishable from one at 30fps because it is slow -- a
// difference worth an hour of chasing the wrong cost. The fastest frame a
// client managed bounds its refresh interval from below, which separates them.
let framePhaseLastStart = 0;
let framePhaseFastest = null;
let framePhaseFastestReport = null;

// The first mark of a frame measures from here.
export function startFramePhases() {
  const mark = performance.now();
  if (framePhaseLastStart > 0) {
    const interval = mark - framePhaseLastStart;
    if (interval > 0 && (framePhaseFastest === null || interval < framePhaseFastest)) {
      framePhaseFastest = interval;
    }
  }
  framePhaseLastStart = mark;
  framePhaseMark = mark;
}

export function markFramePhase(name) {
  const mark = performance.now();
  framePhaseTotals.set(name, (framePhaseTotals.get(name) || 0) + (mark - framePhaseMark));
  framePhaseMark = mark;
}

// Three.js keys its program cache on the light count, among other things, so a
// scene that adds and removes lights compiles a fresh set of programs every
// time it does. The spread over a window says whether that is happening; the
// single count a stats line carries cannot.
export function noteProgramCount(count) {
  if (!Number.isFinite(count)) return;
  if (framePhaseProgramsLow === null || count < framePhaseProgramsLow) framePhaseProgramsLow = count;
  if (framePhaseProgramsHigh === null || count > framePhaseProgramsHigh) framePhaseProgramsHigh = count;
}

export function rollFramePhases() {
  framePhaseFrames += 1;
  const elapsed = performance.now() - framePhaseWindowStart;
  if (elapsed < FRAME_PHASE_WINDOW_MS) return;

  const report = {};
  let measured = 0;
  for (const name of FRAME_PHASES) {
    const ms = Number(((framePhaseTotals.get(name) || 0) / framePhaseFrames).toFixed(2));
    report[name] = ms;
    measured += ms;
  }
  // Everything between the end of one frame callback and the start of the next:
  // the wait for the GPU to catch up and the display to accept the frame, the
  // browser laying out and painting the HUD's DOM, socket handlers, collection.
  // A client can be slow with nothing above it moving, and then none of the work
  // this file measures is the work to cut. The phases plus this one are the
  // whole frame, so the total matches 1000/fps.
  report.outside = Number(Math.max(0, (elapsed / framePhaseFrames) - measured).toFixed(2));
  framePhaseReport = report;
  framePhaseProgramRange = framePhaseProgramsLow === null
    ? null
    : `${framePhaseProgramsLow}-${framePhaseProgramsHigh}`;
  framePhaseFastestReport = framePhaseFastest === null
    ? null
    : Number(framePhaseFastest.toFixed(2));
  framePhaseTotals.clear();
  framePhaseFrames = 0;
  framePhaseProgramsLow = null;
  framePhaseProgramsHigh = null;
  framePhaseFastest = null;
  framePhaseWindowStart = performance.now();
}

// A leak is a *trend*, and no single stats line can show one. So the counters
// that could grow without bound are baselined the first time they are sampled
// and reported as growth since then -- which is the number that means something
// on a client that has been idle for an hour.
//
// The page is the baseline's lifetime rather than the connection: bzo reconnects
// its clients on every server restart, and a leak the reconnect clears is
// exactly the case worth catching -- resetting the baseline there would hide it.
// `init` tears the scene down and rebuilds it, so a count that returns to its
// starting value has answered the question either way.
const growthBaseline = new Map();

// Chrome and Edge only, and coarse: `usedJSHeapSize` is quantised and lags
// collection, so a single reading says little. The *slope* over an idle hour is
// the signal, which is what the baseline above turns it into.
//
// A capability, not a cost: where the browser does not expose it there is
// nothing to disable, so the field is simply absent rather than zero -- a zero
// would read as "no memory used" in a line somebody is comparing against
// another browser's.
export function getHeapUsedMB() {
  const memory = performance.memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize)) return null;
  return Number((memory.usedJSHeapSize / (1024 * 1024)).toFixed(1));
}

// Records `value` for `name` and returns how far it has moved since the first
// time it was recorded, or null the first time and for a value that has not
// moved. Null rather than zero so the caller can leave a quiet counter out of
// the line entirely: a stats line full of `+0` is a line nobody reads.
export function noteGrowth(name, value) {
  if (!Number.isFinite(value)) return null;
  if (!growthBaseline.has(name)) {
    growthBaseline.set(name, value);
    return null;
  }
  const delta = Number((value - growthBaseline.get(name)).toFixed(1));
  return delta === 0 ? null : delta;
}

// The growth fields for a stats line: `grew=objects+12,heap+40.5` and nothing at
// all when nothing has moved. One field rather than a delta beside every
// counter, because the counters are already there and what is worth reading is
// the short list of the ones that are climbing.
export function describeGrowth(samples) {
  const parts = [];
  for (const [name, value] of Object.entries(samples)) {
    const delta = noteGrowth(name, value);
    if (delta === null) continue;
    parts.push(`${name}${delta > 0 ? '+' : ''}${delta}`);
  }
  return parts.length > 0 ? parts.join(',') : null;
}

// Milliseconds per frame for the last completed window, or null before one has
// completed.
export function getFramePhaseReport() {
  return framePhaseReport;
}

// "low-high" over the last completed window, or null.
export function getFrameProgramRange() {
  return framePhaseProgramRange;
}

// The shortest frame of the last completed window in ms, or null. At or below
// the display's refresh interval, so 33 means a 30Hz panel rather than a slow
// client.
export function getFastestFrame() {
  return framePhaseFastestReport;
}
