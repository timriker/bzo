/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// precompress.cjs - Brotli sidecars for the static assets, built once and
// served in place of the identity file to a client that asks for `br`.
//
// Express serves everything uncompressed, and the text among the assets is most
// of a cold join: models, code and markup are 3.2MB of the 9.9MB a browser with
// an empty cache pulls down, and brotli takes those to 540KB. The models are the
// bulk of it -- an OBJ is ASCII numbers and compresses about ten to one -- and
// nothing else compresses them today, because express announces `.obj` as
// `application/x-tgif` and a reverse proxy's type list never matches it.
//
// Quality 11, which is three seconds for a megabyte and out of the question per
// request: the game loop shares this process, so the compression is done once,
// off the event loop through zlib's thread pool, and kept on disk.
//
// A sidecar is named for the digest of the source it was made from --
// `cache/br/obj/bzflag.obj.<digest>.br` -- so one that exists is by construction
// the current file's, and one left by an earlier version of the source is a name
// nothing looks up. Neither an mtime nor a manifest is trusted for that, and the
// digests are free: the walk that computes the client build id already reads
// every byte. The same pass queues what is missing and deletes what nothing
// names, which is what keeps the directory from growing across edits.
//
// A missing sidecar is not an error. Until the queue drains -- and forever, if
// the cache directory cannot be written, as in a container running read-only --
// requests fall through to express's own static handler and the identity file.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// Text worth compressing. Textures, icons and audio are left out: PNG gains
// 15KB across 3.1MB, and the WAVs want a different container rather than a
// compressor, so spending twenty seconds of q11 on them buys little.
const COMPRESSIBLE = /\.(?:css|html|js|mjs|json|obj|mtl|svg)$/;

// `/manifest.webmanifest` and `/icons/` are deliberately absent. Both are
// small, and the install log wants to see those requests reach it rather than
// being answered by a sidecar first.
const EXCLUDED = /^\/(?:icons\/|manifest\.webmanifest$)/;

// three ships eleven builds and the game fetches two. Naming them keeps the
// pass from spending half a minute on the nine nobody asks for; anything else
// under the vendor mount is served identity, which is what it gets today.
const VENDOR_SERVED = new Set([
  '/vendor/three/three.module.js',
  '/vendor/three/three.core.js',
]);

// Long enough that two versions of one file never collide, and the same width
// as the client build id for the same reason.
const DIGEST_LENGTH = 12;

// zlib's async compression runs on libuv's thread pool, which is four threads
// wide by default and also serves every fs call in the process. Two at a time
// keeps the pass off the game's path to disk.
const CONCURRENCY = 2;

const state = {
  cacheDir: '',
  // URL path -> { source, digest, sidecar, ready }
  planned: new Map(),
  queue: [],
  // Every sidecar path this plan accounts for, which is what the sweep keeps.
  expected: new Set(),
  disabled: false,
};

// Every file under a root, directories in name order and depth first. Shared
// with the client build id's walk in `server.js`, so the plan and the id are
// made from exactly the same files in exactly the same order -- and so the pass
// this module runs on its own sees the tree the server would have seen.
function walkFiles(root, onFile) {
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) onFile(full, path.relative(root, full));
    }
  };
  if (fs.existsSync(root)) walk(root);
}

function eligible(urlPath) {
  if (EXCLUDED.test(urlPath)) return false;
  if (urlPath.startsWith('/vendor/')) return VENDOR_SERVED.has(urlPath);
  return COMPRESSIBLE.test(urlPath);
}

