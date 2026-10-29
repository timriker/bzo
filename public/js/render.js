/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
import * as THREE from 'three';
import { DISPLAY_OUTPUT_COLOR_SPACE } from './color-management.mjs';
import { AnaglyphEffect } from './anaglyph.js';
import { xrState } from './webxr.js';
import { markFramePhase, noteProgramCount } from './perf.js';
import {
  collectDeviceHints, detectRenderCapabilities,
} from './capabilities.mjs';
import {
  GAME_SOUNDS,
  GAME_SOUND_NAMES,
  MASTER_VOLUME,
  GAME_LIMITER,
  SOUND_DISTANCE_MODEL,
  SOUND_REF_DISTANCE,
  SOUND_ROLLOFF_FACTOR,
  VOICE_DUCK_GAIN,
  getSoundPath,
  loadAudioBuffer,
} from './audio.js';
import {
  TANK,
} from './collision.mjs';
import {
  DEFAULT_VOLUME_LEVEL,
  clampVolumeLevel,
  volumeLevelToGain,
} from './volume.mjs';
import {
  createZoneGroundTexture,
} from './texture.js';
import { SkyRendering } from './render-sky.js';
import { LightingRendering } from './render-lighting.js';
import { WorldRendering } from './render-world.js';
import { TankRendering } from './render-tanks.js';
import { EffectsRendering } from './render-effects.js';
import { FlagRendering } from './render-flags.js';

// BZDB_MUZZLEFRONT (global.cxx: "_tankRadius + 0.1") is upstream's own
// invariant: the muzzle never sits more than 0.1 past the tank's closest
// possible approach to a wall, whatever the model looks like, so a shot can
// never originate beyond a wall the tank's own hull is already being kept
// off of. Upstream's collision is a bounding circle (_tankRadius, 4.32), but
// bzo's is box-precise -- a tank driven straight into a flat wall stops with
// its nose (BZFLAG_TANK_LENGTH / 2, half the tank's own length) right at the
// surface, closer than upstream's circle ever allows. bzo derives the
// forward offset from each model's real barrel geometry for visual accuracy
// (see _computeMuzzleFromBarrel below), but a long-barreled model can compute
// a value past *this* tank's own closest approach -- letting the shot spawn
// inside or past a thin wall (issue #83). Clamp to bzo's own invariant.
// A tank stands in `worldFrame` at the game's position, its model built
// facing +X on +Z, so its `rotation.z` is its azimuth.
export function tankAzimuth(tank) {
  return tank.rotation.z;
}

// A geometry three.js builds along +Y -- a cylinder, a cone -- turned to run
// along +Z, the game's up: (x, y, z) becomes (x, -z, y).
export function standUpGeometry(geometry) {
  return geometry.rotateX(Math.PI / 2);
}


const BZFlag_DEFAULT_HORIZONTAL_FOV = 60;

// `glPointSize(2.0f)`, and not scaled by distance: a nav light that shrank
// with range would stop being readable at exactly the range it is there for.
//
// Upstream's 2 is a count of pixels, which is only a size on the display it
// was chosen for. The same two pixels are a quarter of their intended share of
// a 4K window and several times it on a small phone -- and a tank at a given
// range subtends the same angle on both, so the light that marks it should
// cover the same part of that angle. Two pixels of a 1080-tall buffer is the
// share upstream means; every other buffer gets the same fraction of its own
// height, floored where a point stops being drawable at all and capped before
// a headset's very tall buffer turns a nav light into a lamp.
// A light is a lamp of a fixed size, so it grows as you close on a tank the
// way everything else in the scene does -- and stops shrinking at the far end,
// which is where upstream's flat `glPointSize` holds it for the whole range
// the lights are actually read at. Both ends are the one clamp: the floor is
// the far-field size and the ceiling is how big a light gets point-blank.
//
// The far-field size, as a share of the buffer's height rather than a count of
// pixels -- two pixels is only a size on the display it was chosen for, a
// quarter of its intended share of a 4K window and several times it on a
// phone. The reference is the buffer a 1080p browser window actually draws
// into, which is the display these two pixels were judged on and some way
// short of 1080 once the window's own furniture is out of it.
const TANK_NAV_LIGHT_PIXELS = 2;
export const TANK_NAV_LIGHT_REFERENCE_HEIGHT = 800;
// The other half of that reference: the view those two pixels were judged
// through. A share of the buffer's height is a share of the camera's field of
// view, so the same share is a wider angle through a wider lens. The game's 60
// degrees across 16:9 is 36 degrees top to bottom, the tank preview's is 42,
// and a headset's is 90-odd -- which would draw the same light two and a half
// times the size, at every distance and whatever the headset's resolution,
// because the buffer's height cancels out of the two. `projectionMatrix`
// carries `1/tan(fovY/2)` in its second diagonal, so dividing the camera's own
// by this one holds a light to the angle it was chosen at whatever draws it.
const TANK_NAV_LIGHT_REFERENCE_FOCAL =
  (16 / 9) / Math.tan(THREE.MathUtils.degToRad(BZFlag_DEFAULT_HORIZONTAL_FOV * 0.5));
// A round dot has nothing to be round in under two pixels. This floors the
// finished size rather than the share it is worked out from: floor the share
// and a buffer far shorter than the reference -- the tank preview's canvas is
// one -- keeps the reference's whole curve, ceiling and all, in a fraction of
// the pixels to spend it in.
const TANK_NAV_LIGHT_SIZE_MIN = 2;
// Where the size settles to the far-field one: closer in it grows, further out
// it holds. This has to be far enough out that the ranges a tank is actually
// seen at land high on the curve. A point is drawn in whole pixels, so a
// difference the curve is proud of can still rasterise to the same 2x2 block
// and be no difference at all -- at five tank lengths the chase camera came
// out at 2.4 pixels against the far field's 2.0 and looked identical to it.
// Forty tank lengths puts the chase camera's twelve units at four and a half
// times the far-field size, which is four pixels of difference rather than
// none.
function tankNavLightHold() {
  return 40 * TANK.length;
}
// How hard the size follows the distance. Solid geometry follows it exactly --
// an exponent of 1, half the distance and twice the size -- and a light should
// not, because what a light is worth at range is out of all proportion to how
// much of the sky it covers. A square root puts the lights between the two:
// closing on a tank they grow, but slower than the tank does, so a far tank's
// lights are the largest thing about it and a near tank's are a detail on a
// hull that is already unmistakable.
//
// Fixed-function OpenGL had this as `GL_POINT_DISTANCE_ATTENUATION`, a
// quadratic whose coefficients chose the same curve. GLES2 dropped
// `glPointParameter` and WebGL never had it, so `gl_PointSize` in the vertex
// shader is the whole of the feature now -- and Three's own `sizeAttenuation`
// is only the one coefficient that gives solid geometry's exponent of 1.
const TANK_NAV_LIGHT_FALLOFF = 0.5;
// The ceiling, as a multiple of the far-field size: how big a light gets when
// you are on top of it. The only dial for that, and it has to clear what the
// chase camera asks for or the view a player spends most of its time in is
// the flat top of the curve.
const TANK_NAV_LIGHT_GROWTH = 6;

// `gl_PointSize` from the distance to the point, the height of the buffer being
// drawn into, and the camera's field of view. The clamp is the shader's own, so
// the only thing JS writes is the height. The distance is the length of the
// view-space position rather than its depth: depth falls short of the distance
// by the cosine of the angle off the view axis, which a 36-degree view keeps
// under a tenth and a headset's 90-odd does not -- there a light at the edge of
// vision is a third larger again, and it breathes as the head turns.
export const TANK_NAV_LIGHT_VERTEX_SHADER = `
uniform float bufferHeight;
attribute vec3 color;
varying vec3 vColor;
#include <common>
#include <fog_pars_vertex>
void main() {
  vColor = color;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float held = ${TANK_NAV_LIGHT_PIXELS.toFixed(1)} * bufferHeight
    / ${TANK_NAV_LIGHT_REFERENCE_HEIGHT.toFixed(1)}
    * projectionMatrix[1][1] / ${TANK_NAV_LIGHT_REFERENCE_FOCAL.toFixed(4)};
  float viewDistance = length(mvPosition.xyz);
  gl_PointSize = max(${TANK_NAV_LIGHT_SIZE_MIN.toFixed(1)}, clamp(
    held * pow(
      ${tankNavLightHold().toFixed(1)} / max(viewDistance, 0.001),
      ${TANK_NAV_LIGHT_FALLOFF.toFixed(2)}
    ),
    held,
    ${TANK_NAV_LIGHT_GROWTH.toFixed(1)} * held
  ));
  #include <fog_vertex>
}
`;

