/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// bzflag-motd.cjs - BZFlag's message of the day, which every BZFlag client
// fetches when it starts (`MessageOfTheDay`, src/bzflag/motd.cxx) and shows
// in its message panel. Fetched here rather than by each browser, which the
// site's CORS would not allow, and handed to clients as they connect.
'use strict';

const MOTD_URL = 'https://www.bzflag.org/motd.php';
const REFRESH_MS = 60 * 60 * 1000;

// The messages for a client of `version`, as upstream picks them: the reply
// is four lines a message -- title, date, text, `BZFlag version: <regex>` --
// and a message whose regex matches the version is shown. A version of
// `0.0` means every client, and one starting with a digit is a prefix.
// `UPGRADE:` messages are the native client's new-version dialog, about a
// download a browser has no use for, so they are left out.
function parseMotd(text, version) {
  const lines = String(text).split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0 || lines.length % 4) return [];
  const shown = [];
  for (let i = 0; i < lines.length; i += 4) {
    const [title, , body, versionLine] = lines.slice(i, i + 4);
    let pattern = versionLine.slice(versionLine.indexOf(':') + 2);
    if (/^\d/.test(pattern)) pattern = pattern === '0.0' ? '[a-z0-9\\.-]*' : `^${pattern}[a-z0-9\\.-]*`;
    let matches = false;
    try {
      matches = new RegExp(pattern, 'i').test(version);
    } catch {
      // A regex JavaScript cannot read matches nothing.
    }
    if (matches && !title.startsWith('UPGRADE: ')) shown.push(body);
  }
  return shown;
}

function createBzflagMotd({ version, log }) {
  let messages = [];
  async function refresh() {
    try {
      const response = await fetch(MOTD_URL, { headers: { 'User-Agent': version } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = parseMotd(await response.text(), version);
      if (next.join('\n') !== messages.join('\n')) log(`[MOTD] ${next.length} message(s)`);
      messages = next;
    } catch (error) {
      log(`[MOTD] ${MOTD_URL}: ${error.message}`);
    }
  }
  refresh();
  setInterval(refresh, REFRESH_MS).unref?.();
  return { messages: () => messages.slice() };
}

module.exports = { createBzflagMotd, parseMotd };
