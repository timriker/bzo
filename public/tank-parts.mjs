/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The tank part contract from docs/tank-model-format.md, shared by the client
// and the server.
//
// A tank is the OBJ file it was loaded from and nothing else, so a model whose
// objects do not carry these names cannot be drawn at all. Both ends need the
// same answer for that: the renderer discovers the parts it clones by these
// names, and the server refuses to offer a model that is missing any of them
// rather than listing one that would draw as nothing.
//
// Names are the hard contract; material names are advisory. Upstream BZFlag's
// own `body`/`turret`/`barrel`/`ltread`/`rtread` come first in every alias list,
// and the bzo extensions follow.

export const TANK_PART_ALIASES = {
  body: ['body'],
  turret: ['turret'],
  barrel: ['barrel'],
  leftTreadMiddle: ['leftTreadMiddle', 'tread_belt_left', 'leftTrack', 'ltread'],
  leftTreadFrontCap: ['leftTreadFrontCap', 'tread_cap_left_front', 'leftTrack', 'ltread'],
  leftTreadRearCap: ['leftTreadRearCap', 'tread_cap_left_rear', 'leftTrack', 'ltread'],
  rightTreadMiddle: ['rightTreadMiddle', 'tread_belt_right', 'rightTrack', 'rtread'],
  rightTreadFrontCap: ['rightTreadFrontCap', 'tread_cap_right_front', 'rightTrack', 'rtread'],
  rightTreadRearCap: ['rightTreadRearCap', 'tread_cap_right_rear', 'rightTrack', 'rtread'],
};

export const TANK_WHEEL_PREFIX_ALIASES = {
  left: ['leftWheel', 'wheel_left'],
  right: ['rightWheel', 'wheel_right'],
};

// The three parts every model must name, whatever else it carries.
export const TANK_REQUIRED_PARTS = ['body', 'turret', 'barrel'];

// What a model has to run on. A tracked model names all three tread parts per
// side, a wheeled one names indexed wheels on both sides, and either is enough
// -- but a model with neither has nothing the ground animation can drive.
export function tankRunningGear(objectNames) {
  const names = new Set(objectNames);
  const has = (role) => TANK_PART_ALIASES[role].some((alias) => names.has(alias));
  const wheels = (side) => [...names].some(
    (name) => TANK_WHEEL_PREFIX_ALIASES[side].some((prefix) => name.startsWith(prefix)),
  );
  return {
    leftTread: has('leftTreadMiddle') && has('leftTreadFrontCap') && has('leftTreadRearCap'),
    rightTread: has('rightTreadMiddle') && has('rightTreadFrontCap') && has('rightTreadRearCap'),
    leftWheels: wheels('left'),
    rightWheels: wheels('right'),
  };
}

// The roles a model fails to fill, named the way the docs name them so a log
// line says what to rename in Blender. An empty array means the renderer can
// build it.
export function missingTankParts(objectNames) {
  const names = new Set(objectNames);
  const missing = TANK_REQUIRED_PARTS.filter(
    (role) => !TANK_PART_ALIASES[role].some((alias) => names.has(alias)),
  );
  const gear = tankRunningGear(objectNames);
  const tracked = gear.leftTread && gear.rightTread;
  const wheeled = gear.leftWheels && gear.rightWheels;
  if (!tracked && !wheeled) missing.push('treads or wheels on both sides');
  return missing;
}

// The object names an OBJ file declares, which is all either end reads to
// answer the question above. Kept here so the server parses the contract the
// same way the loader names the meshes it builds.
export function readObjObjectNames(text) {
  const names = [];
  for (const line of String(text).split('\n')) {
    if (line.startsWith('o ')) names.push(line.slice(2).trim());
  }
  return names;
}
