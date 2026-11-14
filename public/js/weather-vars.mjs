/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The `_rain*` variables, read into the `weather` object bzo draws from: by
// the server from a map's `-set` lines (server/bzw-parse.cjs), and by the
// client from a live `setVar`, where upstream's WeatherRenderer rebuilds its
// rain on each one's callback. See "Weather" in docs/bzw.md.

import { parseColorString } from './bzdb.mjs';

// `_rainType` (`WeatherRenderer.cxx`): the preset names upstream recognizes.
// bzo builds every preset on one textured, spun or billboarded, roof-culled
// and puddled path rather than porting `doLineRain`'s plain streaks.
export const WEATHER_RAIN_TYPES = new Set(['rain', 'snow', 'fatrain', 'frog', 'particle', 'bubble']);

// The single-value `_rain*` variables, mapped to the `weather` field bzo's own
// JSON uses rather than upstream's BZDB name.
export const WEATHER_RAIN_NUMERIC_VARS = new Map([
  ['_rainDensity', 'density'],
  ['_rainSpread', 'spread'],
  ['_rainSpeed', 'speed'],
  ['_rainSpeedMod', 'speedMod'],
  ['_rainStartZ', 'startZ'],
  ['_rainEndZ', 'endZ'],
  ['_rainMaxPuddleTime', 'maxPuddleTime'],
  ['_rainPuddleSpeed', 'puddleSpeed'],
  ['_rainRoofs', 'roofs'],
]);

// `BZDB.isTrue`'s own reading: `atoi(value) != 0`, so "true" is false and only
// a nonzero number is true.
function atoiTrue(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed !== 0;
}

// `weather` with one variable laid over it. Null when `name` is not a weather
// variable; otherwise `{ weather, unread }`, `unread` for a value bzo cannot
// use (an unknown `_rainType`). `evalNumber(name)` reads the variable as a
// number, formulas and all; `isStockTexture(name)` says whether bzo has a
// texture of that name.
export function applyWeatherVar(weather, name, value, { evalNumber, isStockTexture }) {
  const text = String(value ?? '');
  const set = (fields) => ({ weather: { ...(weather || {}), ...fields }, unread: false });
  const same = { weather, unread: false };
  if (name === '_rainType') {
    // The one weather variable whose value is a preset name. Nothing turns
    // weather on without it, and `none` turns it off.
    const type = text.trim().toLowerCase();
    if (WEATHER_RAIN_TYPES.has(type)) return set({ type });
    if (!type || type === 'none') {
      if (!weather?.type) return same;
      const rest = { ...weather };
      delete rest.type;
      return { weather: rest, unread: false };
    }
    return { weather, unread: true };
  }
  if (WEATHER_RAIN_NUMERIC_VARS.has(name)) {
    const num = evalNumber(name);
    return Number.isFinite(num) ? set({ [WEATHER_RAIN_NUMERIC_VARS.get(name)]: num }) : same;
  }
  if (name === '_useRainPuddles') return set({ puddles: atoiTrue(text) });
  if (name === '_rainSpins') return set({ spin: atoiTrue(text) });
  if (name === '_useLineRain') return set({ lineRain: atoiTrue(text) });
  if (name === '_rainPuddleColor') {
    // `WeatherRenderer::set` (WeatherRenderer.cxx:322): the puddle tint, over
    // the preset's own. A colour that will not parse leaves it.
    const color = parseColorString(text);
    return color ? set({ puddleColor: color.slice(0, 3) }) : same;
  }
  if (name === '_rainBaseColor' || name === '_rainTopColor') {
    // The line streak's two vertex colours.
    const color = parseColorString(text);
    return color ? set({ [name === '_rainBaseColor' ? 'rainBaseColor' : 'rainTopColor']: color.slice(0, 4) }) : same;
  }
  if (name === '_rainTexture' || name === '_rainPuddleTexture') {
    const textureName = text.trim().toLowerCase();
    if (!isStockTexture(textureName)) return same;
    return set({ [name === '_rainTexture' ? 'texture' : 'puddleTexture']: textureName });
  }
  return null;
}
