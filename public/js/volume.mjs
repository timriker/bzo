/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// volume.mjs - The audio level model shared by the Audio dialog, the XR Audio
// screen, the renderer, and voice chat.
//
// BZFlag's "Sound Volume:" is an integer slider from 0 to 10 (OptionsMenu.cxx),
// and its mixer squares the level -- `volumeAtten = 0.02f * code * code` in
// sound.cxx, commented "to compensate for human hearing". bzo keeps both the
// 0..10 scale and the squared curve.
//
// What bzo does not keep is upstream's ceiling. 0.02 * 10 * 10 is 2.0, so
// BZFlag's default level is double gain, which its software mixer sums into a
// scratch buffer it clips itself. Web Audio has no such stage and would simply
// distort, and bzo's samples are already balanced at the level render.js played
// them before there was a setting. So level 10 is unity here: gain is
// (level / 10)^2, which is upstream's curve scaled to end at 1 instead of 2.

export const VOLUME_MIN_LEVEL = 0;
export const VOLUME_MAX_LEVEL = 10;
export const DEFAULT_VOLUME_LEVEL = VOLUME_MAX_LEVEL;

// One row per adjustable channel, in the order both the Audio dialog and the XR
// Audio screen present them. Like SETTINGS_MENU_ITEMS, the row carries the DOM
// ids it drives so the two renderers cannot drift apart.
export const VOLUME_CHANNELS = Object.freeze([
  {
    id: 'game',
    label: 'Game volume',
    storageKey: 'bzo.volume.game',
    sliderId: 'gameVolumeSlider',
    valueId: 'gameVolumeValue',
    xrId: 'gameVolumeXR',
  },
  {
    id: 'voice',
    label: 'Voice volume',
    storageKey: 'bzo.volume.voice',
    sliderId: 'voiceVolumeSlider',
    valueId: 'voiceVolumeValue',
    xrId: 'voiceVolumeXR',
  },
  {
    id: 'microphone',
    label: 'Microphone volume',
    storageKey: 'bzo.volume.microphone',
    sliderId: 'microphoneVolumeSlider',
    valueId: 'microphoneVolumeValue',
    xrId: 'microphoneVolumeXR',
  },
]);

export function clampVolumeLevel(value, fallback = DEFAULT_VOLUME_LEVEL) {
  // Number(null) and Number('') are both 0, so an absent stored level would
  // otherwise read as silence rather than as "no level saved yet".
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(VOLUME_MIN_LEVEL, Math.min(VOLUME_MAX_LEVEL, numeric));
}

// Left/Right on a focused row moves one step and stops at the ends. Wrapping
// would put a slider at full volume one press past silence.
export function stepVolumeLevel(value, direction) {
  const level = clampVolumeLevel(value);
  const step = Number(direction) < 0 ? -1 : 1;
  return clampVolumeLevel(level + step, level);
}

export function volumeLevelToGain(level) {
  const clamped = clampVolumeLevel(level);
  return (clamped / VOLUME_MAX_LEVEL) ** 2;
}

// Upstream's slider reads "Off" at the bottom rather than "0%", and so does
// this one. Every other stop is named for its slider position, not its gain:
// level 5 says 50% because it is halfway along, even though it is a quarter of
// the power.
export function formatVolumeLevel(level) {
  const clamped = clampVolumeLevel(level);
  if (clamped === VOLUME_MIN_LEVEL) return 'Off';
  return `${clamped * (100 / VOLUME_MAX_LEVEL)}%`;
}

export function readVolumeLevel(storage, storageKey) {
  if (!storage || typeof storage.getItem !== 'function') return DEFAULT_VOLUME_LEVEL;
  try {
    return clampVolumeLevel(storage.getItem(storageKey));
  } catch {
    // A blocked storage area is not a reason to start the game silent.
    return DEFAULT_VOLUME_LEVEL;
  }
}

export function writeVolumeLevel(storage, storageKey, level) {
  const clamped = clampVolumeLevel(level);
  if (storage && typeof storage.setItem === 'function') {
    try {
      storage.setItem(storageKey, String(clamped));
    } catch {
      // Persistence is a convenience; the level still applies for this session.
    }
  }
  return clamped;
}
