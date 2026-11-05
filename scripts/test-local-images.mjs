#!/usr/bin/env node
// A server's own map textures (server/local-images.cjs): which names reach
// `/img/`, which files the route serves, and what each kind of client is
// told a map's texture is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { localImageUrl, findLocalImage, localImageRefusal } = require('../server/local-images.cjs');
const { parseBZWMap, configureBzwParse } = require('../server/bzw-parse.cjs');
const { compileBzwWorld } = require('../server/bzw-compile.cjs');

assert.equal(localImageUrl('/img/wall.png'), '/img/wall.png');
assert.equal(localImageUrl('/IMG/a/b.png'), '/img/a/b.png');
assert.equal(localImageUrl('wall'), '/img/wall', 'a bare name');
assert.equal(localImageUrl('mymap\\wall.png'), '/img/mymap/wall.png', 'a Windows path');
assert.equal(localImageUrl('my wall'), '/img/my%20wall');
assert.equal(localImageUrl('../secret'), null, 'no climbing out');
assert.equal(localImageUrl('/etc/passwd'), null, 'no other absolute path');
assert.equal(localImageUrl('C:/textures/wall.png'), null, 'no drive letter');
assert.equal(localImageUrl('http://host/x.png'), null, 'a URL is not local');
assert.equal(localImageUrl(''), null);

// A PNG header claiming `width` x `height`, padded to `size` bytes.
const png = (width, height, size = 64) => {
  const out = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(out);
  out.write('IHDR', 12, 'latin1');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-img-'));
fs.mkdirSync(path.join(dir, 'mymap'));
fs.writeFileSync(path.join(dir, 'wall.png'), png(256, 256));
fs.writeFileSync(path.join(dir, 'mymap', 'roof.png'), png(996, 1224));
fs.writeFileSync(path.join(dir, 'huge.png'), png(32768, 32768));
fs.writeFileSync(path.join(dir, 'fake.png'), Buffer.from('GIF89a not a png'));
fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');

assert.equal(findLocalImage(dir, '/wall.png'), path.join(dir, 'wall.png'));
assert.equal(findLocalImage(dir, '/wall'), path.join(dir, 'wall.png'), 'then with .png');
assert.equal(findLocalImage(dir, '/mymap/roof'), path.join(dir, 'mymap', 'roof.png'));
assert.equal(findLocalImage(dir, '/missing'), null);
assert.equal(findLocalImage(dir, '/notes.txt'), null, 'PNG only');
assert.equal(findLocalImage(dir, '/../wall.png'), null);
assert.equal(findLocalImage(dir, '/%2e%2e/wall.png'), null, 'an encoded climb');
assert.equal(findLocalImage(dir, '/mymap%2f..%2fwall.png'), null, 'an encoded slash');
assert.equal(localImageRefusal(path.join(dir, 'wall.png')), null);
assert.equal(localImageRefusal(path.join(dir, 'mymap', 'roof.png')), null, 'the largest a real map uses');
assert.match(localImageRefusal(path.join(dir, 'huge.png')), /over 2048/);
assert.equal(localImageRefusal(path.join(dir, 'fake.png')), 'not a PNG');
fs.writeFileSync(path.join(dir, 'big.png'), png(64, 64, 5 * 1024 * 1024));
assert.match(localImageRefusal(path.join(dir, 'big.png')), /bytes, over/);
fs.rmSync(dir, { recursive: true });

// A browser is sent `/img/` for a non-stock name; a stock name stays stock.
const text = [
  'material', '  name local', '  texture mywall', 'end',
  'material', '  name direct', '  texture /img/sign.png', 'end',
  'material', '  name stock', '  texture boxwall', 'end',
  'box', '  position 0 0 0', '  size 10 10 10', '  matref local', 'end',
  'box', '  position 50 0 0', '  size 10 10 10', '  matref direct', 'end',
  'box', '  position -50 0 0', '  size 10 10 10', '  matref stock', 'end',
].join('\n');
const parsed = JSON.stringify(parseBZWMap('local-images.bzw', { quiet: true, text }));
assert.ok(parsed.includes('"/img/mywall"'), 'a bare name goes to /img/');
assert.ok(parsed.includes('"/img/sign.png"'));
assert.ok(!parsed.includes('/img/boxwall'), 'a stock name is not local');

// Every texture name or URL anywhere in a parsed map or compiled world, for
// comparing whole rather than by substring.
const textureValues = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((item) => textureValues(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /texture|^name$/i.test(key) && /^(\/|https?:)/.test(item)) found.add(item);
      else textureValues(item, found);
    }
  }
  return found;
};

// A texture URL on one of this server's own names reaches a browser as its
// path; another host's stays a URL.
configureBzwParse({ ownHosts: ['bz.example.org'] });
const own = textureValues(parseBZWMap('own.bzw', { quiet: true, text: [
  'material', '  name a', '  texture http://bz.example.org:5154/img/a.png', 'end',
  'material', '  name b', '  texture https://BZ.example.org/img/b.png', 'end',
  'material', '  name c', '  texture http://images.bzflag.org/x/c.png', 'end',
  'box', '  position 0 0 0', '  size 10 10 10', '  matref a', 'end',
  'box', '  position 50 0 0', '  size 10 10 10', '  matref b', 'end',
  'box', '  position -50 0 0', '  size 10 10 10', '  matref c', 'end',
].join('\n') }));
assert.deepEqual([...own].sort(), ['//images.bzflag.org/x/c.png', '/img/a.png', '/img/b.png'],
  'our host becomes a path; another host stays a URL');
configureBzwParse({ ownHosts: [] });

// A native client is sent an `/img/` name as an absolute URL, and a bare
// name as written.
const names = (tree) => JSON.stringify(tree);
const rename = (name) => (name.startsWith('/img/') ? `http://example.org:5154${name}` : name);
const nativeTree = compileBzwWorld(text, { textureName: rename });
const native = names(nativeTree);
assert.ok(textureValues(nativeTree).has('http://example.org:5154/img/sign.png'));
assert.ok(native.includes('"mywall"'));
assert.ok(!names(compileBzwWorld(text)).includes('http://'), 'no rename without one');

console.log('test-local-images: ok');
