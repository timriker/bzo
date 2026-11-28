#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Points map textures at images.bzflag.org, the one host a BZFlag client
// loads images from, and keeps a local copy of every one a map names
// (docs/map-archive.md, "Textures"):
//
//   node scripts/migrate-map-textures.mjs [--dry-run 1]
//        [--images /var/www/images-dev] [--maps data/maps,maps]
//        [--img data/img]
//
// An images.bzflag.org texture missing from `--images` is downloaded into it.
// A texture on an old host images.bzflag.org keeps a copy of is pointed at
// that copy, once the copy is known to be there, and the map's metadata gets
// a `note` saying so. Anything else is reported, not guessed at: a file name
// alone does not say which of several `wood.png`s a map meant.

import fs from 'node:fs';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const IMAGES = path.resolve(args.get('images') || '/var/www/images-dev');
const MAP_DIRS = (args.get('maps') || 'data/maps,maps').split(',').map((dir) => path.resolve(ROOT, dir));
const DRY_RUN = Boolean(args.get('dry-run'));
const IMG = path.resolve(ROOT, args.get('img') || 'data/img');
const IMAGE_HOST = 'images.bzflag.org';
const USER_AGENT = 'bzo map textures (https://github.com/timriker/bzo)';

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

// Old hosts images.bzflag.org keeps copies of, each as the places on it a
// file from that host may be, most specific first: `rest` is the path after
// the host's own prefix, `base` its file name.
const OLD_HOSTS = [
  {
    host: 'louman.bzflag.bz', prefix: '/textures/', dir: 'bz_legacy/louman',
    candidates: ({ rest, base }) => [`bz_legacy/louman/${rest}`, `bz_legacy/louman/${base}`],
  },
  {
    host: 'trepan.bzflag.bz', prefix: '/', dir: 'bz_legacy/trepan',
    candidates: ({ rest, base }) => [`bz_legacy/trepan/${rest}`, `bz_legacy/trepan/${base}`,
      `bz_legacy/trepan/tiles/${base}`, `bz_legacy/louman/${base}`],
  },
  {
    host: 'fusion.bzflag.org', prefix: '/', dir: 'bz_legacy/fusion',
    candidates: ({ rest, base }) => [`bz_legacy/fusion/${rest}`, `bz_legacy/fusion/${base}`],
  },
  // The Purple Panzer's own hosts, re-uploaded under one name.
  { host: 'images.planet-mofo.com', prefix: '/', dir: 'bbentz', candidates: ({ base }) => [`bbentz/${base}`] },
  { host: 'cbg.bzflag.org', prefix: '/', dir: 'bbentz', candidates: ({ base }) => [`bbentz/${base}`] },
];

const TEXTURE_LINE = /^(\s*(?:add)?texture\s+)(https?:\/\/[^\s#]+)/i;

// Every file in the image cache by its path, lower-cased, so a candidate
// matches the case the cache has it in.
const cached = new Map();
(function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // A name that is not UTF-8 reads back as one that is not there.
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else cached.set(path.relative(IMAGES, file).toLowerCase(), path.relative(IMAGES, file));
  }
}(IMAGES));

const imageUrl = (relative) => `http://${IMAGE_HOST}/${relative.split('/').map(encodeURIComponent).join('/')}`;

// A cached path, or one downloaded from images.bzflag.org into the cache;
// null when images.bzflag.org does not have it either.
const fetched = new Map();
async function ensureImage(relative) {
  const known = cached.get(relative.toLowerCase());
  if (known) return known;
  if (fetched.has(relative)) return fetched.get(relative);
  await sleep(1000);
  const response = await fetch(imageUrl(relative), { headers: { 'User-Agent': USER_AGENT } }).catch(() => null);
  let result = null;
  if (response?.ok && /^image\//.test(response.headers.get('content-type') || '')) {
    const body = Buffer.from(await response.arrayBuffer());
    if (!DRY_RUN) {
      fs.mkdirSync(path.dirname(path.join(IMAGES, relative)), { recursive: true });
      fs.writeFileSync(path.join(IMAGES, relative), body);
    }
    cached.set(relative.toLowerCase(), relative);
    result = relative;
  }
  fetched.set(relative, result);
  return result;
}

// A texture with no copy on images.bzflag.org, kept under `--img` by host
// and path and served from `/img/`: the archive keeps the images its maps
// use, and a host that sends no CORS headers is one a headset cannot load
// from at all. Fetched once, while its own host still serves it; null when
// it does not.
const PHOTOBUCKET = /(^|\.)photobucket\.com$/i;
async function cacheLocally(url, host, pathname) {
  // Photobucket answers with its own watermark over the picture, not the
  // picture the map named.
  if (PHOTOBUCKET.test(host)) return null;
  const parts = [host, ...pathname.split('/').filter((part) => part && part !== '.' && part !== '..')];
  const target = path.join(IMG, ...parts);
  if (!fs.existsSync(target)) {
    await sleep(1000);
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10000) })
      .catch(() => null);
    if (!response?.ok || !/^image\/png/.test(response.headers.get('content-type') || '')) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (!DRY_RUN) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
  }
  cachedLocally.add(url);
  return { url: `/img/${parts.map(encodeURIComponent).join('/')}`, from: host, dir: '/img/' };
}
const cachedLocally = new Set();

