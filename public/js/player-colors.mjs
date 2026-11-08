/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Each tank's own colour, for the server and for practice (the offline game,
// `bot-game.mjs`): a distinct one off the whole wheel without colour teams,
// and a shade of its team's colour with them.
//
// Upstream gives every tank on a team the one team colour (Team::getTankColor,
// Team.cxx:30) and has nothing per player -- do not go looking for it there.
// bzo shades team mates apart inside a band around that colour, for the same
// reason it gives every player a distinct colour outside team mode: so a player
// can tell two team mates apart at a range where the labels are unreadable. The
// team is still what the colour says first; the band is narrow enough that no
// shade of one team reads as another.

import { getPlayerTeamColor, isObserverTeam, PLAYER_TEAM, PLAYER_TEAM_COLORS } from './teams.mjs';

// How far a team mate's shade may sit from the team colour. The hue spread is
// bounded by the closest pair of team colours -- red at 0 and purple at 300, 60
// degrees apart -- so ten degrees either side leaves 40 of clearance and no red
// is ever within reach of a purple. `check:team-shade-bands` asserts that
// against the team colours rather than trusting this comment. Most of the
// separation comes from lightness for that reason, and because the team
// colours are already fully saturated and can only move down.
export const TEAM_SHADE_HUE_SPREAD = 10;
export const TEAM_SHADE_HUE_STEP = 5;
export const TEAM_SHADE_SAT_SPREAD = 12;
export const TEAM_SHADE_LIGHT_SPREAD = 14;
// Below this there is no hue to shade: observer's white would only go grey.
export const TEAM_SHADE_MIN_SATURATION = 15;

export function colorIntToRgb(color) {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

export function rgbToColorInt({ r, g, b }) {
  return (r << 16) | (g << 8) | b;
}

export function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
  return { r: Math.round(255 * f(0)), g: Math.round(255 * f(8)), b: Math.round(255 * f(4)) };
}

export function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const light = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: 0, sat: 0, light: light * 100 };
  const sat = delta / (1 - Math.abs(2 * light - 1));
  let hue;
  switch (max) {
    case rn:
      hue = 60 * (((gn - bn) / delta) % 6);
      break;
    case gn:
      hue = 60 * ((bn - rn) / delta + 2);
      break;
    default:
      hue = 60 * ((rn - gn) / delta + 4);
      break;
  }
  if (hue < 0) hue += 360;
  return { hue, sat: sat * 100, light: light * 100 };
}

function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

// How far a candidate sits from the nearest colour already taken.
function scoreCandidateColor(candidate, existing) {
  if (existing.length === 0) return Number.POSITIVE_INFINITY;
  let minScore = Number.POSITIVE_INFINITY;
  for (const other of existing) {
    const dr = candidate.rgb.r - other.rgb.r;
    const dg = candidate.rgb.g - other.rgb.g;
    const db = candidate.rgb.b - other.rgb.b;
    const score = (dr * dr) + (dg * dg) + (db * db) + (hueDistance(candidate.hue, other.hue) * 64)
      + (Math.abs(candidate.sat - other.sat) * 12) + (Math.abs(candidate.light - other.light) * 10);
    if (score < minScore) minScore = score;
  }
  return minScore;
}

