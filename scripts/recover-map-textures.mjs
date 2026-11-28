#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Finds a map's missing textures where its author posted them: attached to
// the map's forum thread, alone or in an archive (docs/map-archive.md,
// "Textures"):
//
//   node scripts/recover-map-textures.mjs [--dry-run 1] [--maps data/maps]
//        [--img data/img] [--images /var/www/images-dev]
//        [--cache /tmp/bzo-map-archive]
//
// A missing texture is a name that resolves to nothing or a URL
// `data/cache/image-check.json` found missing. One found attached under the
// same file name, and a PNG, is matched by its bytes against the local copy
// of images.bzflag.org first: the same file there is what the map is pointed
// at, since a BZFlag client loads that too. Otherwise it is saved under
// `--img` and the map points at `/img/`, which only this server serves.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createArchiveFetch } from './archive-fetch.mjs';

const require = createRequire(import.meta.url);
const { parseBZWMap, configureBzwParse } = require('../server/bzw-parse.cjs');
const { splitBzwMetadata } = require('../server/bzw-metadata.cjs');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const MAPS = path.resolve(ROOT, args.get('maps') || 'data/maps');
const IMG = path.resolve(ROOT, args.get('img') || 'data/img');
const IMAGES = path.resolve(args.get('images') || '/var/www/images-dev');
const CACHE = path.resolve(args.get('cache') || '/tmp/bzo-map-archive');
const CHECKS = path.resolve(ROOT, 'data/cache/image-check.json');
const DRY_RUN = Boolean(args.get('dry-run'));
const IMAGE_HOST = 'images.bzflag.org';

const { fetchCached } = createArchiveFetch({
  cache: CACHE, userAgent: 'bzo map textures (https://github.com/timriker/bzo)',
});
configureBzwParse({ log: () => {} });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const ARCHIVE = /\.(zip|tar\.gz|tgz|tar\.bz2)$/i;
const md5 = (body) => crypto.createHash('md5').update(body).digest('hex');
// A texture as a name to match a file by: its file name, case aside, with
// no `.png`, as `MediaFile::readImage` adds one.
const key = (ref) => {
  const last = decodeURIComponent(String(ref).split(/\s/)[0].split(/[?#]/)[0]).split('/').pop();
  return last.toLowerCase().replace(/\.png$/, '');
};

// Every file of the local images.bzflag.org copy by its bytes' md5.
function imagesByMd5() {
  const byMd5 = new Map();
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.png$/i.test(entry.name)) byMd5.set(md5(fs.readFileSync(file)), path.relative(IMAGES, file));
    }
  }(IMAGES));
  return byMd5;
}

// A thread's attachments, every page, as `{ name, url }`.
async function threadAttachments(thread) {
  const found = [];
  for (let start = 0; start < 250; start += 25) {
    const html = await fetchCached(start ? `${thread}&start=${start}` : thread);
    if (!html) break;
    for (const m of html.matchAll(/href="\.\/download\/file\.php\?id=(\d+)[^"]*">([^<]+)<\/a>/g)) {
      found.push({ name: m[2].trim(), url: `https://forums.bzflag.org/download/file.php?id=${m[1]}` });
    }
    if (!html.includes(`start=${start + 25}`)) break;
  }
  return found;
}

