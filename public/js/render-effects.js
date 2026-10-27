/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Shots and effects: bolts, missiles and lasers, explosions, muzzle flashes,
// ricochets, jump jets, landings and spawns.
// RenderManager's own methods, kept here and installed on its prototype by
// render.js: `this` is the RenderManager.

import { TANK } from './collision.mjs';
import { getFlagTuning, getShockWaveAlpha, getShotEffects } from './flags.mjs';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { BZFLAG_LIGHT_ATTENUATION, standUpGeometry } from './render.js';

// Turns an object so its own +Z runs along the unit direction (x, y, z), in
// its parent's frame. Its roll about that axis is whatever the shortest turn
// leaves, which is all a shape round that axis needs.
const POINT_ALONG_FORWARD = new THREE.Vector3(0, 0, 1);
const POINT_ALONG_SCRATCH = new THREE.Vector3();
function pointAlong(object, x, y, z) {
  object.quaternion.setFromUnitVectors(POINT_ALONG_FORWARD, POINT_ALONG_SCRATCH.set(x, y, z));
  return object;
}

const BZFLAG_FLASH_TEXTURE = '/textures/blend_flash.png';
const SHOT_EXPLOSION_TEXTURES = [
  '/textures/explode1.png',
  '/textures/explode2.png',
];
// Muzzle flash, mirroring StdShotEffect. It is a flared cone out of the barrel,
// not a billboard: drawRingYZ() builds a frustum whose inner circle sits at the
// muzzle with radius `radius`, flaring to `radius + topsideOffset` a distance
// `z` forward, textured V 0.65..1.0 along its length. These figures are
// hardcoded in effectsRenderer.cxx (ctor at :897, update at :931, draw at :935)
// and are not BZDB-tunable, so they are constants here too.
const BZFLAG_SHOT_FLASH_LIFETIME = 1.5;         // ctor
const BZFLAG_SHOT_FLASH_START_RADIUS = 0.125;   // ctor
const BZFLAG_SHOT_FLASH_GROWTH = 6.0;           // update(): radius += dt * 6
const BZFLAG_SHOT_FLASH_LENGTH = 0.5;           // draw(): drawRingYZ z argument
const BZFLAG_SHOT_FLASH_FLARE = 1.0;            // draw(): topsideOffset base
const BZFLAG_SHOT_FLASH_FLARE_GROWTH = 5.0;     // draw(): topsideOffset age term
const BZFLAG_SHOT_FLASH_START_ALPHA = 0.5;      // draw(): alpha = 0.5 - age/lifetime
const BZFLAG_SHOT_FLASH_SEGMENTS = 32;          // drawRingYZ default
const BZFLAG_SHOT_FLASH_UV_BOTTOM = 0.65;       // draw(): bottomUV
// Ricochet, mirroring StdRicoEffect (effectsRenderer.cxx:1594). The same flared
// cone the muzzle flash is, thrown at the point a shot bounced and aimed along
// the change in its direction -- which is to say out of the surface it hit.
const BZFLAG_RICO_LIFETIME = 0.5;               // ctor
const BZFLAG_RICO_START_RADIUS = 0.25;          // ctor
const BZFLAG_RICO_GROWTH = 6.5;                 // update(): radius += dt * 6.5
const BZFLAG_RICO_LENGTH = 0.5;                 // draw(): drawRingYZ z argument
const BZFLAG_RICO_FLARE = 0.5;                  // draw(): topsideOffset
const BZFLAG_RICO_START_ALPHA = 0.5;            // draw(): alpha = 0.5 - age/lifetime
const BZFLAG_RICO_SEGMENTS = 32;                // drawRingYZ default
const BZFLAG_RICO_UV_BOTTOM = 0.5;              // draw(): bottomUV
// Jump jets, mirroring TankSceneNode. Four downward flames under the tank fire
// on a jump and fade as the tank rises.
//   TankSceneNode.cxx:1430  jumpJetsModel[4][3], the jet offsets
//   TankSceneNode.cxx:1448  the flame triangle and its texture coordinates
//   TankSceneNode.cxx:419   per-jet random length, roughly +/-25%
//   Player.cxx:447          jetTime = 0.5 * (jumpVelocity / gravity)
//   Player.cxx:847          fireJumpJets() sets the scale to 1
// Upstream's tank-local offsets: +X forward, +Y left, +Z up.
const BZFLAG_JUMPJET_TEXTURE = '/textures/jumpjets.png';
const BZFLAG_JUMPJET_OFFSETS = [
  { x: -1.5, y: -0.6, z: 0.25 },
  { x: -1.5, y: +0.6, z: 0.25 },
  { x: +1.5, y: -0.6, z: 0.25 },
  { x: +1.5, y: +0.6, z: 0.25 },
];
const BZFLAG_JUMPJET_HALF_WIDTH = 0.3;   // triangle half width at the nozzle
const BZFLAG_JUMPJET_LENGTH = 1.0;       // triangle length before scaling
const BZFLAG_JUMPJET_ALPHA = 0.5;        // myColor4f(1,1,1,0.5)
const BZFLAG_JUMPJET_LIGHT_COLOR = { r: 1.5, g: 1.0, b: 0.5 };

// Shot teleport, mirroring StdShotTeleportEffect (effectsRenderer.cxx:1665).
// A small six-segment collar that rides along with the shot, spinning about the
// shot axis while its length pulses on a one second sawtooth. Radius is fixed --
// upstream's growth line is commented out -- and alpha stays at 1.
const BZFLAG_SHOT_TELEPORT_TEXTURE = '/textures/dusty_flare.png';
const BZFLAG_SHOT_TELEPORT_LIFETIME = 4.0;      // ctor
const BZFLAG_SHOT_TELEPORT_RADIUS = 0.25;       // ctor
const BZFLAG_SHOT_TELEPORT_FLARE = 0.125;       // draw(): topsideOffset
const BZFLAG_SHOT_TELEPORT_SPIN = 90;           // draw(): glRotatef(age*90, 1,0,0)
const BZFLAG_SHOT_TELEPORT_SEGMENTS = 6;        // draw(): segments argument
const BZFLAG_SHOT_TELEPORT_UV_TOP = 0.8;        // draw(): topUV
// HUDRenderer::drawLockonMarker (HUDRenderer.cxx:1314): two brackets facing each
// other across the locked tank, each a four-point strip inset at top and bottom.
// The proportions are upstream's, in its own +/-40 box.
//
// Upstream draws them in screen space, projecting the target and clamping the
// result to the window edge so a target behind you still has a marker on the
// rim. bzo draws the bracket in the world instead, as a sprite standing at the
// tank: a screen-space overlay has no meaning in a headset, where there is no
// window to pin it to, and a sprite is already how bzo billboards. The cost is
// upstream's edge clamping -- a target off screen has no marker -- and the
// heading tape is where a bearing belongs anyway.
const BZFLAG_LOCKON_SIZE = 40;                  // lockonSize
const BZFLAG_LOCKON_INSET = 15;                 // lockonInset
const BZFLAG_LOCKON_DECLINATION = 15;           // lockonDeclination
const BZFLAG_LOCKON_LINE_WIDTH = 3;             // glLineWidth(3.0f)
const BZFLAG_LOCKON_ALPHA = 0.45;               // hudColor3Afv(color, 0.45f)
// How wide the bracket stands in the world. A bzo tank is four units across, so
// this frames it with room to read as a bracket rather than as a box drawn on it.
const BZFLAG_LOCKON_WORLD_SIZE = 7;

// A guided missile's bolt, and its smoke trail. Upstream's default quality draws
// the missile as a billboard like any other shot -- the modelled one with fins is
// behind `useQuality() >= 3` -- but textured from `missile.png`, which is a 4x4
// sheet stepped one cell a frame (BoltSceneNode.cxx:864), and trailing a
// SmokeGMPuffEffect puff every `gmPuffTime`. That trail is what makes a missile
// recognisable at a glance in upstream, so bzo takes both.
//
// The colour is bzo's, not upstream's. Upstream paints every GM bolt the same
// orange (`setColor(1.0f, 0.2f, 0.0f)`); bzo colours every shot by who fired it,
// and a missile is the shot you most want to know the owner of.
const BZFLAG_MISSILE_TEXTURE = '/textures/missile.png';
const BZFLAG_MISSILE_ANIM_CELLS = 4;            // setTextureAnimation(4, 4)
// BoltSceneNode's flares (BoltSceneNode.cxx:615), which upstream turns on for
// the guided missile and for nothing else (`setFlares(true)`,
// GuidedMissleStrategy.cxx:49). Three to five spikes in random directions out
// of the bolt, re-picked every single frame -- it is the flicker rather than
// the shape that does the work, and it is what makes a missile read as
// something burning rather than as an ordinary bolt in a different colour.
//
// The spikes are drawn in the bolt's own billboard frame, so they face the
// camera with it, and they reach twice the bolt's radius: far enough to break
// the round silhouette every other shot has.
const BZFLAG_GM_FLARE_MIN = 3;                  // 3 + int(3 * bzfrand())
const BZFLAG_GM_FLARE_RANGE = 3;
const BZFLAG_GM_FLARE_MAX = BZFLAG_GM_FLARE_MIN + BZFLAG_GM_FLARE_RANGE - 1;
const BZFLAG_GM_FLARE_SIZE = 1.0;               // FlareSize
const BZFLAG_GM_FLARE_SPREAD = 0.08;            // FlareSpread, radians
// flareColor takes the bolt's rgb and its own alpha (BoltSceneNode.cxx:304),
// and a missile's bolt is `setColor(1.0, 0.2, 0.0)` whoever fired it
// (GuidedMissleStrategy.cxx:47). Kept upstream's: a spike in a blue team's
// colour is lost against the sky, and the model's nose and fins already say
// whose missile it is.
const BZFLAG_GM_FLARE_OPACITY = 0.667;
const BZFLAG_GM_FLARE_COLOR = [1.0, 0.2, 0.0];
// `shot_tail.png` is a four-by-four sheet of wisps, and a shot takes six
// consecutive cells of it from a random start so that two shots in the air do
// not wear the same tail.
const BZFLAG_SHOT_TAIL_CELLS = 4;
// How far behind the bolt each segment of the trail sits, how big it is and how
// much of it shows. Fixed by its place in the trail rather than by the shot, so
// they are read straight out of these rather than stored per shot.
const BZFLAG_SHOT_TAIL_SEGMENTS = 6;
const BZFLAG_SHOT_TAIL_DISTANCES = [0.34, 0.62, 0.90, 1.18, 1.46, 1.74];
const BZFLAG_SHOT_TAIL_SCALES = [0.78, 0.70, 0.62, 0.54, 0.46, 0.38];
const BZFLAG_SHOT_TAIL_ALPHAS = [0.74, 0.64, 0.54, 0.44, 0.34, 0.24];
// A bolt's billboard at upstream's own size: nothing calls `setSize` on a
// shot's BoltSceneNode, so it keeps its default radius of 1 and its square is
// two units across -- a missile's flares reaching to its edge.
const BZFLAG_SHOT_HEAD_SCALE = 2;
// Grown in powers of two from here, the way the flag batch grows.
const BZFLAG_SHOT_BATCH_MIN_CAPACITY = 32;
const BZFLAG_GM_PUFF_TEXTURE = '/textures/puffs.png';
const BZFLAG_GM_PUFF_CELLS = 2;                 // du = dv = 0.5, a random quadrant
const BZFLAG_GM_PUFF_INTERVAL = 1 / 8;          // gmPuffTime
const BZFLAG_GM_PUFF_LIFETIME = 3.5;            // ctor
const BZFLAG_GM_PUFF_JITTER = 0.5;              // ctor: randMod
const BZFLAG_GM_PUFF_DRIFT = 1.5;               // draw(): vertDrift = 1.5f * age
const BZFLAG_GM_PUFF_SPIN = 180;                // draw(): glRotatef(age*180, 0,0,1)
const BZFLAG_GM_PUFF_SIZE = 0.5;                // draw(): size = 0.5f + age * 1.25f
const BZFLAG_GM_PUFF_GROWTH = 1.25;
const BZFLAG_GM_PUFF_ALPHA = 0.5;               // draw(): alpha = 0.5f - age/lifetime
// GuidedMissileStrategy's ctor at `useQuality() >= 3`: `rootPuff /= 10 + 5 *
// bzfrand()`, so a missile at that quality leaves a puff every frame or so.
const BZFLAG_GM_PUFF_QUALITY_DIVISOR = 10;
const BZFLAG_GM_PUFF_QUALITY_DIVISOR_RANGE = 5;
// Every puff in the world rides in one ring of instances, aged on the GPU from
// its birth time, so a puff costs the CPU one write when it is born and nothing
// after. Upstream's rate is one a frame a missile, for the 1.75 s a puff is
// visible: enough for a dozen missiles at once at 144 fps before the oldest
// puff is overwritten.
const GM_PUFF_CAPACITY = 4096;
// renderGeoGMBolt (BoltSceneNode.cxx:326), the modelled missile upstream draws
// at `useQuality() >= 3`.
const BZFLAG_GM_MODEL_PATH = '/obj/missile.obj';
const BZFLAG_GM_MODEL_ROLL = 90;                // degrees a second, `rotSpeed`
// coneColor and bodyColor; the nose is the shot's colour and the fins half it.
const BZFLAG_GM_MODEL_CONE = 0.125;
const BZFLAG_GM_MODEL_FIN_SCALE = 0.5;
const GM_MODEL_AXIS = new THREE.Vector3(0, 0, 1);
const GM_MODEL_FORWARD = new THREE.Vector3();
const GM_MODEL_ROLL = new THREE.Quaternion();

