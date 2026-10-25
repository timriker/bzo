/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Tanks: models and their textures, treads and wheels, nav lights, the
// teleporter crossing, and the tracks they leave.
// RenderManager's own methods, kept here and installed on its prototype by
// render.js: `this` is the RenderManager.

import { camoColor, camoPaintColor, isTeamShade, referenceHue, rgbToHsv, teamShadeColor, wrapSignedTurns } from './camo.mjs';
import { TANK } from './collision.mjs';
import { TANK_LIGHT_ALIASES, TANK_PART_ALIASES, TANK_WHEEL_PREFIX_ALIASES, missingTankParts } from './tank-parts.mjs';
import { TANK_SKIN_TEAMS, getTankSkin, getTankSkinTexture } from './tank-skins.mjs';
import { TRACK_TREAD_LEFT, TRACK_TREAD_RIGHT, TREAD_INSIDE, TREAD_MARK_WIDTH, TREAD_OUTSIDE, getTrackMarkAlpha } from './tracks.mjs';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GHOST_ALPHA_SCALE, GHOST_SCALE, LABEL_MATERIAL_DEPTH, TANK_NAV_LIGHTS_NAME, TANK_NAV_LIGHT_REFERENCE_HEIGHT, TANK_NAV_LIGHT_VERTEX_SHADER, tankAzimuth } from './render.js';

function maxMuzzleForward() {
  return (TANK.length / 2) + 0.1;
}
const MUZZLE_TIP_EPSILON = 0.03;

// Tank units of belt per tile of the tread image. Measured off bzflag-notracks.obj,
// whose authored tread runs u 0..1.6 around a loop of roughly 10.3 units, so a
// model that arrives without texture coordinates gets tread links the size the
// stock tank's are rather than a size of its own.
const TREAD_UNITS_PER_TILE = 6.4;

// `TankSceneNode::TankRenderNode::renderLights` (TankSceneNode.cxx:1391).
// Aircraft-style navigation lights on the turret: white astern, red to port,
// green to starboard, so which way a tank is pointing reads at a range where
// its silhouette does not yet. Upstream's tank-space coordinates: forward x,
// portward y, up z.
//
// These are the fallback. Upstream can hard-code one height because it has
// one tank; 2.1 clears bzflag-notracks.obj's turret by 0.02 and is buried inside the
// turret of bzfourtank, bzship and modern. Every model bzo offers names its
// own three lights, and these serve a model that does not.
const TANK_NAV_LIGHTS = [
  { role: 'rear', color: 0xffffff, position: [-1.53, 0, 2.1] },
  { role: 'port', color: 0xff0000, position: [0.1, 0.75, 2.1] },
  { role: 'starboard', color: 0x00ff00, position: [0.1, -0.75, 2.1] },
];