// Called for every file the build id walk reads, with the bytes it already has.
function consider(urlPath, source, bytes) {
  if (!eligible(urlPath)) return;
  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, DIGEST_LENGTH);
  const sidecar = path.join(state.cacheDir, `${urlPath.slice(1)}.${digest}.br`);
  state.expected.add(sidecar);
  const entry = { source, digest, sidecar, size: bytes.length, ready: false };
  state.planned.set(urlPath, entry);
  // A sidecar under this name was made from these bytes, so its presence is the
  // whole check. An empty one is a write that did not finish and is redone.
  let ready = false;
  try {
    ready = fs.statSync(sidecar).size > 0;
  } catch {
    ready = false;
  }
  if (ready) entry.ready = true;
  else state.queue.push(entry);
}

function configure({ cacheDir }) {
  state.cacheDir = cacheDir;
  state.planned = new Map();
  state.queue = [];
  state.expected = new Set();
  state.disabled = false;
}

// Anything under the cache directory this plan does not name: a sidecar for a
// file that has since changed, or for one that is gone.
function sweep() {
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removed += walk(full);
        // Only an empty one goes, so a directory still holding sidecars stays.
        try {
          fs.rmdirSync(full);
        } catch {
          // Not empty, which is the common case.
        }
      } else if (!state.expected.has(full)) {
        try {
          fs.unlinkSync(full);
          removed += 1;
        } catch {
          // Left behind rather than failing the sweep.
        }
      }
    }
    return removed;
  };
  return walk(state.cacheDir);
}