// Shots ride over the flags they pass, and their explosions over the shots.
const SHOT_RENDER_ORDER = 16;
// How many lines the overlay holds; past that it draws the first ones.
const OVERLAY_MAX_SEGMENTS = 2048;
const SHOT_EXPLOSION_RENDER_ORDER = 17;

function shotExplosionSize() {
  return 1.2 * TANK.length;
}
const BZFLAG_SHOT_EXPLOSION_DURATION = 0.8;
const BZFLAG_SHOT_EXPLOSION_LIGHT_FADE_START_RATIO = 0.7;

const SHOT_EXPLOSION_EYE_SCRATCH = new THREE.Vector3();

// Every bolt of one colour in one draw, and its whole trail in another.
//
// The quad is laid out in view space rather than world space, which is how a
// `Sprite` faces the eye and is why this can be instanced where a `Sprite`
// cannot: the instance matrix carries only the centre and the size, so a shot
// moving is four floats rather than a rotation composed on the CPU for every
// segment of every trail.
//
// `instanceUvOffset` is which cell of a sheet the instance shows -- the wisp a
// trail segment wears, and the animation frame a guided missile is on --
// and `instanceAlpha` how much of it shows, which for a trail is fixed by how
// far back the segment sits.
const SHOT_BATCH_VERTEX_SHADER = `
attribute vec2 instanceUvOffset;
attribute float instanceAlpha;
uniform vec2 uvScale;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = (uv * uvScale) + instanceUvOffset;
  vAlpha = instanceAlpha;
  vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 size = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
  centre.xy += position.xy * size;
  gl_Position = projectionMatrix * centre;
}
`;

// `colorspace_fragment` is what a `SpriteMaterial` ends with too. Without it a
// shader of one's own writes linear values into a screen that expects the
// output space, and every shot comes out dark.
const SHOT_BATCH_FRAGMENT_SHADER = `
uniform sampler2D map;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 texel = texture2D(map, vUv);
  gl_FragColor = vec4(texel.rgb, texel.a * vAlpha);
  #include <colorspace_fragment>
}
`;

function createShotBatchMaterial(texture, { cells = 1, additive = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      uvScale: { value: new THREE.Vector2(1 / cells, 1 / cells) },
    },
    vertexShader: SHOT_BATCH_VERTEX_SHADER,
    fragmentShader: SHOT_BATCH_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

function buildShotBatchMesh(texture, capacity, { cells, additive }) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute(
    'instanceUvOffset', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2),
  );
  geometry.setAttribute(
    'instanceAlpha', new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1),
  );
  const mesh = new THREE.InstancedMesh(geometry, createShotBatchMaterial(texture, { cells, additive }), capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Shots are scattered over the whole map, so a bound around them is the map
  // -- the same reason the flag batch is never culled.
  mesh.frustumCulled = false;
  mesh.renderOrder = SHOT_RENDER_ORDER;
  mesh.count = 0;
  return mesh;
}

// SmokeGMPuffEffect::draw (EffectsRenderer.cxx), on the GPU: a puff's age is
// the clock less its birth, and everything else -- its fade, its swell, its
// drift upward and its spin -- is upstream's formula of that age. A puff whose
// age is past its fade is moved off screen rather than drawn transparent.
const GM_PUFF_VERTEX_SHADER = `
attribute vec3 puffOrigin;
attribute float puffBirth;
attribute vec2 puffCell;
uniform float time;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  float age = time - puffBirth;
  vAlpha = ${BZFLAG_GM_PUFF_ALPHA.toFixed(4)} - (age / ${BZFLAG_GM_PUFF_LIFETIME.toFixed(4)});
  vUv = (uv * ${(1 / BZFLAG_GM_PUFF_CELLS).toFixed(4)}) + puffCell;
  if (age < 0.0 || vAlpha <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float size = (${BZFLAG_GM_PUFF_SIZE.toFixed(4)} + (age * ${BZFLAG_GM_PUFF_GROWTH.toFixed(4)})) * 2.0;
  float spin = radians(age * ${BZFLAG_GM_PUFF_SPIN.toFixed(4)});
  vec2 corner = vec2(
    (position.x * cos(spin)) - (position.y * sin(spin)),
    (position.x * sin(spin)) + (position.y * cos(spin))
  );
  vec4 mvPosition = modelViewMatrix
    * vec4(puffOrigin + vec3(0.0, 0.0, ${BZFLAG_GM_PUFF_DRIFT.toFixed(4)} * age), 1.0);
  mvPosition.xy += corner * size;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const GM_PUFF_FRAGMENT_SHADER = `
uniform sampler2D map;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  vec4 texel = texture2D(map, vUv);
  gl_FragColor = vec4(texel.rgb, texel.a * vAlpha);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function buildGMPuffMesh(texture) {
  const plane = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.setAttribute('position', plane.getAttribute('position'));
  geometry.setAttribute('uv', plane.getAttribute('uv'));
  const attribute = (size, fill = 0) => {
    const buffer = new THREE.InstancedBufferAttribute(new Float32Array(GM_PUFF_CAPACITY * size).fill(fill), size);
    buffer.setUsage(THREE.DynamicDrawUsage);
    return buffer;
  };
  geometry.setAttribute('puffOrigin', attribute(3));
  // Born long ago, so a slot never written is already faded out.
  geometry.setAttribute('puffBirth', attribute(1, -1e6));
  geometry.setAttribute('puffCell', attribute(2));
  geometry.instanceCount = 0;
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { map: { value: null }, time: { value: 0 } },
    ]),
    vertexShader: GM_PUFF_VERTEX_SHADER,
    fragmentShader: GM_PUFF_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  // `merge` clones values, a texture included, so the sheet goes in after.
  material.uniforms.map.value = texture;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = SHOT_RENDER_ORDER;
  return mesh;
}

// renderGeoGMBolt's missile (`public/obj/missile.obj`, written by
// `scripts/gen-missile-obj.mjs`) for one shot colour: its four parts merged
// into one geometry, each in the colour upstream paints it, so a missile is
// one draw call. The nose is the shooter's colour flat and the fins half it:
// upstream's team colour, which in a bzo world is the player's own.
function halveDisplayColor(color, scale) {
  const rgb = color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  return new THREE.Color().setRGB(rgb.r * scale, rgb.g * scale, rgb.b * scale, THREE.SRGBColorSpace);
}

