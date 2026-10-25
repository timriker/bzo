/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The patterns a tank's body may wear: 2.5's skins, in its JoinMenu order
// (`JoinMenu.cxx:105`), so a skin's place here is the number `MsgEnter`
// carries (`Player.cxx:908`). Upstream paints every skin once per team
// (`<team>_tank<suffix>.png`), and bzo ships all of them: a tank in its team's
// band of shades wears its team's file, moved only as far as its shade is from
// the team colour, and any other colour has the blue file repainted for it
// (camo.mjs). The 2.5 files are upstream's 500-800 pixel ones scaled to 256 and
// reduced to 256 colours, the palette the painter works through; `size` is the
// file's, which the tank's canvas takes so it is filled texel for texel.
export const TANK_SKINS = Object.freeze([
  Object.freeze({ id: 'standard', label: 'Standard', suffix: '', size: 128 }),
  Object.freeze({ id: 'hex', label: 'Hex', suffix: '_hex', size: 256 }),
  Object.freeze({ id: 'digital', label: 'Digital', suffix: '_digital', size: 256 }),
  Object.freeze({ id: 'facet', label: 'Facet', suffix: '_facet', size: 256 }),
  Object.freeze({ id: 'solid', label: 'Solid', suffix: '_solid', size: 256 }),
]);

// `Team::getImagePrefix`: the teams upstream paints a tank for.
export const TANK_SKIN_TEAMS = Object.freeze(['rogue', 'red', 'green', 'blue', 'purple', 'rabbit', 'hunter']);

export const DEFAULT_TANK_SKIN = 'standard';

export function normalizeTankSkinId(id) {
  return TANK_SKINS.some((skin) => skin.id === id) ? id : DEFAULT_TANK_SKIN;
}

export function getTankSkin(id) {
  const wanted = normalizeTankSkinId(id);
  return TANK_SKINS.find((skin) => skin.id === wanted);
}

// The file a skin is painted from for a team, and the blue one for anything
// that is not a team upstream paints.
export function getTankSkinTexture(skin, team = 'blue') {
  const prefix = TANK_SKIN_TEAMS.includes(team) ? team : 'blue';
  return `/textures/${prefix}_tank${skin.suffix}.png`;
}