// The members of an archive whose names `wanted` has, as `{ name, body }`.
function fromArchive(name, body, wanted) {
  const dir = fs.mkdtempSync(path.join(CACHE, 'unpack-'));
  const file = path.join(dir, 'archive');
  fs.writeFileSync(file, body);
  const run = (cmd, list) => execFileSync(cmd, list, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const zip = /\.zip$/i.test(name);
    const flag = /\.tar\.bz2$/i.test(name) ? 'j' : 'z';
    const members = (zip ? run('unzip', ['-Z1', file]) : run('tar', [`-t${flag}f`, file])).toString().split('\n')
      .filter((member) => member && !member.endsWith('/') && wanted.has(key(member)));
    return members.map((member) => ({
      name: path.basename(member),
      body: zip ? run('unzip', ['-p', file, member]) : run('tar', [`-x${flag}Of`, file, member]),
    }));
  } catch {
    return [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function addNote(text, note) {
  if (/^endmetadata\s*$/m.test(text)) return text.replace(/^endmetadata\s*$/m, `  note ${note}\nendmetadata`);
  return `metadata\n  note ${note}\nendmetadata\n\n${text}`;
}

async function main() {
  const checks = JSON.parse(fs.readFileSync(CHECKS, 'utf8'));
  const byMd5 = imagesByMd5();
  const summary = { maps: 0, onImages: 0, local: 0 };
  for (const name of fs.readdirSync(MAPS).filter((file) => file.endsWith('.bzw') && !file.startsWith('import-')).sort()) {
    const file = path.join(MAPS, name);
    const text = fs.readFileSync(file, 'utf8');
    let map;
    try {
      map = parseBZWMap(name, { quiet: true, text });
    } catch {
      continue;
    }
    const missing = [
      ...map.unresolvedTextureNames,
      ...map.externalTextureUrls.filter((url) => checks[url]?.ok === false || /photobucket\.com\//i.test(url)),
    ];
    const thread = (splitBzwMetadata(text).metadata?.sourceurl || [])
      .find((url) => /forums\.bzflag\.org\/viewtopic/.test(url));
    if (!missing.length || !thread) continue;
    const wanted = new Set(missing.map(key));
    // The last posted of each name, a later post being a fix.
    const found = new Map();
    for (const attachment of await threadAttachments(thread)) {
      const direct = wanted.has(key(attachment.name));
      if (!direct && !ARCHIVE.test(attachment.name)) continue;
      const body = await fetchCached(attachment.url, { binary: true });
      if (!body) continue;
      const files = direct ? [{ name: attachment.name, body }] : fromArchive(attachment.name, body, wanted);
      for (const one of files) {
        if (one.body.subarray(0, 4).equals(PNG)) found.set(key(one.name), { ...one, from: attachment.url });
      }
    }
    if (!found.size) continue;
    const stem = name.replace(/\.bzw$/i, '');
    const fixes = new Map();
    for (const [texture, image] of found) {
      const copy = byMd5.get(md5(image.body));
      if (copy) {
        fixes.set(texture, `http://${IMAGE_HOST}/${copy.split('/').map(encodeURIComponent).join('/')}`);
        summary.onImages += 1;
      } else {
        const local = path.join(IMG, stem, `${texture}.png`);
        if (!DRY_RUN) {
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, image.body);
        }
        fixes.set(texture, `/img/${encodeURIComponent(stem)}/${encodeURIComponent(texture)}.png`);
        summary.local += 1;
      }
    }
    const missingRefs = new Set(missing.map((ref) => ref.split(/\s/)[0]));
    let changed = 0;
    const next = text.split('\n').map((line) => {
      const m = /^(\s*(?:add)?texture\s+)(\S+)(.*)$/i.exec(line);
      if (!m) return line;
      const ref = m[2].replace(/^https?:/i, '');
      if (!missingRefs.has(ref) && !missingRefs.has(m[2])) return line;
      const fix = fixes.get(key(m[2]));
      if (!fix) return line;
      changed += 1;
      return `${m[1]}${fix}${m[3]}`;
    }).join('\n');
    if (!changed) continue;
    summary.maps += 1;
    console.log(`${name}: ${changed} line(s), ${found.size} of ${wanted.size} texture(s) found on its thread`);
    if (!DRY_RUN) {
      fs.writeFileSync(file, addNote(next, `Missing textures restored from the files attached to its forum thread, ${thread}.`));
    }
  }
  console.log(`${DRY_RUN ? 'Dry run: ' : ''}${summary.maps} map(s) changed; ${summary.onImages} texture(s) matched`
    + ` a file on ${IMAGE_HOST}, ${summary.local} saved under ${IMG}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
