/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Chat, a client's debug lines, and a client asking to watch the server bots'
// plans. Each handler takes the player who sent the message, their socket and
// the message; acceptConnection (server.js) calls it by the message's `type`,
// through MESSAGE_HANDLERS.

const {
  ADMIN_PLAYERS,
  ALL_PLAYERS,
  SERVER_PLAYER,
  channelTeam,
} = require('./player-ids.cjs');

// What the handlers need of server.js, from `useServer`.
let deliverActionMessage;
let deliverChatMessage;
let handleServerCommand;
let log;

function useServer(deps) {
  ({
    deliverActionMessage,
    deliverChatMessage,
    handleServerCommand,
    log,
  } = deps);
}

function handleMessage(player, ws, message) {
  const rawTarget = message.dst ?? message.to;
  // The destinations that are not a player, on upstream's own numbers
  // (`server/player-ids.cjs`). Both spellings, because a `<select>`
  // hands its value over as a string.
  const matches = (value) => rawTarget === value || rawTarget === String(value);
  const isAllTarget = matches(ALL_PLAYERS)
    || rawTarget === null || rawTarget === undefined || rawTarget === '';
  const isServerTarget = matches(SERVER_PLAYER);
  const isTeamTarget = channelTeam(rawTarget) !== null;
  const isAdminTarget = matches(ADMIN_PLAYERS);
  const targetId = isAllTarget || isServerTarget || isTeamTarget || isAdminTarget
    // A destination rather than a player: a number, and `ALL` even
    // when nothing named one.
    ? (isAllTarget ? ALL_PLAYERS : Number(rawTarget))
    : String(rawTarget);
  const msgType = message.msgType === 'action' ? 'action' : 'chat';
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (text.length === 0) return;

  // `/me` before the command dispatcher, because it is the one `/` line
  // that keeps its destination: upstream reformats it here for exactly
  // that reason (bzfs.cxx:1490). `/mefoo` is not `/me` and falls through
  // to the dispatcher -- upstream's "don't intercept other messages
  // beginning with /me...".
  if (/^\/me(\s|$)/i.test(text)) {
    deliverActionMessage(player, targetId, text.slice(3));
    return;
  }

  // Step 1 of docs/commands-plan.md, and the reason it goes first: a line
  // beginning with `/` is a command whatever channel it was aimed at, and
  // it is never said out loud -- a mistyped `/kick bob` must never
  // announce itself to the room as chat.
  if (handleServerCommand(player, text, targetId)) return;

  deliverChatMessage(player, targetId, msgType, text);
  return;
}

// A client showing its debug labels asks for the server bots' plans
// (`broadcastBotIntents`); nobody else is sent them.
function handleWatchBots(player, ws, message) {
  player.watchBots = message.on === true;
  player.watchBotFollow = typeof message.follow === 'string' ? message.follow : null;
  return;
}

function handleDebug(player, ws, message) {
  // Log debug messages from clients
  const payloadName = typeof message.name === 'string' ? message.name.trim() : '';
  const debugFrom = payloadName || player.name || `Player ${player.playerNumber}`;
  log(`[DEBUG] "${debugFrom}": ${message.message || ''}`);
  return;
}

const MESSAGE_HANDLERS = Object.freeze({
  message: handleMessage,
  watchBots: handleWatchBots,
  debug: handleDebug,
});

module.exports = { useServer, MESSAGE_HANDLERS };
