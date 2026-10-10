#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Asks the public BZFlag list server which servers are running right now, has
// a local bzo import the map each one is actually playing, and reports what
// that bzo said it could not read -- so "does bzo support what is out there"
// is answered by bzo rather than by this file.
//
// It used to answer the question itself, from a list of what bzo supported
// written into the source here. That list went stale: it still called mesh,
// arc, cone, sphere, tetra, group, materials, physics drivers and texture
// matrices unsupported long after the parser read every one of them, and
// reported 60% of real-world map content as undrawable. A second opinion about
// bzo's own capabilities has nowhere to be kept accurate, so there is no longer
// one here.
//
// The import is the server's ordinary one -- the same `POST /list/import` the
// Map Viewer's own button uses -- so the file lands in `maps/` exactly where a
// map imported any other way does, is parsed by the real parser, and carries
// the parser's own warnings as `-srvmsg` lines in its options block. This
// script reads those back.
//
//   node scripts/survey-live-maps.mjs
//   node scripts/survey-live-maps.mjs --count 12
//   node scripts/survey-live-maps.mjs --server bzflag.example.org:5154
//   node scripts/survey-live-maps.mjs --base-url http://localhost:5154

import fs from 'node:fs';
import path from 'node:path';
import { URLSearchParams } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEFAULT_LIST_SERVER, PROTOCOL_VERSION, fetchServerList } =
  require('../server/remote-world-import.cjs');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const serverCount = parseInt(args.get('count') || '10', 10);
const singleServer = args.get('server') || null;
const listServerUrl = args.get('list-server') || DEFAULT_LIST_SERVER;
const baseUrl = (args.get('base-url') || 'http://localhost:5154').replace(/\/$/, '');
const mapsDir = args.get('maps-dir') || process.env.MAPS_PATH || 'maps';

// The name the server gives an imported map, shared with `remoteMapFileName`
// in server.js. Kept in step by the file it names: if this is ever wrong the
// read below finds nothing and says so, rather than reporting a clean map.
const importFileName = (host, port) =>
  `import-${host}_${port}`.replace(/[^A-Za-z0-9._-]/g, '_') + '.bzw';

// What the parser wrote into the map about its own limits. `-srvmsg` is how
// bzo tells a player what it dropped, and the import path appends one per
// warning, so the file is the report.
function readServerVerdict(host, port) {
  const file = path.join(mapsDir, importFileName(host, port));
  if (!fs.existsSync(file)) return null;
  const notes = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.trim().match(/^-srvmsg\s+"(.*)"$/);
    if (match) notes.push(match[1]);
  }
  return { file, notes, bytes: fs.statSync(file).size };
}

async function importThroughServer(host, port) {
  const res = await fetch(`${baseUrl}/list/import`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ host, port: String(port) }),
  });
  const location = res.headers.get('location') || '';
  if (location.includes('imported=')) return { ok: true };
  const error = decodeURIComponent((location.split('error=')[1] || '').replace(/\+/g, ' '));
  return { ok: false, error: error || `unexpected reply ${res.status}` };
}

async function main() {
  let servers;
  if (singleServer) {
    const idx = singleServer.lastIndexOf(':');
    servers = [{
      host: idx === -1 ? singleServer : singleServer.slice(0, idx),
      port: idx === -1 ? 5154 : parseInt(singleServer.slice(idx + 1), 10),
      title: '(manual)',
    }];
  } else {
    console.log(`Fetching running server list from ${listServerUrl} ...`);
    const all = await fetchServerList(listServerUrl, PROTOCOL_VERSION);
    const seen = new Set();
    servers = [];
    for (const s of all) {
      const key = `${s.host}:${s.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      servers.push(s);
    }
    console.log(`${servers.length} server(s) on protocol ${PROTOCOL_VERSION}; trying the first ${Math.min(serverCount, servers.length)}.`);
    servers = servers.slice(0, serverCount);
  }

  try {
    await fetch(`${baseUrl}/api/tank-models`);
  } catch {
    console.error(`No bzo answering at ${baseUrl}. Start one (npm run dev) or pass --base-url.`);
    process.exit(1);
  }

  const noteCounts = new Map();
  let imported = 0;
  let quiet = 0;

  for (const server of servers) {
    const label = `${server.host}:${server.port}${server.title ? ` -- ${server.title}` : ''}`;
    console.log(`\n=== ${label} ===`);
    const result = await importThroughServer(server.host, server.port);
    if (!result.ok) {
      console.log(`  skip: ${result.error}`);
      continue;
    }
    imported += 1;
    const verdict = readServerVerdict(server.host, server.port);
    if (!verdict) {
      console.log('  imported, but no file found to read back');
      continue;
    }
    console.log(`  imported ${(verdict.bytes / 1024).toFixed(0)} KB -> ${verdict.file}`);
    if (verdict.notes.length === 0) {
      quiet += 1;
      console.log('  bzo reported nothing it could not read');
      continue;
    }
    for (const note of verdict.notes) {
      console.log(`  ! ${note}`);
      // Grouped by the sentence rather than the map, since the map's own name
      // is inside it: the aggregate below wants the shape of the complaint.
      const shape = note.replace(/\bimport-[^\s]+\.bzw\b/g, '<map>');
      noteCounts.set(shape, (noteCounts.get(shape) || 0) + 1);
    }
  }

  console.log(`\n=== across ${imported} imported map(s) ===`);
  console.log(`${quiet} had nothing to report.`);
  if (noteCounts.size > 0) {
    console.log('\nWhat bzo said it could not read, most common first:');
    for (const [shape, count] of [...noteCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)}x  ${shape}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
