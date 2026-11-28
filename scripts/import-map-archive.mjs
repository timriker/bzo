#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Fetches old BZFlag maps from public archives into a maps directory, each
// with a `metadata` block saying what could be learned of it
// (docs/map-archive-plan.md):
//
//   node scripts/import-map-archive.mjs [--out data/maps] [--dry-run 1]
//        [--cache /tmp/bzo-map-archive] [--source bzx|sf|forum|all]
//
// Downloads are kept in the cache directory, so a second run fetches nothing.
// A map already in `--out` or `maps/` with the same content is given the
// metadata rather than written twice. A report of every file, taken or not,
// is written to `<cache>/report.json`.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { FORUM_BASE, createArchiveFetch } from './archive-fetch.mjs';

const require = createRequire(import.meta.url);
const { parseBZWMap } = require('../server/bzw-parse.cjs');
const { splitBzwMetadata } = require('../server/bzw-metadata.cjs');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.resolve(args.get('out') || path.join(ROOT, 'data', 'maps'));
const CACHE = path.resolve(args.get('cache') || '/tmp/bzo-map-archive');
const DRY_RUN = Boolean(args.get('dry-run'));
const SOURCE = args.get('source') || 'all';

const BZX_INDEX = 'https://static.bzexcess.com/downloads/bzWorlds/';
// When the bzexcess archive was copied: every file there carries this date.
const BZX_ARCHIVED = '2011-07-30';
const SF_BASE = 'https://sourceforge.net';
const SF_TRACKER = `${SF_BASE}/p/bzflag/world-files/`;
// Tickets are numbered from 1; a run of this many missing in a row ends it.
const SF_GAP = 15;
const MAP_INDEX = 'https://wiki.bzflag.org/Map_Index';
const USER_AGENT = 'bzo map archive import (https://github.com/timriker/bzo)';

const { fetchCached } = createArchiveFetch({ cache: CACHE, userAgent: USER_AGENT });

const decodeEntities = (text) => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const stripTags = (html) => decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// --- Sources ----------------------------------------------------------------

async function bzexcessFiles() {
  const index = await fetchCached(BZX_INDEX);
  const links = [...index.matchAll(/href="(maps\/[^"]+\.bzw)"/gi)].map((m) => decodeEntities(m[1]));
  const files = [];
  for (const link of links) {
    const name = path.basename(link);
    const url = BZX_INDEX + link.split('/').map(encodeURIComponent).join('/');
    files.push({ source: 'bzx', name, url, body: await fetchCached(url, { binary: true }) });
  }
  return files;
}

// What a ticket may attach a world as: a `.bzw`, a `.map` (bzedit32 saved
// worlds under that name), or an archive of them.
const WORLD_FILE = /\.(bzw|map)$/i;
const ARCHIVE = /\.(zip|tar\.gz|tgz|tar\.bz2|gz|bz2)$/i;

