#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// How the server's bots have played, by bzo version, pilot and map: the
// tally the server keeps in `bot-stats.json` beside server.json from every
// bot report. Rates are per minute of bot play.
//
//   node scripts/bot-stats.mjs                 # data/bot-stats.json
//   node scripts/bot-stats.mjs path/to/bot-stats.json --map hix.bzw

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mapAt = args.indexOf('--map');
const onlyMap = mapAt >= 0 ? args[mapAt + 1] : null;
const file = args.find((arg, i) => !arg.startsWith('--') && (mapAt < 0 || i !== mapAt + 1))
  || path.join(root, 'data', 'bot-stats.json');

if (!fs.existsSync(file)) {
  console.error(`${file}: no tally yet; the server writes it once a bot has reported`);
  process.exit(1);
}
const tally = JSON.parse(fs.readFileSync(file, 'utf8'));

// Versions in release order, not as strings sort.
const versionKey = (version) => version.split('.').map((part) => String(Number(part) || 0).padStart(5, '0')).join('.');
const rows = Object.entries(tally)
  .map(([key, counts]) => {
    const [version, pilot, map] = key.split(' ');
    return { version, pilot, map, ...counts };
  })
  .filter((row) => !onlyMap || row.map === onlyMap)
  .sort((a, b) => versionKey(a.version).localeCompare(versionKey(b.version))
    || a.map.localeCompare(b.map) || a.pilot.localeCompare(b.pilot));

const perMinute = (row, name) => ((row[name] || 0) / ((row.seconds || 1) / 60)).toFixed(2);
const columns = [
  ['version', (r) => r.version],
  ['pilot', (r) => r.pilot],
  ['map', (r) => r.map],
  ['minutes', (r) => ((r.seconds || 0) / 60).toFixed(0)],
  ['kills/m', (r) => perMinute(r, 'kills')],
  ['deaths/m', (r) => perMinute(r, 'deaths')],
  ['k/d', (r) => ((r.kills || 0) / Math.max(1, r.deaths || 0)).toFixed(2)],
  ['tk', (r) => String(r.teamKills || 0)],
  ['shots/m', (r) => perMinute(r, 'shots')],
  ['held', (r) => String(r.held || 0)],
  ['falls/m', (r) => perMinute(r, 'falls')],
  ['unsticks/m', (r) => perMinute(r, 'unsticks')],
  ['no route', (r) => `${Math.round((100 * (r.unreachable || 0)) / Math.max(1, r.plans || 0))}%`],
];
const table = [columns.map(([name]) => name), ...rows.map((row) => columns.map(([, cell]) => cell(row)))];
const widths = columns.map((_, i) => Math.max(...table.map((line) => line[i].length)));
for (const line of table) console.log(line.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '));
