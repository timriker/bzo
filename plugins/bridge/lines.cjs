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

module.exports = { GAME_LINES, GAME_LINE_LIMIT, QUEUE_LIMIT, plain, gameLines, isCommand };