// One SourceForge ticket: its title, date, creator and description, and the
// worlds attached to it or to its discussion, oldest first.
function parseTicket(html, number) {
  const title = stripTags(/<title>[^<]*\/\s*#\d+\s*([^<]*)<\/title>/i.exec(html)?.[1] || '');
  const created = /Created:<\/label>\s*<span[^>]*>\s*(\d{4}-\d{2}-\d{2})/i.exec(html)?.[1] || '';
  const creator = stripTags(/Creator:<\/label>\s*<a[^>]*>([^<]*)<\/a>/i.exec(html)?.[1] || '');
  const description = stripTags(/class="markdown_content">([\s\S]*?)<\/div>/i.exec(html)?.[1] || '');
  const attachments = [...new Set([...html.matchAll(/href="([^"]*\/attachment\/[^"]+)"/gi)]
    .map((m) => decodeEntities(m[1])))]
    .filter((href) => {
      const name = decodeURIComponent(href);
      return WORLD_FILE.test(name) || ARCHIVE.test(name);
    });
  return {
    number, title, created, creator, description,
    url: `${SF_TRACKER}${number}/`,
    attachments: attachments.map((href) => ({
      name: path.basename(decodeURIComponent(href)),
      url: href.startsWith('http') ? href : SF_BASE + href,
    })),
  };
}

// The worlds in an archive, as `{ name, body }`. A tool it needs and cannot
// run, or an archive it cannot read, gives none.
function unpack(name, body) {
  const dir = fs.mkdtempSync(path.join(CACHE, 'unpack-'));
  const file = path.join(dir, 'archive');
  fs.writeFileSync(file, body);
  const run = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    if (/\.zip$/i.test(name)) {
      return run('unzip', ['-Z1', file]).toString().split('\n').filter((m) => WORLD_FILE.test(m))
        .map((m) => ({ name: path.basename(m), body: run('unzip', ['-p', file, m]) }));
    }
    const tarFlag = /\.(tar\.gz|tgz)$/i.test(name) ? 'z' : /\.tar\.bz2$/i.test(name) ? 'j' : '';
    if (tarFlag) {
      return run('tar', [`-t${tarFlag}f`, file]).toString().split('\n').filter((m) => WORLD_FILE.test(m))
        .map((m) => ({ name: path.basename(m), body: run('tar', [`-x${tarFlag}Of`, file, m]) }));
    }
    const inner = name.replace(/\.(gz|bz2)$/i, '');
    if (!WORLD_FILE.test(inner)) return [];
    return [{ name: inner, body: /\.gz$/i.test(name) ? zlib.gunzipSync(body) : run('bzip2', ['-dc', file]) }];
  } catch {
    return [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function sourceforgeFiles() {
  const files = [];
  let missing = 0;
  for (let number = 1; missing < SF_GAP; number += 1) {
    const html = await fetchCached(`${SF_TRACKER}${number}/`);
    if (!html) {
      missing += 1;
      continue;
    }
    missing = 0;
    const ticket = parseTicket(html, number);
    // A ticket is one map, its later attachments newer versions or other
    // formats of it: the last is taken, and every world in it if it is an
    // archive (a pack of several maps).
    const attachment = ticket.attachments.at(-1);
    if (!attachment) continue;
    const body = await fetchCached(attachment.url, { binary: true });
    const worlds = body && ARCHIVE.test(attachment.name) ? unpack(attachment.name, body)
      : [{ name: attachment.name, body }];
    if (body && worlds.length === 0) {
      files.push({ source: 'sf', name: attachment.name, url: attachment.url, ticket, body: null, empty: true });
    }
    for (const world of worlds) {
      files.push({
        source: 'sf',
        name: world.name.replace(/\.map$/i, '.bzw'),
        url: worlds.length === 1 && world.name === attachment.name
          ? attachment.url : `${attachment.url}#${encodeURIComponent(world.name)}`,
        ticket,
        // One of several maps in a pack: the ticket's title is the pack's.
        inPack: worlds.length > 1,
        body: world.body,
      });
    }
  }
  return files;
}

// The wiki's Map Index: a section for each author, a row for each map naming
// its forum thread and the day it was published there.
function parseMapIndex(html) {
  const maps = [];
  for (const section of html.split(/<h1>/i).slice(1)) {
    const heading = /class="mw-headline"[^>]*>([\s\S]*?)<\/span>/i.exec(section)?.[1] || '';
    const author = stripTags(heading);
    const authorId = /memberlist\.php\?mode=viewprofile&amp;u=(\d+)/.exec(heading)?.[1] || '';
    for (const row of section.matchAll(/<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/gi)) {
      const topic = /href="https?:\/\/forums\.bzflag\.org\/viewtopic\.php\?[^"]*\bt=(\d+)/i.exec(row[2])?.[1];
      const published = /\d{4}-\d{2}-\d{2}/.exec(row[3])?.[0] || '';
      if (!topic && !published) continue;
      maps.push({ author, authorId, title: stripTags(row[1]), topic, published });
    }
  }
  return maps;
}

// The posts of a forum thread page: who wrote each, its text, and the worlds
// attached to it.
function parsePosts(html) {
  return html.split(/<div id="p\d+" class="post /).slice(1).map((post) => ({
    posted: /<time datetime="([^"]+)"/.exec(post)?.[1] || '',
    authorId: /memberlist\.php\?mode=viewprofile&amp;u=(\d+)[^"]*" class="username/.exec(post)?.[1] || '',
    text: stripTags(/<div class="content">([\s\S]*?)<\/div>\s*(?:<dl class="attachbox"|<div id="sig|<div class="notice"|<\/div>)/i
      .exec(post)?.[1] || ''),
    attachments: [...post.matchAll(/href="\.\/download\/file\.php\?id=(\d+)[^"]*">([^<]+)<\/a>/g)]
      .map((m) => ({ name: decodeEntities(m[2]).trim(), url: `${FORUM_BASE}download/file.php?id=${m[1]}` }))
      .filter((a) => WORLD_FILE.test(a.name) || ARCHIVE.test(a.name)),
  })).map((post) => {
    for (const attachment of post.attachments) attachment.posted = post.posted;
    return post;
  });
}

// When the forums' map licence terms were posted: a map posted after it may be
// hosted and changed by anyone, as public domain where it names no licence.
const FORUM_TERMS = `${FORUM_BASE}viewtopic.php?t=10575`;
const FORUM_TERMS_FROM = '2007-04-11T18:37:23Z';
const utc = (stamp) => (stamp ? new Date(stamp).toISOString().replace(/\.000Z$/, 'Z') : '');

// A forum post as a map's description: its first lines, no addresses.
function postDescription(text) {
  return text.replace(/\S+@\S+\.\S+/g, '').split('\n').map((line) => line.trim())
    .filter((line) => line && !/^(quote|code|select all)$/i.test(line)).slice(0, 8);
}

const FORUM_PAGES = 10;

// The worlds a forum thread gives, pushed onto `files`: `map` is its title,
// author (name and forum id), topic number and the day it was published.
async function threadFiles(map, files) {
  const thread = `${FORUM_BASE}viewtopic.php?t=${map.topic}`;
  const ticket = {
    title: map.title, creator: map.author, created: map.published, url: thread, description: '',
  };
  const posts = [];
  for (let page = 0; page < FORUM_PAGES; page += 1) {
    const html = await fetchCached(page ? `${thread}&start=${page * 25}` : thread);
    if (!html) break;
    const found = parsePosts(html);
    posts.push(...found);
    if (found.length < 25 || !html.includes(`start=${(page + 1) * 25}`)) break;
  }
  // The author's last world in the thread is the map as it was left; a
  // thread whose author posted none gives its first post's.
  const own = posts.filter((post) => map.authorId && post.authorId === map.authorId);
  const attachment = own.flatMap((post) => post.attachments).at(-1) || posts[0]?.attachments.at(-1);
  const starter = own[0] || posts[0];
  ticket.description = starter ? postDescription(starter.text).join('\n') : '';
  if (!attachment) {
    files.push({ source: 'forum', name: map.title, url: thread, ticket, body: null });
    return;
  }
  ticket.posted = utc(attachment.posted);
  const body = await fetchCached(attachment.url, { binary: true });
  const worlds = body && ARCHIVE.test(attachment.name) ? unpack(attachment.name, body)
    : [{ name: attachment.name, body }];
  if (body && worlds.length === 0) {
    files.push({ source: 'forum', name: attachment.name, url: attachment.url, ticket, body: null, empty: true });
  }
  for (const world of worlds) {
    files.push({
      source: 'forum',
      name: world.name.replace(/\.map$/i, '.bzw'),
      url: worlds.length === 1 && world.name === attachment.name
        ? attachment.url : `${attachment.url}#${encodeURIComponent(world.name)}`,
      ticket,
      inPack: worlds.length > 1,
      body: world.body,
    });
  }
}

// The Map releases forum's own topics, page by page: each one's number,
// title, starter and the day it was started. Announcements from other forums
// that every forum lists are left out.
const MAP_FORUM = `${FORUM_BASE}viewforum.php?f=64`;
const FORUM_TOPICS_PER_PAGE = 25;

function parseTopicRows(html) {
  return html.split(/<li class="row /).slice(1)
    .filter((row) => !/^[^"]*\b(global-announce|announce)\b/.test(row))
    .map((row) => {
      const poster = /class="topic-poster[^"]*"[\s\S]*?memberlist\.php\?mode=viewprofile&amp;u=(\d+)[^"]*"[^>]*>([^<]*)<\/a>[\s\S]*?<time datetime="(\d{4}-\d{2}-\d{2})/
        .exec(row);
      return {
        topic: /viewtopic\.php\?t=(\d+)[^"]*" class="topictitle/.exec(row)?.[1],
        title: stripTags(/class="topictitle">([^<]*)</.exec(row)?.[1] || ''),
        authorId: poster?.[1] || '',
        author: decodeEntities(poster?.[2] || '').trim(),
        published: poster?.[3] || '',
      };
    })
    .filter((row) => row.topic);
}

async function forumFiles() {
  const index = parseMapIndex(await fetchCached(MAP_INDEX));
  const files = [];
  const seen = new Set();
  for (const map of index) {
    if (!map.topic) {
      files.push({ source: 'forum', name: map.title, url: MAP_INDEX, ticket: { url: MAP_INDEX }, body: null });
      continue;
    }
    seen.add(map.topic);
    await threadFiles(map, files);
  }
  // Then every topic in the forum the index has not named, which is most of
  // the maps posted since it was kept.
  for (let start = 0; ; start += FORUM_TOPICS_PER_PAGE) {
    const html = await fetchCached(`${MAP_FORUM}&start=${start}`);
    const rows = html ? parseTopicRows(html) : [];
    const fresh = rows.filter((row) => !seen.has(row.topic));
    for (const row of fresh) {
      seen.add(row.topic);
      await threadFiles(row, files);
    }
    if (rows.length === 0 || !html.includes(`start=${start + FORUM_TOPICS_PER_PAGE}`)) break;
  }
  return files;
}

// --- What a file says about itself ---------------------------------------------

// The comment lines at the top of a file, before its first object.
function headerComments(text) {
  const lines = [];
  for (const line of text.split('\n').slice(0, 60)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('#')) break;
    // `#!name` is bzedit's name for the object below it, not a comment.
    if (trimmed.startsWith('#!')) continue;
    const body = trimmed.replace(/^#+\s*/, '').trim();
    if (body && !/^[-=#*~_ ]+$/.test(body)) lines.push(body);
  }
  return lines;
}

// Lines naming a tool, not a person.
const TOOL_LINE = /generat|bzworld|bzedit|modeler|blender|wings|editor|exporter|converted|bzflag world file|available at/i;

function cleanName(raw) {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/\([^)]*@[^)]*\)/g, '')
    .replace(/\S+@\S+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\b(on|in)?\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?\b.*$/i, '')
    .replace(/\b\d{1,2}\/\d{4}\b.*$/, '')
    .replace(/,\s*(?:(?:19|20)\d\d|version|v\d).*$/i, '')
    .replace(/[\s,.;:!]+$/, '')
    .replace(/^[\s:,-]+/, '')
    .replace(/^"([^"]*)"$/, '$1')
    .trim();
}

// `Label : value` header lines, as some 2002 maps lay out a header, by
// lower-cased label.
function labelled(lines) {
  const fields = new Map();
  for (const line of lines) {
    const m = /^([a-z][a-z ]{1,20}?)\s*:\s*(\S.*)$/i.exec(line);
    if (m && !/^https?$/i.test(m[1])) fields.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  return fields;
}

function authorFrom(lines) {
  const fields = labelled(lines);
  for (const label of ['author', 'authors', 'designer', 'creator', 'made by', 'created by', 'map by']) {
    const name = fields.has(label) ? cleanName(fields.get(label)) : '';
    if (name) return name;
  }
  for (const line of lines) {
    if (TOOL_LINE.test(line)) continue;
    const match = /^(?:author|creator|made by|created by|map by|designed by|built by|written by|by)\s*[:-]?\s*(.+)$/i.exec(line)
      || /\b(?:created|made|designed|built|written)\s+by\s*[:-]?\s*(.+)$/i.exec(line)
      || /^.{1,40}?\bby\s+(.+)$/i.exec(line);
    if (!match) continue;
    const name = cleanName(match[1]);
    if (name && name.length <= 40 && /[a-z]/i.test(name)) return name;
  }
  return '';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
const fullYear = (y) => (y < 100 ? (y > 50 ? 1900 + y : 2000 + y) : y);
const plausible = (y) => y >= 1993 && y <= 2030;

// A date the header gives, as `YYYY-MM-DD`, `YYYY-MM` or `YYYY`.
// The date one line gives, as `YYYY-MM-DD`, `YYYY-MM` or `YYYY`; US order
// for a slashed date.
function dateIn(line) {
  let m = /\b((?:19|20)\d\d)-(\d\d)-(\d\d)\b/.exec(line);
  if (m && plausible(+m[1])) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(line);
  if (m && +m[1] <= 12 && +m[2] <= 31 && plausible(fullYear(+m[3]))) {
    return `${fullYear(+m[3])}-${pad(m[1])}-${pad(m[2])}`;
  }
  m = /\b(\d{1,2})\/((?:19|20)\d\d)\b/.exec(line);
  if (m && +m[1] <= 12 && plausible(+m[2])) return `${m[2]}-${pad(m[1])}`;
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?((?:19|20)\d\d)\b/i.exec(line);
  if (m && plausible(+m[2])) return `${m[2]}-${pad(MONTHS.indexOf(m[1].toLowerCase()) + 1)}`;
  return '';
}

// A date the header gives: a labelled release date first, else any line's.
function dateFrom(lines) {
  const fields = labelled(lines);
  for (const label of ['release date', 'date', 'created']) {
    const date = fields.has(label) ? dateIn(fields.get(label)) : '';
    if (date) return date;
  }
  for (const line of lines) {
    const date = dateIn(line);
    if (date) return date;
  }
  // A bare year on the line naming the author or a copyright.
  for (const line of lines) {
    const m = /\b(?:by|copyright|\(c\)|©)\b.*\b((?:19|20)\d\d)\b/i.exec(line);
    if (m && plausible(+m[1])) return m[1];
  }
  return '';
}

function titleFrom(lines, name) {
  const fields = labelled(lines);
  for (const label of ['map name', 'title', 'name', 'world name']) {
    if (fields.has(label)) return cleanName(fields.get(label));
  }
  const first = lines[0] || '';
  if (first && first.length <= 40 && !TOOL_LINE.test(first) && !/\bby\b|author|created|made/i.test(first)
    && /[a-z]/i.test(first)) {
    return cleanName(first);
  }
  return name.replace(/\.bzw$/i, '').replace(/[_]+/g, ' ').trim();
}

// --- Normalising a file ----------------------------------------------------

function decode(body) {
  const text = body.toString('utf8');
  // Not UTF-8: read as Latin-1, which every byte is.
  return text.includes('�') ? body.toString('latin1') : text;
}

const RAD_LIMIT = 2 * Math.PI + 0.01;

// Rotations in radians -- world files before BZFlag 1.7e4 (2001-11-27) -- as
// degrees. Radians when every non-zero rotation is within 2π and one has a
// fractional part, which a map in degrees never shows on all of them.
function convertRadians(text) {
  const pattern = /^(\s*rot(?:ation)?\s+)(-?\d*\.?\d+)/gim;
  const values = [...text.matchAll(pattern)].map((m) => Number(m[2])).filter((v) => v !== 0);
  if (values.length === 0 || !values.every((v) => Math.abs(v) <= RAD_LIMIT)
    || !values.some((v) => !Number.isInteger(v))) {
    return null;
  }
  return text.replace(pattern, (match, lead, value) => {
    const degrees = Math.round(Number(value) * 180 / Math.PI * 1000) / 1000;
    return `${lead}${degrees}`;
  });
}

function normalise(body) {
  let text = decode(body).replace(/\r\n?/g, '\n').replaceAll(String.fromCharCode(0x1a), '');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

// What a map is, for telling copies apart: its text without a metadata block.
const contentKey = (text) => crypto.createHash('md5')
  .update(splitBzwMetadata(text).text.replace(/\s+/g, ' ').trim()).digest('hex');

function objectCount(text, name) {
  try {
    return parseBZWMap(name, { quiet: true, text }).obstacles.length;
  } catch {
    return 0;
  }
}

function metadataBlock(fields) {
  const lines = ['metadata'];
  for (const [key, values] of fields) {
    for (const value of [].concat(values)) {
      if (value) lines.push(`  ${key} ${String(value).replace(/\s+/g, ' ').trim()}`);
    }
  }
  lines.push('endmetadata', '');
  return `${lines.join('\n')}\n`;
}

// --- The run -----------------------------------------------------------------

function existingMaps() {
  const byKey = new Map();
  const names = new Set();
  for (const dir of [OUT, path.join(ROOT, 'maps')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.bzw') || name.startsWith('import-')) continue;
      names.add(name.toLowerCase());
      const text = normalise(fs.readFileSync(path.join(dir, name)));
      byKey.set(contentKey(text), { name, dir, text });
      const converted = convertRadians(splitBzwMetadata(text).text);
      if (converted) byKey.set(contentKey(converted), { name, dir, text });
    }
  }
  return { byKey, names };
}

// A name or title with version numbers and punctuation set aside.
const plainName = (text) => String(text || '').toLowerCase()
  .replace(/\.(bzw|map)$/, '')
  .replace(/\bv(er(sion)?)?\s*\d+(\.\d+)*[a-z]?\b/g, '')
  .replace(/\d+\.\d+[a-z]?/g, '')
  .replace(/[^a-z0-9]/g, '');

// Which candidates are versions of one map, as a group number each: the same
// author and the same file name or title, versions aside. A copy naming no
// author joins the one author who has a map of that name, if only one does.
function groupVersions(candidates) {
  const parent = candidates.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  // A name too short or common to say which map it is matches nothing.
  const GENERIC = /^(ctf|ffa|map|maps|test|world|newworld|untitled|mymap|myworld|firstmap|bzflag|bzflagmap)\d*$/;
  const names = (c) => [plainName(c.file.name), plainName(c.row.title)]
    .filter((name) => name.length >= 4 && !GENERIC.test(name));
  const byKey = new Map();
  const byName = new Map();
  candidates.forEach((c, i) => {
    const author = plainName(c.row.author);
    for (const name of names(c)) {
      if (author) {
        const key = `${author}|${name}`;
        if (byKey.has(key)) union(i, byKey.get(key));
        else byKey.set(key, i);
      }
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(i);
    }
  });
  candidates.forEach((c, i) => {
    if (plainName(c.row.author)) return;
    for (const name of names(c)) {
      const authored = byName.get(name).filter((j) => plainName(candidates[j].row.author));
      const authors = new Set(authored.map((j) => plainName(candidates[j].row.author)));
      if (authors.size === 1) union(i, authored[0]);
    }
  });
  return candidates.map((_, i) => find(i));
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const files = [
    ...(SOURCE === 'all' || SOURCE === 'bzx' ? await bzexcessFiles() : []),
    ...(SOURCE === 'all' || SOURCE === 'sf' ? await sourceforgeFiles() : []),
    ...(SOURCE === 'all' || SOURCE === 'forum' ? await forumFiles() : []),
  ];
  const { byKey, names } = existingMaps();
  const report = [];
  // Every file read and described first, so that of several versions of one
  // map -- an author posting it again, or in a pack -- only the newest is
  // taken.
  const candidates = [];
  for (const file of files) {
    const row = { source: file.source, name: file.name, url: file.url };
    report.push(row);
    if (!file.body) {
      row.result = file.empty ? 'no world in archive' : 'missing';
      continue;
    }
    let text = normalise(file.body);
    if (/<html|<!doctype/i.test(text.slice(0, 500))) {
      row.result = 'not a map (HTML)';
      continue;
    }
    const lines = headerComments(text);
    const notes = [];
    const converted = convertRadians(text);
    if (converted) {
      text = converted;
      notes.push('rotation converted from radians to degrees');
    }
    if (objectCount(text, file.name) === 0) {
      row.result = 'not a map (no objects)';
      continue;
    }
    const ticket = file.ticket;
    if (ticket?.posted && ticket.posted >= FORUM_TERMS_FROM) {
      notes.push(`posted under the forums' map terms, ${FORUM_TERMS}`);
    }
    const fields = [
      ['title', (!file.inPack && ticket?.title) || titleFrom(lines, file.name)],
      // The wiki's index names a forum map's author by hand.
      ['author', (file.source === 'forum' && ticket.creator) || authorFrom(lines) || ticket?.creator || ''],
      ['version', labelled(lines).get('version') || ''],
      ['created', dateFrom(lines) || ticket?.created || ''],
      ['archived', file.source === 'bzx' ? BZX_ARCHIVED : ''],
      ['posted', ticket?.posted || ''],
      ['sourceurl', ticket?.url || file.url],
      // The file itself, where the source is a page about it; `#member` for
      // one taken out of an archive.
      ['downloadurl', ticket ? file.url : ''],
      ['description', ticket?.description ? ticket.description.split('\n').filter(Boolean) : []],
      ['note', notes],
    ];
    Object.assign(row, Object.fromEntries(fields.map(([k, v]) => [k, Array.isArray(v) ? v.join(' / ') : v])));
    candidates.push({ file, row, text, fields });
  }
  groupVersions(candidates).forEach((group, i) => { candidates[i].identity = group; });

  const newest = new Map();
  for (const candidate of candidates) {
    const best = newest.get(candidate.identity);
    if (!best || (candidate.row.created || '') >= (best.row.created || '')) newest.set(candidate.identity, candidate);
  }

  for (const { file, row, text, fields, identity } of candidates) {
    const winner = newest.get(identity);
    if (winner.row !== row) {
      row.result = `older version of ${winner.file.name}`;
      continue;
    }
    const key = contentKey(text);
    const twin = byKey.get(key);
    if (twin) {
      // The same map already here, with or without a block of its own.
      const known = splitBzwMetadata(twin.text).metadata;
      if (known && file.source === 'forum' && twin.dir === OUT && twin.text.startsWith('metadata\n')
        && !fs.readFileSync(path.join(twin.dir, twin.name)).includes('\r')) {
        // An archived copy of a map its thread says more about: the thread
        // and the fields the block lacks.
        const merged = new Map(Object.entries(known));
        const added = [];
        for (const [key, values] of fields) {
          const have = merged.get(key) || [];
          const multi = key === 'sourceurl' || key === 'downloadurl' || key === 'note';
          const fresh = [].concat(values).filter((value) => value && !have.includes(value));
          if (fresh.length && (multi || have.length === 0)) {
            merged.set(key, [...have, ...fresh]);
            added.push(key);
          }
        }
        if (added.length === 0) {
          row.result = `same as ${twin.name}`;
          continue;
        }
        row.result = `metadata merged into ${twin.name}`;
        row.file = twin.name;
        row.added = added.join(' ');
        twin.text = metadataBlock(merged) + twin.text.replace(/^metadata\n[\s\S]*?\nendmetadata\n\n?/, '');
        if (!DRY_RUN) fs.writeFileSync(path.join(twin.dir, twin.name), twin.text);
        continue;
      }
      if (known || twin.taken) {
        row.result = `same as ${twin.name}`;
        continue;
      }
      row.result = `metadata added to ${twin.name}`;
      row.file = twin.name;
      twin.taken = true;
      if (!DRY_RUN) fs.writeFileSync(path.join(twin.dir, twin.name), metadataBlock(fields) + text);
      continue;
    }
    // The name it came with, and a prefix only where another map has it.
    let name = file.name.replace(/[/\\]/g, '_');
    if (!/\.bzw$/i.test(name)) name += '.bzw';
    if (names.has(name.toLowerCase())) name = `${file.source}-${name}`;
    for (let n = 2; names.has(name.toLowerCase()); n += 1) name = name.replace(/(-\d+)?\.bzw$/i, `-${n}.bzw`);
    names.add(name.toLowerCase());
    byKey.set(key, { name, dir: OUT, text, taken: true });
    row.result = 'taken';
    row.file = name;
    if (!DRY_RUN) fs.writeFileSync(path.join(OUT, name), metadataBlock(fields) + text);
  }
  fs.writeFileSync(path.join(CACHE, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  const tally = {};
  for (const row of report) {
    const result = row.result.replace(/ .*/, '');
    tally[result] = (tally[result] || 0) + 1;
  }
  console.log(`${DRY_RUN ? 'Dry run: ' : ''}${report.length} file(s):`, tally);
  console.log(`Report: ${path.join(CACHE, 'report.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
