/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// One map file parsed again for where each obstacle came from in it (its
// `source` and `placedBy`, docs/editor-plan.md), off the server's own thread
// as `map-convert-worker.cjs` is. `obstacleSourceFor` in server.js starts it.
// Sent back with the text the spans index into and bzfs's hash of it, so the
// server can tell the file has not changed since its world was built.

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { configureBzwParse, parseBZWMap } = require('./bzw-parse.cjs');
const { bzfsWorldHashOfBzw } = require('./bzflag-world.cjs');

const { filePath, gameConfigDefaults } = workerData;
configureBzwParse({ log: () => {}, gameConfigDefaults });

const text = fs.readFileSync(filePath, 'utf8');
const map = parseBZWMap(filePath, { quiet: true, text });
// Four numbers a span: its first and last line and its character range.
const flat = (span) => (span ? [span.startLine, span.endLine, span.start, span.end] : [0, 0, 0, 0]);
parentPort.postMessage({
  text,
  bzfsHash: bzfsWorldHashOfBzw(fs.readFileSync(filePath, 'latin1')),
  missingTextures: map.unresolvedTextureNames,
  materials: map.materialSources.map((material) => [material.name, ...flat(material.source)]),
  warnings: map.warnedMessages,
  spans: map.obstacles.map((obstacle) => [
    ...flat(obstacle.source),
    ...(obstacle.placedBy || []).flatMap(flat),
  ]),
});