// A tank model is authored as an OBJ conventionally is, standing on +Y and
// facing -Z, with its starboard on +X. Each one is turned once as it loads to
// stand as upstream's tank does, on +Z facing +X with its port on +Y:
// (x, y, z) becomes (-z, -x, y).
const TANK_MODEL_TO_GAME = new THREE.Matrix4().set(
  0, 0, -1, 0,
  -1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

// The outer fraction of the dot's radius that fades out. At the two-pixel
// floor every pixel of the point is still inside the solid core, so the light
// reads exactly as bright as `GL_POINTS` draws it; the rim only starts doing
// anything once there are pixels to spend on it.
const TANK_NAV_LIGHT_EDGE = 0.7;

// A round dot rather than the hard square a point sprite is by default, and
// fogged, because upstream draws its lights inside the same `GL_FOG` as
// everything else and a light that stayed bright through the haze would mark a
// tank the tank itself is hidden by.
const TANK_NAV_LIGHT_FRAGMENT_SHADER = `
varying vec3 vColor;
#include <common>
#include <fog_pars_fragment>
void main() {
  float dist = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float alpha = 1.0 - smoothstep(${TANK_NAV_LIGHT_EDGE.toFixed(2)}, 1.0, dist);
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(vColor, alpha);
  #include <fog_fragment>
}
`;

const TANK_WHEEL_OUTWARD_NUDGE = 0.02;

// The other half of the same flag: the eighth dimension is what a phasing tank
// sees of the building, and this is what everyone else sees of the tank. A tank
// half inside a wall is clipped flat at the wall's face and sprays white light
// out of the seam -- TankIDLSceneNode (TankSceneNode.cxx:567) and the clip plane
// beside it (Player.cxx:938-968), both driven by the same crossing plane.
//
// Upstream calls them interdimensional lights, which is `showIDL` in its own
// source, and the effect is not OO's alone: PZ crossing a teleporter gets it
// too, from the same branch.
//
// The silhouette is upstream's own table, not bzo's tank mesh. It is 40 vertices
// and 26 faces standing in for the body, turret, barrel and both treads, in
// upstream's tank-local frame -- x forward, y left, z up -- and in world units,
// which bzo shares (`_tankLength` 6.0, `_tankWidth` 2.8). bzo has several tank
// models where upstream has one, so a table that suits all of them roughly is
// worth more than a silhouette exact to one; it also caps the per-frame cost at
// something known, where the real meshes vary.
const TANK_IDL_VERTICES = new Float32Array([
  2.430, 0.877, 0.000,
  2.430, -0.877, 0.000,
  -2.835, 0.877, 1.238,
  -2.835, -0.877, 1.238,
  2.575, 0.877, 1.111,
  2.575, -0.877, 1.111,
  -2.229, -0.877, 0.000,
  -2.229, 0.877, 0.000,
  -1.370, 0.764, 2.050,
  -1.370, -0.765, 2.050,
  1.580, -0.434, 1.790,
  1.580, 0.435, 1.790,
  -0.456, -1.060, 1.040,
  -0.456, 1.080, 1.040,
  1.480, 0.516, 1.040,
  1.480, -0.516, 1.040,
  4.940, 0.047, 1.410,
  4.940, -0.079, 1.530,
  4.940, 0.047, 1.660,
  4.940, 0.173, 1.530,
  1.570, 0.047, 1.350,
  1.570, -0.133, 1.530,
  1.570, 0.047, 1.710,
  1.570, 0.227, 1.530,
  -2.229, 0.877, 0.000,
  2.730, 1.400, 1.294,
  2.597, 1.400, 0.000,
  -2.970, 1.400, 1.410,
  2.730, 0.877, 1.294,
  2.597, 0.877, 0.000,
  -2.970, 0.877, 1.410,
  -2.229, 1.400, 0.000,
  -2.229, -1.400, 0.000,
  2.730, -0.875, 1.294,
  2.597, -0.875, 0.000,
  -2.970, -0.875, 1.410,
  2.730, -1.400, 1.294,
  2.597, -1.400, 0.000,
  -2.970, -1.400, 1.410,
  -2.229, -0.875, 0.000,
]);
const TANK_IDL_FACES = [
  [1, 0, 4, 5],
  [5, 4, 2, 3],
  [3, 2, 7, 6],
  [6, 7, 0, 1],
  [12, 15, 10],
  [12, 10, 9],
  [13, 8, 11],
  [13, 11, 14],
  [15, 14, 11, 10],
  [10, 11, 8, 9],
  [9, 8, 13, 12],
  [21, 17, 18, 22],
  [22, 18, 19, 23],
  [23, 19, 16, 20],
  [20, 16, 17, 21],
  [17, 16, 19, 18],
  [29, 26, 25, 28],
  [28, 25, 27, 30],
  [30, 27, 31, 24],
  [24, 31, 26, 29],
  [25, 26, 31, 27],
  [37, 34, 33, 36],
  [36, 33, 35, 38],
  [38, 35, 39, 32],
  [32, 39, 34, 37],
  [37, 36, 38, 32],
];
// Alpha 0.75 at the seam, 0 at the tips: the light fades out rather than ending.
const TANK_IDL_INNER_ALPHA = 0.75;
// draw(): `dist = 2.0f + 0.3f * (rand - 0.5f)`, re-rolled per face per frame,
// which is what makes the lights flicker rather than sit still.
const TANK_IDL_PROJECT_DISTANCE = 2.0;
const TANK_IDL_PROJECT_JITTER = 0.3;
// The projection origin sits one tank length back from the plane, so the streaks
// fan rather than run parallel.
function tankIdlOriginSetback() {
  return TANK.length;
}
// Over the tank and the building both, being the seam between them.
const TANK_IDL_RENDER_ORDER = 7;
// Two triangles a face is the most a plane can cut from one, and the buffer is
// allocated once at that size rather than grown: 26 faces is 156 vertices.
const TANK_IDL_MAX_VERTICES = 26 * 6;
// A clip plane that cuts nothing, for a tank that has left the wall. Removing
// the plane instead would change the material's plane count and recompile every
// program the tank draws with -- on the way out, and again on the next wall.
const TANK_CLIP_DISABLED_CONSTANT = 1e6;

// Tank track marks. Upstream draws these last of the things that lie on the
// ground -- `renderGroundEffects` puts down the grid, the shadows and the
// receivers (`SceneRenderer.cxx:975`) and `doRender` lays the ground tracks over
// them (`SceneRenderer.cxx:1057`) -- so they take the next render order up, and
// `TRACK_HEIGHT_OFFSET` puts them on the next layer up as well.
//
// Upstream keeps two lists and draws them differently: ground marks with the
// depth test off, because it has to support a client with no depth buffer at
// all, and marks left on a roof with depth writes off so they do not fight the
// roof. WebGL always has the depth buffer, so one mesh with the writes off does
// for both -- each mark is already lifted clear of the surface it sits on, and
// the depth test is what stops a mark behind a building showing through it.
const TRACK_MARK_RENDER_ORDER = 22;
// A fixed budget rather than a growing one. A tank lays 20 marks a second and
// they last 3, so 60 entries covers one tank driving without pause and this
// covers eight of them; past that the oldest mark is dropped to make room, so a
// crowded map shortens every trail instead of costing the client anything. The
// pool is 124KB of vertex data whether it is used or not, which is what buys a
// mark that is written once when it is laid and never moved again -- and every
// upload is bounded by the marks that are alive, not by the size of the pool.
const TRACK_MARK_CAPACITY = 512;
// Two quads per entry, one per tread, four vertices each.
const TRACK_MARK_QUADS = 2;
const TRACK_MARK_VERTICES = TRACK_MARK_QUADS * 4;
const TRACK_MARK_INDICES = TRACK_MARK_QUADS * 6;

export class TankRendering {
  _computeMuzzleFromBarrel(barrel) {
    if (!barrel || !barrel.geometry) {
      return { forward: TANK.muzzleForward, height: TANK.muzzleHeight };
    }

    const position = barrel.geometry.getAttribute('position');
    if (!position || position.count === 0) {
      return { forward: TANK.muzzleForward, height: TANK.muzzleHeight };
    }

    // The barrel's tip is its furthest forward points, along the tank's +x.
    barrel.updateMatrix();
    const transformed = new THREE.Vector3();
    let maxX = Number.NEGATIVE_INFINITY;
    const points = [];

    for (let i = 0; i < position.count; i += 1) {
      transformed.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(barrel.matrix);
      points.push({ x: transformed.x, y: transformed.y, z: transformed.z });
      if (transformed.x > maxX) maxX = transformed.x;
    }

    const tipPoints = points.filter((point) => point.x >= (maxX - MUZZLE_TIP_EPSILON));
    if (tipPoints.length === 0) {
      return { forward: TANK.muzzleForward, height: TANK.muzzleHeight };
    }

    const avg = tipPoints.reduce((acc, point) => {
      acc.x += point.x;
      acc.z += point.z;
      return acc;
    }, { x: 0, z: 0 });

    const avgX = avg.x / tipPoints.length;
    const avgZ = avg.z / tipPoints.length;
    const forward = Number.isFinite(avgX)
      ? Math.min(maxMuzzleForward(), Math.max(0.5, avgX))
      : TANK.muzzleForward;
    const height = Number.isFinite(avgZ) ? avgZ : TANK.muzzleHeight;

    return { forward, height };
  }

  _setTankMuzzleData(tankGroup, barrel) {
    const muzzle = this._computeMuzzleFromBarrel(barrel);
    tankGroup.userData.muzzleForward = muzzle.forward;
    tankGroup.userData.muzzleHeight = muzzle.height;
    tankGroup.userData.cameraHeight = muzzle.height;
  }

  // The crossing-wall pair for one tank: `plane` is the wall it is straddling
  // as `{x, y, z, d}` with the normal pointing out of the building, or null when
  // it is not straddling one. Called every frame for a tank carrying a phasing
  // flag and never for any other, which is the same gate upstream's
  // `CrossingWall` status bit is.
  // `clip` false keeps the lights and skips the cut, which is upstream's
  // `if (!inCockpit) tankNode->setClipPlane(plane)` (Player.cxx:961-963):
  // the lights and the clip come from one plane in one `if` there, and the
  // tank you are driving gets the lights without the cut.
  setTankCrossingPlane(tank, plane, clip = true) {
    if (!tank?.userData) return;
    this._applyTankClipPlane(tank, clip ? plane : null);
    this._updateTankIDL(tank, plane);
  }

  // The tank is going away, so its lights have to go with it. They are parented
  // to the world group rather than to the tank -- a child would wear the tank's
  // landing squish and spawn scaling -- so nothing else detaches them, and a
  // tank that quits while inside a wall would otherwise leave a set of streaks
  // hanging in the building forever. `discardTank` is the one caller.
  dropTankCrossingEffect(tank) {
    const state = tank?.userData;
    if (!state) return;
    if (state.crossingIDLMesh) {
      this._clearObjectForRemoval(state.crossingIDLMesh);
      state.crossingIDLMesh = null;
    }
    // The plane object itself is only referenced by materials that are going
    // away with the tank, so dropping the reference is the whole of it.
    state.crossingClipPlane = null;
  }

  // Cut away the half of the tank inside the wall. Upstream's
  // `tankNode->setClipPlane(plane)`, and three.js keeps the side the normal
  // points to, which is why the plane is signed positive on the outside.
  _applyTankClipPlane(tank, plane) {
    const state = tank.userData;
    // The overwhelmingly common case: a tank that has never phased, not phasing
    // now. It must cost nothing, because this runs per tank per frame.
    if (!plane && !state.crossingClipPlane) return;
    if (!state.crossingClipPlane) {
      // First wall this tank has ever been half inside. Assigning the array
      // changes the material's clipping-plane count, which recompiles every
      // program it draws with -- so it is assigned once here and mutated from
      // then on, and it stays assigned when the tank leaves the wall holding a
      // plane that cuts nothing. Toggling it instead would recompile on the way
      // out and again on the next wall, which is the pattern `noteProgramCount`
      // was written to catch.
      state.crossingClipPlane = new THREE.Plane(
        new THREE.Vector3(0, 1, 0),
        TANK_CLIP_DISABLED_CONSTANT,
      );
      const planes = [state.crossingClipPlane];
      tank.traverse((child) => {
        if (!child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          material.clippingPlanes = planes;
          material.needsUpdate = true;
        }
      });
    }
    if (plane) {
      // three.js clips in its own world space, which is the game's frame
      // carried by the world groups -- a headset's walk and turn included.
      state.crossingClipPlane.normal.set(plane.x, plane.y, plane.z);
      state.crossingClipPlane.constant = plane.d;
      this.worldFrame.updateWorldMatrix(true, false);
      state.crossingClipPlane.applyMatrix4(this.worldFrame.matrixWorld);
    } else {
      state.crossingClipPlane.normal.set(0, 1, 0);
      state.crossingClipPlane.constant = TANK_CLIP_DISABLED_CONSTANT;
    }
  }

  // The lights themselves. Built in world space rather than in the tank's local
  // frame: the plane arrives in world space, bzo's tank models do not all share
  // a rest orientation, and a mesh at the origin with world-space vertices needs
  // no matrix of its own.
  _updateTankIDL(tank, plane) {
    const state = tank.userData;
    if (!plane) {
      // Detached rather than hidden, for `setInsideBuildings`' reason:
      // `updateMatrixWorld` walks a parented node whatever its visibility. The
      // mesh and its buffer stay on the tank, so re-entering a wall costs
      // nothing.
      state.crossingIDLMesh?.removeFromParent();
      return;
    }
    if (!state.crossingIDLMesh) state.crossingIDLMesh = this._createTankIDLMesh();
    const mesh = state.crossingIDLMesh;
    const written = this._fillTankIDLGeometry(mesh.geometry, tank, plane);
    if (written === 0) {
      // Straddling by the arithmetic, but no face actually cut: the tank is in
      // the wall's half-space without any of its silhouette crossing the plane.
      mesh.removeFromParent();
      return;
    }
    if (!mesh.parent) this.worldFrame.add(mesh);
  }

  _createTankIDLMesh() {
    const geometry = new THREE.BufferGeometry();
    // Allocated once at the worst case and re-filled in place. A geometry
    // rebuilt from new arrays every frame is a new buffer upload every frame,
    // and this runs while a tank is moving through a wall.
    geometry.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(TANK_IDL_MAX_VERTICES * 3), 3,
    ));
    // Four components, because the fade to nothing is in the alpha: the seam is
    // opaque white and the tips are transparent white.
    geometry.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(TANK_IDL_MAX_VERTICES * 4), 4,
    ));
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // `builder.disableCulling()` in the constructor: the streaks are seen from
      // both sides, and which side depends on where the viewer is standing.
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = TANK_IDL_RENDER_ORDER;
    // The vertices are already in world space, so the mesh sits at the origin
    // and never moves.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // Its bounds change every frame and the thing it is attached to is on
    // screen by definition -- a wall the viewer can see a tank inside of.
    mesh.frustumCulled = false;
    return this._tagDraws(mesh, 'effect');
  }

  // IDLRenderNode::render (TankSceneNode.cxx:637). For each face of the
  // silhouette, the two points where its edges cross the wall, and a streak from
  // those out to where they project. Returns how many vertices were written.
  _fillTankIDLGeometry(geometry, tank, plane) {
    const azimuth = tankAzimuth(tank);
    // The tank's own axes, so the silhouette can be placed without knowing
    // which way a given tank model faces at rest: forward along the azimuth,
    // left a quarter turn on.
    const forwardX = Math.cos(azimuth);
    const forwardY = Math.sin(azimuth);
    const leftX = 0 - forwardY;
    const leftY = forwardX;
    const originX = tank.position.x;
    const originY = tank.position.y;
    const originZ = tank.position.z;

    const positions = geometry.getAttribute('position');
    const colors = geometry.getAttribute('color');
    const positionArray = positions.array;
    const colorArray = colors.array;
    let vertexCount = 0;

    // One tank length in from the wall, which is where the streaks fan from.
    const projectOriginX = originX - plane.x * tankIdlOriginSetback();
    const projectOriginY = originY - plane.y * tankIdlOriginSetback();
    const projectOriginZ = originZ - plane.z * tankIdlOriginSetback();

    const cross = [0, 0, 0, 0, 0, 0];
    for (const face of TANK_IDL_FACES) {
      let crossings = 0;
      for (let i = 0, k = face.length - 1; i < face.length && crossings < 2; k = i, i += 1) {
        const worldK = this._tankIDLVertex(
          face[k], originX, originY, originZ, forwardX, forwardY, leftX, leftY, 0,
        );
        const worldI = this._tankIDLVertex(
          face[i], originX, originY, originZ, forwardX, forwardY, leftX, leftY, 1,
        );
        const dK = plane.x * worldK[0] + plane.y * worldK[1] + plane.z * worldK[2] + plane.d;
        const dI = plane.x * worldI[0] + plane.y * worldI[1] + plane.z * worldI[2] + plane.d;
        if ((dK < 0) === (dI < 0)) continue;
        // Where the edge meets the plane, which is what upstream interpolates
        // the same way.
        const fraction = dK / (dK - dI);
        const base = crossings * 3;
        cross[base] = worldK[0] + fraction * (worldI[0] - worldK[0]);
        cross[base + 1] = worldK[1] + fraction * (worldI[1] - worldK[1]);
        cross[base + 2] = worldK[2] + fraction * (worldI[2] - worldK[2]);
        crossings += 1;
      }
      // A face touched by the plane at one point or not at all has no seam to
      // draw, which is upstream's `if (crossings != 2) continue`.
      if (crossings !== 2) continue;

      const distance = TANK_IDL_PROJECT_DISTANCE
        + TANK_IDL_PROJECT_JITTER * (Math.random() - 0.5);
      const p0x = projectOriginX + distance * (cross[0] - projectOriginX);
      const p0y = projectOriginY + distance * (cross[1] - projectOriginY);
      const p0z = projectOriginZ + distance * (cross[2] - projectOriginZ);
      const p1x = projectOriginX + distance * (cross[3] - projectOriginX);
      const p1y = projectOriginY + distance * (cross[4] - projectOriginY);
      const p1z = projectOriginZ + distance * (cross[5] - projectOriginZ);

      // Upstream's four-point triangle strip, written as the two triangles it
      // stands for: seam, seam, tip and seam, tip, tip.
      const strip = [
        cross[0], cross[1], cross[2], TANK_IDL_INNER_ALPHA,
        cross[3], cross[4], cross[5], TANK_IDL_INNER_ALPHA,
        p0x, p0y, p0z, 0,
        cross[3], cross[4], cross[5], TANK_IDL_INNER_ALPHA,
        p0x, p0y, p0z, 0,
        p1x, p1y, p1z, 0,
      ];
      for (let i = 0; i < strip.length; i += 4) {
        const p = vertexCount * 3;
        const c = vertexCount * 4;
        positionArray[p] = strip[i];
        positionArray[p + 1] = strip[i + 1];
        positionArray[p + 2] = strip[i + 2];
        colorArray[c] = 1;
        colorArray[c + 1] = 1;
        colorArray[c + 2] = 1;
        colorArray[c + 3] = strip[i + 3];
        vertexCount += 1;
      }
    }

    geometry.setDrawRange(0, vertexCount);
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    return vertexCount;
  }

  // One silhouette vertex in world space. Two scratch slots rather than one, so
  // an edge's two ends can be held at once without allocating a pair of arrays
  // every edge of every face of every frame.
  _tankIDLVertex(index, originX, originY, originZ, forwardX, forwardY, leftX, leftY, slot) {
    const base = index * 3;
    const along = TANK_IDL_VERTICES[base];
    const across = TANK_IDL_VERTICES[base + 1];
    const up = TANK_IDL_VERTICES[base + 2];
    const out = slot === 0 ? this._tankIDLScratchA : this._tankIDLScratchB;
    out[0] = originX + forwardX * along + leftX * across;
    out[1] = originY + forwardY * along + leftY * across;
    out[2] = originZ + up;
    return out;
  }

  // An OBJ is not required to carry texture coordinates, and a model that
  // leaves them out draws every fragment from one texel: the tank comes out
  // flat team colour with none of the skin on it, which reads as a plastic toy
  // rather than armour. Upstream never has to answer this -- its one tank
  // carries hand-written texcoords in C++ -- but bzo draws whatever OBJ a
  // contributor names, so a model without UVs is given them here, once, when
  // its template loads rather than per tank built from it.
  //
  // A model that ships its own UVs keeps them: this only fills a gap.
  _generateMissingTankUVs(root) {
    const treadNames = new Set([
      ...TANK_PART_ALIASES.leftTreadMiddle, ...TANK_PART_ALIASES.rightTreadMiddle,
      ...TANK_PART_ALIASES.leftTreadFrontCap, ...TANK_PART_ALIASES.rightTreadFrontCap,
      ...TANK_PART_ALIASES.leftTreadRearCap, ...TANK_PART_ALIASES.rightTreadRearCap,
    ]);

    // The sphere is struck from the middle of the assembled tank, so every
    // part has to be measured where it actually sits.
    root.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());

    root.traverse((child) => {
      const geometry = child.isMesh ? child.geometry : null;
      if (!geometry || geometry.attributes.uv || !geometry.attributes.position) return;
      // Both projections read a triangle as three consecutive vertices, which
      // is what OBJLoader builds. An indexed geometry is left alone rather
      // than mapped wrongly.
      if (geometry.index) return;

      if (treadNames.has(child.name || '')) this._projectTankUVsAroundBelt(geometry);
      else this._projectTankUVsOnSphere(geometry, child.matrixWorld, center);
    });
  }

  // A `u` that runs once around the loop wraps from 1 back to 0 somewhere, and
  // the triangle that straddles the join would otherwise stretch the whole
  // texture backwards across itself. Carrying the low corners of that triangle
  // past 1 keeps it continuous, which RepeatWrapping then resolves.
  _healTankUVWrap(uv, vertexCount) {
    for (let triangle = 0; triangle < vertexCount; triangle += 3) {
      const u0 = uv[triangle * 2];
      const u1 = uv[(triangle + 1) * 2];
      const u2 = uv[(triangle + 2) * 2];
      const highest = Math.max(u0, u1, u2);
      if (highest - Math.min(u0, u1, u2) <= 0.5) continue;
      for (let corner = 0; corner < 3; corner += 1) {
        const slot = (triangle + corner) * 2;
        if (highest - uv[slot] > 0.5) uv[slot] += 1;
      }
    }
  }

  // Spherical, about the centre of the whole tank rather than of each part, so
  // the skin is one continuous wrap across hull, turret and barrel instead of
  // three mappings that meet at nothing. Vertices are lifted into the model's
  // own space first: a part may sit at an offset of its own, and projecting
  // from its local origin would slide its share of the skin off centre.
  //
  // A sphere stretches where the surface does not face outward from the
  // centre, most of all near the poles. On a camo skin that reads as the
  // pattern drifting rather than as a seam, which is the trade for having no
  // seam at all except the one meridian the wrap heals.
  _projectTankUVsOnSphere(geometry, matrix, center) {
    const position = geometry.attributes.position;
    const uv = new Float32Array(position.count * 2);
    const point = new THREE.Vector3();

    for (let vertex = 0; vertex < position.count; vertex += 1) {
      point.fromBufferAttribute(position, vertex).applyMatrix4(matrix).sub(center);
      const radius = point.length() || 1;
      uv[vertex * 2] = (Math.atan2(point.z, point.x) + Math.PI) / (Math.PI * 2);
      uv[vertex * 2 + 1] = 1 - (Math.acos(Math.min(1, Math.max(-1, point.y / radius))) / Math.PI);
    }
    this._healTankUVWrap(uv, position.count);

    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  // A track is a loop, and the animation scrolls `offset.x` to run the pattern
  // along it -- the same thing upstream does by translating the texture matrix.
  // So `u` has to advance once around the belt and `v` across its width. The
  // narrowest axis of the mesh is that width; the belt turns in the plane of
  // the other two.
  //
  // The angle is taken after dividing each loop axis by its own half extent. A
  // track is a long flat oval, and an angle measured on it raw would spend most
  // of its range rounding the two ends and hardly any along the straights,
  // bunching the tread pattern where the wheels are. Normalising first makes
  // the loop roughly circular, which spreads the pattern close to evenly.
  _projectTankUVsAroundBelt(geometry) {
    const position = geometry.attributes.position;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const size = new THREE.Vector3();
    box.getSize(size);

    const extents = [size.x, size.y, size.z];
    const mins = [box.min.x, box.min.y, box.min.z];
    const centers = [
      (box.min.x + box.max.x) * 0.5,
      (box.min.y + box.max.y) * 0.5,
      (box.min.z + box.max.z) * 0.5,
    ];
    const readers = [
      (vertex) => position.getX(vertex),
      (vertex) => position.getY(vertex),
      (vertex) => position.getZ(vertex),
    ];

    let widthAxis = 0;
    if (extents[1] < extents[widthAxis]) widthAxis = 1;
    if (extents[2] < extents[widthAxis]) widthAxis = 2;
    // The longer of the remaining two leads, so the angle sweeps along the
    // track rather than across it.
    const loopAxes = [0, 1, 2].filter((axis) => axis !== widthAxis)
      .sort((left, right) => extents[right] - extents[left]);
    const halfAlong = (extents[loopAxes[0]] * 0.5) || 1;
    const halfAcross = (extents[loopAxes[1]] * 0.5) || 1;
    const widthSpan = extents[widthAxis] || 1;

    // How many times the tread image goes round. One turn of the loop would
    // stretch a single tread pattern over the whole track, so the count comes
    // from the belt's own size: a longer track carries more links, each the
    // size the stock model's are, rather than the same few stretched further.
    const perimeter = Math.PI * ((3 * (halfAlong + halfAcross))
      - Math.sqrt(((3 * halfAlong) + halfAcross) * (halfAlong + (3 * halfAcross))));
    const tiles = Math.max(1, Math.round(perimeter / TREAD_UNITS_PER_TILE));

    const uv = new Float32Array(position.count * 2);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const along = (readers[loopAxes[0]](vertex) - centers[loopAxes[0]]) / halfAlong;
      const across = (readers[loopAxes[1]](vertex) - centers[loopAxes[1]]) / halfAcross;
      uv[vertex * 2] = (Math.atan2(across, along) + Math.PI) / (Math.PI * 2);
      uv[vertex * 2 + 1] = (readers[widthAxis](vertex) - mins[widthAxis]) / widthSpan;
    }
    // Healed while `u` is still one turn, so the seam test can recognise the
    // wrap; the repeats are laid on after, and scale the mended values with it.
    this._healTankUVWrap(uv, position.count);
    if (tiles > 1) {
      for (let vertex = 0; vertex < position.count; vertex += 1) uv[vertex * 2] *= tiles;
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  _preloadTankModel(modelPath = this._tankModelPath) {
    const loadPath = modelPath || '/obj/bzflag.obj';
    if (this._tankTemplateByPath.has(loadPath) || this._tankModelLoadsInFlight.has(loadPath)) {
      return;
    }

    const loader = new OBJLoader();
    this._tankModelLoadsInFlight.add(loadPath);
    const onLoad = (obj) => {
      this._generateMissingTankUVs(obj);
      // OBJLoader leaves every part at the identity, so turning the geometry
      // turns the model.
      obj.traverse((child) => {
        if (child.geometry) child.geometry.applyMatrix4(TANK_MODEL_TO_GAME);
      });
      const cache = {};
      obj.traverse((child) => {
        if (child.isMesh) cache[child.name] = child.geometry;
      });
      this._tankTemplateByPath.set(loadPath, obj);
      this._tankGeoCacheByPath.set(loadPath, cache);
      if (loadPath === this._tankModelPath) {
        this._tankTemplate = obj;
        this._tankGeoCache = cache;
      }
      const readyResolver = this._tankModelReadyResolversByPath.get(loadPath);
      if (readyResolver) {
        readyResolver.resolve(obj);
        this._tankModelReadyResolversByPath.delete(loadPath);
      }
      this._tankModelLoadsInFlight.delete(loadPath);
    };

    loader.load(loadPath, onLoad, undefined, () => {
      const readyResolver = this._tankModelReadyResolversByPath.get(loadPath);
      if (readyResolver) {
        readyResolver.reject(new Error(`Failed to load tank model: ${loadPath}`));
        this._tankModelReadyResolversByPath.delete(loadPath);
        this._tankModelReadyPromisesByPath.delete(loadPath);
      }
      this._tankModelLoadsInFlight.delete(loadPath);
      if (loadPath !== '/obj/simple.obj') {
        this._preloadTankModel('/obj/simple.obj');
      }
    });
  }

  setTankModel(modelPath = '/obj/bzflag.obj') {
    const normalizedPath = modelPath || '/obj/bzflag.obj';
    if (this._tankModelPath === normalizedPath && this._tankTemplateByPath.has(normalizedPath)) return;
    this._tankModelPath = normalizedPath;
    const template = this._tankTemplateByPath.get(normalizedPath) || null;
    const cache = this._tankGeoCacheByPath.get(normalizedPath) || null;
    this._tankTemplate = template;
    this._tankGeoCache = cache;
    this._preloadTankModel(normalizedPath);
  }

  preloadTankModel(modelPath) {
    this._preloadTankModel(modelPath);
  }

  whenTankModelReady(modelPath = this._tankModelPath) {
    const loadPath = modelPath || '/obj/bzflag.obj';
    if (this._tankTemplateByPath.has(loadPath)) {
      return Promise.resolve(this._tankTemplateByPath.get(loadPath));
    }

    if (!this._tankModelReadyPromisesByPath.has(loadPath)) {
      this._tankModelReadyPromisesByPath.set(loadPath, new Promise((resolve, reject) => {
        this._tankModelReadyResolversByPath.set(loadPath, { resolve, reject });
      }));
    }

    this._preloadTankModel(loadPath);
    return this._tankModelReadyPromisesByPath.get(loadPath);
  }

  _findTankTemplateMesh(name, modelPath = this._tankModelPath) {
    const template = this._tankTemplateByPath.get(modelPath);
    if (!template) return null;
    let found = null;
    template.traverse((child) => {
      if (!found && child.isMesh && child.name === name) {
        found = child;
      }
    });
    return found;
  }

  _findFirstTankTemplateMesh(names, modelPath = this._tankModelPath) {
    for (const name of names) {
      const mesh = this._findTankTemplateMesh(name, modelPath);
      if (mesh) return mesh;
    }
    return null;
  }

  // The part lookups above want a mesh, because a part that is not a mesh
  // cannot be drawn. A navigation light is the opposite case: it is a `p`
  // object, so OBJLoader builds it as `THREE.Points` and `isMesh` never sees
  // it. All that is wanted of it is where it sits, so any node carrying
  // vertices answers -- a single `p` vertex, or a marker the modeller built
  // out of faces, averaged to its own centre either way.
  _findTankTemplatePoint(names, modelPath = this._tankModelPath) {
    const template = this._tankTemplateByPath.get(modelPath);
    if (!template) return null;
    for (const name of names) {
      let found = null;
      template.traverse((child) => {
        if (!found && child.name === name && child.geometry?.attributes?.position?.count) {
          found = child.geometry.attributes.position;
        }
      });
      if (!found) continue;
      const centre = new THREE.Vector3();
      const vertex = new THREE.Vector3();
      for (let i = 0; i < found.count; i += 1) {
        centre.add(vertex.fromBufferAttribute(found, i));
      }
      return centre.divideScalar(found.count);
    }
    return null;
  }

  // One material for every tank on the map: the colours ride on the geometry,
  // so three points per tank cost one draw and nothing else.
  _getTankNavLightMaterial() {
    if (!this._tankNavLightMaterial) {
      this._tankNavLightMaterial = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          { bufferHeight: { value: TANK_NAV_LIGHT_REFERENCE_HEIGHT } },
        ]),
        vertexShader: TANK_NAV_LIGHT_VERTEX_SHADER,
        fragmentShader: TANK_NAV_LIGHT_FRAGMENT_SHADER,
        // The soft rim needs blending, and a dot this small has no depth worth
        // writing -- what matters is that the turret it sits on still hides it
        // from behind, which is depth *testing* and stays on.
        transparent: true,
        depthWrite: false,
        fog: true,
      });
      this._tankNavLightMaterial.userData.shared = true;
    }
    return this._tankNavLightMaterial;
  }

  // The buffer a given renderer is drawing into, so the tank preview's small
  // canvas is read as its own rather than the game's. A session states its
  // height on the base layer where the browser has one; where it draws through
  // a projection layer instead there is no base layer to ask, and the canvas
  // answers for it, Three having sized the canvas to the session's buffer.
  // Both are property reads, which is what lets this be asked per draw instead
  // of cached.
  _getNavLightBufferHeight(renderer) {
    const layer = renderer?.xr?.getSession?.()?.renderState?.baseLayer;
    if (layer?.framebufferHeight) return layer.framebufferHeight;
    return renderer?.getContext?.()?.drawingBufferHeight || TANK_NAV_LIGHT_REFERENCE_HEIGHT;
  }

  _buildTankNavLights(modelPath) {
    const positions = [];
    const colors = [];
    const colour = new THREE.Color();

    TANK_NAV_LIGHTS.forEach((light) => {
      const declared = this._findTankTemplatePoint(TANK_LIGHT_ALIASES[light.role], modelPath);
      if (declared) positions.push(declared.x, declared.y, declared.z);
      else positions.push(...light.position);
      colour.setHex(light.color);
      colors.push(colour.r, colour.g, colour.b);
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const lights = new THREE.Points(geometry, this._getTankNavLightMaterial());
    lights.name = TANK_NAV_LIGHTS_NAME;
    // One material is shared by every tank, and the tank preview draws its own
    // tank with a second `WebGLRenderer` on a canvas a fraction of the game's.
    // A height written once a frame would be whichever renderer wrote last, so
    // the point that is two pixels in the game came out the same two pixels in
    // a preview a quarter the size. Three calls this immediately before the
    // draw and hands over the renderer doing it, which is the only place that
    // knows.
    lights.onBeforeRender = (renderer) => {
      this._tankNavLightMaterial.uniforms.bufferHeight.value = this._getNavLightBufferHeight(renderer);
    };
    return lights;
  }

  // Upstream draws the lights with the turret and skips them in the shadow
  // pass and while a tank is exploding. A child of the turret gets the first
  // two for free -- it follows the turret wherever the turret goes, and
  // `THREE.Points` casts no shadow -- and the two places that deep-clone a
  // tank drop it, which gets the third.
  _stripTankNavLights(object) {
    const lights = object?.getObjectByName?.(TANK_NAV_LIGHTS_NAME);
    if (lights) lights.removeFromParent();
  }

  _cloneTemplateMesh(templateMesh, material) {
    let geometry = templateMesh.geometry;
    let resolvedMaterial = material;
    if (Array.isArray(material) && (!geometry.groups || geometry.groups.length === 0)) {
      if (material.length >= 6) {
        geometry = geometry.clone();
        geometry.clearGroups();

        const position = geometry.attributes.position;
        const index = geometry.index ? geometry.index.array : null;
        const triangleCount = index ? index.length / 3 : position.count / 3;

        const getVertex = (vertexIndex, target) => {
          target.set(
            position.getX(vertexIndex),
            position.getY(vertexIndex),
            position.getZ(vertexIndex),
          );
          return target;
        };

        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        const ab = new THREE.Vector3();
        const ac = new THREE.Vector3();
        const normal = new THREE.Vector3();

        // Which of the six materials each triangle wants, by the axis its
        // normal leans on: a face pointing up or down is the belt the tread
        // runs on, anything else is the side of it. The material slots keep
        // three.js's box order, where up is the third and down the fourth.
        const triangleMaterials = new Uint8Array(triangleCount);
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
          const base = triangleIndex * 3;
          const ia = index ? index[base] : base;
          const ib = index ? index[base + 1] : base + 1;
          const ic = index ? index[base + 2] : base + 2;

          getVertex(ia, a);
          getVertex(ib, b);
          getVertex(ic, c);

          ab.subVectors(b, a);
          ac.subVectors(c, a);
          normal.crossVectors(ab, ac).normalize();

          let materialIndex = 0;
          if (Math.abs(normal.z) >= Math.abs(normal.x) && Math.abs(normal.z) >= Math.abs(normal.y)) {
            materialIndex = normal.z >= 0 ? 2 : 3;
          }

          triangleMaterials[triangleIndex] = materialIndex;
        }

        // Three.js draws a group per call, so the triangles are gathered by
        // the material they picked and each material gets one group. A group
        // per triangle is what this did before, and it cost a draw call per
        // triangle -- nothing on a twelve-triangle tread, thousands on a
        // detailed one, and the frame rate went with it.
        //
        // The order lives in an index buffer rather than in the attributes:
        // the vertices do not move, only the order they are read in, and the
        // geometry here is the clone above so the template keeps its own.
        const materialCount = material.length;
        const runStarts = new Uint32Array(materialCount + 1);
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
          runStarts[triangleMaterials[triangleIndex] + 1] += 1;
        }
        for (let materialIndex = 0; materialIndex < materialCount; materialIndex += 1) {
          const runLength = runStarts[materialIndex + 1];
          runStarts[materialIndex + 1] = runStarts[materialIndex] + runLength;
          if (runLength > 0) geometry.addGroup(runStarts[materialIndex] * 3, runLength * 3, materialIndex);
        }

        const vertexCount = position.count;
        const ordered = vertexCount > 65535
          ? new Uint32Array(triangleCount * 3)
          : new Uint16Array(triangleCount * 3);
        const cursors = runStarts.slice(0, materialCount);
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
          const base = triangleIndex * 3;
          const slot = cursors[triangleMaterials[triangleIndex]] * 3;
          cursors[triangleMaterials[triangleIndex]] += 1;
          ordered[slot] = index ? index[base] : base;
          ordered[slot + 1] = index ? index[base + 1] : base + 1;
          ordered[slot + 2] = index ? index[base + 2] : base + 2;
        }
        geometry.setIndex(new THREE.BufferAttribute(ordered, 1));
      } else {
        resolvedMaterial = material[0];
      }
    }
    const mesh = new THREE.Mesh(geometry, resolvedMaterial);
    mesh.name = templateMesh.name;
    mesh.position.copy(templateMesh.position);
    mesh.rotation.copy(templateMesh.rotation);
    mesh.scale.copy(templateMesh.scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  _nudgeWheelMeshOutward(mesh, directionHint = 0) {
    if (!mesh || !mesh.geometry) return;

    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }

    // Outward is along the tank's y: +y to port, -y to starboard.
    const box = mesh.geometry.boundingBox;
    const centerY = box ? (box.min.y + box.max.y) * 0.5 : 0;
    const direction = directionHint || Math.sign(centerY);
    if (!direction) return;

    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.translate(0, direction * TANK_WHEEL_OUTWARD_NUDGE, 0);
  }

  _getTemplateMeshesByPrefix(prefix, modelPath = this._tankModelPath) {
    const template = this._tankTemplateByPath.get(modelPath);
    if (!template) return [];
    const meshes = [];
    template.traverse((child) => {
      if (child.isMesh && child.name && child.name.startsWith(prefix)) {
        meshes.push(child);
      }
    });
    meshes.sort((a, b) => {
      const ai = parseInt(a.name.slice(prefix.length), 10);
      const bi = parseInt(b.name.slice(prefix.length), 10);
      const aNum = Number.isFinite(ai) ? ai : 0;
      const bNum = Number.isFinite(bi) ? bi : 0;
      return aNum - bNum;
    });
    return meshes;
  }

  _getTemplateMeshesByPrefixes(prefixes, modelPath = this._tankModelPath) {
    const seen = new Set();
    const meshes = [];

    prefixes.forEach((prefix) => {
      this._getTemplateMeshesByPrefix(prefix, modelPath).forEach((mesh) => {
        if (seen.has(mesh.uuid)) return;
        seen.add(mesh.uuid);
        meshes.push(mesh);
      });
    });

    meshes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return meshes;
  }

  // One tread group -- the middle band plus the front and rear caps. The two
  // sides differ only in which template meshes they clone, so they share the
  // build; the cloned textures come back for updateTreads to scroll.
  _buildTreadGroup(parts, { treadTexture, treadTextureRotated, treadCapMat, treadCapMatSide }) {
    const repeating = (source) => {
      const texture = source.clone();
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      return texture;
    };

    const group = new THREE.Group();
    const textures = [];

    // A tread that is one casing rather than a band with two caps bolted on.
    // `ltread`/`rtread` alias to all three roles in TANK_PART_ALIASES, so all
    // three resolve to the same mesh -- which is the signal, and also the
    // reason this cannot simply fall through: cloning that one mesh three
    // times would draw the whole casing three times over, once wearing each of
    // the three materials.
    //
    // This is what upstream's medium and low tanks are. They have no animated
    // tread at all: `partFunctions` fills their LeftCasing and RightCasing
    // from medium_ltread.cxx and low_ltread.cxx, and the animated belt is high
    // geometry that upstream only builds when animatedTreads is on. The two
    // material groups come from the extractor -- the belt first, then the side
    // plates -- so the pattern runs along the track and the flat sides take
    // the tread's end texture, which nothing scrolls.
    if (parts.middle && parts.middle === parts.frontCap) {
      const beltTexture = repeating(treadTextureRotated);
      const beltMaterial = new THREE.MeshLambertMaterial({ map: beltTexture });
      group.add(this._cloneTemplateMesh(parts.middle, [beltMaterial, treadCapMatSide]));
      textures.push(beltTexture);
      return { group, textures };
    }

    const middleTexture = repeating(treadTextureRotated);
    const middleMaterial = new THREE.MeshLambertMaterial({ map: middleTexture });
    group.add(this._cloneTemplateMesh(parts.middle, [
      treadCapMatSide,
      treadCapMatSide,
      middleMaterial,
      middleMaterial,
      treadCapMatSide,
      treadCapMatSide,
    ]));
    textures.push(middleTexture);

    const capGroups = parts.frontCap.geometry.groups.length;
    for (const capPart of [parts.frontCap, parts.rearCap]) {
      const capTexture = repeating(treadTexture);
      const capMaterial = new THREE.MeshLambertMaterial({ map: capTexture });
      group.add(this._cloneTemplateMesh(
        capPart,
        capGroups === 2
          ? [capMaterial, treadCapMat]
          : [capMaterial, treadCapMat, treadCapMat],
      ));
      textures.push(capTexture);
    }

    return { group, textures };
  }

  // The wheels on one side, each offset around its own texture so they do not
  // turn in lockstep. The sides differ only in which way the mesh is nudged
  // clear of the body.
  _buildWheels(templateWheels, outwardDirection) {
    const wheels = [];
    const faceTextures = [];
    const sideTextures = [];

    templateWheels.forEach((templateWheel, index) => {
      const sideTexture = this._createWheelTexture();
      const faceTexture = this._createWheelTreadTexture();
      faceTexture.rotation = (index * 0.17) * Math.PI * 2;
      faceTexture.center.set(0.5, 0.5);
      faceTexture.needsUpdate = true;
      sideTexture.offset.x = index * 0.17;
      sideTexture.needsUpdate = true;

      const wheel = this._cloneTemplateMesh(templateWheel, [
        new THREE.MeshLambertMaterial({ map: sideTexture }),
        new THREE.MeshLambertMaterial({ map: faceTexture }),
        new THREE.MeshLambertMaterial({ map: faceTexture }),
      ]);
      this._nudgeWheelMeshOutward(wheel, outwardDirection);

      wheels.push(wheel);
      faceTextures.push(faceTexture);
      sideTextures.push(sideTexture);
    });

    return { wheels, faceTextures, sideTextures };
  }

  // Named once per model, not once per tank: every player wearing the model
  // asks for the same build, and a message per tank per rebuild would bury the
  // one line that says which file to rename. The names come from the shared
  // contract, so the line reads as the roles docs/tank-model-format.md lists.
  _reportUnbuildableTankModel(modelPath) {
    if (this._reportedUnbuildableTankModels.has(modelPath)) return;
    this._reportedUnbuildableTankModels.add(modelPath);
    const template = this._tankTemplateByPath.get(modelPath);
    const names = [];
    if (template) template.traverse((child) => { if (child.isMesh && child.name) names.push(child.name); });
    console.error(`Tank model ${modelPath} cannot be built: no ${missingTankParts(names).join(', no ')}.`
      + ' See docs/tank-model-format.md for the object names a model must carry.');
  }

  _createTankFromTemplate(color = 0x4caf50, name = '', modelPath = this._tankModelPath, options = {}) {
    const template = this._tankTemplateByPath.get(modelPath);
    if (!template) {
      this._preloadTankModel(modelPath);
      return null;
    }

    const templateParts = {
      body: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.body, modelPath),
      leftTreadMiddle: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.leftTreadMiddle, modelPath),
      leftTreadFrontCap: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.leftTreadFrontCap, modelPath),
      leftTreadRearCap: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.leftTreadRearCap, modelPath),
      rightTreadMiddle: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.rightTreadMiddle, modelPath),
      rightTreadFrontCap: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.rightTreadFrontCap, modelPath),
      rightTreadRearCap: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.rightTreadRearCap, modelPath),
      turret: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.turret, modelPath),
      barrel: this._findFirstTankTemplateMesh(TANK_PART_ALIASES.barrel, modelPath),
    };
    const leftWheelParts = this._getTemplateMeshesByPrefixes(TANK_WHEEL_PREFIX_ALIASES.left, modelPath);
    const rightWheelParts = this._getTemplateMeshesByPrefixes(TANK_WHEEL_PREFIX_ALIASES.right, modelPath);

    const hasLeftTread = !!(templateParts.leftTreadMiddle && templateParts.leftTreadFrontCap && templateParts.leftTreadRearCap);
    const hasRightTread = !!(templateParts.rightTreadMiddle && templateParts.rightTreadFrontCap && templateParts.rightTreadRearCap);
    const hasWheelPairs = leftWheelParts.length > 0 && rightWheelParts.length > 0;

    if (!templateParts.body || !templateParts.turret || !templateParts.barrel
      || ((!hasLeftTread || !hasRightTread) && !hasWheelPairs)) {
      this._reportUnbuildableTankModel(modelPath);
      return null;
    }

    const tankGroup = this._tagDraws(new THREE.Group(), 'tank');

    if (name) {
      const spriteMaterial = new THREE.SpriteMaterial({ ...LABEL_MATERIAL_DEPTH });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(0, 0, 3);
      sprite.scale.set(2, 0.5, 1);
      tankGroup.add(sprite);
      tankGroup.userData.nameLabel = sprite;
      this.updateSpriteLabel(sprite, name, color);
    }

    const bodyTexture = this._createTankTexture(color, options);
    const treadTexture = this._createTreadTexture();
    const treadTextureRotated = treadTexture.clone();
    treadTextureRotated.rotation = Math.PI / 2;
    treadTextureRotated.center.set(0.5, 0.5);
    treadTextureRotated.needsUpdate = true;
    const treadCapTexture = this._createTreadCapTexture(color, options);

    const treadCapTextureSide = treadCapTexture.clone();
    treadCapTextureSide.repeat.set(3.0, 1.0);
    treadCapTextureSide.wrapS = THREE.RepeatWrapping;
    treadCapTextureSide.wrapT = THREE.RepeatWrapping;
    treadCapTextureSide.needsUpdate = true;

    const bodyMaterial = new THREE.MeshLambertMaterial({ map: bodyTexture });
    const body = this._cloneTemplateMesh(templateParts.body, bodyMaterial);
    tankGroup.add(body);
    tankGroup.userData.body = body;

    const treadMaterials = {
      treadTexture,
      treadTextureRotated,
      treadCapMat: new THREE.MeshLambertMaterial({ map: treadCapTexture }),
      treadCapMatSide: new THREE.MeshLambertMaterial({ map: treadCapTextureSide }),
    };
    const leftTread = hasLeftTread ? this._buildTreadGroup({
      middle: templateParts.leftTreadMiddle,
      frontCap: templateParts.leftTreadFrontCap,
      rearCap: templateParts.leftTreadRearCap,
    }, treadMaterials) : null;
    const rightTread = hasRightTread ? this._buildTreadGroup({
      middle: templateParts.rightTreadMiddle,
      frontCap: templateParts.rightTreadFrontCap,
      rearCap: templateParts.rightTreadRearCap,
    }, treadMaterials) : null;

    // What `recolorTank` repaints: the materials a colour reaches.
    tankGroup.userData.colorMaterials = {
      body: [bodyMaterial],
      treadCap: treadMaterials.treadCapMat,
      treadCapSide: treadMaterials.treadCapMatSide,
    };
    tankGroup.userData.leftTreadTextures = leftTread ? leftTread.textures : [];
    tankGroup.userData.rightTreadTextures = rightTread ? rightTread.textures : [];

    const leftWheels = this._buildWheels(leftWheelParts, 1);
    const rightWheels = this._buildWheels(rightWheelParts, -1);
    [...leftWheels.wheels, ...rightWheels.wheels].forEach((wheel) => tankGroup.add(wheel));

    tankGroup.userData.leftWheels = leftWheels.wheels;
    tankGroup.userData.rightWheels = rightWheels.wheels;
    tankGroup.userData.leftWheelTextures = leftWheels.faceTextures;
    tankGroup.userData.rightWheelTextures = rightWheels.faceTextures;
    tankGroup.userData.leftWheelSideTextures = leftWheels.sideTextures;
    tankGroup.userData.rightWheelSideTextures = rightWheels.sideTextures;

    const sampleWheel = tankGroup.userData.leftWheels[0] || tankGroup.userData.rightWheels[0];
    if (sampleWheel && sampleWheel.geometry) {
      if (!sampleWheel.geometry.boundingBox) sampleWheel.geometry.computeBoundingBox();
      const box = sampleWheel.geometry.boundingBox;
      const radiusX = (box.max.x - box.min.x) * 0.5;
      const radiusZ = (box.max.z - box.min.z) * 0.5;
      tankGroup.userData.wheelRadius = Math.max(0.05, Math.max(radiusX, radiusZ));
    } else {
      tankGroup.userData.wheelRadius = 0.42;
    }

    tankGroup.userData.treadGroups = [leftTread?.group, rightTread?.group].filter(Boolean);
    tankGroup.userData.treadGroups.forEach((group) => tankGroup.add(group));

    // The body's texture on the turret's own coordinates, unscaled, as
    // upstream draws it: `setupTextureMatrix` (TankSceneNode.cxx) moves only
    // the treads and wheels.
    const turretMaterial = new THREE.MeshLambertMaterial({ map: bodyTexture });
    tankGroup.userData.colorMaterials.body.push(turretMaterial);
    const turret = this._cloneTemplateMesh(templateParts.turret, turretMaterial);
    tankGroup.add(turret);
    tankGroup.userData.turret = turret;

    const navLights = this._buildTankNavLights(modelPath);
    turret.add(navLights);
    tankGroup.userData.navLights = navLights;

    const barrelMaterial = new THREE.MeshLambertMaterial({ color: 0x333333 });
    const barrel = this._cloneTemplateMesh(templateParts.barrel, barrelMaterial);
    tankGroup.add(barrel);
    tankGroup.userData.barrel = barrel;
    this._setTankMuzzleData(tankGroup, barrel);

    tankGroup.userData.explodableParts = [
      body,
      turret,
      barrel,
      ...tankGroup.userData.treadGroups,
      ...tankGroup.userData.leftWheels,
      ...tankGroup.userData.rightWheels,
    ];

    return tankGroup;
  }

  // A tank is the OBJ file it came from and nothing else. A model that will
  // not build is an error rather than something to stand a generic tank in
  // for: a substitute reports the model as working and leaves the fault to be
  // found in play, where an unfamiliar tank shape is the last thing anyone
  // reads as a broken asset. The server keeps an unbuildable model out of the
  // picker in the first place (`getAvailableTankModels`), so a null here is a
  // model that passed that check and then failed to load.
  createTank(color = 0x4caf50, name = '', modelPath = this._tankModelPath, options = {}) {
    const tank = this._createTankFromTemplate(color, name, modelPath, options);
    if (!tank) return null;
    tank.userData.modelPath = modelPath;
    tank.userData.ownedResources = this._tankOwnedResources(tank, modelPath);
    return tank;
  }

  // What a tank was built with that is its alone: every texture and material
  // made for it -- body, treads, caps, wheels, label -- and each geometry that
  // is not the model's own, which every tank shares. A shared material is
  // left out, and so is anything added to the tank later.
  _tankOwnedResources(tank, modelPath) {
    const templateGeometries = new Set();
    this._tankTemplateByPath.get(modelPath)?.traverse((node) => {
      if (node.geometry) templateGeometries.add(node.geometry);
    });
    const owned = { geometries: new Set(), materials: new Set(), textures: new Set() };
    tank.traverse((node) => {
      if (node.geometry && !templateGeometries.has(node.geometry)) owned.geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!material || material.userData?.shared) continue;
        owned.materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) owned.textures.add(value);
      }
    });
    // Kept on the tank but not on any mesh: the wheels' textures for each
    // face are swapped in as they turn.
    for (const key of ['leftWheelTextures', 'rightWheelTextures', 'leftWheelSideTextures', 'rightWheelSideTextures']) {
      for (const texture of tank.userData[key] || []) if (texture?.isTexture) owned.textures.add(texture);
    }
    return owned;
  }

  // A tank in a new colour, rogue look or skin, on the tank it already is:
  // the colour is in the body's texture and the tread caps' and nothing else
  // (the label is the caller's), so those two are painted again and swapped
  // in and the old ones let go -- where a rebuild makes every texture, wheels
  // and treads included, and every geometry, again. A disguise flag repaints
  // every tank in sight.
  recolorTank(tank, color, options = {}) {
    const materials = tank?.userData?.colorMaterials;
    if (!materials) return false;
    const owned = tank.userData.ownedResources;
    const swap = (material, texture) => {
      const old = material.map;
      material.map = texture;
      material.needsUpdate = true;
      if (old && old !== texture && owned?.textures.delete(old)) old.dispose();
      owned?.textures.add(texture);
    };
    const body = this._createTankTexture(color, options);
    materials.body.forEach((material) => swap(material, body));
    const cap = this._createTreadCapTexture(color, options);
    const side = cap.clone();
    side.repeat.set(3.0, 1.0);
    side.wrapS = THREE.RepeatWrapping;
    side.wrapT = THREE.RepeatWrapping;
    side.needsUpdate = true;
    swap(materials.treadCap, cap);
    swap(materials.treadCapSide, side);
    return true;
  }

  // A tank let go of for good (`discardTank`): what `_tankOwnedResources`
  // says it was built with, disposed. Its debris, still flying, shares the
  // geometry and textures, and three uploads them again for as long as it does.
  disposeTank(tank) {
    const owned = tank?.userData?.ownedResources;
    if (!owned) return;
    tank.userData.ownedResources = null;
    owned.geometries.forEach((geometry) => geometry.dispose());
    owned.materials.forEach((material) => material.dispose());
    owned.textures.forEach((texture) => texture.dispose());
  }

  createGhostMesh(tank) {
    // Create a semi-transparent ghost version of a tank for showing server-confirmed position
    const ghostTank = tank.clone(true); // Deep clone the tank
    this._stripTankNavLights(ghostTank);

    // A clone carries the original's userData, so without this a ghost counts
    // as a tank and debug geometry silently doubles what the tanks appear to
    // cost. It is a whole tank's worth of draws, so it is worth seeing on its
    // own.
    this._tagDraws(ghostTank, 'debug');

    // Rebind name label after clone: Object3D clone serializes userData and can
    // drop direct object references like userData.nameLabel.
    ghostTank.userData.nameLabel = null;
    ghostTank.traverse((child) => {
      if (!ghostTank.userData.nameLabel && child.isSprite) {
        ghostTank.userData.nameLabel = child;
      }
    });

    // Scale slightly larger to wrap around the tank. The dimension flags
    // scale it further from client.js, since the ghost is not a child of the
    // tank and does not inherit the tank's own scaling.
    ghostTank.scale.set(GHOST_SCALE, GHOST_SCALE, GHOST_SCALE);

    ghostTank.traverse((child) => {
      if (child.isMesh && child.material) {
        // Clone materials to avoid shared references
        if (Array.isArray(child.material)) {
          child.material = child.material.map(mat => {
            const cloned = mat.clone();
            cloned.transparent = true;
            cloned.opacity = GHOST_ALPHA_SCALE;
            cloned.color.setHex(0xffffff);
            cloned.emissive.setHex(0x404040);
            cloned.emissiveIntensity = 0.2;
            return cloned;
          });
        } else {
          child.material = child.material.clone();
          child.material.transparent = true;
          child.material.opacity = GHOST_ALPHA_SCALE;
          child.material.color.setHex(0xffffff);
          child.material.emissive.setHex(0x404040);
          child.material.emissiveIntensity = 0.2;
        }
      } else if (child.isSprite && child.material) {
        // Make sprite label (name) transparent to match ghost opacity
        child.material = child.material.clone();
        child.material.opacity = GHOST_ALPHA_SCALE;
        child.material.transparent = true;
        // The ghost's copy sits a hair outside the tank's own label and says
        // the same thing. Only one of the two should be writing depth, or they
        // take turns rejecting each other's pixels.
        child.material.depthWrite = false;
      }
    });
    return ghostTank;
  }

  // A label keeps one canvas and one texture for the life of its sprite, and
  // repaints in place only when what it says changes. The packet motion gizmo
  // relabels itself on every movement packet, and a replaced CanvasTexture that
  // nobody disposes holds its GPU texture for the life of the page -- which is
  // a leak that grows with how fast the tank is driven.
  updateSpriteLabel(sprite, name, color = '#4CAF50') {
    if (!sprite) return;
    // Convert numeric color to hex string if needed
    let cssColor = color;
    if (typeof color === 'number') {
      cssColor = '#' + color.toString(16).padStart(6, '0');
    }

    const labelKey = `${name}|${cssColor}`;
    if (sprite.userData.labelKey === labelKey && sprite.material.map) return;
    sprite.userData.labelKey = labelKey;

    const FONT = 'bold 36px Arial';
    const DEFAULT_WIDTH = 256;
    const MAX_WIDTH = 1024;
    const HORIZONTAL_PADDING = 24;

    if (!sprite.material.map) {
      const canvas = document.createElement('canvas');
      canvas.width = DEFAULT_WIDTH;
      canvas.height = 64;
      sprite.material.map = new THREE.CanvasTexture(canvas);
      sprite.material.needsUpdate = true;
      // The width-to-world-unit ratio the caller chose (an obstacle or a
      // flag wears its label wider than a tank wears its callsign) --
      // captured once, from the scale already set before this first call,
      // so a name longer than fits at that width grows the sprite to match
      // rather than squeezing into it. `Watchtower#0:Base` needs to read at
      // the same size as `B3`, not smaller.
      sprite.userData.unitsPerPixel = sprite.scale.x / canvas.width;
      // A tank's label counters the tank's own scale each frame (see
      // updateTankDimensions in client.js) so Tiny/Narrow/Obesity/spawn-grow
      // stretch the tank without stretching its nametag. That needs the
      // label's intended size independent of whatever the counter-scaling
      // last wrote into sprite.scale.
      sprite.userData.baseScaleY = sprite.scale.y;
    }

    const texture = sprite.material.map;
    const canvas = texture.image;
    const context = canvas.getContext('2d');
    context.font = FONT;
    const measuredWidth = Math.ceil(context.measureText(name).width) + HORIZONTAL_PADDING * 2;
    const width = Math.min(MAX_WIDTH, Math.max(DEFAULT_WIDTH, measuredWidth));
    if (canvas.width !== width) {
      canvas.width = width; // resizing clears the canvas and resets context state
      context.font = FONT;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = cssColor;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(name, canvas.width / 2, canvas.height / 2, width - HORIZONTAL_PADDING * 2);
    texture.needsUpdate = true;
    sprite.scale.x = canvas.width * sprite.userData.unitsPerPixel;
    sprite.userData.baseScaleX = sprite.scale.x;
  }

  _getSharedImage(path) {
    if (!this._imageCache) {
      this._imageCache = new Map();
    }

    let entry = this._imageCache.get(path);
    if (!entry) {
      const image = document.createElement('img');
      entry = {
        image,
        loaded: false,
        listeners: [],
        error: null,
      };
      image.onload = () => {
        entry.loaded = true;
        const listeners = entry.listeners.splice(0);
        listeners.forEach((listener) => {
          try {
            listener(image);
          } catch (error) {
            console.error('Failed to update texture from image:', error);
          }
        });
      };
      image.onerror = () => {
        entry.error = new Error(`Failed to load image: ${path}`);
        // Said out loud, because the fallbacks behind this are silent and look
        // like a rendering bug rather than a missing file: `_createTreadTexture`
        // fills `#2b2b2b` when its source has not loaded, which reads as black
        // treads on a lit tank. `docs/audio.md` already refuses fallbacks for a
        // missing sample for exactly this reason -- "a failed load is a broken
        // build and should surface as an error" -- and a texture that quietly
        // goes grey is the same failure without the evidence.
        this.debugLog?.(`renderer.imageLoadFailed path=${path}`, 'render');
        const listeners = entry.listeners.splice(0);
        listeners.forEach((listener) => {
          try {
            listener(null, entry.error);
          } catch (error) {
            console.error('Failed to propagate image load error:', error);
          }
        });
      };
      image.src = path;
      this._imageCache.set(path, entry);
    }

    return entry;
  }

  _createCanvasBackedImageTexture(width, height, drawWhenReady) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;

    const redraw = () => {
      const ctx = canvas.getContext('2d');
      drawWhenReady(ctx, canvas, texture);
      texture.needsUpdate = true;
    };

    redraw();
    return { canvas, texture, redraw };
  }

  preloadImage(path) {
    const entry = this._getSharedImage(path);
    if (entry.loaded) {
      return Promise.resolve(entry.image);
    }
    if (entry.error) {
      return Promise.reject(entry.error);
    }
    if (!entry.promise) {
      entry.promise = new Promise((resolve, reject) => {
        entry.listeners.push((image, error) => {
          if (error) reject(error);
          else resolve(image);
        });
      });
    }
    return entry.promise;
  }

  // Tint a BZFlag source texture into a canvas-backed texture. The image may
  // still be loading, so the painter runs once now and again when it arrives.
  _createTintedTexture(path, width, height, paint, baseColor, { srgb = true } = {}) {
    const source = this._getSharedImage(path);
    const { texture, redraw } = this._createCanvasBackedImageTexture(width, height, (ctx, canvas) => {
      paint.call(this, ctx, canvas, source.loaded ? source.image : null, baseColor);
    });
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace;

    if (!source.loaded) {
      source.listeners.push(redraw);
    }

    return texture;
  }

  // The camo source, read once and kept as a palette rather than as pixels.
  //
  // A tank is rebuilt whenever its effective colour changes -- picking up
  // Masquerade or Colourblindness does it, and so does every join -- and the
  // source is only ever 128x128 with well under 256 distinct colours in it,
  // because it was painted as flat camo patches with antialiased edges. So the
  // conversion runs over the palette and the pixels are filled by index: a
  // rebuild costs one HSV round trip per distinct colour instead of one per
  // texel. That matters on the low-powered clients bzo targets, where the main
  // thread is the budget.
  //
  // `hue` is each entry's offset from the source's own average hue rather than
  // its absolute hue, so painting only has to add the player's. The average is
  // weighted by saturation: a grey texel has no hue worth averaging in, and
  // letting it vote would drag the reference towards whatever rounding left
  // behind in it.
  _getCamoSource(path, image) {
    if (!this._camoSources) this._camoSources = new Map();
    const cached = this._camoSources.get(path);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const texels = canvas.width * canvas.height;
    const indices = new Uint16Array(texels);
    const byColor = new Map();
    const hue = [];
    const saturation = [];
    const value = [];
    // How many texels each palette entry covers, so the reference hue is the
    // average of the picture rather than of its colour list -- a colour on one
    // antialiased edge would otherwise weigh as much as the body of the tank.
    const coverage = [];

    for (let i = 0, texel = 0; texel < texels; i += 4, texel += 1) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      let index = byColor.get(key);
      if (index === undefined) {
        index = hue.length;
        byColor.set(key, index);
        const hsv = rgbToHsv(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
        hue.push(hsv.h);
        saturation.push(hsv.s);
        value.push(hsv.v);
        coverage.push(0);
      }
      indices[texel] = index;
      coverage[index] += 1;
    }

    const reference = referenceHue(hue, saturation, coverage);
    const source = {
      width: canvas.width,
      height: canvas.height,
      indices,
      // Signed, so a patch painted above the reference hue stays above the
      // player's and one painted below stays below.
      hueOffset: Float32Array.from(hue, (h) => wrapSignedTurns(h - reference)),
      hue: Float32Array.from(hue),
      saturation: Float32Array.from(saturation),
      value: Float32Array.from(value),
      rgb: new Uint8ClampedArray(hue.length * 3),
    };
    this._camoSources.set(path, source);
    return source;
  }

  _paintCamoTankTexture(ctx, canvas, image, baseColor, options = {}) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!image) {
      ctx.fillStyle = '#777777';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const source = this._getCamoSource(options.texture, image);
    const base = new THREE.Color(baseColor);
    const player = rgbToHsv(base.r, base.g, base.b);

    // A rogue is drained and darkened rather than given a pattern of its own,
    // so its camo still falls in the same places as everyone else's.
    const palette = source.rgb;
    const { teamHsv } = options;
    for (let i = 0; i < source.hueOffset.length; i += 1) {
      const rgb = teamHsv
        ? teamShadeColor(source.hue[i], source.saturation[i], source.value[i], options.playerHsv, teamHsv)
        : camoColor(source.hueOffset[i], source.saturation[i], source.value[i], player, options.rogue);
      palette[i * 3] = rgb.r * 255;
      palette[(i * 3) + 1] = rgb.g * 255;
      palette[(i * 3) + 2] = rgb.b * 255;
    }

    const imageData = ctx.createImageData(canvas.width, canvas.height);
    const out = imageData.data;
    const { indices } = source;
    for (let texel = 0, i = 0; texel < indices.length; texel += 1, i += 4) {
      const entry = indices[texel] * 3;
      out[i] = palette[entry];
      out[i + 1] = palette[entry + 1];
      out[i + 2] = palette[entry + 2];
      out[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // `options.skin` is a tank-skins.mjs entry (the standard camo with none), and
  // `options.team` the team the tank is drawn as. A shade of a team upstream
  // paints a tank for (not observer or Map Viewer) wears the
  // team's own file, moved by its distance from `options.teamColor`; any other
  // colour has the blue file repainted for it.
  _createTankTexture(baseColor, options = {}) {
    const skin = options.skin || getTankSkin();
    let texture = getTankSkinTexture(skin);
    let teamHsv = null;
    let playerHsv = null;
    // In the file's own sRGB, not THREE's linear working space: the team's
    // file is moved by the ratio of the two colours, and a ratio taken in
    // linear light roughly doubles every step between shades.
    const srgbHsv = (hex) => rgbToHsv(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
    if (TANK_SKIN_TEAMS.includes(options.team) && Number.isFinite(options.teamColor) && Number.isFinite(baseColor)) {
      const candidate = srgbHsv(options.teamColor);
      const player = srgbHsv(baseColor);
      if (isTeamShade(player, candidate)) {
        texture = getTankSkinTexture(skin, options.team);
        teamHsv = candidate;
        playerHsv = player;
      }
    }
    const paintOptions = { ...options, texture, teamHsv, playerHsv };
    const size = skin.size;
    return this._createTintedTexture(
      texture, size, size,
      function paint(ctx, canvas, image, color) {
        this._paintCamoTankTexture(ctx, canvas, image, color, paintOptions);
      },
      baseColor,
      { srgb: false });
  }

  _paintTintedBZFlagBoltTexture(ctx, canvas, image, baseColor) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!image) {
      ctx.fillStyle = '#ffff66';
      ctx.beginPath();
      ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width * 0.16, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    // The canvas holds display bytes, so the tint goes in as display values,
    // not the linear ones a `THREE.Color` keeps.
    const tint = new THREE.Color(baseColor).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    const tintR = tint.r * 255;
    const tintG = tint.g * 255;
    const tintB = tint.b * 255;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) continue;

      const luminance = (
        (0.2126 * data[i]) +
        (0.7152 * data[i + 1]) +
        (0.0722 * data[i + 2])
      ) / 255;
      const shaded = 0.35 + (luminance * 0.95);
      data[i] = Math.max(0, Math.min(255, tintR * shaded));
      data[i + 1] = Math.max(0, Math.min(255, tintG * shaded));
      data[i + 2] = Math.max(0, Math.min(255, tintB * shaded));
    }

    ctx.putImageData(imageData, 0, 0);
  }

  _createTreadTexture() {
    const source = this._getSharedImage('/textures/treads.png');
    const { texture, redraw } = this._createCanvasBackedImageTexture(128, 128, (ctx, canvas) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (source.loaded) {
        ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = '#2b2b2b';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    });

    if (!source.loaded) {
      source.listeners.push(redraw);
    }

    return texture;
  }

  _createTreadCapTexture(baseColor = 0x646464, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    // Through the same rogue treatment the body's camo gets, or a rogue keeps
    // yellow treads on a grey tank -- see camoPaintColor.
    const source = new THREE.Color(baseColor);
    const paint = camoPaintColor(rgbToHsv(source.r, source.g, source.b), options.rogue);
    const color = new THREE.Color(paint.r, paint.g, paint.b);
    const darkened = color.clone().multiplyScalar(0.5);
    const r = Math.round(darkened.r * 255);
    const g = Math.round(darkened.g * 255);
    const b = Math.round(darkened.b * 255);

    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, 128, 128);

    const numBlobs = 25;
    for (let i = 0; i < numBlobs; i += 1) {
      const x = Math.random() * 128;
      const y = Math.random() * 128;
      const radius = Math.random() * 20 + 10;
      const variation = (Math.random() - 0.5) * 0.4;
      const newR = Math.max(0, Math.min(255, r + r * variation));
      const newG = Math.max(0, Math.min(255, g + g * variation));
      const newB = Math.max(0, Math.min(255, b + b * variation));
      ctx.fillStyle = `rgba(${Math.floor(newR)}, ${Math.floor(newG)}, ${Math.floor(newB)}, 0.6)`;
      ctx.beginPath();
      const points = 8;
      for (let j = 0; j <= points; j += 1) {
        const angle = (j / points) * Math.PI * 2;
        const radiusVariation = radius * (0.7 + Math.random() * 0.6);
        const px = x + Math.cos(angle) * radiusVariation;
        const py = y + Math.sin(angle) * radiusVariation;
        if (j === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.closePath();
      ctx.fill();
    }

    for (let i = 0; i < 15; i += 1) {
      const x = Math.random() * 128;
      const y = Math.random() * 128;
      const radius = Math.random() * 8 + 4;
      ctx.fillStyle = `rgba(0, 0, 0, ${0.1 + Math.random() * 0.2})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  _createWheelTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#303030';
    ctx.fillRect(0, 0, 128, 32);

    ctx.fillStyle = '#202020';
    for (let x = 0; x < 128; x += 16) {
      ctx.fillRect(x, 0, 10, 32);
    }

    ctx.fillStyle = 'rgba(120, 120, 120, 0.55)';
    for (let x = 0; x < 128; x += 32) {
      ctx.fillRect(x + 2, 5, 3, 22);
    }

    ctx.strokeStyle = 'rgba(10, 10, 10, 0.6)';
    ctx.lineWidth = 1;
    for (let x = 8; x < 128; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 32);
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 1);
    texture.needsUpdate = true;
    return texture;
  }

  _createWheelTreadTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const outerRadius = 58;
    const innerRadius = 18;
    const segmentCount = 24;

    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#333333';
    ctx.fill();

    for (let i = 0; i < segmentCount; i += 1) {
      const start = (i / segmentCount) * Math.PI * 2;
      const end = start + ((Math.PI * 2) / segmentCount) * 0.62;
      ctx.beginPath();
      ctx.arc(cx, cy, outerRadius, start, end);
      ctx.arc(cx, cy, innerRadius, end, start, true);
      ctx.closePath();
      ctx.fillStyle = i % 2 === 0 ? '#222222' : '#2a2a2a';
      ctx.fill();
    }

    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2;
    for (let i = 0; i < segmentCount; i += 1) {
      const angle = (i / segmentCount) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * innerRadius, cy + Math.sin(angle) * innerRadius);
      ctx.lineTo(cx + Math.cos(angle) * outerRadius, cy + Math.sin(angle) * outerRadius);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius - 4, 0, Math.PI * 2);
    ctx.fillStyle = '#202020';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 3;
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.center.set(0.5, 0.5);
    texture.needsUpdate = true;
    return texture;
  }

  updateTreads(tanks, deltaTime, gameConfig) {
    tanks.forEach((tank) => {
      if (!tank.userData.leftTreadOffset) {
        tank.userData.leftTreadOffset = 0;
        tank.userData.rightTreadOffset = 0;
      }
      const forwardSpeed = tank.userData.forwardSpeed || 0;
      const rotationSpeed = tank.userData.rotationSpeed || 0;
      const treadWidth = 3.5;
      const tankSpeed = gameConfig ? gameConfig.TANK_SPEED : 5;
      const tankRotSpeed = gameConfig ? gameConfig.TANK_ROTATION_SPEED : 2;
      const forwardDistance = forwardSpeed * tankSpeed * deltaTime;
      const rotationDistance = rotationSpeed * tankRotSpeed * deltaTime * treadWidth / 2;
      const leftDistance = forwardDistance - rotationDistance;
      const rightDistance = forwardDistance + rotationDistance;
      const treadSpeed = 0.5;
      tank.userData.leftTreadOffset -= leftDistance * treadSpeed;
      tank.userData.rightTreadOffset -= rightDistance * treadSpeed;

      const wheelRadius = tank.userData.wheelRadius || 0.42;
      if (wheelRadius > 0) {
        const leftWheelAngleDelta = leftDistance / wheelRadius;
        const rightWheelAngleDelta = -rightDistance / wheelRadius;
        const wheelSideOffsetScale = 1 / (Math.PI * 2 * wheelRadius);
        if (tank.userData.leftWheelTextures) {
          tank.userData.leftWheelTextures.forEach((texture) => {
            texture.rotation += leftWheelAngleDelta;
          });
        }
        if (tank.userData.leftWheelSideTextures) {
          tank.userData.leftWheelSideTextures.forEach((texture) => {
            texture.offset.x -= leftDistance * wheelSideOffsetScale;
          });
        }
        if (tank.userData.rightWheelTextures) {
          tank.userData.rightWheelTextures.forEach((texture) => {
            texture.rotation += rightWheelAngleDelta;
          });
        }
        if (tank.userData.rightWheelSideTextures) {
          tank.userData.rightWheelSideTextures.forEach((texture) => {
            texture.offset.x -= rightDistance * wheelSideOffsetScale;
          });
        }
      }

      if (tank.userData.leftTreadTextures) {
        tank.userData.leftTreadTextures.forEach((texture) => {
          if (texture && texture.offset) {
            texture.offset.x = tank.userData.leftTreadOffset;
          }
        });
      }
      if (tank.userData.rightTreadTextures) {
        tank.userData.rightTreadTextures.forEach((texture) => {
          if (texture && texture.offset) {
            texture.offset.x = tank.userData.rightTreadOffset;
          }
        });
      }
    });
  }

  // The whole world's track marks in one draw. Upstream gives each mark a scene
  // node of its own and walks a linked list per frame; here every mark is a pair
  // of quads at a fixed slot in one buffer, written when the mark is laid and
  // never moved again, so the per-frame cost is the fade -- one alpha per vertex
  // of the marks that are still alive -- and nothing else.
  //
  // Every mark fades over the same `_trackFade`, and they are laid in time
  // order, so the live marks are always one run of slots and the oldest is
  // always the next to go. That is what lets the ring be walked from its tail
  // rather than swept, and what bounds every buffer upload to the marks that are
  // actually on the ground.
  _getTrackMarkMesh() {
    if (this._trackMarkMesh) return this._trackMarkMesh;

    const vertices = TRACK_MARK_CAPACITY * TRACK_MARK_VERTICES;
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3);
    // Four components: the mark is black and the fade is in the alpha, exactly
    // as `drawTreads` sets `glColor4f(0, 0, 0, 1 - ratio)`.
    const colors = new THREE.BufferAttribute(new Float32Array(vertices * 4), 4);
    positions.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);
    const index = new Uint16Array(TRACK_MARK_CAPACITY * TRACK_MARK_QUADS * 6);
    for (let quad = 0; quad < TRACK_MARK_CAPACITY * TRACK_MARK_QUADS; quad += 1) {
      const v = quad * 4;
      index.set([v, v + 1, v + 3, v + 1, v + 2, v + 3], quad * 6);
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      // The last thing drawn on the ground writes no depth, so the marks do not
      // occlude each other where a trail crosses itself.
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = TRACK_MARK_RENDER_ORDER;
    // World-space vertices, so the mesh sits at the origin and never moves.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // The marks are scattered over the whole map, so a bound around them is the
    // map and computing one every frame would cost more than the draw it saves.
    mesh.frustumCulled = false;
    mesh.visible = false;
    this._trackMarkMesh = this._tagDraws(mesh, 'effect');
    this._trackMarkAges = new Float32Array(TRACK_MARK_CAPACITY);
    // The live run: `count` slots starting at `tail`, wrapping.
    this._trackMarkTail = 0;
    this._trackMarkCount = 0;
    this.worldFrame.add(mesh);
    return mesh;
  }

  // One mark, as `TrackMarks::addMark` accepts it: a place, a heading, the
  // tank's width scale, and which treads left it. A pool that is full drops its
  // oldest mark to make room -- upstream's list has no bound and lets a busy map
  // grow one instead, which is the trade a client that has to hold a frame rate
  // cannot make.
  addTrackMark(mark) {
    if (!this.worldGroup || !mark || !mark.sides) return;
    const mesh = this._getTrackMarkMesh();
    if (this._trackMarkCount === TRACK_MARK_CAPACITY) {
      this._trackMarkTail = (this._trackMarkTail + 1) % TRACK_MARK_CAPACITY;
      this._trackMarkCount -= 1;
    }
    const slot = (this._trackMarkTail + this._trackMarkCount) % TRACK_MARK_CAPACITY;
    this._trackMarkCount += 1;

    const positions = mesh.geometry.getAttribute('position');
    const colors = mesh.geometry.getAttribute('color');
    const positionArray = positions.array;
    const colorArray = colors.array;

    // The tank's own axes. Upstream draws the quad in tank space and lets
    // `glRotatef` place it; bzo writes world-space vertices in `worldFrame`, so
    // the frame is spelled out here -- forward along the azimuth, and the
    // lateral axis leading it by a quarter turn, which is upstream's +y.
    const sin = Math.sin(mark.angle);
    const cos = Math.cos(mark.angle);
    const forwardX = cos;
    const forwardY = sin;
    const leftX = -sin;
    const leftY = cos;
    // `glScalef(1, te.scale, 1)`: the tank's width scale reaches the lateral
    // offsets and nothing else, so a wide tank leaves its marks further apart
    // without making either of them longer.
    const inside = TREAD_INSIDE * mark.scale;
    const outside = TREAD_OUTSIDE * mark.scale;
    const halfWidth = 0.5 * TREAD_MARK_WIDTH;

    const writeQuad = (quad, near, far) => {
      let vertex = ((slot * TRACK_MARK_QUADS) + quad) * 4;
      // Wound so the quad faces up: forward cross left is +z, so along the tread
      // first and then across it is counter-clockwise seen from above.
      const corners = [
        -halfWidth, near,
        +halfWidth, near,
        +halfWidth, far,
        -halfWidth, far,
      ];
      for (let i = 0; i < corners.length; i += 2) {
        const along = corners[i];
        const across = corners[i + 1];
        const p = vertex * 3;
        positionArray[p] = mark.x + (forwardX * along) + (leftX * across);
        positionArray[p + 1] = mark.y + (forwardY * along) + (leftY * across);
        positionArray[p + 2] = mark.z;
        const c = vertex * 4;
        colorArray[c] = 0;
        colorArray[c + 1] = 0;
        colorArray[c + 2] = 0;
        colorArray[c + 3] = 1;
        vertex += 1;
      }
    };

    if (mark.sides & TRACK_TREAD_LEFT) writeQuad(0, inside, outside);
    else this._collapseTrackMarkQuad(positionArray, slot, 0);
    if (mark.sides & TRACK_TREAD_RIGHT) writeQuad(1, -outside, -inside);
    else this._collapseTrackMarkQuad(positionArray, slot, 1);

    this._trackMarkAges[slot] = 0;
    // One slot's worth of vertices, rather than the pool: a mark is laid twenty
    // times a second per tank and this is the only thing that ever moves one.
    positions.addUpdateRange(slot * TRACK_MARK_VERTICES * 3, TRACK_MARK_VERTICES * 3);
    positions.needsUpdate = true;
    this._setTrackMarkDrawRange();
    mesh.visible = true;
  }

  // A tread that left no mark collapses to a point at the origin, which is a
  // pair of zero-area triangles: still in the index buffer, still submitted, and
  // producing no fragments at all.
  _collapseTrackMarkQuad(positionArray, slot, quad) {
    const start = (((slot * TRACK_MARK_QUADS) + quad) * 4) * 3;
    positionArray.fill(0, start, start + 12);
  }

  // Only the live run is submitted. It is one span of slots, so the common case
  // is a draw range over it; where it wraps the whole pool goes, and the dead
  // slots in the middle are the collapsed quads, which cost no fragments.
  _setTrackMarkDrawRange() {
    const geometry = this._trackMarkMesh.geometry;
    const tail = this._trackMarkTail;
    const count = this._trackMarkCount;
    if (count === 0) geometry.setDrawRange(0, 0);
    else if (tail + count <= TRACK_MARK_CAPACITY) {
      geometry.setDrawRange(tail * TRACK_MARK_INDICES, count * TRACK_MARK_INDICES);
    } else {
      geometry.setDrawRange(0, TRACK_MARK_CAPACITY * TRACK_MARK_INDICES);
    }
  }

  // `TrackMarks::update` (`TrackMarks.cxx:508`) ages every mark and drops the
  // ones past `_trackFade`. Upstream also re-culls marks a physics driver has
  // carried off the surface they were left on; bzo has no physics drivers, so
  // where a mark was laid is where it stays.
  updateTrackMarks(deltaTime) {
    const mesh = this._trackMarkMesh;
    if (!mesh || !(deltaTime > 0) || this._trackMarkCount === 0) return;

    const positions = mesh.geometry.getAttribute('position');
    const colors = mesh.geometry.getAttribute('color');
    const positionArray = positions.array;
    const colorArray = colors.array;
    const ages = this._trackMarkAges;

    // Retire from the tail, which is the oldest and so the first to expire.
    while (this._trackMarkCount > 0) {
      const slot = this._trackMarkTail;
      ages[slot] += deltaTime;
      if (getTrackMarkAlpha(ages[slot]) > 0) break;
      this._collapseTrackMarkQuad(positionArray, slot, 0);
      this._collapseTrackMarkQuad(positionArray, slot, 1);
      positions.addUpdateRange(slot * TRACK_MARK_VERTICES * 3, TRACK_MARK_VERTICES * 3);
      positions.needsUpdate = true;
      this._trackMarkTail = (slot + 1) % TRACK_MARK_CAPACITY;
      this._trackMarkCount -= 1;
    }
    this._setTrackMarkDrawRange();
    if (this._trackMarkCount === 0) {
      mesh.visible = false;
      return;
    }

    // The rest of the run has already been aged at its head, so start past it.
    for (let step = 1; step < this._trackMarkCount; step += 1) {
      const slot = (this._trackMarkTail + step) % TRACK_MARK_CAPACITY;
      ages[slot] += deltaTime;
    }
    for (let step = 0; step < this._trackMarkCount; step += 1) {
      const slot = (this._trackMarkTail + step) % TRACK_MARK_CAPACITY;
      const alpha = getTrackMarkAlpha(ages[slot]);
      const start = slot * TRACK_MARK_VERTICES * 4;
      for (let i = start + 3; i < start + (TRACK_MARK_VERTICES * 4); i += 4) {
        colorArray[i] = alpha;
      }
    }
    // The live run is contiguous, so it is one upload, or two where it wraps.
    const stride = TRACK_MARK_VERTICES * 4;
    const first = Math.min(this._trackMarkCount, TRACK_MARK_CAPACITY - this._trackMarkTail);
    colors.addUpdateRange(this._trackMarkTail * stride, first * stride);
    if (first < this._trackMarkCount) {
      colors.addUpdateRange(0, (this._trackMarkCount - first) * stride);
    }
    colors.needsUpdate = true;
  }

  // `TrackMarks::clear`, which upstream calls when the renderer starts on a new
  // world. A trail belongs to the map it was left on.
  clearTrackMarks() {
    const mesh = this._trackMarkMesh;
    if (!mesh) return;
    const positions = mesh.geometry.getAttribute('position');
    positions.array.fill(0);
    positions.clearUpdateRanges();
    positions.needsUpdate = true;
    this._trackMarkAges.fill(0);
    this._trackMarkTail = 0;
    this._trackMarkCount = 0;
    this._setTrackMarkDrawRange();
    mesh.visible = false;
  }
}
