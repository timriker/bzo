/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// local-models.cjs - A server's own tank models: an OBJ in `obj/` beside its
// config (`data/obj/` in a checkout, `/data/obj/` in Docker), the MTL it
// names and the texture that names, served at `/data/obj/`
// (docs/tank-model-format.md, Server Models). Every client that meets a model
// parses it on its main thread, so a model is held to limits before it is
// offered; one over them is left out of the picker rather than sent.
'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, localImageRefusal } = require('./local-images.cjs');

const MODEL_FILE_TYPES = Object.freeze({
  '.obj': 'model/obj',
  '.mtl': 'model/mtl',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
});

// The bundled models top out near 8,000 triangles but for one; a model past
// this costs every client that meets it a visible stall while it parses.
const MAX_MODEL_TRIANGLES = 20000;
const MAX_OBJ_BYTES = 8 * 1024 * 1024;
const MAX_MTL_BYTES = 64 * 1024;

// The file `/data/obj/<name>` serves, or null: one of MODEL_FILE_TYPES, in
// `dir` itself and nowhere below or above it.
function localModelFile(dir, name) {
  const fileName = String(name || '');
  if (!MODEL_FILE_TYPES[path.extname(fileName).toLowerCase()]) return null;
  if (fileName.startsWith('.') || /[\\/\0]/.test(fileName)) return null;
  const root = path.resolve(dir);
  const file = path.join(root, fileName);
  if (path.dirname(file) !== root) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

// What an OBJ asks of a client: its triangles, each face of n corners being
// n - 2 of them, and the first material library it names.
function readObjCost(text) {
  let triangles = 0;
  let library = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('f ')) {
      triangles += Math.max(0, line.trim().split(/\s+/).length - 3);
    } else if (library === null && line.startsWith('mtllib ')) {
      library = line.slice(7).trim();
    }
  }
  return { triangles, library };
}

// A JPEG's size, from the start-of-frame segment the markers lead to.
function jpegSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const marker = Buffer.alloc(4);
    let offset = 2;
    const soi = Buffer.alloc(2);
    fs.readSync(fd, soi, 0, 2, 0);
    if (soi[0] !== 0xff || soi[1] !== 0xd8) return null;
    for (;;) {
      if (fs.readSync(fd, marker, 0, 4, offset) < 4 || marker[0] !== 0xff) return null;
      const type = marker[1];
      const length = marker.readUInt16BE(2);
      // SOF0-SOF15, but for DHT (C4), JPG (C8) and DAC (CC), which share the range.
      if (type >= 0xc0 && type <= 0xcf && type !== 0xc4 && type !== 0xc8 && type !== 0xcc) {
        const frame = Buffer.alloc(5);
        fs.readSync(fd, frame, 0, 5, offset + 4);
        return { width: frame.readUInt16BE(3), height: frame.readUInt16BE(1) };
      }
      offset += 2 + length;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Why a model's texture may not be used, or null: the map textures' rules,
// with JPEG allowed beside PNG since that is what model tools export.
function textureRefusal(file) {
  if (path.extname(file).toLowerCase() === '.png') return localImageRefusal(file);
  try {
    const { size } = fs.statSync(file);
    if (size > MAX_IMAGE_BYTES) return `${size} bytes, over ${MAX_IMAGE_BYTES}`;
    const dims = jpegSize(file);
    if (!dims) return 'not a JPEG';
    if (dims.width < 1 || dims.height < 1 || dims.width > MAX_IMAGE_SIDE || dims.height > MAX_IMAGE_SIDE) {
      return `${dims.width}x${dims.height}, over ${MAX_IMAGE_SIDE} a side`;
    }
  } catch (error) {
    return error.message;
  }
  return null;
}

// The model `objFile` in `dir`, held to the limits: `refusal` says why it may
// not be offered, `warning` what is wrong with it that still leaves it
// drawable -- a texture it names and cannot have, which leaves it in the team
// skin. Both null for a model that is fine.
function checkLocalModel(dir, objFile, text = null) {
  const result = { refusal: null, warning: null };
  const { size } = fs.statSync(objFile);
  if (size > MAX_OBJ_BYTES) {
    result.refusal = `${size} bytes, over ${MAX_OBJ_BYTES}`;
    return result;
  }
  const { triangles, library } = readObjCost(text ?? fs.readFileSync(objFile, 'utf8'));
  if (triangles > MAX_MODEL_TRIANGLES) {
    result.refusal = `${triangles} triangles, over ${MAX_MODEL_TRIANGLES}`;
    return result;
  }
  if (!library) return result;

  const mtlFile = localModelFile(dir, library);
  if (!mtlFile) {
    result.warning = `material library ${library} is not beside it`;
    return result;
  }
  const mtlSize = fs.statSync(mtlFile).size;
  if (mtlSize > MAX_MTL_BYTES) {
    result.warning = `${library} is ${mtlSize} bytes, over ${MAX_MTL_BYTES}`;
    return result;
  }
  const map = fs.readFileSync(mtlFile, 'utf8').match(/^\s*map_Kd\s+(?:-\S+\s+\S+\s+)*(\S.*?)\s*$/m);
  if (!map) return result;
  const textureFile = localModelFile(dir, map[1]);
  if (!textureFile) {
    result.warning = `texture ${map[1]} is not beside it`;
    return result;
  }
  const refusal = textureRefusal(textureFile);
  if (refusal) result.warning = `texture ${map[1]} refused: ${refusal}`;
  return result;
}

module.exports = {
  MODEL_FILE_TYPES, MAX_MODEL_TRIANGLES, MAX_OBJ_BYTES, MAX_MTL_BYTES,
  localModelFile, readObjCost, textureRefusal, checkLocalModel,
};
