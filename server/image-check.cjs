/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// image-check.cjs - Whether each texture URL a map names still answers with
// an image, so the map list can say how many a map is missing. Checked one a
// second in the background, never while a player waits, and kept in
// `image-check.json` beside the server's other state; a URL is checked again
// after a month.
'use strict';

const fs = require('fs');
const path = require('path');

const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const PACE_MS = 1000;
const TIMEOUT_MS = 10000;
// Hosts that answer every old link with their own picture over the image --
// photobucket stamps "Groupsy by photobucket" across it -- so an answer from
// one is not the image the map named.
const WATERMARKED_HOST = /(^|\.)photobucket\.com$/i;

function hostOf(url) {
  try {
    return new URL(url.startsWith('//') ? `http:${url}` : url).hostname;
  } catch {
    return '';
  }
}

// `localImage(url)` says whether this server has an `/img/` texture itself:
// one is never fetched, only looked for.
function createImageCheck({
  statePath, userAgent, log, logError, onChecked = () => {}, localImage = () => false,
}) {
  // url -> { ok, at }, `at` the ms the answer came
  let checked = new Map();
  try {
    checked = new Map(Object.entries(JSON.parse(fs.readFileSync(statePath, 'utf8'))));
  } catch {
    // None yet.
  }
  const queue = new Set();
  let running = false;
  let saveTimer = null;

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, `${JSON.stringify(Object.fromEntries(checked), null, 1)}\n`);
      } catch (error) {
        logError(`Could not write ${statePath}:`, error);
      }
    }, 5000);
    saveTimer.unref?.();
  }

  async function check(url) {
    let ok = false;
    if (WATERMARKED_HOST.test(hostOf(url))) {
      checked.set(url, { ok, at: Date.now() });
      save();
      return;
    }
    try {
      const response = await fetch(url.startsWith('//') ? `http:${url}` : url, {
        headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      ok = response.ok && /^image\//.test(response.headers.get('content-type') || '');
      await response.body?.cancel().catch(() => {});
    } catch {
      ok = false;
    }
    checked.set(url, { ok, at: Date.now() });
    save();
  }

  async function run() {
    if (running) return;
    running = true;
    let missing = 0;
    let done = 0;
    while (queue.size > 0) {
      const url = queue.values().next().value;
      queue.delete(url);
      await check(url);
      done += 1;
      if (!checked.get(url).ok) missing += 1;
      await new Promise((resolve) => { setTimeout(resolve, PACE_MS).unref?.(); });
    }
    running = false;
    if (done) {
      log(`[IMAGES] ${done} texture URL(s) checked, ${missing} missing`);
      onChecked();
    }
  }

  return {
    // Queues the URLs never checked, or not for a month.
    want(urls) {
      const now = Date.now();
      for (const url of (urls || []).filter((candidate) => !candidate.startsWith('/img/'))) {
        const known = checked.get(url);
        if (!known || now - known.at > RECHECK_MS) queue.add(url);
      }
      if (queue.size > 0) run();
    },
    // The URLs found missing, and every one on a watermarking host; one not
    // checked yet is not counted.
    missing(urls) {
      return (urls || []).filter((url) => (url.startsWith('/img/') ? !localImage(url)
        : checked.get(url)?.ok === false || WATERMARKED_HOST.test(hostOf(url))));
    },
  };
}

module.exports = { createImageCheck };