// One name for the whole set, so the places that walk a tank's own nodes can
// find them: the two that deep-clone a tank -- the explosion debris and the
// server-position ghost -- drop them, and client.js's cloaking fade leaves
// their material alone.
export const TANK_NAV_LIGHTS_NAME = 'navLights';

// The teleporter proximity wash, drawn on a quad mounted to the camera. Last of
// everything the world draws, matching where upstream runs it: `renderDimming`
// closes `SceneRenderer::render` (SceneRenderer.cxx:843), and `playing.cxx`
// hands the finished frame to the HUD afterwards.
const TELEPORTER_DIMMING_RENDER_ORDER = 9999;
// Every name written into the world -- a tank's callsign, a flag's
// abbreviation, an obstacle's debug label -- is a billboard in the scene rather
// than the flat HUD text upstream draws after the frame
// (HUDRenderer::renderTankLabels). Being in the scene, it has to sort with the
// scene, and the only thing that can do that in both directions is depth: a
// render order high enough to stop a projected shadow or a badly-sorted merged
// obstacle painting over a name from behind is also high enough to draw the
// name over the alpha-textured panel standing in front of it.
//
// So a label writes depth. Every effect that would otherwise cover it from
// behind depth-tests -- the shadow darkening pass, the ground receivers, the
// track marks, an obstacle fragment whose merged geometry sorts by a centre
// nowhere near the face being drawn -- and each is rejected where the name is
// nearer. In front, ordinary back-to-front sorting still puts a transparent
// face over the name, which is what makes it possible to hide behind one. The
// `alphaTest` below is what keeps this honest: the empty pixels around the
// glyphs are discarded before the depth write, so a label occludes only where
// it has something to say.
export const LABEL_MATERIAL_DEPTH = Object.freeze({
  depthTest: true,
  depthWrite: true,
  transparent: true,
  alphaTest: 0.1,
});

// The server-position ghost wraps the tank 5% out so both are visible at once.
// It is exported because the ghost is a sibling of the tank, not a child, so
// whoever scales the tank has to scale the ghost by the same factors.
export const GHOST_SCALE = 1.05;
// And the opacity it is drawn at, so the tank shows through it. Exported for the
// same reason the scale is: the ghost is not a child of the tank, so whatever
// fades the tank has to fade the ghost by the same proportion.
export const GHOST_ALPHA_SCALE = 0.25;
// A measurement knob, not a setting: `?renderScale=0.5` draws into a buffer half
// the window on each axis and lets the browser scale it up to fill the window
// unchanged. Resizing the window cannot answer the same question, because it
// moves the pixels bzo draws and the surface the browser presents together --
// this moves only the first. No UI and no persistence: it exists to tell those
// two costs apart on a machine that is slow, and the answer decides whether any
// renderer setting could have helped it.
function readRenderScale() {
  const raw = Number(new URLSearchParams(window.location.search).get('renderScale'));
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(1, Math.max(0.25, raw));
}

// The same kind of knob, for the same reason: `?antialias=0` drops MSAA. Chrome
// carries a driver workaround saying MSAA is not acceptable on Intel GPUs, and
// the machines that read slowest here are the ones it applies to, so the cost of
// the samples has to be measurable rather than assumed. The context reports what
// it was given, so `renderer.capabilities` in the log says which run is which.
// Two more, to answer what turning dynamic lighting off should also turn off.
// `?shadows=0` drops the projected shadow pass -- the caster stencil draws, the
// darkening overlay and the per-frame projection -- and `?celestial=0` drops the
// sun and moon discs, which are only three draws but large ones. Whether either
// is worth coupling to the lighting setting is a measurement, not a guess.
function readProjectedShadowsEnabled() {
  const raw = new URLSearchParams(window.location.search).get('shadows');
  return raw !== '0' && raw !== 'false';
}

function readCelestialEnabled() {
  const raw = new URLSearchParams(window.location.search).get('celestial');
  return raw !== '0' && raw !== 'false';
}

function readAntialias() {
  const raw = new URLSearchParams(window.location.search).get('antialias');
  return raw !== '0' && raw !== 'false';
}

// `?xrScale=0.7` is renderScale for a session, and it is a separate knob
// because renderScale cannot be one: it works through setPixelRatio, and the
// framebuffer a session draws into belongs to the headset, not to the page. So
// a headset ignores renderScale outright -- the drawing buffer in a sample
// taken in a session is the headset's own resolution whatever the page asked
// for -- and this is the only way to ask for fewer pixels there. A fraction of
// the resolution the runtime recommends, so 1 is native and above 1
// supersamples.
const XR_FRAMEBUFFER_SCALE_MIN = 0.25;
const XR_FRAMEBUFFER_SCALE_MAX = 2;

function readXRFramebufferScale() {
  const raw = Number(new URLSearchParams(window.location.search).get('xrScale'));
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(XR_FRAMEBUFFER_SCALE_MAX, Math.max(XR_FRAMEBUFFER_SCALE_MIN, raw));
}

const GROUND_GRID_Z = 0.02;

export let onAlphaWithoutThreshold = null;

export function reportAlphaWithoutThreshold(callback) {
  onAlphaWithoutThreshold = callback;
}

// `MeshDrawInfo::updateAnimation` (#88): a mesh's own `angvel`, degrees/sec
// about its own placement, evaluated off the same shared wall clock
// `_updateAnimatedMaterials` uses (`Date.now()`, not `performance.now()`) so
// every connected client agrees on the angle at any given real moment, the
// same reason a map's `dyncol`/`texmat` already reads that clock. Exported
// for `client.js`'s own radar draw, which projects a spinning mesh's faces
// itself rather than through this module's `THREE.Object3D` tree.
export function meshSpinRadians(angvel, timeSeconds = Date.now() * 0.001) {
  if (!angvel) return 0;
  const angleDeg = (angvel * timeSeconds) % 360;
  return angleDeg * (Math.PI / 180);
}

// The chase camera's offset from the tank it follows: this far behind along the
// tank's heading, this far above it. One pair for both paths, because a desktop
// third-person view and an XR one that framed the tank differently would be two
// different views under one name.
const THIRD_PERSON_DISTANCE = 12;
const THIRD_PERSON_HEIGHT = 4;
// A chase camera's distance and height are for a 16:9 screen. bzo keeps the
// horizontal field of view at BZFlag's 60 degrees, so a narrower screen sees
// more top to bottom and the tank it follows shrinks in it -- a phone held
// upright sees two and a half times as much. Narrower than this, the chase
// comes in by the fourth root of the ratio, 0.87 on a 9:16 phone: by the whole
// ratio the tank keeps its share of the height and fills the narrow width,
// hiding the way ahead, and the tilt below does most of the rest. Never past
// 0.6, which on the tallest phones still keeps the third-person eye well
// clear of its own tank.
const CHASE_REFERENCE_ASPECT = 16 / 9;
const CHASE_SCALE_MIN = 0.6;
// A tall view looks as far down as up, and from behind the tank most of what
// lies below its middle is the ground between the eye and the tank. The chase
// camera is tilted up until the bottom of the view meets the ground this many
// degrees short of the tank's rear (half a tank, BZFlag's 6 long, behind its
// middle) -- on a 16:9 screen it already does, and nothing changes.
const CHASE_TILT_MARGIN_DEGREES = 5;
const CHASE_TANK_REAR = 3;
// First in the transparent pass, before flags, shots, explosions and
// alpha-tested foliage -- none of those write depth, so none of them can
// depth-reject a grid line drawn after them. A default (0) renderOrder is
// what ordinary scenery gets, so the grid needs to sort below that floor to
// stay underneath everything else in the pass.
const GROUND_GRID_RENDER_ORDER = -1;

