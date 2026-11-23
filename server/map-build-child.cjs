/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A map parsed, built or compiled in a process of its own (server/map-build.cjs
// starts it). A big map takes hundreds of MB to read, and a process keeps the
// memory it grew into, a worker thread's included; this one exits with the
// map done and gives all of it back. The job comes in on stdin and the result
// goes out on stdout, both v8-serialized; stderr is the log, a line apiece.

'use strict';

const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const crypto = require('crypto');
const { configureBzwParse, parseBZWMap, buildWorldFile } = require('./bzw-parse.cjs');
const { compileBzwWorld } = require('./bzw-compile.cjs');
const { packWorldDatabase, bzfsWorldHashOfBzw } = require('./bzflag-world.cjs');
const { digestOf } = require('./precompress.cjs');
const { IMG_URL_PREFIX } = require('./local-images.cjs');

const log = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);

// The map's text, as bzfs would read it.
const textOf = (job) => (job.text != null ? job.text : fs.readFileSync(job.filePath, 'latin1'));

function writeJson(dir, world, json) {
  const bytes = Buffer.from(json);
  fs.writeFileSync(path.join(dir, `${world.hash}.json`), bytes);
  return { digest: digestOf(bytes), size: bytes.length };
}

// A packed world written as `<md5>.bwc`, the name it is fetched by.
function writeBwc(dir, blob) {
  const md5 = crypto.createHash('md5').update(blob).digest('hex');
  fs.writeFileSync(path.join(dir, `${md5}.bwc`), blob);
  return { md5, size: blob.length };
}

// The map file's own BZFlag world, as bzfs loads it: what a recording names
// its map by and carries. Null for a map the compiler cannot reproduce.
function plainWorld(text, dir) {
  try {
    const tree = compileBzwWorld(text);
    if (tree.unsupported.length > 0) return null;
    return writeBwc(dir, packWorldDatabase(tree));
  } catch {
    return null;
  }
}

// Any map, built into its world file for bzo's clients (`convertMapFile`).
function convert(job) {
  const map = parseBZWMap(job.filePath, { quiet: job.quiet });
  const { json, ...world } = buildWorldFile(map, job.build);
  const written = job.writeDir ? writeJson(job.writeDir, world, json) : null;
  return {
    ...world,
    // For naming the map a recording was played on.
    bzfsHash: bzfsWorldHashOfBzw(textOf(job)),
    written,
    instancing: map.instancing || null,
    warnedMessages: map.warnedMessages,
  };
}

// The live map: its world file and plain BZFlag world written, and what the
// game plays on sent back. Render-only geometry stays here: it is in the file.
function live(job) {
  const map = job.text != null ? parseBZWMap('random', { text: job.text }) : parseBZWMap(job.filePath);
  const { json, ...world } = buildWorldFile({
    obstacles: map.obstacles,
    teleporterGraph: map.teleporterGraph,
    teamMode: map.teamMode,
    mapSize: Number.isFinite(map.mapSize) ? map.mapSize : job.mapSize,
    messages: map.messages,
    noWalls: map.noWalls,
    waterLevel: map.waterLevel || null,
    weather: map.weather || null,
    groundMaterial: map.groundMaterial || null,
    metadata: map.metadata,
    physicsDrivers: map.physicsDrivers || [],
    serverOptions: map.serverOptions,
    meshTemplates: map.meshTemplates || {},
    meshInstances: map.meshInstances || [],
    zones: map.zones,
  }, job.build);
  const written = writeJson(job.writeDir, world, json);
  const plain = job.text != null ? null : plainWorld(textOf(job), job.plainDir);
  for (const obstacle of map.obstacles) delete obstacle.drawArrays;
  delete map.meshTemplates;
  delete map.meshInstances;
  return {
    map,
    world: { ...world, written, bzfsHash: plain ? `p${plain.md5}` : null },
    plain,
  };
}

// The world a BZFlag client is sent. `/img/` textures name `textureHost`, or
// stay bare without one. With `returnTree` the compiled tree comes back for
// a plugin to add to, unpacked. A recording takes the world whatever the
// compiler could not reproduce in it (`evenUnsupported`).
function native(job) {
  const imgNames = new Set();
  const textureName = (name) => {
    if (!String(name).toLowerCase().startsWith(IMG_URL_PREFIX)) return name;
    imgNames.add(name);
    return job.textureHost ? `http://${job.textureHost}${name}` : name;
  };
  const tree = compileBzwWorld(textOf(job), {
    bzdb: job.bzdb, textureName, customObjects: job.customObjects,
  });
  if (tree.unsupported.length > 0 && !job.evenUnsupported) return { unsupported: [...new Set(tree.unsupported)] };
  if (job.returnTree) return { tree, imgTextures: imgNames.size };
  return { ...writeBwc(job.writeDir, packWorldDatabase(tree)), imgTextures: imgNames.size };
}

// Where each obstacle came from in its file (its `source` and `placedBy`,
// docs/editor-plan.md), with the text the spans index into and bzfs's hash of
// it, so the server can tell the file has not changed since its world was
// built (`obstacleSourcesFor`).
function spans(job) {
  const text = fs.readFileSync(job.filePath, 'utf8');
  const map = parseBZWMap(job.filePath, { quiet: true, text });
  // Four numbers a span: its first and last line and its character range.
  const flat = (span) => (span ? [span.startLine, span.endLine, span.start, span.end] : [0, 0, 0, 0]);
  return {
    text,
    bzfsHash: bzfsWorldHashOfBzw(fs.readFileSync(job.filePath, 'latin1')),
    missingTextures: map.unresolvedTextureNames,
    materials: map.materialSources.map((material) => [material.name, ...flat(material.source)]),
    warnings: map.warnedMessages,
    spans: map.obstacles.map((obstacle) => [
      ...flat(obstacle.source),
      ...(obstacle.placedBy || []).flatMap(flat),
    ]),
  };
}

const TASKS = {
  convert, live, native, spans,
};

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const job = v8.deserialize(Buffer.concat(chunks));
  configureBzwParse({ ...job.configure, log });
  let result;
  try {
    result = { ok: TASKS[job.task](job) };
  } catch (error) {
    result = { error: error.stack || String(error) };
  }
  process.stdout.write(v8.serialize(result), () => process.exit(0));
});
