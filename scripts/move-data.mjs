#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `npm run move-data`: moves a checkout from the old layout, with
// `server.json` and its state at the top, to `data/`, laid out as the image's
// `/data` volume is (docs/installation.md). Run once; it refuses if `data/`
// already has a `server.json`.
//
// What moves:
// - `server.json` and the state files beside it;
// - `cache/`, except `cache/br`, which is built from the checkout's own files
//   as the image's `/app/cache/br` is;
// - every file in `maps/`, `replays/` and `plugins/` that git does not track:
//   uploads, imports and recordings. What git tracks is bundled and stays.
//
// A relative `https` certificate path in `server.json` is rewritten so it
// still names the same file from `data/`.
//
// `--dry-run` says what it would move and moves nothing.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = path.join(root, 'data');
const dryRun = process.argv.includes('--dry-run');

const STATE_FILES = Object.freeze([
  'server.json', 'sessions.json', 'uploads.json', 'list-server-keys.json', 'bans.json',
  'scores.json', 'discord-links.json', 'discord-gateway.json',
]);
const CONTENT_DIRS = Object.freeze(['maps', 'replays', 'plugins']);

function fail(text) {
  console.error(`move-data: ${text}`);
  process.exit(1);
}

if (process.env.SERVER_CONFIG_PATH) fail('SERVER_CONFIG_PATH is set; this moves the checkout\'s own layout only');
if (fs.existsSync(path.join(dataDir, 'server.json'))) fail('data/server.json exists already');
if (!fs.existsSync(path.join(root, 'server.json'))) fail('no server.json to move');

let tracked;
try {
  tracked = new Set(execFileSync('git', ['ls-files', '-z', ...CONTENT_DIRS], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean));
} catch (error) {
  fail(`needs git to tell bundled files from local ones: ${error.message}`);
}

const moves = [];
for (const name of STATE_FILES) {
  if (fs.existsSync(path.join(root, name))) moves.push(name);
}
const cacheDir = path.join(root, 'cache');
if (fs.existsSync(cacheDir)) {
  for (const name of fs.readdirSync(cacheDir)) {
    if (name !== 'br') moves.push(path.join('cache', name));
  }
}
for (const dir of CONTENT_DIRS) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    const relative = path.join(dir, name);
    if (fs.statSync(path.join(root, relative)).isFile() && !tracked.has(relative)) moves.push(relative);
  }
}

// The config as it will read from `data/`.
const configText = fs.readFileSync(path.join(root, 'server.json'), 'utf8');
const config = JSON.parse(configText);
let rewritten = false;
for (const key of ['cert', 'key']) {
  const file = config.https?.[key];
  if (typeof file === 'string' && !path.isAbsolute(file)) {
    config.https[key] = path.relative(dataDir, path.resolve(root, file));
    console.log(`https.${key}: ${file} -> ${config.https[key]}`);
    rewritten = true;
  }
}

for (const relative of moves) console.log(`${relative} -> data/${relative}`);
if (dryRun) {
  console.log(`dry run: ${moves.length} to move`);
  process.exit(0);
}

for (const relative of moves) {
  const to = path.join(dataDir, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(path.join(root, relative), to);
}
if (rewritten) fs.writeFileSync(path.join(dataDir, 'server.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`moved ${moves.length}; the server now reads data/server.json`);