// A pastel-ish colour as far as practical from the other tanks' (`others`,
// each `{ team, color }`): without a team (`team` null), off the whole wheel
// and clear of everyone; with one, from a band round the team's colour and
// clear of team mates only, so a red tank is still unmistakably red. A team
// with no hue to shade -- observer's white -- keeps its colour as it is.
//
// Nothing is rebalanced when a player leaves. The gap they free is the one the
// next joiner is most likely to take, and a tank that changed colour mid-match
// would undo the only thing the shade is for.
export function pickDistinctColor(team, others, random = Math.random) {
  const teamColor = team === null || team === undefined ? null : getPlayerTeamColor(team);
  const teamHsl = Number.isFinite(teamColor)
    ? (() => {
      const rgb = colorIntToRgb(teamColor);
      return rgbToHsl(rgb.r, rgb.g, rgb.b);
    })()
    : null;
  if (teamHsl && teamHsl.sat < TEAM_SHADE_MIN_SATURATION) return teamColor;
  // A red tank has no reason to avoid looking like a particular blue one.
  const existing = others.filter((other) => !teamHsl || other.team === team)
    .map((other) => other.color).filter((color) => Number.isFinite(color)).map((color) => {
    const rgb = colorIntToRgb(color);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    return { rgb, hue: hsl.hue, sat: hsl.sat, light: hsl.light };
  });
  const clampPercent = (value) => Math.max(0, Math.min(100, value));
  const hues = [];
  const saturations = [];
  const lightnesses = [];
  if (teamHsl) {
    for (let offset = -TEAM_SHADE_HUE_SPREAD; offset <= TEAM_SHADE_HUE_SPREAD; offset += TEAM_SHADE_HUE_STEP) {
      hues.push((teamHsl.hue + offset + 360) % 360);
    }
    // The team colours are fully saturated already, so saturation only has
    // room downwards; lightness has room both ways.
    for (const offset of [0, -TEAM_SHADE_SAT_SPREAD, -2 * TEAM_SHADE_SAT_SPREAD]) {
      saturations.push(clampPercent(teamHsl.sat + offset));
    }
    for (const offset of [0, -TEAM_SHADE_LIGHT_SPREAD, TEAM_SHADE_LIGHT_SPREAD]) {
      lightnesses.push(clampPercent(teamHsl.light + offset));
    }
  } else {
    for (let hue = 0; hue < 360; hue += 12) hues.push(hue);
    saturations.push(58, 66, 74);
    lightnesses.push(58, 64, 70);
  }
  const scored = [];
  let best = -1;
  for (const hue of hues) {
    for (const sat of saturations) {
      for (const light of lightnesses) {
        const candidate = { hue, sat, light, rgb: hslToRgb(hue, sat, light) };
        const score = scoreCandidateColor(candidate, existing);
        scored.push({ candidate, score });
        if (score > best) best = score;
      }
    }
  }
  if (scored.length === 0) {
    if (teamHsl) return teamColor;
    return rgbToColorInt(hslToRgb(Math.floor(random() * 360), 66, 64));
  }
  const top = scored.filter(({ score }) => score >= best * 0.72)
    .sort((left, right) => right.score - left.score)
    .slice(0, 28);
  const chosen = top[Math.floor(random() * top.length)] || scored[0];
  return rgbToColorInt(chosen.candidate.rgb);
}

// Observer is the exception at both ends: it keeps upstream's flat white on
// every server, whatever the team mode. An observer has no tank to tell apart
// from another observer's -- it is never drawn -- and its scoreboard row is
// read by name, so there is nothing for a distinct colour to distinguish. With
// colour teams on `pickDistinctColor` already answers white for it, white
// having no hue to shade; this makes it true with them off as well.
export function getInitialPlayerColor(teamMode, team, pick) {
  if (isObserverTeam(team)) return PLAYER_TEAM_COLORS[PLAYER_TEAM.OBSERVER];
  return pick(teamMode.enabled ? team : null);
}

// What colour a player takes when a join puts them on `team`, having been on
// `previousTeam` (null for a first join). `null` means the colour they already
// have stands, which is what a rejoin on a world with no colour teams gets: a
// tank that changed colour mid-match would undo the only thing a distinct
// colour is for. `pick(team)` is `pickDistinctColor` with the colours to stand
// apart from.
export function getJoinPlayerColor(teamMode, team, previousTeam, pick) {
  if (isObserverTeam(team)) return PLAYER_TEAM_COLORS[PLAYER_TEAM.OBSERVER];
  // A shade inside the new team's band rather than the flat team colour.
  if (teamMode.enabled) return pick(team);
  // Coming back from observer on a world with no colour teams, where the
  // constructor's colour is long gone: the white it was wearing is nobody's,
  // so it takes a fresh one off the whole wheel rather than staying white.
  if (isObserverTeam(previousTeam)) return pick(null);
  return null;
}
