/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The world's geometry: the ground, water, boxes, pyramids, teleporters,
// meshes and walls, inside-building views, and the debug labels on them.
// RenderManager's own methods, kept here and installed on its prototype by
// render.js: `this` is the RenderManager.

import { WORLD_WALL_HEIGHT, getObstacleBase, getObstacleHeight, getPyramidSurfaceLocalHeight } from './collision.mjs';
import { createBuriedTriangleTest } from './face-trim.mjs';
import { NO_INDEX, meshArrays, meshDrawArrays } from './mesh-arrays.mjs';
import { getPlayerTeamColor, getTeamFromColorIndex } from './teams.mjs';
import { createBaseTopTexture, createBaseWallTexture, createBoundaryTexture, createBoxWallTexture, createGroundTexture, createPyramidTexture, createRoofTexture, createStockMaterialTexture, createTeleporterBorderTexture, createTeleporterPortalTexture, getBaseTeamTint, loadExternalTexture } from './texture.js';
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { LABEL_MATERIAL_DEPTH, meshSpinRadians, onAlphaWithoutThreshold, standUpGeometry } from './render.js';

// An obstacle's footprint: `size` is upstream's half extents.
function obstacleWidth(obs) {
  return 2 * obs.size[0];
}

function obstacleBreadth(obs) {
  return 2 * obs.size[1];
}

// A shape built about its own origin, placed at (x, y, z) and turned by
// `angle` about z: as a matrix to bake into vertices, or as an object's pose.
const PLACEMENT_QUATERNION = new THREE.Quaternion();
const PLACEMENT_POSITION = new THREE.Vector3();
const PLACEMENT_SCALE = new THREE.Vector3(1, 1, 1);
const PLACEMENT_AXIS = new THREE.Vector3(0, 0, 1);
function placementMatrix(x, y, z, angle, target = new THREE.Matrix4()) {
  PLACEMENT_QUATERNION.setFromAxisAngle(PLACEMENT_AXIS, angle);
  return target.compose(PLACEMENT_POSITION.set(x, y, z), PLACEMENT_QUATERNION, PLACEMENT_SCALE);
}

function placeObstacle(object, obs) {
  object.position.set(obs.pos[0], obs.pos[1], getObstacleBase(obs));
  object.rotation.set(0, 0, obs.angle || 0);
  return object;
}

// The eighth dimension: what a tank driving through a building sees of it.
// EighthDimSceneNode.cxx fills the solid with loose triangles in random colours
// at random alpha, and EighthDBoxSceneNode / EighthDPyrSceneNode draw a white
// wireframe of the obstacle around them. Both are needed and for the same
// reason: an obstacle's faces are back-face culled, so from inside one the walls
// are not there at all, and without these a phased tank drives through a
// building it cannot see.
//
// The counts are BoxPolygons / BasePolygons 60 and PyrPolygons 20, and the
// triangle size is upstream's `size[0] / cbrt(count)`.
const BZFLAG_EIGHTH_DIM_BOX_POLYGONS = 60;
const BZFLAG_EIGHTH_DIM_PYRAMID_POLYGONS = 20;
// color[i] = 0.2 + 0.8 * rand per channel, alpha 0.2 + 0.6 * rand.
const BZFLAG_EIGHTH_DIM_COLOR_MIN = 0.2;
const BZFLAG_EIGHTH_DIM_COLOR_RANGE = 0.8;
const BZFLAG_EIGHTH_DIM_ALPHA_MIN = 0.2;
const BZFLAG_EIGHTH_DIM_ALPHA_RANGE = 0.6;
// Inside a building and therefore over everything the building is made of.
const EIGHTH_DIM_RENDER_ORDER = 6;
// A mesh has no XZ footprint the way a box or a pyramid does, so its own dot
// cloud (#77 -- every obstacle gets one, not just box/pyramid) is placed by
// ray-casting candidate points against the mesh's own triangles rather than a
// closed-form span. This is how many triangles it aims for and how hard it
// tries before giving up on a shape that never encloses a volume at all (an
// open decorative shell, say).
const BZFLAG_EIGHTH_DIM_MESH_POLYGONS = 60;
const MESH_CLOUD_MAX_ATTEMPTS_FACTOR = 40;
// Off every axis, so a ray cast from a candidate point is unlikely to graze
// along an axis-aligned face's own plane -- most map meshes are built from
// axis-aligned panels.
const MESH_CLOUD_RAY_DIRECTION = new THREE.Vector3(1, 1.3, 1.7).normalize();

// And the ground goes *before* them, which is the whole reason that works.
// Upstream's order is fixed by `SceneRenderer`: `renderGround` lays the
// ground down first (`BackgroundRenderer.cxx:605-609`), `renderGroundEffects`
// then draws the grid, the shadows and the light receivers, and only then
// does `drawMountains` paint over the lot of it with the depth test off
// (`:689-695`). Without an explicit order here the ground sorts at the
// default 0 and lands *after* the mountains, so a ground plane that reaches
// ten times the world (`mapSize * 10`, far beyond the mountains' own
// `2.25 * mapSize`) simply paints them out -- visible from any viewpoint high
// enough to see past the ring, which on a small map is one jump.
const GROUND_RENDER_ORDER = -600;
// BZFlag does not draw the ground as one enormous quad. At its default quality
// it draws a patch that follows the eye, skirted by four quads reaching the edge
// of the world (BackgroundRenderer::drawGroundCentered, BackgroundRenderer.cxx:1132).
// Everything near the camera then lands on a small triangle carrying small
// texture coordinates, rather than on one kilometres across whose interpolation
// drifts as the view moves -- which is the ground appearing to slide against the
// obstacles standing on it.
// How far a wall texture and a roof texture stretch, in metres per tile. These
// were the divisors on the per-face texture repeats and are now the divisors on
// the baked UVs, so the tiling is unchanged.
// The mirror ground's compositing, upstream's tint quad over its reflection:
// `reflection * (1 - a) + tint * a`.
const BZFLAG_MIRROR_SHADER = {
  name: 'BzflagMirror',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    tintAlpha: { value: 0.5 },
  },
  vertexShader: Reflector.ReflectorShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform float tintAlpha;
    uniform sampler2D tDiffuse;
    varying vec4 vUv;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec4 base = texture2DProj( tDiffuse, vUv );
      gl_FragColor = vec4( mix( base.rgb, color, tintAlpha ), 1.0 );
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

const BOX_TEXTURE_SCALES = { sideScale: 8, capScale: 2 };
// `MeshSceneNodeGenerator::makeTexcoords`'s own `uvScale` -- upstream's tile
// size for a mesh face's planar-projected default UVs, when it states none
// of its own. Coincidentally the same 8 units `BOX_TEXTURE_SCALES.sideScale`
// already tiles a box's own wall at; kept as its own constant since the two
// are only related by upstream's own choice of matching defaults, not by
// anything that has to stay in sync.
const MESH_AUTO_UV_TILE_SIZE = 8;
// BoxGeometry emits its faces in this order, four vertices and six indices each,
// which is what _prepareBoxGeometry's loops count on.
const BOX_FACE = Object.freeze({ PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 });
// What an untinted group in a tinted fragment multiplies its texture by.
const WHITE_OBSTACLE_TINT = Object.freeze([1, 1, 1]);

// The colour a map painted an obstacle, in the order its geometry groups take
// them -- walls then caps -- or null where the map painted none. The BZW reader
// resolves a face selector down to those two, since that is as finely as a box
// or a pyramid divides here.
function getObstacleTint(obs) {
  if (!obs?.wallColor && !obs?.capColor) return null;
  return [obs.wallColor || WHITE_OBSTACLE_TINT, obs.capColor || WHITE_OBSTACLE_TINT];
}

// Picks what a face group's material actually loads: a map's own stock-name
// override, a map's own external URL (only if the browser trusts its host --
// `loadExternalTexture` decides, and falls back to `fallbackPath` either way),
// or this obstacle type's own plain default, in that order. Returns a
// zero-arg factory, the shape `_getSharedObstacleMaterials` wants.
// `onAlpha`, when the caller wants one, learns whether the texture this
// factory loads actually needs blending (`applyTextureAlpha` below) --
// `fallbackFactory` is always one of bzo's own stock assets, confirmed
// alpha-free directly, so it ignores the extra argument same as any other
// function call with more arguments than parameters.
function resolveObstacleTextureFactory(stockName, url, fallbackPath, fallbackFactory) {
  if (stockName) return (onAlpha) => createStockMaterialTexture(stockName, onAlpha);
  if (url) return (onAlpha) => loadExternalTexture(url, fallbackPath, onAlpha);
  return fallbackFactory;
}

// Upstream's own rule for whether a face needs blending at all
// (`MeshSceneNode::updateMaterial`, `MeshSceneNode.cxx:401-406`:
// `textureAlpha = imageInfo.alpha`, folded into `isAlpha` a few lines
// below) -- a texture with no real transparency costs nothing extra, and
// one that does gets Three's ordinary alpha blending and sort, the modern
// equivalent of upstream's own `BZDBCache::blend`-enabled path (there is no
// hardware left that needs its stipple fallback). Applied once alpha is
// actually known, since a texture's image loads after the material sharing
// it is already created and handed to every obstacle using that material.
// A near-zero cutoff -- discards only a pixel the texture's own alpha left
// essentially fully transparent, not a soft edge or a mapper's own
// deliberately partial overlay (`images.bzflag.org/bgrondin/telelink-trans.png`,
// a uniform 80% alpha; `msheppard/glass.png`, a uniform 20% one -- both real
// maps sampled this session, and both need to keep blending and keep
// occluding normally, not vanish or turn solid the way a 0.5 threshold
// would send a uniform-alpha texture entirely one way or the other).
const FOLIAGE_ALPHA_TEST = 0.05;

// Materials whose texture turned out to have real transparency while the map
// said nothing about a threshold, by the texture that proved it. A map like
// that renders correctly on bzo's own default, so this is not an error -- it
// is the one thing a mapper can fix that would make the map render the same
// way on upstream, which reads no threshold at all unless one is stated.
// Reported once per texture rather than once per material: a map builds one
// material per surface and a shrub is placed a hundred times.
const alphaWithoutThreshold = new Set();

// `alphathresh` from the map (`BzMaterial::getAlphaThreshold`), or bzo's own
// default where the map states none. Upstream runs no alpha test at all
// without one (`MeshSceneNode.cxx:525`: `if (alphaThreshold != 0.0f)`); bzo
// keeps a low one, which is the deliberate difference documented in
// docs/bzw.md -- a foliage cutout's fully-transparent pixels would otherwise
// still write depth and block what is behind them.
function resolveAlphaTest(material, textureName) {
  const stated = material?.userData?.alphaThreshold;
  if (Number.isFinite(stated) && stated !== 0) return stated;
  const key = textureName || '(unnamed texture)';
  if (!alphaWithoutThreshold.has(key)) {
    alphaWithoutThreshold.add(key);
    if (onAlphaWithoutThreshold) onAlphaWithoutThreshold(key);
  }
  return FOLIAGE_ALPHA_TEST;
}

// `nosorting` (`BzMaterial::getNoSorting`). Upstream's flag does not ask for
// an unsorted draw as a hint -- it takes the face out of the sorted pass
// entirely. `WallSceneNode.cxx:373-374` clears `needsSorting`, which sends
// the node to a gstate bucket instead of `orderedList`
// (`SceneRenderer.h:367-377`), and `SceneRenderer::doRender`
// (`SceneRenderer.cxx:1061-1074`) draws every bucket first and wraps only
// `orderedList` in `glDepthMask(GL_FALSE)`. So the face blends, writes depth,
// and shares a pass with the tanks -- which is why a tank behind a `nosorting`
// pane is simply depth-rejected upstream (issue #138).
//
// `depthWrite` alone cannot reproduce that here, because three.js buckets on
// the flag rather than the depth mask: any `transparent: true` material goes
// into the transparent list, which always draws after the *whole* opaque list
// regardless of renderOrder -- the same trap the sun glow hits from the other
// side (issue #102). Leaving the transparent flag off is what puts the face
// back in the opaque pass alongside the tanks.
//
// The blending has to be `CustomBlending` and not `NormalBlending`: three.js
// derives its `OPAQUE` shader define from `transparent === false && blending
// === NormalBlending`, and `opaque_fragment` forces `diffuseColor.a = 1.0`
// under it, which would draw the pane solid. `CustomBlending` fails that test,
// so the alpha survives, and `WebGLState.setMaterial` still enables real
// blending for it.
//
// Read off `userData` so the alpha callback, which fires a microtask or a
// network round trip later, sees the same answer as the code below it.
// `opaquePass` puts a nearly opaque texture in the same pass; see
// `applyTextureAlpha`.
function setTransparentDepthWrite(material, opaquePass = material.userData?.noSorting) {
  if (opaquePass) {
    material.transparent = false;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.depthWrite = true;
  } else {
    material.depthWrite = false;
  }
  // `blending`/`transparent` are both program parameters, so a material that
  // has already been rendered once -- the texture-alpha path always has --
  // needs its program re-evaluated rather than just its uniforms updated.
  material.needsUpdate = true;
}

// A texture whose most transparent pixel is still at least this opaque
// draws in the opaque pass, blended but writing depth. Upstream sorts each
// face of its blended pass by distance; three.js sorts whole objects, and an
// instanced or merged mesh sorts as one, so a far wall could draw after --
// and over -- a near one (issue #186). Writing depth makes order not matter,
// which is right for a surface nothing shows through anyway.
const OPAQUE_PASS_MIN_ALPHA = 0.85;

function applyTextureAlpha(material, hasAlpha, textureName = null, minAlpha = 0) {
  if (!hasAlpha) return;
  material.transparent = true;
  // A pixel this discards never reaches the depth test at all, so it can
  // never block anything behind it -- correct for a foliage cutout's actual
  // gaps, the class of pixel that was wrongly blocking a teleporter's own
  // effect before this existed. Upstream's own equivalent
  // (`alphaThreshold`/`GL_GEQUAL`, `MeshSceneNode.cxx:519-520`) only
  // activates when a mapper explicitly sets `alphathresh`; `resolveAlphaTest`
  // honours that stated value and otherwise falls back to a threshold low
  // enough that it only ever catches the pixels upstream's own default (no
  // threshold at all) would have shown as fully invisible anyway.
  material.alphaTest = resolveAlphaTest(material, textureName);
  // Upstream renders every alpha-blended material in a separate ordered
  // pass with `glDepthMask(GL_FALSE)` (`SceneRenderer.cxx:1061-1074`), so
  // overlapping transparent geometry (crossed-quad foliage billboards,
  // stacked leaf layers) blends instead of occluding itself through the
  // depth buffer. Depth *testing* stays on, so this still hides correctly
  // behind opaque scene geometry -- only writes are disabled. A material
  // whose map states `nosorting` opts out of that pass altogether; see
  // `setTransparentDepthWrite`. So does a nearly opaque texture on a face
  // whose own colour can't fade it (`OPAQUE_PASS_MIN_ALPHA`).
  const nearlyOpaque = minAlpha >= OPAQUE_PASS_MIN_ALPHA
    && material.opacity === 1 && !material.userData.dynamicColor;
  setTransparentDepthWrite(material, material.userData.noSorting || nearlyOpaque);
  material.needsUpdate = true;
}

// Which `dynamicColor`/`textureMatrix` a material animates from, as a cache
// key -- so every face naming the same one shares a single material, matching
// upstream's own shared state (`DynamicColor::update` writes into one array
// that every referencing material reads the same pointer to).
//
// The map's own name for the block is what says "the same one", because object
// identity does not survive the trip to the client: the server resolves one
// descriptor per block and hands the same object to every face that names it,
// and serializing the world gives each face its own copy. Keying on those
// copies split an `arc`'s rim into one material and one animation update per
// division, where the whole rim wants one of each. Two named blocks cannot
// collide -- a world holds one block per name -- and an unnamed one falls back
// to a per-object id, which never collides either.
let animIdentityCounter = 0;
const animIdentityIds = new WeakMap();
function animIdentityKey(descriptor) {
  if (!descriptor) return '';
  if (descriptor.name) return `n:${descriptor.name}`;
  if (!animIdentityIds.has(descriptor)) {
    animIdentityIds.set(descriptor, ++animIdentityCounter);
  }
  return String(animIdentityIds.get(descriptor));
}

// A material's `specular`/`shininess`/`emission` -- the coefficients that
// reach real GL state upstream (`OpenGLMaterial`, fed from
// `MeshSceneNode.cxx:463-465`). `ambient` is the fourth of `BzMaterial`'s own
// set but never reaches one: nothing upstream ever calls
// `glMaterial(..., GL_AMBIENT, ...)` anywhere in its tree, so a mapper's own
// ambient line is exactly as inert in a real bzflag client as it is here --
// see `applyBzwMaterialToken` in server.js, and `BzMaterial.cxx:652`'s own
// "not really used". A material with no real specular stays
// `MeshLambertMaterial`, cheaper and visually identical to a
// `MeshPhongMaterial` whose own specular is black; one with real specular
// becomes `MeshPhongMaterial` so the highlight -- and the shininess that
// shapes it -- actually show, matching upstream's own
// `RENDERER.useQuality() > 0` branch that turns on accurate, view-dependent
// specular exactly when a material's specular is non-black
// (`OpenGLMaterial.cxx:118-131`).
function hasRealSpecular(specular) {
  return !!specular && (specular[0] > 0 || specular[1] > 0 || specular[2] > 0);
}

function pickLitMaterialClass(specular) {
  return hasRealSpecular(specular) ? THREE.MeshPhongMaterial : THREE.MeshLambertMaterial;
}

// `emissive` is a `MeshLambertMaterial` property too, so it costs nothing to
// carry regardless of which class `pickLitMaterialClass` chose.
function buildLightingMaterialOptions(specular, shininess, emission) {
  const options = {};
  if (emission && (emission[0] > 0 || emission[1] > 0 || emission[2] > 0)) {
    options.emissive = new THREE.Color(emission[0], emission[1], emission[2]);
  }
  if (hasRealSpecular(specular)) {
    options.specular = new THREE.Color(specular[0], specular[1], specular[2]);
    options.shininess = shininess || 0;
  }
  return options;
}

