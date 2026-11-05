/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// local-images.cjs - A server's own map textures: PNGs in `img/` beside its
// config (`data/img/` in a checkout, `/data/img/` in Docker), served at
// `/img/`. A map names one as `/img/name.png`, or by the bare name a native
// client looks up in its own data directory (`MediaFile::readImage`), so a
// map made for players who installed its textures plays as it is.
'use strict';

const fs = require('fs');
const path = require('path');

const IMG_URL_PREFIX = '/img/';
// Larger than any texture a real map names (the biggest on images.bzflag.org
// that a map here uses is 996x1224, 1.8 MB), and far short of the sizes that
// overflow a native client's decoder.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2048;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The `/img/` URL a texture name refers to, or null: `/img/a/b.png` as it
// is, and a bare relative name -- `wall`, `mymap/wall.png` -- under `/img/`.
// A URL, any other absolute path, or a name climbing out with `..` is none.
function localImageUrl(rawName) {
  let name = String(rawName || '').trim().replace(/\\/g, '/');
  if (name.toLowerCase().startsWith(IMG_URL_PREFIX)) name = name.slice(IMG_URL_PREFIX.length);
  else if (name.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(name)) return null;
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return IMG_URL_PREFIX + parts.map(encodeURIComponent).join('/');
}

// The file `/img/<rest>` serves, tried as written and then with `.png`, as
// `MediaFile::readImage` tries a name; null when neither is a PNG in `dir`.
function findLocalImage(dir, rest) {
  let parts;
  try {
    parts = String(rest).split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..' || /[\\/\0]/.test(part))) return null;
  const root = path.resolve(dir);
  const base = path.join(root, ...parts);
  if (!base.startsWith(root + path.sep)) return null;
  for (const file of [base, `${base}.png`]) {
    if (!file.toLowerCase().endsWith('.png')) continue;
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Not there; the next candidate.
    }
  }
  return null;
}

// Why `file` may not be served, or null when it may: a PNG by its signature,
// at most MAX_IMAGE_BYTES, each side 1 to MAX_IMAGE_SIDE by its header.
function localImageRefusal(file) {
  let size;
  const head = Buffer.alloc(24);
  try {
    size = fs.statSync(file).size;
    if (size > MAX_IMAGE_BYTES) return `${size} bytes, over ${MAX_IMAGE_BYTES}`;
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return error.message;
  }
  if (!head.subarray(0, 8).equals(PNG_SIGNATURE) || head.toString('latin1', 12, 16) !== 'IHDR') return 'not a PNG';
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    return `${width}x${height}, over ${MAX_IMAGE_SIDE} a side`;
  }
  return null;
}

module.exports = {
  IMG_URL_PREFIX, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, localImageUrl, findLocalImage, localImageRefusal,
};
