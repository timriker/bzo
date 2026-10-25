/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Voice: a player's microphone state, and the WebRTC offers, answers and
// candidates passed between two of them. Each handler takes the player who
// sent the message, their socket and the message; acceptConnection (server.js)
// calls it by the message's `type`, through MESSAGE_HANDLERS.

const { normalizeVoiceChannel } = require('../public/js/voice-channels.mjs');

// What the handlers need of server.js, from `useServer`.
let broadcastAll;
let forwardVoiceSignal;
let refreshVoiceRosters;
let sendVoiceStateUpdate;

function useServer(deps) {
  ({
    broadcastAll,
    forwardVoiceSignal,
    refreshVoiceRosters,
    sendVoiceStateUpdate,
  } = deps);
}

function handleVoiceState(player, ws, message) {
  if (!player.joined) return;

  // An unrecognized channel normalizes to the default rather than being
  // rejected, so an older or newer client lands somewhere valid instead
  // of silently having no voice at all.
  if (message.channel !== undefined) {
    player.voiceChannel = normalizeVoiceChannel(message.channel);
  }
  player.voiceMicEnabled = message.enabled === true;
  sendVoiceStateUpdate(player);
  // A channel change rewrites other players' rosters too, not just this
  // one's, so every roster is reconsidered rather than only the sender's.
  refreshVoiceRosters();
  // sendVoiceStateUpdate only reaches this player's current voice
  // peers, because that message is also what negotiates the WebRTC
  // roster. The scoreboard's mic glyph is for every player in the
  // match, on any channel or out of Nearby range alike, so it needs
  // its own broadcast rather than reusing that one.
  broadcastAll({
    type: 'voiceMicToggled', playerId: player.id, enabled: player.voiceMicEnabled,
  });
  return;
}

function handleVoiceIceCandidate(player, ws, message) {
  forwardVoiceSignal(player, message);
  return;
}

const MESSAGE_HANDLERS = Object.freeze({
  voiceState: handleVoiceState,
  voiceOffer: handleVoiceIceCandidate,
  voiceAnswer: handleVoiceIceCandidate,
  voiceIceCandidate: handleVoiceIceCandidate,
});

module.exports = { useServer, MESSAGE_HANDLERS };
