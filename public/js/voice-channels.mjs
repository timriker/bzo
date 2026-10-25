/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Which players hear each other, shared by the client and the server.
//
// A channel is the room a player is in. Two players are voice peers only when
// they are in the same channel and that channel's rule puts them together. Both
// rules are symmetric -- distance is, and so is sharing a team -- so one
// predicate answers for both ends of a connection.
//
// It has to be the server that applies it. The media is peer to peer, so a
// client-side filter is not a filter at all: a modified client that opened a
// connection anyway would simply be heard. What the server withholds is the
// roster and the signalling, which is what makes the rule stick.
//
// Rogue and Observer are teams here. That is what upstream does -- the team
// message dispatch in src/bzfs/bzfs.cxx sends to every player whose
// `isTeam(_team)` matches, with no exception for either.

export const VOICE_CHANNEL_ALL = 'all';
export const VOICE_CHANNEL_NEARBY = 'nearby';
export const VOICE_CHANNEL_TEAM = 'team';

export const DEFAULT_VOICE_CHANNEL = VOICE_CHANNEL_ALL;

// In the order the Audio dialog and the XR Audio screen offer them.
export const VOICE_CHANNELS = Object.freeze([
  Object.freeze({
    id: VOICE_CHANNEL_ALL,
    label: 'All',
    hint: 'Every player on the server, however far away.',
  }),
  Object.freeze({
    id: VOICE_CHANNEL_NEARBY,
    label: 'Nearby',
    hint: 'Players within earshot, whatever team they are on.',
  }),
  Object.freeze({
    id: VOICE_CHANNEL_TEAM,
    label: 'Team',
    hint: 'Your own team, however far away.',
  }),
]);

export function normalizeVoiceChannel(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return VOICE_CHANNELS.some((channel) => channel.id === id) ? id : DEFAULT_VOICE_CHANNEL;
}

export function getVoiceChannel(value) {
  const id = normalizeVoiceChannel(value);
  return VOICE_CHANNELS.find((channel) => channel.id === id);
}

// Only Nearby asks where anybody is standing. All and Team reach across the
// whole map, so a peer on either is heard at the level the player set and does
// not fade with distance.
export function voiceChannelUsesDistance(value) {
  return normalizeVoiceChannel(value) === VOICE_CHANNEL_NEARBY;
}

// The one rule, applied to both ends of a connection. `planarDistance` is only
// consulted for Nearby; a caller with no position to offer passes Infinity,
// which puts the pair out of earshot rather than silently in it.
export function areVoicePeers(source, target, planarDistance, nearbyRadius) {
  if (!source || !target) return false;
  const channel = normalizeVoiceChannel(source.voiceChannel);
  if (channel !== normalizeVoiceChannel(target.voiceChannel)) return false;
  if (channel === VOICE_CHANNEL_TEAM) return source.team === target.team;
  if (channel === VOICE_CHANNEL_ALL) return true;
  const distance = Number(planarDistance);
  return Number.isFinite(distance) && distance <= Number(nearbyRadius);
}
