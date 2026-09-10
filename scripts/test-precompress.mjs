#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The sidecar cache's two dangers are serving a stale body, which is the desync
// the whole cache policy exists to prevent, and growing without bound across
// edits. Both come down to the digest in a sidecar's name, so that is what these
// exercise: a changed source must not be answered from the old sidecar, and the
// old sidecar must not survive the pass that noticed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const precompress = require('../server/precompress.cjs');

const { acceptsBrotli, eligible } = precompress;

// Which files get a sidecar at all.
assert.equal(eligible('/client.js'), true);
assert.equal(eligible('/render.mjs'), true);
assert.equal(eligible('/index.html'), true);
assert.equal(eligible('/styles.css'), true);
assert.equal(eligible('/obj/bzflag.obj'), true);
assert.equal(eligible('/favicon.svg'), true);
// Already compressed, or wanting a different container rather than a compressor.
assert.equal(eligible('/textures/std_ground.png'), false);
assert.equal(eligible('/audio/explosion.wav'), false);
assert.equal(eligible('/favicon.ico'), false);
// The install log wants to see these reach it.
assert.equal(eligible('/icons/any-192.png'), false);
assert.equal(eligible('/manifest.webmanifest'), false);
// Of three's eleven builds the game fetches two, and the rest are not worth
// half a minute of q11 each.
assert.equal(eligible('/vendor/three/three.module.js'), true);
assert.equal(eligible('/vendor/three/three.core.js'), true);
assert.equal(eligible('/vendor/three/three.webgpu.js'), false);
assert.equal(eligible('/vendor/three/addons/loaders/OBJLoader.js'), false);

// Accept-Encoding, including the forms that refuse brotli.
assert.equal(acceptsBrotli('gzip, deflate, br, zstd'), true);
assert.equal(acceptsBrotli('br'), true);
assert.equal(acceptsBrotli('gzip, br;q=0.5'), true);
assert.equal(acceptsBrotli('*'), true);
assert.equal(acceptsBrotli('gzip, deflate'), false);
assert.equal(acceptsBrotli('gzip, br;q=0'), false);
assert.equal(acceptsBrotli('br;q=0, *'), false, 'an explicit refusal outranks the wildcard');
assert.equal(acceptsBrotli(''), false);
assert.equal(acceptsBrotli(undefined), false);
// A name brotli is only a prefix of must not be read as brotli.
assert.equal(acceptsBrotli('brotli-ish'), false);

// Only a sidecar that is actually gone retires the sidecar. A client that hangs
// up part way through a download fails the send too, and treating that as a
// missing file would take the compressed copy out of service for everyone else
// until the next restart -- silently, since identity is a correct answer.
assert.equal(precompress.isMissingFile({ code: 'ENOENT' }), true);
assert.equal(precompress.isMissingFile({ code: 'EACCES' }), true);
assert.equal(precompress.isMissingFile({ code: 'ECONNABORTED' }), false, 'a client hangup keeps it');
assert.equal(precompress.isMissingFile({ code: 'EPIPE' }), false, 'so does a broken pipe');
assert.equal(precompress.isMissingFile({ code: 'ERR_STREAM_PREMATURE_CLOSE' }), false);
assert.equal(precompress.isMissingFile(null), false);

// A tree to compress, kept out of the repository.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-br-'));
const cacheDir = path.join(root, 'cache', 'br');
const sourceDir = path.join(root, 'public');
fs.mkdirSync(path.join(sourceDir, 'obj'), { recursive: true });

const wide = (marker) => `${marker}\n${'v 1.0 2.0 3.0\n'.repeat(400)}`;
const objPath = path.join(sourceDir, 'obj', 'thing.obj');
const pngPath = path.join(sourceDir, 'flat.png');
fs.writeFileSync(objPath, wide('# first'));
fs.writeFileSync(pngPath, Buffer.from('89504e470d0a1a0a', 'hex'));

const plan = () => {
  precompress.configure({ cacheDir });
  for (const [urlPath, filePath] of [['/obj/thing.obj', objPath], ['/flat.png', pngPath]]) {
    precompress.consider(urlPath, filePath, fs.readFileSync(filePath));
  }
};

plan();
assert.equal(precompress._state.planned.has('/obj/thing.obj'), true);
assert.equal(precompress._state.planned.has('/flat.png'), false, 'a PNG is never planned');

const first = await precompress.start();
assert.equal(first.compressed, 1, 'the one eligible file is compressed');
assert.ok(first.br < first.raw, 'a sidecar is smaller than its source');

const firstEntry = precompress._state.planned.get('/obj/thing.obj');
assert.equal(firstEntry.ready, true);
assert.ok(fs.existsSync(firstEntry.sidecar));
assert.equal(
  zlib.brotliDecompressSync(fs.readFileSync(firstEntry.sidecar)).toString(),
  wide('# first'),
  'the sidecar decompresses to exactly its source',
);

// Planning again over an unchanged tree compresses nothing and keeps what is
// there: this is what every restart does, and it must not redo the work.
plan();
const second = await precompress.start();
assert.equal(second.compressed, 0, 'an unchanged tree is not recompressed');
assert.equal(second.removed, 0, 'and nothing is swept');
assert.equal(precompress._state.planned.get('/obj/thing.obj').ready, true);

// The source changes. The old sidecar is a name nothing looks up, so the entry
// starts out unready -- the identity file is served until the new one is built
// -- and the sweep takes the old one with it.
const staleSidecar = firstEntry.sidecar;
fs.writeFileSync(objPath, wide('# second'));
plan();
const changed = precompress._state.planned.get('/obj/thing.obj');
assert.notEqual(changed.digest, firstEntry.digest, 'a changed source has a new digest');
assert.equal(changed.ready, false, 'and is not served from the old sidecar');

const third = await precompress.start();
assert.equal(third.compressed, 1, 'the changed source is compressed again');
assert.equal(third.removed, 1, 'and its old sidecar is swept');
assert.equal(fs.existsSync(staleSidecar), false, 'the stale sidecar is gone');
assert.equal(
  zlib.brotliDecompressSync(fs.readFileSync(changed.sidecar)).toString(),
  wide('# second'),
  'the new sidecar carries the new bytes',
);

// A source that leaves the tree takes its sidecar with it rather than leaving
// the cache to grow across edits.
const orphan = changed.sidecar;
precompress.configure({ cacheDir });
const fourth = await precompress.start();
assert.equal(fourth.removed, 1, 'a sidecar nothing names is swept');
assert.equal(fs.existsSync(orphan), false);

// Incompressible input gets no sidecar, because the decode would cost a client
// something and save nothing.
const noisePath = path.join(sourceDir, 'noise.json');
fs.writeFileSync(noisePath, require('node:crypto').randomBytes(4096));
precompress.configure({ cacheDir });
precompress.consider('/noise.json', noisePath, fs.readFileSync(noisePath));
const fifth = await precompress.start();
assert.equal(fifth.compressed, 0, 'nothing is written when brotli does not help');
assert.equal(precompress._state.planned.get('/noise.json').ready, false);

// A cache directory that cannot be written is not an error: every request falls
// through to the identity file.
const blocked = path.join(root, 'blocked');
fs.writeFileSync(blocked, 'not a directory');
precompress.configure({ cacheDir: path.join(blocked, 'br') });
precompress.consider('/obj/thing.obj', objPath, fs.readFileSync(objPath));
const refused = await precompress.start();
assert.equal(refused.compressed, 0);
assert.equal(precompress._state.disabled, true, 'and the middleware stands aside');

fs.rmSync(root, { recursive: true, force: true });
console.log('brotli sidecar tests passed');