function buildGMModelGeometry(parts, shotColor) {
  const nose = new THREE.Color(shotColor);
  const partColors = {
    nose,
    // Half of what upstream displays, so halved as display values.
    fin: halveDisplayColor(nose, BZFLAG_GM_MODEL_FIN_SCALE),
    body: new THREE.Color(1, 1, 1),
    cone: new THREE.Color().setRGB(
      BZFLAG_GM_MODEL_CONE, BZFLAG_GM_MODEL_CONE, BZFLAG_GM_MODEL_CONE, THREE.SRGBColorSpace,
    ),
  };
  const positions = [];
  const colors = [];
  for (const [name, geometry] of parts) {
    const color = partColors[name] || partColors.body;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      colors.push(color.r, color.g, color.b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

// The colour scales, which are the only thing that differs between the lights.
const BZFLAG_SHOT_LIGHT_SCALE = 1.5;          // BoltSceneNode.cxx:85
// LaserSceneNode::renderGeoLaser (LaserSceneNode.cxx:178): a bright core inside a
// faint glow, both cylinders the length of the segment. That is upstream's
// untextured laser, and bzo ships no laser texture, so it is the one bzo draws.
const BZFLAG_LASER_TEXTURE = '/textures/rabbit_laser.png';

// renderFlatLaser's geometry for a segment one unit long, running up +Y from
// the origin: the start star (a fan of four triangles across the beam, its
// centre at the middle of the texture and its rim at the corner, as upstream
// writes it) and the two crossed quads, `u` across their width and `v` along
// their length.
function buildFlatLaserGeometry() {
  const positions = [];
  const uvs = [];
  const quad = (a, b, c, d) => {
    positions.push(...a.p, ...b.p, ...c.p, ...b.p, ...d.p, ...c.p);
    uvs.push(...a.uv, ...b.uv, ...c.uv, ...b.uv, ...d.uv, ...c.uv);
  };
  const rim = [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]];
  for (let i = 0; i < 4; i++) {
    const p0 = rim[i];
    const p1 = rim[(i + 1) % 4];
    positions.push(0, 0, 0, ...p0, ...p1);
    uvs.push(0.5, 0.5, 0, 0, 0, 0);
  }
  quad({ p: [0, 0, 1], uv: [0, 0] }, { p: [0, 1, 1], uv: [0, 1] },
    { p: [0, 0, -1], uv: [1, 0] }, { p: [0, 1, -1], uv: [1, 1] });
  quad({ p: [1, 0, 0], uv: [0, 0] }, { p: [1, 1, 0], uv: [0, 1] },
    { p: [-1, 0, 0], uv: [1, 0] }, { p: [-1, 1, 0], uv: [1, 1] });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}
const BZFLAG_SHOT_IMPACT_LIGHT_SCALE = 1.2;   // playing.cxx:3636, scaled by size/tankLength
const BZFLAG_EXPLOSION_LIGHT_SCALE = 9.6;     // playing.cxx:3654, colour * lightGain
const BZFLAG_JUMPJET_LIGHT_SCALE = 3.0;       // TankSceneNode.cxx:308, (1.5,1,0.5) * 2

// Upstream's colour scale as a Three light intensity, at the shared falloff.
function bzflagLightIntensity(colorScale) {
  return colorScale / BZFLAG_LIGHT_ATTENUATION[2];
}

export class EffectsRendering {
  _createBoltTexture(baseColor) {
    return this._createTintedTexture(
      '/textures/green_bolt.png', 64, 64, this._paintTintedBZFlagBoltTexture, baseColor);
  }

  // The same tint over the missile sheet, wrapped to one of its sixteen cells.
  // Which cell is random to start with and steps once a frame, as upstream's
  // does, so two missiles in the air are never in step.
  _createMissileTexture(baseColor) {
    const texture = this._createTintedTexture(
      BZFLAG_MISSILE_TEXTURE, 256, 256, this._paintTintedBZFlagBoltTexture, baseColor);
    const cell = 1 / BZFLAG_MISSILE_ANIM_CELLS;
    texture.repeat.set(cell, cell);
    // No mipmaps: a mip of the whole sheet blends cells into their neighbours,
    // so a missile drawn small shows four frames at once instead of one. The
    // cell is a soft glow, which is the kind of image that loses least by it.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    const start = Math.floor(Math.random() * BZFLAG_MISSILE_ANIM_CELLS * BZFLAG_MISSILE_ANIM_CELLS);
    texture.userData = {
      u: start % BZFLAG_MISSILE_ANIM_CELLS,
      v: Math.floor(start / BZFLAG_MISSILE_ANIM_CELLS),
    };
    this._applyMissileFrame(texture);
    return texture;
  }

  // One mesh a missile, rewritten in place every frame. The spikes are four
  // vertices each -- upstream's `GL_TRIANGLE_STRIP` of a point at the bolt's
  // centre, two shoulders and a tip -- so the whole thing is twenty vertices at
  // its widest and re-randomising it costs a handful of floats rather than a
  // buffer of a new size. `drawRange` covers the frames that picked fewer than
  // the maximum, which is what keeps the allocation a one-off.
  _createGMFlares() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(BZFLAG_GM_FLARE_MAX * 4 * 3), 3,
    ));
    const indices = new Uint16Array(BZFLAG_GM_FLARE_MAX * 6);
    for (let i = 0; i < BZFLAG_GM_FLARE_MAX; i += 1) {
      const base = i * 4;
      // The two triangles a four-vertex strip stands for. Wound either way: the
      // material is double-sided, because a spike picked at random in 3-space
      // is as likely to point away from the camera as towards it.
      indices.set([base, base + 1, base + 2, base + 1, base + 3, base + 2], i * 6);
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    // Never lit: upstream draws the flares with lighting off and blends them
    // over the world.
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(...BZFLAG_GM_FLARE_COLOR, THREE.SRGBColorSpace),
      transparent: true,
      opacity: BZFLAG_GM_FLARE_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = SHOT_RENDER_ORDER - 1;
    // The spikes are re-picked from nothing every frame, so a bounding sphere
    // computed from the vertices would be stale the moment it was built -- and
    // a missile is never the thing worth culling anyway.
    mesh.frustumCulled = false;
    this._updateGMFlares(mesh);
    return mesh;
  }

  // One frame's spikes. `phi` is upstream's own correction to a uniform pick:
  // spreading it evenly biases the directions towards the poles, and squaring
  // it moves the crowd back towards the equator, where a flare is side-on to
  // the camera and reads longest.
  _updateGMFlares(mesh, cameraWorldPosition = null) {
    const position = mesh.geometry.attributes.position;
    const array = position.array;
    const count = BZFLAG_GM_FLARE_MIN + Math.floor(Math.random() * BZFLAG_GM_FLARE_RANGE);
    // Upstream scales the whole billboard by the bolt's radius, which is half
    // the width the head sprite is drawn at.
    const radius = BZFLAG_SHOT_HEAD_SCALE / 2;
    for (let i = 0; i < count; i += 1) {
      const theta = Math.random() * Math.PI * 2;
      const rawPhi = Math.random() - 0.5;
      const phi = rawPhi * (Math.PI * 2 * Math.abs(rawPhi));
      const c = BZFLAG_GM_FLARE_SIZE * Math.cos(phi) * radius;
      const z = BZFLAG_GM_FLARE_SIZE * Math.sin(phi) * radius;
      const near = theta - BZFLAG_GM_FLARE_SPREAD;
      const far = theta + BZFLAG_GM_FLARE_SPREAD;
      const base = i * 12;
      array[base] = 0;
      array[base + 1] = 0;
      array[base + 2] = 0;
      array[base + 3] = c * Math.cos(near);
      array[base + 4] = c * Math.sin(near);
      array[base + 5] = z;
      array[base + 6] = c * Math.cos(far);
      array[base + 7] = c * Math.sin(far);
      array[base + 8] = z;
      array[base + 9] = c * Math.cos(theta) * 2;
      array[base + 10] = c * Math.sin(theta) * 2;
      array[base + 11] = z * 2;
    }
    position.needsUpdate = true;
    mesh.geometry.setDrawRange(0, count * 6);
    // The billboard upstream gets from `executeBillboard`. `lookAt` takes a
    // world point and accounts for whatever the parents are doing, which is
    // what makes this right in a headset too -- there the world sits under a
    // rig transform that a copied camera rotation would ignore.
    if (cameraWorldPosition) mesh.lookAt(cameraWorldPosition);
  }

  // `offset` is a uniform rather than image data, so stepping a frame costs a
  // matrix update and never a texture upload -- which matters, because this runs
  // once a frame for every missile in the air.
  _applyMissileFrame(texture) {
    const cell = 1 / BZFLAG_MISSILE_ANIM_CELLS;
    texture.offset.set(texture.userData.u * cell, texture.userData.v * cell);
  }

  // BoltSceneNode.cxx:864, on the last frame of each render: step one cell along,
  // wrapping to the next row and then back to the start.
  advanceMissileFrames(projectiles) {
    // One read for the whole pass: the flares billboard against the camera, and
    // it does not move between two missiles inside a frame.
    let cameraWorldPosition = null;
    if (this.camera) {
      cameraWorldPosition = this._gmFlareCameraPosition
        || (this._gmFlareCameraPosition = new THREE.Vector3());
      this.camera.getWorldPosition(cameraWorldPosition);
    }
    projectiles.forEach((projectile) => {
      const flares = projectile?.userData?.guidedFlares;
      if (flares) this._updateGMFlares(flares, cameraWorldPosition);
      const texture = projectile?.userData?.missileTexture;
      if (!texture?.userData) return;
      texture.userData.u += 1;
      if (texture.userData.u === BZFLAG_MISSILE_ANIM_CELLS) {
        texture.userData.u = 0;
        texture.userData.v = (texture.userData.v + 1) % BZFLAG_MISSILE_ANIM_CELLS;
      }
      this._applyMissileFrame(texture);
    });
  }

  _paintTintedBZFlagTailTexture(ctx, canvas, image, baseColor) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!image) {
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
      gradient.addColorStop(1, '#ffff66');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, canvas.height * 0.3, canvas.width, canvas.height * 0.4);
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
      const shaded = 0.3 + (luminance * 0.95);
      data[i] = Math.max(0, Math.min(255, tintR * shaded));
      data[i + 1] = Math.max(0, Math.min(255, tintG * shaded));
      data[i + 2] = Math.max(0, Math.min(255, tintB * shaded));
      data[i + 3] = Math.max(0, Math.min(255, alpha * 0.9));
    }

    ctx.putImageData(imageData, 0, 0);
  }

  _createShotTailTexture(baseColor) {
    return this._createTintedTexture(
      '/textures/shot_tail.png', 128, 32, this._paintTintedBZFlagTailTexture, baseColor);
  }

  // A shot's look is decided entirely by the colour of whoever fired it, and a
  // colour is a property of a player rather than of a shot. So everything a
  // bolt wears is built once for a colour and then shared by every shot of it:
  // tinting a texture reads a whole canvas back and walks it pixel by pixel,
  // and a shot that built its own paid that twice and uploaded two textures,
  // for a shape identical to the last shot the same tank fired.
  //
  // The same fact is what lets a colour's shots ride in two `InstancedMesh`es
  // -- one for the bolts, one for every segment of every trail -- instead of
  // seven sprites and seven draw calls each. A busy server draws three times
  // as many colours as are shooting, rather than seven times as many shots as
  // are in the air.
  //
  // A guided missile is the exception and keeps a sprite of its own: its sheet
  // steps a cell a frame (`advanceMissileFrames`), so two missiles sharing one
  // texture would animate in lockstep and, worse, step it twice as fast.
  _getShotColorCache(color) {
    if (!this._shotColorCache) this._shotColorCache = new Map();
    let entry = this._shotColorCache.get(color);
    if (!entry) {
      entry = { bolt: null, tailSheet: null, headMesh: null, tailMesh: null, capacity: 0 };
      this._shotColorCache.set(color, entry);
    }
    return entry;
  }

  _preloadGMModel() {
    if (this._gmModelParts || this._gmModelLoading) return;
    this._gmModelLoading = true;
    new OBJLoader().load(BZFLAG_GM_MODEL_PATH, (obj) => {
      const parts = [];
      obj.traverse((child) => {
        if (child.isMesh) parts.push([child.name, child.geometry]);
      });
      this._gmModelParts = parts;
    }, undefined, () => {
      this._gmModelLoading = false;
    });
  }

  // Null until the model has loaded; a missile fired before then is drawn as
  // the bolt alone.
  _getGMModelGeometry(color) {
    if (!this._gmModelParts) return null;
    const entry = this._getShotColorCache(color);
    if (!entry.gmModel) entry.gmModel = buildGMModelGeometry(this._gmModelParts, color);
    return entry.gmModel;
  }

  // Unlit, as upstream draws it, and two-sided: its fins are single quads.
  _getGMModelMaterial() {
    if (!this._gmModelMaterial) {
      this._gmModelMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    }
    return this._gmModelMaterial;
  }

  _getShotBoltTexture(color) {
    const entry = this._getShotColorCache(color);
    if (!entry.bolt) entry.bolt = this._createBoltTexture(color);
    return entry.bolt;
  }

  _getShotTailSheet(color) {
    const entry = this._getShotColorCache(color);
    if (!entry.tailSheet) entry.tailSheet = this._createShotTailTexture(color);
    return entry.tailSheet;
  }

  // Grown in powers of two and never shrunk, so a colour that once had a lot in
  // the air does not rebuild its buffers the next time it does.
  _getShotBatch(color, needed) {
    const entry = this._getShotColorCache(color);
    if (entry.headMesh && entry.capacity >= needed) return entry;

    let capacity = Math.max(BZFLAG_SHOT_BATCH_MIN_CAPACITY, entry.capacity || 0);
    while (capacity < needed) capacity *= 2;
    this._disposeShotBatch(entry);

    entry.capacity = capacity;
    entry.headMesh = buildShotBatchMesh(this._getShotBoltTexture(color), capacity, {
      cells: 1, additive: false,
    });
    entry.tailMesh = buildShotBatchMesh(
      this._getShotTailSheet(color), capacity * BZFLAG_SHOT_TAIL_SEGMENTS,
      { cells: BZFLAG_SHOT_TAIL_CELLS, additive: true },
    );
    this.worldFrame.add(this._tagDraws(entry.headMesh, 'effect'));
    this.worldFrame.add(this._tagDraws(entry.tailMesh, 'effect'));
    return entry;
  }

  _disposeShotBatch(entry) {
    for (const mesh of [entry.headMesh, entry.tailMesh]) {
      if (!mesh) continue;
      this.worldFrame?.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
    entry.headMesh = null;
    entry.tailMesh = null;
  }

  // Every bolt in the world, written into its colour's two meshes. Rebuilt
  // whole each frame rather than kept in slots: the caller already walks every
  // shot to move it, so a free list would buy bookkeeping and nothing else --
  // and a shot that ends leaves no hole to find.
  updateShotVisuals(projectiles) {
    const batches = this._shotColorCache;
    if (batches) {
      for (const entry of batches.values()) {
        if (entry.headMesh) entry.headMesh.count = 0;
        if (entry.tailMesh) entry.tailMesh.count = 0;
      }
    }
    if (!projectiles) return;

    // Counted before anything is written, so a colour's meshes are grown once
    // for the frame rather than once per shot that overflows them.
    const perColor = new Map();
    projectiles.forEach((projectile) => {
      const state = projectile?.userData;
      if (!state || state.beam || state.shockwave || !state.tailCells) return;
      perColor.set(state.color, (perColor.get(state.color) || 0) + 1);
    });
    if (perColor.size === 0) return;
    for (const [color, needed] of perColor) this._getShotBatch(color, needed);

    if (!this._shotBatchDummy) this._shotBatchDummy = new THREE.Object3D();
    const dummy = this._shotBatchDummy;
    const step = 1 / BZFLAG_SHOT_TAIL_CELLS;

    projectiles.forEach((projectile) => {
      const state = projectile?.userData;
      if (!state || state.beam || state.shockwave || !state.tailCells) return;
      const batch = this._shotColorCache.get(state.color);
      const { x, y, z } = projectile.position;

      // A missile's head is its own animated sprite, so only its trail rides
      // here; every other shot puts its bolt in as well.
      if (!state.guidedHead) {
        const head = batch.headMesh;
        dummy.position.set(x, y, z);
        dummy.scale.set(BZFLAG_SHOT_HEAD_SCALE, BZFLAG_SHOT_HEAD_SCALE, 1);
        dummy.updateMatrix();
        head.setMatrixAt(head.count, dummy.matrix);
        head.geometry.attributes.instanceAlpha.setX(head.count, 1);
        head.count += 1;
      }

      // renderGeoGMBolt's frame: nose along the flight, rolling about it.
      if (state.guidedModel) {
        const model = state.guidedModel;
        GM_MODEL_FORWARD.set(state.tailDirX, state.tailDirY, state.tailDirZ);
        model.quaternion.setFromUnitVectors(GM_MODEL_AXIS, GM_MODEL_FORWARD);
        GM_MODEL_ROLL.setFromAxisAngle(
          GM_MODEL_AXIS, THREE.MathUtils.degToRad(((performance.now() / 1000) * BZFLAG_GM_MODEL_ROLL) % 360),
        );
        model.quaternion.multiply(GM_MODEL_ROLL);
      }

      const tail = batch.tailMesh;
      for (let i = 0; i < BZFLAG_SHOT_TAIL_SEGMENTS; i += 1) {
        const distance = BZFLAG_SHOT_TAIL_DISTANCES[i];
        const scale = BZFLAG_SHOT_TAIL_SCALES[i];
        dummy.position.set(
          x - (state.tailDirX * distance),
          y - (state.tailDirY * distance),
          z - (state.tailDirZ * distance),
        );
        dummy.scale.set(scale, scale, 1);
        dummy.updateMatrix();
        tail.setMatrixAt(tail.count, dummy.matrix);
        const cell = state.tailCells[i];
        tail.geometry.attributes.instanceUvOffset.setXY(
          tail.count,
          (cell % BZFLAG_SHOT_TAIL_CELLS) * step,
          Math.floor(cell / BZFLAG_SHOT_TAIL_CELLS) * step,
        );
        tail.geometry.attributes.instanceAlpha.setX(tail.count, BZFLAG_SHOT_TAIL_ALPHAS[i]);
        tail.count += 1;
      }
    });

    for (const color of perColor.keys()) {
      const batch = this._shotColorCache.get(color);
      batch.headMesh.instanceMatrix.needsUpdate = true;
      batch.headMesh.geometry.attributes.instanceAlpha.needsUpdate = true;
      batch.tailMesh.instanceMatrix.needsUpdate = true;
      batch.tailMesh.geometry.attributes.instanceUvOffset.needsUpdate = true;
      batch.tailMesh.geometry.attributes.instanceAlpha.needsUpdate = true;
    }
  }

  // One sheet per source image for the whole session. An impact used to build
  // its own 512x512 canvas and upload a texture off it, for a picture with no
  // per-impact variation in it at all -- the frame it is on and the angle it
  // sits at are the sprite's, not the image's.
  //
  // The clone is what keeps the frame per impact: `Texture.clone()` copies
  // `.source` by reference, so every impact samples the one uploaded sheet
  // while carrying its own `offset` to walk it with.
  _getShotExplosionSheet(sourcePath) {
    if (!this._shotExplosionSheets) this._shotExplosionSheets = new Map();
    let sheet = this._shotExplosionSheets.get(sourcePath);
    if (!sheet) {
      sheet = this._buildShotExplosionSheet(sourcePath);
      this._shotExplosionSheets.set(sourcePath, sheet);
    }
    return sheet;
  }

  _createShotExplosionTexture() {
    const sourcePath = SHOT_EXPLOSION_TEXTURES[Math.floor(Math.random() * SHOT_EXPLOSION_TEXTURES.length)];
    const texture = this._getShotExplosionSheet(sourcePath).clone();
    texture.repeat.set(1 / 8, 1 / 8);
    texture.offset.set(0, 0);
    texture.needsUpdate = true;
    return texture;
  }

  _buildShotExplosionSheet(sourcePath) {
    const source = this._getSharedImage(sourcePath);
    const { texture, redraw } = this._createCanvasBackedImageTexture(512, 512, (ctx, canvas) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (source.loaded) {
        ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
      } else {
        const gradient = ctx.createRadialGradient(
          canvas.width * 0.5,
          canvas.height * 0.5,
          canvas.width * 0.06,
          canvas.width * 0.5,
          canvas.height * 0.5,
          canvas.width * 0.45
        );
        gradient.addColorStop(0, 'rgba(255, 255, 220, 1)');
        gradient.addColorStop(0.45, 'rgba(255, 180, 90, 0.9)');
        gradient.addColorStop(1, 'rgba(255, 80, 20, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    });
    texture.colorSpace = THREE.SRGBColorSpace;

    if (!source.loaded) {
      source.listeners.push(redraw);
    }

    return texture;
  }

  // Walking an atlas moves the sampler, not the pixels: `repeat` and `offset`
  // reach the shader as uniforms. Flagging the texture would re-upload the whole
  // 512x512 explosion sheet on every frame of every impact.
  _setSpriteAtlasFrame(texture, frameIndex, columns, rows) {
    if (!texture) return;
    const totalFrames = Math.max(1, columns * rows);
    const clamped = Math.max(0, Math.min(totalFrames - 1, frameIndex));
    const column = clamped % columns;
    const row = Math.floor(clamped / columns);
    texture.repeat.set(1 / columns, 1 / rows);
    texture.offset.set(column / columns, row / rows);
  }

  createShotImpact(at) {
    if (!this.scene || !at) return;
    const position = at;

    const texture = this._createShotExplosionTexture();
    this._setSpriteAtlasFrame(texture, 0, 8, 8);
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    material.rotation = Math.random() * Math.PI * 2;

    // Where the shot actually ended. The sprite is offset from it every frame,
    // so the offset is taken from this rather than from wherever the sprite was
    // left last time.
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(origin);
    sprite.scale.set(shotExplosionSize(), shotExplosionSize(), 1);
    sprite.renderOrder = SHOT_EXPLOSION_RENDER_ORDER;
    this.worldFrame.add(this._tagDraws(sprite, 'effect'));
    // A shot ends on the surface it struck, and a quad standing on that point
    // is half inside it. `_faceShotExplosion` lifts it clear -- see there.
    this._faceShotExplosion(sprite, origin);

    let light = null;
    if (this._dynamicLightingActive()) {
      light = this._createDynamicLight(0xffcc80, bzflagLightIntensity(BZFLAG_SHOT_IMPACT_LIGHT_SCALE));
      light.position.copy(position);
    }

    this.activeShotExplosions.push({
      sprite,
      material,
      texture,
      origin,
      duration: BZFLAG_SHOT_EXPLOSION_DURATION,
      age: 0,
      light,
      lightFadeStart: BZFLAG_SHOT_EXPLOSION_DURATION * BZFLAG_SHOT_EXPLOSION_LIGHT_FADE_START_RATIO,
      lightBaseIntensity: light ? light.intensity : 0,
    });
  }

  // `BillboardSceneNode::BillboardRenderNode::render` (`:357-375`): "want to
  // move the billboard directly towards the eye a little bit". A shot ends on
  // the face it struck, and a camera-facing quad centred there is half buried
  // in the wall -- so upstream slides it along the line from the explosion to
  // the eye by the quad's own half width, which is exactly far enough that no
  // part of it can still be behind the surface.
  //
  // Along the line to the eye rather than towards the camera's own forward
  // axis, which upstream's comment is careful about: the two are only the same
  // for something dead centre in the view, and moving along the view axis
  // would leave an explosion at the edge of the screen still in the wall.
  //
  // Every frame, because the eye moves even when the explosion does not.
  _faceShotExplosion(sprite, origin) {
    if (!sprite || !origin || !this.camera || !this.worldFrame) return;
    this.camera.updateWorldMatrix(true, false);
    this.worldFrame.updateWorldMatrix(true, false);
    const eye = this.camera.getWorldPosition(SHOT_EXPLOSION_EYE_SCRATCH);
    this.worldFrame.worldToLocal(eye);
    eye.sub(origin);
    const distance = eye.length();
    if (!(distance > 1e-6)) return;
    eye.multiplyScalar((shotExplosionSize() * 0.5) / distance);
    sprite.position.copy(origin).add(eye);
  }

  // Player::addPlayer's pausedSphere (Player.cxx:1004): a black sphere at half
  // alpha around a tank that is paused, sitting on the tank's own position and
  // wide enough to enclose it.
  createPausedSphere({ x, y, z, radius }) {
    if (!this.scene) return null;
    const geometry = new THREE.SphereGeometry(radius, 16, 16);
    const material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.5,
    });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.position.set(x, y, z);
    this.worldFrame.add(this._tagDraws(sphere, 'effect'));
    return sphere;
  }

  // The marker is one sprite, made once and moved: it always faces the viewer,
  // which is what upstream's screen-space bracket is for, and a sprite does that
  // in a headset as readily as in a window. Depth testing is off because a lock
  // is a HUD element -- upstream's is drawn over everything, and a target that
  // ducks behind a wall is exactly when you want to know where it went.
  // A set of coloured line segments drawn over the world, for whatever the
  // client wants to show without a mesh of its own -- the autopilot's plan. One
  // draw for all of them, through walls, so a route behind a building is still
  // a route. `segments` is `[{ a, b, color }]`, or empty to hide it.
  setOverlaySegments(segments) {
    if (!this.scene) return;
    const count = Math.min(segments?.length || 0, OVERLAY_MAX_SEGMENTS);
    if (count === 0) {
      if (this.overlayLines) this.overlayLines.visible = false;
      return;
    }
    if (!this.overlayLines) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(OVERLAY_MAX_SEGMENTS * 6), 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(OVERLAY_MAX_SEGMENTS * 6), 3));
      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      });
      this.overlayLines = new THREE.LineSegments(geometry, material);
      this.overlayLines.frustumCulled = false;
      this.overlayLines.renderOrder = SHOT_RENDER_ORDER + 2;
      this.worldFrame.add(this._tagDraws(this.overlayLines, 'effect'));
    }
    const geometry = this.overlayLines.geometry;
    const positions = geometry.attributes.position.array;
    const colors = geometry.attributes.color.array;
    const color = this._overlayColor || (this._overlayColor = new THREE.Color());
    for (let i = 0; i < count; i++) {
      const { a, b } = segments[i];
      color.setHex(segments[i].color);
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      colors.set([color.r, color.g, color.b, color.r, color.g, color.b], i * 6);
    }
    geometry.setDrawRange(0, count * 2);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    this.overlayLines.visible = true;
  }

  // `_forbidMarkers` takes it away, as it does upstream's whole
  // `drawMarkersInView` (HUDRenderer.cxx:1761).
  setLockOnMarker(position, color, forbidden = false) {
    if (!this.scene) return;
    if (!position || forbidden) {
      if (this.lockOnMarker) this.lockOnMarker.visible = false;
      return;
    }
    if (!this.lockOnMarker) {
      const material = new THREE.SpriteMaterial({
        map: this._getLockOnTexture(),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: BZFLAG_LOCKON_ALPHA,
      });
      this.lockOnMarker = new THREE.Sprite(material);
      this.lockOnMarker.scale.set(BZFLAG_LOCKON_WORLD_SIZE, BZFLAG_LOCKON_WORLD_SIZE, 1);
      this.lockOnMarker.renderOrder = SHOT_RENDER_ORDER + 1;
      this.worldFrame.add(this._tagDraws(this.lockOnMarker, 'effect'));
    }
    this.lockOnMarker.visible = true;
    this.lockOnMarker.position.set(position.x, position.y, position.z);
    if (typeof color === 'number') this.lockOnMarker.material.color.setHex(color);
  }

  _getLockOnTexture() {
    if (this._lockOnTexture) return this._lockOnTexture;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    // Upstream's box is +/-40 with a little air around it, so the marker keeps
    // its shape rather than touching the edge of its own texture.
    const unit = (size * 0.45) / BZFLAG_LOCKON_SIZE;
    const half = size / 2;
    const at = (x, y) => [half + (x * unit), half - (y * unit)];
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = BZFLAG_LOCKON_LINE_WIDTH * unit;
    ctx.lineJoin = 'miter';
    for (const side of [-1, 1]) {
      const points = [
        [side * BZFLAG_LOCKON_INSET, BZFLAG_LOCKON_SIZE - BZFLAG_LOCKON_DECLINATION],
        [side * BZFLAG_LOCKON_SIZE, BZFLAG_LOCKON_SIZE],
        [side * BZFLAG_LOCKON_SIZE, -BZFLAG_LOCKON_SIZE],
        [side * BZFLAG_LOCKON_INSET, -BZFLAG_LOCKON_SIZE + BZFLAG_LOCKON_DECLINATION],
      ];
      ctx.beginPath();
      points.forEach(([x, y], index) => {
        const [px, py] = at(x, y);
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    this._lockOnTexture = new THREE.CanvasTexture(canvas);
    this._lockOnTexture.colorSpace = THREE.SRGBColorSpace;
    return this._lockOnTexture;
  }

  // SmokeGMPuffEffect (effectsRenderer.cxx:1477), which is `gmPuffEffect`'s own
  // default. A puff is one billboarded quad from a random quadrant of the puff
  // sheet, jittered off the missile's path, drifting upward and spinning as it
  // swells and fades. Upstream leaves one behind every `gmPuffTime`; the trail
  // is what a missile looks like from anywhere but behind it.
  // One puff per `gmPuffTime` of flight, whatever the frame rate: the clock is
  // the missile's own, so a slow frame leaves the same trail as a fast one.
  trailGMPuffs(projectile, deltaTime) {
    if (!projectile || !(deltaTime > 0)) return;
    const state = projectile.userData;
    // GuidedMissileStrategy::update: a puff once the missile has flown its
    // current wait, then a fresh random wait up to `rootPuff` -- so never more
    // than one a frame, and at quality 3's `rootPuff` very nearly one every
    // frame.
    if (!(state.puffRoot > 0)) {
      state.puffRoot = BZFLAG_GM_PUFF_INTERVAL
        / (BZFLAG_GM_PUFF_QUALITY_DIVISOR + (Math.random() * BZFLAG_GM_PUFF_QUALITY_DIVISOR_RANGE));
      state.puffWait = Math.random() * state.puffRoot;
      state.puffTimer = 0;
    }
    state.puffTimer += deltaTime;
    if (state.puffTimer <= state.puffWait) return;
    state.puffTimer = 0;
    state.puffWait = Math.random() * state.puffRoot;
    this.createGMPuff(projectile.position);
  }

  _getGMPuffMesh() {
    if (this._gmPuffMesh) return this._gmPuffMesh;
    const texture = this._createTintedTexture(
      BZFLAG_GM_PUFF_TEXTURE, 256, 256, this._paintGMPuffSheet, null);
    this._gmPuffMesh = buildGMPuffMesh(texture);
    this._gmPuffNext = 0;
    this._gmPuffClock = this._gmPuffClock || 0;
    this.worldFrame.add(this._tagDraws(this._gmPuffMesh, 'effect'));
    return this._gmPuffMesh;
  }

  // One puff into the ring: where, when, and which quadrant of the sheet
  // upstream picked for it. The oldest slot is the one reused.
  createGMPuff(position) {
    if (!this.scene || !this.worldFrame || !position) return;
    const mesh = this._getGMPuffMesh();
    const { geometry } = mesh;
    const slot = this._gmPuffNext;
    this._gmPuffNext = (slot + 1) % GM_PUFF_CAPACITY;
    geometry.instanceCount = Math.max(geometry.instanceCount, slot + 1);

    const jitter = () => (Math.random() * BZFLAG_GM_PUFF_JITTER * 2) - BZFLAG_GM_PUFF_JITTER;
    const origin = geometry.getAttribute('puffOrigin');
    origin.setXYZ(slot, position.x + jitter(), position.y + jitter(), position.z + jitter());
    const birth = geometry.getAttribute('puffBirth');
    birth.setX(slot, this._gmPuffClock);
    // The sheet is drawn the right way up, so its top row is the top of `v`.
    const quadrant = Math.floor(Math.random() * BZFLAG_GM_PUFF_CELLS * BZFLAG_GM_PUFF_CELLS);
    const cell = 1 / BZFLAG_GM_PUFF_CELLS;
    const column = quadrant % BZFLAG_GM_PUFF_CELLS;
    const row = Math.floor(quadrant / BZFLAG_GM_PUFF_CELLS);
    const uv = geometry.getAttribute('puffCell');
    uv.setXY(slot, column * cell, (BZFLAG_GM_PUFF_CELLS - 1 - row) * cell);
    for (const [attribute, size] of [[origin, 3], [birth, 1], [uv, 2]]) {
      attribute.addUpdateRange(slot * size, size);
      attribute.needsUpdate = true;
    }
  }

  // Only the clock moves: every puff's fade, swell, drift and spin follow from
  // it in the shader.
  updateGMPuffs(deltaTime) {
    if (!(deltaTime > 0)) return;
    this._gmPuffClock = (this._gmPuffClock || 0) + deltaTime;
    if (this._gmPuffMesh) this._gmPuffMesh.material.uniforms.time.value = this._gmPuffClock;
  }

  // The whole puff sheet; a puff picks its quadrant by UV.
  _paintGMPuffSheet(ctx, canvas, image) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!image) return;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }

  removePausedSphere(sphere) {
    if (!sphere || !this.scene) return;
    this.worldFrame.remove(sphere);
    if (sphere.geometry) sphere.geometry.dispose();
    if (sphere.material) sphere.material.dispose();
  }

  createLandingEffect(at, intensity = 1, { local = false, silent = false } = {}) {
    if (!this.scene || !at) return;
    const clampedIntensity = Math.max(0.4, Math.min(1.6, intensity || 1));
    // BZFlag has no per-sound gain, so landing volume does not vary with impact
    // speed. The intensity argument still drives the visual landing effect.
    // `silent` is a caller that has already sounded the bounce this frame; the
    // effect still draws, since upstream's is not part of that else-chain.
    if (!silent) {
      if (local) this.playLocalSound('land');
      else this.playSound('land', at);
    }

    // StdLandEffect (effectsRenderer.cxx:1379): drawRingXY builds a shell
    // between a base ring flat on the ground and a top ring that is both
    // wider and higher, so the dirt flares up and out rather than sitting flat
    // -- a splash, not a halo. The 1.05 taper is upstream's `0.05f*radius`
    // topside offset, always a twentieth of the (growing) base radius, which
    // is why a unit cylinder scaled by that one radius keeps the ratio.
    const ringGeometry = new THREE.CylinderGeometry(1.05, 1, 1, 32, 1, true);
    ringGeometry.translate(0, 0.5, 0);
    standUpGeometry(ringGeometry);
    // `dusty_flare`, the same texture the shot-teleport collar wears -- a
    // speckle of dots dense at one edge and fading to nothing at the other,
    // which is what reads as thrown dirt rather than a flat lit ring.
    const ringMaterial = new THREE.MeshBasicMaterial({
      map: this._getShotTeleportTexture(),
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1.0,
      depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.set(at.x, at.y, at.z + 0.03);

    const startRadius = 2.5;
    // The top ring starts half a unit up (upstream's `0.5f + age`, age zero).
    ring.scale.set(startRadius, startRadius, 0.5);

    this.worldFrame.add(this._tagDraws(ring, 'effect'));
    this.activeLandingEffects.push({
      ring,
      geometry: ringGeometry,
      material: ringMaterial,
      intensity: clampedIntensity,
      startRadius,
      expansionRate: 3.5,
      lifetime: 0,
      maxLifetime: 1.0
    });
  }

  createSpawnEffect(at, color = 0x4caf50) {
    if (!this.scene || !at) return;
    this.playSound('pop', at);

    const tint = new THREE.Color(typeof color === 'number' ? color : 0x4caf50)
      .lerp(new THREE.Color(0xffffff), 0.35);

    const ringGeometry = new THREE.RingGeometry(0.7, 1.1, 48);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: tint,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.set(at.x, at.y, at.z + 0.05);
    ring.scale.set(0.7, 0.7, 1);

    const columnGeometry = standUpGeometry(new THREE.CylinderGeometry(0.28, 0.55, 3.0, 18, 1, true));
    const columnMaterial = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const column = new THREE.Mesh(columnGeometry, columnMaterial);
    column.position.set(at.x, at.y, at.z + 1.5);
    column.scale.set(0.4, 0.4, 0.3);

    const topRingGeometry = new THREE.RingGeometry(0.45, 0.78, 40);
    const topRingMaterial = new THREE.MeshBasicMaterial({
      color: tint,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const topRing = new THREE.Mesh(topRingGeometry, topRingMaterial);
    topRing.position.set(at.x, at.y, at.z + 1.35);
    topRing.scale.set(0.65, 0.65, 1);

    this.worldFrame.add(this._tagDraws(ring, 'effect'));
    this.worldFrame.add(this._tagDraws(column, 'effect'));
    this.worldFrame.add(this._tagDraws(topRing, 'effect'));

    this.activeSpawnEffects.push({
      ring,
      ringGeometry,
      ringMaterial,
      column,
      columnGeometry,
      columnMaterial,
      topRing,
      topRingGeometry,
      topRingMaterial,
      lifetime: 0,
      maxLifetime: 0.75,
    });
  }

  createProjectile(data) {
    if (!this.scene) return null;
    const projectileColor = typeof data.color === 'number' ? data.color : 0xffff00;
    const guided = data.guided === true;
    // In `worldFrame`, at the game's position.
    const projectile = new THREE.Group();
    projectile.position.set(data.x, data.y, data.z);

    // The trail hangs level behind the shot.
    const dir = new THREE.Vector3(data.dirX || 0, data.dirY || 1, 0);
    if (dir.lengthSq() < 0.0001) {
      dir.set(0, 1, 0);
    } else {
      dir.normalize();
    }

    // Six consecutive cells of the wisp sheet from a random start, so two shots
    // in the air never wear the same trail. Which cell a segment shows reaches
    // the batch as an instance attribute, so the sheet itself stays one texture
    // for the whole colour.
    const tailCellCount = BZFLAG_SHOT_TAIL_CELLS * BZFLAG_SHOT_TAIL_CELLS;
    const tailCells = [];
    let uvCell = Math.floor(Math.random() * tailCellCount);
    for (let i = 0; i < BZFLAG_SHOT_TAIL_SEGMENTS; i += 1) {
      uvCell = (uvCell + 1) % tailCellCount;
      tailCells.push(uvCell);
    }

    projectile.userData = {
      color: projectileColor,
      // Where the trail hangs. Normalized at the muzzle and rewritten by
      // `aimProjectile` for a missile, which is the only shot that turns.
      tailDirX: dir.x,
      tailDirY: dir.y,
      tailDirZ: dir.z,
      tailCells,
    };

    // A missile animates, so it keeps a sprite and a sheet of its own; every
    // other bolt is drawn by its colour's batch -- see `_getShotColorCache`.
    if (guided) {
      const missileTexture = this._createMissileTexture(projectileColor);
      const head = new THREE.Sprite(new THREE.SpriteMaterial({
        map: missileTexture,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
      }));
      head.scale.set(BZFLAG_SHOT_HEAD_SCALE, BZFLAG_SHOT_HEAD_SCALE, 1);
      head.renderOrder = SHOT_RENDER_ORDER;
      projectile.add(head);
      projectile.userData.guidedHead = head;
      // Under the head rather than over it, as upstream draws the flares before
      // the billboard square: the sprite covers the inner ends of the spikes,
      // so they read as coming out of the bolt and not as crossing it.
      const flares = this._createGMFlares();
      projectile.add(flares);
      projectile.userData.guidedFlares = flares;
      // And the missile itself, over the bolt as upstream draws it at quality
      // 3 -- turned along the flight and rolled by `updateShotVisuals`.
      // The model wears the shooter's own colour flat, not the bolt's lifted one.
      const modelColor = typeof data.modelColor === 'number' ? data.modelColor : projectileColor;
      const modelGeometry = this._getGMModelGeometry(modelColor);
      if (modelGeometry) {
        const model = new THREE.Mesh(modelGeometry, this._getGMModelMaterial());
        model.scale.setScalar(getFlagTuning().gmSize);
        projectile.add(model);
        projectile.userData.guidedModel = model;
      }
      projectile.userData.projectileTexture = missileTexture;
      // Only a missile's sheet is stepped; every other shot is one still image.
      projectile.userData.missileTexture = missileTexture;
    }
    projectile.renderOrder = SHOT_RENDER_ORDER;
    // Only add a point light if dynamic lighting is enabled
    if (this._dynamicLightingActive()) {
      const shotLight = this._createDynamicLight(
        projectileColor,
        bzflagLightIntensity(BZFLAG_SHOT_LIGHT_SCALE),
      );
      shotLight.position.copy(projectile.position);
      projectile.userData.shotLight = shotLight;
      // Track for update/removal
      if (!this.projectileLights) this.projectileLights = new Map();
      this.projectileLights.set(projectile, shotLight);
    }
    this.worldFrame.add(this._tagDraws(projectile, 'effect'));
    // Upstream picks the report off the firing flag rather than playing SFX_FIRE
    // for everything (playing.cxx:2956); a guided missile is the second shot bzo
    // has that takes a sound of its own.
    this.playSound(typeof data.fireSound === 'string' ? data.fireSound : 'fire', projectile.position);
    this.createMuzzleFlash(projectile.position, dir);
    return projectile;
  }

  // The trail hangs behind the shot along the direction it was fired, which is
  // set once and never revisited -- except for a guided missile, whose direction
  // is a new answer every step. Re-laying six sprite positions is cheaper than
  // rotating the group, and it is the only thing about the shot that moves.
  aimProjectile(projectile, direction) {
    const state = projectile?.userData;
    if (!state?.tailCells) return;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!(length > 0)) return;
    state.tailDirX = direction.x / length;
    state.tailDirY = direction.y / length;
    state.tailDirZ = direction.z / length;
  }

  // LaserStrategy's laser scene nodes: one quad per segment of a path that was
  // built whole the moment the trigger was pulled. bzo takes the segments from
  // the server, which traced them, and draws a thin additive tube along each --
  // upstream textures its beam and bzo has no such texture, which is the only
  // difference. The group sits at the muzzle so the shot still has a position
  // for the radar and for its sounds.
  // Upstream's grey laser (`rabbit_laser.png`, the one team laser with no hue
  // of its own) in a shooter's colour, by the same tint shell bolts take, kept
  // per colour since a beam lives a fraction of a second.
  _getLaserTexture(color) {
    if (!this._laserTextures) this._laserTextures = new Map();
    let texture = this._laserTextures.get(color);
    if (!texture) {
      texture = this._createTintedTexture(
        BZFLAG_LASER_TEXTURE, 64, 64, this._paintTintedBZFlagBoltTexture, color);
      this._laserTextures.set(color, texture);
    }
    return texture;
  }

  createShotBeam(data) {
    if (!this.scene) return null;
    const beamColor = typeof data.color === 'number' ? data.color : 0xffff00;
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const origin = segments.length > 0 ? segments[0].from : { x: data.x, y: data.y, z: data.z };
    // In `worldFrame`, upstream's, as the segments are.
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y, origin.z);
    group.renderOrder = SHOT_RENDER_ORDER;

    // LaserSceneNode::renderFlatLaser, upstream's laser at its default quality:
    // two crossed quads along each segment, two units wide, the laser texture
    // across their width and stretched once along their length, with a small
    // star facing down the beam where each segment starts. Drawn white over the
    // texture, so the colour is the texture's own -- here, upstream's grey
    // laser in the shooter's colour (`_getLaserTexture`) -- and added in
    // (`GL_SRC_ALPHA, GL_ONE`) with nothing culled. One instanced draw for every
    // segment, however many bends a ricochet gives the beam.
    if (!this._laserGeometry) this._laserGeometry = buildFlatLaserGeometry();
    const materials = [];
    const layers = [];
    const up = new THREE.Vector3(0, 1, 0);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const drawn = segments.filter((segment) => segment?.from && segment?.to
      && Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y,
        segment.to.z - segment.from.z) > 0.01);

    if (drawn.length > 0) {
      const material = new THREE.MeshBasicMaterial({
        map: this._getLaserTexture(beamColor),
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.InstancedMesh(this._laserGeometry, material, drawn.length);
      mesh.frustumCulled = false;
      mesh.renderOrder = SHOT_RENDER_ORDER;
      drawn.forEach((segment, index) => {
        from.set(segment.from.x, segment.from.y, segment.from.z);
        to.set(segment.to.x, segment.to.y, segment.to.z);
        direction.subVectors(to, from);
        const length = direction.length();
        orientation.setFromUnitVectors(up, direction.divideScalar(length));
        scale.set(1, length, 1);
        mesh.setMatrixAt(index, matrix.compose(from.sub(group.position), orientation, scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
      materials.push(material);
      layers.push(mesh);
    }

    group.userData = { beam: true, beamMaterials: materials, beamLayers: layers, color: beamColor };
    this.worldFrame.add(this._tagDraws(group, 'effect'));
    // The shooter has already heard and seen its own shot leave the barrel; this
    // message is what tells it where the beam went.
    if (!data.silent) {
      this.playSound(typeof data.fireSound === 'string' ? data.fireSound : 'fire', group.position);
      if (drawn.length > 0) {
        const first = drawn[0];
        const flashDir = new THREE.Vector3(
          first.to.x - first.from.x, first.to.y - first.from.y, first.to.z - first.from.z,
        );
        this.createMuzzleFlash(group.position, flashDir.normalize());
      }
    }

    // SegmentedShotStrategy::update plays SFX_RICOCHET at the start of each
    // reflected segment and adds a teleport effect where a shot crossed a
    // portal. A laser is already at the end of its path the first time it
    // updates (LaserStrategy's constructor sets the current time to the last
    // one), so upstream announces every bend at once and so does this.
    for (let i = 1; i < segments.length; i += 1) {
      const cause = segments[i - 1].end;
      const at = segments[i].from;
      if (cause === 'obstacle' || cause === 'ground') {
        this.playSound('ricochet', at);
        const before = segments[i - 1];
        this.createRicochetEffect(at, {
          x: (segments[i].to.x - segments[i].from.x) - (before.to.x - before.from.x),
          y: (segments[i].to.y - segments[i].from.y) - (before.to.y - before.from.y),
          z: (segments[i].to.z - segments[i].from.z) - (before.to.z - before.from.z),
        });
      } else if (cause === 'teleport') {
        this.playSound('teleport', at);
      }
    }
    return group;
  }

  // ShockWaveStrategy's scene node: one translucent team-coloured sphere sitting
  // where the tank fired it, scaled to the radius the flags module computes and
  // faded as it swells. `getShockWaveAlpha` says why this is upstream's low
  // quality wave rather than its default one -- the default inverts the colour
  // of everything inside the sphere, and WebGL has no logic op to invert with.
  //
  // Double-sided, because the wave grows past the camera and the inside of the
  // ball is most of what you see of your own; and depth-write off, because it is
  // a translucent shell that everything else has to stay visible through.
  createShotShockWave(data) {
    if (!this.scene) return null;
    const waveColor = typeof data.color === 'number' ? data.color : 0xffff00;
    // One sphere geometry for every wave ever drawn: the radius lives in the
    // scale, so nothing here is rebuilt as the wave grows.
    if (!this._shockWaveGeometry) {
      this._shockWaveGeometry = new THREE.SphereGeometry(1, 24, 16);
    }
    const material = new THREE.MeshBasicMaterial({
      color: waveColor,
      transparent: true,
      opacity: getShockWaveAlpha(getShotEffects('SW').shockInRadius),
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this._shockWaveGeometry, material);
    mesh.scale.setScalar(Math.max(getShotEffects('SW').shockInRadius, 1e-3));
    mesh.frustumCulled = false;
    mesh.renderOrder = SHOT_RENDER_ORDER;

    // In `worldFrame`, upstream's; a sphere has no up to stand.
    const group = new THREE.Group();
    group.position.set(data.x, data.y, data.z);
    group.renderOrder = SHOT_RENDER_ORDER;
    group.add(mesh);
    group.userData = { shockwave: true, shockWaveMesh: mesh, shockWaveMaterial: material, color: waveColor };
    this.worldFrame.add(this._tagDraws(group, 'effect'));
    // SFX_SHOCK, and no muzzle flash: the shot leaves no barrel. The shooter
    // has already heard its own, so only everybody else's arrives with the
    // message that announces it.
    if (!data.silent) {
      this.playSound(typeof data.fireSound === 'string' ? data.fireSound : 'fire', group.position);
    }
    return group;
  }

  updateShotShockWave(projectile, radius, alpha) {
    const mesh = projectile?.userData?.shockWaveMesh;
    if (!mesh) return;
    mesh.scale.setScalar(radius);
    mesh.material.opacity = alpha;
  }

  removeProjectile(projectile, reason = 1) {
    if (!projectile || !this.scene) return;
    const at = projectile.position;
    if (reason === 0) {
      this.createShotImpact(at);
    }
    // BZFlag plays SFX_SHOT_BOOM when a shot ends. A shock wave is the exception:
    // it is expired by its own strategy at full size rather than ended on
    // anything, so it fades out of the world without a sound.
    if (!projectile.userData?.shockwave) {
      this.playSound('shotBoom', at);
    }
    // Remove point light from scene if present
    if (this.projectileLights) this.projectileLights.delete(projectile);
    this.worldFrame.remove(projectile);
    if (projectile.userData?.shockwave) {
      // The sphere itself is shared between every wave ever drawn.
      projectile.userData.shockWaveMaterial?.dispose();
      return;
    }
    if (projectile.userData?.beam) {
      // The cylinder itself is shared between every beam ever drawn, so only the
      // per-beam instances and their materials are thrown away.
      for (const mesh of projectile.userData.beamLayers || []) mesh.dispose();
      for (const material of projectile.userData.beamMaterials || []) material.dispose();
      return;
    }
    // A bolt and its trail belong to the colour's batch and outlive the shot;
    // a guided missile's own animated sheet is the only thing here a shot owns.
    const guidedFlares = projectile.userData?.guidedFlares;
    if (guidedFlares) {
      guidedFlares.geometry.dispose();
      guidedFlares.material.dispose();
    }
    const guidedHead = projectile.userData?.guidedHead;
    if (guidedHead?.material) {
      guidedHead.material.map?.dispose();
      guidedHead.material.dispose();
    }
  }

  // gotBlowedUp's explosion (playing.cxx:3925). `sound` is the sample the death
  // is announced with, because upstream picks it off the reason rather than
  // always exploding: being run over plays SFX_RUNOVER *instead of*
  // SFX_EXPLOSION, so a squish sounds like a squish.
  // `explodeTime` is the world's `_explodeTime`, how long a dead tank's pieces
  // tumble (the body for all of it, as upstream's Exploding state lasts), and
  // `size` its `_tankExplosionSize`, which the burst scales with against
  // upstream's default of 3.5 tank lengths.
  createExplosion(at, tank, sound = 'explosion', { explodeTime = 5, size = 21 } = {}) {
    if (!this.scene || !at) return;
    const position = new THREE.Vector3(at.x, at.y, at.z);
    const burst = size > 0 ? size / 21 : 1;
    const tumble = explodeTime >= 0 ? explodeTime / 5 : 1;
    this.playSound(sound, at);

    // Dynamic lighting flash
    let explosionLight = null;
    let lightIntensity = 0;
    if (this._dynamicLightingActive() && typeof THREE !== 'undefined') {
      explosionLight = this._createDynamicLight(
        0xffe066,
        bzflagLightIntensity(BZFLAG_EXPLOSION_LIGHT_SCALE),
      );
      explosionLight.position.copy(position);
      // updateExplosions() fades this down from here.
      lightIntensity = explosionLight.intensity;
    }

    const geometry = new THREE.SphereGeometry(2 * burst, 16, 16);
    const material = new THREE.MeshBasicMaterial({ color: 0xff4500, transparent: true, opacity: 0.8 });
    const explosion = new THREE.Mesh(geometry, material);
    explosion.position.copy(position);
    this.worldFrame.add(this._tagDraws(explosion, 'effect'));

    const shockwaveGeometry = new THREE.TorusGeometry(1.6 * burst, 0.12 * burst, 8, 48);
    const shockwaveMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0.8,
      depthWrite: false
    });
    // A torus lies in its own x-y plane, which is the ground.
    const shockwave = new THREE.Mesh(shockwaveGeometry, shockwaveMaterial);
    shockwave.position.set(position.x, position.y, Math.max(0.08, position.z + 0.08));
    this.worldFrame.add(this._tagDraws(shockwave, 'effect'));

    const debrisPieces = [];
    let followTarget = null;
    if (tank && tank.userData) {
      const tankWorldPos = tank.position;
      const explodableParts = Array.isArray(tank.userData.explodableParts)
        ? tank.userData.explodableParts
        : [];

      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      const worldScale = new THREE.Vector3();
      const worldMatrix = new THREE.Matrix4();
      const localMatrix = new THREE.Matrix4();
      const parentInverseMatrix = new THREE.Matrix4();
      const localPos = new THREE.Vector3();
      const localQuat = new THREE.Quaternion();
      const localScale = new THREE.Vector3();

      this.worldFrame.updateWorldMatrix(true, false);
      parentInverseMatrix.copy(this.worldFrame.matrixWorld).invert();

      // Player::addToScene (Player.cxx:888) keeps handing an exploding tank's
      // node the eased flag dimensions, so a tank that dies with Narrow, Tiny or
      // Obesity grows back to its own size over _flagEffectTime while it comes
      // apart. Each piece therefore hangs in the tank's own frame, under a
      // scale that follows the dead tank's dimensions rather than keeping the
      // ones it died with.
      tank.updateWorldMatrix(true, false);
      const tankInverseMatrix = tank.matrixWorld.clone().invert();
      const tankPos = new THREE.Vector3();
      const tankQuat = new THREE.Quaternion();
      const tankScale = new THREE.Vector3();
      localMatrix.multiplyMatrices(parentInverseMatrix, tank.matrixWorld);
      localMatrix.decompose(tankPos, tankQuat, tankScale);
      const deathWidth = tank.userData.dimensionScaleWidth ?? 1;
      const deathLength = tank.userData.dimensionScaleLength ?? 1;

      explodableParts.forEach((sourcePart) => {
        if (!sourcePart) return;

        const part = sourcePart.clone(true);
        // The cockpit view hides its own turret and barrel, and a clone copies
        // that; the debris flies either way.
        part.visible = true;
        this._stripTankNavLights(part);
        part.traverse((node) => {
          if (node.isMesh && node.material) {
            node.material = Array.isArray(node.material)
              ? node.material.map((material) => material.clone())
              : node.material.clone();
          }
        });

        sourcePart.updateWorldMatrix(true, false);
        sourcePart.getWorldPosition(worldPos);
        sourcePart.getWorldQuaternion(worldQuat);
        sourcePart.getWorldScale(worldScale);

        worldMatrix.compose(worldPos, worldQuat, worldScale);
        localMatrix.multiplyMatrices(parentInverseMatrix, worldMatrix);
        localMatrix.decompose(localPos, localQuat, localScale);

        // The part's pose in the tank's unscaled frame, about its own origin.
        localMatrix.multiplyMatrices(tankInverseMatrix, sourcePart.matrixWorld);
        localMatrix.decompose(worldPos, worldQuat, worldScale);
        part.position.set(0, 0, 0);
        part.quaternion.copy(worldQuat);
        part.scale.copy(worldScale);
        const dimensions = new THREE.Group();
        dimensions.scale.copy(tankScale);
        dimensions.add(part);
        const pivot = new THREE.Group();
        pivot.position.copy(localPos);
        pivot.quaternion.copy(tankQuat);
        pivot.add(dimensions);

        let speedMultiplier = 0.9;
        if (sourcePart === tank.userData.body) speedMultiplier = 0.95;
        else if (sourcePart === tank.userData.turret) speedMultiplier = 0.8;
        else if (sourcePart === tank.userData.barrel) speedMultiplier = 0.6;

        const debrisPiece = this._launchTankPart(pivot, tankWorldPos, debrisPieces, speedMultiplier, {
          isFollowTarget: sourcePart === tank.userData.body,
          maxLifetime: (sourcePart === tank.userData.body ? 5.0 : 3.2) * tumble
        });
        if (debrisPiece) {
          debrisPiece.dimensions = dimensions;
          debrisPiece.dimensionSource = tank;
          debrisPiece.unflaggedScale = new THREE.Vector3(
            tankScale.x / deathLength, tankScale.y / deathWidth, tankScale.z,
          );
        }
        if (sourcePart === tank.userData.body && debrisPiece) {
          followTarget = debrisPiece.mesh;
        }
      });
    }

    const debrisCount = 15;
    for (let i = 0; i < debrisCount; i += 1) {
      const pieceSize = (Math.random() * 0.5 + 0.3) * burst;
      const debrisGeom = new THREE.BoxGeometry(pieceSize, pieceSize, pieceSize);
      const debrisMat = new THREE.MeshLambertMaterial({
        color: i % 3 === 0 ? 0x4caf50 : (i % 3 === 1 ? 0x666666 : 0xff5722),
      });
      const debris = new THREE.Mesh(debrisGeom, debrisMat);
      debris.position.copy(position);

      const angle = Math.random() * Math.PI * 2;
      const elevation = (Math.random() - 0.3) * Math.PI / 3;
      const speed = (Math.random() * 15 + 10) * burst;
      debris.velocity = new THREE.Vector3(
        Math.cos(angle) * Math.cos(elevation) * speed,
        0 - (Math.sin(angle) * Math.cos(elevation) * speed),
        Math.sin(elevation) * speed + 5,
      );
      debris.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI,
      );
      debris.rotationVelocity = new THREE.Vector3(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
      );
      debris.userData.isTankPart = false;
      this.worldFrame.add(this._tagDraws(debris, 'effect'));
      debrisPieces.push({ mesh: debris, lifetime: 0, maxLifetime: 2.5 });
    }

    this.activeExplosions.push({
      light: explosionLight,
      lightIntensity,
      sphere: explosion,
      sphereGeometry: geometry,
      sphereMaterial: material,
      shockwave,
      shockwaveGeometry,
      shockwaveMaterial,
      debrisPieces,
    });
    return { followTarget };
  }

  updateExplosions(deltaTime) {
    const dt = Math.max(0.001, Math.min(0.05, deltaTime || 0.016));

    for (let index = this.activeSpawnEffects.length - 1; index >= 0; index -= 1) {
      const effect = this.activeSpawnEffects[index];
      effect.lifetime += dt;
      const progress = Math.min(1, effect.lifetime / effect.maxLifetime);

      const ringScale = 0.7 + progress * 3.3;
      effect.ring.scale.set(ringScale, ringScale, 1);
      effect.ringMaterial.opacity = Math.max(0, 0.95 * (1 - progress));

      const columnPulse = 0.28 + (1 - progress) * 0.72;
      effect.column.scale.set(0.4 * columnPulse, 0.4 * columnPulse, 0.3 + (1 - progress) * 1.25);
      effect.columnMaterial.opacity = Math.max(0, 0.34 * (1 - progress));

      const topRingScale = 0.65 + progress * 1.45;
      effect.topRing.scale.set(topRingScale, topRingScale, 1);
      effect.topRing.position.z += dt * 1.8;
      effect.topRingMaterial.opacity = Math.max(0, 0.55 * (1 - progress));

      if (progress >= 1) {
        effect.ring.removeFromParent();
        effect.column.removeFromParent();
        effect.topRing.removeFromParent();
        effect.ringGeometry.dispose();
        effect.ringMaterial.dispose();
        effect.columnGeometry.dispose();
        effect.columnMaterial.dispose();
        effect.topRingGeometry.dispose();
        effect.topRingMaterial.dispose();
        this.activeSpawnEffects.splice(index, 1);
      }
    }

    for (let index = this.activeLandingEffects.length - 1; index >= 0; index -= 1) {
      const effect = this.activeLandingEffects[index];
      effect.lifetime += dt;
      const progress = Math.min(1, effect.lifetime / effect.maxLifetime);
      const radius = effect.startRadius + (effect.expansionRate * effect.lifetime);
      effect.ring.scale.x = radius;
      effect.ring.scale.y = radius;
      // Upstream's `0.5f + age`: the top ring keeps rising for the effect's
      // whole life, independent of how wide it has grown.
      effect.ring.scale.z = 0.5 + effect.lifetime;
      effect.material.opacity = Math.max(0, 1.0 - progress);
      if (progress >= 1) {
        effect.ring.removeFromParent();
        effect.geometry.dispose();
        effect.material.dispose();
        this.activeLandingEffects.splice(index, 1);
      }
    }

    if (this.activeExplosions.length) {
      for (let index = this.activeExplosions.length - 1; index >= 0; index -= 1) {
      const explosion = this.activeExplosions[index];

      if (explosion.sphere && explosion.sphereMaterial) {
        explosion.sphereMaterial.opacity -= 1.5 * dt;
        explosion.sphere.scale.addScalar(3.8 * dt);
        if (explosion.sphereMaterial.opacity <= 0) {
          explosion.sphere.removeFromParent();
          explosion.sphereGeometry.dispose();
          explosion.sphereMaterial.dispose();
          explosion.sphere = null;
          explosion.sphereGeometry = null;
          explosion.sphereMaterial = null;
        }
      }

      if (explosion.shockwave && explosion.shockwaveMaterial) {
        explosion.shockwaveMaterial.opacity -= 0.65 * dt;
        explosion.shockwave.scale.x += 5.5 * dt;
        explosion.shockwave.scale.y += 5.5 * dt;
        if (explosion.shockwaveMaterial.opacity <= 0) {
          explosion.shockwave.removeFromParent();
          explosion.shockwaveGeometry.dispose();
          explosion.shockwaveMaterial.dispose();
          explosion.shockwave = null;
          explosion.shockwaveGeometry = null;
          explosion.shockwaveMaterial = null;
        }
      }

      if (explosion.light) {
        const fade = Math.pow(0.92, dt / 0.016);
        explosion.lightIntensity *= fade;
        explosion.light.intensity = explosion.lightIntensity;
        if (explosion.lightIntensity <= 0.05) {
          explosion.light = null;
        }
      }

      for (let pieceIndex = explosion.debrisPieces.length - 1; pieceIndex >= 0; pieceIndex -= 1) {
        const piece = explosion.debrisPieces[pieceIndex];
        if (piece.lifetime < piece.maxLifetime) {
          piece.lifetime += dt;
          const isPrimaryHull = Boolean(piece.mesh.userData?.isPrimaryHull);
          const gravity = isPrimaryHull ? 9 : 12;
          piece.mesh.velocity.z -= gravity * dt;
          piece.mesh.position.x += piece.mesh.velocity.x * dt;
          piece.mesh.position.y += piece.mesh.velocity.y * dt;
          piece.mesh.position.z += piece.mesh.velocity.z * dt;
          piece.mesh.rotation.x += piece.mesh.rotationVelocity.x * dt;
          piece.mesh.rotation.y += piece.mesh.rotationVelocity.y * dt;
          piece.mesh.rotation.z += piece.mesh.rotationVelocity.z * dt;
          if (piece.dimensions) {
            const { userData } = piece.dimensionSource;
            piece.dimensions.scale.set(
              piece.unflaggedScale.x * (userData.dimensionScaleLength ?? 1),
              piece.unflaggedScale.y * (userData.dimensionScaleWidth ?? 1),
              piece.unflaggedScale.z,
            );
          }

          const fadeStart = piece.maxLifetime * 0.7;
          if (piece.lifetime > fadeStart) {
            const fadeProgress = (piece.lifetime - fadeStart) / (piece.maxLifetime - fadeStart);
            this._fadeMaterial(piece.mesh.material, fadeProgress);
            piece.mesh.traverse((child) => {
              if (child.material) this._fadeMaterial(child.material, fadeProgress);
            });
          }

          if (piece.mesh.position.z < 0) {
            if (isPrimaryHull) {
              piece.mesh.position.z = 0;
              const bounceCount = piece.mesh.userData.groundBounces || 0;
              const verticalImpact = Math.abs(piece.mesh.velocity.z);
              if (bounceCount < 2 && verticalImpact > 1.2) {
                piece.mesh.userData.groundBounces = bounceCount + 1;
                piece.mesh.userData.grounded = false;
                piece.mesh.velocity.z = verticalImpact * (bounceCount === 0 ? 0.38 : 0.24);
                piece.mesh.velocity.x *= 0.82;
                piece.mesh.velocity.y *= 0.82;
                piece.mesh.rotationVelocity.multiplyScalar(0.72);
              } else {
                piece.mesh.userData.grounded = true;
                piece.mesh.velocity.z = 0;
                const skidDamping = Math.pow(0.22, dt / 0.016);
                piece.mesh.velocity.x *= skidDamping;
                piece.mesh.velocity.y *= skidDamping;
                piece.mesh.rotationVelocity.multiplyScalar(Math.pow(0.18, dt / 0.016));
                if ((piece.mesh.velocity.x * piece.mesh.velocity.x) + (piece.mesh.velocity.y * piece.mesh.velocity.y) < 0.04) {
                  piece.mesh.velocity.x = 0;
                  piece.mesh.velocity.y = 0;
                  piece.mesh.rotationVelocity.set(0, 0, 0);
                }
              }
            } else {
              piece.lifetime = piece.maxLifetime;
            }
          }

          continue;
        }

        this._cleanupDebrisPiece(piece.mesh);
        explosion.debrisPieces.splice(pieceIndex, 1);
      }

      const done = !explosion.sphere && !explosion.light && !explosion.shockwave && explosion.debrisPieces.length === 0;
        if (done) {
          this.activeExplosions.splice(index, 1);
        }
      }
    }

    for (let index = this.activeShotExplosions.length - 1; index >= 0; index -= 1) {
      const effect = this.activeShotExplosions[index];
      effect.age += dt;
      const progress = Math.min(1, effect.age / effect.duration);
      const frame = Math.min(63, Math.floor(progress * 64));
      this._setSpriteAtlasFrame(effect.texture, frame, 8, 8);
      effect.material.opacity = Math.max(0, 1 - progress);
      this._faceShotExplosion(effect.sprite, effect.origin);

      if (effect.light) {
        if (effect.age < effect.lightFadeStart) {
          effect.light.intensity = effect.lightBaseIntensity;
        } else {
          const fadeRange = Math.max(0.001, effect.duration - effect.lightFadeStart);
          const fadeProgress = Math.min(1, (effect.age - effect.lightFadeStart) / fadeRange);
          effect.light.intensity = effect.lightBaseIntensity * (1 - fadeProgress);
        }
      }

      if (progress >= 1) {
        effect.sprite.removeFromParent();
        if (effect.material) effect.material.dispose();
        // The texture is a clone sharing the session's one uploaded sheet, so
        // it is dropped rather than disposed: disposing the last clone would
        // free the sheet off the GPU and the next impact would upload it again.
        effect.texture = null;
        effect.light = null;
        this.activeShotExplosions.splice(index, 1);
      }
    }
  }

  _fadeMaterial(material, fadeProgress) {
    if (!material) return;
    if (Array.isArray(material)) {
      material.forEach((mat) => {
        if (mat) {
          mat.opacity = 1 - fadeProgress;
          mat.transparent = true;
        }
      });
    } else {
      material.opacity = 1 - fadeProgress;
      material.transparent = true;
    }
  }

  _launchTankPart(part, centerPos, debrisPieces, speedMultiplier = 1.0, options = {}) {
    this.worldFrame.add(this._tagDraws(part, 'effect'));
    part.userData.isTankPart = true;
    part.userData.isPrimaryHull = Boolean(options.isFollowTarget);
    part.userData.groundBounces = 0;
    part.userData.grounded = false;
    const angle = Math.random() * Math.PI * 2;
    const elevation = (Math.random() - 0.15) * Math.PI / 4;
    const speed = (Math.random() * 6 + 6) * speedMultiplier;
    part.velocity = new THREE.Vector3(
      Math.cos(angle) * Math.cos(elevation) * speed,
      0 - (Math.sin(angle) * Math.cos(elevation) * speed),
      Math.sin(elevation) * speed + (options.isFollowTarget ? 7 : 5.5),
    );
    part.rotationVelocity = new THREE.Vector3(
      (Math.random() - 0.5) * (options.isFollowTarget ? 2.5 : 4.5),
      (Math.random() - 0.5) * (options.isFollowTarget ? 2.5 : 4.5),
      (Math.random() - 0.5) * (options.isFollowTarget ? 2.5 : 4.5),
    );
    const debrisPiece = {
      mesh: part,
      lifetime: 0,
      maxLifetime: options.maxLifetime ?? (options.isFollowTarget ? 3.5 : 2.0)
    };
    debrisPieces.push(debrisPiece);
    return debrisPiece;
  }

  _cleanupDebrisPiece(mesh) {
    if (mesh === this.deathFollowTarget) {
      this.deathFollowTarget = null;
    }
    mesh.removeFromParent();
    // A tank part is a clone sharing the live tank's geometry and textures,
    // with materials of its own (`createExplosion`): those go, nothing else.
    if (mesh.userData?.isTankPart) {
      mesh.traverse((node) => {
        if (!node.isMesh || !node.material) return;
        (Array.isArray(node.material) ? node.material : [node.material]).forEach((mat) => mat.dispose());
      });
    }
    if (mesh.userData && !mesh.userData.isTankPart) {
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((mat) => mat.dispose());
        } else {
          mesh.material.dispose();
        }
      }
    }
    if (mesh.children) {
      mesh.children.forEach((child) => {
        mesh.remove(child);
      });
    }
  }

  _getFlashTexture() {
    if (!this._flashTexture) {
      this._flashTexture = this._createSharedImageTexture(BZFLAG_FLASH_TEXTURE);
    }
    return this._flashTexture;
  }

  // EffectsRenderer::addShotEffect / StdShotEffect. drawRingYZ() sweeps a
  // frustum: the inner circle sits at the muzzle, the outer one flares out a
  // fixed distance forward, and both grow with age. BZFlag forces the colour to
  // white regardless of the shot colour.
  _buildMuzzleFlashGeometry(age) {
    const innerRadius = BZFLAG_SHOT_FLASH_START_RADIUS + (age * BZFLAG_SHOT_FLASH_GROWTH);
    const flare = BZFLAG_SHOT_FLASH_FLARE + (age * BZFLAG_SHOT_FLASH_FLARE_GROWTH);
    const geometry = new THREE.CylinderGeometry(
      innerRadius + flare,           // outer circle, a length forward of the muzzle
      innerRadius,                   // inner circle, at the muzzle
      BZFLAG_SHOT_FLASH_LENGTH,
      BZFLAG_SHOT_FLASH_SEGMENTS,
      1,
      true                           // open ended, like the triangle strip upstream
    );
    // CylinderGeometry runs along +Y; point it along the barrel and slide the
    // inner circle to the muzzle rather than straddling it.
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, BZFLAG_SHOT_FLASH_LENGTH / 2);
    // Match drawRingYZ's V range so the texture reads along the flare.
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) {
      const v = uv.getY(i);
      uv.setY(i, BZFLAG_SHOT_FLASH_UV_BOTTOM + v * (1 - BZFLAG_SHOT_FLASH_UV_BOTTOM));
    }
    uv.needsUpdate = true;
    return geometry;
  }

  createMuzzleFlash(at, along) {
    if (!this.scene || !at || !along) return;
    const length = Math.hypot(along.x, along.y, along.z);
    if (length <= 0) return;

    const material = new THREE.MeshBasicMaterial({
      map: this._getFlashTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: BZFLAG_SHOT_FLASH_START_ALPHA,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this._buildMuzzleFlashGeometry(0), material);
    mesh.position.set(at.x, at.y, at.z);
    pointAlong(mesh, along.x / length, along.y / length, along.z / length);
    this.worldFrame.add(this._tagDraws(mesh, 'effect'));

    if (!this.muzzleFlashes) this.muzzleFlashes = [];
    this.muzzleFlashes.push({ mesh, material, age: 0 });
  }

  updateMuzzleFlashes(deltaTime) {
    if (!this.muzzleFlashes?.length || deltaTime <= 0) return;
    for (let i = this.muzzleFlashes.length - 1; i >= 0; i -= 1) {
      const flash = this.muzzleFlashes[i];
      flash.age += deltaTime;

      // draw(): alpha = 0.5 - age/lifetime, so it is invisible well before the
      // lifetime elapses. Retire it once it is no longer worth drawing.
      const alpha = BZFLAG_SHOT_FLASH_START_ALPHA - (flash.age / BZFLAG_SHOT_FLASH_LIFETIME);
      if (alpha <= 0.001) {
        flash.mesh.removeFromParent();
        flash.mesh.geometry.dispose();
        flash.material.dispose();
        this.muzzleFlashes.splice(i, 1);
        continue;
      }

      flash.mesh.geometry.dispose();
      flash.mesh.geometry = this._buildMuzzleFlashGeometry(flash.age);
      flash.material.opacity = alpha;
    }
  }

  // StdRicoEffect::draw. drawRingYZ sweeps the same frustum the muzzle flash
  // does, so only the figures differ: the ring grows and the cone keeps a fixed
  // length rather than the flare growing with it.
  _buildRicochetGeometry(age) {
    const innerRadius = BZFLAG_RICO_START_RADIUS + (age * BZFLAG_RICO_GROWTH);
    const geometry = new THREE.CylinderGeometry(
      innerRadius + BZFLAG_RICO_FLARE,
      innerRadius,
      BZFLAG_RICO_LENGTH,
      BZFLAG_RICO_SEGMENTS,
      1,
      true
    );
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, BZFLAG_RICO_LENGTH / 2);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) {
      const v = uv.getY(i);
      uv.setY(i, BZFLAG_RICO_UV_BOTTOM + v * (1 - BZFLAG_RICO_UV_BOTTOM));
    }
    uv.needsUpdate = true;
    return geometry;
  }

  // EffectsRenderer::addRicoEffect. `direction` is upstream's own aim for it:
  // the new shot direction minus the old one, which points out of the surface.
  createRicochetEffect(at, along) {
    if (!this.scene || !at || !along) return;
    const length = Math.hypot(along.x, along.y, along.z);
    if (length <= 0) return;

    const material = new THREE.MeshBasicMaterial({
      map: this._getFlashTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: BZFLAG_RICO_START_ALPHA,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this._buildRicochetGeometry(0), material);
    mesh.position.set(at.x, at.y, at.z);
    pointAlong(mesh, along.x / length, along.y / length, along.z / length);
    this.worldFrame.add(this._tagDraws(mesh, 'effect'));

    if (!this.ricochetEffects) this.ricochetEffects = [];
    this.ricochetEffects.push({ mesh, material, age: 0 });
  }

  updateRicochetEffects(deltaTime) {
    if (!this.ricochetEffects?.length || deltaTime <= 0) return;
    for (let i = this.ricochetEffects.length - 1; i >= 0; i -= 1) {
      const effect = this.ricochetEffects[i];
      effect.age += deltaTime;

      const alpha = BZFLAG_RICO_START_ALPHA - (effect.age / BZFLAG_RICO_LIFETIME);
      if (alpha <= 0.001) {
        effect.mesh.removeFromParent();
        effect.mesh.geometry.dispose();
        effect.material.dispose();
        this.ricochetEffects.splice(i, 1);
        continue;
      }

      effect.mesh.geometry.dispose();
      effect.mesh.geometry = this._buildRicochetGeometry(effect.age);
      effect.material.opacity = alpha;
    }
  }

  _getJumpJetTexture() {
    if (!this._jumpJetTexture) {
      this._jumpJetTexture = this._createSharedImageTexture(BZFLAG_JUMPJET_TEXTURE);
    }
    return this._jumpJetTexture;
  }

  // TankSceneNode.cxx:1448 -- a triangle hanging below the nozzle, wide at the
  // top and coming to a point, with the texture mapped across it.
  _createJumpJetMesh() {
    const geometry = new THREE.BufferGeometry();
    const w = BZFLAG_JUMPJET_HALF_WIDTH;
    const l = BZFLAG_JUMPJET_LENGTH;
    // Across the tank's y, hanging down its z.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, -w, 0,
      0, +w, 0,
      0, 0, -l,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 1,
      1, 1,
      0.5, 0,
    ], 2));

    const material = new THREE.MeshBasicMaterial({
      map: this._getJumpJetTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: BZFLAG_JUMPJET_ALPHA,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geometry, material);
  }

  _ensureJumpJets(tank) {
    if (tank.userData.jumpJets) return tank.userData.jumpJets;
    const jets = BZFLAG_JUMPJET_OFFSETS.map((offset) => {
      const mesh = this._createJumpJetMesh();
      mesh.position.set(offset.x, offset.y, offset.z);
      mesh.visible = false;
      tank.add(mesh);
      return { mesh, length: 1 };
    });
    tank.userData.jumpJets = jets;
    return jets;
  }

  // Player::fireJumpJets()
  fireTankJumpJets(tank) {
    if (!tank) return;
    const jets = this._ensureJumpJets(tank);
    tank.userData.jumpJetsScale = 1;
    // TankSceneNode.cxx:419 -- each jet gets its own length so they flicker
    // independently rather than moving as one block.
    for (const jet of jets) {
      jet.length = 1 - (0.5 * (0.5 - Math.random()));
    }
  }

  updateJumpJets(tanks, deltaTime, gameConfig) {
    if (!tanks || deltaTime <= 0) return;

    const jumpVelocity = gameConfig?.JUMP_VELOCITY || 19;
    const gravity = gameConfig?.GRAVITY || 9.8;
    const jetTime = 0.5 * (jumpVelocity / gravity);

    tanks.forEach((tank) => {
      const scale = tank?.userData?.jumpJetsScale;
      if (!Number.isFinite(scale) || scale <= 0) return;

      const nextScale = Math.max(0, scale - (deltaTime / jetTime));
      tank.userData.jumpJetsScale = nextScale;

      for (const jet of tank.userData.jumpJets) {
        if (nextScale <= 0) {
          jet.mesh.visible = false;
          continue;
        }
        jet.mesh.visible = true;
        jet.mesh.scale.set(1, 1, nextScale * jet.length);
        // executeBillboard() upstream. Turning about the tank's up axis keeps
        // the flame hanging downward while still facing the camera.
        this._faceJetToCamera(tank, jet.mesh);
      }

      this._updateJumpJetLight(tank, nextScale);
    });
  }

  // Turn the flame about the tank's up axis so it faces the camera while still
  // hanging straight down. The jet's own position is already tank-local, so
  // bringing the camera into that frame makes this a single atan2.
  _faceJetToCamera(tank, mesh) {
    if (!this.camera) return;
    // The flame's face is its -x side.
    const cameraLocal = tank.worldToLocal(this.camera.getWorldPosition(new THREE.Vector3()));
    mesh.rotation.z = Math.atan2(
      mesh.position.y - cameraLocal.y,
      mesh.position.x - cameraLocal.x,
    );
  }

  // TankSceneNode.cxx:308 -- one warm light at the tank while the jets burn.
  _updateJumpJetLight(tank, scale) {
    if (!this._dynamicLightingActive()) {
      if (tank.userData.jumpJetLight) tank.userData.jumpJetLight.visible = false;
      return;
    }
    if (!tank.userData.jumpJetLight) {
      const { r, g, b } = BZFLAG_JUMPJET_LIGHT_COLOR;
      const peak = Math.max(r, g, b);
      tank.userData.jumpJetLight = this._createDynamicLight(
        new THREE.Color(r / peak, g / peak, b / peak),
        0,
      );
    }
    const light = tank.userData.jumpJetLight;
    light.visible = scale > 0;
    // Upstream scales the jet light's colour by how far the flames have grown
    // (TankSceneNode.cxx:308); the colour here is normalised, so the scale
    // rides on the intensity instead.
    light.intensity = scale * bzflagLightIntensity(BZFLAG_JUMPJET_LIGHT_SCALE);
    // The light sat on the tank and rode along with it; now it is a request in
    // the game's frame, where the tank's position already is, and it stands
    // only for the frame that asked.
    light.position.copy(tank.position);
    if (light.visible && light.intensity > 0) {
      if (!this._activeJumpJetLights) this._activeJumpJetLights = [];
      this._activeJumpJetLights.push(light);
    }
  }

  _getShotTeleportTexture() {
    if (!this._shotTeleportTexture) {
      this._shotTeleportTexture = this._createSharedImageTexture(BZFLAG_SHOT_TELEPORT_TEXTURE);
    }
    return this._shotTeleportTexture;
  }

  // draw(): length is 0.5 + mod*0.5 where mod is a one second sawtooth centred
  // on zero, so the collar stretches between 0.25 and 0.75 as it travels.
  _buildShotTeleportGeometry(age) {
    const sawtooth = (age - Math.floor(age)) - 0.5;
    const length = 0.5 + (sawtooth * 0.5);
    const geometry = new THREE.CylinderGeometry(
      BZFLAG_SHOT_TELEPORT_RADIUS + BZFLAG_SHOT_TELEPORT_FLARE,
      BZFLAG_SHOT_TELEPORT_RADIUS,
      length,
      BZFLAG_SHOT_TELEPORT_SEGMENTS,
      1,
      true
    );
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, length / 2);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) {
      uv.setY(i, uv.getY(i) * BZFLAG_SHOT_TELEPORT_UV_TOP);
    }
    uv.needsUpdate = true;
    return geometry;
  }

  // EffectsRenderer::addShotTeleportEffect. Upstream advances the effect by
  // position + velocity*age, so it rides with the shot; parenting it to the
  // projectile does the same thing and disposes with it.
  createShotTeleportEffect(projectile) {
    if (!this.scene || !projectile) return;

    const material = new THREE.MeshBasicMaterial({
      map: this._getShotTeleportTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // Along the shot, as upstream turns it by the shot's velocity; the collar
    // spins about that axis inside its holder.
    const mesh = new THREE.Mesh(this._buildShotTeleportGeometry(0), material);
    const holder = new THREE.Group();
    const { tailDirX = 0, tailDirY = 1, tailDirZ = 0 } = projectile.userData || {};
    const length = Math.hypot(tailDirX, tailDirY, tailDirZ) || 1;
    pointAlong(holder, tailDirX / length, tailDirY / length, tailDirZ / length);
    holder.add(mesh);
    projectile.add(holder);

    if (!this.shotTeleportEffects) this.shotTeleportEffects = [];
    this.shotTeleportEffects.push({ mesh, holder, material, projectile, age: 0 });
  }

  updateShotTeleportEffects(deltaTime) {
    if (!this.shotTeleportEffects?.length || deltaTime <= 0) return;
    for (let i = this.shotTeleportEffects.length - 1; i >= 0; i -= 1) {
      const effect = this.shotTeleportEffects[i];
      effect.age += deltaTime;

      // Drop it once it expires, or once the shot it rides on is gone.
      if (effect.age >= BZFLAG_SHOT_TELEPORT_LIFETIME || !effect.holder.parent) {
        effect.holder.removeFromParent();
        effect.mesh.geometry.dispose();
        effect.material.dispose();
        this.shotTeleportEffects.splice(i, 1);
        continue;
      }

      effect.mesh.geometry.dispose();
      effect.mesh.geometry = this._buildShotTeleportGeometry(effect.age);
      // glRotatef(age*90, 1, 0, 0): spin about the shot axis.
      effect.mesh.rotation.z = THREE.MathUtils.degToRad(effect.age * BZFLAG_SHOT_TELEPORT_SPIN);
    }
  }
}