// BZFlag gives every dynamic light the same falloff, 1/(c + l*d + q*d*d) --
// bolts (BoltSceneNode.cxx:52-55), jump jets (TankSceneNode.cxx:75-83) and
// explosions (playing.cxx:3637) alike -- and varies only the colour it feeds in.
// Three's punctual lights are intensity/d*d instead, so past about a metre and a
// half the two curves agree when intensity is upstream's colour scale divided by
// the quadratic term. Closer in upstream flattens at 1/c where Three keeps
// climbing, and both are far past white either way.
// Constant, linear, quadratic; shared with the ground receiver pass.
const CAMERA_NEAR = 1;
const CAMERA_NEAR_INSIDE_TANK = 0.25;
const CAMERA_NEAR_XR = 0.1;
export const BZFLAG_LIGHT_ATTENUATION = [0.05, 0.0, 0.03];
const GAME_UP = new THREE.Vector3(0, 0, 1);
const THREE_UP = new THREE.Vector3(0, 1, 0);
const CAMERA_EYE_SCRATCH = new THREE.Vector3();
const CAMERA_TARGET_SCRATCH = new THREE.Vector3();
const CAMERA_LOOK_SCRATCH = new THREE.Vector3();
const CAMERA_FRAME_SCRATCH = new THREE.Quaternion();

class RenderManager {
  // How far in a chase camera comes for this screen's shape (see
  // CHASE_REFERENCE_ASPECT): 1 on 16:9 and wider, and in a headset, whose
  // own optics set what it sees.
  getChaseScale() {
    if (xrState.enabled) return 1;
    const aspect = this.camera?.aspect;
    if (!(aspect > 0)) return 1;
    return Math.max(CHASE_SCALE_MIN, Math.min(1, Math.sqrt(Math.sqrt(aspect / CHASE_REFERENCE_ASPECT))));
  }

  _getVerticalFovForAspect(aspect) {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : (16 / 9);
    const halfHorizontalRadians = THREE.MathUtils.degToRad(BZFlag_DEFAULT_HORIZONTAL_FOV * 0.5);
    const halfVerticalRadians = Math.atan(Math.tan(halfHorizontalRadians) / safeAspect);
    return THREE.MathUtils.radToDeg(halfVerticalRadians * 2);
  }

  _getViewportSize() {
    const body = document.body;
    const doc = document.documentElement;
    const visualViewport = window.visualViewport;
    const containerBounds = this.container && typeof this.container.getBoundingClientRect === 'function'
      ? this.container.getBoundingClientRect()
      : null;
    const width = Math.max(
      0,
      Number(window.innerWidth) || 0,
      Number(visualViewport && visualViewport.width) || 0,
      Number(doc && doc.clientWidth) || 0,
      Number(body && body.clientWidth) || 0,
      Number(this.container && this.container.clientWidth) || 0,
      Number(containerBounds && containerBounds.width) || 0,
    );
    const height = Math.max(
      0,
      Number(window.innerHeight) || 0,
      Number(visualViewport && visualViewport.height) || 0,
      Number(doc && doc.clientHeight) || 0,
      Number(body && body.clientHeight) || 0,
      Number(this.container && this.container.clientHeight) || 0,
      Number(containerBounds && containerBounds.height) || 0,
    );

    const fallbackWidth = Math.max(320, Number(window.screen && window.screen.availWidth) || 1280);
    const fallbackHeight = Math.max(200, Number(window.screen && window.screen.availHeight) || 720);
    return {
      width: Math.max(1, width >= 32 ? Math.floor(width) : fallbackWidth),
      height: Math.max(1, height >= 32 ? Math.floor(height) : fallbackHeight),
    };
  }
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.audioListener = null;
    this.gameVolumeLevel = DEFAULT_VOLUME_LEVEL;
    // Set while somebody's voice is coming through, so the game gets out of
    // the way of it. The player's own level is untouched underneath -- this is
    // a factor on top of it, not a second setting.
    this.voiceDucked = false;
    // Gameplay sample buffers, keyed by GAME_SOUNDS name.
    this.soundBuffers = new Map();
    this.container = null;

    this.ground = null;
    this.groundExtent = null;
    this.groundMapSize = null;
    this._groundCenterX = null;
    this._groundCenterY = null;
    this.gridHelper = null;
    this.obstacleMeshes = [];
    // A mesh face's or a box/pyramid's own `dyncol`/`texmat` (`docs/bzw.md`,
    // "Animated materials") -- `{ material, dynamicColor }` and/or
    // `{ texture, textureMatrix }` entries, driven each frame by
    // `_updateAnimatedMaterials`. Each entry carries `source: 'obstacle'` or
    // `'mesh'`, so `clearObstacles`/`clearMeshes` can each drop only its own
    // half without racing whichever one reloads second.
    this._animatedMaterials = [];
    // One `THREE.Mesh` per parsed `mesh` block -- render-only, see `setMeshes`.
    this.meshObjects = [];
    // `{ group, angvel }` per spinning mesh (`angvel`, #88) -- `group` is the
    // pivot wrapper `setMeshes` puts around that mesh's own (otherwise
    // static) `THREE.Mesh`, driven each frame by `_updateMeshSpins`. Reset
    // wholesale on every `clearMeshes`, same as `meshObjects` itself.
    this._meshSpins = [];
    // Keyed by the obstacle the tank is inside, built on demand.
    this.insideBuildingNodes = new Map();
    this.visibleInsideBuildingNodes = [];
    this.mountainMeshes = [];
    this.celestialMeshes = [];
    this.sunMesh = null;
    this.sunGlowMesh = null;
    this.moonMesh = null;
    this.clouds = [];
    // Set by the world overview, which stands above the cloud layer.
    this.cloudsHiddenForOverview = false;
    this.skyBeacons = [];
    this.skyBeaconGeometry = null;
    this.skyBeaconTopZ = 0;

    this.compassMarkers = [];
    this.maxObstacleHeight = 0;

    this.debugLabels = [];
    this.debugLabelsEnabled = true;

    this.anaglyphEffect = null;
    this.anaglyphEnabled = false;
    this.projectedShadowOverlay = null;
    this.activeExplosions = [];
    this.activeLandingEffects = [];
    this.activeSpawnEffects = [];
    // Scratch for one silhouette edge's two ends, reused for every edge of
    // every face. The IDL runs 100 edges a tank a frame while a tank is inside
    // a wall, and allocating a vector for each would hand the collector a
    // steady drip on a client that runs out of one core.
    this._tankIDLScratchA = new Float64Array(3);
    this._tankIDLScratchB = new Float64Array(3);
    this.activeShotExplosions = [];

    // Dynamic lighting toggle (default true), and what the context allows.
    this.dynamicLightingEnabled = true;
    this.renderCapabilities = null;
    this.showGroundGrid = false;
    this.renderScale = 1;
    this.projectedShadowsEnabled = true;
    this.celestialEnabled = true;

