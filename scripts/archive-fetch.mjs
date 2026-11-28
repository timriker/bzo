/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Fetching from the map archives for the scripts that read them
// (import-map-archive.mjs, recover-map-textures.mjs): every body cached on
// disk by its URL, one request a second, and the BZFlag forums' bot check
// passed in a headless Chrome.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FORUM_BASE = 'https://forums.bzflag.org/';
const FORUM_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const ANUBIS_PAGE = 'Making sure you&#39;re not a bot';

export const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

// `fetchCached(url, { binary })`, keeping bodies under `cache`.
export function createArchiveFetch({ cache, userAgent }) {
  let forumPass = null;

  // A URL's body, from the cache when it is there. Null for a 404.
  async function fetchCached(url, { binary = false } = {}) {
    const file = path.join(cache, 'fetch', crypto.createHash('sha1').update(url).digest('hex'));
    if (fs.existsSync(file)) {
      const body = fs.readFileSync(file);
      return body.length === 0 ? null : (binary ? body : body.toString('utf8'));
    }
    // One request a second: the archives are volunteers' servers.
    await sleep(1000);
    const forum = url.startsWith(FORUM_BASE);
    const response = await fetch(url, { headers: forum ? await forumHeaders() : { 'User-Agent': userAgent } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (response.status === 404) {
      fs.writeFileSync(file, '');
      return null;
    }
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (forum && body.includes(ANUBIS_PAGE)) {
      // The pass ran out mid-run: a new one, and the page again.
      forumPass = null;
      return fetchCached(url, { binary });
    }
    fs.writeFileSync(file, body);
    return binary ? body : body.toString('utf8');
  }

  // The BZFlag forums sit behind Anubis, a proof of work only a browser runs:
  // a headless Chrome passes it once, and its cookies, sent with the same
  // user agent, carry the plain fetches after it.
  async function forumHeaders() {
    forumPass ||= passAnubis(cache);
    return { 'User-Agent': FORUM_AGENT, Cookie: await forumPass };
  }

  return { fetchCached };
}

async function passAnubis(cache) {
  const { default: WebSocket } = await import('ws');
  const { spawn } = await import('node:child_process');
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(cache, 'chrome-'));
  const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, `--user-agent=${FORUM_AGENT}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' });
  try {
    let pages = null;
    for (let attempt = 0; !pages && attempt < 60; attempt += 1) {
      pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
      if (!pages) await sleep(250);
    }
    if (!pages) throw new Error('headless chrome never opened its debugging port');
    const socket = new WebSocket(pages.find((entry) => entry.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve) => { socket.on('open', resolve); });
    let nextId = 0;
    const waiting = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      waiting.get(message.id)?.(message.result);
      waiting.delete(message.id);
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      nextId += 1;
      waiting.set(nextId, resolve);
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
    await send('Page.navigate', { url: FORUM_BASE });
    for (let second = 0; second < 90; second += 1) {
      await sleep(1000);
      const cookies = (await send('Network.getAllCookies')).cookies
        .filter((cookie) => cookie.domain.endsWith('bzflag.org'));
      if (cookies.some((cookie) => /anubis-auth/.test(cookie.name))) {
        socket.close();
        return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
      }
    }
    throw new Error('headless chrome did not pass the forums\' bot check');
  } finally {
    chrome.kill('SIGKILL');
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
