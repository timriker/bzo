#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Boots the server far enough to prove it boots, then stops it.
//
// `node --check` parses; it does not run, so it sees nothing wrong with a
// module-level `const` that reads a value initialized later in the file. That
// mistake throws `ReferenceError: Cannot access 'x' before initialization` on
// the first real start -- and on a dev machine the first real start is
// nodemon's, the moment the file is saved, which drops every connected client
// without the auto-reconnect a clean restart gives them.
//
// Port 0 so this never collides with a server already running, and throwaway
// config and log paths so it touches neither the operator's config nor the
// log of the server that is already running in this directory -- which the
// real one truncates on start.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const READY = /listening on|HTTP server listening|Server running/i;
const TIMEOUT_MS = 30000;

const dir = mkdtempSync(path.join(os.tmpdir(), 'bzo-boot-'));
const configPath = path.join(dir, 'server.json');
writeFileSync(configPath, JSON.stringify({ title: 'boot check', listen: '127.0.0.1:0' }));

const child = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    SERVER_CONFIG_PATH: configPath,
    SERVER_LOG_PATH: path.join(dir, 'server.log'),
    LISTEN: '127.0.0.1:0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let settled = false;

const finish = (code, message) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.kill('SIGKILL');
  if (message) console.error(message);
  if (code === 0) console.log('server boots');
  // Its config, log and cache, which nothing reads after the check.
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
};

const timer = setTimeout(
  () => finish(1, `server did not finish booting in ${TIMEOUT_MS / 1000}s:\n${output}`),
  TIMEOUT_MS,
);

const read = (chunk) => {
  output += chunk;
  if (READY.test(output)) finish(0);
};
child.stdout.on('data', read);
child.stderr.on('data', read);
child.on('error', (error) => finish(1, `could not start the server: ${error.message}`));
child.on('exit', (code) => finish(1, `server exited with ${code} before it was ready:\n${output}`));
