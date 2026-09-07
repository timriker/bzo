/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { AnaglyphEffect } from './anaglyph.js';
import { xrState } from './webxr.js';
import { markFramePhase, noteProgramCount } from './perf.js';
import {
  collectDeviceHints,
  detectRenderCapabilities,
  supportsDynamicLighting,
  supportsProjectedShadows,
} from './capabilities.mjs';
import {
  GAME_SOUNDS,
  GAME_SOUND_NAMES,
  MASTER_VOLUME,
  SOUND_DISTANCE_MODEL,
  SOUND_REF_DISTANCE,
  SOUND_ROLLOFF_FACTOR,
  getSoundPath,
  loadAudioBuffer,
} from './audio.js';
import { WORLD_WALL_HEIGHT } from './collision.mjs';
import {
  getPlayerTeamColor,
  getTeamFromColorIndex,
} from './teams.mjs';
import {
  FLAG_POLE_SIZE,
  FLAG_POLE_WIDTH,
  SUPER_FLAG_COLOR,
} from './flags.mjs';
import {
  DEFAULT_VOLUME_LEVEL,
  clampVolumeLevel,
  volumeLevelToGain,
} from './volume.mjs';
import {
  createBoundaryTexture,
  createBoxWallTexture,
  createBaseTopTexture,
  createBaseWallTexture,
  getBaseTeamTint,
  createPyramidTexture,
  createRoofTexture,
  createTeleporterBorderTexture,
  createTeleporterPortalTexture,
  createGroundTexture,
} from './texture.js';

const DEFAULT_MUZZLE_FORWARD = 3.0;
// BZDB_MUZZLEHEIGHT. Also the floor the roaming camera rests on, so an observer
// sits at the eye height of a tank on the ground.
export const DEFAULT_MUZZLE_HEIGHT = 1.57;
const MUZZLE_TIP_EPSILON = 0.03;
const BZFlag_DEFAULT_HORIZONTAL_FOV = 60;
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
const TANK_WHEEL_PREFIX_ALIASES = {
  left: ['leftWheel', 'wheel_left'],
  right: ['rightWheel', 'wheel_right'],
};

