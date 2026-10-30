#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `npm run dev`'s `--watch` arguments: nodemon.json's list, plus the config
// file, the operator's plugins and the map being served, wherever the server
// finds them -- `data/` in a checkout, or `./server.json` in the layout from
// before it (server.js, `CONFIG_IS_LEGACY`).

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataConfig = path.join(root, 'data', 'server.json');
const legacyConfig = path.join(root, 'server.json');
const configPath = process.env.SERVER_CONFIG_PATH
  ? path.resolve(process.env.SERVER_CONFIG_PATH)
  : (!fs.existsSync(dataConfig) && fs.existsSync(legacyConfig) ? legacyConfig : dataConfig);
const configDir = path.dirname(configPath);

let mapFile = 'bzo.bzw';
try {
  mapFile = JSON.parse(fs.readFileSync(configPath, 'utf8')).mapFile || mapFile;
} catch {
  // No config yet: the server writes one from example-server.json.
}
const runtimeMap = path.join(process.env.MAPS_PATH || path.join(configDir, 'maps'), mapFile);
const mapPath = fs.existsSync(runtimeMap) ? runtimeMap : path.join(root, 'maps', mapFile);
const runtimePlugins = process.env.PLUGINS_PATH || path.join(configDir, 'plugins');

const { watch } = JSON.parse(fs.readFileSync(path.join(root, 'nodemon.json'), 'utf8'));
const paths = [...new Set([...watch, configPath, runtimePlugins, mapPath]
  .map((entry) => path.relative(root, path.resolve(root, entry)) || '.'))];
console.log(paths.map((entry) => `--watch ${entry}`).join(' '));
