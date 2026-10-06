#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Writes the server's CommonJS copy of a mirrored shared pair from its ESM
// copy: `import { a } from './x.mjs'` becomes `const { a } = require('./x.cjs')`,
// `export` comes off each declaration, and the exports are listed at the end --
// which is exactly the difference `check-shared-pairs.mjs` allows.
//
//   node scripts/mirror-pair.mjs drive teleport

import fs from 'node:fs';

for (const name of process.argv.slice(2)) {
  let source = fs.readFileSync(`public/${name}.mjs`, 'utf8');
  source = source.replace(
    /^import \{([^}]*)\} from '\.\/([a-z-]+)\.mjs';$/gm,
    (whole, names, module_) => `const {${names}} = require('./${module_}.cjs');`,
  );
  source = source.replace(
    /^import \* as ([A-Za-z_$][\w$]*) from '\.\/([a-z-]+)\.mjs';$/gm,
    (whole, name_, module_) => `const ${name_} = require('./${module_}.cjs');`,
  );
  const exported = [...source.matchAll(/^export (?:function|const|let) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  source = source.replace(/^export (function|const|let) /gm, '$1 ');
  source = `${source.replace(/\n+$/, '')}\n\nmodule.exports = {\n${exported.map((n) => `  ${n},\n`).join('')}};\n`;
  fs.writeFileSync(`server/${name}.cjs`, source);
  console.log(`server/${name}.cjs: ${exported.length} exports`);
}