const TANK_WHEEL_OUTWARD_NUDGE = 0.02;
const MOUNTAIN_TEXTURE_PATHS = [
  '/textures/mountain1.png',
  '/textures/mountain2.png',
  '/textures/mountain3.png',
  '/textures/mountain4.png',
  '/textures/mountain5.png',
];
const BZFLAG_MOUNTAIN_FACE_COUNT = 16;
const BZFLAG_NIGHT_ELEVATION = -0.25;
const BZFLAG_DUSK_ELEVATION = -0.17;
const BZFLAG_TWILIGHT_ELEVATION = -0.087;
const BZFLAG_DAWN_ELEVATION = 0.0;
const BZFLAG_DAY_ELEVATION = 0.087;
const BZFLAG_FLASH_TEXTURE = '/textures/blend_flash.png';
const SHOT_EXPLOSION_TEXTURES = [
  '/textures/explode1.png',
  '/textures/explode2.png',
];
const BZFLAG_TANK_LENGTH = 6.0;
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
// Upstream offsets are BZFlag tank-local (+X forward, +Y left, +Z up). bzo tank
// models are BZFlag-sized but face -Z with +Y up, so bzf(x,y,z) -> bzo(-y,z,-x).
const BZFLAG_JUMPJET_TEXTURE = '/textures/jumpjets.png';
const BZFLAG_JUMPJET_OFFSETS = [
  { x: +0.6, y: 0.25, z: +1.5 },
  { x: -0.6, y: 0.25, z: +1.5 },
  { x: +0.6, y: 0.25, z: -1.5 },
  { x: -0.6, y: 0.25, z: -1.5 },
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
// Flags, mirroring FlagSceneNode (FlagSceneNode.cxx) at upstream's default
// quality, where `geoPole` is on and `realFlag` is off: pole and cloth are one
// billboarded pair facing the camera, and the cloth is a strip of eight quads
// rippling on two out-of-phase waves. Because the cloth is billboarded at that
// quality upstream's wind only turns a flag nobody can see turning, so bzo has
// no wind at all -- see AGENTS.md on implementing the default variant.
const BZFLAG_FLAG_TEXTURE = '/textures/flag.png';
const BZFLAG_FLAG_UNIT = 0.8;                              // Unit
const BZFLAG_FLAG_WIDTH = 1.5 * BZFLAG_FLAG_UNIT;          // Width
const BZFLAG_FLAG_HEIGHT = BZFLAG_FLAG_UNIT;               // Height
const BZFLAG_FLAG_CHUNKS = 8;                              // flagChunks
const BZFLAG_FLAG_WAVE_SETS = 8;                           // waveLists
const BZFLAG_FLAG_RIPPLE_SPEED_1 = 2.4 * Math.PI;          // RippleSpeed1
const BZFLAG_FLAG_RIPPLE_SPEED_2 = 1.724 * Math.PI;        // RippleSpeed2
const BZFLAG_FLAG_RIPPLE_PHASE = 1.16 * Math.PI;           // sinRipple2S offset
const BZFLAG_FLAG_RIPPLE_LAG = 0.28 * Math.PI;             // angle2 offset
const BZFLAG_FLAG_RIPPLE_TURNS = 4 * Math.PI;              // angle1 slope
const BZFLAG_FLAG_RIPPLE_DAMP = 0.1;                       // damp
// setAlphaFunc(GL_GEQUAL, 0.9) in notifyStyleChange: an ordinary flag is opaque
// geometry with the cloth's own shape cut out of it by the texture's alpha, and
// only a flag whose colour is fading turns blending on.
const BZFLAG_FLAG_ALPHA_THRESHOLD = 0.9;
// Flags are drawn after the world, and an opaque one occludes whatever is
// behind it rather than blending with it.
const FLAG_RENDER_ORDER = 5;
// Shots ride over the flags they pass, and their explosions over the shots.
const SHOT_RENDER_ORDER = 16;
const SHOT_EXPLOSION_RENDER_ORDER = 17;
// The warp a flag arrives and leaves through, from FlagWarpSceneNode.cxx:28.
// Seven horizontal twelve-sided discs in a fixed rainbow at half alpha, each
// one step smaller than the last and a hair further along the stack.
const BZFLAG_FLAG_WARP_SIZE = 7.5;
const BZFLAG_FLAG_WARP_ALPHA = 0.5;
const BZFLAG_FLAG_WARP_SEGMENTS = 12;
const BZFLAG_FLAG_WARP_STEP = 0.05;
const BZFLAG_FLAG_WARP_SPACING = 0.01;
const BZFLAG_FLAG_WARP_WOBBLE_MIN = 0.9;
const BZFLAG_FLAG_WARP_WOBBLE_RANGE = 0.2;
const BZFLAG_FLAG_WARP_COLORS = [
  0x40ff40, 0x4040ff, 0xff00ff, 0xff4040, 0xff8000, 0xffff00, 0xffffff,
];
const BZFLAG_SHOT_EXPLOSION_SIZE = 1.2 * BZFLAG_TANK_LENGTH;
const BZFLAG_SHOT_EXPLOSION_DURATION = 0.8;
const BZFLAG_SHOT_EXPLOSION_LIGHT_FADE_START_RATIO = 0.7;
const PROJECTED_SHADOW_MIN_LIGHT_Y = 0.05;
const PROJECTED_SHADOW_STENCIL_REF = 1;
// Write the stencil before the darkening overlay pass reads it.
const PROJECTED_SHADOW_RENDER_ORDER = 10;
const PROJECTED_SHADOW_DARKEN_OPACITY = 0.35;
const PROJECTED_SHADOW_CASTER_Y = 0.01;
// Height above the tallest obstacle that a shadow caster can still reach, for
// airborne tanks. Sizes the darkening pass, not the shadows themselves.
const PROJECTED_SHADOW_CASTER_HEADROOM = 20;
const PROJECTED_SHADOW_OVERLAY_Y = 0.03;
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

const GROUND_GRID_Y = 0.02;
// How big the sun and moon look and how far away they sit, from
// makeCelestialLists (BackgroundRenderer.cxx:1706 for the sun, :483 for the
// moon): both are discs at twice the world size, sized by the angle they should
// subtend rather than by a fixed radius, which is what makes them read as the
// sun and the moon instead of as two small spheres parked in the distance.
// These are upstream's expressions with the distance factored out, so they are
// radius per unit of distance.
//
// Only the size and distance come from upstream. Where they are in the sky does
// not: upstream computes real positions from a Julian day and a latitude, while
// bzo sweeps a Minecraft clock through a fixed arc with the moon opposite the
// sun. See AGENTS.md.
const BZFLAG_CELESTIAL_DISTANCE_SCALE = 2.0;
const BZFLAG_SUN_ANGULAR_RADIUS = Math.atan(Math.PI / 3) / 60;
const BZFLAG_MOON_ANGULAR_RADIUS = Math.atan(Math.PI / 180);
// Before everything else in the world, as upstream draws the sky first.
const CELESTIAL_RENDER_ORDER = -1000;
// The glow is bzo's, and rides just outside the sun's disc.
const CELESTIAL_GLOW_RATIO = 1.5;
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
const BOX_TEXTURE_SCALES = { sideScale: 8, capScale: 2 };
// BoxGeometry emits its faces in this order, four vertices and six indices each,
// which is what _prepareBoxGeometry's loops count on.
const BOX_FACE = Object.freeze({ PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 });
// The same, for a pyramid's slanted sides and its base.
const PYRAMID_TEXTURE_SCALE = 8;
const PYRAMID_ROOF_TEXTURE_SCALE = 2;
const GROUND_CENTER_SIZE = 128; // upstream centerSize
const GROUND_TEX_REPEAT = 0.05; // upstream groundHighResTexRepeat (defaultBZDB.cxx:82)
// Upstream's five triangle strips over the four outer and four centre corners.
const GROUND_EYE_SCRATCH = new THREE.Vector3();
const ROAM_FORWARD_SCRATCH = new THREE.Vector3();
const FLAG_BILLBOARD_SCRATCH = new THREE.Vector3();
const FLAG_BILLBOARD_QUATERNION = new THREE.Quaternion();
// One flag's place in the batch, written and handed over once per flag per
// frame rather than allocated per flag.
const FLAG_INSTANCE_MATRIX = new THREE.Matrix4();
const FLAG_INSTANCE_COLOR = new THREE.Color();
// The chase camera's offset from the tank it follows: this far behind along the
// tank's heading, this far above it. One pair for both paths, because a desktop
// third-person view and an XR one that framed the tank differently would be two
// different views under one name.
const THIRD_PERSON_DISTANCE = 12;
const THIRD_PERSON_HEIGHT = 4;
const GROUND_STRIPS = [
  [4, 5, 7, 6],
  [0, 1, 4, 5],
  [1, 2, 5, 6],
  [2, 3, 6, 7],
  [3, 0, 7, 4],
];
// First in the transparent pass, before the flags, shots and explosions that
// blend over the world without writing depth. Those cannot depth-reject a grid
// line standing behind them, so the grid has to be underneath them in draw
// order instead.
const GROUND_GRID_RENDER_ORDER = 1;
// Ground light receivers, mirroring BackgroundRenderer::drawGroundReceivers
// (BackgroundRenderer.cxx:1312): a small additive fan on the ground under every
// dynamic light, its falloff computed per vertex on the CPU rather than by a
// shader. Upstream draws these alongside the real lights, not instead of them,
// so bzo does too -- both are derived from the same attenuation below, which is
// what keeps the pair in the same proportion here as upstream has it. The fan
// reaches 19.2 units and the light itself carries further.
const GROUND_RECEIVER_RINGS = 4;              // receiverRings
const GROUND_RECEIVER_SLICES = 8;             // receiverSlices
const GROUND_RECEIVER_RING_SIZE = 1.2;        // receiverRingSize, in meters
const GROUND_RECEIVER_MIN_LUMINANCE = 0.02;   // draw(): (I * maxVal) < 0.02f
const GROUND_RECEIVER_SUN_DIMMING = 0.6;      // draw(): B = 1 - 0.6 * sunBrightness
// Above the shadow darkening pass, so a shot lights ground it has just darkened.
const GROUND_RECEIVER_Y = 0.04;
const GROUND_RECEIVER_RENDER_ORDER = 21;

// BZFlag gives every dynamic light the same falloff, 1/(c + l*d + q*d*d) --
// bolts (BoltSceneNode.cxx:52-55), jump jets (TankSceneNode.cxx:75-83) and
// explosions (playing.cxx:3637) alike -- and varies only the colour it feeds in.
// Three's punctual lights are intensity/d*d instead, so past about a metre and a
// half the two curves agree when intensity is upstream's colour scale divided by
// the quadratic term. Closer in upstream flattens at 1/c where Three keeps
// climbing, and both are far past white either way.
// Constant, linear, quadratic; shared with the ground receiver pass.
const BZFLAG_LIGHT_ATTENUATION = [0.05, 0.0, 0.03];
// maxDist, the radius upstream culls a light at (OpenGLLight.cxx:40). Its own
// cutoff equation puts one of these lights at 2% around 41 units, so nothing
// worth seeing is lost by stopping there. Three's cutoff eases the last stretch
// to zero rather than clipping it.
const BZFLAG_LIGHT_MAX_DISTANCE = 50;
const BZFLAG_LIGHT_DECAY = 2;
// SceneRenderer.cxx:1275. Upstream ranks the lights it has been offered and
// keeps the first `maxLights` of them -- GL_MAX_LIGHTS less the one reserved
// for the sun or the moon, so seven of them.
//
// bzo needs the cap for a second reason upstream does not have. Three keys its
// shader program cache on how many lights are in the scene, so a light arriving
// or leaving recompiles every material in the world: a firefight took a Quest 2
// from 16 programs to 66 in two minutes, eleven of them inside one second, and
// each compile is a stall on that driver. A pool of a fixed size, always in the
// scene and dimmed to nothing when idle, is a count that never moves.
const BZFLAG_MAX_DYNAMIC_LIGHTS = 7;
const DYNAMIC_LIGHT_EYE = new THREE.Vector3();
const DYNAMIC_LIGHT_FORWARD = new THREE.Vector3();
const DYNAMIC_LIGHT_OFFSET = new THREE.Vector3();
const DYNAMIC_LIGHT_QUATERNION = new THREE.Quaternion();
// The colour scales, which are the only thing that differs between the lights.
const BZFLAG_SHOT_LIGHT_SCALE = 1.5;          // BoltSceneNode.cxx:85
// LaserSceneNode::renderGeoLaser (LaserSceneNode.cxx:178): a bright core inside a
// faint glow, both cylinders the length of the segment. That is upstream's
// untextured laser, and bzo ships no laser texture, so it is the one bzo draws.
const BZFLAG_LASER_LAYERS = Object.freeze([
  Object.freeze([0.0625, 0.85]),
  Object.freeze([0.1, 0.125]),
]);
const BZFLAG_SHOT_IMPACT_LIGHT_SCALE = 1.2;   // playing.cxx:3636, scaled by size/tankLength
const BZFLAG_EXPLOSION_LIGHT_SCALE = 9.6;     // playing.cxx:3654, colour * lightGain
const BZFLAG_JUMPJET_LIGHT_SCALE = 3.0;       // TankSceneNode.cxx:308, (1.5,1,0.5) * 2

// Upstream's colour scale as a Three light intensity, at the shared falloff.
function bzflagLightIntensity(colorScale) {
  return colorScale / BZFLAG_LIGHT_ATTENUATION[2];
}

class RenderManager {
  _getVerticalFovForAspect(aspect) {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : (16 / 9);
    const halfHorizontalRadians = THREE.MathUtils.degToRad(BZFlag_DEFAULT_HORIZONTAL_FOV * 0.5);
    const halfVerticalRadians = Math.atan(Math.tan(halfHorizontalRadians) / safeAspect);
    return THREE.MathUtils.radToDeg(halfVerticalRadians * 2);
  }

  _computeMuzzleFromBarrel(barrel) {
    if (!barrel || !barrel.geometry) {
      return { forward: DEFAULT_MUZZLE_FORWARD, height: DEFAULT_MUZZLE_HEIGHT };
    }

    const position = barrel.geometry.getAttribute('position');
    if (!position || position.count === 0) {
      return { forward: DEFAULT_MUZZLE_FORWARD, height: DEFAULT_MUZZLE_HEIGHT };
    }

    barrel.updateMatrix();
    const transformed = new THREE.Vector3();
    let minZ = Number.POSITIVE_INFINITY;
    const points = [];

    for (let i = 0; i < position.count; i += 1) {
      transformed.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(barrel.matrix);
      points.push({ x: transformed.x, y: transformed.y, z: transformed.z });
      if (transformed.z < minZ) minZ = transformed.z;
    }

    const tipPoints = points.filter((point) => point.z <= (minZ + MUZZLE_TIP_EPSILON));
    if (tipPoints.length === 0) {
      return { forward: DEFAULT_MUZZLE_FORWARD, height: DEFAULT_MUZZLE_HEIGHT };
    }

    const avg = tipPoints.reduce((acc, point) => {
      acc.y += point.y;
      acc.z += point.z;
      return acc;
    }, { y: 0, z: 0 });

    const avgY = avg.y / tipPoints.length;
    const avgZ = avg.z / tipPoints.length;
    const forward = Number.isFinite(avgZ) ? Math.max(0.5, -avgZ) : DEFAULT_MUZZLE_FORWARD;
    const height = Number.isFinite(avgY) ? avgY : DEFAULT_MUZZLE_HEIGHT;

    return { forward, height };
  }

  _setTankMuzzleData(tankGroup, barrel) {
    const muzzle = this._computeMuzzleFromBarrel(barrel);
    tankGroup.userData.muzzleForward = muzzle.forward;
    tankGroup.userData.muzzleHeight = muzzle.height;
    tankGroup.userData.cameraHeight = muzzle.height;
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

  _applyFogConfig(gameConfig = null) {
    if (!this.scene) return;

    const fogMode = typeof gameConfig?.FOG_MODE === 'string' ? gameConfig.FOG_MODE.toLowerCase() : 'none';
    const fogDensity = Number.isFinite(gameConfig?.FOG_DENSITY) ? gameConfig.FOG_DENSITY : 0.001;
    const fogStart = Number.isFinite(gameConfig?.FOG_START) ? gameConfig.FOG_START : 50;
    const fogEnd = Number.isFinite(gameConfig?.FOG_END) ? gameConfig.FOG_END : 100;
    const baseFogColor = this.scene.background?.clone?.() || new THREE.Color(0x87ceeb);

    if (fogMode === 'linear') {
      this.scene.fog = new THREE.Fog(baseFogColor, fogStart, fogEnd);
    } else if (fogMode === 'exp' || fogMode === 'exp2') {
      this.scene.fog = new THREE.FogExp2(baseFogColor, fogDensity);
    } else {
      this.scene.fog = null;
    }
  }

  // Set world time (0-23999, like Minecraft)
  setWorldTime(worldTime) {
    this._worldTime = worldTime;
    // Not gated on dynamic lighting. What fragment uniforms constrain is a
    // scene full of point lights, not one directional sun, and the sun is what
    // the sky, the day cycle and the direction every projected shadow falls in
    // are all read off. Gating this froze `sunLight` at the (0, 1, 0) a
    // DirectionalLight is born with, which reads as a permanent noon: shadows
    // straight down and never moving. `_dynamicLightingActive` still gates the
    // lights a shot, an explosion and a jump jet add, which is the cost the
    // capability is about.
    // A Minecraft clock, not upstream's astronomy: 0 = 6:00, 6000 = noon,
    // 12000 = 18:00, 18000 = midnight, sweeping a fixed arc in the world's X-Y
    // plane with the moon exactly opposite the sun. See AGENTS.md.
    //
    // The distance is upstream's, though: twice the world size, just inside the
    // mountains at 2.25 (BackgroundRenderer.cxx:1716, :1951). Further out than
    // that and they fall past the far plane the mountains size.
    const worldSize = Number.isFinite(this.groundMapSize) ? this.groundMapSize : 100;
    const sunDistance = BZFLAG_CELESTIAL_DISTANCE_SCALE * worldSize;
    const moonDistance = sunDistance;
    const sunAngle = ((worldTime / 24000) * 2 * Math.PI) - Math.PI / 2; // 0 at sunrise, pi at sunset
    const moonAngle = sunAngle + Math.PI;
    // Sun position
    const sunX = Math.cos(sunAngle) * sunDistance;
    const sunY = Math.sin(sunAngle) * sunDistance * 0.8; // Lower arc for realism
    const sunZ = 0;
    // Moon position
    const moonX = Math.cos(moonAngle) * moonDistance;
    const moonY = Math.sin(moonAngle) * moonDistance * 0.8;
    const moonZ = 0;
    const sunElevation = Math.max(-1, Math.min(1, sunY / (sunDistance * 0.8 || 1)));
    const moonElevation = Math.max(-1, Math.min(1, moonY / (moonDistance * 0.8 || 1)));
    const lerpTriplet = (from, to, t) => from.map((value, index) => value + (to[index] - value) * t);
    const toThreeColor = (triplet) => new THREE.Color().setRGB(triplet[0], triplet[1], triplet[2]);

    const highSunColor = [1.75, 1.75, 1.4];
    const lowSunColor = [0.75, 0.27, 0.0];
    const moonColor = [0.4, 0.4, 0.4];
    const nightAmbient = [0.3, 0.3, 0.3];
    const dayAmbient = [0.35, 0.5, 0.5];
    const nightSky = [0.04, 0.04, 0.08];
    const zenithSky = [0.25, 0.55, 0.86];
    const horizonSky = [0.43, 0.75, 0.95];
    const sunrise1 = [0.30, 0.12, 0.08];
    const sunrise2 = [0.47, 0.12, 0.08];

    let directColor = highSunColor;
    let directBrightness = 1.0;
    if (sunElevation <= -0.009) {
      directColor = moonColor;
      directBrightness = 0.35;
    } else if (sunElevation < BZFLAG_DAY_ELEVATION) {
      const t = Math.max(0, Math.min(1, (sunElevation - BZFLAG_DAWN_ELEVATION) / (BZFLAG_DAY_ELEVATION - BZFLAG_DAWN_ELEVATION)));
      directColor = lerpTriplet(lowSunColor, highSunColor, t);
      directBrightness = t;
    }

    let ambientColor = dayAmbient;
    if (sunElevation < BZFLAG_DUSK_ELEVATION) {
      ambientColor = nightAmbient;
    } else if (sunElevation < BZFLAG_DAY_ELEVATION) {
      const t = Math.max(0, Math.min(1, (sunElevation - BZFLAG_DUSK_ELEVATION) / (BZFLAG_DAY_ELEVATION - BZFLAG_DUSK_ELEVATION)));
      ambientColor = lerpTriplet(nightAmbient, dayAmbient, t);
    }

    let skyZenithColor = zenithSky;
    let skySunDirColor = horizonSky;
    if (sunElevation < BZFLAG_NIGHT_ELEVATION) {
      skyZenithColor = nightSky;
      skySunDirColor = nightSky;
    } else if (sunElevation < BZFLAG_TWILIGHT_ELEVATION) {
      const t = Math.max(0, Math.min(1, (sunElevation - BZFLAG_NIGHT_ELEVATION) / (BZFLAG_TWILIGHT_ELEVATION - BZFLAG_NIGHT_ELEVATION)));
      skyZenithColor = nightSky;
      skySunDirColor = lerpTriplet(nightSky, sunrise1, t);
    } else if (sunElevation < BZFLAG_DAWN_ELEVATION) {
      const t = Math.max(0, Math.min(1, (sunElevation - BZFLAG_TWILIGHT_ELEVATION) / (BZFLAG_DAWN_ELEVATION - BZFLAG_TWILIGHT_ELEVATION)));
      skyZenithColor = nightSky;
      skySunDirColor = lerpTriplet(sunrise1, sunrise2, t);
    } else if (sunElevation < BZFLAG_DAY_ELEVATION) {
      const t = Math.max(0, Math.min(1, (sunElevation - BZFLAG_DAWN_ELEVATION) / (BZFLAG_DAY_ELEVATION - BZFLAG_DAWN_ELEVATION)));
      skyZenithColor = lerpTriplet(nightSky, zenithSky, t);
      skySunDirColor = lerpTriplet(sunrise2, horizonSky, t);
    }

    const ambientThreeColor = toThreeColor(ambientColor);
    const directThreeColor = toThreeColor(directColor);
    const backgroundColor = toThreeColor(lerpTriplet(skySunDirColor, skyZenithColor, 0.35));

    if (this.ambientLight) {
      this.ambientLight.color.copy(ambientThreeColor);
      this.ambientLight.intensity = 1.0;
    }

    if (this.sunLight) {
      this.sunLight.position.set(sunX, sunY, sunZ);
      this.sunLight.target.position.set(0, 0, 0);
      this.worldGroup.add(this.sunLight.target);
      this.sunLight.color.copy(directThreeColor);
      this.sunLight.intensity = sunElevation >= -0.009 ? Math.max(0.35, directBrightness) : 0.0;
      this.sunLight.castShadow = sunElevation > (0.5 * BZFLAG_DAY_ELEVATION);
    }

    if (this.moonLight) {
      this.moonLight.position.set(moonX, moonY, moonZ);
      this.moonLight.target.position.set(0, 0, 0);
      this.worldGroup.add(this.moonLight.target);
      this.moonLight.color.copy(toThreeColor(moonColor));
      this.moonLight.intensity = sunElevation < -0.009 && moonElevation > -0.009 ? 0.35 : 0.0;
      this.moonLight.castShadow = this.moonLight.intensity > 0;
    }

    this.scene.background.copy(backgroundColor);
    if (this.scene.fog) {
      this.scene.fog.color.copy(backgroundColor);
    }

    this._updateCelestialBodies({
      sunX,
      sunY,
      sunZ,
      moonX,
      moonY,
      moonZ,
      sunColor: directThreeColor,
      sunRadius: sunDistance * BZFLAG_SUN_ANGULAR_RADIUS,
      moonRadius: moonDistance * BZFLAG_MOON_ANGULAR_RADIUS,
    });
    // Optionally: add/update sun/moon meshes for visuals (not just lighting)
    // ...
  }
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.audioListener = null;
    this.gameVolumeLevel = DEFAULT_VOLUME_LEVEL;
    // Gameplay sample buffers, keyed by GAME_SOUNDS name.
    this.soundBuffers = new Map();
    this.container = null;

    this.ground = null;
    this.groundExtent = null;
    this.groundMapSize = null;
    this._groundCenterX = null;
    this._groundCenterZ = null;
    this.gridHelper = null;
    this.obstacleMeshes = [];
    this.mountainMeshes = [];
    this.celestialMeshes = [];
    this.sunMesh = null;
    this.sunGlowMesh = null;
    this.moonMesh = null;
    this.clouds = [];

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
    this._audioBufferPromisesByPath = new Map();
    this._tankModelPath = '/obj/bzflag.obj';
    this.deathFollowTarget = null;
    this.deathFollowAnchor = null;
    this.deathCameraLogged = false;
    this._preloadTankModel('/obj/bzflag.obj');
    this._preloadTankModel('/obj/modern.obj');
    this._preloadTankModel('/obj/simple.obj');
    this._preloadTankModel('/obj/wheeled6.obj');
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

    const viewport = this._getViewportSize();

    const verticalFov = this._getVerticalFovForAspect(viewport.width / viewport.height);
    this.camera = new THREE.PerspectiveCamera(verticalFov, viewport.width / viewport.height, 0.1, 1000);
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
    container.appendChild(this.renderer.domElement);


    // Anaglyph effect setup (not enabled by default)
    this.anaglyphEffect = new AnaglyphEffect(this.renderer);
    this.anaglyphEffect.setSize(viewport.width, viewport.height);

    this.handleResize();
    window.setTimeout(() => this.handleResize(), 50);
    window.setTimeout(() => this.handleResize(), 250);

    this.audioListener = new THREE.AudioListener();
    this.camera.add(this.audioListener);
    this._applyGameVolume();
    // Sample buffers are filled by preloadGameplayAudio() on map entry.

    this._initDynamicLights();

    return {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
    };
  }

  _initDynamicLights() {
    if (!this.scene) return;
    // Ambient, sun, and moon light will be updated dynamically
    this.ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    this.worldGroup.add(this.ambientLight);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.sunLight.castShadow = false;
    this.worldGroup.add(this.sunLight);
    this.moonLight = new THREE.DirectionalLight(0xffffff, 0.0);
    this.moonLight.castShadow = false;
    this.worldGroup.add(this.moonLight);
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
  playSound(name, position) {
    const buffer = this.soundBuffers.get(name);
    if (!GAME_SOUNDS[name] || !buffer || !this.audioListener) return;

    const sound = new THREE.PositionalAudio(this.audioListener);
    sound.setBuffer(buffer);
    sound.setDistanceModel(SOUND_DISTANCE_MODEL);
    sound.setRefDistance(SOUND_REF_DISTANCE);
    sound.setRolloffFactor(SOUND_ROLLOFF_FACTOR);
    sound.setVolume(MASTER_VOLUME);
    if (position) sound.position.copy(position);
    this.worldGroup.add(sound);
    sound.play();
    sound.source.onended = () => { this.worldGroup.remove(sound); };
  }

  // Non-positional variant, for sounds made by the player's own tank. BZFlag
  // plays these with distance 0, which means no attenuation at all.
  playLocalSound(name) {
    const buffer = this.soundBuffers.get(name);
    if (!GAME_SOUNDS[name] || !buffer || !this.audioListener) return;

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

  _applyGameVolume() {
    this.audioListener?.setMasterVolume(volumeLevelToGain(this.gameVolumeLevel));
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

  getRenderStats() {
    if (!this.renderer) return null;
    const { render, memory, programs } = this.renderer.info;
    // The buffer, not the window: a client that is bound on pixels reads the
    // same at every frame rate unless this is next to the timings. It moves
    // whenever the window does, so the one logged at init does not answer it.
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      drawbuf: `${buffer.x}x${buffer.y}`,
      calls: render.calls,
      triangles: render.triangles,
      programs: programs ? programs.length : 0,
      textures: memory.textures,
      geometries: memory.geometries,
      draws: this._countDrawGroups(),
    };
  }

  canUseDynamicLighting() {
    return supportsDynamicLighting(this.renderCapabilities);
  }

  // The lights the scene is actually given. They are built once and never
  // hidden and never removed, because Three does not count a light it cannot
  // see -- hiding one costs the same recompile as deleting it, and a light
  // dimmed to nothing costs a uniform and changes no program.
  _getDynamicLightPool() {
    if (!this._dynamicLightingActive() || !this.worldGroup) {
      if (this._dynamicLightPool) {
        this._dynamicLightPool.forEach((light) => this.worldGroup?.remove(light));
        this._dynamicLightPool = null;
      }
      return null;
    }
    if (this._dynamicLightPool) return this._dynamicLightPool;

    this._dynamicLightPool = [];
    for (let slot = 0; slot < BZFLAG_MAX_DYNAMIC_LIGHTS; slot += 1) {
      const light = new THREE.PointLight(0xffffff, 0, BZFLAG_LIGHT_MAX_DISTANCE, BZFLAG_LIGHT_DECAY);
      this.worldGroup.add(light);
      this._dynamicLightPool.push(light);
    }
    return this._dynamicLightPool;
  }

  // What a shot, an explosion or a jet asks for: somewhere to be, a colour and
  // a brightness. Not a light in the scene, because how many lights are in the
  // scene is the one thing that has to stay still.
  _createDynamicLight(color, intensity) {
    return {
      position: new THREE.Vector3(),
      color: new THREE.Color(color),
      intensity,
      visible: true,
      importance: 0,
    };
  }

  // Hand the pool to whichever effects matter most, once a frame.
  //
  // `OpenGLLight::calculateImportance`: a light further away than its own reach
  // is dropped outright, and what survives is ranked by how near the eye it is.
  // Upstream sorts every time; bzo sorts only when there are more candidates
  // than slots, which in an ordinary frame there are not.
  _applyDynamicLightPool() {
    const pool = this._getDynamicLightPool();
    if (!this._activeJumpJetLights) this._activeJumpJetLights = [];
    if (!pool) {
      this._activeJumpJetLights.length = 0;
      return;
    }

    // The eye and where it looks, in the world group's own space, the way the
    // flags take them: that group carries the player's heading in a session, so
    // the camera's own world position is in a different frame from the lights'.
    const inverse = DYNAMIC_LIGHT_QUATERNION.copy(this.worldGroup.quaternion).invert();
    const eye = DYNAMIC_LIGHT_EYE;
    this.camera.getWorldPosition(eye);
    eye.sub(this.worldGroup.position).applyQuaternion(inverse);
    const forward = DYNAMIC_LIGHT_FORWARD;
    this.camera.getWorldDirection(forward).applyQuaternion(inverse);

    if (!this._dynamicLightCandidates) this._dynamicLightCandidates = [];
    const candidates = this._dynamicLightCandidates;
    candidates.length = 0;
    const offset = DYNAMIC_LIGHT_OFFSET;
    this._forEachDynamicLight((light) => {
      if (light.visible === false || !(light.intensity > 0)) return;
      const distance = offset.copy(light.position).sub(eye).length();
      // `OpenGLLight::calculateImportance` drops a light for being far away
      // only when it is *behind* the viewer: `sphereCull` is cleared the moment
      // the light is in front of the front plane, and the distance test below
      // it never runs. A light in front is only ever ranked by distance, never
      // disqualified by it -- a shot lighting the ground a hundred units ahead
      // is a shot the player can see lighting the ground.
      //
      // Upstream also drops a light that has fallen outside a frustum side by
      // more than its own reach. That test is not here: it needs the frustum
      // planes, a session has two of them rather than one, and with seven slots
      // and a handful of shots a light off to the side costs a slot rather than
      // a wrong picture.
      if (distance > BZFLAG_LIGHT_MAX_DISTANCE && offset.dot(forward) <= 0) return;
      light.importance = distance > 0 ? 1 / distance : Infinity;
      candidates.push(light);
    });
    if (candidates.length > pool.length) {
      candidates.sort((a, b) => b.importance - a.importance);
    }

    for (let slot = 0; slot < pool.length; slot += 1) {
      const light = pool[slot];
      const source = candidates[slot];
      if (!source) {
        light.intensity = 0;
        continue;
      }
      light.position.copy(source.position);
      light.color.copy(source.color);
      light.intensity = source.intensity;
    }
    // Gathered afresh every frame from the tanks that are actually jetting, so
    // a tank that left the world leaves nothing behind here.
    this._activeJumpJetLights.length = 0;
  }

  // Capability and switch kept apart, as `_dynamicLightingActive` does: the
  // stencil bits say what the machine can do, the knob says what this run is
  // measuring.
  _projectedShadowsActive() {
    return this.projectedShadowsEnabled && this.canUseProjectedShadows();
  }

  canUseProjectedShadows() {
    return supportsProjectedShadows(this.renderCapabilities);
  }

  _dynamicLightingActive() {
    return this.dynamicLightingEnabled && this.canUseDynamicLighting();
  }

  // --- Projected Planar Shadows (Stencil-style) ---
  // Build each shadow in worldGroup-local space so XR can move the whole world
  // without applying the camera transform to the shadow twice.
  _getProjectedShadowDirection(lightDirection) {
    if (!lightDirection) return null;

    const dir = lightDirection.clone();
    const lengthSq = dir.lengthSq();
    if (!Number.isFinite(lengthSq) || lengthSq < Number.EPSILON) return null;

    dir.normalize();
    // A light at or below the horizon would produce an unbounded or inverted
    // projection. Keep the last valid shadow until the light rises again.
    if (!Number.isFinite(dir.y) || dir.y <= PROJECTED_SHADOW_MIN_LIGHT_Y) return null;
    return dir;
  }

  // Upstream does not move any vertices to project a shadow: drawGroundShadows
  // (BackgroundRenderer.cxx:1227) builds a degenerate matrix, multiplies it in,
  // and redraws the same geometry. This is that matrix for a Y-up world, taking
  // (x, y, z) to (x - y*dx/dy, casterY, z - y*dz/dy) -- the same projection the
  // vertices used to be walked through one at a time, now free.
  _setProjectedShadowFlattenMatrix(matrix, dir) {
    const slopeX = dir.x / dir.y;
    const slopeZ = dir.z / dir.y;
    return matrix.set(
      1, -slopeX, 0, 0,
      0, 0, 0, PROJECTED_SHADOW_CASTER_Y,
      0, -slopeZ, 1, 0,
      0, 0, 0, 1,
    );
  }

  // One material for every shadow: they differ only in where they land, and a
  // shared material is a shared program and one piece of GL state to set.
  _getProjectedShadowMaterial() {
    if (!this._projectedShadowMaterial) {
      const material = new THREE.MeshBasicMaterial({
        color: 0x000000,
        depthWrite: false,
        depthTest: false,
        colorWrite: false,
        transparent: false,
      });
      material.stencilWrite = true;
      material.stencilRef = PROJECTED_SHADOW_STENCIL_REF;
      material.stencilFunc = THREE.AlwaysStencilFunc;
      material.stencilFail = THREE.KeepStencilOp;
      material.stencilZFail = THREE.KeepStencilOp;
      material.stencilZPass = THREE.ReplaceStencilOp;
      this._projectedShadowMaterial = material;
    }
    return this._projectedShadowMaterial;
  }

  // The shadow shares its caster's geometry -- it is the same shape, drawn flat
  // -- so it owns no vertices, no buffer, and nothing that can fall out of step
  // with the caster. Neither the geometry nor the material is this mesh's to
  // dispose; _removeProjectedShadowMesh is the only way it goes away.
  _ensureProjectedShadowMesh(mesh) {
    const existing = mesh.userData.shadowMesh;
    if (existing) {
      if (existing.geometry === mesh.geometry) return existing;
      this._removeProjectedShadowMesh(mesh);
    }

    const shadowMesh = new THREE.Mesh(mesh.geometry, this._getProjectedShadowMaterial());
    // Its placement is written straight into matrixWorld below, so Three has
    // nothing to recompute for it.
    shadowMesh.matrixAutoUpdate = false;
    shadowMesh.matrixWorldAutoUpdate = false;
    shadowMesh.renderOrder = PROJECTED_SHADOW_RENDER_ORDER;
    // The bound Three would derive from a flattening matrix can under-estimate,
    // and a shadow that pops out is worse than one that is always submitted.
    shadowMesh.frustumCulled = false;
    this._tagDraws(shadowMesh, 'shadow');
    this.worldGroup.add(shadowMesh);
    mesh.userData.shadowMesh = shadowMesh;
    return shadowMesh;
  }

  _removeProjectedShadowMesh(mesh) {
    const shadowMesh = mesh?.userData?.shadowMesh;
    if (!shadowMesh) return;
    this.worldGroup.remove(shadowMesh);
    mesh.userData.shadowMesh = null;
  }

  // A tank's whole shape as one geometry, in the tank's own space, shared by
  // every tank wearing the same model.
  //
  // A tank arrives from the loader as seventeen objects and cast a shadow from
  // each, which the draw breakdown measured at three quarters of everything the
  // map itself costs -- and none of them cull, because a shadow's flattening
  // matrix can under-estimate its bound. The shadow does not need the parts: it
  // is one flat silhouette, the parts do not move against each other, and what
  // does move on a tank moves by scrolling a texture rather than by turning a
  // wheel.
  _getTankShadowGeometry(tank) {
    const key = tank.userData.modelPath || 'default';
    if (!this._tankShadowGeometry) this._tankShadowGeometry = new Map();
    const existing = this._tankShadowGeometry.get(key);
    if (existing) return existing;

    const positions = [];
    const indices = [];
    const matrix = new THREE.Matrix4();
    const vertex = new THREE.Vector3();
    tank.updateWorldMatrix(true, true);
    const tankInverse = new THREE.Matrix4().copy(tank.matrixWorld).invert();

    tank.traverse((child) => {
      // A sprite is a name label, and a label casts nothing.
      if (!child.isMesh || !child.geometry) return;
      const position = child.geometry.getAttribute('position');
      if (!position) return;
      matrix.multiplyMatrices(tankInverse, child.matrixWorld);
      const offset = positions.length / 3;
      for (let i = 0; i < position.count; i += 1) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
        positions.push(vertex.x, vertex.y, vertex.z);
      }
      const index = child.geometry.getIndex();
      if (index) {
        for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
      } else {
        for (let i = 0; i < position.count; i += 1) indices.push(i + offset);
      }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    this._tankShadowGeometry.set(key, geometry);
    return geometry;
  }

  // One shadow for a whole tank, hung off the tank rather than off its parts.
  _ensureTankShadowMesh(tank) {
    const existing = tank.userData.shadowMesh;
    if (existing) return existing;

    const shadowMesh = this._tagDraws(
      new THREE.Mesh(this._getTankShadowGeometry(tank), this._getProjectedShadowMaterial()),
      'shadow',
    );
    shadowMesh.matrixAutoUpdate = false;
    shadowMesh.matrixWorldAutoUpdate = false;
    shadowMesh.renderOrder = PROJECTED_SHADOW_RENDER_ORDER;
    shadowMesh.frustumCulled = false;
    this.worldGroup.add(shadowMesh);
    tank.userData.shadowMesh = shadowMesh;
    return shadowMesh;
  }

  // Everything under `object3D` stops casting for good. A tank's meshes are
  // clones sharing their geometry and materials with every other tank, so
  // nothing here is disposed -- only the shadows pointing at them, which the
  // world group would otherwise keep drawing after the caster has left it.
  dropProjectedShadows(object3D) {
    if (!object3D) return;
    object3D.traverse((child) => this._removeProjectedShadowMesh(child));
  }

  // The whole cost of a shadow, per frame: one matrix multiply.
  //
  // A caster is either a mesh with geometry of its own -- an obstacle fragment
  // -- or a tank, which is a group of parts casting one merged silhouette.
  _projectShadowForMesh(mesh, projection, casting = true) {
    if (!mesh) return;
    const isTank = !mesh.geometry;
    if (isTank && mesh.userData.drawGroup !== 'tank') return;
    if (!casting || mesh.visible === false) {
      const shadowMesh = mesh.userData.shadowMesh;
      if (shadowMesh) shadowMesh.visible = false;
      return;
    }

    const shadowMesh = isTank
      ? this._ensureTankShadowMesh(mesh)
      : this._ensureProjectedShadowMesh(mesh);
    shadowMesh.visible = true;
    shadowMesh.matrixWorld.multiplyMatrices(projection, mesh.matrixWorld);
  }

  // Shadows only land where a caster can throw one: inside the world border,
  // plus the longest shadow the lowest light the pass accepts can cast. The
  // ground reaches ten times the world in every direction, and covering all of
  // it means blending most of the screen -- every frame the horizon is in view
  // -- over ground no shadow can reach. The headroom is for airborne tanks
  // above the tallest obstacle.
  _getProjectedShadowOverlayExtent() {
    const border = Number.isFinite(this.groundMapSize) ? this.groundMapSize / 2 : 100;
    const casterHeight = this.maxObstacleHeight + PROJECTED_SHADOW_CASTER_HEADROOM;
    return Math.min(this.groundExtent, border + (casterHeight / PROJECTED_SHADOW_MIN_LIGHT_Y));
  }

  // Called again once the obstacles are in, because the tallest of them is what
  // decides how far a shadow reaches.
  _refreshProjectedShadowOverlay() {
    if (!this._projectedShadowsActive() || !Number.isFinite(this.groundExtent)) return;

    const extent = this._getProjectedShadowOverlayExtent();
    if (!this.projectedShadowOverlay) {
      this.projectedShadowOverlay = this._buildProjectedShadowOverlay(extent);
      this.worldGroup.add(this._tagDraws(this.projectedShadowOverlay, 'shadow'));
      return;
    }
    if (this.projectedShadowOverlay.userData.extent === extent) return;
    this.projectedShadowOverlay.geometry.dispose();
    this.projectedShadowOverlay.geometry = new THREE.PlaneGeometry(extent * 2, extent * 2);
    this.projectedShadowOverlay.userData.extent = extent;
  }

  _buildProjectedShadowOverlay(overlayExtent) {
    const overlayGeometry = new THREE.PlaneGeometry(overlayExtent * 2, overlayExtent * 2);
    const overlayMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: PROJECTED_SHADOW_DARKEN_OPACITY,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });

    overlayMaterial.stencilWrite = true;
    overlayMaterial.stencilRef = PROJECTED_SHADOW_STENCIL_REF;
    overlayMaterial.stencilFunc = THREE.EqualStencilFunc;
    overlayMaterial.stencilFail = THREE.KeepStencilOp;
    overlayMaterial.stencilZFail = THREE.KeepStencilOp;
    overlayMaterial.stencilZPass = THREE.KeepStencilOp;

    const overlayMesh = new THREE.Mesh(overlayGeometry, overlayMaterial);
    overlayMesh.rotation.x = -Math.PI / 2;
    overlayMesh.position.y = PROJECTED_SHADOW_OVERLAY_Y;
    overlayMesh.renderOrder = 20;
    overlayMesh.userData.extent = overlayExtent;
    return overlayMesh;
  }

  _buildGroundGrid(mapSize) {
    if (!Number.isFinite(mapSize) || mapSize <= 0) return null;
    const gridSpacing = 5;
    const gridDivisions = Math.max(1, Math.round(mapSize / gridSpacing));
    const grid = new THREE.GridHelper(mapSize, gridDivisions, 0x000000, 0x555555);
    grid.position.y = GROUND_GRID_Y;
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
    this.worldGroup?.remove(this.gridHelper);
    this.gridHelper.geometry?.dispose();
    if (Array.isArray(this.gridHelper.material)) {
      this.gridHelper.material.forEach((material) => material.dispose());
    } else {
      this.gridHelper.material?.dispose();
    }
    this.gridHelper = null;
  }

  _inferMapSizeFromGround() {
    if (Number.isFinite(this.groundMapSize) && this.groundMapSize > 0) {
      return this.groundMapSize;
    }
    return 100;
  }

  setGroundGridEnabled(enabled, mapSize = null) {
    this.showGroundGrid = !!enabled;
    if (!this.scene || !this.worldGroup) return;

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
    this.worldGroup.add(this._tagDraws(grid, 'scenery'));
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

  // Expects updateWorldMatrices to have run this frame.
  updateProjectedShadows(tankMeshes = []) {
    // Each shadow mesh writes the stencil the ground overlay reads. Without a
    // stencil buffer there is no overlay to read it, so the meshes would draw
    // for nothing.
    if (!this._projectedShadowsActive() || !this.worldGroup) return;
    // Use sun or moon depending on which is visible
    const light = (this.sunLight && this.sunLight.intensity > 0.5) ? this.sunLight : this.moonLight;
    const dir = this._getProjectedShadowDirection(light?.position);
    if (!dir) return;

    if (!this._projectedShadowProjection) {
      this._projectedShadowProjection = new THREE.Matrix4();
      this._projectedShadowFlatten = new THREE.Matrix4();
      this._projectedShadowWorldToLocal = new THREE.Matrix4();
    }

    this._setProjectedShadowFlattenMatrix(this._projectedShadowFlatten, dir);
    this._projectedShadowWorldToLocal.copy(this.worldGroup.matrixWorld).invert();
    // Flatten in worldGroup space, whatever the world is doing in XR.
    const projection = this._projectedShadowProjection
      .multiplyMatrices(this.worldGroup.matrixWorld, this._projectedShadowFlatten)
      .multiply(this._projectedShadowWorldToLocal);

    for (const mesh of this.obstacleMeshes) {
      this._projectShadowForMesh(mesh, projection);
    }

    for (const tank of tankMeshes) {
      if (!tank) continue;
      // A dead tank is hidden by its group, and the group is what casts: one
      // silhouette for the whole tank rather than one shadow per part. A
      // shadow keeps the last matrix it was handed -- written straight into
      // matrixWorld, where nothing re-derives it from the world group -- so a
      // caster that stops being projected leaves its shadow behind: a dark
      // patch on a desktop, and in a session, where the world group carries the
      // player's own heading, a shadow that appears stuck to the view. It comes
      // back when the tank does.
      this._projectShadowForMesh(tank, projection, tank.visible !== false);
    }
  }

  // --- Ground light receivers ---
  // Upstream's ring radii are receiverRingSize * i*i, so the fan reaches 19.2
  // units in four steps that get coarser as the light falls off. Position and
  // index buffers are shared by every receiver; only the colours differ.
  _getGroundReceiverGeometry() {
    if (!this._groundReceiverPosition) {
      const positions = [0, 0, 0];
      for (let ring = 1; ring <= GROUND_RECEIVER_RINGS; ring += 1) {
        const radius = GROUND_RECEIVER_RING_SIZE * ring * ring;
        for (let slice = 0; slice < GROUND_RECEIVER_SLICES; slice += 1) {
          const angle = (slice / GROUND_RECEIVER_SLICES) * Math.PI * 2;
          positions.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
        }
      }

      const indices = [];
      for (let slice = 0; slice < GROUND_RECEIVER_SLICES; slice += 1) {
        const next = (slice + 1) % GROUND_RECEIVER_SLICES;
        indices.push(0, 1 + slice, 1 + next);
      }
      for (let ring = 1; ring < GROUND_RECEIVER_RINGS; ring += 1) {
        const inner = 1 + ((ring - 1) * GROUND_RECEIVER_SLICES);
        const outer = 1 + (ring * GROUND_RECEIVER_SLICES);
        for (let slice = 0; slice < GROUND_RECEIVER_SLICES; slice += 1) {
          const next = (slice + 1) % GROUND_RECEIVER_SLICES;
          indices.push(inner + slice, outer + slice, outer + next);
          indices.push(inner + slice, outer + next, inner + next);
        }
      }

      this._groundReceiverPosition = new THREE.BufferAttribute(new Float32Array(positions), 3);
      this._groundReceiverIndex = indices;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this._groundReceiverPosition);
    geometry.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(this._groundReceiverPosition.count * 4), 4,
    ));
    geometry.setIndex(this._groundReceiverIndex);
    return geometry;
  }

  _getGroundReceiverMaterial() {
    if (!this._groundReceiverMaterial) {
      this._groundReceiverMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        // What upstream's receiverGState blends with: GL_SRC_ALPHA, GL_ONE.
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // A flat additive decal is worth seeing from either side, and eight
        // slices are not worth a winding argument.
        side: THREE.DoubleSide,
        fog: false,
      });
    }
    return this._groundReceiverMaterial;
  }

  // I = B / (c + d*(l + d*q)), and past the centre also the cosine term
  // height/d, exactly as upstream computes it per ring.
  _getGroundReceiverIntensity(distance, dimming) {
    const [constant, linear, quadratic] = BZFLAG_LIGHT_ATTENUATION;
    return dimming / (constant + (distance * (linear + (distance * quadratic))));
  }

  // Repaint a receiver's vertex colours. The profile depends only on the light's
  // colour, its height, and how bright the sun is, none of which change on a
  // shot in flight -- so a receiver is painted once and then only moved.
  _paintGroundReceiver(mesh, color, height, dimming) {
    const profileKey = `${color.getHex()}|${Math.round(height * 4)}|${Math.round(dimming * 64)}`;
    if (mesh.userData.receiverProfile === profileKey) return;
    mesh.userData.receiverProfile = profileKey;

    const attribute = mesh.geometry.getAttribute('color');
    const alphaForRing = (ring) => {
      if (ring >= GROUND_RECEIVER_RINGS) return 0; // upstream forces the rim to 0
      if (ring === 0) return this._getGroundReceiverIntensity(height, dimming);
      const radius = GROUND_RECEIVER_RING_SIZE * ring * ring;
      const distance = Math.hypot(radius, height);
      return this._getGroundReceiverIntensity(distance, dimming) * (height / distance);
    };

    let vertex = 0;
    for (let ring = 0; ring <= GROUND_RECEIVER_RINGS; ring += 1) {
      const alpha = Math.max(0, Math.min(1, alphaForRing(ring)));
      const sliceCount = ring === 0 ? 1 : GROUND_RECEIVER_SLICES;
      for (let slice = 0; slice < sliceCount; slice += 1) {
        attribute.setXYZW(vertex, color.r, color.g, color.b, alpha);
        vertex += 1;
      }
    }
    attribute.needsUpdate = true;
  }

  // Upstream's sunBrightness dims the receivers in daylight so a shot does not
  // paint a bright pool on ground the sun is already lighting.
  _getGroundReceiverDimming() {
    const sunBrightness = Math.max(0, Math.min(1, this.sunLight ? this.sunLight.intensity : 0));
    return 1 - (GROUND_RECEIVER_SUN_DIMMING * sunBrightness);
  }

  // Every dynamic light bzo casts belongs to something parented to worldGroup,
  // so the light's own position is already in the space the receivers live in.
  // Everything asking for a light this frame, which is more than the scene can
  // be given.
  _forEachDynamicLight(visit) {
    if (this.projectileLights) {
      for (const light of this.projectileLights.values()) {
        if (light) visit(light);
      }
    }
    for (const effect of this.activeShotExplosions) {
      if (effect.light) visit(effect.light);
    }
    for (const effect of this.activeExplosions) {
      if (effect.light) visit(effect.light);
    }
    if (this._activeJumpJetLights) {
      for (const light of this._activeJumpJetLights) visit(light);
    }
  }

  // And the ones it was given. A receiver stands for light landing on the
  // ground, so it follows what is lighting the ground rather than what asked
  // to.
  _forEachPooledLight(visit) {
    if (!this._dynamicLightPool) return;
    for (const light of this._dynamicLightPool) {
      if (light.intensity > 0) visit(light);
    }
  }

  updateGroundReceivers() {
    if (!this.worldGroup) return;
    if (!this._groundReceivers) this._groundReceivers = [];

    const dimming = this._getGroundReceiverDimming();
    const receivers = this._groundReceivers;
    let used = 0;

    this._forEachPooledLight((light) => {
      const height = light.position.y;
      if (!(height > 0)) return;
      const color = light.color;
      const peak = this._getGroundReceiverIntensity(height, dimming)
        * Math.max(color.r, color.g, color.b);
      if (peak < GROUND_RECEIVER_MIN_LUMINANCE) return;

      let mesh = receivers[used];
      if (!mesh) {
        mesh = new THREE.Mesh(this._getGroundReceiverGeometry(), this._getGroundReceiverMaterial());
        mesh.renderOrder = GROUND_RECEIVER_RENDER_ORDER;
        this.worldGroup.add(this._tagDraws(mesh, 'effect'));
        receivers[used] = mesh;
      }
      mesh.position.set(light.position.x, GROUND_RECEIVER_Y, light.position.z);
      this._paintGroundReceiver(mesh, color, height, dimming);
      mesh.visible = true;
      used += 1;
    });

    for (let index = used; index < receivers.length; index += 1) {
      receivers[index].visible = false;
    }
  }

  getScene() {
    return this.scene;
  }

  getWorldGroup() {
    return this.worldGroup;
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

  clearGround() {
    if (this.ground && this.scene) {
      this.worldGroup.remove(this.ground);
      this.ground.geometry.dispose();
      this.ground.material.dispose();
      this.ground = null;
      this.groundExtent = null;
      this.groundMapSize = null;
    }
    if (this.projectedShadowOverlay && this.scene) {
      this.worldGroup.remove(this.projectedShadowOverlay);
      this.projectedShadowOverlay.geometry.dispose();
      this.projectedShadowOverlay.material.dispose();
      this.projectedShadowOverlay = null;
    }
    this._disposeGroundGrid();
  }

  // A box's four walls and its two caps, as one shared material each. The repeat
  // that used to ride on the texture is baked into the geometry's UVs instead,
  // which is what lets every box in the world share them: nothing about the
  // material depends on the box's size any more. `_prepareBoxGeometry` also puts
  // the four walls next to each other in the index buffer, so a box is two draw
  // calls rather than the six a BoxGeometry's own face groups ask for.
  //
  // Shared, so never disposed with the mesh -- `clearObstacles` drops the cache
  // once every mesh using it is gone.
  _getSharedObstacleMaterials(key, sideTextureFactory, topTextureFactory, options = {}) {
    if (!this._sharedObstacleMaterials) this._sharedObstacleMaterials = new Map();
    const existing = this._sharedObstacleMaterials.get(key);
    if (existing) return existing;
    const materials = [
      new THREE.MeshLambertMaterial({ map: sideTextureFactory(), ...options }),
      new THREE.MeshLambertMaterial({ map: topTextureFactory(), ...options }),
    ];
    materials.forEach((material) => { material.userData.shared = true; });
    this._sharedObstacleMaterials.set(key, materials);
    return materials;
  }

  // Per key, because the boxes and the boundary walls are torn down separately
  // and each owns only its own entry.
  _disposeSharedObstacleMaterials(key) {
    const materials = this._sharedObstacleMaterials?.get(key);
    if (!materials) return;
    materials.forEach((material) => {
      material.map?.dispose();
      material.dispose();
    });
    this._sharedObstacleMaterials.delete(key);
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
    const halfWidth = Math.max(0.25, Number(obs.w) / 2 || 0.56);
    const sourceHalfBreadth = Math.max(0.25, Number(obs.d) / 2 || 2.24);
    const sourceHeight = Math.max(1.0, Number(obs.h) || 10.0);
    const border = Math.max(0.12, Number(obs.border) || 1.12);

    // Match BZFlag Teleporter::finalize() for non-horizontal teleporters:
    // size[1] = origBreadth + 2*border, size[2] = origHeight + border.
    const halfBreadth = sourceHalfBreadth + (border * 2.0);
    const height = sourceHeight + border;

    // Scene generator then uses:
    // h = getBreadth() - border, z = getHeight() - border.
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
    // Each one used to be its own mesh and so its own draw call, which on a map
    // with eight teleporters is over a hundred draws for a few hundred
    // triangles. They accumulate per material here and become one mesh each
    // below. No quad shares a vertex with another, so the normals a merged
    // geometry computes are still per-quad.
    const quadBuckets = new Map();
    const addQuad = (base, sEdge, tEdge, uvCoords, material, renderOrder = 5) => {
      let bucket = quadBuckets.get(material);
      if (!bucket) {
        bucket = { material, renderOrder, positions: [], uvs: [], indices: [] };
        quadBuckets.set(material, bucket);
      }
      const p0 = new THREE.Vector3(base[0], base[2], base[1]);
      const p1 = new THREE.Vector3(base[0] + sEdge[0], base[2] + sEdge[2], base[1] + sEdge[1]);
      const p2 = new THREE.Vector3(base[0] + sEdge[0] + tEdge[0], base[2] + sEdge[2] + tEdge[2], base[1] + sEdge[1] + tEdge[1]);
      const p3 = new THREE.Vector3(base[0] + tEdge[0], base[2] + tEdge[2], base[1] + tEdge[1]);

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

    addPortalFace(halfWidth, centerMaterialFront, true);
    addPortalFace(-halfWidth, centerMaterialBack, false);

    buildQuadBuckets();

    teleporter.userData.portalMaterials = [centerMaterialFront, centerMaterialBack];
    teleporter.userData.portalTextures = [portalTextureFront, portalTextureBack];
    teleporter.userData.portalPhase = (obs.x * 0.031) + (obs.z * 0.017);

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
        frontTexture.offset.y = -((timeSeconds * 0.05) % 1);
      }
      if (backTexture) {
        backTexture.offset.y = -((timeSeconds * 0.05) % 1);
      }
    }
  }

  _clearObjectForRemoval(object3D) {
    if (!object3D) return;
    this._removeProjectedShadowMesh(object3D);
    this._disposeObject3D(object3D);
    this.worldGroup.remove(object3D);
  }

  // The ground's eight corners: four at the edge of the world, four around the
  // eye. Texture coordinates are the world position scaled by the repeat, as
  // upstream's `glTexCoord2f(vertices[index][0] * repeat, ...)` does, so the
  // texture is pinned to the world rather than to the patch that moves under it.
  _buildCenteredGroundGeometry(groundExtent) {
    const geometry = new THREE.BufferGeometry();
    const normals = new Float32Array(8 * 3);
    for (let i = 0; i < 8; i++) normals[i * 3 + 1] = 1;
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

  _setGroundCorner(index, x, z) {
    const { position, uv } = this.ground.geometry.attributes;
    position.setXYZ(index, x, 0, z);
    uv.setXY(index, x * GROUND_TEX_REPEAT, -z * GROUND_TEX_REPEAT);
  }

  // Keeps the centre patch under the eye, clamped so it never leaves the skirt
  // it is cut out of. Called once per frame, before the scene is drawn.
  updateGroundCenter() {
    if (!this.ground || !this.camera || !this.worldGroup) return;
    const limit = this.groundExtent - GROUND_CENTER_SIZE;
    if (!(limit > 0)) return;

    this.camera.updateWorldMatrix(true, false);
    this.worldGroup.updateWorldMatrix(true, false);
    const eye = this.camera.getWorldPosition(GROUND_EYE_SCRATCH);
    this.worldGroup.worldToLocal(eye);
    const centerX = Math.max(-limit, Math.min(limit, eye.x));
    const centerZ = Math.max(-limit, Math.min(limit, eye.z));
    if (this._groundCenterX === centerX && this._groundCenterZ === centerZ) return;
    this._groundCenterX = centerX;
    this._groundCenterZ = centerZ;

    const size = GROUND_CENTER_SIZE;
    this._setGroundCorner(4, centerX - size, centerZ + size);
    this._setGroundCorner(5, centerX + size, centerZ + size);
    this._setGroundCorner(6, centerX + size, centerZ - size);
    this._setGroundCorner(7, centerX - size, centerZ - size);
    this.ground.geometry.attributes.position.needsUpdate = true;
    this.ground.geometry.attributes.uv.needsUpdate = true;
  }

  buildGround(mapSize) {
    if (!this.scene) return;
    this.clearGround();

    const groundExtent = mapSize * 10;
    const groundGeometry = this._buildCenteredGroundGeometry(groundExtent);
    const groundTexture = createGroundTexture();
    groundTexture.wrapS = THREE.RepeatWrapping;
    groundTexture.wrapT = THREE.RepeatWrapping;

    // The ground is the largest thing on screen, so it is the last surface that
    // should carry the most expensive shader. Upstream lights it diffuse-only,
    // and every other surface here is Lambert; a metalness/roughness BRDF over
    // that many fragments is paid for nothing. Front faces only: the ground is
    // never seen from below.
    const groundMaterial = new THREE.MeshLambertMaterial({
      map: groundTexture,
      side: THREE.FrontSide,
    });

    this.ground = new THREE.Mesh(groundGeometry, groundMaterial);
    this.ground.frustumCulled = false;
    this.groundExtent = groundExtent;
    this.groundMapSize = mapSize;
    this._groundCenterX = null;
    this._groundCenterZ = null;
    this._setGroundCorner(0, -groundExtent, groundExtent);
    this._setGroundCorner(1, groundExtent, groundExtent);
    this._setGroundCorner(2, groundExtent, -groundExtent);
    this._setGroundCorner(3, -groundExtent, -groundExtent);
    this.updateGroundCenter();
    this.worldGroup.add(this._tagDraws(this.ground, 'scenery'));

    this._refreshProjectedShadowOverlay();
    this.setGroundGridEnabled(this.showGroundGrid, mapSize);
  }


  createMapBoundaries(mapSize = 100) {
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
    const wallHeight = WORLD_WALL_HEIGHT;
    const wallThickness = 1;

    // Create and track boundary meshes
    const boundaryMeshes = [];

    // Remove old compass markers if present
    if (!this.compassMarkers) this.compassMarkers = [];
    this.compassMarkers.forEach(marker => {
      this.worldGroup.remove(marker);
      if (marker.material && marker.material.map) marker.material.map.dispose();
      if (marker.material) marker.material.dispose();
    });
    this.compassMarkers = [];

    // Each wall drops the face that points away from the arena. Nothing is made
    // transparent: with the outward face gone, a camera outside the border meets
    // the inward face from behind, which back-face culling removes, and sees
    // straight into the arena. So backing a tank against the border in third
    // person shows the tank rather than the back of a wall, while from every
    // position a player can occupy the wall is as solid as it was.
    //
    // Upstream has no third person view and no equivalent of this.
    const northWall = new THREE.Mesh(
      this._prepareBoxGeometry(mapSize + wallThickness * 2, wallHeight, wallThickness, { ...BOX_TEXTURE_SCALES, omitFaces: [BOX_FACE.NZ] }),
      this._getSharedObstacleMaterials('boundary', createBoundaryTexture, createBoundaryTexture),
    );
    northWall.position.set(0, wallHeight / 2, -mapSize / 2 - wallThickness / 2);
    northWall.castShadow = true;
    northWall.receiveShadow = true;
    northWall.name = 'North Wall';
    this.worldGroup.add(this._tagDraws(northWall, 'scenery'));
    boundaryMeshes.push(northWall);
    const markerHeight = Math.max(wallHeight + 8, this.maxObstacleHeight + 5);
    this._addCompassMarker('N', 0xB20000, new THREE.Vector3(0, markerHeight, -mapSize / 2));
    this._addDebugLabel(northWall, 'boundary');


    const southWall = new THREE.Mesh(
      this._prepareBoxGeometry(mapSize + wallThickness * 2, wallHeight, wallThickness, { ...BOX_TEXTURE_SCALES, omitFaces: [BOX_FACE.PZ] }),
      this._getSharedObstacleMaterials('boundary', createBoundaryTexture, createBoundaryTexture),
    );
    southWall.position.set(0, wallHeight / 2, mapSize / 2 + wallThickness / 2);
    southWall.castShadow = true;
    southWall.receiveShadow = true;
    this.worldGroup.add(this._tagDraws(southWall, 'scenery'));
    southWall.name = 'South Wall';
    boundaryMeshes.push(southWall);
    this._addCompassMarker('S', 0x1976D2, new THREE.Vector3(0, markerHeight, mapSize / 2));
    this._addDebugLabel(southWall, 'boundary');


    const eastWall = new THREE.Mesh(
      this._prepareBoxGeometry(wallThickness, wallHeight, mapSize, { ...BOX_TEXTURE_SCALES, omitFaces: [BOX_FACE.PX] }),
      this._getSharedObstacleMaterials('boundary', createBoundaryTexture, createBoundaryTexture),
    );
    eastWall.position.set(mapSize / 2 + wallThickness / 2, wallHeight / 2, 0);
    eastWall.castShadow = true;
    eastWall.receiveShadow = true;
    this.worldGroup.add(this._tagDraws(eastWall, 'scenery'));
    eastWall.name = 'East Wall';
    boundaryMeshes.push(eastWall);
    this._addCompassMarker('E', 0x388E3C, new THREE.Vector3(mapSize / 2, markerHeight, 0));
    this._addDebugLabel(eastWall, 'boundary');


    const westWall = new THREE.Mesh(
      this._prepareBoxGeometry(wallThickness, wallHeight, mapSize, { ...BOX_TEXTURE_SCALES, omitFaces: [BOX_FACE.NX] }),
      this._getSharedObstacleMaterials('boundary', createBoundaryTexture, createBoundaryTexture),
    );
    westWall.position.set(-mapSize / 2 - wallThickness / 2, wallHeight / 2, 0);
    westWall.castShadow = true;
    westWall.receiveShadow = true;
    this.worldGroup.add(this._tagDraws(westWall, 'scenery'));
    westWall.name = 'West Wall';
    boundaryMeshes.push(westWall);
    this._addCompassMarker('W', 0x9C27B0, new THREE.Vector3(-mapSize / 2, markerHeight, 0));
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
    this.worldGroup.add(this._tagDraws(sprite, 'scenery'));
    if (!this.compassMarkers) this.compassMarkers = [];
    this.compassMarkers.push(sprite);
  }

  _updateCompassMarkerHeights() {
    if (!this.compassMarkers || this.compassMarkers.length === 0) return;
    const wallHeight = 5;
    const markerHeight = Math.max(wallHeight + 8, this.maxObstacleHeight + 5);
    this.compassMarkers.forEach(marker => {
      marker.position.y = markerHeight;
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
  _addObstacleFragment(fragments, key, materials, geometry, matrix, color = null) {
    geometry.applyMatrix4(matrix);
    let fragment = fragments.get(key);
    if (!fragment) {
      fragment = {
        materials,
        // Only the bases carry one, and they carry it because it is what lets
        // every base on the map share one material whatever team holds it.
        colored: color !== null,
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
      // A vertex is copied once however many of this group's triangles use it.
      const remapped = new Map();
      for (let i = group.start; i < group.start + group.count; i += 1) {
        const vertex = index.getX(i);
        let mapped = remapped.get(vertex);
        if (mapped === undefined) {
          mapped = bucket.positions.length / 3;
          remapped.set(vertex, mapped);
          bucket.positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
          bucket.normals.push(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
          bucket.uvs.push(uv.getX(vertex), uv.getY(vertex));
          if (color) bucket.colors.push(color[0], color[1], color[2]);
        }
        bucket.indices.push(mapped);
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
      // It is built in world space and never moves.
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.worldGroup.add(mesh);
      this.obstacleMeshes.push(mesh);
    });
  }

  clearObstacles() {
    if (!this.scene) return;
    this.obstacleMeshes.forEach((mesh) => {
      this._clearObjectForRemoval(mesh);
    });
    this.obstacleMeshes = [];
    // After the meshes, so nothing is still pointing at them. The boundary walls
    // keep their own entry and are not cleared here.
    this._disposeSharedObstacleMaterials('box');
    this._disposeSharedObstacleMaterials('pyramid');
    this._disposeSharedObstacleMaterials('base');
    this._clearDebugLabels('obstacle');
  }

  setObstacles(obstacles = []) {
    if (!this.scene) return;
    this.clearObstacles();

    // Track max obstacle height for cardinal marker positioning
    this.maxObstacleHeight = 0;
    obstacles.forEach((obs) => {
      const h = obs.h || 4;
      const baseY = obs.baseY || 0;
      const topY = baseY + h;
      if (topY > this.maxObstacleHeight) {
        this.maxObstacleHeight = topY;
      }
    });

    // Boxes and pyramids collect here and become two meshes at the end.
    const fragments = new Map();
    const fragmentMatrix = new THREE.Matrix4();
    const fragmentPosition = new THREE.Vector3();
    const fragmentRotation = new THREE.Quaternion();
    const fragmentScale = new THREE.Vector3(1, 1, 1);
    const fragmentEuler = new THREE.Euler();

    obstacles.forEach((obs, i) => {
      const h = obs.h || 4;
      const baseY = obs.baseY || 0;
      let mesh = null;

      // What the obstacle's own mesh transform would have been, baked into the
      // vertices instead because the merged mesh cannot carry one per obstacle.
      const obstacleMatrix = () => {
        fragmentPosition.set(obs.x, baseY + h / 2, obs.z);
        fragmentRotation.setFromEuler(fragmentEuler.set(0, obs.rotation || 0, 0));
        return fragmentMatrix.compose(fragmentPosition, fragmentRotation, fragmentScale);
      };

      if (obs.kind === 'teleporter') {
        mesh = this._createTeleporterMesh(obs, i + 1);
        mesh.position.set(obs.x, baseY, obs.z);
        mesh.rotation.y = obs.rotation || 0;
        mesh.name = obs.name || `Teleporter ${i + 1}`;
        mesh.userData.teleporter = {
          border: Number(obs.border) || 0,
        };
        this.worldGroup.add(this._tagDraws(mesh, 'teleporter'));
        this._addDebugLabel(mesh, 'obstacle');
      } else if (obs.kind === 'base') {
        this._addObstacleFragment(
          fragments,
          'base',
          this._getSharedObstacleMaterials(
            'base', createBaseWallTexture, createBaseTopTexture, { vertexColors: true }
          ),
          // BaseSceneNodeGenerator.cxx:74 leaves the bottom out of a base that
          // sits on the ground, where nothing can see it.
          this._prepareBoxGeometry(obs.w, h, obs.d, {
            capRepeat: [1, 1],
            omitFaces: baseY > 0 ? [] : [BOX_FACE.NY],
          }),
          obstacleMatrix(),
          getBaseTeamTint(getPlayerTeamColor(getTeamFromColorIndex(obs.team || 1))),
        );
        this._addDebugLabelAt(
          obs.name || `Base ${i + 1}`,
          new THREE.Vector3(obs.x, baseY + h + 2, obs.z),
          'obstacle',
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
        if (obs.w > obs.d) {
          geometry.rotateY(Math.PI / 2);
        }
        geometry.scale(2 * obs.w, 1, 2 * obs.d);
        if (obs.inverted) {
          geometry.rotateX(Math.PI);
        }

        // The tiling rides on the vertices rather than on a texture of this
        // pyramid's own, so every pyramid in the world shares one pair of
        // materials. Same reasoning as the boxes above.
        const pyramidBaseSpan = Math.max(obs.w, obs.d);
        const pyramidSlantHeight = Math.hypot(h, pyramidBaseSpan / 2);
        this._bakeGroupUvTransform(geometry, 0, {
          repeatX: pyramidBaseSpan / PYRAMID_TEXTURE_SCALE,
          repeatY: pyramidSlantHeight / PYRAMID_TEXTURE_SCALE,
        });
        if (showPyramidBase) {
          this._bakeGroupUvTransform(geometry, 1, {
            repeatX: obs.w / PYRAMID_ROOF_TEXTURE_SCALE,
            repeatY: obs.d / PYRAMID_ROOF_TEXTURE_SCALE,
            // An inverted pyramid's base is seen from above, so its roof turns
            // with it.
            rotation: obs.inverted ? Math.PI : 0,
            centerX: 0.5,
            centerY: 0.5,
          });
        }

        this._addObstacleFragment(
          fragments,
          'pyramid',
          this._getSharedObstacleMaterials(
            'pyramid', createPyramidTexture, createRoofTexture, { flatShading: true }
          ),
          geometry,
          obstacleMatrix(),
        );
        this._addDebugLabelAt(
          obs.name || `Pyramid ${i + 1}`,
          new THREE.Vector3(obs.x, baseY + h + 2, obs.z),
          'obstacle',
        );
      } else {
        this._addObstacleFragment(
          fragments,
          'box',
          this._getSharedObstacleMaterials('box', createBoxWallTexture, createRoofTexture),
          // BoxSceneNodeGenerator.cxx:66, in its own words: "Don't generate the
          // bottom polygon if on the ground (or lower)".
          this._prepareBoxGeometry(obs.w, h, obs.d, {
            ...BOX_TEXTURE_SCALES,
            omitFaces: baseY > 0 ? [] : [BOX_FACE.NY],
          }),
          obstacleMatrix(),
        );
        this._addDebugLabelAt(
          obs.name || `Box ${i + 1}`,
          new THREE.Vector3(obs.x, baseY + h + 2, obs.z),
          'obstacle',
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

  setDebugLabelsEnabled(enabled) {
    this.debugLabelsEnabled = enabled;
    this._updateDebugLabelsVisibility();
  }

  _createDebugLabelSprite(name) {
    const labelMaterial = new THREE.SpriteMaterial({
      depthTest: true,
      depthWrite: false,
      transparent: true,
      alphaTest: 0.1,
    });
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(4, 1, 1);
    this.updateSpriteLabel(label, name || '', '#ffffff');
    return label;
  }

  // For an obstacle with no mesh of its own, because it was merged into a
  // fragment with every other obstacle of its kind. The position is in world
  // space and the label hangs off the world group rather than off the obstacle.
  _addDebugLabelAt(name, position, type) {
    const label = this._tagDraws(this._createDebugLabelSprite(name), 'debug');
    label.position.copy(position);
    this.worldGroup.add(label);
    label.visible = this.debugLabelsEnabled;
    this.debugLabels.push({ label, object3D: this.worldGroup, type });
  }

  _addDebugLabel(object3D, type) {
    if (!object3D) return;
    // Tagged even though it hangs off its subject, so it is counted as the
    // debug it is rather than as whatever it is labelling.
    const label = this._tagDraws(this._createDebugLabelSprite(object3D.name), 'debug');
    // Ensure boundingBox is computed for label placement
    if (object3D.geometry && !object3D.geometry.boundingBox) object3D.geometry.computeBoundingBox();
    const y = (object3D.geometry && object3D.geometry.boundingBox ? object3D.geometry.boundingBox.max.y : object3D.position.y) + 2;
    label.position.set(0, y, 0);
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

  clearMountains() {
    if (!this.scene) return;
    this.mountainMeshes.forEach((mesh) => {
      this.worldGroup.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((mat) => mat.dispose());
        } else {
          mesh.material.dispose();
        }
      }
    });
    this.mountainMeshes = [];
  }

  _createSharedImageTexture(path) {
    const source = this._getSharedImage(path);
    const texture = new THREE.Texture();
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;

    const applyImage = (image) => {
      if (!image) return;
      texture.image = image;
      texture.needsUpdate = true;
    };

    if (source.loaded) {
      applyImage(source.image);
    } else if (!source.error) {
      source.listeners.push((image) => {
        applyImage(image);
      });
    }

    return texture;
  }

  _createMountainStripGeometry(radius, height, startAngle, angleLength, segmentCount, textureWidth = 512) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const angleStep = angleLength / segmentCount;

    for (let i = 0; i <= segmentCount; i += 1) {
      const angle = startAngle + angleStep * i;
      const x = radius * Math.cos(angle);
      const z = radius * Math.sin(angle);
      const nx = -Math.SQRT1_2 * Math.cos(angle);
      const nz = -Math.SQRT1_2 * Math.sin(angle);
      let u = i / segmentCount;
      if (MOUNTAIN_TEXTURE_PATHS.length !== 1) {
        u = (u * (textureWidth - 2) + 1) / textureWidth;
      }

      positions.push(x, 0, z);
      positions.push(x, height, z);

      normals.push(nx, Math.SQRT1_2, nz);
      normals.push(nx, Math.SQRT1_2, nz);

      uvs.push(u, 0.02);
      uvs.push(u, 0.99);
    }

    for (let i = 0; i < segmentCount; i += 1) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(indices);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    return geometry;
  }

  _ensureMountainViewDistance(mapSize) {
    if (!this.camera || !Number.isFinite(mapSize) || mapSize <= 0) return;
    const mountainRadius = 2.25 * mapSize;
    const desiredFar = mountainRadius + (0.75 * mapSize) + 200;
    if (this.camera.far < desiredFar) {
      this.camera.far = desiredFar;
      this.camera.updateProjectionMatrix();
    }
  }

  createMountains(mapSize) {
    if (!this.scene) return;
    this.clearMountains();

    this._ensureMountainViewDistance(mapSize);

    const mountainDistance = 2.25 * mapSize;
    const mountainHeight = 0.9 * mapSize;
    const numMountainTextures = MOUNTAIN_TEXTURE_PATHS.length;
    const numFacesPerTexture = Math.ceil(BZFLAG_MOUNTAIN_FACE_COUNT / numMountainTextures);
    const angleScale = Math.PI / (numMountainTextures * numFacesPerTexture);
    const segmentAngle = angleScale * numFacesPerTexture;

    for (let textureIndex = 0, n = Math.floor(numFacesPerTexture / 2);
      textureIndex < numMountainTextures;
      textureIndex += 1, n += numFacesPerTexture) {
      const texture = this._createSharedImageTexture(MOUNTAIN_TEXTURE_PATHS[textureIndex]);
      const material = new THREE.MeshLambertMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.02,
        side: THREE.DoubleSide,
      });

      const frontGeometry = this._createMountainStripGeometry(
        mountainDistance,
        mountainHeight,
        angleScale * n,
        segmentAngle,
        numFacesPerTexture,
      );
      const frontMountain = new THREE.Mesh(frontGeometry, material);
      frontMountain.receiveShadow = false;
      frontMountain.castShadow = false;
      this.worldGroup.add(this._tagDraws(frontMountain, 'scenery'));
      this.mountainMeshes.push(frontMountain);

      const backGeometry = this._createMountainStripGeometry(
        mountainDistance,
        mountainHeight,
        Math.PI + angleScale * n,
        segmentAngle,
        numFacesPerTexture,
      );
      const backMountain = new THREE.Mesh(backGeometry, material.clone());
      backMountain.receiveShadow = false;
      backMountain.castShadow = false;
      this.worldGroup.add(this._tagDraws(backMountain, 'scenery'));
      this.mountainMeshes.push(backMountain);
    }
  }

  clearCelestialBodies() {
    if (!this.scene) return;
    // All three share one sphere, so it is disposed once rather than per mesh.
    const geometries = new Set();
    this.celestialMeshes.forEach((mesh) => {
      this.worldGroup.remove(mesh);
      if (mesh.geometry) geometries.add(mesh.geometry);
      if (mesh.material) mesh.material.dispose();
    });
    geometries.forEach((geometry) => geometry.dispose());
    this.celestialMeshes = [];
    this.sunMesh = null;
    this.sunGlowMesh = null;
    this.moonMesh = null;
  }

  // Unit spheres, scaled to the radius the caller worked out from the distance,
  // so a bigger map moves them further out without shrinking them. They draw
  // before the rest of the world and write no depth, which is how upstream ends
  // up with the mountains in front of a low sun even though the sun is nearer
  // than they are.
  _updateCelestialBodies({
    sunX, sunY, sunZ, moonX, moonY, moonZ, sunColor,
    sunRadius, moonRadius, sunVisible = true, moonVisible = true,
  }) {
    if (!this.scene || !this.worldGroup) return;
    if (!this.celestialEnabled) {
      this.clearCelestialBodies();
      return;
    }

    if (!this.sunMesh || !this.sunGlowMesh || !this.moonMesh) {
      this.clearCelestialBodies();

      const celestialGeometry = new THREE.SphereGeometry(1, 32, 32);
      const addCelestialMesh = (material, renderOrder) => {
        const mesh = this._tagDraws(new THREE.Mesh(celestialGeometry, material), 'scenery');
        mesh.renderOrder = renderOrder;
        this.worldGroup.add(mesh);
        this.celestialMeshes.push(mesh);
        return mesh;
      };

      this.sunMesh = addCelestialMesh(new THREE.MeshBasicMaterial({
        color: 0xffff00, fog: false, depthTest: true, depthWrite: false, toneMapped: false,
      }), CELESTIAL_RENDER_ORDER);
      this.sunGlowMesh = addCelestialMesh(new THREE.MeshBasicMaterial({
        color: 0xffff88, transparent: true, opacity: 0.3, fog: false,
        depthTest: true, depthWrite: false, toneMapped: false,
      }), CELESTIAL_RENDER_ORDER - 1);
      this.moonMesh = addCelestialMesh(new THREE.MeshBasicMaterial({
        color: 0xcccccc, fog: false, depthTest: true, depthWrite: false, toneMapped: false,
      }), CELESTIAL_RENDER_ORDER);
    }

    this.sunMesh.visible = !!sunVisible;
    this.sunGlowMesh.visible = !!sunVisible;
    this.moonMesh.visible = !!moonVisible;

    this.sunMesh.position.set(sunX, sunY, sunZ);
    this.sunGlowMesh.position.set(sunX, sunY, sunZ);
    this.moonMesh.position.set(moonX, moonY, moonZ);

    this.sunMesh.scale.setScalar(sunRadius);
    this.sunGlowMesh.scale.setScalar(sunRadius * CELESTIAL_GLOW_RATIO);
    this.moonMesh.scale.setScalar(moonRadius);

    if (sunColor) {
      this.sunMesh.material.color.copy(sunColor);
      this.sunGlowMesh.material.color.copy(sunColor).lerp(new THREE.Color(0xffffff), 0.2);
    }
  }

  clearClouds() {
    if (!this.scene) return;
    this.clouds.forEach((cloud) => {
      this.worldGroup.remove(cloud);
      // A cloud owns its geometry outright; the material is the sky's.
      cloud.geometry.dispose();
    });
    this.clouds = [];
  }

  // One white for every cloud in the sky. Nothing about a puff varies but where
  // it is and how big, so nothing about the material can.
  _getCloudMaterial() {
    if (!this._cloudMaterial) {
      this._cloudMaterial = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.7,
      });
    }
    return this._cloudMaterial;
  }

  // A cloud's puffs as one geometry. They were a mesh each, which on a world of
  // fifteen clouds of five to twelve puffs is around 125 draws for a decoration
  // in the sky -- measured as the second largest thing in a headset frame,
  // behind the tanks and ahead of everything the map is made of.
  //
  // Merged per cloud rather than all into one, because a cloud is what moves:
  // each drifts at its own speed, so a mesh each keeps the animation a
  // translation and asks nothing of the geometry per frame. It also leaves the
  // clouds sorted against each other, which a single mesh would not; what is
  // given up is sorting between the puffs of one cloud, and those are the same
  // white at the same opacity, so there is nothing in it to see.
  _buildCloudGeometry(puffs) {
    const positions = [];
    const normals = [];
    const indices = [];
    puffs.forEach((puff) => {
      const sphere = new THREE.SphereGeometry(puff.radius, 8, 8);
      sphere.translate(puff.offsetX, puff.offsetY, puff.offsetZ);
      const position = sphere.getAttribute('position');
      const normal = sphere.getAttribute('normal');
      const index = sphere.getIndex();
      const offset = positions.length / 3;
      for (let vertex = 0; vertex < position.count; vertex += 1) {
        positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
        normals.push(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
      }
      for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
      sphere.dispose();
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  createClouds(cloudsData = []) {
    if (!this.scene) return;
    this.clearClouds();

    cloudsData.forEach((cloudData) => {
      const cloud = this._tagDraws(
        new THREE.Mesh(this._buildCloudGeometry(cloudData.puffs), this._getCloudMaterial()),
        'cloud',
      );
      cloud.position.set(cloudData.x, cloudData.y, cloudData.z);
      cloud.userData.velocity = 0.5 + Math.random() * 1.0;
      cloud.userData.startX = cloudData.x;

      this.worldGroup.add(cloud);
      this.clouds.push(cloud);
    });
  }

  getClouds() {
    return this.clouds;
  }

  _preloadTankModel(modelPath = this._tankModelPath) {
    const loadPath = modelPath || '/obj/bzflag.obj';
    if (this._tankTemplateByPath.has(loadPath) || this._tankModelLoadsInFlight.has(loadPath)) {
      return;
    }

    const loader = new OBJLoader();
    this._tankModelLoadsInFlight.add(loadPath);
    const onLoad = (obj) => {
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
          if (Math.abs(normal.y) >= Math.abs(normal.x) && Math.abs(normal.y) >= Math.abs(normal.z)) {
            materialIndex = normal.y >= 0 ? 2 : 3;
          }

          geometry.addGroup(base, 3, materialIndex);
        }
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

    const box = mesh.geometry.boundingBox;
    const centerX = box ? (box.min.x + box.max.x) * 0.5 : 0;
    const direction = directionHint || Math.sign(centerX);
    if (!direction) return;

    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.translate(direction * TANK_WHEEL_OUTWARD_NUDGE, 0, 0);
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

  _createTankFromTemplate(color = 0x4caf50, name = '', modelPath = this._tankModelPath) {
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

    if (!templateParts.body || !templateParts.turret || !templateParts.barrel) {
      return null;
    }

    if ((!hasLeftTread || !hasRightTread) && !hasWheelPairs) {
      return null;
    }

    const tankGroup = this._tagDraws(new THREE.Group(), 'tank');

    if (name) {
      const spriteMaterial = new THREE.SpriteMaterial({
        depthTest: true,
        depthWrite: false,
        transparent: true,
        alphaTest: 0.1,
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(0, 3, 0);
      sprite.scale.set(2, 0.5, 1);
      tankGroup.add(sprite);
      tankGroup.userData.nameLabel = sprite;
      this.updateSpriteLabel(sprite, name, color);
    }

    const bodyTexture = this._createTankTexture(color);
    const treadTexture = this._createTreadTexture();
    const treadTextureRotated = treadTexture.clone();
    treadTextureRotated.rotation = Math.PI / 2;
    treadTextureRotated.center.set(0.5, 0.5);
    treadTextureRotated.needsUpdate = true;
    const treadCapTexture = this._createTreadCapTexture(color);

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

    tankGroup.userData.leftTreadTextures = leftTread ? leftTread.textures : [];
    tankGroup.userData.rightTreadTextures = rightTread ? rightTread.textures : [];

    const leftWheels = this._buildWheels(leftWheelParts, -1);
    const rightWheels = this._buildWheels(rightWheelParts, 1);
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
      const radiusY = (box.max.y - box.min.y) * 0.5;
      const radiusZ = (box.max.z - box.min.z) * 0.5;
      tankGroup.userData.wheelRadius = Math.max(0.05, Math.max(radiusY, radiusZ));
    } else {
      tankGroup.userData.wheelRadius = 0.42;
    }

    tankGroup.userData.treadGroups = [leftTread?.group, rightTread?.group].filter(Boolean);
    tankGroup.userData.treadGroups.forEach((group) => tankGroup.add(group));

    const turretTexture = bodyTexture.clone();
    turretTexture.wrapS = THREE.RepeatWrapping;
    turretTexture.wrapT = THREE.RepeatWrapping;
    turretTexture.repeat.set(6.28 / 4, 0.8 / 4);
    turretTexture.needsUpdate = true;
    const turretMaterial = new THREE.MeshLambertMaterial({ map: turretTexture });
    const turret = this._cloneTemplateMesh(templateParts.turret, turretMaterial);
    tankGroup.add(turret);
    tankGroup.userData.turret = turret;

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

  createTank(color = 0x4caf50, name = '', modelPath = this._tankModelPath) {
    const templateTank = this._createTankFromTemplate(color, name, modelPath);
    if (templateTank) {
      templateTank.userData.modelPath = modelPath;
      return templateTank;
    }

    const tankGroup = this._tagDraws(new THREE.Group(), 'tank');
    tankGroup.userData.modelPath = modelPath;

    if (name) {
      const spriteMaterial = new THREE.SpriteMaterial({
        depthTest: true,
        depthWrite: false,
        transparent: true,
        alphaTest: 0.1,
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(0, 3, 0);
      sprite.scale.set(2, 0.5, 1);
      tankGroup.add(sprite);
      tankGroup.userData.nameLabel = sprite;
      this.updateSpriteLabel(sprite, name, color);
    }

    const bodyTexture = this._createTankTexture(color);
    const treadTexture = this._createTreadTexture();
    const treadTextureRotated = treadTexture.clone();
    treadTextureRotated.rotation = Math.PI / 2;
    treadTextureRotated.center.set(0.5, 0.5);
    treadTextureRotated.needsUpdate = true;
    const treadCapTexture = this._createTreadCapTexture(color);

    const treadCapTextureSide = treadCapTexture.clone();
    treadCapTextureSide.repeat.set(3.0, 1.0);
    treadCapTextureSide.wrapS = THREE.RepeatWrapping;
    treadCapTextureSide.wrapT = THREE.RepeatWrapping;
    treadCapTextureSide.needsUpdate = true;

    const bodyGeometry = this._tankGeoCache?.body ?? new THREE.BoxGeometry(3, 1, 4);
    const bodyMaterial = new THREE.MeshLambertMaterial({ map: bodyTexture });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 0.8;
    body.castShadow = true;
    body.receiveShadow = true;
    tankGroup.add(body);
    tankGroup.userData.body = body;

    const treadCapMat = new THREE.MeshLambertMaterial({ map: treadCapTexture });

    const leftTreadGroup = new THREE.Group();
    leftTreadGroup.position.set(-1.1375, 0.6, 0);

    tankGroup.userData.leftTreadTextures = [];
    tankGroup.userData.rightTreadTextures = [];

    const treadHeight = 1.2;            // BZFlag exposed treadHeight
    const treadWidth = 0.525;           // BZFlag exposed treadWidth (treadOutside - treadInside)
    const treadCapRadius = treadHeight / 2;
    const treadMiddleLength = 4.8;      // BZFlag fullLength - treadHeight = 6.0 - 1.2
    const treadMiddleGeom = this._tankGeoCache?.treadMiddle ?? new THREE.BoxGeometry(treadWidth, treadHeight, treadMiddleLength);
    const leftTreadRotatedTex = treadTextureRotated.clone();
    leftTreadRotatedTex.wrapS = THREE.RepeatWrapping;
    leftTreadRotatedTex.wrapT = THREE.RepeatWrapping;
    const leftTreadRotatedMat = new THREE.MeshLambertMaterial({ map: leftTreadRotatedTex });
    const treadCapMatSide = new THREE.MeshLambertMaterial({ map: treadCapTextureSide });
    const leftTreadMiddle = new THREE.Mesh(
      treadMiddleGeom,
      [treadCapMatSide, treadCapMatSide, leftTreadRotatedMat, leftTreadRotatedMat, treadCapMatSide, treadCapMatSide],
    );
    leftTreadMiddle.castShadow = true;
    leftTreadGroup.add(leftTreadMiddle);
    tankGroup.userData.leftTreadTextures.push(leftTreadRotatedTex);

    const treadCapGeom = this._tankGeoCache?.treadFrontCap ?? new THREE.CylinderGeometry(treadCapRadius, treadCapRadius, treadWidth, 16, 1, false, 0, Math.PI);
    const treadCapGeomRear = this._tankGeoCache?.treadRearCap ?? new THREE.CylinderGeometry(treadCapRadius, treadCapRadius, treadWidth, 16, 1, false, Math.PI, Math.PI);
    // OBJ-loaded caps have 2 groups (tread_side, tread_cap); procedural have 3
    const capGroups = treadCapGeom.groups.length;
    const leftTreadFrontTex = treadTexture.clone();
    leftTreadFrontTex.wrapS = THREE.RepeatWrapping;
    leftTreadFrontTex.wrapT = THREE.RepeatWrapping;
    const leftTreadFrontMat = new THREE.MeshLambertMaterial({ map: leftTreadFrontTex });
    const leftTreadFront = new THREE.Mesh(treadCapGeom, capGroups === 2 ? [leftTreadFrontMat, treadCapMat] : [leftTreadFrontMat, treadCapMat, treadCapMat]);
    leftTreadFront.rotation.x = Math.PI / 2;
    leftTreadFront.rotation.z = Math.PI / 2;
    leftTreadFront.position.z = treadMiddleLength / 2;
    leftTreadFront.castShadow = true;
    leftTreadGroup.add(leftTreadFront);
    tankGroup.userData.leftTreadTextures.push(leftTreadFrontTex);

    const leftTreadRearTex = treadTexture.clone();
    leftTreadRearTex.wrapS = THREE.RepeatWrapping;
    leftTreadRearTex.wrapT = THREE.RepeatWrapping;
    const leftTreadRearMat = new THREE.MeshLambertMaterial({ map: leftTreadRearTex });
    const leftTreadRear = new THREE.Mesh(treadCapGeomRear, capGroups === 2 ? [leftTreadRearMat, treadCapMat] : [leftTreadRearMat, treadCapMat, treadCapMat]);
    leftTreadRear.rotation.x = Math.PI / 2;
    leftTreadRear.rotation.z = Math.PI / 2;
    leftTreadRear.position.z = -treadMiddleLength / 2;
    leftTreadRear.castShadow = true;
    leftTreadGroup.add(leftTreadRear);
    tankGroup.userData.leftTreadTextures.push(leftTreadRearTex);

    tankGroup.add(leftTreadGroup);

    const rightTreadGroup = new THREE.Group();
    rightTreadGroup.position.set(1.1375, 0.6, 0);

    const rightTreadRotatedTex = treadTextureRotated.clone();
    rightTreadRotatedTex.wrapS = THREE.RepeatWrapping;
    rightTreadRotatedTex.wrapT = THREE.RepeatWrapping;
    const rightTreadRotatedMat = new THREE.MeshLambertMaterial({ map: rightTreadRotatedTex });
    const rightTreadMiddle = new THREE.Mesh(
      treadMiddleGeom,
      [treadCapMatSide, treadCapMatSide, rightTreadRotatedMat, rightTreadRotatedMat, treadCapMatSide, treadCapMatSide],
    );
    rightTreadMiddle.castShadow = true;
    rightTreadGroup.add(rightTreadMiddle);
    tankGroup.userData.rightTreadTextures.push(rightTreadRotatedTex);

    const rightTreadFrontTex = treadTexture.clone();
    rightTreadFrontTex.wrapS = THREE.RepeatWrapping;
    rightTreadFrontTex.wrapT = THREE.RepeatWrapping;
    const rightTreadFrontMat = new THREE.MeshLambertMaterial({ map: rightTreadFrontTex });
    const rightTreadFront = new THREE.Mesh(treadCapGeom, capGroups === 2 ? [rightTreadFrontMat, treadCapMat] : [rightTreadFrontMat, treadCapMat, treadCapMat]);
    rightTreadFront.rotation.x = Math.PI / 2;
    rightTreadFront.rotation.z = Math.PI / 2;
    rightTreadFront.position.z = treadMiddleLength / 2;
    rightTreadFront.castShadow = true;
    rightTreadGroup.add(rightTreadFront);
    tankGroup.userData.rightTreadTextures.push(rightTreadFrontTex);

    const rightTreadRearTex = treadTexture.clone();
    rightTreadRearTex.wrapS = THREE.RepeatWrapping;
    rightTreadRearTex.wrapT = THREE.RepeatWrapping;
    const rightTreadRearMat = new THREE.MeshLambertMaterial({ map: rightTreadRearTex });
    const rightTreadRear = new THREE.Mesh(treadCapGeomRear, capGroups === 2 ? [rightTreadRearMat, treadCapMat] : [rightTreadRearMat, treadCapMat, treadCapMat]);
    rightTreadRear.rotation.x = Math.PI / 2;
    rightTreadRear.rotation.z = Math.PI / 2;
    rightTreadRear.position.z = -treadMiddleLength / 2;
    rightTreadRear.castShadow = true;
    rightTreadGroup.add(rightTreadRear);
    tankGroup.userData.rightTreadTextures.push(rightTreadRearTex);

    tankGroup.add(rightTreadGroup);

    const turretGeometry = this._tankGeoCache?.turret ?? new THREE.CylinderGeometry(1, 1, 0.8, 32);
    const turretTexture = bodyTexture.clone();
    turretTexture.wrapS = THREE.RepeatWrapping;
    turretTexture.wrapT = THREE.RepeatWrapping;
    turretTexture.repeat.set(6.28 / 4, 0.8 / 4);
    turretTexture.needsUpdate = true;
    const turretMaterial = new THREE.MeshLambertMaterial({ map: turretTexture });
    const turret = new THREE.Mesh(turretGeometry, turretMaterial);
    turret.position.y = 1.7;
    turret.castShadow = true;
    tankGroup.add(turret);
    tankGroup.userData.turret = turret;

    const barrelGeometry = this._tankGeoCache?.barrel ?? new THREE.CylinderGeometry(0.2, 0.2, 3, 8);
    const barrelMaterial = new THREE.MeshLambertMaterial({ color: 0x333333 });
    const barrel = new THREE.Mesh(barrelGeometry, barrelMaterial);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 1.7, -1.5);
    barrel.castShadow = true;
    tankGroup.add(barrel);
    tankGroup.userData.barrel = barrel;
    this._setTankMuzzleData(tankGroup, barrel);

    tankGroup.userData.leftWheels = [];
    tankGroup.userData.rightWheels = [];
    tankGroup.userData.leftWheelTextures = [];
    tankGroup.userData.rightWheelTextures = [];
    tankGroup.userData.wheelRadius = 0.495;

    tankGroup.userData.treadGroups = [leftTreadGroup, rightTreadGroup];
    tankGroup.userData.explodableParts = [
      body,
      turret,
      barrel,
      leftTreadGroup,
      rightTreadGroup,
    ];

    return tankGroup;
  }

  createGhostMesh(tank) {
    // Create a semi-transparent ghost version of a tank for showing server-confirmed position
    const ghostTank = tank.clone(true); // Deep clone the tank

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

    // Scale slightly larger to wrap around the tank (1.05x = 5% larger)
    ghostTank.scale.set(1.05, 1.05, 1.05);

    ghostTank.traverse((child) => {
      if (child.isMesh && child.material) {
        // Clone materials to avoid shared references
        if (Array.isArray(child.material)) {
          child.material = child.material.map(mat => {
            const cloned = mat.clone();
            cloned.transparent = true;
            cloned.opacity = 0.25;
            cloned.color.setHex(0xffffff);
            cloned.emissive.setHex(0x404040);
            cloned.emissiveIntensity = 0.2;
            return cloned;
          });
        } else {
          child.material = child.material.clone();
          child.material.transparent = true;
          child.material.opacity = 0.25;
          child.material.color.setHex(0xffffff);
          child.material.emissive.setHex(0x404040);
          child.material.emissiveIntensity = 0.2;
        }
      } else if (child.isSprite && child.material) {
        // Make sprite label (name) transparent to match ghost opacity
        child.material = child.material.clone();
        child.material.opacity = 0.25;
        child.material.transparent = true;
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

    if (!sprite.material.map) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      sprite.material.map = new THREE.CanvasTexture(canvas);
      sprite.material.needsUpdate = true;
    }

    const texture = sprite.material.map;
    const canvas = texture.image;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = 'bold 36px Arial';
    context.fillStyle = cssColor;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(name, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
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

  _paintTintedBZFlagTankTexture(ctx, canvas, image, baseColor) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!image) {
      ctx.fillStyle = '#777777';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const tint = new THREE.Color(baseColor);
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
      const shaded = 0.28 + (luminance * 0.92);
      data[i] = Math.max(0, Math.min(255, tintR * shaded));
      data[i + 1] = Math.max(0, Math.min(255, tintG * shaded));
      data[i + 2] = Math.max(0, Math.min(255, tintB * shaded));
    }

    ctx.putImageData(imageData, 0, 0);
  }

  _createTankTexture(baseColor) {
    return this._createTintedTexture(
      '/textures/green_tank.png', 128, 128, this._paintTintedBZFlagTankTexture, baseColor,
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
    const tint = new THREE.Color(baseColor);
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

  _createBoltTexture(baseColor) {
    return this._createTintedTexture(
      '/textures/green_bolt.png', 64, 64, this._paintTintedBZFlagBoltTexture, baseColor);
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
    const tint = new THREE.Color(baseColor);
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

  _createShotExplosionTexture() {
    const sourcePath = SHOT_EXPLOSION_TEXTURES[Math.floor(Math.random() * SHOT_EXPLOSION_TEXTURES.length)];
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
    texture.repeat.set(1 / 8, 1 / 8);
    texture.offset.set(0, 0);

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

  createShotImpact(position) {
    if (!this.scene || !position) return;

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

    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.set(BZFLAG_SHOT_EXPLOSION_SIZE, BZFLAG_SHOT_EXPLOSION_SIZE, 1);
    sprite.renderOrder = SHOT_EXPLOSION_RENDER_ORDER;
    this.worldGroup.add(this._tagDraws(sprite, 'effect'));

    let light = null;
    if (this._dynamicLightingActive()) {
      light = this._createDynamicLight(0xffcc80, bzflagLightIntensity(BZFLAG_SHOT_IMPACT_LIGHT_SCALE));
      light.position.copy(position);
    }

    this.activeShotExplosions.push({
      sprite,
      material,
      texture,
      duration: BZFLAG_SHOT_EXPLOSION_DURATION,
      age: 0,
      light,
      lightFadeStart: BZFLAG_SHOT_EXPLOSION_DURATION * BZFLAG_SHOT_EXPLOSION_LIGHT_FADE_START_RATIO,
      lightBaseIntensity: light ? light.intensity : 0,
    });
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

  _createTreadCapTexture(baseColor = 0x646464) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    const color = new THREE.Color(baseColor);
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
    this.worldGroup.add(this._tagDraws(sphere, 'effect'));
    return sphere;
  }

  removePausedSphere(sphere) {
    if (!sphere || !this.scene) return;
    this.worldGroup.remove(sphere);
    if (sphere.geometry) sphere.geometry.dispose();
    if (sphere.material) sphere.material.dispose();
  }

  createLandingEffect(position, intensity = 1, { local = false } = {}) {
    if (!this.scene || !position) return;
    const clampedIntensity = Math.max(0.4, Math.min(1.6, intensity || 1));
    // BZFlag has no per-sound gain, so landing volume does not vary with impact
    // speed. The intensity argument still drives the visual landing effect.
    if (local) this.playLocalSound('land');
    else this.playSound('land', position);

    const ringGeometry = new THREE.RingGeometry(0.5, 0.9, 48);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1.0,
      depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(position.x, position.y + 0.03, position.z);

    const startRadius = 2.5;
    ring.scale.set(startRadius, startRadius, 1);

    this.worldGroup.add(this._tagDraws(ring, 'effect'));
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

  createSpawnEffect(position, color = 0x4caf50) {
    if (!this.scene || !position) return;
    this.playSound('pop', position);

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
    ring.rotation.x = Math.PI / 2;
    ring.position.set(position.x, position.y + 0.05, position.z);
    ring.scale.set(0.7, 0.7, 1);

    const columnGeometry = new THREE.CylinderGeometry(0.28, 0.55, 3.0, 18, 1, true);
    const columnMaterial = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const column = new THREE.Mesh(columnGeometry, columnMaterial);
    column.position.set(position.x, position.y + 1.5, position.z);
    column.scale.set(0.4, 0.3, 0.4);

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
    topRing.rotation.x = Math.PI / 2;
    topRing.position.set(position.x, position.y + 1.35, position.z);
    topRing.scale.set(0.65, 0.65, 1);

    this.worldGroup.add(this._tagDraws(ring, 'effect'));
    this.worldGroup.add(this._tagDraws(column, 'effect'));
    this.worldGroup.add(this._tagDraws(topRing, 'effect'));

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
    const projectileTexture = this._createBoltTexture(projectileColor);
    const headMaterial = new THREE.SpriteMaterial({
      map: projectileTexture,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
    });
    const projectile = new THREE.Group();
    projectile.position.set(data.x, data.y, data.z);

    const head = new THREE.Sprite(headMaterial);
    head.scale.set(1.35, 1.35, 1);
    head.renderOrder = SHOT_RENDER_ORDER;

    const dir = new THREE.Vector3(data.dirX || 0, 0, data.dirZ || -1);
    if (dir.lengthSq() < 0.0001) {
      dir.set(0, 0, -1);
    } else {
      dir.normalize();
    }
    const tailSegmentCount = 6;
    const tailTexture = this._createShotTailTexture(projectileColor);
    const tailSegments = [];
    let uvCell = Math.floor(Math.random() * 16);
    for (let i = 0; i < tailSegmentCount; i += 1) {
      uvCell = (uvCell + 1) % 16;
      const u = (uvCell % 4) * 0.25;
      const v = Math.floor(uvCell / 4) * 0.25;
      const segmentTexture = tailTexture.clone();
      segmentTexture.repeat.set(0.25, 0.25);
      segmentTexture.offset.set(u, v);
      segmentTexture.needsUpdate = true;

      const segmentMaterial = new THREE.SpriteMaterial({
        map: segmentTexture,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        opacity: 0.74 - (i * 0.1),
        blending: THREE.AdditiveBlending,
      });
      const segment = new THREE.Sprite(segmentMaterial);
      const scale = 0.78 - (i * 0.08);
      segment.scale.set(scale, scale, 1);
      segment.renderOrder = SHOT_RENDER_ORDER;
      const distance = 0.34 + (i * 0.28);
      segment.position.set(-dir.x * distance, 0, -dir.z * distance);
      projectile.add(segment);
      tailSegments.push(segment);
    }
    projectile.renderOrder = SHOT_RENDER_ORDER;
    projectile.add(head);
    projectile.userData = {
      dirX: data.dirX,
      dirZ: data.dirZ,
      color: projectileColor,
      projectileTexture,
      head,
      tailSegments,
    };
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
    this.worldGroup.add(this._tagDraws(projectile, 'effect'));
    this.playSound('fire', projectile.position);
    this.createMuzzleFlash(projectile.position, dir);
    return projectile;
  }

  // LaserStrategy's laser scene nodes: one quad per segment of a path that was
  // built whole the moment the trigger was pulled. bzo takes the segments from
  // the server, which traced them, and draws a thin additive tube along each --
  // upstream textures its beam and bzo has no such texture, which is the only
  // difference. The group sits at the muzzle so the shot still has a position
  // for the radar and for its sounds.
  createShotBeam(data) {
    if (!this.scene) return null;
    const beamColor = typeof data.color === 'number' ? data.color : 0xffff00;
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const origin = segments.length > 0 ? segments[0].from : { x: data.x, y: data.y, z: data.z };
    const group = new THREE.Group();
    group.position.set(origin.x, origin.y, origin.z);
    group.renderOrder = SHOT_RENDER_ORDER;

    // One instanced draw per layer, however many bends the beam has: a
    // ricocheting laser on an enclosed map runs to makeSegments' hundred
    // segments, and a mesh apiece would be a hundred geometries built and thrown
    // away inside a third of a second.
    if (!this._laserGeometry) {
      this._laserGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    }
    const materials = [];
    const layers = [];
    const up = new THREE.Vector3(0, 1, 0);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const midpoint = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const drawn = segments.filter((segment) => segment?.from && segment?.to
      && Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y,
        segment.to.z - segment.from.z) > 0.01);

    for (const [radius, alpha] of BZFLAG_LASER_LAYERS) {
      if (drawn.length === 0) break;
      const material = new THREE.MeshBasicMaterial({
        color: beamColor,
        transparent: true,
        opacity: alpha,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
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
        midpoint.addVectors(from, to).multiplyScalar(0.5).sub(group.position);
        scale.set(radius, length, radius);
        mesh.setMatrixAt(index, matrix.compose(midpoint, orientation, scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
      materials.push(material);
      layers.push(mesh);
    }

    group.userData = { beam: true, beamMaterials: materials, beamLayers: layers, color: beamColor };
    this.worldGroup.add(this._tagDraws(group, 'effect'));
    // The shooter has already heard and seen its own shot leave the barrel; this
    // message is what tells it where the beam went.
    if (!data.silent) {
      this.playSound(typeof data.fireSound === 'string' ? data.fireSound : 'fire', group.position);
      if (drawn.length > 0) {
        const first = drawn[0];
        const flashDir = new THREE.Vector3(
          first.to.x - first.from.x, first.to.y - first.from.y, first.to.z - first.from.z
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
      const at = new THREE.Vector3(segments[i].from.x, segments[i].from.y, segments[i].from.z);
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

  removeProjectile(projectile, reason = 1) {
    if (!projectile || !this.scene) return;
    if (reason === 0) {
      this.createShotImpact(projectile.position);
    }
    // BZFlag plays SFX_SHOT_BOOM when a shot ends.
    this.playSound('shotBoom', projectile.position);
    // Remove point light from scene if present
    if (this.projectileLights) this.projectileLights.delete(projectile);
    this.worldGroup.remove(projectile);
    if (projectile.userData?.beam) {
      // The cylinder itself is shared between every beam ever drawn, so only the
      // per-beam instances and their materials are thrown away.
      for (const mesh of projectile.userData.beamLayers || []) mesh.dispose();
      for (const material of projectile.userData.beamMaterials || []) material.dispose();
      return;
    }
    if (projectile.userData?.head?.material?.map) projectile.userData.head.material.map.dispose();
    if (projectile.userData?.head?.material) projectile.userData.head.material.dispose();
    if (Array.isArray(projectile.userData?.tailSegments)) {
      for (const segment of projectile.userData.tailSegments) {
        if (segment?.material?.map) segment.material.map.dispose();
        if (segment?.material) segment.material.dispose();
      }
    }
  }

  createExplosion(position, tank) {
    if (!this.scene || !position) return;
    this.playSound('explosion', position);

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

    const geometry = new THREE.SphereGeometry(2, 16, 16);
    const material = new THREE.MeshBasicMaterial({ color: 0xff4500, transparent: true, opacity: 0.8 });
    const explosion = new THREE.Mesh(geometry, material);
    explosion.position.copy(position);
    this.worldGroup.add(this._tagDraws(explosion, 'effect'));

    const shockwaveGeometry = new THREE.TorusGeometry(1.6, 0.12, 8, 48);
    const shockwaveMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0.8,
      depthWrite: false
    });
    const shockwave = new THREE.Mesh(shockwaveGeometry, shockwaveMaterial);
    shockwave.rotation.x = Math.PI / 2;
    shockwave.position.set(position.x, Math.max(0.08, position.y + 0.08), position.z);
    this.worldGroup.add(this._tagDraws(shockwave, 'effect'));

    const debrisPieces = [];
    let followTarget = null;
    if (tank && tank.userData) {
      const tankWorldPos = tank.position.clone();
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

      this.worldGroup.updateWorldMatrix(true, false);
      parentInverseMatrix.copy(this.worldGroup.matrixWorld).invert();

      explodableParts.forEach((sourcePart) => {
        if (!sourcePart) return;

        const part = sourcePart.clone(true);
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

        part.position.copy(localPos);
        part.quaternion.copy(localQuat);
        part.scale.copy(localScale);

        let speedMultiplier = 0.9;
        if (sourcePart === tank.userData.body) speedMultiplier = 0.95;
        else if (sourcePart === tank.userData.turret) speedMultiplier = 0.8;
        else if (sourcePart === tank.userData.barrel) speedMultiplier = 0.6;

        const debrisPiece = this._launchTankPart(part, tankWorldPos, debrisPieces, speedMultiplier, {
          isFollowTarget: sourcePart === tank.userData.body,
          maxLifetime: sourcePart === tank.userData.body ? 5.0 : 3.2
        });
        if (sourcePart === tank.userData.body && debrisPiece) {
          followTarget = debrisPiece.mesh;
        }
      });
    }

    const debrisCount = 15;
    for (let i = 0; i < debrisCount; i += 1) {
      const size = Math.random() * 0.5 + 0.3;
      const debrisGeom = new THREE.BoxGeometry(size, size, size);
      const debrisMat = new THREE.MeshLambertMaterial({
        color: i % 3 === 0 ? 0x4caf50 : (i % 3 === 1 ? 0x666666 : 0xff5722),
      });
      const debris = new THREE.Mesh(debrisGeom, debrisMat);
      debris.position.copy(position);

      const angle = Math.random() * Math.PI * 2;
      const elevation = (Math.random() - 0.3) * Math.PI / 3;
      const speed = Math.random() * 15 + 10;
      debris.velocity = new THREE.Vector3(
        Math.cos(angle) * Math.cos(elevation) * speed,
        Math.sin(elevation) * speed + 5,
        Math.sin(angle) * Math.cos(elevation) * speed,
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
      this.worldGroup.add(this._tagDraws(debris, 'effect'));
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
      effect.column.scale.set(0.4 * columnPulse, 0.3 + (1 - progress) * 1.25, 0.4 * columnPulse);
      effect.columnMaterial.opacity = Math.max(0, 0.34 * (1 - progress));

      const topRingScale = 0.65 + progress * 1.45;
      effect.topRing.scale.set(topRingScale, topRingScale, 1);
      effect.topRing.position.y += dt * 1.8;
      effect.topRingMaterial.opacity = Math.max(0, 0.55 * (1 - progress));

      if (progress >= 1) {
        this.worldGroup.remove(effect.ring);
        this.worldGroup.remove(effect.column);
        this.worldGroup.remove(effect.topRing);
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
      effect.material.opacity = Math.max(0, 1.0 - progress);
      if (progress >= 1) {
        this.worldGroup.remove(effect.ring);
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
          this.worldGroup.remove(explosion.sphere);
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
          this.worldGroup.remove(explosion.shockwave);
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
          piece.mesh.velocity.y -= gravity * dt;
          piece.mesh.position.x += piece.mesh.velocity.x * dt;
          piece.mesh.position.y += piece.mesh.velocity.y * dt;
          piece.mesh.position.z += piece.mesh.velocity.z * dt;
          piece.mesh.rotation.x += piece.mesh.rotationVelocity.x * dt;
          piece.mesh.rotation.y += piece.mesh.rotationVelocity.y * dt;
          piece.mesh.rotation.z += piece.mesh.rotationVelocity.z * dt;

          const fadeStart = piece.maxLifetime * 0.7;
          if (piece.lifetime > fadeStart) {
            const fadeProgress = (piece.lifetime - fadeStart) / (piece.maxLifetime - fadeStart);
            this._fadeMaterial(piece.mesh.material, fadeProgress);
            piece.mesh.traverse((child) => {
              if (child.material) this._fadeMaterial(child.material, fadeProgress);
            });
          }

          if (piece.mesh.position.y < 0) {
            if (isPrimaryHull) {
              piece.mesh.position.y = 0;
              const bounceCount = piece.mesh.userData.groundBounces || 0;
              const verticalImpact = Math.abs(piece.mesh.velocity.y);
              if (bounceCount < 2 && verticalImpact > 1.2) {
                piece.mesh.userData.groundBounces = bounceCount + 1;
                piece.mesh.userData.grounded = false;
                piece.mesh.velocity.y = verticalImpact * (bounceCount === 0 ? 0.38 : 0.24);
                piece.mesh.velocity.x *= 0.82;
                piece.mesh.velocity.z *= 0.82;
                piece.mesh.rotationVelocity.multiplyScalar(0.72);
              } else {
                piece.mesh.userData.grounded = true;
                piece.mesh.velocity.y = 0;
                const skidDamping = Math.pow(0.22, dt / 0.016);
                piece.mesh.velocity.x *= skidDamping;
                piece.mesh.velocity.z *= skidDamping;
                piece.mesh.rotationVelocity.multiplyScalar(Math.pow(0.18, dt / 0.016));
                if ((piece.mesh.velocity.x * piece.mesh.velocity.x) + (piece.mesh.velocity.z * piece.mesh.velocity.z) < 0.04) {
                  piece.mesh.velocity.x = 0;
                  piece.mesh.velocity.z = 0;
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
        this.worldGroup.remove(effect.sprite);
        if (effect.material) effect.material.dispose();
        if (effect.texture) effect.texture.dispose();
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
    this.worldGroup.add(this._tagDraws(part, 'effect'));
    part.userData.isTankPart = true;
    part.userData.isPrimaryHull = Boolean(options.isFollowTarget);
    part.userData.groundBounces = 0;
    part.userData.grounded = false;
    const angle = Math.random() * Math.PI * 2;
    const elevation = (Math.random() - 0.15) * Math.PI / 4;
    const speed = (Math.random() * 6 + 6) * speedMultiplier;
    part.velocity = new THREE.Vector3(
      Math.cos(angle) * Math.cos(elevation) * speed,
      Math.sin(elevation) * speed + (options.isFollowTarget ? 7 : 5.5),
      Math.sin(angle) * Math.cos(elevation) * speed,
    );
    part.rotationVelocity = new THREE.Vector3(
      (Math.random() - 0.5) * (options.isFollowTarget ? 2.5 : 4.5),
      (Math.random() - 0.5) * (options.isFollowTarget ? 2.5 : 4.5),
      (Math.random() - 0.5) * (options.isFollowTarget ? 2.5 : 4.5),
    );
    const debrisPiece = {
      mesh: part,
      lifetime: 0,
      maxLifetime: options.maxLifetime || (options.isFollowTarget ? 3.5 : 2.0)
    };
    debrisPieces.push(debrisPiece);
    return debrisPiece;
  }

  _cleanupDebrisPiece(mesh) {
    if (mesh === this.deathFollowTarget) {
      this.deathFollowTarget = null;
    }
    this.worldGroup.remove(mesh);
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

  createMuzzleFlash(position, direction) {
    if (!this.scene || !position || !direction) return;

    const material = new THREE.MeshBasicMaterial({
      map: this._getFlashTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: BZFLAG_SHOT_FLASH_START_ALPHA,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this._buildMuzzleFlashGeometry(0), material);
    mesh.position.copy(position);
    mesh.lookAt(
      position.x + direction.x,
      position.y + direction.y,
      position.z + direction.z
    );
    this.worldGroup.add(this._tagDraws(mesh, 'effect'));

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
        this.worldGroup.remove(flash.mesh);
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
  createRicochetEffect(position, direction) {
    if (!this.scene || !position || !direction) return;
    const length = Math.hypot(direction.x, direction.y, direction.z);
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
    mesh.position.copy(position);
    mesh.lookAt(
      position.x + (direction.x / length),
      position.y + (direction.y / length),
      position.z + (direction.z / length)
    );
    this.worldGroup.add(this._tagDraws(mesh, 'effect'));

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
        this.worldGroup.remove(effect.mesh);
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
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      +w, 0, 0,
      -w, 0, 0,
      0, -l, 0,
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
        jet.mesh.scale.set(1, nextScale * jet.length, 1);
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
    const cameraLocal = tank.worldToLocal(this.camera.getWorldPosition(new THREE.Vector3()));
    mesh.rotation.y = Math.atan2(
      cameraLocal.x - mesh.position.x,
      cameraLocal.z - mesh.position.z
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
    // the world group's own space, which is where the tank's position already
    // is, and it stands only for the frame that asked.
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
    const mesh = new THREE.Mesh(this._buildShotTeleportGeometry(0), material);
    projectile.add(mesh);

    if (!this.shotTeleportEffects) this.shotTeleportEffects = [];
    this.shotTeleportEffects.push({ mesh, material, projectile, age: 0 });
  }

  updateShotTeleportEffects(deltaTime) {
    if (!this.shotTeleportEffects?.length || deltaTime <= 0) return;
    for (let i = this.shotTeleportEffects.length - 1; i >= 0; i -= 1) {
      const effect = this.shotTeleportEffects[i];
      effect.age += deltaTime;

      // Drop it once it expires, or once the shot it rides on is gone.
      if (effect.age >= BZFLAG_SHOT_TELEPORT_LIFETIME || !effect.mesh.parent) {
        effect.mesh.parent?.remove(effect.mesh);
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

  _getFlagTexture() {
    if (!this._flagTexture) {
      this._flagTexture = this._createSharedImageTexture(BZFLAG_FLAG_TEXTURE);
    }
    return this._flagTexture;
  }

  // FlagSceneNode::waveFlag steps eight wave sets once a frame and lets every
  // flag in the world share them, however many flags there are. bzo shares the
  // same eight BufferGeometry instances for the same reason: on a CPU-bound
  // client the cloth must not cost per flag.
  _getFlagWaveSets() {
    if (this._flagWaveSets) return this._flagWaveSets;

    const vertexCount = (BZFLAG_FLAG_CHUNKS + 1) * 2;
    // Upstream draws a GL_TRIANGLE_STRIP; the same vertices indexed as
    // triangles are the strip, and the cloth is double sided so the alternating
    // winding a strip implies does not matter.
    const indices = [];
    for (let vertex = 0; vertex < vertexCount - 2; vertex += 1) {
      indices.push(vertex, vertex + 1, vertex + 2);
    }
    const uvs = new Float32Array(vertexCount * 2);
    for (let chunk = 0; chunk <= BZFLAG_FLAG_CHUNKS; chunk += 1) {
      const u = chunk / BZFLAG_FLAG_CHUNKS;
      uvs[(chunk * 4) + 0] = u;
      uvs[(chunk * 4) + 1] = 1;
      uvs[(chunk * 4) + 2] = u;
      uvs[(chunk * 4) + 3] = 0;
    }

    this._flagWaveSets = [];
    for (let set = 0; set < BZFLAG_FLAG_WAVE_SETS; set += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs.slice(), 2));
      geometry.setIndex(indices);
      // The vertices move every frame, so the bounding sphere is set once to
      // cover the whole ripple rather than recomputed for each step.
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(BZFLAG_FLAG_WIDTH / 2, FLAG_POLE_SIZE + (BZFLAG_FLAG_HEIGHT / 2), 0),
        BZFLAG_FLAG_WIDTH
      );
      this._flagWaveSets.push({
        geometry,
        // Each set starts at its own phase so neighbouring flags do not ripple
        // in lockstep.
        ripple1: Math.random() * 2 * Math.PI,
        ripple2: Math.random() * 2 * Math.PI,
      });
    }
    this._stepFlagWaveSets(0);
    return this._flagWaveSets;
  }

  // waveFlag(). Two ripples run along the cloth at different speeds; the top and
  // bottom edges of each chunk ride different combinations of them, damped
  // towards the pole so the cloth stays attached to it.
  _stepFlagWaveSets(deltaTime) {
    const twoPi = 2 * Math.PI;
    // Asked for rather than assumed: the first frame of a world steps the sets
    // before anything else has had reason to build them.
    (this._flagWaveSets ?? this._getFlagWaveSets()).forEach((set) => {
      set.ripple1 = (set.ripple1 + (deltaTime * BZFLAG_FLAG_RIPPLE_SPEED_1)) % twoPi;
      set.ripple2 = (set.ripple2 + (deltaTime * BZFLAG_FLAG_RIPPLE_SPEED_2)) % twoPi;
      const sinRipple2 = Math.sin(set.ripple2);
      const sinRipple2Shifted = Math.sin(set.ripple2 + BZFLAG_FLAG_RIPPLE_PHASE);
      const positions = set.geometry.attributes.position;

      for (let chunk = 0; chunk <= BZFLAG_FLAG_CHUNKS; chunk += 1) {
        const along = chunk / BZFLAG_FLAG_CHUNKS;
        const damp = BZFLAG_FLAG_RIPPLE_DAMP * along;
        const angle1 = set.ripple1 - (BZFLAG_FLAG_RIPPLE_TURNS * along);
        const angle2 = angle1 - BZFLAG_FLAG_RIPPLE_LAG;
        const wave0 = damp * Math.sin(angle1);
        const wave1 = damp * (Math.sin(angle2) + sinRipple2Shifted);
        const wave2 = wave0 + (damp * sinRipple2);
        const x = BZFLAG_FLAG_WIDTH * along;
        positions.setXYZ(chunk * 2, x, FLAG_POLE_SIZE + BZFLAG_FLAG_HEIGHT - wave0, wave1);
        positions.setXYZ((chunk * 2) + 1, x, FLAG_POLE_SIZE - wave0, wave2);
      }
      positions.needsUpdate = true;
    });
  }

  _createFlagWarp() {
    const group = new THREE.Group();
    group.visible = false;
    // One perturbed ring shared by the whole stack, as upstream builds one
    // `geom` per render call and scales it seven times.
    const geometry = new THREE.BufferGeometry();
    const vertexCount = BZFLAG_FLAG_WARP_SEGMENTS + 1;
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    const indices = [];
    for (let segment = 0; segment < BZFLAG_FLAG_WARP_SEGMENTS; segment += 1) {
      indices.push(0, segment + 1, ((segment + 1) % BZFLAG_FLAG_WARP_SEGMENTS) + 1);
    }
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), BZFLAG_FLAG_WARP_SIZE * 1.25);

    const rings = BZFLAG_FLAG_WARP_COLORS.map((color, ring) => {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: BZFLAG_FLAG_WARP_ALPHA,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // Upstream stacks the discs towards or away from the eye depending on
      // which side of the flag it is on, purely so the nearest draws last. With
      // depth writing off and both sides visible that ordering is free, so the
      // stack always climbs.
      mesh.position.y = ring * BZFLAG_FLAG_WARP_SPACING;
      mesh.renderOrder = FLAG_RENDER_ORDER;
      group.add(mesh);
      return { mesh, material };
    });

    return { group, geometry, rings };
  }

  _perturbFlagWarp(warp) {
    const positions = warp.geometry.attributes.position;
    positions.setXYZ(0, 0, 0, 0);
    for (let segment = 0; segment < BZFLAG_FLAG_WARP_SEGMENTS; segment += 1) {
      const angle = (2 * Math.PI * segment) / BZFLAG_FLAG_WARP_SEGMENTS;
      const radius = BZFLAG_FLAG_WARP_SIZE
        * (BZFLAG_FLAG_WARP_WOBBLE_MIN + (BZFLAG_FLAG_WARP_WOBBLE_RANGE * Math.random()));
      positions.setXYZ(segment + 1, radius * Math.cos(angle), 0, radius * Math.sin(angle));
    }
    positions.needsUpdate = true;
  }

  // Every flag in the world, in as few draws as there are cloth ripples plus
  // one. `FlagSceneNode::notifyStyleChange` draws an ordinary flag opaque --
  // no blending, `setAlphaFunc(GL_GEQUAL, 0.9)` against the texture -- and only
  // reaches for blending when the flag's own colour has alpha below one, which
  // is a flag warping in or out. An opaque flag needs no sorting against its
  // neighbours, and that is what lets the whole world's flags ride in
  // InstancedMeshes: one per wave set for the cloth, because a set is a shared
  // geometry and instancing draws one geometry many times, and one for every
  // pole in the world, which are identical.
  //
  // Capacity is grown in powers of two and the meshes are never culled: they
  // stand for flags scattered over the whole map, so a bound around them is the
  // map, and computing one per frame would cost more than the draw it saves.
  _getFlagBatch(needed) {
    if (this._flagBatch && this._flagBatch.capacity >= needed) return this._flagBatch;

    this._disposeFlagBatch();
    const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, needed))));
    const waveSets = this._getFlagWaveSets();
    const clothMaterial = new THREE.MeshBasicMaterial({
      map: this._getFlagTexture(),
      side: THREE.DoubleSide,
      alphaTest: BZFLAG_FLAG_ALPHA_THRESHOLD,
    });
    const poleMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    // The pole stands on the flag's position, so its offset is baked into the
    // geometry and the instance matrix carries nothing but the flag's place and
    // the way it faces.
    const poleHeight = FLAG_POLE_SIZE + BZFLAG_FLAG_HEIGHT;
    const poleGeometry = new THREE.PlaneGeometry(2 * FLAG_POLE_WIDTH, poleHeight)
      .translate(0, poleHeight / 2, 0);

    const prepare = (mesh) => {
      this._tagDraws(mesh, 'flag');
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = FLAG_RENDER_ORDER;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.getWorldGroup().add(mesh);
      return mesh;
    };

    this._flagBatch = {
      capacity,
      clothMaterial,
      poleMaterial,
      poleGeometry,
      cloth: waveSets.map((set) => prepare(new THREE.InstancedMesh(set.geometry, clothMaterial, capacity))),
      pole: prepare(new THREE.InstancedMesh(poleGeometry, poleMaterial, capacity)),
    };
    return this._flagBatch;
  }

  _disposeFlagBatch() {
    const batch = this._flagBatch;
    if (!batch) return;
    [...batch.cloth, batch.pole].forEach((mesh) => {
      mesh.parent?.remove(mesh);
      mesh.dispose();
    });
    batch.poleGeometry.dispose();
    batch.clothMaterial.dispose();
    batch.poleMaterial.dispose();
    this._flagBatch = null;
  }

  // What a flag looks like right now, and nothing that draws it. A record is
  // cheap enough that a world of 200 can carry one each whether or not that
  // slot has ever held a flag.
  _ensureFlagRecord(index) {
    if (!this.flagRecords) this.flagRecords = new Map();
    const existing = this.flagRecords.get(index);
    if (existing) return existing;

    const record = {
      x: 0,
      y: 0,
      z: 0,
      color: SUPER_FLAG_COLOR,
      alpha: 1,
      visible: false,
      // Fixed for the life of the flag, so a flag does not change its ripple
      // when it is picked up and put down again.
      waveSet: Math.floor(Math.random() * BZFLAG_FLAG_WAVE_SETS),
      fade: null,
      warp: null,
      label: null,
    };
    this.flagRecords.set(index, record);
    return record;
  }

  // The one flag the batch cannot draw: upstream turns blending on for a flag
  // whose colour has alpha below one, and an InstancedMesh has one material for
  // every instance in it. A warping flag gets a mesh of its own for as long as
  // it is fading, which is a second at a time and rarely more than one flag.
  _ensureFlagFade(record) {
    if (record.fade) return record.fade;

    const waveSet = this._getFlagWaveSets()[record.waveSet];
    const group = new THREE.Group();
    const clothMaterial = new THREE.MeshBasicMaterial({
      map: this._getFlagTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const cloth = new THREE.Mesh(waveSet.geometry, clothMaterial);
    cloth.renderOrder = FLAG_RENDER_ORDER;
    group.add(cloth);

    const poleMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const poleHeight = FLAG_POLE_SIZE + BZFLAG_FLAG_HEIGHT;
    const pole = new THREE.Mesh(new THREE.PlaneGeometry(2 * FLAG_POLE_WIDTH, poleHeight), poleMaterial);
    pole.position.y = poleHeight / 2;
    pole.renderOrder = FLAG_RENDER_ORDER;
    group.add(pole);

    this.getWorldGroup().add(this._tagDraws(group, 'flag'));
    record.fade = { group, clothMaterial, poleMaterial, pole };
    return record.fade;
  }

  _ensureFlagWarp(record) {
    if (record.warp) return record.warp;
    record.warp = this._createFlagWarp();
    this.getWorldGroup().add(record.warp.group);
    return record.warp;
  }

  // The debug label over a flag, created the first time that flag has anything
  // to say. Most flags in a world are unidentified, so a world of 200 would
  // otherwise pay for 200 label canvases to draw nothing.
  //
  // It hangs off the world group rather than off the flag, because a flag is
  // billboarded every frame and a child would be swung around with it.
  _ensureFlagLabel(record) {
    if (record.label) return record.label;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      depthTest: true,
      depthWrite: false,
      transparent: true,
      alphaTest: 0.1,
    }));
    label.scale.set(4, 1, 1);
    this.getWorldGroup().add(label);
    record.label = label;
    return label;
  }

  // Places a flag and sets how solid it looks. `warp` is the size fraction of
  // the arrival/departure disc stack, zero for no warp at all. `label` is the
  // abbreviation of a flag whose identity this client knows, or null for one it
  // does not, and it draws only while the debug labels are on.
  //
  // Nothing here touches a mesh: the cloth and the pole are written into the
  // batch once a frame by updateFlagVisuals, which is the only place that knows
  // which way each flag has to face.
  showFlag(index, { x, y, z, color = SUPER_FLAG_COLOR, alpha = 1, warp = 0, label = null }) {
    const record = this._ensureFlagRecord(index);
    record.x = x;
    record.y = y;
    record.z = z;
    record.color = color;
    record.alpha = alpha;
    record.visible = alpha > 0;

    const showLabel = Boolean(label) && this.debugLabelsEnabled && alpha > 0;
    if (showLabel) {
      const sprite = this._ensureFlagLabel(record);
      this.updateSpriteLabel(sprite, label, '#ffffff');
      sprite.position.set(x, y + BZFLAG_FLAG_HEIGHT + FLAG_POLE_SIZE + 1, z);
      sprite.visible = true;
    } else if (record.label) {
      record.label.visible = false;
    }

    if (warp > 0 || record.warp) {
      const flagWarp = this._ensureFlagWarp(record);
      flagWarp.group.visible = warp > 0;
      flagWarp.group.position.set(x, y, z);
    }
    if (warp > 0) {
      record.warp.rings.forEach((ring, index2) => {
        const size = warp - (BZFLAG_FLAG_WARP_STEP * index2);
        ring.mesh.visible = size > 0;
        if (size > 0) ring.mesh.scale.set(size, 1, size);
      });
    }
  }

  hideFlag(index) {
    const record = this.flagRecords?.get(index);
    if (!record) return;
    record.visible = false;
    if (record.fade) record.fade.group.visible = false;
    if (record.warp) record.warp.group.visible = false;
    if (record.label) record.label.visible = false;
  }

  clearFlags() {
    this._disposeFlagBatch();
    if (!this.flagRecords) return;
    this.flagRecords.forEach((record) => {
      // The cloth geometry is shared by every flag, so only what a record owns
      // outright is disposed here.
      if (record.fade) {
        record.fade.group.parent?.remove(record.fade.group);
        record.fade.clothMaterial.dispose();
        record.fade.poleMaterial.dispose();
        record.fade.pole.geometry.dispose();
      }
      if (record.label) {
        record.label.parent?.remove(record.label);
        record.label.material.map?.dispose();
        record.label.material.dispose();
      }
      if (record.warp) {
        record.warp.group.parent?.remove(record.warp.group);
        record.warp.geometry.dispose();
        record.warp.rings.forEach((ring) => ring.material.dispose());
      }
    });
    this.flagRecords.clear();
  }

  // One step for every flag in the world: the shared cloth ripples, each
  // visible flag turns to face the camera, and each visible warp re-wobbles.
  updateFlagVisuals(deltaTime) {
    if (!this.flagRecords?.size) return;
    this._stepFlagWaveSets(deltaTime);

    // A flag turns to face the viewer about its own pole, and about nothing
    // else. Upstream multiplies in the inverse of the whole view rotation
    // (ViewFrustum::executeBillboard), which keeps the pole upright on a monitor
    // only because a desktop camera has no roll and little pitch: the pole is
    // vertical *on the screen*, not in the world. In a headset that reads as the
    // flag leaning over with your head, and turning about the eye rather than
    // about the pole means a flag spins in place when you merely look away from
    // it. Yaw towards the viewer does what the billboard is for -- the cloth
    // faces you -- and leaves the pole where the world put it.
    //
    // The turn is measured in worldGroup's own space rather than the scene's,
    // because in a session worldGroup carries the player's heading: reading the
    // camera's orientation straight off would apply that heading a second time.
    const camera = FLAG_BILLBOARD_SCRATCH;
    this.camera.getWorldPosition(camera);
    // worldGroup is only ever translated and turned about the vertical, so its
    // inverse is that by hand -- cheaper than updating the world matrix of every
    // one of its children to ask `worldToLocal`.
    camera.sub(this.worldGroup.position).applyQuaternion(
      FLAG_BILLBOARD_QUATERNION.copy(this.worldGroup.quaternion).invert()
    );

    const batch = this._getFlagBatch(this.flagRecords.size);
    const matrix = FLAG_INSTANCE_MATRIX;
    const color = FLAG_INSTANCE_COLOR;
    batch.cloth.forEach((mesh) => { mesh.count = 0; });
    batch.pole.count = 0;

    this.flagRecords.forEach((record) => {
      if (record.warp?.group.visible) this._perturbFlagWarp(record.warp);
      if (!record.visible) return;

      const yaw = Math.atan2(camera.x - record.x, camera.z - record.z);
      matrix.makeRotationY(yaw);
      matrix.setPosition(record.x, record.y, record.z);

      if (record.alpha >= 1) {
        if (record.fade) record.fade.group.visible = false;
        const cloth = batch.cloth[record.waveSet];
        const slot = cloth.count;
        cloth.setMatrixAt(slot, matrix);
        cloth.setColorAt(slot, color.setHex(record.color));
        cloth.count = slot + 1;
        batch.pole.setMatrixAt(batch.pole.count, matrix);
        batch.pole.count += 1;
        return;
      }

      // Fading, so it leaves the batch and is drawn on its own with blending.
      const fade = this._ensureFlagFade(record);
      fade.group.visible = true;
      fade.group.position.set(record.x, record.y, record.z);
      fade.group.rotation.set(0, yaw, 0);
      fade.clothMaterial.color.setHex(record.color);
      fade.clothMaterial.opacity = record.alpha;
      fade.poleMaterial.opacity = record.alpha;
    });

    batch.cloth.forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    batch.pole.instanceMatrix.needsUpdate = true;
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

  updateClouds(deltaTime, mapSize) {
    const mapBoundary = mapSize / 2;
    this.clouds.forEach((cloud) => {
      cloud.position.x += cloud.userData.velocity * deltaTime;
      if (cloud.position.x > mapBoundary + 30) {
        cloud.position.x = -mapBoundary - 30;
      }
    });
  }

  updateCamera({ cameraMode, myTank, playerRotation, deathFollowTarget, roamFraming }) {
    if (!this.camera) return;
    // Every roaming view resolves to an eye and a look point in client.js, so
    // the rigs stay with the game state and this only has to apply one.
    if (cameraMode === 'roam') {
      if (!roamFraming) return;
      const { eye, look } = roamFraming;
      if (xrState.enabled) {
        // In XR the world moves and the camera does not, as in first person.
        // Only the heading is taken: tilting worldGroup tilts the horizon, which
        // is the nausea case, and the head already looks around.
        const heading = Math.atan2(-(look.x - eye.x), -(look.z - eye.z));
        const q = new THREE.Quaternion();
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
        this.worldGroup.quaternion.copy(q);
        const eyeRotated = ROAM_FORWARD_SCRATCH.set(eye.x, 0, eye.z).applyQuaternion(q);
        this.worldGroup.position.set(-eyeRotated.x, -eye.y, -eyeRotated.z);
        return;
      }
      this.worldGroup.position.set(0, 0, 0);
      this.worldGroup.quaternion.identity();
      this.camera.position.set(eye.x, eye.y, eye.z);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(look.x, look.y, look.z);
      return;
    }
    if (cameraMode === 'overview') {
      const target = deathFollowTarget || this.deathFollowTarget;
      const focusPoint = target && target.parent
        ? target.getWorldPosition(new THREE.Vector3())
        : this.deathFollowAnchor;
      if (target && target.parent) {
        this.deathFollowAnchor = target.getWorldPosition(new THREE.Vector3());
      }
      if (focusPoint) {
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
        this.worldGroup.position.set(0, 0, 0);
        this.worldGroup.quaternion.identity();
        const followOffset = velocity.lengthSq() > 0.1
          ? velocity.clone().normalize().multiplyScalar(-20).add(new THREE.Vector3(0, 10, 0))
          : new THREE.Vector3(0, 10, 22);
        const desiredPosition = focusPoint.clone().add(followOffset);
        if (!this.deathCameraLogged) {
          const dl = window.gameDebugLog;
          if (dl) {
            dl(`deathCam lookAt=${focusPoint.x.toFixed(1)},${focusPoint.y.toFixed(1)},${focusPoint.z.toFixed(1)} camPos=${desiredPosition.x.toFixed(1)},${desiredPosition.y.toFixed(1)},${desiredPosition.z.toFixed(1)} debrisVel=${velocity.x.toFixed(1)},${velocity.y.toFixed(1)},${velocity.z.toFixed(1)}`, 'render');
          }
          this.deathCameraLogged = true;
        }
        this.camera.position.lerp(desiredPosition, 0.045);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(focusPoint);
        return;
      }
      this.deathFollowTarget = null;
      this.deathFollowAnchor = null;
      this.deathCameraLogged = false;
      this.worldGroup.position.set(0, 0, 0);
      this.worldGroup.quaternion.identity();
      this.camera.position.set(0, 15, 20);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
      return;
    }

    if (!myTank) return;
    if (cameraMode === 'first-person') {
      if (xrState.enabled) {
        // In XR mode, keep tank visible and position camera above it
        if (myTank.userData.body) myTank.userData.body.visible = true;
        if (myTank.userData.turret) myTank.userData.turret.visible = true;

        // Apply rotation first (around the camera/origin)
        const q = new THREE.Quaternion();
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -myTank.rotation.y);
        this.worldGroup.quaternion.copy(q);

        // Calculate where the tank ends up after rotation
        const tankRotated = myTank.position.clone();
        tankRotated.applyQuaternion(q);

        // Translate to center the rotated tank at camera origin, with ground slightly below eye height
        this.worldGroup.position.set(
          -tankRotated.x,
          -myTank.position.y - 0.6,
          -tankRotated.z
        );
      } else {
        // In non-XR first-person, keep hull visible like BZFlag; hide turret to avoid center obstruction
        if (myTank.userData.body) myTank.userData.body.visible = true;
        if (myTank.userData.turret) myTank.userData.turret.visible = false;
        // Reset world group for non-XR
        this.worldGroup.position.set(0, 0, 0);
        this.worldGroup.rotation.y = 0;
        const cameraHeight = Number.isFinite(myTank.userData.cameraHeight)
          ? myTank.userData.cameraHeight
          : DEFAULT_MUZZLE_HEIGHT;
        this.camera.position.set(
          myTank.position.x,
          myTank.position.y + cameraHeight,
          myTank.position.z,
        );
        const lookTarget = new THREE.Vector3(
          myTank.position.x - Math.sin(playerRotation) * 10,
          myTank.position.y + cameraHeight,
          myTank.position.z - Math.cos(playerRotation) * 10,
        );
        this.camera.lookAt(lookTarget);
      }
    } else {
      if (myTank.userData.body) myTank.userData.body.visible = true;
      if (myTank.userData.turret) myTank.userData.turret.visible = true;
      const cameraOffset = new THREE.Vector3(
        Math.sin(playerRotation) * THIRD_PERSON_DISTANCE,
        THIRD_PERSON_HEIGHT,
        Math.cos(playerRotation) * THIRD_PERSON_DISTANCE,
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
        const eye = ROAM_FORWARD_SCRATCH.copy(myTank.position).add(cameraOffset);
        const eyeY = eye.y;
        const q = new THREE.Quaternion();
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -playerRotation);
        const eyeRotated = eye.set(eye.x, 0, eye.z).applyQuaternion(q);
        this.worldGroup.quaternion.copy(q);
        this.worldGroup.position.set(-eyeRotated.x, -eyeY, -eyeRotated.z);
        return;
      }
      this.worldGroup.position.set(0, 0, 0);
      this.worldGroup.quaternion.identity();
      this.camera.position.copy(myTank.position).add(cameraOffset);
      this.camera.lookAt(new THREE.Vector3(
        myTank.position.x - Math.sin(playerRotation) * 10,
        myTank.position.y + 3,
        myTank.position.z - Math.cos(playerRotation) * 10,
      ));
    }
  }

}

export const renderManager = new RenderManager();