// A shared obstacle material is cached by `key` alone (`_getSharedObstacleMaterials`),
// so two obstacles whose specular/shininess/emission differ need different keys
// or they would silently share whichever one built the material first.
function materialLightingKey(specular, shininess, emission) {
  if (!hasRealSpecular(specular) && !(emission && (emission[0] > 0 || emission[1] > 0 || emission[2] > 0))) {
    return '';
  }
  const s = specular ? specular.slice(0, 3).join(',') : '';
  const e = emission ? emission.slice(0, 3).join(',') : '';
  return `${s}/${shininess || 0}/${e}`;
}

// `DynamicColor::update` (`src/game/DynamicColor.cxx:371-463`). A sequence
// overrides a channel's clamps entirely; sinusoids only ever apply once
// neither clamp is active -- ported in that same order.
function foldTimeIntoPeriod(t, period) {
  let x = t;
  if (x < 0) x -= period * Math.floor(x / period);
  return x % period;
}

function evaluateDynamicColorChannel(channel, t) {
  let clampUp = false;
  let clampDown = false;
  if (channel.sequence) {
    const { period, offset, states } = channel.sequence;
    const fullPeriod = states.length * period;
    const indexTime = foldTimeIntoPeriod(t - offset, fullPeriod);
    const index = Math.min(states.length - 1, Math.floor(indexTime / period));
    const state = states[index];
    if (state === 0) clampDown = true;
    else if (state === 2) clampUp = true;
  } else {
    for (const clamp of channel.clampUps) {
      const upTime = foldTimeIntoPeriod(t - clamp.offset, clamp.period);
      if (upTime < clamp.width) { clampUp = true; break; }
    }
    for (const clamp of channel.clampDowns) {
      const downTime = foldTimeIntoPeriod(t - clamp.offset, clamp.period);
      if (downTime < clamp.width) { clampDown = true; break; }
    }
  }

  let factor = 1;
  if (clampUp && clampDown) factor = 0.5;
  else if (clampUp) factor = 1;
  else if (clampDown) factor = 0;
  else if (channel.sinusoids.length > 0) {
    let value = 0;
    for (const s of channel.sinusoids) {
      const phase = (t - s.offset) / s.period;
      value += s.weight * Math.cos((phase % 1) * Math.PI * 2);
    }
    factor = Math.max(0, Math.min(1, 0.5 + (0.5 * value)));
  }

  return (channel.min * (1 - factor)) + (channel.max * factor);
}

// Returns [r, g, b, a] in [0, 1] -- replaces a material's diffuse outright
// (`MeshSceneNode.cxx:487-491`'s `mat->colorPtr = dyncol->getColor()`), never
// multiplies against a static tint.
function evaluateDynamicColor(dynamicColor, t) {
  const { red, green, blue, alpha } = dynamicColor.channels;
  return [
    evaluateDynamicColorChannel(red, t),
    evaluateDynamicColorChannel(green, t),
    evaluateDynamicColorChannel(blue, t),
    evaluateDynamicColorChannel(alpha, t),
  ];
}

// `TextureMatrix::finalize`/`update` (`src/game/TextureMatrix.cxx:274-309,
// 405-444`) -- ported as one unified formula rather than upstream's own two
// (a static pass baked once at load, a dynamic pass re-run every frame):
// running the dynamic step with every dynamic field at its own default (0
// frequency, 1 scale) reduces algebraically to the identity transform, which
// is exactly what upstream's `useDynamic` gate leaves `matrix` at in that
// case -- the baked static matrix (or true identity, if that is at its own
// defaults too). `tm_shift`/`tm_scale`/`tm_spin`/`tm_multiply` are the same
// file's own composition primitives (`:192-238`) -- a right-multiply affine,
// not commutative, ported in the same order.
function tm_multiply(m, n) {
  const t = [
    [(m[0][0] * n[0][0]) + (m[0][1] * n[1][0]), (m[0][0] * n[0][1]) + (m[0][1] * n[1][1])],
    [(m[1][0] * n[0][0]) + (m[1][1] * n[1][0]), (m[1][0] * n[0][1]) + (m[1][1] * n[1][1])],
    [
      (m[2][0] * n[0][0]) + (m[2][1] * n[1][0]) + n[2][0],
      (m[2][0] * n[0][1]) + (m[2][1] * n[1][1]) + n[2][1],
    ],
  ];
  m[0][0] = t[0][0]; m[0][1] = t[0][1];
  m[1][0] = t[1][0]; m[1][1] = t[1][1];
  m[2][0] = t[2][0]; m[2][1] = t[2][1];
}
function tm_shift(m, ushf, vshf) {
  tm_multiply(m, [[1, 0], [0, 1], [ushf, vshf]]);
}
function tm_scale(m, uscl, vscl) {
  tm_multiply(m, [[uscl, 0], [0, vscl], [0, 0]]);
}
function tm_spin(m, radians) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  tm_multiply(m, [[c, s], [-s, c], [0, 0]]);
}

// Writes the current frame's UV transform into `out` (a `THREE.Matrix3`,
// normally a texture's own `.matrix` with `matrixAutoUpdate` left false --
// reused in place rather than replaced, so an animated texture costs no
// per-frame allocation) -- the same shader-stage transform upstream's own
// `glLoadMatrixf` applies (`OpenGLGState.cxx:536-544`), composable on top of
// whatever UVs the geometry already carries.
function applyTextureMatrix(tm, t, out) {
  const staticMatrix = [[1, 0], [0, 1], [0, 0]];
  const radiansFixed = tm.fixedSpin * (Math.PI / 180);
  tm_shift(staticMatrix, -(tm.fixedShiftU + tm.fixedCenterU), -(tm.fixedShiftV + tm.fixedCenterV));
  tm_spin(staticMatrix, -radiansFixed);
  tm_scale(staticMatrix, 1 / tm.fixedScaleU, 1 / tm.fixedScaleV);
  tm_shift(staticMatrix, tm.fixedCenterU, tm.fixedCenterV);

  const partial = [[1, 0], [0, 1], [0, 0]];
  const radians = ((t * tm.spin) % 1) * Math.PI * 2;
  const urad = ((t * tm.scaleUFreq) % 1) * Math.PI * 2;
  const vrad = ((t * tm.scaleVFreq) % 1) * Math.PI * 2;
  const uratio = 0.5 + (0.5 * Math.cos(urad));
  const vratio = 0.5 + (0.5 * Math.sin(vrad));
  const uscl = 1 + (uratio * (tm.scaleU - 1));
  const vscl = 1 + (vratio * (tm.scaleV - 1));
  const ushf = (t * tm.shiftU) % 1;
  const vshf = (t * tm.shiftV) % 1;

  tm_shift(partial, -(ushf + tm.centerU), -(vshf + tm.centerV));
  tm_spin(partial, -radians);
  tm_scale(partial, 1 / uscl, 1 / vscl);
  tm_shift(partial, tm.centerU, tm.centerV);
  tm_multiply(partial, staticMatrix);

  out.set(
    partial[0][0], partial[1][0], partial[2][0],
    partial[0][1], partial[1][1], partial[2][1],
    0, 0, 1,
  );
}

// Upstream's own default teleporter glow is a `LinkMaterial` a map can
// override but every sampled real one leaves at its stock values --
// `textureMatrix name LinkMaterial \n shift 0 -0.05 \n end` (confirmed
// verbatim in `maps/dw_missilewar3.bzw`, `maps/ahs3_Ironside_Battlefield.bzw`).
// `_updateTeleporterVisuals` runs this through the same `applyTextureMatrix`
// a map-authored `texmat` uses, rather than a hand-tuned `texture.offset`
// approximation -- the two are not the same transform (Three's own
// offset/repeat/rotation composition is a different formula from upstream's
// shift/spin/scale one), which is what previously scrolled the portal
// texture the opposite direction from a real client.
const TELEPORTER_LINK_TEXTURE_MATRIX = {
  fixedShiftU: 0, fixedShiftV: 0, fixedScaleU: 1, fixedScaleV: 1, fixedSpin: 0, fixedCenterU: 0.5, fixedCenterV: 0.5,
  shiftU: 0, shiftV: -0.05, spin: 0, scaleUFreq: 0, scaleVFreq: 0, scaleU: 1, scaleV: 1, centerU: 0.5, centerV: 0.5,
};

// A tinted obstacle's debug label wears its colour, so a map's painting can be
// read off the label as well as off the obstacle. The cap first: the label hangs
// over the top.
function getObstacleTintHex(obs) {
  const tint = obs?.capColor || obs?.wallColor;
  if (!tint) return undefined;
  const channel = (value) => Math.round(Math.max(0, Math.min(1, value)) * 0xff);
  return (channel(tint[0]) << 16) | (channel(tint[1]) << 8) | channel(tint[2]);
}
// A pyramid's slanted sides. CustomPyramid.cxx:53-57 paints its base with the
// same "pyrwall" its sides get, at the same -8 texsize (CustomPyramid.cxx:
// 59-64) -- bzo deliberately does not follow that: its base cap keeps a box's
// own "roof" look instead, at a box cap's tighter scale (below). Intentional,
// not a parity gap -- do not "fix" this to match upstream again.
const PYRAMID_TEXTURE_SCALE = 8;
const PYRAMID_ROOF_TEXTURE_SCALE = 2;
const GROUND_CENTER_SIZE = 128; // upstream centerSize
const GROUND_TEX_REPEAT = 0.05; // upstream groundHighResTexRepeat (defaultBZDB.cxx:82)
// Upstream's five triangle strips over the four outer and four centre corners.
const GROUND_EYE_SCRATCH = new THREE.Vector3();

const GROUND_STRIPS = [
  [4, 5, 7, 6],
  [0, 1, 4, 5],
  [1, 2, 5, 6],
  [2, 3, 6, 7],
  [3, 0, 7, 4],
];

export class WorldRendering {
  clearGround() {
    if (this.mirror) {
      this.mirror.removeFromParent();
      this.mirror.dispose();
      this.mirror.geometry.dispose();
      this.mirror = null;
    }
    this._animatedMaterials = this._animatedMaterials.filter((entry) => entry.source !== 'ground');
    // The material's `dispose` does not reach its map, and the zone ground is a
    // second texture the material is not holding when the standard one is up.
    if (this._groundTexture) this._groundTexture.dispose();
    if (this._zoneGroundTexture) this._zoneGroundTexture.dispose();
    this._groundTexture = null;
    this._zoneGroundTexture = null;
    this._zoneGroundActive = false;
    if (this.ground && this.scene) {
      this.ground.removeFromParent();
      this.ground.geometry.dispose();
      this.ground.material.dispose();
      this.ground = null;
      this.groundExtent = null;
      this.groundMapSize = null;
    }
    if (this.projectedShadowOverlay && this.scene) {
      this.projectedShadowOverlay.removeFromParent();
      this.projectedShadowOverlay.geometry.dispose();
      this.projectedShadowOverlay.material.dispose();
      this.projectedShadowOverlay = null;
    }
    this._disposeGroundGrid();
  }

  // A box's four walls and its two caps, as one shared material each. The
  // texture's repeat is baked into the geometry's UVs rather than the material,
  // which is what lets every box in the world share them: nothing about the
  // material depends on the box's size. `_prepareBoxGeometry` also puts
  // the four walls next to each other in the index buffer, so a box is two draw
  // calls rather than the six a BoxGeometry's own face groups ask for.
  //
  // Shared, so never disposed with the mesh -- `clearObstacles` drops the cache
  // once every mesh using it is gone.
  // `unlit.side`/`unlit.cap` is a material's own `nolighting` flag
  // (docs/bzw.md, "Materials and appearance") -- upstream stops lighting the
  // face rather than tinting it, so this swaps the class rather than adding
  // an option Lambert would just ignore.
  // `animation` -- `{ wallDynamicColor, capDynamicColor, wallTextureMatrix,
  // capTextureMatrix }`, a box/pyramid's own resolved `dyncol`/`texmat`
  // (`docs/bzw.md`, "Animated materials"). Registered into
  // `_animatedMaterials` here, at creation, rather than at the call site --
  // `key` already folds each one's identity in (`animIdentityKey`, at every
  // call site below), so a cache hit means this obstacle shares an already-
  // registered material rather than needing a second registration. Assumes
  // no obstacle also states a static `wallColor`/`capColor` on the same
  // slot -- true of every obstacle in `maps/bzo.bzw` today -- since a
  // vertex-baked tint and a live `material.color` write would otherwise
  // fight every frame; `dyncol` replaces a slot's diffuse outright upstream
  // too (`MeshSceneNode.cxx:487-491`), so this is the same rule, just not
  // yet arbitrated against `_addObstacleFragment`'s own tint argument.
  _getSharedObstacleMaterials(key, sideTextureFactory, topTextureFactory, options = {}, unlit = {}, animation = {}, lighting = {}) {
    if (!this._sharedObstacleMaterials) this._sharedObstacleMaterials = new Map();
    const existing = this._sharedObstacleMaterials.get(key);
    if (existing) return existing;
    const SideClass = unlit.side ? THREE.MeshBasicMaterial : pickLitMaterialClass(lighting.wallSpecular);
    const CapClass = unlit.cap ? THREE.MeshBasicMaterial : pickLitMaterialClass(lighting.capSpecular);
    // `sideMaterial`/`capMaterial` are declared before either factory runs so
    // the alpha callback below always closes over the real material -- safe
    // even though a factory may invoke it before returning (an already-known
    // answer), since `registerAlphaCallback` defers that case to a microtask,
    // which never runs until this whole statement (and both `let`s) finishes.
    let sideMaterial;
    let capMaterial;
    sideMaterial = new SideClass({
      map: sideTextureFactory((hasAlpha, minAlpha) => applyTextureAlpha(sideMaterial, hasAlpha, key, minAlpha)),
      ...options,
      ...(unlit.side ? {} : buildLightingMaterialOptions(lighting.wallSpecular, lighting.wallShininess, lighting.wallEmission)),
    });
    capMaterial = new CapClass({
      map: topTextureFactory((hasAlpha, minAlpha) => applyTextureAlpha(capMaterial, hasAlpha, key, minAlpha)),
      ...options,
      ...(unlit.cap ? {} : buildLightingMaterialOptions(lighting.capSpecular, lighting.capShininess, lighting.capEmission)),
    });
    const materials = [sideMaterial, capMaterial];
    materials.forEach((material) => { material.userData.shared = true; });
    const { wallDynamicColor, capDynamicColor, wallTextureMatrix, capTextureMatrix } = animation;
    if (wallDynamicColor) {
      sideMaterial.transparent = true;
      sideMaterial.depthWrite = false;
      this._animatedMaterials.push({ material: sideMaterial, dynamicColor: wallDynamicColor, source: 'obstacle' });
    }
    if (capDynamicColor) {
      capMaterial.transparent = true;
      capMaterial.depthWrite = false;
      this._animatedMaterials.push({ material: capMaterial, dynamicColor: capDynamicColor, source: 'obstacle' });
    }
    if (wallTextureMatrix && sideMaterial.map) {
      sideMaterial.map.matrixAutoUpdate = false;
      this._animatedMaterials.push({ texture: sideMaterial.map, textureMatrix: wallTextureMatrix, source: 'obstacle' });
    }
    if (capTextureMatrix && capMaterial.map) {
      capMaterial.map.matrixAutoUpdate = false;
      this._animatedMaterials.push({ texture: capMaterial.map, textureMatrix: capTextureMatrix, source: 'obstacle' });
    }
    this._sharedObstacleMaterials.set(key, materials);
    return materials;
  }

  // Takes a key or a predicate over keys, because the boxes and the boundary
  // walls are torn down separately and each owns only its own entries.
  _disposeSharedObstacleMaterials(selector) {
    if (!this._sharedObstacleMaterials) return;
    const matches = typeof selector === 'function' ? selector : (key) => key === selector;
    [...this._sharedObstacleMaterials.keys()].forEach((key) => {
      if (!matches(key)) return;
      this._sharedObstacleMaterials.get(key).forEach((material) => {
        material.map?.dispose();
        material.dispose();
      });
      this._sharedObstacleMaterials.delete(key);
    });
  }

  // Bakes a texture's UV transform into the vertices one geometry group uses, so
  // the material no longer carries it and can be shared by every obstacle of its
  // kind. Built with the same `Matrix3.setUvTransform` Three uses for
  // `map.matrix` (Texture.updateMatrix), so the vertices end up where the shader
  // would have put them. Groups must not share vertices, which holds for the box
  // and cone geometries this is used on.
  _bakeGroupUvTransform(geometry, groupIndex, transform) {
    const { repeatX = 1, repeatY = 1, rotation = 0, centerX = 0, centerY = 0 } = transform;
    const group = geometry.groups[groupIndex];
    const index = geometry.getIndex();
    const uv = geometry.attributes.uv;
    const matrix = new THREE.Matrix3().setUvTransform(0, 0, repeatX, repeatY, rotation, centerX, centerY);
    const scratch = new THREE.Vector2();
    const seen = new Set();
    for (let i = group.start; i < group.start + group.count; i += 1) {
      const vertex = index.getX(i);
      if (seen.has(vertex)) continue;
      seen.add(vertex);
      scratch.set(uv.getX(vertex), uv.getY(vertex)).applyMatrix3(matrix);
      uv.setXY(vertex, scratch.x, scratch.y);
    }
    uv.needsUpdate = true;
  }

  // A BoxGeometry whose UVs already carry the tiling and whose faces are grouped
  // as walls then caps. Vertices come out of BoxGeometry four to a face in the
  // order +X, -X, +Y, -Y, +Z, -Z, and the index buffer six to a face in the same
  // order, which is what both loops below count on.
  // three.js's box, built as it builds one with its height on y, stood on z:
  // its own +y cap is the top, and its -z face looks along +y.
  _prepareStandingBoxGeometry(width, height, depth, options) {
    return standUpGeometry(this._prepareBoxGeometry(width, height, depth, options));
  }

