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

const TANK_PART_ALIASES = {
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

// The three navigation lights, which a model places itself. Upstream fixes
// them at one point above the stock tank's turret, and that point is inside
// the turret of half of bzo's models -- so each model names its own, as a
// single-vertex `p` object, and a model that names none falls back to
// upstream's coordinates.
//
// A `p` object is invisible to `readObjObjectNames` below and to the
// renderer's `child.isMesh` part lookup, which is what makes these safe to
// add: nothing that builds a tank out of parts can pick one up by accident.
// Only the light builder, which reads their vertices directly, sees them.
const TANK_LIGHT_ALIASES = {
  rear: ['lightRear'],
  port: ['lightPort'],
  starboard: ['lightStarboard'],
};

const TANK_WHEEL_PREFIX_ALIASES = {
  left: ['leftWheel', 'wheel_left'],
  right: ['rightWheel', 'wheel_right'],
};

// The three parts every model must name, whatever else it carries.
const TANK_REQUIRED_PARTS = ['body', 'turret', 'barrel'];

// What a model has to run on. A tracked model names all three tread parts per
// side, a wheeled one names indexed wheels on both sides, and either is enough
// -- but a model with neither has nothing the ground animation can drive.
function tankRunningGear(objectNames) {
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
function missingTankParts(objectNames) {
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

// The loader's `_object_pattern` (OBJLoader.js:20), which is what makes `g` and
// `o` the same command as far as the meshes it builds are concerned.
const OBJ_OBJECT_PATTERN = /^[og]\s*(.+)?/;

// The object names an OBJ file declares, which is all either end reads to
// answer the question above. Kept here so the server parses the contract the
// same way the loader names the meshes it builds.
//
// `g` opens a block exactly as `o` does, because the loader's own
// `_object_pattern` is `/^[og]\s*(.+)?/` and calls `startObject` for either.
// Reading only `o` is how a per-material Blender export -- `o body` followed by
// `g body_body_skin` carrying every face -- passes as a model with a body and
// then builds meshes named nothing the renderer looks for.
//
// A block is only a name something can build if faces landed in it. The loader
// drops an object whose geometry stayed empty, so the `o body` above names no
// mesh at all; counting it would report a part the model does not have.
//
// A block that carries even one loose `l` (or `p`) primitive builds as a
// LineSegments or Points node instead of a Mesh: OBJLoader.js sets the whole
// object's type the first time it sees either command and never sets it back,
// so a hundred `f` faces in the same block still come out invisible to the
// renderer's `child.isMesh` lookup. Such a block is left out of the returned
// names the same way an empty one is -- a name nothing can ever build.
function readObjObjectNames(text) {
  const names = [];
  let current = null;
  let tainted = false;
  let faces = 0;
  const commit = () => {
    if (current !== null && !tainted && faces > 0) names.push(current);
  };
  for (const line of String(text).split('\n')) {
    if (line.startsWith('f ')) {
      faces += 1;
    } else if (line.startsWith('l ') || line.startsWith('p ')) {
      tainted = true;
    } else if (OBJ_OBJECT_PATTERN.test(line)) {
      commit();
      // The loader's own naming: everything after the command, trimmed.
      current = line.slice(1).trim();
      tainted = false;
      faces = 0;
    }
  }
  commit();
  return names;
}

module.exports = {
  TANK_PART_ALIASES,
  TANK_LIGHT_ALIASES,
  TANK_WHEEL_PREFIX_ALIASES,
  TANK_REQUIRED_PARTS,
  tankRunningGear,
  missingTankParts,
  readObjObjectNames,
};
