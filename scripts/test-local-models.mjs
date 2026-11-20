#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A server's own tank models (server/local-models.cjs): which files
// `/data/obj/` serves, and the limits a model is held to before it is offered.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  MAX_MODEL_TRIANGLES, localModelFile, readObjCost, textureRefusal, checkLocalModel,
} = require('../server/local-models.cjs');

const dir = mkdtempSync(path.join(os.tmpdir(), 'bzo-local-models-'));
const put = (name, data) => writeFileSync(path.join(dir, name), data);

// A JPEG with nothing in it but the markers its size is read from.
function jpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

const quad = (count) => Array.from({ length: count }, () => 'f 1 2 3 4').join('\n');

try {
  put('tank.obj', 'mtllib tank.mtl\no body\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  put('tank.mtl', 'newmtl team\nmap_Kd tank.jpg\n');
  put('tank.jpg', jpeg(512, 512));
  put('notes.txt', 'not a model file');
  put('.hidden.obj', 'o body\n');

  // --- what /data/obj/ serves ----------------------------------------------
  assert.ok(localModelFile(dir, 'tank.obj'), 'an OBJ beside the config is served');
  assert.ok(localModelFile(dir, 'tank.jpg'), 'and its texture');
  assert.equal(localModelFile(dir, 'notes.txt'), null, 'nothing but model files');
  assert.equal(localModelFile(dir, '.hidden.obj'), null, 'no dotfiles');
  assert.equal(localModelFile(dir, '../tank.obj'), null, 'nothing above the folder');
  assert.equal(localModelFile(dir, 'sub/tank.obj'), null, 'nothing below it');
  assert.equal(localModelFile(dir, 'missing.obj'), null, 'nothing that is not there');

  // --- what a model costs ---------------------------------------------------
  assert.deepEqual(readObjCost('mtllib a.mtl\nf 1 2 3\nf 1 2 3 4\nmtllib b.mtl\n'),
    { triangles: 3, library: 'a.mtl' }, 'a quad is two triangles, and the first library is the one');

  // --- the limits -----------------------------------------------------------
  assert.deepEqual(checkLocalModel(dir, path.join(dir, 'tank.obj')), { refusal: null, warning: null },
    'a model inside the limits is fine');

  put('big.obj', `o body\n${quad(Math.ceil(MAX_MODEL_TRIANGLES / 2) + 1)}\n`);
  assert.match(checkLocalModel(dir, path.join(dir, 'big.obj')).refusal, /triangles, over/,
    'too many triangles is refused');

  put('lost.obj', 'mtllib lost.mtl\no body\nf 1 2 3\n');
  put('lost.mtl', 'newmtl team\nmap_Kd nowhere.png\n');
  const lost = checkLocalModel(dir, path.join(dir, 'lost.obj'));
  assert.equal(lost.refusal, null, 'a missing texture still leaves the model drawable');
  assert.match(lost.warning, /nowhere\.png is not beside it/, 'and says which texture');

  put('wide.jpg', jpeg(4096, 512));
  assert.match(textureRefusal(path.join(dir, 'wide.jpg')), /over 2048 a side/, 'a JPEG is held to the map textures\' size');
  put('fake.jpg', 'not a jpeg');
  assert.equal(textureRefusal(path.join(dir, 'fake.jpg')), 'not a JPEG');
  assert.equal(textureRefusal(path.join(dir, 'tank.jpg')), null);

  put('wide.obj', 'mtllib wide.mtl\no body\nf 1 2 3\n');
  put('wide.mtl', 'newmtl team\nmap_Kd wide.jpg\n');
  assert.match(checkLocalModel(dir, path.join(dir, 'wide.obj')).warning, /wide\.jpg refused/,
    'a texture over the limits leaves the model in the team skin');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('local model tests passed');