  _prepareBoxGeometry(width, height, depth, { sideScale = 1, capScale = 1, omitFaces = [], capRepeat = null } = {}) {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    // A base's caps take the picture once however large the base is, which is
    // what upstream's getNextNode(1, 1) asks for (SceneBuilder.cxx:563).
    const caps = capRepeat || [width / capScale, depth / capScale];
    const faceRepeats = [
      [depth / sideScale, height / sideScale],  // +X
      [depth / sideScale, height / sideScale],  // -X
      caps,                                     // +Y
      caps,                                     // -Y
      [width / sideScale, height / sideScale],  // +Z
      [width / sideScale, height / sideScale],  // -Z
    ];
    const uv = geometry.attributes.uv;
    for (let face = 0; face < 6; face += 1) {
      const [repeatU, repeatV] = faceRepeats[face];
      for (let vertex = face * 4; vertex < (face * 4) + 4; vertex += 1) {
        uv.setXY(vertex, uv.getX(vertex) * repeatU, uv.getY(vertex) * repeatV);
      }
    }
    uv.needsUpdate = true;

    // The caps are already adjacent; the walls are not, so the index buffer is
    // rewritten to put them together and the whole box becomes two groups.
    const index = geometry.getIndex().array;
    const face = (n) => Array.from(index.slice(n * 6, (n * 6) + 6));
    const omitted = new Set(omitFaces);
    const kept = (faces) => faces.filter((n) => !omitted.has(n)).flatMap(face);
    const walls = kept([BOX_FACE.PX, BOX_FACE.NX, BOX_FACE.PZ, BOX_FACE.NZ]);
    const capFaces = kept([BOX_FACE.PY, BOX_FACE.NY]);
    geometry.setIndex([...walls, ...capFaces]);
    geometry.clearGroups();
    if (walls.length) geometry.addGroup(0, walls.length, 0);
    if (capFaces.length) geometry.addGroup(walls.length, capFaces.length, 1);
    return geometry;
  }

