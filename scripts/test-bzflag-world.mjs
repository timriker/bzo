#!/usr/bin/env node
// Holds the JS world compiler (server/bzw-compile.cjs) to bzfs's own
// `-cacheout`: every maps/*.bzw compiled and packed must inflate to the same
// bytes bzfs writes. bzfs is the reference, so without it there is nothing
// to compare against and the test says so and passes. Reference blobs are
// made once per run in a temporary directory, or read from
// BZFLAG_WORLD_REFS when it names a directory of <map>.bwc files.
//
//   node scripts/test-bzflag-world.mjs [map ...]

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compileBzwWorld } = require('../server/bzw-compile.cjs');
const { packWorldBody } = require('../server/bzflag-world.cjs');
const { parseWorldDatabase } = require('../server/remote-world-import.cjs');

// A block a loaded plugin registered (bz_registerCustomMapObject) is the
// plugin's: bzfs's reader skips it, and fails the map where no plugin did.
{
  const map = 'finishline\n  position 0 0 0\n  heading 180\nend\nbox\n  position 0 0 0\n  size 5 5 5\nend\n';
  assert.throws(() => compileBzwWorld(map), /failed to load/, 'an object no plugin registered fails the map');
  const tree = compileBzwWorld(map, { customObjects: new Set(['FINISHLINE']) });
  assert.equal(tree.unsupported.length, 0, 'one a plugin registered is skipped');

  // bzo's own parse reads it whole as a plugin's, and warns of nothing in it;
  // a stray word whose lines reach a real object first is still unread.
  const { parseBZWMap } = require('../server/bzw-parse.cjs');
  const world = parseBZWMap('race.bzw', { text: map, quiet: true });
  assert.deepEqual(world.customObjects, { finishline: 1 });
  assert.equal(world.obstacles.filter((obs) => obs.type === 'box').length, 1, 'the box after it is read');
  assert.ok(!world.messages.some((line) => /ignored/.test(line)), world.messages.join('; '));
  const stray = parseBZWMap('stray.bzw', { text: `typo\n${map.slice(map.indexOf('box'))}`, quiet: true });
  assert.deepEqual(stray.customObjects, {});
  assert.equal(stray.obstacles.filter((obs) => obs.type === 'box').length, 1, 'a stray word swallows nothing');
  assert.ok(stray.messages.some((line) => /ignored: typo/.test(line)), stray.messages.join('; '));
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const mapsDir = path.join(root, 'maps');
const only = process.argv.slice(2);
const maps = fs.readdirSync(mapsDir)
  .filter((name) => name.endsWith('.bzw') && (only.length > 0 || !name.startsWith('import-')))
  .map((name) => name.slice(0, -4))
  .filter((name) => only.length === 0 || only.includes(name))
  .sort();

let refDir = process.env.BZFLAG_WORLD_REFS || null;
if (!refDir) {
  try {
    execFileSync('bzfs', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('test-bzflag-world: bzfs is not installed; nothing to compare against, skipped');
    process.exit(0);
  }
  refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-bwc-'));
  const made = refDir;
  process.on('exit', () => fs.rmSync(made, { recursive: true, force: true }));
}

function reference(name) {
  const file = path.join(refDir, `${name}.bwc`);
  if (!fs.existsSync(file)) {
    try {
      execFileSync('bzfs', ['-world', path.join(mapsDir, `${name}.bzw`), '-cacheout', file],
        { stdio: 'ignore', timeout: 60000 });
    } catch {
      // the file is the answer
    }
  }
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

// The first place two trees part, as a path into them.
function firstDifference(a, b, at = '') {
  if (typeof a !== typeof b) return `${at}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
  if (a === null || typeof a !== 'object') {
    if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return null;
    return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) && a.length !== b.length) return `${at}.length: ${a.length} vs ${b.length}`;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const diff = firstDifference(a[key], b[key], `${at}.${key}`);
    if (diff) return diff;
  }
  return null;
}

let same = 0;
let compared = 0;
const failures = [];
for (const name of maps) {
  const blob = reference(name);
  if (!blob) {
    console.log(`  ${name}: no reference from bzfs, skipped`);
    continue;
  }
  compared += 1;
  const expected = zlib.inflateSync(blob.subarray(14, 14 + blob.readUInt32BE(10)));
  let body;
  let tree;
  try {
    tree = compileBzwWorld(fs.readFileSync(path.join(mapsDir, `${name}.bzw`), 'latin1'));
    body = packWorldBody(tree);
  } catch (error) {
    failures.push(`${name}: ${error.stack.split('\n').slice(0, 3).join(' | ')}`);
    continue;
  }
  if (Buffer.compare(body, expected) === 0) {
    same += 1;
    continue;
  }
  const ref = parseWorldDatabase(blob);
  let mine;
  try {
    const header = Buffer.alloc(14);
    header.writeUInt16BE(10, 0);
    header.writeUInt16BE(0x6865, 2);
    header.writeUInt16BE(1, 4);
    const deflated = zlib.deflateSync(body);
    header.writeUInt32BE(body.length, 6);
    header.writeUInt32BE(deflated.length, 10);
    mine = parseWorldDatabase(Buffer.concat([header, deflated]));
  } catch (error) {
    mine = { error: error.message };
  }
  const strip = (t) => ({ ...t, compressedSize: 0, uncompressedSize: 0 });
  failures.push(`${name}: ${firstDifference(strip(mine), strip(ref)) || `bytes differ (${body.length} vs ${expected.length})`}`);
}

for (const line of failures) console.log(`  DIFF ${line}`);
console.log(`test-bzflag-world: ${same} of ${compared} map(s) byte-identical to bzfs`);
if (failures.length > 0) process.exit(1);