function compressOne(entry) {
  return new Promise((resolve) => {
    let bytes;
    try {
      bytes = fs.readFileSync(entry.source);
    } catch {
      resolve(0);
      return;
    }
    zlib.brotliCompress(bytes, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }, (error, out) => {
      // A sidecar no smaller than its source would cost a client the decode for
      // nothing, so none is written and the identity file stays the only answer.
      if (error || out.length >= bytes.length) {
        resolve(0);
        return;
      }
      // Written under another name and renamed, so a sidecar is either absent
      // or complete: the plan reads presence as proof, and a half-written file
      // would be served as a truncated response.
      const temporary = `${entry.sidecar}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(entry.sidecar), { recursive: true });
        fs.writeFileSync(temporary, out);
        fs.renameSync(temporary, entry.sidecar);
      } catch {
        try {
          fs.unlinkSync(temporary);
        } catch {
          // Nothing to clean up.
        }
        resolve(0);
        return;
      }
      entry.ready = true;
      resolve(out.length);
    });
  });
}

// Sweeps, then works the queue. Resolves when the last sidecar is written, so a
// build step can await it; a server calls it after `listen` and ignores it.
async function start({ log = () => {} } = {}) {
  try {
    fs.mkdirSync(state.cacheDir, { recursive: true });
  } catch (error) {
    // Serving identity is a correct answer, so a cache that cannot be written
    // is said once and then left alone.
    state.disabled = true;
    log(`[BR] no sidecars: ${state.cacheDir} is not writable (${error.message})`);
    return { compressed: 0, raw: 0, br: 0, removed: 0, ms: 0 };
  }
  const removed = sweep();
  const ready = [...state.planned.values()].filter((entry) => entry.ready).length;
  if (state.queue.length === 0) {
    log(`[BR] ${ready} sidecars ready, ${removed} stale removed`);
    return { compressed: 0, raw: 0, br: 0, removed, ms: 0 };
  }
  const started = Date.now();
  const pending = state.queue.slice();
  state.queue = [];
  let raw = 0;
  let br = 0;
  let compressed = 0;
  const worker = async () => {
    for (let entry = pending.shift(); entry; entry = pending.shift()) {
      const size = await compressOne(entry);
      if (size > 0) {
        compressed += 1;
        raw += entry.size;
        br += size;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const ms = Date.now() - started;
  log(`[BR] ${compressed} sidecars built, ${Math.round(raw / 1024)}KB -> `
    + `${Math.round(br / 1024)}KB in ${(ms / 1000).toFixed(1)}s`
    + `, ${ready} already present, ${removed} stale removed`);
  return { compressed, raw, br, removed, ms };
}

// Whether a failed send says the sidecar itself is gone, rather than that the
// client hung up part way through it. Only the first retires the sidecar: a
// player who closes the tab mid-download, or a probe whose pipe breaks, would
// otherwise take the compressed copy out of service for every later request and
// leave the server quietly serving identity until the next restart.
function isMissingFile(error) {
  return error !== null && typeof error === 'object'
    && ['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(error.code);
}

// `br` in an Accept-Encoding, honouring a `q=0` that refuses it and the `*` that
// asks for anything.
function acceptsBrotli(header) {
  if (!header) return false;
  let wildcard = false;
  for (const part of String(header).split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters
      .map((parameter) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(parameter))
      .find(Boolean);
    const wanted = quality ? Number(quality[1]) > 0 : true;
    if (name.toLowerCase() === 'br') return wanted;
    if (name === '*' && wanted) wildcard = true;
  }
  return wildcard;
}

// Mounted ahead of the static handlers. `cacheControl` is the same function
// those use, called with the source path, so a compressed response and an
// identity one make the same promise about freshness.
function middleware({ cacheControl = () => {} } = {}) {
  return function serveBrotliSidecar(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (state.disabled) return next();
    const entry = state.planned.get(req.path);
    if (!entry || !entry.ready) return next();
    if (!acceptsBrotli(req.headers['accept-encoding'])) return next();

    // The type of the source, not of the `.br` file, and named the way express
    // names it so the two representations do not disagree.
    res.type(path.basename(entry.source));
    res.setHeader('Content-Encoding', 'br');
    // Without this a shared cache could hand the compressed body to a client
    // that never asked for it.
    res.setHeader('Vary', 'Accept-Encoding');
    cacheControl(res, entry.source);
    // The source's digest rather than the sidecar's mtime, so the tag survives
    // a rebuild that changes nothing and matches across machines.
    res.setHeader('ETag', `"${entry.digest}-br"`);
    // A range would be a range of compressed bytes, which nothing here asks
    // for and no client should be invited to try.
    return res.sendFile(entry.sidecar, { acceptRanges: false, cacheControl: false }, (error) => {
      if (!error) return undefined;
      // Gone from under us: stop offering it, and let the static handler serve
      // the file itself, which is still on disk. Anything else -- a client that
      // hung up -- leaves the sidecar in service.
      if (isMissingFile(error)) entry.ready = false;
      if (res.headersSent) return res.destroy();
      res.removeHeader('Content-Encoding');
      res.removeHeader('ETag');
      return next();
    });
  };
}

// The two trees the game serves, named the way a request names them.
function assetRoots() {
  return [
    { root: path.join(__dirname, '..', 'public'), urlPrefix: '/' },
    { root: path.dirname(require.resolve('three')), urlPrefix: '/vendor/three/' },
  ];
}

// Plans and builds without a server, which is how an image ships with the
// sidecars already in it: the container then needs nothing writable at runtime
// and the first player pays nothing for the compression. The server does the
// same work at boot for anything missing, so this only ever saves time.
async function buildAll({ cacheDir = path.join(__dirname, '..', 'cache', 'br'), log } = {}) {
  configure({ cacheDir });
  for (const { root, urlPrefix } of assetRoots()) {
    walkFiles(root, (full, relative) => {
      const urlPath = `${urlPrefix}${relative.split(path.sep).join('/')}`;
      if (!eligible(urlPath)) return;
      consider(urlPath, full, fs.readFileSync(full));
    });
  }
  return start({ log });
}

module.exports = {
  COMPRESSIBLE,
  VENDOR_SERVED,
  acceptsBrotli,
  assetRoots,
  buildAll,
  configure,
  consider,
  eligible,
  isMissingFile,
  middleware,
  start,
  walkFiles,
  // For the tests.
  _state: state,
};

// `node server/precompress.cjs`, which is what the image build runs.
if (require.main === module) {
  buildAll({ log: (line) => console.log(line) }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