  _disposeObject3D(object3D) {
    if (!object3D) return;

    object3D.traverse((child) => {
      this._removeProjectedShadowMesh(child);

      if (child.geometry) {
        child.geometry.dispose();
      }

      // Shared materials outlive any one mesh; whoever owns the cache disposes
      // them once nothing is left using them.
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => {
          if (!material.userData.shared) material.dispose();
        });
      } else if (child.material && !child.material.userData.shared) {
        child.material.dispose();
      }
    });
  }

  _createTeleporterMesh(obs, nameSuffix = '') {
    // The frame as it arrives: `w`/`d`/`h` are the solid, resolved once by the
    // importer, so the drawn frame is the collided frame by construction rather
    // than by two places agreeing to add the same border. The opening inside it
    // is upstream's scene generator subtraction, `getBreadth() - border` and
    // `getHeight() - border`.
    const halfWidth = obs.size[0];
    const halfBreadth = obs.size[1];
    const height = obs.size[2];
    const border = obs.border;

    const innerBreadth = Math.max(0.1, halfBreadth - border);
    const halfBorder = border * 0.5;
    const portalHeight = Math.max(0.2, height - border);

    const teleporter = new THREE.Group();
    teleporter.name = obs.name || `Teleporter ${nameSuffix}`;
    teleporter.userData.isTeleporter = true;

    const borderTexture = createTeleporterBorderTexture();
    const baseFrameMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: borderTexture,
      emissive: 0x221900,
      emissiveIntensity: 0.18,
      side: THREE.DoubleSide,
    });
    const outerFrameMaterial = baseFrameMaterial.clone();
    outerFrameMaterial.color.setRGB(1.0, 0.875, 0.0);
    const innerFrameMaterial = baseFrameMaterial.clone();
    innerFrameMaterial.color.setRGB(0.9, 0.8, 0.0);

    const portalTextureFront = createTeleporterPortalTexture();
    const portalTextureBack = createTeleporterPortalTexture();
    // `_updateTeleporterVisuals` drives `.matrix` directly every frame
    // (`applyTextureMatrix`), so Three must not recompute it from
    // `.offset`/`.repeat`/`.rotation` behind that.
    portalTextureFront.matrixAutoUpdate = false;
    portalTextureBack.matrixAutoUpdate = false;

    const centerMaterialFront = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: portalTextureFront,
      transparent: true,
      opacity: 0.56,
      depthWrite: true,
      fog: false,
      toneMapped: false,
      side: THREE.FrontSide,
    });
    const centerMaterialBack = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: portalTextureBack,
      transparent: true,
      opacity: 0.56,
      depthWrite: true,
      fog: false,
      toneMapped: false,
      side: THREE.FrontSide,
    });

    const texCoords = [
      [[0.0, 0.0], [0.5, 0.0], [0.5, 9.5], [0.0, 9.5]],
      [[0.5, 0.0], [1.0, 0.0], [1.0, 9.5], [0.5, 9.5]],
      [[0.0, 0.0], [0.5, 0.0], [0.5, 9.0], [0.0, 9.0]],
      [[0.5, 0.0], [1.0, 0.0], [1.0, 9.0], [0.5, 9.0]],
      [[0.5, 0.0], [1.0, 0.0], [1.0, 9.0], [0.5, 9.0]],
      [[0.0, 0.0], [0.5, 0.0], [0.5, 9.0], [0.0, 9.0]],
      [[0.5, 0.0], [1.0, 0.0], [1.0, 9.0], [0.5, 9.0]],
      [[0.0, 0.0], [0.5, 0.0], [0.5, 9.0], [0.0, 9.0]],
      [[0.0, 0.0], [0.0, 0.0], [0.5, 5.0], [0.5, 5.0]],
      [[0.0, 0.0], [0.0, 0.0], [0.5, 4.0], [0.5, 4.0]],
      [[0.0, 0.0], [5.0, 0.0], [5.0, 0.5], [0.0, 0.5]],
      [[0.0, 0.5], [5.0, 0.5], [5.0, 1.0], [0.0, 1.0]],
    ];

    // A teleporter is fourteen small quads sharing four materials between them.
    // They accumulate per material here and become one mesh each below, rather
    // than one draw call per quad -- a map with eight teleporters would
    // otherwise cost over a hundred draws for a few hundred triangles. No quad
    // shares a vertex with another, so the normals a merged geometry computes
    // are still per-quad.
    const quadBuckets = new Map();
    const addQuad = (base, sEdge, tEdge, uvCoords, material, renderOrder = 5) => {
      let bucket = quadBuckets.get(material);
      if (!bucket) {
        bucket = { material, renderOrder, positions: [], uvs: [], indices: [] };
        quadBuckets.set(material, bucket);
      }
      const p0 = new THREE.Vector3(base[0], base[1], base[2]);
      const p1 = new THREE.Vector3(base[0] + sEdge[0], base[1] + sEdge[1], base[2] + sEdge[2]);
      const p2 = new THREE.Vector3(base[0] + sEdge[0] + tEdge[0], base[1] + sEdge[1] + tEdge[1], base[2] + sEdge[2] + tEdge[2]);
      const p3 = new THREE.Vector3(base[0] + tEdge[0], base[1] + tEdge[1], base[2] + tEdge[2]);

      const first = bucket.positions.length / 3;
      bucket.positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
      for (const [u, v] of uvCoords) bucket.uvs.push(u, v);
      bucket.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    };

    const buildQuadBuckets = () => {
      quadBuckets.forEach((bucket) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
        geometry.setIndex(bucket.indices);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, bucket.material);
        mesh.renderOrder = bucket.renderOrder;
        teleporter.add(mesh);
      });
    };

    const x = [1.0, 0.0];
    const y = [0.0, 1.0];
    const h = innerBreadth;
    const b = halfBorder;
    const d = h + b;
    const z = portalHeight;

    const quads = [
      { base: [d * y[0] + b * x[0] + b * y[0], d * y[1] + b * x[1] + b * y[1], 0.0], s: [-2.0 * b * x[0], -2.0 * b * x[1], 0.0], t: [0.0, 0.0, z + 2.0 * b] },
      { base: [-d * y[0] - b * x[0] - b * y[0], -d * y[1] - b * x[1] - b * y[1], 0.0], s: [2.0 * b * x[0], 2.0 * b * x[1], 0.0], t: [0.0, 0.0, z + 2.0 * b] },
      { base: [d * y[0] - b * x[0] - b * y[0], d * y[1] - b * x[1] - b * y[1], 0.0], s: [2.0 * b * x[0], 2.0 * b * x[1], 0.0], t: [0.0, 0.0, z] },
      { base: [-d * y[0] + b * x[0] + b * y[0], -d * y[1] + b * x[1] + b * y[1], 0.0], s: [-2.0 * b * x[0], -2.0 * b * x[1], 0.0], t: [0.0, 0.0, z] },
      { base: [d * y[0] + b * x[0] - b * y[0], d * y[1] + b * x[1] - b * y[1], 0.0], s: [2.0 * b * y[0], 2.0 * b * y[1], 0.0], t: [0.0, 0.0, z] },
      { base: [-d * y[0] - b * x[0] + b * y[0], -d * y[1] - b * x[1] + b * y[1], 0.0], s: [-2.0 * b * y[0], -2.0 * b * y[1], 0.0], t: [0.0, 0.0, z] },
      { base: [d * y[0] - b * x[0] + b * y[0], d * y[1] - b * x[1] + b * y[1], 0.0], s: [-2.0 * b * y[0], -2.0 * b * y[1], 0.0], t: [0.0, 0.0, z] },
      { base: [-d * y[0] + b * x[0] - b * y[0], -d * y[1] + b * x[1] - b * y[1], 0.0], s: [2.0 * b * y[0], 2.0 * b * y[1], 0.0], t: [0.0, 0.0, z] },
      { base: [-d * y[0] - b * x[0] - b * y[0], -d * y[1] - b * x[1] - b * y[1], z + 2.0 * b], s: [2.0 * b * x[0], 2.0 * b * x[1], 0.0], t: [2.0 * (d + b) * y[0], 2.0 * (d + b) * y[1], 0.0] },
      { base: [-d * y[0] + b * x[0] + b * y[0], -d * y[1] + b * x[1] + b * y[1], z], s: [-2.0 * b * x[0], -2.0 * b * x[1], 0.0], t: [2.0 * (d - b) * y[0], 2.0 * (d - b) * y[1], 0.0] },
      { base: [-d * y[0] + b * x[0] - b * y[0], -d * y[1] + b * x[1] - b * y[1], z], s: [2.0 * (d + b) * y[0], 2.0 * (d + b) * y[1], 0.0], t: [0.0, 0.0, 2.0 * b] },
      { base: [d * y[0] - b * x[0] + b * y[0], d * y[1] - b * x[1] + b * y[1], z], s: [-2.0 * (d + b) * y[0], -2.0 * (d + b) * y[1], 0.0], t: [0.0, 0.0, 2.0 * b] },
    ];

    quads.forEach((quad, index) => {
      const material = index <= 1 ? outerFrameMaterial : innerFrameMaterial;
      addQuad(quad.base, quad.s, quad.t, texCoords[index], material);
    });

    // Each portal faces out of its own side of the frame.
    const addPortalFace = (xPos, material, facingNegativeX = false) => {
      const portalRepeatV = (height) / Math.max(0.1, 2.0 * innerBreadth);
      const baseY = facingNegativeX ? innerBreadth : -innerBreadth;
      const spanY = facingNegativeX ? -2.0 * innerBreadth : 2.0 * innerBreadth;
      addQuad(
        [xPos, baseY, 0.0],
        [0.0, spanY, 0.0],
        [0.0, 0.0, portalHeight],
        [[0.0, 0.0], [1.0, 0.0], [1.0, portalRepeatV], [0.0, portalRepeatV]],
        material,
        6,
      );
    };

    addPortalFace(halfWidth, centerMaterialFront, false);
    addPortalFace(-halfWidth, centerMaterialBack, true);

    buildQuadBuckets();

    teleporter.userData.portalMaterials = [centerMaterialFront, centerMaterialBack];
    teleporter.userData.portalTextures = [portalTextureFront, portalTextureBack];
    teleporter.userData.portalPhase = (obs.pos[0] * 0.031) - (obs.pos[1] * 0.017);

    return teleporter;
  }

  _updateTeleporterVisuals(timeSeconds = 0) {
    for (const obstacle of this.obstacleMeshes) {
      if (!obstacle?.userData?.isTeleporter) continue;
      const portalMaterials = obstacle.userData.portalMaterials;
      const portalTextures = obstacle.userData.portalTextures;
      const phase = obstacle.userData.portalPhase || 0;
      if (!Array.isArray(portalMaterials) || !Array.isArray(portalTextures)) continue;

      const cycle = ((timeSeconds + phase) / 2.0) * (Math.PI * 2.0);
      const red = 0.125 + (0.125 * Math.sin(cycle));
      const green = 0.125 + (0.125 * Math.sin(cycle + ((Math.PI * 2.0) / 3.0)));
      const blue = 0.125 + (0.125 * Math.sin(cycle + ((Math.PI * 4.0) / 3.0)));
      const opacity = 0.75;
      portalMaterials.forEach((material) => {
        if (!material) return;
        material.color.setRGB(red, green, blue);
        material.opacity = opacity;
      });

      const frontTexture = portalTextures[0];
      const backTexture = portalTextures[1];
      if (frontTexture) {
        applyTextureMatrix(TELEPORTER_LINK_TEXTURE_MATRIX, timeSeconds, frontTexture.matrix);
      }
      if (backTexture) {
        applyTextureMatrix(TELEPORTER_LINK_TEXTURE_MATRIX, timeSeconds, backTexture.matrix);
      }
    }
  }

  // A map-authored `dyncol`/`texmat` (`_buildMeshObject`'s own registration,
  // above) -- `DynamicColorManager::update`/`TextureMatrixManager::update`'s
  // own per-frame pass (`DynamicColor.cxx:60-69`, `TextureMatrix.cxx:54-63`),
  // one shared evaluation per named descriptor rather than a separate one
  // per material, matching upstream's own manager loop.
  _updateAnimatedMaterials(timeSeconds = 0) {
    for (const entry of this._animatedMaterials) {
      if (entry.dynamicColor) {
        const [r, g, b, a] = evaluateDynamicColor(entry.dynamicColor, timeSeconds);
        entry.material.color.setRGB(r, g, b);
        entry.material.opacity = a;
      }
      if (entry.textureMatrix) {
        applyTextureMatrix(entry.textureMatrix, timeSeconds, entry.texture.matrix);
      }
    }
  }

  // A spinning mesh's own pivot group (`angvel`, #88 -- see `setMeshes`),
  // rotated fresh each frame off the same shared wall clock rather than
  // accumulated -- `MeshDrawInfo::updateAnimation`'s own `fmod(angvel * time,
  // 360)`, not a per-frame delta, so a client that just joined starts every
  // spinning mesh at the same phase as one that has been watching it all along.
  _updateMeshSpins(timeSeconds = 0) {
    for (const spin of this._meshSpins) {
      const radians = meshSpinRadians(spin.angvel, timeSeconds);
      if (spin.axis) spin.group.quaternion.setFromAxisAngle(spin.axis, radians);
      else spin.group.rotation.z = radians;
    }
  }

  _clearObjectForRemoval(object3D) {
    if (!object3D) return;
    this._removeProjectedShadowMesh(object3D);
    this._disposeObject3D(object3D);
    object3D.removeFromParent();
  }

  // The ground's eight corners: four at the edge of the world, four around the
  // eye. Texture coordinates are the world position scaled by the repeat, as
  // upstream's `glTexCoord2f(vertices[index][0] * repeat, ...)` does, so the
  // texture is pinned to the world rather than to the patch that moves under it.
  _buildCenteredGroundGeometry(groundExtent) {
    const geometry = new THREE.BufferGeometry();
    const normals = new Float32Array(8 * 3);
    for (let i = 0; i < 8; i++) normals[i * 3 + 2] = 1;
    const indices = [];
    for (const [a, b, c, d] of GROUND_STRIPS) {
      indices.push(a, b, c, c, b, d);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(8 * 2), 2));
    geometry.setIndex(indices);
    // Four of the corners move every frame, so a bound measured from them would
    // be stale; the ground reaches the edge of the world in any case.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), groundExtent * 2);
    return geometry;
  }

  _setGroundCorner(index, x, y) {
    const { position, uv } = this.ground.geometry.attributes;
    position.setXYZ(index, x, y, 0);
    uv.setXY(index, x * GROUND_TEX_REPEAT, y * GROUND_TEX_REPEAT);
  }

  // Keeps the centre patch under the eye, clamped so it never leaves the skirt
  // it is cut out of. Called once per frame, before the scene is drawn.
  updateGroundCenter() {
    if (!this.ground || !this.camera || !this.worldFrame) return;
    const limit = this.groundExtent - GROUND_CENTER_SIZE;
    if (!(limit > 0)) return;

    this.camera.updateWorldMatrix(true, false);
    this.worldFrame.updateWorldMatrix(true, false);
    const eye = this.camera.getWorldPosition(GROUND_EYE_SCRATCH);
    this.worldFrame.worldToLocal(eye);
    const centerX = Math.max(-limit, Math.min(limit, eye.x));
    const centerY = Math.max(-limit, Math.min(limit, eye.y));
    if (this._groundCenterX === centerX && this._groundCenterY === centerY) return;
    this._groundCenterX = centerX;
    this._groundCenterY = centerY;

    const size = GROUND_CENTER_SIZE;
    this._setGroundCorner(4, centerX - size, centerY - size);
    this._setGroundCorner(5, centerX + size, centerY - size);
    this._setGroundCorner(6, centerX + size, centerY + size);
    this._setGroundCorner(7, centerX - size, centerY + size);
    this.ground.geometry.attributes.position.needsUpdate = true;
    this.ground.geometry.attributes.uv.needsUpdate = true;
  }

  // `groundMaterial` -- the parsed `-gndtex`/`GroundMaterial` block (see
  // `groundMaterial` in server.js's `parseBZWMap`), `null` for a map that
  // states neither, which keeps upstream's own default `std_ground`
  // checkerboard (`BackgroundRenderer::setupGroundMaterials`,
  // `BackgroundRenderer.cxx:265-303` -- falls back to `stdGroundTexture`
  // the same way when no material named `GroundMaterial` is registered).
  // `_mirror`: the world under a mirror ground (SceneRenderer.cxx:748). Upstream
  // draws the scene once flipped about the ground, lays the mirror's colour
  // over all of it at the colour's alpha, and draws the real scene on top with
  // no ground at all -- so where the ground would be, a player sees the
  // reflection under that tint. A `Reflector` is the same picture: the mirrored
  // view rendered into the ground's own place, composited as upstream's quad
  // composites it. Half resolution, since it is a second render of the world.
  setMirror(rgba) {
    this._mirrorColor = Array.isArray(rgba) ? rgba : null;
  }

  _buildMirror(groundExtent) {
    const [r, g, b, a] = this._mirrorColor;
    const pixelRatio = this.renderer?.getPixelRatio?.() || 1;
    const width = Math.max(256, Math.floor((window.innerWidth * pixelRatio) / 2));
    const height = Math.max(256, Math.floor((window.innerHeight * pixelRatio) / 2));
    const mirror = new Reflector(new THREE.PlaneGeometry(groundExtent, groundExtent), {
      color: new THREE.Color(r, g, b),
      textureWidth: width,
      textureHeight: height,
      clipBias: 0.003,
      multisample: 0,
      shader: BZFLAG_MIRROR_SHADER,
    });
    mirror.material.uniforms.tintAlpha.value = a;
    mirror.receiveShadow = false;
    this.mirror = mirror;
    this.worldFrame.add(this._tagDraws(mirror, 'world'));
  }

  buildGround(mapSize, groundMaterial = null) {
    if (!this.scene) return;
    this.clearGround();
    // A mirror world draws no ground, whatever `_drawGround` says.
    if (this._mirrorColor) {
      this._buildMirror(mapSize * 10);
      return;
    }
    if (!this._worldDraws('ground')) return;

    const groundExtent = mapSize * 10;
    const groundGeometry = this._buildCenteredGroundGeometry(groundExtent);
    const hasCustomTexture = !!(groundMaterial?.texture || groundMaterial?.textureUrl);
    const groundTexture = hasCustomTexture
      ? resolveObstacleTextureFactory(
        groundMaterial.texture, groundMaterial.textureUrl, '/textures/std_ground.png', createGroundTexture,
      )(() => {})
      : createGroundTexture();
    groundTexture.wrapS = THREE.RepeatWrapping;
    groundTexture.wrapT = THREE.RepeatWrapping;

    // The ground is the largest thing on screen, so it is the last surface that
    // should carry the most expensive shader. Upstream lights it diffuse-only,
    // and every other surface here is Lambert; a metalness/roughness BRDF over
    // that many fragments is paid for nothing. Front faces only: the ground is
    // never seen from below.
    const groundMeshMaterial = new THREE.MeshLambertMaterial({
      map: groundTexture,
      // `groundColor` upstream (`BackgroundRenderer.cxx:271-283`) tints the
      // ground the same way any other material's `diffuse` line tints a
      // textured obstacle here -- `MeshLambertMaterial`'s `color` multiplies
      // the map, white leaving the texture exactly as shipped.
      color: groundMaterial?.color
        ? new THREE.Color(...groundMaterial.color)
        : 0xffffff,
      side: THREE.FrontSide,
    });

    // A `GroundMaterial`'s own `dyncol`/`texmat` (`BackgroundRenderer`'s own
    // ground material is a `BzMaterial` like any other, so it can carry
    // either) -- the same `_animatedMaterials` registration `buildWater`
    // already does for its own material/texture, just never wired up for
    // the ground until now (issue #81 gave the ground a material at all, but
    // stopped at texture/color).
    if (groundMaterial?.dynamicColor) {
      this._animatedMaterials.push({ material: groundMeshMaterial, dynamicColor: groundMaterial.dynamicColor, source: 'ground' });
    }
    if (groundMaterial?.textureMatrix) {
      groundTexture.matrixAutoUpdate = false;
      this._animatedMaterials.push({ texture: groundTexture, textureMatrix: groundMaterial.textureMatrix, source: 'ground' });
    }

    this._groundTexture = groundTexture;
    this._zoneGroundTexture = null;
    this.ground = new THREE.Mesh(groundGeometry, groundMeshMaterial);
    this.ground.frustumCulled = false;
    // Before the mountains, after the sky -- see `GROUND_RENDER_ORDER`.
    this.ground.renderOrder = GROUND_RENDER_ORDER;
    this.groundExtent = groundExtent;
    this.groundMapSize = mapSize;
    this._groundCenterX = null;
    this._groundCenterY = null;
    this._setGroundCorner(0, -groundExtent, -groundExtent);
    this._setGroundCorner(1, groundExtent, -groundExtent);
    this._setGroundCorner(2, groundExtent, groundExtent);
    this._setGroundCorner(3, -groundExtent, groundExtent);
    this.updateGroundCenter();
    this.worldFrame.add(this._tagDraws(this.ground, 'scenery'));

    this._refreshProjectedShadowOverlay();
    this.setGroundGridEnabled(this.showGroundGrid, mapSize);
  }

  clearWater() {
    this._animatedMaterials = this._animatedMaterials.filter((entry) => entry.source !== 'water');
    if (this.water && this.scene) {
      this.water.removeFromParent();
      this.water.geometry.dispose();
      this.water.material.map?.dispose();
      this.water.material.dispose();
      this.water = null;
    }
  }

  // `SceneDatabaseBuilder::addWaterLevel` (`SceneBuilder.cxx:272-308`): one
  // `BZDBCache::worldSize`-wide quad at the map's own height, its texture
  // tiled twice across the whole span rather than once (`t[1][0] = 2.0f`).
  // `WorldInfo::makeWaterMaterial`'s own defaults -- translucent, off the
  // radar -- apply whatever the map's own material lines replaced the tint
  // or the texture with, since bzo has no alpha channel on a plain `color`/
  // `diffuse` line to carry them instead (docs/bzw.md, "Colour"). `noRadar`
  // needs no code here at all: water is not in `OBSTACLES`, so the radar
  // never draws it regardless.
  buildWater(mapSize, waterLevel) {
    if (!this.scene) return;
    this.clearWater();
    if (!waterLevel || !Number.isFinite(waterLevel.height)) return;

    const geometry = new THREE.PlaneGeometry(mapSize, mapSize);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) {
      uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 2);
    }

    const hasTexture = !!(waterLevel.texture || waterLevel.textureUrl);
    let texture = null;
    if (hasTexture) {
      const textureFactory = resolveObstacleTextureFactory(
        waterLevel.texture, waterLevel.textureUrl, '/textures/water.png',
        () => createStockMaterialTexture('water'),
      );
      texture = textureFactory(() => {});
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
    }

    const [r, g, b] = waterLevel.color || [1, 1, 1];
    const MaterialClass = waterLevel.noLighting ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial;
    const material = new MaterialClass({
      map: texture,
      color: new THREE.Color(r, g, b),
      // `setUseTextureAlpha(true)` upstream -- forced translucency rather
      // than the render's usual per-texture alpha detection, and not
      // something a `color`/`diffuse` line can override (bzo drops the
      // fourth number there; see the comment above).
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.water = new THREE.Mesh(geometry, material);
    this.water.position.z = waterLevel.height;
    this.water.frustumCulled = false;
    this.worldFrame.add(this._tagDraws(this.water, 'scenery'));

    if (waterLevel.dynamicColor) {
      this._animatedMaterials.push({ material, dynamicColor: waterLevel.dynamicColor, source: 'water' });
    }
    if (waterLevel.textureMatrix && texture) {
      texture.matrixAutoUpdate = false;
      this._animatedMaterials.push({ texture, textureMatrix: waterLevel.textureMatrix, source: 'water' });
    }
  }

  createMapBoundaries(mapSize = 100, noWalls = false, wallHeight = WORLD_WALL_HEIGHT) {
    if (!this.scene) return;

    // Remove old boundary meshes and debug labels if present
    if (!this.boundaryMeshes) this.boundaryMeshes = [];
    this.boundaryMeshes.forEach((mesh) => {
      this._clearObjectForRemoval(mesh);
    });
    this.boundaryMeshes = [];
    this._disposeSharedObstacleMaterials('boundary');
    this._clearDebugLabels('boundary');

    // `_wallHeight`, the same figure the border colliders stand the solid part of
    // the wall up to, so what bounces a shot is exactly what a player can see.
    // Above it the barrier is invisible and lets shots through, which is what
    // upstream's outer wall does too.
    const wallThickness = 1;

    // Create and track boundary meshes
    const boundaryMeshes = [];

    // Remove old compass markers if present
    if (!this.compassMarkers) this.compassMarkers = [];
    this.compassMarkers.forEach(marker => {
      marker.removeFromParent();
      if (marker.material && marker.material.map) marker.material.map.dispose();
      if (marker.material) marker.material.dispose();
    });
    this.compassMarkers = [];

    // `noWalls` -- a map's `world` block skipped the border entirely. There is
    // nothing to draw, but the compass letters are still worth having: with no
    // wall to judge direction by, they are the only orientation cue left. A
    // `_wallHeight` of 0 is the same picture: the wall is there for tanks, but
    // nothing of it stands above the ground.
    if (noWalls || !(wallHeight > 0)) {
      const markerHeight = Math.max(wallHeight + 8, this.maxObstacleHeight + 5);
      this._addCompassMarker('N', 0xB20000, new THREE.Vector3(0, mapSize / 2, markerHeight));
      this._addCompassMarker('S', 0x1976D2, new THREE.Vector3(0, -mapSize / 2, markerHeight));
      this._addCompassMarker('E', 0x388E3C, new THREE.Vector3(mapSize / 2, 0, markerHeight));
      this._addCompassMarker('W', 0x9C27B0, new THREE.Vector3(-mapSize / 2, 0, markerHeight));
      this.boundaryMeshes = boundaryMeshes;
      return;
    }

    // Each wall drops the face that points away from the arena. Nothing is made
    // transparent: with the outward face gone, a camera outside the border meets
    // the inward face from behind, which back-face culling removes, and sees
    // straight into the arena. So backing a tank against the border in third
    // person shows the tank rather than the back of a wall, while from every
    // position a player can occupy the wall is as solid as it was.
    //
    // Upstream has no third person view and no equivalent of this.
    //
    // Each wall also drops its two end faces and runs exactly `mapSize` long,
    // meeting the perpendicular wall at the corner rather than overlapping it.
    // A camera can never reach the gap this opens behind the meeting point --
    // it is outside every wall's kept face -- so there is nothing there to cap.
    //
    // And each drops its top and bottom: upstream's border is a single quad
    // with no thickness, so the one face this wall is built around is the
    // whole of it. The bottom sits at ground level, where the ground itself
    // already hides it, and above `wallHeight` there is nothing to stand on
    // or see from outside -- shots already pass over that same edge.
    //
    // A standing box's -z face is the one facing north.
    const wallGeometry = (width, height, depth, omitFaces) => this._prepareStandingBoxGeometry(
      width, height, depth, { ...BOX_TEXTURE_SCALES, omitFaces },
    );
    const northWall = new THREE.Mesh(
      wallGeometry(mapSize, wallHeight, wallThickness, [BOX_FACE.NZ, BOX_FACE.PX, BOX_FACE.NX, BOX_FACE.PY, BOX_FACE.NY]),
      this._getSharedObstacleMaterials('boundary', createBoundaryTexture, createBoundaryTexture),
    );
    northWall.position.set(0, mapSize / 2 + wallThickness / 2, wallHeight / 2);
    northWall.castShadow = true;
    northWall.receiveShadow = true;
    northWall.name = 'North Wall';
    this.worldFrame.add(this._tagDraws(northWall, 'scenery'));
    boundaryMeshes.push(northWall);
    const markerHeight = Math.max(wallHeight + 8, this.maxObstacleHeight + 5);
    this._addCompassMarker('N', 0xB20000, new THREE.Vector3(0, mapSize / 2, markerHeight));
    this._addDebugLabel(northWall, 'boundary');


    const southWall = new THREE.Mesh(
      wallGeometry(mapSize, wallHeight, wallThickness, [BOX_FACE.PZ, BOX_FACE.PX, BOX_FACE.NX, BOX_FACE.PY, BOX_FACE.NY]),
      this._getSharedObstacleMaterials('boundary', createBoundaryTexture, createBoundaryTexture),
    );
    southWall.position.set(0, -mapSize / 2 - wallThickness / 2, wallHeight / 2);
    southWall.castShadow = true;
    southWall.receiveShadow = true;
    this.worldFrame.add(this._tagDraws(southWall, 'scenery'));
    southWall.name = 'South Wall';
    boundaryMeshes.push(southWall);
    this._addCompassMarker('S', 0x1976D2, new THREE.Vector3(0, -mapSize / 2, markerHeight));
    this._addDebugLabel(southWall, 'boundary');


    const eastWall = new THREE.Mesh(
      wallGeometry(wallThickness, wallHeight, mapSize, [BOX_FACE.PX, BOX_FACE.PZ, BOX_FACE.NZ, BOX_FACE.PY, BOX_FACE.NY]),
      this._getSharedObstacleMaterials('boundary', createBoundaryTexture, createBoundaryTexture),
    );
    eastWall.position.set(mapSize / 2 + wallThickness / 2, 0, wallHeight / 2);
    eastWall.castShadow = true;
    eastWall.receiveShadow = true;
    this.worldFrame.add(this._tagDraws(eastWall, 'scenery'));
    eastWall.name = 'East Wall';
    boundaryMeshes.push(eastWall);
    this._addCompassMarker('E', 0x388E3C, new THREE.Vector3(mapSize / 2, 0, markerHeight));
    this._addDebugLabel(eastWall, 'boundary');


    const westWall = new THREE.Mesh(
      wallGeometry(wallThickness, wallHeight, mapSize, [BOX_FACE.NX, BOX_FACE.PZ, BOX_FACE.NZ, BOX_FACE.PY, BOX_FACE.NY]),
      this._getSharedObstacleMaterials('boundary', createBoundaryTexture, createBoundaryTexture),
    );
    westWall.position.set(-mapSize / 2 - wallThickness / 2, 0, wallHeight / 2);
    westWall.castShadow = true;
    westWall.receiveShadow = true;
    this.worldFrame.add(this._tagDraws(westWall, 'scenery'));
    westWall.name = 'West Wall';
    boundaryMeshes.push(westWall);
    this._addCompassMarker('W', 0x9C27B0, new THREE.Vector3(-mapSize / 2, 0, markerHeight));
    this._addDebugLabel(westWall, 'boundary');

    this.boundaryMeshes = boundaryMeshes;
  }

  _addCompassMarker(letter, color, position) {
    if (!this.scene) return;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 256);
    ctx.font = 'bold 200px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 10;
    ctx.strokeText(letter, 128, 128);
    ctx.fillText(letter, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      depthTest: true,
      depthWrite: false,
      transparent: true,
      alphaTest: 0.1,
      fog: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.set(20, 20, 1);
    sprite.userData = { letter, initialY: position.y }; // Store metadata
    this.worldFrame.add(this._tagDraws(sprite, 'scenery'));
    if (!this.compassMarkers) this.compassMarkers = [];
    this.compassMarkers.push(sprite);
  }

  _updateCompassMarkerHeights() {
    if (!this.compassMarkers || this.compassMarkers.length === 0) return;
    const wallHeight = 5;
    const markerHeight = Math.max(wallHeight + 8, this.maxObstacleHeight + 5);
    this.compassMarkers.forEach(marker => {
      marker.position.z = markerHeight;
    });
  }

  // Upstream collates the faces of one mesh that share a material into a single
  // MeshFragSceneNode (MeshSceneNodeGenerator.cxx:206, "a collection of faces
  // with the same material properties"), and keeps translucent faces out of it
  // so they can still be depth sorted. bzo collates the same way but across
  // obstacles rather than within one, because a draw call costs far more here
  // than it does there: every box in the world becomes two draws and every
  // pyramid two more, instead of two each.
  //
  // The price is per-obstacle frustum culling, which is worth little on a map of
  // a few hundred obstacles and ten thousand triangles, against a client that
  // runs out of one core with the GPU idle. Bases and teleporters stay out: one
  // carries team colour and a hidden face, the other animates.
  //
  // `isBuried` is where the world's own hidden faces are dropped, since this is
  // the one place every obstacle's triangles are already in world space and
  // already being copied one at a time. A triangle it claims is kept out of the
  // buffers entirely, vertices and all.
  // `colors` is one colour per material group or null, and a fragment either
  // carries them for every vertex or for none: a base takes its team's, a box or
  // a pyramid the colour its map painted it, and each rides on the vertices
  // rather than on a material, which is what lets obstacles that are tinted
  // differently still merge into one mesh. A group the caller left out is white,
  // which multiplies its texture by nothing.
  // `remapWallUv`: upstream's AntiFlicker (QuadWallSceneNode.cxx:65,
  // `remapTexCoords`) -- the walls group (materialIndex 0, see
  // `_prepareBoxGeometry`) gets its UV recomputed from world position instead
  // of each box's own local corner, so two boxes that touch (stacked to build
  // a taller wall, or simply adjacent) sample the same phase of the tiling
  // instead of each restarting at 0. Only ever passed for the default box
  // texture -- bases keep their own stretched-to-fit tiling, and a wall that
  // never touches another one has no seam to fix, so there is no menu option:
  // it is strictly better here and costs nothing upstream didn't already
  // spend on the vertex it's replacing.
  _addObstacleFragment(fragments, key, materials, geometry, matrix, colors = null, isBuried = null, remapWallUv = false) {
    geometry.applyMatrix4(matrix);
    let fragment = fragments.get(key);
    if (!fragment) {
      fragment = {
        materials,
        colored: colors !== null,
        groups: materials.map(() => ({ positions: [], normals: [], uvs: [], colors: [], indices: [] })),
      };
      fragments.set(key, fragment);
    }
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const uv = geometry.attributes.uv;
    const index = geometry.getIndex();
    for (const group of geometry.groups) {
      const bucket = fragment.groups[group.materialIndex];
      if (!bucket) continue;
      const color = colors ? (colors[group.materialIndex] || WHITE_OBSTACLE_TINT) : null;
      // Only the walls (materialIndex 0) get remapped -- the roof keeps its
      // own local tiling, same as upstream leaves a box's top scene node out
      // of remapTexCoords.
      const remapUv = remapWallUv && group.materialIndex === 0;
      // A vertex is copied once however many of this group's triangles use it,
      // and a vertex no surviving triangle names is never copied at all.
      const remapped = new Map();
      const copyVertex = (vertex) => {
        let mapped = remapped.get(vertex);
        if (mapped === undefined) {
          mapped = bucket.positions.length / 3;
          remapped.set(vertex, mapped);
          bucket.positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
          bucket.normals.push(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
          if (remapUv) {
            // Wall normals are horizontal (nz ~ 0); rotating one by 90 degrees
            // about Z gives the direction the wall runs in, so its dot with
            // world XY is a coordinate that agrees with whatever else shares
            // this plane, however many boxes it takes to build it.
            const nx = normal.getX(vertex);
            const ny = normal.getY(vertex);
            const u = (position.getY(vertex) * nx) - (position.getX(vertex) * ny);
            const v = position.getZ(vertex);
            const { sideScale } = this._boxTextureScales();
            bucket.uvs.push(u / sideScale, v / sideScale);
          } else {
            bucket.uvs.push(uv.getX(vertex), uv.getY(vertex));
          }
          if (color) bucket.colors.push(color[0], color[1], color[2]);
        }
        bucket.indices.push(mapped);
      };
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const first = index.getX(i);
        const second = index.getX(i + 1);
        const third = index.getX(i + 2);
        if (isBuried && isBuried(
          position.getX(first), position.getY(first), position.getZ(first),
          position.getX(second), position.getY(second), position.getZ(second),
          position.getX(third), position.getY(third), position.getZ(third),
        )) continue;
        copyVertex(first);
        copyVertex(second);
        copyVertex(third);
      }
    }
  }

  // One mesh per fragment, its materials in the same order as its groups.
  _buildObstacleFragments(fragments) {
    fragments.forEach(({ materials, groups, colored }, key) => {
      const positions = [];
      const normals = [];
      const uvs = [];
      const colors = [];
      const indices = [];
      const geometry = new THREE.BufferGeometry();
      groups.forEach((bucket, materialIndex) => {
        if (!bucket.indices.length) return;
        const vertexOffset = positions.length / 3;
        const indexOffset = indices.length;
        positions.push(...bucket.positions);
        normals.push(...bucket.normals);
        uvs.push(...bucket.uvs);
        colors.push(...bucket.colors);
        for (const value of bucket.indices) indices.push(value + vertexOffset);
        geometry.addGroup(indexOffset, bucket.indices.length, materialIndex);
      });
      if (!indices.length) return;
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      if (colored) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const mesh = this._tagDraws(new THREE.Mesh(geometry, materials), key === 'base' ? 'base' : 'world');
      mesh.name = `${key} fragment`;
      // It is built in `worldFrame`'s space and never moves.
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.worldFrame.add(mesh);
      this.obstacleMeshes.push(mesh);
    });
  }

  clearObstacles() {
    if (!this.scene) return;
    this.obstacleMeshes.forEach((mesh) => {
      this._clearObjectForRemoval(mesh);
    });
    this.obstacleMeshes = [];
    // A box/pyramid's own `dyncol`/`texmat` registration (see
    // `_getSharedObstacleMaterials`) is tagged `source: 'obstacle'` so this
    // can drop only its own entries -- `clearMeshes` may run before or after
    // this during a world reload, and a blind reset here would race whichever
    // one runs second.
    this._animatedMaterials = this._animatedMaterials.filter((entry) => entry.source !== 'obstacle');
    // The eighth-dimension nodes are keyed by the obstacle objects the world
    // that is going away owns, so they go with it.
    this._clearInsideBuildings();
    // After the meshes, so nothing is still pointing at them. Every entry but
    // the boundary walls', which `createMapBoundaries` owns and clears itself.
    // Swept rather than named: a box or pyramid key is built from the
    // obstacle's textures, lighting and animation, so it is not a string this
    // can spell out in advance.
    this._disposeSharedObstacleMaterials((key) => key !== 'boundary');
    this._clearDebugLabels('obstacle');
  }

  // The ray from the camera through a point on the page, in the game's own
  // frame (z up), for the world viewer to pick with: `{ origin, dir }`, each
  // [x, y, z] with `dir` unit length, or null off the canvas.
  worldRayAt(clientX, clientY) {
    if (!this.renderer || !this.camera || !this.worldFrame) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const ndc = new THREE.Vector2(
      (((clientX - rect.left) / rect.width) * 2) - 1,
      -((((clientY - rect.top) / rect.height) * 2) - 1),
    );
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
    this.camera.updateMatrixWorld();
    this.worldFrame.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const origin = this.worldFrame.worldToLocal(raycaster.ray.origin.clone());
    const ahead = this.worldFrame.worldToLocal(raycaster.ray.origin.clone().add(raycaster.ray.direction));
    const dir = ahead.sub(origin).normalize();
    return { origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z] };
  }

  // The world viewer's outline of the obstacle it is showing: its own box,
  // turned as it is, or a mesh's bounds. Drawn through everything else so it
  // reads from behind a wall too. Null clears it.
  setInspectHighlight(obs) {
    if (this._inspectHighlight) {
      this.worldFrame.remove(this._inspectHighlight);
      this._inspectHighlight.geometry.dispose();
      this._inspectHighlight.material.dispose();
      this._inspectHighlight = null;
    }
    if (!obs || !this.worldFrame) return;
    let size;
    let centre;
    let angle = 0;
    if (obs.type !== 'mesh' && obs.pos && obs.size) {
      const height = Math.max(Math.abs(obs.size[2] || 0), 0.05);
      size = [obs.size[0] * 2, obs.size[1] * 2, height];
      centre = [obs.pos[0], obs.pos[1], obs.pos[2] + (height / 2)];
      angle = obs.angle || 0;
    } else if (obs.bounds) {
      const b = obs.bounds;
      size = [b.maxX - b.minX, b.maxY - b.minY, Math.max(b.maxZ - b.minZ, 0.05)];
      centre = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
    } else {
      return;
    }
    const box = new THREE.BoxGeometry(...size);
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0xffeb3b, depthTest: false, transparent: true }),
    );
    box.dispose();
    outline.position.set(...centre);
    outline.rotation.z = angle;
    outline.renderOrder = 10;
    this.worldFrame.add(outline);
    this._inspectHighlight = outline;
  }

  setObstacles(obstacles = []) {
    if (!this.scene) return;
    this.clearObstacles();
    // A trail belongs to the map it was left on, which is upstream's
    // `TrackMarks::clear()` from `TrackMarks::init()`.
    this.clearTrackMarks();

    // Track max obstacle height for cardinal marker positioning
    this.maxObstacleHeight = 0;
    obstacles.forEach((obs) => {
      const h = getObstacleHeight(obs);
      const baseY = getObstacleBase(obs);
      const topY = baseY + h;
      if (topY > this.maxObstacleHeight) {
        this.maxObstacleHeight = topY;
      }
    });

    // The faces the world buries in itself. Worked out once for the whole
    // obstacle list, because every obstacle is a candidate to hide any other,
    // and then asked per triangle as the fragments are built below. Kept on
    // `this` too: a box or a pyramid's own eighth-dimension shell (#77) is
    // built lazily, long after this call returns, and needs the same answer
    // for the same reason the fragments do -- a face dropped from the outside
    // view because another obstacle buries it (four overlapping boxes making
    // an octagon, say) has an inside that is just as buried, and glowing it
    // additively would be a seam nobody outside ever sees but a phased tank
    // very much would.
    const isTriangleBuried = createBuriedTriangleTest(obstacles);
    this._insideBuildingBuriedTest = isTriangleBuried;

    // Boxes and pyramids collect here and become two meshes at the end.
    const fragments = new Map();
    const fragmentMatrix = new THREE.Matrix4();

    obstacles.forEach((obs, i) => {
      const h = getObstacleHeight(obs);
      const baseY = getObstacleBase(obs);
      const w = obstacleWidth(obs);
      const d = obstacleBreadth(obs);
      let mesh = null;
      // Where a label floats over it.
      const labelAt = () => new THREE.Vector3(obs.pos[0], obs.pos[1], baseY + h + 2);

      // What the obstacle's own mesh transform would have been, baked into the
      // vertices instead because the merged mesh cannot carry one per obstacle:
      // its shape, built about its centre, placed in `worldFrame`.
      const obstacleMatrix = () => placementMatrix(
        obs.pos[0], obs.pos[1], baseY + (h / 2), obs.angle || 0, fragmentMatrix,
      );

      // The buried-face test bound to this obstacle, which is never counted as
      // hiding its own faces.
      const buriedFace = (ax, ay, az, bx, by, bz, cx, cy, cz) => isTriangleBuried(
        obs, ax, ay, az, bx, by, bz, cx, cy, cz,
      );

      // The colour the map painted, if it painted one.
      const tint = getObstacleTint(obs);

      if (obs.kind === 'teleporter') {
        mesh = placeObstacle(this._createTeleporterMesh(obs, i + 1), obs);
        mesh.name = obs.name || `Teleporter ${i + 1}`;
        mesh.userData.teleporter = {
          border: Number(obs.border) || 0,
        };
        this.worldFrame.add(this._tagDraws(mesh, 'teleporter'));
        this._addDebugLabel(mesh, 'obstacle');
      } else if (obs.kind === 'base') {
        // A base is tinted by the team that holds it rather than by anything the
        // map said, so its own `color` is a team index and not a colour.
        const baseTeamColor = getPlayerTeamColor(getTeamFromColorIndex(obs.team || 1));
        const baseTeamTint = getBaseTeamTint(baseTeamColor);
        this._addObstacleFragment(
          fragments,
          'base',
          this._getSharedObstacleMaterials(
            'base', createBaseWallTexture, createBaseTopTexture, {
              vertexColors: true,
              // A base drawn flat on the ground -- upstream's CustomBase default,
              // and what a map asks for when it wants a pad a tank drives onto
              // rather than a block it has to jump -- is coplanar with the
              // ground, and two coplanar surfaces are a coin toss per pixel.
              // Upstream's base is its own scene node drawn after the ground;
              // bzo's is a box merged into the world mesh, so it takes a depth
              // bias instead. Costs a base with real height nothing.
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: -1,
            }
          ),
          // BaseSceneNodeGenerator.cxx:74 leaves the bottom out of a base that
          // sits on the ground, where nothing can see it.
          this._prepareStandingBoxGeometry(w, h, d, {
            capRepeat: [1, 1],
            omitFaces: baseY > 0 ? [] : [BOX_FACE.NY],
          }),
          obstacleMatrix(),
          [baseTeamTint, baseTeamTint],
          buriedFace,
        );
        this._addDebugLabelAt(
          obs.name || `Base ${i + 1}`,
          labelAt(),
          'obstacle',
          baseTeamColor,
        );
      } else if (obs.type === 'pyramid') {
        const geometry = new THREE.ConeGeometry(0.5 / Math.SQRT2, h, 4, 1);
        geometry.clearGroups();
        // PyramidSceneNodeGenerator.cxx:109 draws the base only when the pyramid
        // is raised off the ground or stood on its point, which are the two ways
        // anything can see it. It is the last four triangles of the cone.
        const pyramidSideIndexCount = geometry.index.count - 12;
        const showPyramidBase = baseY > 0 || Boolean(obs.inverted);
        if (!showPyramidBase) geometry.setIndex(Array.from(geometry.index.array.slice(0, pyramidSideIndexCount)));
        geometry.addGroup(0, pyramidSideIndexCount, 0);
        if (showPyramidBase) geometry.addGroup(pyramidSideIndexCount, 12, 1);
        geometry.rotateY(-Math.PI / 4);
        if (w > d) {
          geometry.rotateY(Math.PI / 2);
        }
        geometry.scale(2 * w, 1, 2 * d);
        if (obs.inverted) {
          geometry.rotateX(Math.PI);
        }
        standUpGeometry(geometry);

        // The tiling rides on the vertices rather than on a texture of this
        // pyramid's own, so every pyramid in the world shares one pair of
        // materials. Same reasoning as the boxes above.
        const pyramidBaseSpan = Math.max(w, d);
        const pyramidSlantHeight = Math.hypot(h, pyramidBaseSpan / 2);
        this._bakeGroupUvTransform(geometry, 0, {
          repeatX: pyramidBaseSpan / PYRAMID_TEXTURE_SCALE,
          repeatY: pyramidSlantHeight / PYRAMID_TEXTURE_SCALE,
        });
        if (showPyramidBase) {
          this._bakeGroupUvTransform(geometry, 1, {
            repeatX: w / PYRAMID_ROOF_TEXTURE_SCALE,
            repeatY: d / PYRAMID_ROOF_TEXTURE_SCALE,
            // An inverted pyramid's base is seen from above, so its roof turns
            // with it.
            rotation: obs.inverted ? Math.PI : 0,
            centerX: 0.5,
            centerY: 0.5,
          });
        }

        // A map's own `matref`/`addtexture` names one of bzo's stock textures
        // in place of a face's plain default -- see "Materials and
        // appearance" in docs/bzw.md. Unnamed, a pyramid's sides keep bzo's
        // own "pyrwall" default and its base cap keeps bzo's own "roof"
        // default -- a deliberate deviation from upstream's CustomPyramid,
        // which paints its base the same "pyrwall" as its sides. See the
        // note on `PYRAMID_ROOF_TEXTURE_SCALE` above -- do not "fix" this.
        const pyramidWallTexture = obs.wallTexture || null;
        const pyramidCapTexture = obs.capTexture || null;
        const pyramidWallUrl = obs.wallTextureUrl || null;
        const pyramidCapUrl = obs.capTextureUrl || null;
        const pyramidUnlit = { side: !!obs.wallNoLighting, cap: !!obs.capNoLighting };
        const pyramidAnimation = {
          wallDynamicColor: obs.wallDynamicColor || null,
          capDynamicColor: obs.capDynamicColor || null,
          wallTextureMatrix: obs.wallTextureMatrix || null,
          capTextureMatrix: obs.capTextureMatrix || null,
        };
        const pyramidLighting = {
          wallSpecular: obs.wallSpecular || null,
          wallShininess: obs.wallShininess || 0,
          wallEmission: obs.wallEmission || null,
          capSpecular: obs.capSpecular || null,
          capShininess: obs.capShininess || 0,
          capEmission: obs.capEmission || null,
        };
        const pyramidKey = [
          tint ? 'pyramidTinted' : 'pyramid',
          pyramidWallTexture ? `w-${pyramidWallTexture}` : '',
          pyramidCapTexture ? `c-${pyramidCapTexture}` : '',
          pyramidWallUrl ? `wu-${pyramidWallUrl}` : '',
          pyramidCapUrl ? `cu-${pyramidCapUrl}` : '',
          pyramidUnlit.side ? 'wl' : '',
          pyramidUnlit.cap ? 'cl' : '',
          `wd-${animIdentityKey(pyramidAnimation.wallDynamicColor)}`,
          `cd-${animIdentityKey(pyramidAnimation.capDynamicColor)}`,
          `wt-${animIdentityKey(pyramidAnimation.wallTextureMatrix)}`,
          `ct-${animIdentityKey(pyramidAnimation.capTextureMatrix)}`,
          `wm-${materialLightingKey(pyramidLighting.wallSpecular, pyramidLighting.wallShininess, pyramidLighting.wallEmission)}`,
          `cm-${materialLightingKey(pyramidLighting.capSpecular, pyramidLighting.capShininess, pyramidLighting.capEmission)}`,
        ].join('');
        this._addObstacleFragment(
          fragments,
          pyramidKey,
          this._getSharedObstacleMaterials(
            pyramidKey,
            resolveObstacleTextureFactory(pyramidWallTexture, pyramidWallUrl, '/textures/pyrwall.png', createPyramidTexture),
            resolveObstacleTextureFactory(pyramidCapTexture, pyramidCapUrl, '/textures/roof.png', createRoofTexture),
            tint ? { flatShading: true, vertexColors: true } : { flatShading: true },
            pyramidUnlit,
            pyramidAnimation,
            pyramidLighting,
          ),
          geometry,
          obstacleMatrix(),
          tint,
          buriedFace,
        );
        this._addDebugLabelAt(
          obs.name || `Pyramid ${i + 1}`,
          labelAt(),
          'obstacle',
          getObstacleTintHex(obs),
        );
      } else {
        // A box with no height is a pad on the ground rather than a block: a map
        // uses one to mark ground -- `bzo.bzw` puts a named one under most of its
        // flag zones so the debug labels can name them -- and BZW writes it
        // exactly as it writes a flat base, `size w d 0`.
        //
        // Being coplanar with the ground, it needs the same depth bias a flat
        // base gets, or the two surfaces are a coin toss per pixel. Its own
        // material key so an ordinary box does not pay for the bias, and so all
        // the flat ones still share one material between them.
        //
        // A tint the map painted takes a key of its own for the same reason: the
        // colour rides on the vertices, so an untinted box would otherwise carry
        // three numbers per vertex to say white.
        const flatOnGround = h <= 0 && baseY <= 0;
        // A map's own `matref`/`addtexture` names one of bzo's stock textures
        // in place of a face's plain default -- see "Materials and
        // appearance" in docs/bzw.md. Unnamed, a box's walls are upstream's
        // "boxwall" and its caps are "roof" (CustomBox.cxx:52-57).
        const boxWallTexture = obs.wallTexture || null;
        const boxCapTexture = obs.capTexture || null;
        const boxWallUrl = obs.wallTextureUrl || null;
        const boxCapUrl = obs.capTextureUrl || null;
        const boxUnlit = { side: !!obs.wallNoLighting, cap: !!obs.capNoLighting };
        const boxAnimation = {
          wallDynamicColor: obs.wallDynamicColor || null,
          capDynamicColor: obs.capDynamicColor || null,
          wallTextureMatrix: obs.wallTextureMatrix || null,
          capTextureMatrix: obs.capTextureMatrix || null,
        };
        const boxLighting = {
          wallSpecular: obs.wallSpecular || null,
          wallShininess: obs.wallShininess || 0,
          wallEmission: obs.wallEmission || null,
          capSpecular: obs.capSpecular || null,
          capShininess: obs.capShininess || 0,
          capEmission: obs.capEmission || null,
        };
        const boxKey = [
          flatOnGround ? 'boxFlat' : 'box',
          tint ? 'Tinted' : '',
          boxWallTexture ? `w-${boxWallTexture}` : '',
          boxCapTexture ? `c-${boxCapTexture}` : '',
          boxWallUrl ? `wu-${boxWallUrl}` : '',
          boxCapUrl ? `cu-${boxCapUrl}` : '',
          boxUnlit.side ? 'wl' : '',
          boxUnlit.cap ? 'cl' : '',
          `wd-${animIdentityKey(boxAnimation.wallDynamicColor)}`,
          `cd-${animIdentityKey(boxAnimation.capDynamicColor)}`,
          `wt-${animIdentityKey(boxAnimation.wallTextureMatrix)}`,
          `ct-${animIdentityKey(boxAnimation.capTextureMatrix)}`,
          `wm-${materialLightingKey(boxLighting.wallSpecular, boxLighting.wallShininess, boxLighting.wallEmission)}`,
          `cm-${materialLightingKey(boxLighting.capSpecular, boxLighting.capShininess, boxLighting.capEmission)}`,
        ].join('');
        this._addObstacleFragment(
          fragments,
          boxKey,
          this._getSharedObstacleMaterials(
            boxKey,
            resolveObstacleTextureFactory(boxWallTexture, boxWallUrl, '/textures/boxwall.png', createBoxWallTexture),
            resolveObstacleTextureFactory(boxCapTexture, boxCapUrl, '/textures/roof.png', createRoofTexture),
            {
              ...(flatOnGround
                ? { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }
                : {}),
              ...(tint ? { vertexColors: true } : {}),
            },
            boxUnlit,
            boxAnimation,
            boxLighting,
          ),
          // BoxSceneNodeGenerator.cxx:66, in its own words: "Don't generate the
          // bottom polygon if on the ground (or lower)".
          this._prepareStandingBoxGeometry(w, h, d, {
            ...this._boxTextureScales(),
            omitFaces: baseY > 0 ? [] : [BOX_FACE.NY],
          }),
          obstacleMatrix(),
          tint,
          buriedFace,
          true,
        );
        this._addDebugLabelAt(
          obs.name || `Box ${i + 1}`,
          labelAt(),
          'obstacle',
          getObstacleTintHex(obs),
        );
      }

      if (mesh) {
        this.obstacleMeshes.push(mesh);
      }
    });

    this._buildObstacleFragments(fragments);

    // Update compass marker heights now that we know maxObstacleHeight
    this._updateCompassMarkerHeights();
    this._refreshProjectedShadowOverlay();
  }

  clearMeshes() {
    if (!this.scene) return;
    this.meshObjects.forEach((object3D) => {
      this._clearObjectForRemoval(object3D);
    });
    this.meshObjects = [];
    // A mesh face's `dyncol`/`texmat` registration (see `_buildMeshObject`)
    // is tagged `source: 'mesh'`, dropped here the same way `clearObstacles`
    // drops only its own `'obstacle'`-tagged entries.
    this._animatedMaterials = this._animatedMaterials.filter((entry) => entry.source !== 'mesh');
    // Every spinning mesh's pivot group comes down with `meshObjects` above
    // (each is that same list's own entry, or its parent) -- this only drops
    // the bookkeeping `_updateMeshSpins` would otherwise still walk.
    this._meshSpins = [];
    // The labels themselves come down with their own mesh object already
    // (each is a child of it, per `_addDebugLabel`) -- this only clears the
    // bookkeeping entry `_updateDebugLabelsVisibility` would otherwise still
    // walk, same as `clearObstacles`'s own `_clearDebugLabels('obstacle')`.
    this._clearDebugLabels('mesh');
  }

  // A parsed `mesh` block, rendered directly rather than through
  // `_addObstacleFragment`'s shared-material/buried-face system: unlike a box
  // or a pyramid, a mesh's face count and texture set is different for every
  // one of them, so there is nothing to usefully share, and a mesh has no
  // wall/cap split to fold a colour into -- see `docs/bzw-plan.md`'s "Mesh
  // geometry" for what is still missing (collision, radar, a `define`'s own
  // meshes placed per `group` instance).
  // A definition placed by `group` instances, carried as the template plus a
  // transform apiece rather than a copy apiece (#153). Only definitions
  // nothing collides with arrive this way, so the geometry here is never
  // anything the server also holds in `OBSTACLES`.
  //
  // Each template is built once and every placement is a `THREE.Mesh` over
  // that same `BufferGeometry` and material, so the vertices are uploaded to
  // the GPU once however many instances there are. Each placement is still
  // its own draw call; batching them is a later step.
  //
  // The transform mirrors the server's own `transformGroupPoint`: scale in
  // the map's axis order, spin about the vertical, then shift. three.js
  // applies scale, then rotation, then position, which is that same order --
  // and `rotation.y` turns x toward -z exactly as the server's matrix does,
  // so the angle needs no negation here.
  setMeshInstances(templates = null, instances = null) {
    if (!this.scene || !templates || !instances || !instances.length) return;
    const built = new Map();
    for (const [name, templateMeshes] of Object.entries(templates)) {
      const objects = [];
      (templateMeshes || []).forEach((meshObs, i) => {
        const object = this._buildMeshObject(meshObs, i);
        if (object) objects.push(object);
      });
      built.set(name, objects);
    }
    // Grouped by definition, because one `InstancedMesh` draws every
    // placement of one template in a single call. A field of 1,905 flowers
    // is five draw calls rather than 1,905, which is the whole point on a
    // client that runs out of CPU before it runs out of GPU.
    const byDefine = new Map();
    for (const instance of instances) {
      if (!built.has(instance.define)) continue;
      const list = byDefine.get(instance.define) || [];
      list.push(instance);
      byDefine.set(instance.define, list);
    }

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scaleVector = new THREE.Vector3();
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (const [name, placements] of byDefine) {
      for (const prototype of built.get(name)) {
        const batch = new THREE.InstancedMesh(
          prototype.geometry, prototype.material, placements.length,
        );
        placements.forEach((instance, i) => {
          const scale = Array.isArray(instance.scale) ? instance.scale : [1, 1, 1];
          position.set(instance.x || 0, instance.y || 0, instance.z || 0);
          quaternion.setFromAxisAngle(zAxis, instance.spin || 0);
          // Scale, then spin about the vertical, then shift: the order
          // `transformGroupPoint` places a group's meshes in.
          scaleVector.set(scale[0] || 1, scale[1] || 1, scale[2] || 1);
          batch.setMatrixAt(i, matrix.compose(position, quaternion, scaleVector));
        });
        batch.instanceMatrix.needsUpdate = true;
        // Its own bounding sphere over every placement, not the template's --
        // without it the batch would be culled against geometry sitting at
        // the definition's own local origin and vanish as soon as that point
        // left the view.
        if (batch.computeBoundingSphere) batch.computeBoundingSphere();
        batch.castShadow = prototype.castShadow;
        batch.receiveShadow = prototype.receiveShadow;
        this.worldFrame.add(this._tagDraws(batch, 'mesh'));
        this.meshObjects.push(batch);
      }
    }
  }

  setMeshes(meshes = []) {
    if (!this.scene) return;
    this.clearMeshes();
    meshes.forEach((meshObs, i) => {
      const meshMesh = this._buildMeshObject(meshObs, i);
      if (!meshMesh) return;
      // `_addDebugLabel` reads the object's own geometry bounding box for
      // where to float the label -- already computed in `_buildMeshObject`,
      // and already in world space, since a mesh's vertices are baked in
      // directly rather than carried as a position a matrix would move.
      // Read before any spin-wrapping below, which repositions the mesh
      // itself but never touches its geometry.
      this._addDebugLabel(meshMesh, 'mesh');
      const object3D = (meshObs.angvel && meshObs.spinPivot)
        ? this._wrapMeshSpin(meshMesh, meshObs.spinPivot, meshObs.angvel, meshObs.spinAxis)
        : meshMesh;
      this.worldFrame.add(this._tagDraws(object3D, 'mesh'));
      this.meshObjects.push(object3D);
    });
  }

  // Wraps a spinning mesh's own static `THREE.Mesh` (`_buildMeshObject`,
  // whose vertices are baked in absolute world coordinates, matrixAutoUpdate
  // off) in a `THREE.Group` centred on its own pivot (`meshObs.spinPivot`,
  // #88 -- see `applyGroupInstanceTransformToMesh`/`finalizeMeshGeometry`,
  // server.js). The inner mesh is shifted back by that same pivot once, so
  // at rotation 0 it still sits exactly where its baked geometry already
  // puts it; only the group's own rotation, driven every frame by
  // `_updateMeshSpins`, turns it from there -- `MeshDrawMgr::executeSet`'s
  // own `glRotatef` wrapped around an otherwise-unmoved draw. The turn is
  // about `spinAxis` when a tipped group placed the mesh (#168), about the
  // vertical otherwise.
  _wrapMeshSpin(meshMesh, spinPivot, angvel, spinAxis) {
    const group = new THREE.Group();
    group.name = meshMesh.name;
    group.position.set(spinPivot.x, spinPivot.y, spinPivot.z);
    meshMesh.position.set(-spinPivot.x, -spinPivot.y, -spinPivot.z);
    meshMesh.updateMatrix();
    group.add(meshMesh);
    const axis = spinAxis && Math.abs(spinAxis.z) < 0.999999
      ? new THREE.Vector3(spinAxis.x, spinAxis.y, spinAxis.z)
      : null;
    // An axis pointing down turns the other way, as upstream's would.
    const signedAngvel = spinAxis && !axis && spinAxis.z < 0 ? -angvel : angvel;
    this._meshSpins.push({ group, angvel: signedAngvel, axis });
    return group;
  }

  // One `THREE.Mesh` per parsed `mesh` block, its faces fan-triangulated
  // (`CustomMeshFace::write`'s own "triangulate if required", for the
  // convex/planar n-gons a mapper actually states) into one buffer, grouped
  // by each face's own resolved texture/tint so faces that share neither
  // still share a draw call with their neighbours. Vertices already sit in
  // bzo's world frame (`parseBZWMap`'s `vertex`/`normal` conversion), so
  // nothing here repositions the mesh -- it is static geometry the way a
  // box/pyramid fragment already is.
  _buildMeshObject(meshObs, index) {
    // A `drawInfo` block is upstream's render-optimized copy of the same
    // surface, and where a mesh states one it is what upstream *draws* --
    // `MeshSceneNode` is built from it and the mesh's own `face` list is left
    // to collision alone (`MeshSceneNodeGenerator::getMeshNodes` is the other
    // path, for a mesh without one). bzo splits the same way: the draw arrays
    // reach the screen, the collision arrays reach `collision.mjs`. A map may
    // state only a `drawInfo` -- every tank model in `RatsNest.bzw` does --
    // and then there is nothing else to draw it with.
    //
    // Read out of the mesh's flat arrays rather than a face object apiece
    // (issue #153). Geometry, the corner normals and texcoords a face states,
    // and which material it draws with all come from there; the material's own
    // fields are the deduped descriptor the arrays carry, which is the same
    // handful of objects this used to rebuild a key from per face.
    // `meshDrawArrays` picks the `drawInfo` copy where there is one.
    const arrays = meshDrawArrays(meshObs);
    if (arrays.vertices.length === 0 || arrays.faceCount === 0) return null;

    const positions = [];
    const normalsOut = [];
    const uvsOut = [];
    const materials = [];
    const materialIndexByKey = new Map();
    // A face's triangles land in its material's own bucket rather than in one
    // index list in map order, because a `BufferGeometry` group is a draw call
    // and a group per face is a draw call per face. Upstream collates the same
    // way -- `MeshSceneNodeGenerator.cxx:206` builds one `MeshFragSceneNode`
    // per "collection of faces with the same material properties" -- and it is
    // the same trade `_addObstacleFragment` makes for boxes and pyramids. On
    // `import-xs.bzexcess.com_5155.bzw` it is the difference between a few
    // dozen draws and tens of thousands.
    //
    // Sparse and indexed by material, so the buckets come out in the order the
    // materials were first met, and a face's triangles keep their order inside
    // one. Faces of *different* materials are no longer interleaved in map
    // order: a mesh's translucent faces are drawn unsorted either way -- bzo
    // merges them where upstream keeps them out of the fragment to sort them --
    // so this reorders something that was already arbitrary against the view.
    const indicesByMaterial = [];
    const edgeA = new THREE.Vector3();
    const edgeB = new THREE.Vector3();

    const point = (vi) => ({
      x: arrays.vertices[vi * 3],
      y: arrays.vertices[(vi * 3) + 1],
      z: arrays.vertices[(vi * 3) + 2],
    });

    for (let f = 0; f < arrays.faceCount; f += 1) {
      const start = arrays.faceStart[f];
      const end = arrays.faceStart[f + 1];
      const cornerCount = end - start;
      if (cornerCount < 3) continue;
      const face = arrays.materials[arrays.faceMaterial[f]];
      const baseVertex = positions.length / 3;

      // A face with no `normals` line of its own is flat-shaded off its
      // first three corners, the same plane every fan triangle below cuts
      // from -- `MeshObstacle`'s own per-face normal, for a face that never
      // asked for smoother ones.
      const hasOwnNormals = arrays.cornerNormal[start] !== NO_INDEX;
      let flatNormalX = 0; let flatNormalY = 1; let flatNormalZ = 0;
      if (!hasOwnNormals) {
        const p0 = point(arrays.corners[start]);
        const p1 = point(arrays.corners[start + 1]);
        const p2 = point(arrays.corners[start + 2]);
        edgeA.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
        edgeB.set(p2.x - p0.x, p2.y - p0.y, p2.z - p0.z);
        edgeA.cross(edgeB).normalize();
        if (edgeA.lengthSq() > 0) {
          flatNormalX = edgeA.x; flatNormalY = edgeA.y; flatNormalZ = edgeA.z;
        }
      }
      const hasOwnUvs = arrays.cornerTexcoord[start] !== NO_INDEX;
      const facePlaneX = arrays.facePlanes[f * 4];
      const facePlaneY = arrays.facePlanes[(f * 4) + 1];
      const facePlaneZ = arrays.facePlanes[(f * 4) + 2];
      const hasPlane = facePlaneX !== 0 || facePlaneY !== 0 || facePlaneZ !== 0;

      // A face with no `texcoords` line of its own is planar-projected
      // instead of left at a single degenerate UV -- upstream's own
      // `MeshSceneNodeGenerator::makeTexcoords`: vertex 0 pins (0,0), the
      // first edge becomes the U axis, the face's own plane normal crossed
      // with that becomes V, and every other vertex is that basis's own dot
      // product with its offset from vertex 0, both divided by upstream's
      // same 8-unit tile size (`BOX_TEXTURE_SCALES.sideScale`). Needs the
      // face's own plane, which only exists once `finalizeMeshGeometry` has
      // run server-side -- a face on a `define`'s own still-local template
      // (never placed by any `group`) has none, and stays at (0,0) the way
      // it always has.
      let planarUVs = null;
      if (!hasOwnUvs && hasPlane) {
        const p0 = point(arrays.corners[start]);
        const p1 = point(arrays.corners[start + 1]);
        {
          const nx = facePlaneX; const ny = facePlaneY; const nz = facePlaneZ;
          const xLen = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
          if (xLen > 0) {
            const ux = (p1.x - p0.x) / xLen;
            const uy = (p1.y - p0.y) / xLen;
            const uz = (p1.z - p0.z) / xLen;
            const vx = (ny * uz) - (nz * uy);
            const vy = (nz * ux) - (nx * uz);
            const vz = (nx * uy) - (ny * ux);
            const vLen = Math.hypot(vx, vy, vz);
            if (vLen > 0) {
              const nvx = vx / vLen; const nvy = vy / vLen; const nvz = vz / vLen;
              planarUVs = [];
              for (let c = start; c < end; c += 1) {
                const v = point(arrays.corners[c]);
                const dx = v.x - p0.x; const dy = v.y - p0.y; const dz = v.z - p0.z;
                planarUVs.push([
                  ((dx * ux) + (dy * uy) + (dz * uz)) / MESH_AUTO_UV_TILE_SIZE,
                  ((dx * nvx) + (dy * nvy) + (dz * nvz)) / MESH_AUTO_UV_TILE_SIZE,
                ]);
              }
            }
          }
        }
      }

      for (let c = start; c < end; c += 1) {
        const localIndex = c - start;
        const v = arrays.corners[c] * 3;
        positions.push(arrays.vertices[v], arrays.vertices[v + 1], arrays.vertices[v + 2]);
        if (hasOwnNormals) {
          const n = arrays.cornerNormal[c] * 3;
          normalsOut.push(arrays.normals[n], arrays.normals[n + 1], arrays.normals[n + 2]);
        } else {
          normalsOut.push(flatNormalX, flatNormalY, flatNormalZ);
        }
        if (hasOwnUvs) {
          const t = arrays.cornerTexcoord[c] * 2;
          uvsOut.push(arrays.texcoords[t], arrays.texcoords[t + 1]);
        } else if (planarUVs) {
          uvsOut.push(planarUVs[localIndex][0], planarUVs[localIndex][1]);
        } else {
          uvsOut.push(0, 0);
        }
      }

      const faceIndices = [];
      for (let t = 1; t < cornerCount - 1; t++) {
        faceIndices.push(baseVertex, baseVertex + t, baseVertex + t + 1);
      }
      if (!faceIndices.length) continue;

      const key = `${face.texture || ''}|${face.textureUrl || ''}|${(face.color || []).join(',')}`
        + `|${animIdentityKey(face.dynamicColor)}|${animIdentityKey(face.textureMatrix)}`
        + `|${materialLightingKey(face.specular, face.shininess, face.emission)}`
        + `|${face.noSorting ? 's' : ''}${face.useTextureAlpha === false ? 'a' : ''}`
        + `${face.useColorOnTexture === false ? 'd' : ''}${face.noCulling ? 'c' : ''}`;
      let materialIndex = materialIndexByKey.get(key);
      if (materialIndex === undefined) {
        // A generic `mesh` face with no `texture`/`addtexture` at all (unlike
        // box/pyramid, which upstream always textures with a stock default)
        // is meant to be flat-colored -- falling back to the boxwall texture
        // here would draw a wall pattern the map never asked for.
        const LitClass = pickLitMaterialClass(face.specular);
        const lightingOptions = buildLightingMaterialOptions(face.specular, face.shininess, face.emission);
        // `noculling`, which only a face built from a `drawInfo` block ever
        // carries: that is the one path where upstream's own scene node has
        // no plane cull in front of it, so the flag can actually show a far
        // side (`MeshSceneNode::cull`, `:287-300`). See `applyBzwMaterialToken`
        // in server.js for why a plain face never gets here.
        if (face.noCulling) lightingOptions.side = THREE.DoubleSide;
        // `notexalpha` (`BzMaterial::getUseTextureAlpha`) -- upstream reads
        // the texture's own alpha channel only where this is left set
        // (`MeshSceneNode.cxx:429-433`), so a picture that happens to carry
        // alpha draws fully opaque. bzo's own default alpha test is the
        // deliberate difference documented in docs/bzw.md; a map turning the
        // channel off is asking for neither -- but see the alpha test just
        // below, which upstream applies regardless.
        const readsTextureAlpha = face.useTextureAlpha !== false;
        let material;
        if (face.texture || face.textureUrl) {
          const textureFactory = resolveObstacleTextureFactory(
            face.texture, face.textureUrl, '/textures/boxwall.png', createBoxWallTexture,
          );
          // `material` declared before the factory runs, same reason
          // `_getSharedObstacleMaterials` does: `registerAlphaCallback`
          // (`public/js/texture.js`) always defers to a microtask, so the
          // callback never actually fires until this statement (and `let`)
          // has finished, even when the answer was already known.
          material = new LitClass({
            map: textureFactory((hasAlpha, minAlpha) => applyTextureAlpha(
              material, hasAlpha && readsTextureAlpha, face.texture || face.textureUrl, minAlpha,
            )),
            ...lightingOptions,
          });
        } else {
          material = new LitClass(lightingOptions);
        }
        // What the map's own material asked for, kept on the material so the
        // alpha callback can tell a stated threshold from bzo's default -- the
        // callback fires once the image decodes, long after this returns.
        if (Number.isFinite(face.alphaThreshold)) {
          material.userData.alphaThreshold = face.alphaThreshold;
        }
        // `nosorting` -- same reason as the threshold above: the alpha
        // callback runs long after this returns and needs the answer then.
        if (face.noSorting) material.userData.noSorting = true;
        // `alphathresh` is an alpha *test*, and upstream sets it from the
        // material unconditionally -- `WallSceneNode::setupBlending`
        // (`:369-370`) and `MeshSceneNode.cxx:523-525` both apply
        // `GL_GEQUAL` whatever `notexalpha` said, because that flag decides
        // only whether the texture's alpha reaches the *blend*
        // (`node->setBlending(alpha)`, `MeshSceneNodeGenerator.cxx:471-477`).
        // So a `notexalpha` face with a stated threshold still cuts its
        // transparent pixels away; it just stops blending the partial ones.
        // The blending path below sets the same test from the callback, once
        // the image says it has alpha at all.
        if (!readsTextureAlpha && Number.isFinite(face.alphaThreshold) && face.alphaThreshold !== 0) {
          material.alphaTest = face.alphaThreshold;
        }
        // `notexcolor` (`BzMaterial::getUseColorOnTexture`) -- with a texture
        // on the material, upstream stops modulating it by the material's own
        // diffuse and uses plain white instead (`MeshSceneNode.cxx:428`,
        // `:470-481`), alpha included, so neither the tint nor its
        // translucency reaches the face. Untextured, the flag means nothing
        // upstream and nothing here: there is no picture for a colour to be
        // used *on*.
        const usesOwnColor = face.useColorOnTexture !== false
          || !(face.texture || face.textureUrl);
        if (face.color && usesOwnColor) {
          material.color.setRGB(face.color[0] ?? 1, face.color[1] ?? 1, face.color[2] ?? 1);
          // A material's own flat `diffuse`/`color` alpha (`parseBzwColor`,
          // server.js) -- distinct from a texture's own per-pixel alpha
          // (`applyTextureAlpha` above). A map that writes `diffuse 0 0 0 0`
          // wants this face invisible (a common "solid for collision/radar,
          // drawn as nothing" trick), not opaque black, which is what
          // dropping this value used to produce.
          const alpha = face.color[3] ?? 1;
          if (alpha < 1) {
            material.transparent = true;
            material.opacity = alpha;
            setTransparentDepthWrite(material);
          }
        }
        // `dyncol` -- replaces this face's diffuse outright (see
        // `evaluateDynamicColor`), so a static `color`/tint above is only
        // ever this material's look before the first animation frame runs.
        // Its alpha channel can vary too, so it gets the same
        // depthWrite-off treatment as any other material that might not be
        // fully opaque (`applyTextureAlpha` above) -- matching bzo's own
        // "no self-occlusion through the depth buffer" rule rather than
        // upstream's own `possibleAlpha` micro-optimization, which only ever
        // skips a sort pass bzo does not have.
        if (face.dynamicColor) {
          material.userData.dynamicColor = true;
          material.transparent = true;
          setTransparentDepthWrite(material);
          this._animatedMaterials.push({ material, dynamicColor: face.dynamicColor, source: 'mesh' });
        }
        // `texmat` -- a live UV transform on this face's own texture. The
        // texture object exists synchronously even though its image loads
        // later (`resolveObstacleTextureFactory`'s own factories always
        // return one right away), so it is safe to grab off `material.map`
        // here rather than waiting on the alpha callback above.
        if (face.textureMatrix && material.map) {
          material.map.matrixAutoUpdate = false;
          this._animatedMaterials.push({ texture: material.map, textureMatrix: face.textureMatrix, source: 'mesh' });
        }
        materialIndex = materials.length;
        materials.push(material);
        materialIndexByKey.set(key, materialIndex);
      }
      let bucket = indicesByMaterial[materialIndex];
      if (!bucket) {
        bucket = [];
        indicesByMaterial[materialIndex] = bucket;
      }
      for (let i = 0; i < faceIndices.length; i += 1) bucket.push(faceIndices[i]);
    }

    // One run per material, laid end to end. `forEach` skips the holes a
    // material whose every face was degenerate leaves behind.
    const indices = [];
    const geometryGroups = [];
    indicesByMaterial.forEach((bucket, materialIndex) => {
      if (!bucket.length) return;
      geometryGroups.push({ start: indices.length, count: bucket.length, materialIndex });
      // Appended one at a time: a spread is an argument list, and a bucket on a
      // map like `import-xs.bzexcess.com_5155.bzw` runs to hundreds of
      // thousands of indices, well past what a call can carry.
      for (let i = 0; i < bucket.length; i += 1) indices.push(bucket[i]);
    });

    if (!indices.length) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalsOut, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvsOut, 2));
    geometry.setIndex(indices);
    geometryGroups.forEach(({ start, count, materialIndex }) => geometry.addGroup(start, count, materialIndex));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = meshObs.name || `Mesh ${index + 1}`;
    // Static world geometry, same as a box/pyramid fragment -- see
    // `_buildObstacleFragments`.
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  // A random point-and-triangle cloud inside an arbitrary closed mesh (#77 --
  // giving every obstacle the same two-part look means a mesh needs one too,
  // not just box/pyramid). A mesh has no simple footprint to sample like a
  // box's XZ rectangle, so a candidate point in the mesh's own bounding box is
  // kept only when a ray cast from it crosses the mesh's own triangles an odd
  // number of times (even-odd rule -- `THREE.Ray.intersectTriangle` per
  // triangle, `geometry`'s own index/position buffers, no separate collision
  // machinery). An open, non-enclosing mesh (a decorative shell with no
  // inside) fails every cast and simply gets no cloud, which is correct: there
  // is no "inside" to scatter one across.
  _buildMeshEighthDimCloud(geometry) {
    const box = geometry.boundingBox;
    const size = new THREE.Vector3();
    if (!box) return null;
    box.getSize(size);
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) return null;

    const positionAttr = geometry.getAttribute('position');
    const indexAttr = geometry.getIndex();
    if (!positionAttr || !indexAttr) return null;
    const positions = positionAttr.array;
    const indices = indexAttr.array;

    const ray = new THREE.Ray(new THREE.Vector3(), MESH_CLOUD_RAY_DIRECTION);
    const triA = new THREE.Vector3();
    const triB = new THREE.Vector3();
    const triC = new THREE.Vector3();
    const hit = new THREE.Vector3();
    const isInside = (point) => {
      ray.origin.copy(point);
      let crossings = 0;
      for (let i = 0; i < indices.length; i += 3) {
        triA.fromArray(positions, indices[i] * 3);
        triB.fromArray(positions, indices[i + 1] * 3);
        triC.fromArray(positions, indices[i + 2] * 3);
        if (ray.intersectTriangle(triA, triB, triC, false, hit)) crossings += 1;
      }
      return (crossings % 2) === 1;
    };

    const volume = size.x * size.y * size.z;
    const polySize = Math.cbrt(volume / BZFLAG_EIGHTH_DIM_MESH_POLYGONS);
    const positionsOut = [];
    const colors = [];
    const point = new THREE.Vector3();
    const jittered = new THREE.Vector3();
    let placed = 0;
    let attempts = 0;
    const maxAttempts = BZFLAG_EIGHTH_DIM_MESH_POLYGONS * MESH_CLOUD_MAX_ATTEMPTS_FACTOR;
    while (placed < BZFLAG_EIGHTH_DIM_MESH_POLYGONS && attempts < maxAttempts) {
      attempts += 1;
      point.set(
        box.min.x + Math.random() * size.x,
        box.min.y + Math.random() * size.y,
        box.min.z + Math.random() * size.z,
      );
      if (!isInside(point)) continue;
      placed += 1;
      const red = BZFLAG_EIGHTH_DIM_COLOR_MIN + BZFLAG_EIGHTH_DIM_COLOR_RANGE * Math.random();
      const green = BZFLAG_EIGHTH_DIM_COLOR_MIN + BZFLAG_EIGHTH_DIM_COLOR_RANGE * Math.random();
      const blue = BZFLAG_EIGHTH_DIM_COLOR_MIN + BZFLAG_EIGHTH_DIM_COLOR_RANGE * Math.random();
      const alpha = BZFLAG_EIGHTH_DIM_ALPHA_MIN + BZFLAG_EIGHTH_DIM_ALPHA_RANGE * Math.random();
      // Clamping a jittered vertex to the bounding *box* the way the box/
      // pyramid cloud clamps to its own half-extents (`_getInsideBuildingNode`
      // above) is only exact there because a box's or a pyramid's "inside"
      // test is that same box -- an arbitrary mesh's is not (the octagon's own
      // bevels cut through its bounding box's corners), so a jittered vertex
      // needs its own `isInside` check rather than a clamp, or exactly this
      // triangle would poke out through a bevel it was never meant to cross.
      // Falling back to `point` itself rather than discarding the vertex or
      // the whole triangle keeps every triangle non-degenerate and every
      // vertex provably inside, since `point` already passed the same test.
      for (let vertex = 0; vertex < 3; vertex += 1) {
        jittered.set(
          point.x + polySize * (Math.random() - 0.5),
          point.y + polySize * (Math.random() - 0.5),
          point.z + polySize * (Math.random() - 0.5),
        );
        if (!isInside(jittered)) jittered.copy(point);
        positionsOut.push(jittered.x, jittered.y, jittered.z);
        colors.push(red, green, blue, alpha);
      }
    }
    if (!positionsOut.length) return null;

    const cloudGeometry = new THREE.BufferGeometry();
    cloudGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positionsOut, 3));
    cloudGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    const cloud = new THREE.Mesh(cloudGeometry, new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    cloud.renderOrder = EIGHTH_DIM_RENDER_ORDER;
    cloud.frustumCulled = false;
    return cloud;
  }

  // A mesh's own eighth-dimension node -- upstream's `EighthDimShellNode`
  // (EighthDimShellNode.cxx): it redraws the mesh's own real render node a
  // second time, twice over. `ShellRenderNode::render()` (EighthDimShellNode.
  // cxx:137-165) first draws it solid -- filled, normal winding inverted
  // (`setCulling(GL_FRONT)`, the constructor, line 114) so the normally
  // hidden *inside* of each face draws, textured and lit exactly as the real
  // outside face is, additively blended whenever `blend` is on and render
  // quality is 2 or better -- and only then overlays a 3px wireframe on top of
  // that, unconditionally. The solid pass is what reads as "floating
  // triangles": the building's own real walls glowing from the inside, not a
  // color-blind cloud.
  //
  // bzo has no inverted-cull material pass sitting around to reuse, but
  // `_buildMeshObject` already resolves this obstacle's real per-face
  // geometry, UVs and textures, so that is asked for again here and its
  // materials cloned into unlit, `BackSide`, additively-blended ones sharing
  // the same maps -- upstream's own real-texture look, not the random colour
  // bzo shipped before #77. (The second `_buildMeshObject` call re-registers
  // any `dyncol`/`texmat` animation on its own throwaway materials -- wasted
  // cycles on a mesh that uses either, never a visible difference, and rare
  // enough next to actually phasing through that particular mesh not to be
  // worth a second geometry-building code path just to skip it.) The dot
  // cloud is new for #77 too -- see `_buildMeshEighthDimCloud` -- and the
  // wireframe outline stays the plain white a box or a pyramid's own outline
  // already uses rather than upstream's per-face colour, same as before.
  _buildMeshInsideBuildingNode(obs) {
    const edges = [];
    // The collision faces rather than the drawn ones: this outlines the shape
    // the tank is actually inside of. Out of the flat arrays (issue #153).
    const arrays = meshArrays(obs);
    for (let f = 0; f < arrays.faceCount; f += 1) {
      const start = arrays.faceStart[f];
      const end = arrays.faceStart[f + 1];
      const n = end - start;
      for (let i = 0; i < n; i += 1) {
        const a = arrays.corners[start + i] * 3;
        const b = arrays.corners[start + ((i + 1) % n)] * 3;
        edges.push(
          arrays.vertices[a], arrays.vertices[a + 1], arrays.vertices[a + 2],
          arrays.vertices[b], arrays.vertices[b + 1], arrays.vertices[b + 2],
        );
      }
    }

    // A mesh's own vertices are already in world space (unlike a box or a
    // pyramid, which are drawn relative to their own centre and rotation),
    // so the node itself sits at the origin with nothing to transform.
    const node = new THREE.Group();
    node.matrixAutoUpdate = false;
    node.updateMatrix();

    const base = this._buildMeshObject(obs, 0);
    if (base) {
      const realMaterials = Array.isArray(base.material) ? base.material : [base.material];
      const shellMaterials = realMaterials.map((material) => new THREE.MeshBasicMaterial({
        map: material.map || null,
        color: material.color ? material.color.clone() : undefined,
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      // The cloud below still ray-casts against `base.geometry` unfiltered --
      // it needs the mesh's real, watertight shape to tell inside from
      // outside, where the fill only ever wants to skip drawing a face's own
      // glow (see `_filterGroundLevelMeshGeometry`).
      const fill = new THREE.Mesh(this._filterGroundLevelMeshGeometry(base.geometry), shellMaterials);
      fill.renderOrder = EIGHTH_DIM_RENDER_ORDER;
      fill.frustumCulled = false;
      node.add(fill);

      const cloud = this._buildMeshEighthDimCloud(base.geometry);
      if (cloud) node.add(cloud);
    }

    const outlineGeometry = new THREE.BufferGeometry();
    outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
    const outline = new THREE.LineSegments(
      outlineGeometry,
      new THREE.LineBasicMaterial({ color: 0xffffff })
    );
    outline.renderOrder = EIGHTH_DIM_RENDER_ORDER;
    outline.frustumCulled = false;
    node.add(outline);

    this._tagDraws(node, 'effect');
    return node;
  }

  // Rebuilds `geometry` keeping only the triangles `shouldDrop(a, b, c)`
  // (each corner a `THREE.Vector3`, reused across calls -- read them, don't
  // keep them) says to keep, group by group so each surviving triangle stays
  // under its own material index. Shared by the two shell face filters below,
  // which differ only in what a dropped triangle actually is -- one buried
  // against a neighbouring obstacle, one a floor facing into the world's own
  // ground. Always returns a plain, non-indexed geometry: cheap to build for
  // the handful of triangles either caller ever runs on, and one less thing
  // for a caller to get wrong re-deriving an index buffer for.
  _filterShellTriangles(geometry, shouldDrop) {
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const uv = geometry.attributes.uv;
    const index = geometry.getIndex();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const outPositions = [];
    const outNormals = [];
    const outUvs = [];
    const outGroups = [];
    for (const group of geometry.groups) {
      const groupStart = outPositions.length / 3;
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const ia = index.getX(i);
        const ib = index.getX(i + 1);
        const ic = index.getX(i + 2);
        a.fromBufferAttribute(position, ia);
        b.fromBufferAttribute(position, ib);
        c.fromBufferAttribute(position, ic);
        if (shouldDrop(a, b, c)) continue;
        for (const vi of [ia, ib, ic]) {
          outPositions.push(position.getX(vi), position.getY(vi), position.getZ(vi));
          outNormals.push(normal.getX(vi), normal.getY(vi), normal.getZ(vi));
          outUvs.push(uv.getX(vi), uv.getY(vi));
        }
      }
      outGroups.push({ start: groupStart, count: (outPositions.length / 3) - groupStart, materialIndex: group.materialIndex });
    }
    const filtered = new THREE.BufferGeometry();
    filtered.setAttribute('position', new THREE.Float32BufferAttribute(outPositions, 3));
    filtered.setAttribute('normal', new THREE.Float32BufferAttribute(outNormals, 3));
    filtered.setAttribute('uv', new THREE.Float32BufferAttribute(outUvs, 2));
    outGroups.forEach((g) => filtered.addGroup(g.start, g.count, g.materialIndex));
    return filtered;
  }

  // Drops whatever triangles of `geometry` (local to `obs`, vertical centre
  // at `baseY + height / 2` -- see the two callers) `_buildObstacleFragments`
  // would also have dropped as buried against another obstacle, so a shell's
  // additive glow never shows a seam the outside view was never allowed to.
  // `createBuriedTriangleTest`'s answer is per triangle in world space, so
  // each one is transformed by this obstacle's own matrix -- the same
  // position/rotation `obstacleMatrix()` bakes into the real fragment -- to
  // ask it, even though the geometry returned here stays local (it is still
  // headed for a child of `_getInsideBuildingNode`'s own positioned/rotated
  // group). No burial test yet (`this._insideBuildingBuriedTest` unset) keeps
  // the geometry as it was handed in, same as an obstacle list with nothing
  // to bury anything in.
  _filterBuriedShellGeometry(geometry, obs, height) {
    const isBuried = this._insideBuildingBuriedTest;
    if (!isBuried) return geometry;
    const matrix = placementMatrix(
      obs.pos[0], obs.pos[1], getObstacleBase(obs) + (height / 2), obs.angle || 0,
    );
    const wa = new THREE.Vector3();
    const wb = new THREE.Vector3();
    const wc = new THREE.Vector3();
    return this._filterShellTriangles(geometry, (a, b, c) => {
      wa.copy(a).applyMatrix4(matrix);
      wb.copy(b).applyMatrix4(matrix);
      wc.copy(c).applyMatrix4(matrix);
      return isBuried(obs, wa.x, wa.y, wa.z, wb.x, wb.y, wb.z, wc.x, wc.y, wc.z);
    });
  }

  // A mesh face lying flat on the world's own ground -- upstream's
  // `MeshSceneNodeGenerator` builds a mesh exactly as authored, unlike
  // `BoxSceneNodeGenerator`, which explicitly skips "the bottom polygon if on
  // the ground (or lower)" (`_prepareBoxGeometry`'s own `omitFaces`, above).
  // A mesh author has no equivalent switch, and no reason to reach for one:
  // nothing before the shell ever rendered a ground-level face's buried side
  // anyway, so the map's own "Hexagon" (`bzo.bzw`) left its floor cap in its
  // default wall texture same as its walls. A phasing tank is always on the
  // ground -- `OO` grants no flight -- so this is exactly the face its own
  // feet are standing on, coplanar with the real ground mesh, and additively
  // blending a second texture onto it is a z-fight (whichever the driver
  // happens to put down last), not a glow. Coplanar is the whole test, not
  // which way the face happens to wind: cull it outright rather than draw it
  // additively, the same as the box's own bottom never draws at all.
  _filterGroundLevelMeshGeometry(geometry) {
    const groundEpsilon = 0.05;
    return this._filterShellTriangles(
      geometry,
      (a, b, c) => a.z <= groundEpsilon && b.z <= groundEpsilon && c.z <= groundEpsilon,
    );
  }

  // A box's own textured shell (#77 -- the real-texture inside-out look
  // upstream reserves for meshes, given to every obstacle). Its own small
  // `BoxGeometry`+material pair rather than a slice of the merged fragment
  // `_buildObstacleFragments` puts every box into: nothing in that merge
  // remembers which vertices were which obstacle's, and unlike the mesh shell
  // above there is no already-built per-obstacle mesh sitting around to
  // borrow materials from. Skips the merged path's tint/`dyncol`/`texmat`
  // handling -- a glow nobody sees except while phasing through this one box
  // does not need its own animated colour.
  //
  // Its own vertical centre, not the obstacle's base: `BoxGeometry`/
  // `ConeGeometry` are centred on the local origin the way
  // `_buildObstacleFragments`'s own `obstacleMatrix()` (`baseY + h / 2`)
  // expects, unlike the dot cloud and outline elsewhere in
  // `_getInsideBuildingNode`, which put local `y = 0` at the obstacle's own
  // base. `_getInsideBuildingNode` shifts this shell up by `height / 2` of
  // its own to land it on the same world span rather than half a height too
  // low.
  //
  // `_filterBuriedShellGeometry` drops whatever `_buildObstacleFragments`
  // would have dropped from the outside view too -- a wall buried against a
  // neighbouring obstacle (four overlapping boxes making an octagon, say) has
  // an inside just as buried, and this shell has no other way to learn that:
  // it is built from scratch rather than sliced out of that merge.
  // How a box's walls and roof tile, with the world's `_boxHeight`: upstream
  // tiles them at `0.2 * _boxHeight` (SceneBuilder.cxx:198), so a world with
  // taller default boxes tiles them bigger. 9.42 is upstream's default.
  setBoxHeight(boxHeight) {
    this._boxTextureFactor = Number.isFinite(boxHeight) && boxHeight > 0 ? boxHeight / (6.0 * 1.57) : 1;
  }

  _boxTextureScales() {
    const factor = this._boxTextureFactor || 1;
    return { sideScale: BOX_TEXTURE_SCALES.sideScale * factor, capScale: BOX_TEXTURE_SCALES.capScale * factor };
  }

  _buildBoxInsideBuildingShell(obs, height) {
    const geometry = this._filterBuriedShellGeometry(this._prepareStandingBoxGeometry(
      obstacleWidth(obs), height, obstacleBreadth(obs), {
        ...this._boxTextureScales(),
        omitFaces: getObstacleBase(obs) > 0 ? [] : [BOX_FACE.NY],
      },
    ), obs, height);
    const wallTexture = resolveObstacleTextureFactory(
      obs.wallTexture || null, obs.wallTextureUrl || null, '/textures/boxwall.png', createBoxWallTexture,
    )();
    const capTexture = resolveObstacleTextureFactory(
      obs.capTexture || null, obs.capTextureUrl || null, '/textures/roof.png', createRoofTexture,
    )();
    const shellOptions = {
      transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    };
    return new THREE.Mesh(geometry, [
      new THREE.MeshBasicMaterial({ map: wallTexture, ...shellOptions }),
      new THREE.MeshBasicMaterial({ map: capTexture, ...shellOptions }),
    ]);
  }

  // A pyramid's own textured shell -- same reasoning as the box above, and the
  // same cone geometry/UV recipe `_buildObstacleFragments` uses for its real
  // one.
  _buildPyramidInsideBuildingShell(obs, height) {
    const geometry = new THREE.ConeGeometry(0.5 / Math.SQRT2, height, 4, 1);
    geometry.clearGroups();
    const pyramidSideIndexCount = geometry.index.count - 12;
    const showPyramidBase = getObstacleBase(obs) > 0 || Boolean(obs.inverted);
    if (!showPyramidBase) geometry.setIndex(Array.from(geometry.index.array.slice(0, pyramidSideIndexCount)));
    geometry.addGroup(0, pyramidSideIndexCount, 0);
    if (showPyramidBase) geometry.addGroup(pyramidSideIndexCount, 12, 1);
    const w = obstacleWidth(obs);
    const d = obstacleBreadth(obs);
    geometry.rotateY(-Math.PI / 4);
    if (w > d) geometry.rotateY(Math.PI / 2);
    geometry.scale(2 * w, 1, 2 * d);
    if (obs.inverted) geometry.rotateX(Math.PI);
    standUpGeometry(geometry);

    const pyramidBaseSpan = Math.max(w, d);
    const pyramidSlantHeight = Math.hypot(height, pyramidBaseSpan / 2);
    this._bakeGroupUvTransform(geometry, 0, {
      repeatX: pyramidBaseSpan / PYRAMID_TEXTURE_SCALE,
      repeatY: pyramidSlantHeight / PYRAMID_TEXTURE_SCALE,
    });
    if (showPyramidBase) {
      this._bakeGroupUvTransform(geometry, 1, {
        repeatX: w / PYRAMID_ROOF_TEXTURE_SCALE,
        repeatY: d / PYRAMID_ROOF_TEXTURE_SCALE,
        rotation: obs.inverted ? Math.PI : 0,
        centerX: 0.5,
        centerY: 0.5,
      });
    }
    // After the UV bake above, which needs this geometry's own index/groups
    // intact -- see `_filterBuriedShellGeometry`.
    const filtered = this._filterBuriedShellGeometry(geometry, obs, height);

    const wallTexture = resolveObstacleTextureFactory(
      obs.wallTexture || null, obs.wallTextureUrl || null, '/textures/pyrwall.png', createPyramidTexture,
    )();
    const capTexture = resolveObstacleTextureFactory(
      obs.capTexture || null, obs.capTextureUrl || null, '/textures/roof.png', createRoofTexture,
    )();
    const shellOptions = {
      transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    };
    return new THREE.Mesh(filtered, [
      new THREE.MeshBasicMaterial({ map: wallTexture, ...shellOptions }),
      new THREE.MeshBasicMaterial({ map: capTexture, ...shellOptions }),
    ]);
  }

  // One eighth-dimension node per obstacle, built the first time a tank is
  // inside that obstacle rather than with the world. Upstream builds all of them
  // in SceneBuilder because it builds every scene node there anyway; here they
  // are geometry no frame draws until somebody carries `OO`, and a map has
  // hundreds of obstacles.
  _getInsideBuildingNode(obs) {
    let node = this.insideBuildingNodes.get(obs);
    if (node) return node;

    if (obs.type === 'mesh') {
      node = this._buildMeshInsideBuildingNode(obs);
      this.insideBuildingNodes.set(obs, node);
      return node;
    }

    const height = getObstacleHeight(obs);
    const halfW = obs.size[0];
    const halfD = obs.size[1];
    const pyramid = obs.type === 'pyramid';
    const count = pyramid
      ? BZFLAG_EIGHTH_DIM_PYRAMID_POLYGONS
      : BZFLAG_EIGHTH_DIM_BOX_POLYGONS;
    const polySize = halfW / Math.cbrt(count);

    // The solid's vertical extent over a point of its footprint. A box is its
    // whole height everywhere; a pyramid is bounded by the slope, which bzo asks
    // its own geometry for rather than taking upstream's `slope * hypot(x, y)`:
    // that is a cone rather than a pyramid, and it knows nothing of an inverted
    // one, which bzo maps have.
    const localSpan = (localX, localY) => {
      if (!pyramid) return { low: 0, high: height };
      const surface = getPyramidSurfaceLocalHeight(obs, localX, localY) ?? 0;
      return obs.inverted ? { low: surface, high: height } : { low: 0, high: surface };
    };

    const positions = [];
    const colors = [];
    for (let i = 0; i < count; i += 1) {
      // A triangle's centre, then three points scattered around it and clamped
      // back into the solid.
      const baseX = (halfW - 0.5 * polySize) * (2 * Math.random() - 1);
      const baseY = (halfD - 0.5 * polySize) * (2 * Math.random() - 1);
      const baseSpan = localSpan(baseX, baseY);
      const baseZ = baseSpan.low
        + Math.max(0, baseSpan.high - baseSpan.low - 0.5 * polySize) * Math.random();
      const red = BZFLAG_EIGHTH_DIM_COLOR_MIN + BZFLAG_EIGHTH_DIM_COLOR_RANGE * Math.random();
      const green = BZFLAG_EIGHTH_DIM_COLOR_MIN + BZFLAG_EIGHTH_DIM_COLOR_RANGE * Math.random();
      const blue = BZFLAG_EIGHTH_DIM_COLOR_MIN + BZFLAG_EIGHTH_DIM_COLOR_RANGE * Math.random();
      const alpha = BZFLAG_EIGHTH_DIM_ALPHA_MIN + BZFLAG_EIGHTH_DIM_ALPHA_RANGE * Math.random();
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const x = Math.max(-halfW, Math.min(halfW, baseX + polySize * (Math.random() - 0.5)));
        const y = Math.max(-halfD, Math.min(halfD, baseY + polySize * (Math.random() - 0.5)));
        const span = localSpan(x, y);
        const z = Math.max(span.low, Math.min(span.high, baseZ + polySize * (Math.random() - 0.5)));
        positions.push(x, y, z);
        colors.push(red, green, blue, alpha);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      // disableCulling(), and no depth write: the triangles are a cloud, and
      // whichever of them the driver happened to submit first is not the one
      // that should hide the rest.
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const cloud = new THREE.Mesh(geometry, material);
    cloud.renderOrder = EIGHTH_DIM_RENDER_ORDER;

    // The white outline around them, which is the only edge of the building a
    // tank inside it can see. A box is its twelve edges; a pyramid is its base
    // and the four ribs to the apex, at the top for an upright one and at the
    // bottom for an inverted one.
    const apexZ = obs.inverted ? 0 : height;
    const cornerZ = obs.inverted ? height : 0;
    const corners = [
      [halfW, -halfD, cornerZ],
      [-halfW, -halfD, cornerZ],
      [-halfW, halfD, cornerZ],
      [halfW, halfD, cornerZ],
    ];
    const edges = [];
    for (let i = 0; i < 4; i += 1) {
      const next = (i + 1) % 4;
      edges.push(...corners[i], ...corners[next]);
      if (pyramid) {
        edges.push(...corners[i], 0, 0, apexZ);
      } else {
        const top = [corners[i][0], corners[i][1], height];
        const topNext = [corners[next][0], corners[next][1], height];
        edges.push(...top, ...topNext);
        edges.push(...corners[i], ...top);
      }
    }
    const outlineGeometry = new THREE.BufferGeometry();
    outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
    const outline = new THREE.LineSegments(
      outlineGeometry,
      new THREE.LineBasicMaterial({ color: 0xffffff })
    );
    outline.renderOrder = EIGHTH_DIM_RENDER_ORDER;

    const shell = pyramid
      ? this._buildPyramidInsideBuildingShell(obs, height)
      : this._buildBoxInsideBuildingShell(obs, height);
    shell.renderOrder = EIGHTH_DIM_RENDER_ORDER;
    shell.frustumCulled = false;
    // The shell's own geometry is centred the way `_buildObstacleFragments`
    // centres the real one (`baseY + height / 2`), not based at `y = 0` the
    // way `node` itself is (matching the dot cloud and outline below) -- see
    // `_buildBoxInsideBuildingShell`.
    shell.position.z = height / 2;

    // Built about the obstacle's base, and placed in `worldFrame`.
    node = placeObstacle(new THREE.Group(), obs);
    // The obstacle it belongs to never moves, so neither does this.
    node.matrixAutoUpdate = false;
    node.updateMatrix();
    // Never culled, for the same reason upstream's cull() returns false: the
    // viewer is inside the volume this is the bounds of.
    cloud.frustumCulled = false;
    outline.frustumCulled = false;
    node.add(shell);
    node.add(cloud);
    node.add(outline);
    this._tagDraws(node, 'effect');
    this.insideBuildingNodes.set(obs, node);
    return node;
  }

  // playing.cxx:6198, "if inside a building, add some eighth dimension scene
  // nodes": the obstacles the local tank is standing in, and nothing else.
  // Called only when the list changes, so an ordinary frame does no work here.
  // Attached and detached rather than shown and hidden. `updateMatrixWorld`
  // walks the whole graph whatever is visible, so a node left parented is a
  // matrix recomposed every frame for the rest of the session -- and a tank that
  // drives through a dozen buildings would leave a dozen behind. The geometry
  // stays in the map either way, so re-entering a building costs nothing.
  setInsideBuildings(obstacles = []) {
    if (!this.scene) return;
    for (const node of this.visibleInsideBuildingNodes) this.worldFrame.remove(node);
    this.visibleInsideBuildingNodes = obstacles.map((obs) => {
      const node = this._getInsideBuildingNode(obs);
      this.worldFrame.add(node);
      return node;
    });
  }

  _clearInsideBuildings() {
    this.insideBuildingNodes.forEach((node) => {
      this._clearObjectForRemoval(node);
    });
    this.insideBuildingNodes = new Map();
    this.visibleInsideBuildingNodes = [];
  }

  setDebugLabelsEnabled(enabled) {
    this.debugLabelsEnabled = enabled;
    this._updateDebugLabelsVisibility();
  }

  _createDebugLabelSprite(name, color = '#ffffff') {
    const labelMaterial = new THREE.SpriteMaterial({ ...LABEL_MATERIAL_DEPTH });
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(4, 1, 1);
    this.updateSpriteLabel(label, name || '', color);
    return label;
  }

  // For an obstacle with no mesh of its own, because it was merged into a
  // fragment with every other obstacle of its kind. The position is the
  // game's, and the label hangs off `worldFrame` rather than off the obstacle.
  // `color` is the obstacle's own where it has one -- a base's team, or the
  // colour a map painted a box -- so the label reads as the thing it names.
  _addDebugLabelAt(name, position, type, color = undefined) {
    const label = this._tagDraws(this._createDebugLabelSprite(name, color ?? '#ffffff'), 'debug');
    label.position.copy(position);
    this.worldFrame.add(label);
    label.visible = this.debugLabelsEnabled;
    this.debugLabels.push({ label, object3D: this.worldFrame, type });
  }

  _addDebugLabel(object3D, type) {
    if (!object3D) return;
    // Tagged even though it hangs off its subject, so it is counted as the
    // debug it is rather than as whatever it is labelling.
    const label = this._tagDraws(this._createDebugLabelSprite(object3D.name), 'debug');
    // Ensure boundingBox is computed for label placement
    if (object3D.geometry && !object3D.geometry.boundingBox) object3D.geometry.computeBoundingBox();
    const box = object3D.geometry && object3D.geometry.boundingBox;
    // A wall's geometry is centred on its own local origin, with the object
    // itself carrying the world position -- so the box's own x/y centre is
    // (0,0) there and this changes nothing for it. A mesh's geometry instead
    // bakes absolute world coordinates straight in (see `_buildMeshObject`)
    // with the object left at identity, so without its own x/y centre here
    // every mesh label would float at the world origin instead of over the
    // mesh it is meant to label.
    label.position.set(
      box ? (box.min.x + box.max.x) / 2 : 0,
      box ? (box.min.y + box.max.y) / 2 : 0,
      (box ? box.max.z : object3D.position.z) + 2,
    );
    object3D.add(label);
    label.visible = this.debugLabelsEnabled;
    this.debugLabels.push({ label, object3D, type });
  }

  _clearDebugLabels(type = null) {
    this.debugLabels = this.debugLabels.filter(({ label, object3D, type: t }) => {
      if (!type || t === type) {
        if (object3D && label) {
          object3D.remove(label);
        }
        if (label && label.material) {
          if (label.material.map) {
            label.material.map.dispose();
          }
          label.material.dispose();
        }
        return false;
      }
      return true;
    });
  }

  _updateDebugLabelsVisibility() {
    this.debugLabels.forEach(({ label }) => {
        if (label) {
          label.visible = this.debugLabelsEnabled;
        }
    });
  }
}
