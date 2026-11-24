/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Practice's settings (docs/practice.md, "Settings"): what the worker plays by
// and what the Operator panel offers in practice, kept in this browser. The
// level and the number of bots are this browser's for every map; shots,
// ricochet and jumping are per map, since maps set them differently.

export const PRACTICE_LEVELS = Object.freeze(['easy', 'normal', 'hard']);
// How many Aces, unless `&bots=N` says otherwise: every one runs in this
// browser, so a phone is the limit, not the map.
export const PRACTICE_DEFAULT_BOTS = 3;
export const PRACTICE_MAX_BOTS = 15;

const GLOBAL_KEY = 'practiceSettings';
const MAP_KEY_PREFIX = 'practiceMapSettings:';
// A map's own settings a player may change, as the panel names them, to the
// config key each sets.
export const PRACTICE_MAP_SETTINGS = Object.freeze({
  shotMaxActive: 'SHOT_MAX_ACTIVE',
  ricochet: 'ALL_SHOTS_RICOCHET',
  jumping: 'ALLOW_JUMPING',
});

function read(key, storage) {
  try {
    const value = JSON.parse(storage.getItem(key));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function write(key, value, storage) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Too full to keep it: it still plays this once.
  }
}

export const clampPracticeBots = (bots) => Math.max(0, Math.min(PRACTICE_MAX_BOTS, Math.round(Number(bots) || 0)));

// The level and bot count this browser last chose.
export function readPracticeChoice(storage = globalThis.localStorage) {
  const kept = read(GLOBAL_KEY, storage);
  return {
    level: PRACTICE_LEVELS.includes(kept.level) ? kept.level : 'normal',
    bots: Number.isInteger(kept.bots) ? clampPracticeBots(kept.bots) : PRACTICE_DEFAULT_BOTS,
  };
}

export function writePracticeChoice({ level, bots }, storage = globalThis.localStorage) {
  write(GLOBAL_KEY, { level, bots: clampPracticeBots(bots) }, storage);
}

// The settings a player changed on one map, by panel name.
export function readPracticeMapSettings(map, storage = globalThis.localStorage) {
  const kept = read(MAP_KEY_PREFIX + map, storage);
  return Object.fromEntries(Object.entries(kept).filter(([name]) => name in PRACTICE_MAP_SETTINGS));
}

export function writePracticeMapSettings(map, settings, storage = globalThis.localStorage) {
  write(MAP_KEY_PREFIX + map, { ...readPracticeMapSettings(map, storage), ...settings }, storage);
}

// A map's game with the player's own changes laid over it, as `gameplay` so
// what derives from them -- the reload time from the shot count -- follows.
export function withPracticeMapSettings(gameplay, settings) {
  const over = {};
  for (const [name, value] of Object.entries(settings)) over[PRACTICE_MAP_SETTINGS[name]] = value;
  return { ...gameplay, ...over };
}

// The link that plays these settings.
export function practiceUrl({ level, map, bots }) {
  const params = new URLSearchParams({ practice: level });
  if (map) params.set('map', map);
  params.set('bots', String(clampPracticeBots(bots)));
  return `/?${params}`;
}
