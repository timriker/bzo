#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Every name the server destructures from one of its own modules is one that
// module exports. A misspelled or renamed one is not an error anywhere else:
// lint sees a binding, `node --check` sees valid syntax, and the boot check
// starts fine -- the name is simply `undefined` until the code path that reads
// a property of it runs, and then it takes the whole process down. That is how
// the bzfs proxy shipped importing `BZFS_PLAYER_STATUS` from a module that
// exports `PLAYER_STATUS`.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = ['server.js', ...fs.readdirSync(path.join(root, 'server'))
  .filter((name) => name.endsWith('.cjs') || name.endsWith('.js'))
  .map((name) => path.join('server', name))];

const PATTERN = /const\s*\{([^}]*)\}\s*=\s*require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g;
let failed = 0;
for (const file of files) {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, 'utf8');
  const require = createRequire(full);
  for (const match of source.matchAll(PATTERN)) {
    const [, names, specifier] = match;
    const exported = require(specifier);
    for (const entry of names.split(',')) {
      const name = entry.replace(/\/\/.*$/gm, '').trim().split(':')[0].trim();
      if (!name || name.startsWith('...')) continue;
      if (!(name in exported)) {
        failed++;
        console.error(`${file}: ${specifier} has no export "${name}"`);
      }
    }
  }
}
if (failed) process.exit(1);
console.log(`requires: ${files.length} files, every destructured name exported`);