// Where a texture URL should point, and the old host it came from, or why not.
async function resolve(url) {
  const match = /^https?:\/\/([^/]+)(\/[^#\s]*)/i.exec(url);
  if (!match) return { problem: 'not a URL' };
  const host = match[1].toLowerCase();
  let pathname;
  try {
    pathname = decodeURIComponent(match[2]);
  } catch {
    return { problem: 'bad URL' };
  }
  // Other names images.bzflag.org has gone by, the same paths under each.
  if (host === IMAGE_HOST || host === 'images.bzflag.com' || host === 'images.bzflag.bz') {
    const relative = pathname.replace(/^\/+/, '');
    const found = await ensureImage(relative);
    if (!found) return { problem: `not on ${IMAGE_HOST}` };
    return { url: host === IMAGE_HOST && found === relative ? url : imageUrl(found), from: host === IMAGE_HOST ? '' : host };
  }
  const old = OLD_HOSTS.find((candidate) => candidate.host === host);
  if (!old) return (await cacheLocally(url, host, pathname)) || { problem: `no copy known for ${host}` };
  const rest = pathname.startsWith(old.prefix) ? pathname.slice(old.prefix.length) : pathname.replace(/^\/+/, '');
  for (const candidate of old.candidates({ rest, base: path.basename(pathname) })) {
    const found = await ensureImage(candidate);
    if (found) return { url: imageUrl(found), from: host, dir: old.dir };
  }
  return (await cacheLocally(url, host, pathname)) || { problem: `no copy in ${old.dir}` };
}

function addNote(text, note) {
  if (/^metadata\s*$/m.test(text) && /^endmetadata\s*$/m.test(text)) {
    return text.replace(/^endmetadata\s*$/m, `  note ${note}\nendmetadata`);
  }
  return `metadata\n  note ${note}\nendmetadata\n\n${text}`;
}

async function main() {
  const resolved = new Map();
  const problems = new Map();
  let changedMaps = 0;
  let changedLines = 0;
  for (const dir of MAP_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.bzw') && !file.startsWith('import-')).sort()) {
      const file = path.join(dir, name);
      const text = fs.readFileSync(file, 'utf8');
      const sources = new Set();
      let changed = 0;
      const lines = [];
      for (const line of text.split('\n')) {
        const match = TEXTURE_LINE.exec(line);
        if (!match) {
          lines.push(line);
          continue;
        }
        const url = match[2];
        if (!resolved.has(url)) resolved.set(url, await resolve(url));
        const result = resolved.get(url);
        if (result.problem) {
          if (!problems.has(url)) problems.set(url, { problem: result.problem, maps: new Set() });
          problems.get(url).maps.add(name);
        }
        if (result.url && result.url !== url) {
          lines.push(line.replace(url, result.url));
          if (result.from) sources.add(result.dir ? `${result.dir}, from ${result.from}` : result.from);
          changed += 1;
        } else {
          lines.push(line);
        }
      }
      if (!changed) continue;
      let next = lines.join('\n');
      const from = [...sources].sort();
      const copies = from.filter((source) => !source.startsWith('/img/'));
      const local = from.filter((source) => source.startsWith('/img/')).map((source) => source.replace(/^\/img\/, from /, ''));
      if (copies.length) next = addNote(next, `Textures loaded from ${IMAGE_HOST}'s copies (${copies.join('; ')}).`);
      if (local.length) next = addNote(next, `Textures kept on this server under /img/, copied from ${local.join(', ')}.`);
      changedMaps += 1;
      changedLines += changed;
      if (!DRY_RUN) fs.writeFileSync(file, next);
    }
  }
  const downloaded = [...fetched.values()].filter(Boolean).length;
  console.log(`${DRY_RUN ? 'Dry run: ' : ''}${resolved.size} texture URL(s); ${downloaded} downloaded to ${IMAGES};`
    + ` ${changedLines} line(s) in ${changedMaps} map(s) repointed, ${cachedLocally.size} texture(s) kept under ${IMG};`
    + ` ${problems.size} left as they are.`);
  const byProblem = new Map();
  for (const [url, { problem, maps }] of problems) {
    if (!byProblem.has(problem)) byProblem.set(problem, []);
    byProblem.get(problem).push(`${url}  (${[...maps].join(', ')})`);
  }
  for (const [problem, urls] of [...byProblem].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${problem}: ${urls.length}`);
    for (const url of urls) console.log(`  ${url}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
