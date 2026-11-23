/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Runs a map job (server/map-build-child.cjs) in a process of its own, so the
// memory a big map takes to read leaves with it. `runMapBuildSync` blocks, for
// the boot, which has nothing to serve until the live map is read;
// `runMapBuild` does not. `log` gets the child's log lines as they come.

'use strict';

const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const CHILD = path.join(__dirname, 'map-build-child.cjs');

function lines(text, log) {
  for (const line of text.split('\n')) if (line) log(line);
}

function resultOf(job, stdout, how) {
  if (!stdout || stdout.length === 0) throw new Error(`map ${job.task} stopped (${how})`);
  const result = v8.deserialize(stdout);
  if (result.error) throw new Error(`map ${job.task}: ${result.error}`);
  return result.ok;
}

function runMapBuildSync(job, { log }) {
  const out = spawnSync(process.execPath, [CHILD], { input: v8.serialize(job), maxBuffer: 1 << 30 });
  lines(out.stderr ? out.stderr.toString() : '', log);
  return resultOf(job, out.stdout, out.error ? out.error.message : `code ${out.status}`);
}

function runMapBuild(job, { log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    let pending = '';
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => {
      pending += chunk.toString();
      const end = pending.lastIndexOf('\n');
      if (end < 0) return;
      lines(pending.slice(0, end), log);
      pending = pending.slice(end + 1);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      lines(pending, log);
      try {
        resolve(resultOf(job, Buffer.concat(stdout), `code ${code}`));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(v8.serialize(job));
  });
}

// A digest of the code a map's built files come from: the modules `roots`
// name and everything they require. Part of every cache key here, so a
// parser change rebuilds what the old parser wrote.
function codeDigest(roots) {
  const hash = crypto.createHash('sha256');
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const child of require.cache[file]?.children || []) walk(child.filename);
  };
  for (const root of roots) walk(require.resolve(root));
  for (const file of [...seen].sort()) {
    hash.update(file);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
}

// A cache key: a digest of whatever names the inputs.
function keyOf(...parts) {
  return crypto.createHash('sha256').update(v8.serialize(parts)).digest('hex').slice(0, 24);
}

// Removes every file in `dir` but those named in `keep`.
function pruneDir(dir, keep, log) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (error) {
      log(`Could not remove ${path.join(dir, name)}: ${error.message}`);
    }
  }
}

module.exports = {
  runMapBuild, runMapBuildSync, codeDigest, keyOf, pruneDir,
};
