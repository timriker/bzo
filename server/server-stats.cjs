/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// How hard the server itself is working: CPU, how late the event loop runs
// what it was asked to, and the messages and bytes it moves. bzfs has the
// traffic half behind NETWORK_STATS (`NetHandler::countMessage`), per player
// and compiled out by default; bzo counts server-wide, always, because a Node
// process that falls behind does so for everyone at once, and a lagging loop
// is lag every player measures without being able to say where it came from.
//
// A window is a span of time the numbers are taken over. Each reader has its
// own, so the periodic log line and a `/lagstats` caller do not reset each
// other.

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

// The histogram's sampling period. Fine enough to see one 16ms tick running
// late, coarse enough to cost nothing.
const LOOP_DELAY_RESOLUTION_MS = 10;

function createServerStats() {
  const totals = { msgsIn: 0, bytesIn: 0, msgsOut: 0, bytesOut: 0 };

  function snapshot() {
    return {
      at: performance.now(),
      cpu: process.cpuUsage(),
      elu: performance.eventLoopUtilization(),
      ...totals,
    };
  }

  return {
    countIn(bytes) {
      totals.msgsIn++;
      totals.bytesIn += bytes;
    },
    countOut(bytes) {
      totals.msgsOut++;
      totals.bytesOut += bytes;
    },

    // A window starts now; `read()` reports since then and starts the next.
    window() {
      let start = snapshot();
      let delay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
      delay.enable();
      return {
        read() {
          const end = snapshot();
          const seconds = Math.max(0.001, (end.at - start.at) / 1000);
          const cpu = process.cpuUsage(start.cpu);
          const ms = (ns) => ns / 1e6;
          const stats = {
            seconds,
            cpuPercent: (100 * (cpu.user + cpu.system)) / 1e6 / seconds,
            loopBusyPercent: 100 * performance.eventLoopUtilization(end.elu, start.elu).utilization,
            // How late a timer ran past its due time, after the resolution
            // the histogram itself waits.
            loopDelayP50: Math.max(0, ms(delay.percentile(50)) - LOOP_DELAY_RESOLUTION_MS),
            loopDelayP99: Math.max(0, ms(delay.percentile(99)) - LOOP_DELAY_RESOLUTION_MS),
            loopDelayMax: Math.max(0, ms(delay.max) - LOOP_DELAY_RESOLUTION_MS),
            msgsInPerSecond: (end.msgsIn - start.msgsIn) / seconds,
            bytesInPerSecond: (end.bytesIn - start.bytesIn) / seconds,
            msgsOutPerSecond: (end.msgsOut - start.msgsOut) / seconds,
            bytesOutPerSecond: (end.bytesOut - start.bytesOut) / seconds,
          };
          start = end;
          delay.reset();
          return stats;
        },
        close() {
          delay.disable();
          delay = null;
        },
      };
    },
  };
}

function formatServerStats(stats) {
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
  return `cpu ${stats.cpuPercent.toFixed(1)}%, loop busy ${stats.loopBusyPercent.toFixed(1)}%`
    + `, loop delay p50 ${stats.loopDelayP50.toFixed(1)}ms p99 ${stats.loopDelayP99.toFixed(1)}ms`
    + ` max ${stats.loopDelayMax.toFixed(1)}ms`
    + `, in ${Math.round(stats.msgsInPerSecond)}/s ${kb(stats.bytesInPerSecond)}/s`
    + `, out ${Math.round(stats.msgsOutPerSecond)}/s ${kb(stats.bytesOutPerSecond)}/s`;
}

module.exports = { createServerStats, formatServerStats };
