/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// sw.js - Service worker: makes bzo installable and serves its bulky assets
// from disk, without ever letting cached code outlive the server that serves it.
//
// The client/server protocol is lockstep, so code is fetched network-first and
// the cache is only an offline fallback. Textures, audio, models and Three.js
// cannot desync anything, so those are served cache-first out of a cache keyed
// to the build the server is serving: any change to it changes the key and
// refills the cache.
//
// The build id arrives in the worker's own script URL (`/sw.js?v=abdf5ccd7c45`).
// Because the registration URL is part of the worker's identity, a change
// installs a genuinely new worker with no build step and no ES module support
// required in workers.
//
// Keyed to the build rather than to the release version, which only moves when
// a release is cut. An edited texture during development is served cache-first,
// so under a release key it would outlive the reload the build check triggers --
// the client would fetch new code and old art.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `bzo-v${VERSION}`;

// The shell needed to boot the game. Assets discovered later (textures, models,
// audio, addons) join the cache on first use rather than being listed here.
const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/client.js',
  '/xr-launch.js',
  '/webxr.js',
  '/install.js',
  '/vendor/three/three.module.js',
  '/vendor/three/three.core.js',
  '/favicon.svg',
];

// Paths whose contents change only on release, and which cannot cause a
// protocol desync if they lag. `/maps/` is the strongest of them: express
// serves that URL space out of `cache/maps/`, where every file is named for
// its own content hash and answered `immutable`, so a cache hit there is
// exact by construction rather than merely current. Network-first would
// re-fetch a whole world on every build change to be handed back the same
// bytes. Icons are excluded: a launcher keeps whichever one it was shown at
// install time, so a stale icon is the one kind that outlives the cache it
// came from.
const ASSET_PATHS = /^\/(?:textures|obj|audio|vendor|maps)\//;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Drop every other version's cache here as well as in activate. Without
    // skipWaiting a new worker can wait indefinitely behind a page that never
    // closes -- an installed app on a phone may not close for days -- and until
    // it activates those older caches are still reachable.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    // Individually, so one missing asset does not fail the whole install.
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  // Drop every other version's cache, then take over already-open pages.
  // Note there is no skipWaiting: a new worker waits for the next launch rather
  // than swapping the game's code out from under a running match.
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Always this version's cache, never the global `caches.match()`, which searches
// every cache present -- including one left by another version of the worker. A
// leftover generation answering a lookup defeats the whole point of keying the
// cache to the version, and does it silently: the served file is stale but the
// server, the headers and a hand-run fetch all look correct.
async function matchThisVersion(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await matchThisVersion(request);
    if (cached) return cached;
    throw err;
  }
}

// A miss revalidates rather than trusting the HTTP cache. Assets are served
// with a seven day max-age, so a plain fetch on a miss would be answered from
// the HTTP cache without a request reaching the server -- and an edited texture
// would survive the new build, the new worker and the reload, all of which
// exist to get rid of it. Revalidating costs one conditional request per asset
// on a build change, and the unchanged ones answer 304 with no body.
async function cacheFirst(request) {
  const cached = await matchThisVersion(request);
  if (cached) return cached;
  const response = await fetch(request, { cache: 'no-cache' });
  if (response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live server state: never cached, never intercepted.
  if (url.pathname.startsWith('/api/') || url.pathname === '/manifest.webmanifest') return;

  if (ASSET_PATHS.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Navigations, HTML and JavaScript. `no-cache` on these responses means the
  // common case is a cheap 304 revalidation rather than a re-download, so this
  // stays fast while guaranteeing the running code matches the server.
  event.respondWith(networkFirst(request));
});
