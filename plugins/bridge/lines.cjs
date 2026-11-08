/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The rules every chat bridge shares, whatever network it reaches: what a
// game line looks like outside, and what a line from outside may be inside.
// See docs/chat-bridge-plan.md, "One bridge, several transports".

'use strict';

// How many lines of one message from outside reach the game, and how long
// each may be: a chat line is short, and a long post is better read where it
// was written.
const GAME_LINES = 3;
const GAME_LINE_LIMIT = 200;

// Lines held while a network is not answering, beyond which the oldest go.
const QUEUE_LIMIT = 200;

// Text as another network shows it: no BZFlag colour codes (`ESC[...m`,
// whole) and no other control characters.
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

// A message from outside as the game lines it becomes: three at most, each
// cut to its limit, the last saying when there was more. Empty when there is
// nothing to say.
function gameLines(text, where) {
  const lines = String(text).split('\n').map(plain).filter(Boolean);
  const shown = lines.slice(0, GAME_LINES).map((line) => (line.length > GAME_LINE_LIMIT
    ? `${line.slice(0, GAME_LINE_LIMIT - 1)}…` : line));
  if (lines.length > GAME_LINES) shown[GAME_LINES - 1] += ` (more in ${where})`;
  return shown;
}

// A line from outside that is a command, which is not chat and never reaches
// the game as chat: `/` anywhere, and `!` where the network's own clients take
// `/` for themselves.
function isCommand(text, prefixes = ['/']) {
  const start = String(text).trim();
  return prefixes.some((prefix) => start.startsWith(prefix));
}

// A person joining or leaving, as a bridge says it, with who is in now:
// `Foo joined, p 2 o 1 b 1` -- players, observers and bots, each left out at
// none. Bots and observers are counted from what the game reports; the one
// leaving is already gone from it.
function rosterLine(bz, callsign, joined) {
  let playing = 0;
  let observing = 0;
  let bots = 0;
  for (const id of bz.bz_getPlayerIndexList()) {
    const record = bz.bz_getPlayerByIndex(id);
    if (!record) continue;
    if (record.team === bz.eObservers) observing++;
    else if (record.bot) bots++;
    else playing++;
  }
  const counts = [['p', playing], ['o', observing], ['b', bots]].filter(([, n]) => n > 0)
    .map(([key, n]) => `${key} ${n}`).join(' ');
  return `${plain(callsign)} ${joined ? 'joined' : 'left'}, ${counts || 'p 0'}`;
}

// How long after a bridge starts a person counts as rejoining: a restart
// drops everyone without their leaving being heard, and they come back
// within it.
const REJOIN_SECONDS = 120;

// Joins and leaves as a bridge says them, once: who the room was last told
// is in is kept in `store`, so a restart says nothing of the people coming
// back, and after `REJOIN_SECONDS` says who did not. `say(line)` posts.
function createRoster({ bz, store, say, setTimer = setTimeout, now = Date.now }) {
  const startedAt = now();
  const told = new Set(store.load()?.in || []);
  const save = () => store.save({ in: [...told] });
  const present = () => new Set(bz.bz_getPlayerIndexList()
    .map((id) => bz.bz_getPlayerByIndex(id))
    .filter((record) => record && !record.bot)
    .map((record) => plain(record.callsign)));
  setTimer(() => {
    const here = present();
    for (const callsign of [...told]) {
      if (here.has(callsign)) continue;
      told.delete(callsign);
      say(rosterLine(bz, callsign, false));
    }
    save();
  }, REJOIN_SECONDS * 1000);
  return {
    // A person's join or leave event.
    heard(record, joined) {
      if (!record || record.bot) return;
      const callsign = plain(record.callsign);
      const rejoined = joined && told.has(callsign) && now() - startedAt < REJOIN_SECONDS * 1000;
      if (joined) told.add(callsign);
      else if (!told.delete(callsign)) return;
      save();
      if (!rejoined) say(rosterLine(bz, record.callsign, joined));
    },
  };
}

module.exports = {
  GAME_LINES, GAME_LINE_LIMIT, QUEUE_LIMIT, REJOIN_SECONDS, plain, gameLines, isCommand, rosterLine, createRoster,
};
