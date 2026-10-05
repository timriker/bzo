/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// One map file parsed and built into its world file, off the server's own
// thread: a big map takes seconds, and a game running on that thread stops for
// as long. One worker per map, which ends when the map is done, so the memory
// the parse used goes with it. `convertMapFile` in server.js starts it and
// writes what it sends back.

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { configureBzwParse, parseBZWMap, buildWorldFile } = require('./bzw-parse.cjs');
const { digestOf } = require('./precompress.cjs');
const { bzfsWorldHashOfBzw } = require('./bzflag-world.cjs');

// `writeDir`: where to write the world's JSON, when it is to be kept. Written
// here rather than sent back, so the server's thread never holds a big map's
// JSON at all; what goes back is its hash and its sidecar digest.
const { filePath, quiet, gameConfigDefaults, build, writeDir } = workerData;
configureBzwParse({
  log: (...args) => parentPort.postMessage({ log: args.map(String).join(' ') }),
  gameConfigDefaults,
});

const map = parseBZWMap(filePath, { quiet });
const { json, ...world } = buildWorldFile(map, build);
let written = null;
if (writeDir) {
  const bytes = Buffer.from(json);
  fs.writeFileSync(path.join(writeDir, `${world.hash}.json`), bytes);
  written = { digest: digestOf(bytes), size: bytes.length };
}
// For naming the map a recording was played on (`bzfsWorldHashOfBzw`).
const bzfsHash = bzfsWorldHashOfBzw(fs.readFileSync(filePath, 'latin1'));
parentPort.postMessage({
  result: {
    ...world,
    bzfsHash,
    written,
    instancing: map.instancing || null,
    warnedMessages: map.warnedMessages,
  },
});