    // Tank geometry loaded from public/obj/simple.obj (keyed by object name)
    this._tankGeoCache = null;
    this._tankTemplate = null;
    this._tankGeoCacheByPath = new Map();
    this._tankTemplateByPath = new Map();
    this._tankModelLoadsInFlight = new Set();
    this._tankModelReadyPromisesByPath = new Map();
    this._tankModelReadyResolversByPath = new Map();
    this._reportedUnbuildableTankModels = new Set();
    this._audioBufferPromisesByPath = new Map();
    this._tankModelPath = '/obj/bzflag.obj';
    this.deathFollowTarget = null;
    this.deathFollowAnchor = null;
    this.deathCameraLogged = false;
    this._preloadTankModel('/obj/bzflag.obj');
    this._preloadTankModel('/obj/modern.obj');
    this._preloadTankModel('/obj/simple.obj');
    this._preloadTankModel('/obj/wheeled6.obj');
    this._preloadGMModel();
  }

  init({ container = document.body } = {}) {
    if (this.scene) {
      return {
        scene: this.scene,
        camera: this.camera,
        renderer: this.renderer,
      };
    }

    this.container = container;
    this.renderScale = readRenderScale();
    this.projectedShadowsEnabled = readProjectedShadowsEnabled();
    this.celestialEnabled = readCelestialEnabled();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = null;

    // World group - translates all game content for XR positioning
    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);
    // The game's world, +Z up and +Y north, turned into three.js's own, which
    // is +Y up as WebXR defines it. Everything the game draws stands in it by
    // the game's own numbers; `worldGroup` is what XR moves and turns.
    this.worldFrame = new THREE.Group();
    this.worldFrame.rotation.x = -Math.PI / 2;
    this.worldGroup.add(this.worldFrame);

    const viewport = this._getViewportSize();

    const verticalFov = this._getVerticalFovForAspect(viewport.width / viewport.height);
    this.camera = new THREE.PerspectiveCamera(verticalFov, viewport.width / viewport.height, CAMERA_NEAR, 1000);
    this.camera.position.set(0, 15, 20);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: readAntialias(), xrCompatible: true, stencil: true });
    } catch (error) {
      const probeCanvas = document.createElement('canvas');
      const hasWebGL = !!(
        probeCanvas.getContext('webgl2') ||
        probeCanvas.getContext('webgl') ||
        probeCanvas.getContext('experimental-webgl')
      );
      const message = hasWebGL
        ? 'WebGL renderer initialization failed in this browser context'
        : 'WebGL is unavailable in this browser context';
      const wrappedError = new Error(message);
      wrappedError.cause = error;
      throw wrappedError;
    }

    this.renderer.outputColorSpace = DISPLAY_OUTPUT_COLOR_SPACE;
    this.renderer.xr.enabled = true;
    // Set before any session starts, because it is read when the session builds
    // its framebuffer and changing it afterwards does nothing.
    this.xrFramebufferScale = readXRFramebufferScale();
    this.renderer.xr.setFramebufferScaleFactor(this.xrFramebufferScale);
    // renderFrame() resets the counters itself, so they cover the whole frame
    // rather than whichever render() call happened to run last. The anaglyph
    // effect draws three passes per frame, and Three resets on every one.
    this.renderer.info.autoReset = false;
    this.renderCapabilities = detectRenderCapabilities(this.renderer, collectDeviceHints());
    this._applyRendererSize(viewport);
    // Disable real-time shadow mapping for performance
    this.renderer.shadowMap.enabled = false;
    // For the tank clip plane, which is the only thing bzo clips. Enabled at
    // construction rather than on first use: turning it on changes how every
    // program is generated, so doing it mid-game would recompile the lot at the
    // moment a tank drives into a wall. A material without `clippingPlanes`
    // pays nothing for it.
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    // A lost context is how a client ends up drawing black. The browser takes
    // the GL context away -- a driver reset, a background tab reclaimed, too
    // many live contexts across tabs -- and every texture and buffer in it goes
    // with it; Three cannot re-upload what it does not know is gone. Without
    // these listeners that failure is *silent*, which is why "a client lost a
    // texture and rendered black" had no evidence behind it.
    //
    // Recovered from by reloading, because the alternative is what was actually
    // observed: a client sitting with black tanks until somebody reloaded it by
    // hand. Three clears its own caches on restore and re-uploads each texture
    // from `texture.image`, which works for the ones backed by a file -- the
    // treads keep their look -- and not reliably for the `CanvasTexture` bzo
    // builds nearly everything else from, including the tank body. A reload
    // rebuilds all of them, which is the only path known to be correct.
    //
    // The default action is prevented because a context that is not restorable
    // never fires `webglcontextrestored` at all, and a client that says nothing
    // is the thing being fixed.
    // `debugLog` belongs to client.js, which owns the socket the line goes down;
    // it is assigned onto the manager after construction, as `deathFollowTarget`
    // is. The counts also ride every stats line, so the finding survives even if
    // nothing is listening at the moment it happens.
    this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLostCount = (this.contextLostCount || 0) + 1;
      const { memory, programs } = this.renderer.info;
      this.debugLog?.(
        `renderer.contextLost count=${this.contextLostCount}`
        + ` textures=${memory.textures} geometries=${memory.geometries}`
        + ` programs=${programs ? programs.length : 0}`,
        'render',
      );
    }, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextRestoredCount = (this.contextRestoredCount || 0) + 1;
      this.debugLog?.(`renderer.contextRestored count=${this.contextRestoredCount}`, 'render');
      // Once per page, and remembered across the reload: a driver that keeps
      // taking the context away would otherwise reload forever, which is worse
      // than black tanks because it never settles anywhere a log can be read.
      // Whoever is left looking at a broken frame still has the two lines above.
      let alreadyReloaded = false;
      try {
        alreadyReloaded = sessionStorage.getItem('bzoContextReload') === '1';
        sessionStorage.setItem('bzoContextReload', '1');
      } catch {
        // A browser with storage denied gets the reload; a loop there is the
        // less likely failure of the two.
      }
      if (alreadyReloaded) {
        this.debugLog?.('renderer.contextRestored: not reloading again this session', 'render');
        return;
      }
      this.debugLog?.('renderer.contextRestored: reloading to rebuild textures', 'render');
      setTimeout(() => window.location.reload(), 250);
    }, false);


    // Anaglyph effect setup (not enabled by default)
    this.anaglyphEffect = new AnaglyphEffect(this.renderer);
    this.anaglyphEffect.setSize(viewport.width, viewport.height);

    this.handleResize();
    window.setTimeout(() => this.handleResize(), 50);
    window.setTimeout(() => this.handleResize(), 250);

    this.audioListener = new THREE.AudioListener();
    this.camera.add(this.audioListener);
    // Between the master gain and the speakers (`setFilter`), so it holds
    // every game sound and nothing else: voice goes to the destination itself.
    const limiter = this.audioListener.context.createDynamicsCompressor();
    for (const [name, value] of Object.entries(GAME_LIMITER)) limiter[name].value = value;
    this.audioListener.setFilter(limiter);
    this._applyGameVolume();
    // Sample buffers are filled by preloadGameplayAudio() on map entry.

    this._initDynamicLights();

    return {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
    };
  }

  preloadAudioBuffer(path) {
    if (!path) return Promise.resolve(null);
    if (this._audioBufferPromisesByPath.has(path)) {
      return this._audioBufferPromisesByPath.get(path);
    }
    if (!this.audioListener?.context) {
      return Promise.reject(new Error('Audio context is not initialized'));
    }

    const promise = loadAudioBuffer(this.audioListener.context, path).catch((error) => {
      this._audioBufferPromisesByPath.delete(path);
      throw error;
    });
    this._audioBufferPromisesByPath.set(path, promise);
    return promise;
  }

  // Load every gameplay sample up front, on map entry. Both halves of the game
  // ship from this repo, so a missing file is a broken build: let it reject.
  async preloadGameplayAudio() {
    const buffers = await Promise.all(
      GAME_SOUND_NAMES.map((name) => this.preloadAudioBuffer(getSoundPath(name)))
    );
    GAME_SOUND_NAMES.forEach((name, index) => {
      this.soundBuffers.set(name, buffers[index]);
    });
    return this.soundBuffers;
  }

  // One positional one-shot. Attenuation mirrors BZFlag: inverse rolloff at a
  // reference distance of 20 tank radii, and no per-sound gain, so the samples
  // keep the relative balance they were recorded with.
  //
  // The context autoplay policy creates is suspended until a user gesture
  // resumes it (see resumeAudioContextOnFirstGesture in client.js), and
  // AudioContext.currentTime is frozen while suspended -- so a sound started
  // during that window would schedule at whatever instant it eventually
  // resumes, and a whole game's worth of events would all play back at once
  // the moment that happens. Dropping the sound here is what a player simply
  // not hearing it looks like, which is correct: there is no right moment to
  // play a shot that already happened.
  playSound(name, position) {
    const buffer = this.soundBuffers.get(name);
    if (!GAME_SOUNDS[name] || !buffer || !this.audioListener) return;
    if (this.audioListener.context.state !== 'running') return;

    const sound = new THREE.PositionalAudio(this.audioListener);
    sound.setBuffer(buffer);
    sound.setDistanceModel(SOUND_DISTANCE_MODEL);
    sound.setRefDistance(SOUND_REF_DISTANCE);
    sound.setRolloffFactor(SOUND_ROLLOFF_FACTOR);
    sound.setVolume(MASTER_VOLUME);
    // `position` is upstream's, in `worldFrame`.
    if (position) sound.position.set(position.x, position.y, position.z);
    this.worldFrame.add(sound);
    sound.play();
    sound.source.onended = () => { this.worldFrame.remove(sound); };
  }

  // Non-positional variant, for sounds made by the player's own tank. BZFlag
  // plays these with distance 0, which means no attenuation at all.
  playLocalSound(name) {
    const buffer = this.soundBuffers.get(name);
    if (!GAME_SOUNDS[name] || !buffer || !this.audioListener) return;
    if (this.audioListener.context.state !== 'running') return;

    const sound = new THREE.Audio(this.audioListener);
    sound.setBuffer(buffer);
    sound.setVolume(MASTER_VOLUME);
    this.camera.add(sound);
    sound.play();
    sound.source.onended = () => {
      this.camera.remove(sound);
      sound.disconnect();
    };
  }

  // Voice chat borrows this context for its microphone gain rather than opening
  // a second one. A phone counts AudioContexts, and the renderer's is already
  // running by the time anybody grants microphone permission.
  getAudioContext() {
    return this.audioListener?.context || null;
  }

  getGameVolumeLevel() {
    return this.gameVolumeLevel;
  }

  // Every gameplay sound is a node under the AudioListener, so its master gain
  // is the one place the level has to be applied.
  setGameVolumeLevel(level) {
    this.gameVolumeLevel = clampVolumeLevel(level, this.gameVolumeLevel);
    this._applyGameVolume();
    return this.gameVolumeLevel;
  }

  // Voice is not under the AudioListener -- it goes straight to the
  // destination -- so ducking the master gain ducks the game and nothing else,
  // which is what makes this one call the whole feature. setMasterVolume ramps
  // rather than steps (setTargetAtTime, 10 ms), so there is no click either way.
  setVoiceDucking(ducked) {
    const next = ducked === true;
    if (next === this.voiceDucked) return this.voiceDucked;
    this.voiceDucked = next;
    this._applyGameVolume();
    return this.voiceDucked;
  }

  isVoiceDucked() {
    return this.voiceDucked === true;
  }

  _applyGameVolume() {
    const gain = volumeLevelToGain(this.gameVolumeLevel) * (this.voiceDucked ? VOICE_DUCK_GAIN : 1);
    this.audioListener?.setMasterVolume(gain);
  }

  // Where the ears are, in world coordinates -- the same frame a voice panner
  // is placed in. three.js writes this pose onto the AudioContext listener
  // itself during the render, so reading it back afterwards is reading exactly
  // what the panners are heard relative to.
  getListenerWorldPosition(target) {
    const node = this.audioListener || this.camera;
    if (!node || !target) return null;
    return node.getWorldPosition(target);
  }

  getRenderCapabilities() {
    return this.renderCapabilities ? { ...this.renderCapabilities } : null;
  }

  // What the last frame cost the GPU, for the debug HUD. Capabilities answer
  // what the machine can do; these answer what we asked it to do, which is the
  // half a render-level policy has no measurements for yet.
  // Which bucket a thing's draws belong to. Written where the thing is built
  // rather than guessed at counting time, and inherited: everything under a
  // tank belongs to the tank.
  _tagDraws(object3D, group) {
    if (object3D) object3D.userData.drawGroup = group;
    return object3D;
  }

  // What the frame is made of, which `calls` on its own cannot say -- and which
  // has now been guessed wrong twice from the outside. Every mesh in the
  // visible scene is charged to its nearest tagged ancestor and counted as the
  // draws it would submit: one, or one per geometry group where it carries a
  // material each.
  //
  // Frustum culling is not modelled, so this is what the scene offers rather
  // than what Three accepted. The gap between the two is itself worth seeing:
  // the projected shadows are never culled, so for those the two are the same
  // number.
  //
  // Walked once per sample, which is once a map and once every twenty seconds
  // in a session, not once a frame.
  _countDrawGroups() {
    const counts = new Map();
    const walk = (object, inherited) => {
      if (object.visible === false) return;
      const group = object.userData?.drawGroup || inherited;
      let draws = 0;
      if (object.isInstancedMesh) draws = object.count > 0 ? 1 : 0;
      else if (object.isMesh || object.isSprite || object.isLine || object.isPoints) {
        // A mesh carrying several materials submits one draw per group, less
        // any group whose material index the array does not reach -- Three
        // skips those, and a BoxGeometry handed two materials has four of them.
        draws = Array.isArray(object.material)
          ? (object.geometry?.groups?.filter((group) => object.material[group.materialIndex]).length || 1)
          : 1;
      }
      if (draws > 0) counts.set(group, (counts.get(group) || 0) + draws);
      for (const child of object.children) walk(child, group);
    };
    walk(this.scene, 'other');
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([group, draws]) => `${group}:${draws}`)
      .join(',');
  }

  // `deep` asks for the counters that cost something to gather -- currently the
  // scene walk behind `objects`. Off by default because the debug HUD polls this
  // twice a second while it is open, and that is exactly when somebody is
  // measuring: an instrument that costs what it measures is worse than one field
  // short. The logged series asks for them, a few times an hour.
  getRenderStats({ deep = false } = {}) {
    if (!this.renderer) return null;
    const { render, memory, programs } = this.renderer.info;
    // The buffer, not the window: a client that is bound on pixels reads the
    // same at every frame rate unless this is next to the timings. It moves
    // whenever the window does, so the one logged at init does not answer it.
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const stats = {
      drawbuf: `${buffer.x}x${buffer.y}`,
      calls: render.calls,
      triangles: render.triangles,
      programs: programs ? programs.length : 0,
      textures: memory.textures,
      geometries: memory.geometries,
      labels: this.debugLabels ? this.debugLabels.length : 0,
      draws: this._countDrawGroups(),
    };
    // Everything in the scene graph, which is the one aggregate that catches
    // "something is being added and not removed" whatever the something is.
    // `textures` and `geometries` count what Three has uploaded and miss a node
    // holding a shared one; this counts the nodes.
    if (deep) {
      const { count, kinds } = this._countSceneObjects();
      stats.objects = count;
      // The commonest kinds by type and draw group, so a count that climbs
      // names what is climbing (`Mesh/effect:120`).
      stats.objectKinds = kinds;
    }
    // Only when it has happened, so the field's presence is the finding.
    if (this.contextLostCount) stats.contextLost = this.contextLostCount;
    if (this.contextRestoredCount) stats.contextRestored = this.contextRestoredCount;
    return stats;
  }

  // Scene descendants, counted rather than tracked: a running total would have
  // to be right at every add and remove in the renderer, and the whole reason
  // this exists is a suspicion that one of them is not. Only walked for a `deep`
  // sample, which is the logged series and not the HUD's twice-a-second poll.
  _countSceneObjects() {
    if (!this.scene) return { count: 0, kinds: '' };
    let count = 0;
    const byKind = new Map();
    this.scene.traverse((object) => {
      count += 1;
      const kind = `${object.type}/${object.userData?.drawGroup || '-'}`;
      byKind.set(kind, (byKind.get(kind) || 0) + 1);
    });
    const kinds = [...byKind].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([kind, n]) => `${kind}:${n}`).join(',');
    return { count, kinds };
  }

  _buildGroundGrid(mapSize) {
    if (!Number.isFinite(mapSize) || mapSize <= 0) return null;
    const gridSpacing = 5;
    const gridDivisions = Math.max(1, Math.round(mapSize / gridSpacing));
    const grid = new THREE.GridHelper(mapSize, gridDivisions, 0x000000, 0x555555);
    standUpGeometry(grid.geometry);
    grid.position.z = GROUND_GRID_Z;
    grid.renderOrder = GROUND_GRID_RENDER_ORDER;
    if (Array.isArray(grid.material)) {
      grid.material.forEach((material) => {
        material.depthTest = true;
        material.depthWrite = false;
        material.transparent = true;
      });
    } else if (grid.material) {
      grid.material.depthTest = true;
      grid.material.depthWrite = false;
      grid.material.transparent = true;
    }
    return grid;
  }

  _disposeGroundGrid() {
    if (!this.gridHelper) return;
    this.gridHelper.removeFromParent();
    this.gridHelper.geometry?.dispose();
    if (Array.isArray(this.gridHelper.material)) {
      this.gridHelper.material.forEach((material) => material.dispose());
    } else {
      this.gridHelper.material?.dispose();
    }
    this.gridHelper = null;
  }

  // The world-framing overview stands above the weather -- the server puts the
  // lowest cloud a jump above the tallest obstacle (`generateClouds`), which is
  // tens of units where this camera is hundreds -- so the layer sits between
  // the eye and the map it is there to show. Hidden for that one view and for
  // nothing else: a cloud is scenery from underneath, which is where every
  // other camera in the game looks at it from.
  _setCloudsHidden(hidden) {
    if (this.cloudsHiddenForOverview === hidden) return;
    this.cloudsHiddenForOverview = hidden;
    this.clouds.forEach((cloud) => { cloud.visible = !hidden; });
    if (this.cloudLayer) this.cloudLayer.visible = !hidden;
  }

  // Where a camera has to stand to hold the whole world in frame, and what it
  // should be looking at: the answer the entry dialog's backdrop and the map
  // picker's preview both want, since neither has a tank to frame instead
  // (issue #107).
  //
  // Tilted rather than straight down, for two reasons. The radar already draws
  // this map from directly above, with every tank on it and three zooms to pick
  // from -- a flat overview would be a worse radar that took the whole screen.
  // What the radar cannot show is height, which is most of what a bzo map is:
  // pyramids, stacked boxes, a tank on a roof.
  //
  // The distance is found by fitting the world's four ground corners inside the
  // frustum rather than by a formula, because a tilted camera has no single
  // one: the near edge of the map is a fraction of the far edge's distance away
  // and subtends far more, so the closed form that works looking straight down
  // overflows the bottom of the frame as soon as the camera leans. Bisection
  // over the distance is exact, and cheap enough at once per map and aspect --
  // which is also why the answer is cached, since neither changes per frame.
  //
  // Both axes matter and they do not ask for the same thing. bzo fixes the
  // *horizontal* field of view at BZFlag's 60 degrees and derives the vertical
  // from the aspect (`_getVerticalFovForAspect`), so the vertical narrows as a
  // screen widens -- and depth is the axis a view from above spends most of. A
  // 16:9 desktop is bound by the vertical, a phone held in portrait by the
  // horizontal.
  _frameWorldCamera({ margin = 1.06, pitchDegrees = 52 } = {}) {
    const mapSize = this._inferMapSizeFromGround();
    const aspect = this.camera?.aspect > 0 ? this.camera.aspect : (16 / 9);
    const cacheKey = `${mapSize}:${aspect.toFixed(4)}:${margin}:${pitchDegrees}`;
    if (this.worldFramingCache?.key === cacheKey) return this.worldFramingCache.value;

    const half = (mapSize * margin) / 2;
    const tanHalfH = Math.tan(THREE.MathUtils.degToRad(BZFlag_DEFAULT_HORIZONTAL_FOV) / 2);
    const tanHalfV = Math.tan(THREE.MathUtils.degToRad(this._getVerticalFovForAspect(aspect)) / 2);
    const pitch = THREE.MathUtils.degToRad(pitchDegrees);
    const sinPitch = Math.sin(pitch);
    const cosPitch = Math.cos(pitch);

    // The camera sits south of the middle and looks at it, so the map is
    // oriented the way the compass and the radar already read it: north away.
    // Its own axes, for putting a world point in front of it -- forward is the
    // way it looks, up is perpendicular to that in the same vertical plane.
    const fits = (distance) => {
      const eyeHeight = distance * sinPitch;
      const eyeSouth = distance * cosPitch;
      for (const cornerX of [-half, half]) {
        for (const cornerY of [-half, half]) {
          const dx = cornerX;
          const dy = cornerY + eyeSouth;
          const dz = -eyeHeight;
          // Depth along the view direction (0, cos, -sin), and height along
          // the camera's own up (0, sin, cos).
          const depth = (dy * cosPitch) + (dz * -sinPitch);
          if (depth <= 0) return false;
          const up = (dy * sinPitch) + (dz * cosPitch);
          if (Math.abs(dx) > depth * tanHalfH) return false;
          if (Math.abs(up) > depth * tanHalfV) return false;
        }
      }
      return true;
    };

    let low = 1;
    let high = Math.max(mapSize * 8, 64);
    if (!fits(high)) high = mapSize * 40;
    for (let i = 0; i < 40; i += 1) {
      const mid = (low + high) / 2;
      if (fits(mid)) high = mid; else low = mid;
    }
    const distance = high;
    const value = {
      eye: new THREE.Vector3(0, 0 - (distance * cosPitch), distance * sinPitch),
      look: new THREE.Vector3(0, 0, 0),
    };
    this.worldFramingCache = { key: cacheKey, value };
    return value;
  }

  _inferMapSizeFromGround() {
    if (Number.isFinite(this.groundMapSize) && this.groundMapSize > 0) {
      return this.groundMapSize;
    }
    return 100;
  }

  // SceneRenderer::setInvert (playing.cxx:6214), which despite the name is not a
  // colour inversion of the view: BackgroundRenderer keeps a second set of
  // ground gstates and colours built from `zoneGroundTexture` and swaps to them
  // (BackgroundRenderer.cxx:330). So being zoned changes the ground under you
  // and nothing else, which is the whole of upstream's zoned screen effect --
  // and it is the one form of it that means anything in a headset, where there
  // is no screen to post-process.
  //
  // One mesh, one material, one map swapped: the geometry, the lighting and the
  // shadow overlay are untouched, so this costs nothing on a frame that does not
  // change it.
  setZoneGround(zoned) {
    if (!this.ground) return;
    const wanted = zoned === true;
    if (this._zoneGroundActive === wanted) return;
    this._zoneGroundActive = wanted;
    if (wanted && !this._zoneGroundTexture) {
      this._zoneGroundTexture = createZoneGroundTexture();
      this._zoneGroundTexture.wrapS = THREE.RepeatWrapping;
      this._zoneGroundTexture.wrapT = THREE.RepeatWrapping;
    }
    const texture = wanted ? this._zoneGroundTexture : this._groundTexture;
    if (!texture) return;
    this.ground.material.map = texture;
    this.ground.material.needsUpdate = true;
  }

  setGroundGridEnabled(enabled, mapSize = null) {
    this.showGroundGrid = !!enabled;
    if (!this.scene || !this.worldFrame) return;

    if (!this.showGroundGrid) {
      this._disposeGroundGrid();
      return;
    }

    if (this.gridHelper) {
      return;
    }

    const resolvedMapSize = Number.isFinite(mapSize) && mapSize > 0
      ? mapSize
      : this._inferMapSizeFromGround();
    const grid = this._buildGroundGrid(resolvedMapSize);
    if (!grid) return;
    this.gridHelper = grid;
    this.worldFrame.add(this._tagDraws(grid, 'scenery'));
  }

  // Every shadow in the frame shares one projection, so the traversal and the
  // inverse are done once for the pass rather than once per shadow. Nothing is
  // gated on the light having moved: a matrix costs the same whether it changed
  // or not, where re-walking every obstacle's vertices did not -- and gating on
  // that made the cost rise as the frame rate fell, which is a hole a slow
  // machine could not climb out of.
  // A matrix composed for every node in the world, visible or not, shadow
  // caster or not: it scales with how much is in the world rather than with how
  // much of it moves. The shadow pass needs it done before it projects
  // anything, but it is not the shadow pass's cost -- with `?shadows=0` the
  // same walk still happens, inside Three's own render, where it lands in
  // `draw` and stops being comparable with the mode beside it. Doing it here,
  // in every mode, is what keeps a phase meaning the same thing whatever else
  // is turned off.
  updateWorldMatrices() {
    if (!this.worldGroup) return;
    this.worldGroup.updateMatrixWorld(true);
    markFramePhase('matrix');
  }

  // Upstream's near planes (`playing.cxx:175-176`): 1, or 0.25 from inside a
  // tank whose own hull is drawn. Depth precision at range goes as the near
  // plane, so a smaller one loses layers a hair apart -- a map's ground
  // sheets stacked 0.01 high flicker into each other a few hundred units out.
  // XR keeps 0.1, for the panels and hands within a metre of the eyes.
  _setNearPlane(insideTank) {
    let near = insideTank ? CAMERA_NEAR_INSIDE_TANK : CAMERA_NEAR;
    if (xrState.enabled) near = CAMERA_NEAR_XR;
    if (this.camera.near === near) return;
    this.camera.near = near;
    this.camera.updateProjectionMatrix();
  }

  getScene() {
    return this.scene;
  }

  // SceneRenderer::setBlank (playing.cxx:6212), which upstream turns on for a
  // paused tank and for Blindness. Everything the game draws hangs off
  // `worldGroup`, and every HUD panel hangs off the camera, so hiding the one
  // blanks the view and leaves the instruments -- on the flat canvas and in XR
  // alike, from a single switch. The sky goes with it: a blinded tank should not
  // be able to read the time of day off the horizon.
  setBlank(blank) {
    const blanked = blank === true;
    if (this._blanked === blanked) return;
    this._blanked = blanked;
    if (this.worldGroup) this.worldGroup.visible = !blanked;
    if (this.scene) {
      if (blanked) {
        this._sceneBackground = this.scene.background;
        this.scene.background = new THREE.Color(0x000000);
      } else if (this._sceneBackground !== undefined) {
        this.scene.background = this._sceneBackground;
        this._sceneBackground = undefined;
      }
    }
  }

  isBlanked() {
    return this._blanked === true;
  }

  // SceneRenderer::renderDimming's teleporterProximity branch (SceneRenderer.cxx
  // :1145): a full-view yellow wash, graded by how close the tank is to a
  // teleporter's opening (`blindnessColor`, upstream's own name for this yellow,
  // despite having nothing to do with the Blindness flag above). Parented to the
  // camera instead of drawn as a 2D screen overlay, so it renders correctly per
  // eye in a headset too.
  setTeleporterProximity(proximity) {
    if (!this.camera) return;
    const density = proximity > 0.75 ? 1 : proximity / 0.75;
    if (density <= 0) {
      if (this._teleporterFlash) this._teleporterFlash.visible = false;
      return;
    }
    if (!this._teleporterFlash) {
      const geometry = new THREE.PlaneGeometry(200, 200);
      const material = new THREE.MeshBasicMaterial({
        color: 0xffff00,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(0, 0, -2);
      mesh.renderOrder = TELEPORTER_DIMMING_RENDER_ORDER;
      mesh.frustumCulled = false;
      this.camera.add(mesh);
      this._teleporterFlash = mesh;
    }
    this._teleporterFlash.visible = true;
    this._teleporterFlash.material.opacity = density;
  }

  getWorldFrame() {
    return this.worldFrame;
  }

  getCamera() {
    return this.camera;
  }

  getRenderer() {
    return this.renderer;
  }

  setAnimationLoop(callback) {
    if (!this.renderer || typeof this.renderer.setAnimationLoop !== 'function') {
      return false;
    }

    this.renderer.setAnimationLoop(callback);
    return true;
  }

  // Three's own pixel ratio is the scale: it sizes the buffer to
  // window * ratio and the element to the window, which is exactly the split
  // wanted here. Doing it by hand, sizing the buffer and the element
  // separately, left the element at the buffer's size on the machine this was
  // built to measure.
  _applyRendererSize(viewport) {
    this.renderer.setPixelRatio(this.renderScale);
    this.renderer.setSize(viewport.width, viewport.height);
  }

  handleResize() {
    if (!this.camera || !this.renderer) return;
    const viewport = this._getViewportSize();
    this.camera.aspect = viewport.width / viewport.height;
    this.camera.fov = this._getVerticalFovForAspect(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this._applyRendererSize(viewport);
    if (this.anaglyphEffect) {
      this.anaglyphEffect.setSize(viewport.width, viewport.height);
    }
  }

  renderFrame() {
    if (!this.renderer || !this.scene || !this.camera) return;

    this.renderer.info.reset();
    this.updateGroundCenter();
    this._updateTeleporterVisuals(performance.now() * 0.001);
    // `Date.now()`, not `performance.now()` -- a wall clock every connected
    // browser shares (modulo each machine's own clock skew), matching
    // upstream's own `GameTime::getStepTime()` (`GameTime.cxx:194-224`) --
    // every client evaluates a shared `dynamicColor`/`textureMatrix` at the
    // same phase at the same real moment, the way a cycling billboard sign
    // reads the same picture on every screen watching it.
    this._updateAnimatedMaterials(Date.now() * 0.001);
    this._updateMeshSpins(Date.now() * 0.001);
    this._followSky();

    if (this.projectileLights) {
      for (const [projectile, light] of this.projectileLights.entries()) {
        if (projectile && light) {
          light.position.copy(projectile.position);
        }
      }
    }

    // Which effects the scene's lights stand for this frame, decided after the
    // shots have moved and before anything reads them.
    this._applyDynamicLightPool();
    // After the lights have been moved, so a receiver never trails its shot.
    this.updateGroundReceivers();
    // The ground patch, the teleporters and the receivers all rebuild geometry
    // on the CPU every frame, before a single triangle is submitted. Reported
    // apart from the draw so a frame spent building is not read as a frame
    // spent drawing.
    markFramePhase('worldfx');

    if (this.anaglyphEnabled && this.anaglyphEffect) {
      this.anaglyphEffect.render(this.scene, this.camera);
    } else {
      // In XR mode, Three.js handles stereo automatically when we call renderer.render()
      this.renderer.render(this.scene, this.camera);
    }

    // Read after the draw, which is where a program that was missing from the
    // cache would have been compiled.
    noteProgramCount(this.renderer.info.programs?.length ?? 0);
  }

  setAnaglyphEnabled(enabled) {
    this.anaglyphEnabled = !!enabled;
  }

  getAnaglyphEnabled() {
    return this.anaglyphEnabled;
  }

  // three.js's own world, where the camera and a headset's pose live, is Y-up;
  // the game's frame is `worldFrame`. Every view is worked out in the game's
  // frame, and crosses here, by `worldFrame`'s own turn, to be applied.
  _toThree(p, target = new THREE.Vector3()) {
    return target.set(p.x, p.y, p.z).applyQuaternion(this.worldFrame.quaternion);
  }

  // Aims the camera from `eye` at `look`, both in the game's frame, with the
  // game's up as the camera's.
  _aimCamera(eye, look) {
    this.worldGroup.position.set(0, 0, 0);
    this.worldGroup.quaternion.identity();
    this._toThree(eye, this.camera.position);
    this._toThree(GAME_UP, this.camera.up);
    this.camera.lookAt(this._toThree(look, CAMERA_LOOK_SCRATCH));
  }

  // In a session the headset owns the camera, so the world moves instead: the
  // game's point `eye` is put at the rig's origin, `drop` below it, turned so
  // that `azimuth` is the way the rig faces. Only the heading is taken:
  // tilting the world tilts the horizon, which is the nausea case, and the
  // head already looks around.
  _placeWorldAroundEye(eye, azimuth, drop = 0) {
    const q = this.worldGroup.quaternion.setFromAxisAngle(THREE_UP, (Math.PI / 2) - azimuth);
    const at = this._toThree(eye, CAMERA_EYE_SCRATCH).applyQuaternion(q);
    this.worldGroup.position.set(0 - at.x, 0 - at.y - drop, 0 - at.z);
  }

  updateCamera({ cameraMode, myTank, azimuth, deathFollowTarget, roamFraming, roamInsideTank = false }) {
    const heading = azimuth || 0;
    if (this.camera) {
      this._setNearPlane(cameraMode === 'first-person' || (cameraMode === 'roam' && roamInsideTank));
    }
    // Cleared here rather than in each branch that is not the world overview,
    // so a camera that never thinks about clouds cannot leave them hidden. The
    // one branch that wants them gone sets it again below.
    this._setCloudsHidden(false);
    if (!this.camera) return;
    // Every roaming view resolves to an eye and a look point in client.js, so
    // the rigs stay with the game state and this only has to apply one.
    if (cameraMode === 'roam') {
      if (!roamFraming) return;
      const { eye, look } = roamFraming;
      if (xrState.enabled) {
        // In XR the world moves and the camera does not, as in first person.
        this._placeWorldAroundEye(eye, Math.atan2(look.y - eye.y, look.x - eye.x));
        return;
      }
      this._aimCamera(eye, look);
      return;
    }
    // Watching your own tank come apart. Its own mode rather than a second
    // meaning for Overview: while the two shared one, dying had to overwrite
    // `cameraMode` and the restore on respawn could not tell a player who had
    // *chosen* Overview from one who had been put there by dying, so it bailed
    // to first person and a player in Overview never got their view back
    // (issue #107). Nothing overwrites `cameraMode` now -- the death camera is
    // asked for while `deathFollowTarget` is set and stops being asked for when
    // it clears, and whatever the player had chosen is still there underneath.
    if (cameraMode === 'death') {
      const target = deathFollowTarget || this.deathFollowTarget;
      // The debris stands in `worldFrame`, so its position is the game's.
      const focusPoint = target && target.parent
        ? target.position.clone()
        : this.deathFollowAnchor;
      if (target && target.parent) {
        this.deathFollowAnchor = target.position.clone();
      }
      // No body to watch -- it has been cleaned up, or there never was one.
      // Leave the camera wherever it is rather than throwing it somewhere: the
      // respawn is a frame or two away and will place it.
      if (!focusPoint) return;
      const velocity = target && target.parent ? (target.velocity || new THREE.Vector3()) : new THREE.Vector3();
      if (xrState.enabled) {
        // A headset player watches from where they died, and the world does
        // not move at all: it is left exactly where first person put it,
        // which is the spot the tank was standing on, and the explosion
        // happens around the player.
        //
        // The chase below is bzo's own -- upstream has no death camera, the
        // view simply stays where the tank was -- and what it chases is the
        // body, a piece of debris with its own velocity that tumbles and
        // bounces across the map. Turning that into world motion is precisely
        // the movement a session must never make: the player is swung after
        // something that is itself being thrown. On a monitor it reads as a
        // camera; on a head it reads as being thrown too.
        return;
      }
      const followOffset = velocity.lengthSq() > 0.1
        ? velocity.clone().normalize().multiplyScalar(-20).add(new THREE.Vector3(0, 0, 10))
        : new THREE.Vector3(0, -22, 10);
      const desiredPosition = focusPoint.clone().add(followOffset);
      if (!this.deathCameraLogged) {
        const dl = window.gameDebugLog;
        if (dl) {
          dl(`deathCam lookAt=${focusPoint.x.toFixed(1)},${focusPoint.y.toFixed(1)},${focusPoint.z.toFixed(1)} camPos=${desiredPosition.x.toFixed(1)},${desiredPosition.y.toFixed(1)},${desiredPosition.z.toFixed(1)} debrisVel=${velocity.x.toFixed(1)},${velocity.y.toFixed(1)},${velocity.z.toFixed(1)}`, 'render');
        }
        this.deathCameraLogged = true;
      }
      const eye = this.getCameraPosition() || desiredPosition;
      this._aimCamera(eye.lerp(desiredPosition, 0.045), focusPoint);
      return;
    }

    if (cameraMode === 'overview') {
      this.deathFollowTarget = null;
      this.deathFollowAnchor = null;
      this.deathCameraLogged = false;
      // Nothing to frame but the world itself: the entry dialog's backdrop, the
      // map picker's preview, and the player's own third camera mode, which is
      // what `_frameWorldCamera` is for. It used to be `(0, 15, 20)` looking at
      // the origin, which was fifteen units up and twenty back whatever the map
      // -- one building's worth of a 280-unit world and a patch of grass on an
      // 800-unit one (issue #107).
      //
      // Left alone in a headset, where moving the camera does nothing anyway:
      // bzo moves `worldGroup` and not the camera in a session, because the
      // pose owns the camera. The right XR answer is not this view at altitude
      // but the world on a tabletop in AR, which is its own piece of work --
      // and this view at least does not move, so a headset sitting where the
      // session put it is looking at the map rather than being flown over it.
      if (!xrState.enabled) {
        this._setCloudsHidden(true);
        const { eye, look } = this._frameWorldCamera();
        this._aimCamera(eye, look);
      } else {
        this.worldGroup.position.set(0, 0, 0);
        this.worldGroup.quaternion.identity();
      }
      return;
    }

    if (!myTank) return;
    const tankAt = myTank.position;
    const forwardX = Math.cos(heading);
    const forwardY = Math.sin(heading);
    if (cameraMode === 'first-person') {
      if (xrState.enabled) {
        // In XR mode, keep tank visible and position camera above it
        if (myTank.userData.body) myTank.userData.body.visible = true;
        // The ground slightly below eye height.
        this._placeWorldAroundEye(tankAt, tankAzimuth(myTank), 0.6);
      } else {
        // The hull stays, as in BZFlag. The turret and barrel are client.js's
        // cockpit rule, which covers an observer's ride too.
        if (myTank.userData.body) myTank.userData.body.visible = true;
        const cameraHeight = Number.isFinite(myTank.userData.cameraHeight)
          ? myTank.userData.cameraHeight
          : TANK.muzzleHeight;
        const eye = CAMERA_EYE_SCRATCH.set(tankAt.x, tankAt.y, tankAt.z + cameraHeight);
        this._aimCamera(eye, CAMERA_TARGET_SCRATCH.set(
          tankAt.x + (forwardX * 10),
          tankAt.y + (forwardY * 10),
          tankAt.z + cameraHeight,
        ));
      }
    } else {
      if (myTank.userData.body) myTank.userData.body.visible = true;
      // Behind and above the tank, nearer on a narrow screen.
      const chase = this.getChaseScale();
      const eye = CAMERA_EYE_SCRATCH.set(
        tankAt.x - (forwardX * THIRD_PERSON_DISTANCE * chase),
        tankAt.y - (forwardY * THIRD_PERSON_DISTANCE * chase),
        tankAt.z + (THIRD_PERSON_HEIGHT * chase),
      );
      if (xrState.enabled) {
        // The headset owns the camera, so the world moves instead -- the same
        // rule first person and roaming follow. What differs is only the eye
        // point: the chase position rather than the tank itself. It is rebuilt
        // from the tank's current position every frame, which is what was
        // missing; without it the world kept whatever offset first person last
        // set and the tank simply drove out of the shot.
        //
        // The heading is taken as well as the position, so forward is the same
        // direction it is in first person. Height lands the chase point on the
        // XR floor, so a standing player's own height sits on top of it exactly
        // as it does in first person -- THIRD_PERSON_HEIGHT is the number to
        // tune if the view rides too high.
        this._placeWorldAroundEye(eye, heading);
        return;
      }
      // Ten ahead of the tank, three up -- or higher on a tall screen, by the
      // tilt that brings the bottom of the view up to the tank's rear.
      const behind = THIRD_PERSON_DISTANCE * chase;
      const eyeHeight = THIRD_PERSON_HEIGHT * chase;
      const reach = behind + 10;
      let aimZ = tankAt.z + 3;
      const halfView = THREE.MathUtils.degToRad(this._getVerticalFovForAspect(this.camera.aspect) / 2);
      const toRear = Math.atan2(eyeHeight, Math.max(1, behind - CHASE_TANK_REAR));
      const tilt = halfView - toRear - THREE.MathUtils.degToRad(CHASE_TILT_MARGIN_DEGREES);
      const level = Math.atan2((tankAt.z + 3) - (tankAt.z + eyeHeight), reach);
      if (tilt > level) aimZ = tankAt.z + eyeHeight + (Math.tan(tilt) * reach);
      this._aimCamera(eye, CAMERA_TARGET_SCRATCH.set(
        tankAt.x + (forwardX * 10),
        tankAt.y + (forwardY * 10),
        aimZ,
      ));
    }
  }

  // Where the local view actually is right now, for `updateInsideBuildings`'s
  // own OO/PZ check (#77 -- "the OO effect is whenever a camera is inside an
  // object", not only whenever the tank's own hitbox is): third person and an
  // observer's follow-leader view both put the rendered eye somewhere other
  // than the tank/observer's own logical position, with no wall-avoidance of
  // its own, so a chase camera can sit inside a wall's solid well before
  // anything tracking the tank's own body would say so.
  //
  // Null in XR: `updateCamera`'s own XR branches move `worldGroup` around a
  // stationary rig instead of moving `this.camera` through a static world
  // (see the `xrState.enabled` branches above), so `this.camera.position`
  // there is a rig-local constant, not a world one -- answering from it would
  // just be wrong. Nothing upstream of this depends on the answer never being
  // null; XR keeps exactly the tank-body-only behaviour it already had.
  // The death camera's start, above and behind where the tank was, and the
  // point it follows from: `at` is upstream's.
  startDeathCamera(at) {
    if (!this.camera) return;
    this._aimCamera(new THREE.Vector3(at.x, at.y - 22, at.z + 10), at);
  }

  // Where the death camera looks from when it has no debris to follow.
  setDeathFollowAnchor(at) {
    this.deathFollowAnchor = at ? new THREE.Vector3(at.x, at.y, at.z) : null;
  }

  // In the game's frame. Outside a session the world groups sit still, so the
  // camera's position is `worldFrame`'s turn of it.
  getCameraPosition() {
    if (!this.camera || xrState.enabled) return null;
    return this.camera.position.clone().applyQuaternion(
      CAMERA_FRAME_SCRATCH.copy(this.worldFrame.quaternion).invert(),
    );
  }

}

// The methods of each subsystem, kept in a module of their own.
for (const methods of [SkyRendering, LightingRendering, WorldRendering, TankRendering, EffectsRendering, FlagRendering]) {
  for (const name of Object.getOwnPropertyNames(methods.prototype)) {
    if (name !== 'constructor') {
      Object.defineProperty(RenderManager.prototype, name, Object.getOwnPropertyDescriptor(methods.prototype, name));
    }
  }
}

export const renderManager = new RenderManager();
