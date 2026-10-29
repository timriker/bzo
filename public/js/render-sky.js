/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The sky and the weather: the time of day, the sun, moon and stars, fog,
// mountains, clouds, and rain or snow.
// RenderManager's own methods, kept here and installed on its prototype by
// render.js: `this` is the RenderManager.

import { TANK, findShotSegmentImpact } from './collision.mjs';
import { BELOW_HORIZON as SKY_BELOW_HORIZON, MOON_COLOR as SKY_MOON_COLOR, areShadowsCast, areStarsVisible, getCelestialTransform, getMoonPhase, getMoonPosition, getSkyColor, getSunColor, getSunPosition, getSunsetTop, julianDayFromUnixSeconds } from './daylight.mjs';
import { STARS, STAR_COUNT } from './stars.mjs';
import { createStockMaterialTexture } from './texture.js';
import * as THREE from 'three';

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
// Upstream's sky, drawn before anything else and without depth: the pyramid of
// colours first (BackgroundRenderer::drawSky), then the stars over it, then
// the sun and the moon, and only then the world.
const SKY_RENDER_ORDER = -2000;
const SKY_EYE_SCRATCH = new THREE.Vector3();
const SKY_SCALE_SCRATCH = new THREE.Vector3();
const STARS_RENDER_ORDER = -1500;
// The sky pyramid's base corners in its own plane (`squareShape`), in the
// order `drawSky` colours them: across the sun, away from it, across, toward.
const SKY_SQUARE = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
// `drawSky`'s turn toward the sun, as upstream writes it: the azimuth in
// radians times 180, plus 135, over pi -- degrees off by 135/pi rather than 45,
// which still puts the sun's corner within a couple of degrees of the sun.
const SKY_SUN_TURN_OFFSET_DEG = 135 / Math.PI;
// Recompute the sky when its clock has moved this far (playing.cxx:7264).
const SKY_UPDATE_SECONDS = 4;
// `moonSegments` at upstream's top quality (SceneRenderer.cxx:256-260).
const MOON_SEGMENTS = 64;
// The stars' size in pixels: upstream draws `GL_POINTS` at one, smoothed.
const STAR_POINT_SIZE = 1.5;
// The glow is bzo's, and rides just outside the sun's disc.
const CELESTIAL_GLOW_RATIO = 1.5;
// Mountains, after the sky but still well before the ordinary depth-tested
// scene -- `BackgroundRenderer::renderGroundEffects`
// (`BackgroundRenderer.cxx:657-660`) draws them with the z-buffer test off:
// "either everything is coplanar with the ground or is drawn back to front
// and is occluded by everything drawn after it", and `drawMountains`'s own
// call site says it plainly -- "don't do zbuffer test since they occlude
// all drawn before them and are occluded by all drawn after" (`:691-695`).
// A mountain sits at `2.25 * mapSize`, and stretching the camera's far
// plane out to it (`_ensureMountainViewDistance`) thins the depth buffer's
// precision for everything nearer too, so an ordinary depth-tested mountain
// material leaves a tank's name sprite close enough to it in the quantized
// depth range to z-fight (issue #92).
// Matching upstream's own "don't test" -- `depthTest`/`depthWrite` both off
// in `createMountains` -- removes it from that contest entirely: drawn
// first, painted over by anything real that comes after, exactly as
// upstream has it. This needs the *opaque* render list to actually draw
// first, which is why `createMountains` also turns off `transparent` --
// see the comment there.
const MOUNTAIN_RENDER_ORDER = -500;
// Upstream's cloud layer (BackgroundRenderer.cxx:1829): `clouds.png` on a plane
// 120 tank heights up, as wide as the ground plane (ten world sizes either
// way), opaque over the middle quarter of it and fading out to its edge,
// repeated three times across and drifting (`addCloudDrift`, playing.cxx:
// 5966). Drawn with the mountains, before the scene and without depth.
const BZFLAG_CLOUD_LAYER_TEXTURE = '/textures/clouds.png';
const BZFLAG_CLOUD_REPEATS = 3.0;
const BZFLAG_CLOUD_INNER_SCALE = 0.25;
const BZFLAG_CLOUD_HEIGHT_TANK_HEIGHTS = 120;
const CLOUD_LAYER_RENDER_ORDER = MOUNTAIN_RENDER_ORDER + 1;

// Weather (`_rainType`, `src/bzflag/WeatherRenderer.cxx`). A map's own `-set
// _rainType <preset>` is what turns this on at all -- see "Weather" in
// docs/bzw.md -- so every field below is only ever a preset's default,
// overridable by the handful of `_rain*` siblings the server parses.
//
// bzo builds one rendering path rather than upstream's three (line rain,
// billboarded quads, and a non-billboard "cross" of three quads 120 degrees
// apart, upstream's own volumetric stand-in for a raindrop that need not face
// the camera): the cross for `rain`/`snow`/`fatrain`, camera-facing billboards
// for `frog`/`particle`/`bubble`. Upstream's plain `rain` defaults to its
// GL_LINES streak; bzo gives `rain` the cross too and draws the streak only
// when a map sets `_useLineRain` itself.
const WEATHER_RENDER_ORDER = 21;
// `_rainBaseColor` / `_rainTopColor` defaults (WeatherRenderer.cxx:169-176).
const WEATHER_LINE_BASE_COLOR = [0.75, 0.75, 0.85, 0.75];
const WEATHER_LINE_TOP_COLOR = [0, 0, 0, 0];
const WEATHER_DEFAULT_DENSITY = 1000;
const WEATHER_DEFAULT_SPREAD = 500;
const WEATHER_DEFAULT_MAX_PUDDLE_TIME = 1.5;
const WEATHER_DEFAULT_PUDDLE_SPEED = 1.0;
// Same reasoning as `TRACK_MARK_CAPACITY`: a bound on live splashes rather
// than upstream's unbounded `std::vector`, so a crowded sky shortens every
// puddle's life instead of growing memory.
const WEATHER_PUDDLE_CAPACITY = 512;
// `RoofTops::getTopHeight`'s ray needs no real thickness; this is a point
// test, not a shot's own collision radius.
const WEATHER_ROOF_RAY_RADIUS = 0.1;
// `120.0f * BZDBCache::tankHeight`, "same as the clouds" -- WeatherRenderer.cxx:351.
function weatherSkyHeight() {
  return 120 * TANK.height;
}

// `WeatherRenderer::set()`'s per-`_rainType` deltas over its own outer
// defaults (density 1000, speed -100/50, size 1x1, spin on, puddles on, white
// puddles, puddleSpeed 1). `_rainBaseColor`/`_rainTopColor` tint the line
// streak alone, so they live with `WEATHER_LINE_BASE_COLOR` instead.
const WEATHER_PRESETS = {
  rain: {
    texture: 'raindrop', size: [0.3, 0.75], speed: -100, speedMod: 50,
    spin: true, billboard: false, puddles: true, puddleColor: [1, 1, 1],
  },
  snow: {
    texture: 'snowflake', size: [1, 1], speed: -20, speedMod: 5,
    spin: true, billboard: false, puddles: false, puddleColor: [1, 1, 1],
  },
  fatrain: {
    texture: 'raindrop', size: [0.5, 0.75], speed: -50, speedMod: 25,
    spin: false, billboard: false, puddles: true, puddleColor: [1, 1, 1],
  },
  frog: {
    texture: 'frog', size: [2, 2], speed: -100, speedMod: 5,
    spin: true, billboard: true, puddles: true, puddleColor: [0.75, 0, 0], puddleSpeed: 3,
  },
  particle: {
    texture: 'red_super_bolt', size: [1, 1], speed: -20, speedMod: 5,
    spin: true, billboard: true, puddles: true, puddleColor: [1, 0, 0], puddleSpeed: 10,
    density: 500,
  },
  bubble: {
    texture: 'bubble', size: [1, 1], speed: 20, speedMod: 1,
    spin: true, billboard: true, puddles: false, puddleColor: [1, 1, 1],
  },
};

// The "cross" of three quads 120 degrees apart around the vertical axis,
// standing upright -- `WeatherRenderer::buildDropList`'s non-billboard path:
// a vertical quad spanning X and Z (up) at Y=0, turned by
// `glRotatef(_, 0, 0, 1)` about the up axis.
function buildWeatherCrossGeometry(halfW, halfH) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const corner = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (let plane = 0; plane < 3; plane += 1) {
    const angle = (plane * Math.PI * 2) / 3;
    const base = positions.length / 3;
    const corners = [
      [-halfW, -halfH], [halfW, -halfH], [-halfW, halfH], [halfW, halfH],
    ];
    for (const [x, y] of corners) {
      corner.set(x, 0, y).applyAxisAngle(zAxis, angle);
      positions.push(corner.x, corner.y, corner.z);
    }
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// A single camera-facing quad -- `doBillBoards`'s path, upstream's own
// `sr.getViewFrustum().executeBillboard()`. The instance's own rotation is set
// to the camera's each frame (see `_advanceWeatherDrops`) rather than baked
// into the geometry.
function buildWeatherBillboardGeometry(halfW, halfH) {
  const geometry = new THREE.PlaneGeometry(halfW * 2, halfH * 2);
  return geometry;
}

// A flat decal on the ground -- `WeatherRenderer::buildPuddleList`, upstream's
// own unit quad in its X-Y (ground) plane.
function buildWeatherPuddleGeometry() {
  return new THREE.PlaneGeometry(2, 2);
}

const WEATHER_VERTEX_SHADER = `
attribute float instanceAlpha;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = uv;
  vAlpha = instanceAlpha;
  vec4 worldPosition = instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
}
`;

const WEATHER_FRAGMENT_SHADER = `
uniform sampler2D map;
uniform vec3 tint;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 texColor = texture2D(map, vUv);
  float a = texColor.a * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(texColor.rgb * tint, a);
}
`;

// One instanced draw call per mesh regardless of how many drops or puddles are
// alive -- `glDepthMask(GL_FALSE)` and `GL_SRC_ALPHA`/`GL_ONE_MINUS_SRC_ALPHA`
// upstream's own blend, `glDisable(GL_CULL_FACE)` its own `DoubleSide`. Alpha is
// per-instance (`instanceAlpha`) rather than per-material, since a raindrop
// fades as it nears the ground and a puddle fades as it ages -- something no
// built-in Three.js material varies per `InstancedMesh` instance.
function createWeatherMaterial(texture, tint = [1, 1, 1]) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      tint: { value: new THREE.Color(tint[0], tint[1], tint[2]) },
    },
    vertexShader: WEATHER_VERTEX_SHADER,
    fragmentShader: WEATHER_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// `RoofTops::getTopHeight`: a straight ray down from above the world to the
// ground, stopping at the first obstacle it meets -- upstream skips
// teleporters for the same reason `findShotSegmentImpact` already does
// (`obs.kind === 'teleporter'`), "the physics for teles is whacked, imho".
// Never negative, upstream's own floor.
function getWeatherTopHeight(obstacles, x, y, maxHeight) {
  const impact = findShotSegmentImpact(
    obstacles, { x, y, z: maxHeight }, { x, y, z: 0 }, WEATHER_ROOF_RAY_RADIUS,
  );
  if (!impact) return 0;
  return Math.max(0, maxHeight * (1 - impact.fraction));
}

const WEATHER_BILLBOARD_QUATERNION = new THREE.Quaternion();
const WEATHER_CAMERA_QUATERNION = new THREE.Quaternion();

export class SkyRendering {
  _applyFogConfig(gameConfig = null) {
    if (!this.scene) return;

    // SceneRenderer::setupBackgroundMaterials: any mode but `none` is fog, one
    // that is not `linear` or `exp2` is `exp`, and the fog is `_fogColor`
    // rather than the sky behind it.
    const rawMode = typeof gameConfig?.FOG_MODE === 'string' ? gameConfig.FOG_MODE.toLowerCase() : 'none';
    const fogMode = rawMode === 'none' || rawMode === 'linear' || rawMode === 'exp2' ? rawMode : 'exp';
    const fogDensity = Number.isFinite(gameConfig?.FOG_DENSITY) ? gameConfig.FOG_DENSITY : 0.001;
    const fogStart = Number.isFinite(gameConfig?.FOG_START) ? gameConfig.FOG_START : 50;
    const fogEnd = Number.isFinite(gameConfig?.FOG_END) ? gameConfig.FOG_END : 100;
    const fogRgb = Array.isArray(gameConfig?.FOG_COLOR) ? gameConfig.FOG_COLOR : [0.25, 0.25, 0.25];
    const baseFogColor = new THREE.Color(fogRgb[0], fogRgb[1], fogRgb[2]);
    // `_skyColor` multiplies every sky colour (daylight.cxx:368); white, or
    // none, leaves them alone.
    this._skyTint = Array.isArray(gameConfig?.SKY_COLOR) ? gameConfig.SKY_COLOR : null;

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
    // 12000 = 18:00, 18000 = midnight, sweeping a fixed arc in the world's X-Z
    // plane, rising in the east, with the moon exactly opposite the sun. See
    // AGENTS.md.
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
    const sunY = 0;
    const sunZ = Math.sin(sunAngle) * sunDistance * 0.8; // Lower arc for realism
    // Moon position
    const moonX = Math.cos(moonAngle) * moonDistance;
    const moonY = 0;
    const moonZ = Math.sin(moonAngle) * moonDistance * 0.8;
    const sunElevation = Math.max(-1, Math.min(1, sunZ / (sunDistance * 0.8 || 1)));
    const moonElevation = Math.max(-1, Math.min(1, moonZ / (moonDistance * 0.8 || 1)));
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
    const tint = this._skyTint;
    const tinted = (rgb) => (tint ? rgb.map((value, i) => value * tint[i]) : rgb);
    const backgroundColor = toThreeColor(lerpTriplet(tinted(skySunDirColor), tinted(skyZenithColor), 0.35));

    if (this.ambientLight) {
      this.ambientLight.color.copy(ambientThreeColor);
      this.ambientLight.intensity = 1.0;
    }

    if (this.sunLight) {
      this.sunLight.position.set(sunX, sunY, sunZ);
      this.sunLight.target.position.set(0, 0, 0);
      this.worldFrame.add(this.sunLight.target);
      this.sunLight.color.copy(directThreeColor);
      this.sunLight.intensity = sunElevation >= -0.009 ? Math.max(0.35, directBrightness) : 0.0;
      this.sunLight.castShadow = sunElevation > (0.5 * BZFLAG_DAY_ELEVATION);
    }

    if (this.moonLight) {
      this.moonLight.position.set(moonX, moonY, moonZ);
      this.moonLight.target.position.set(0, 0, 0);
      this.worldFrame.add(this.moonLight.target);
      this.moonLight.color.copy(toThreeColor(moonColor));
      this.moonLight.intensity = sunElevation < -0.009 && moonElevation > -0.009 ? 0.35 : 0.0;
      this.moonLight.castShadow = this.moonLight.intensity > 0;
    }

    if (this._worldDraws('sky')) this.scene.background.copy(backgroundColor);
    else this.scene.background.setRGB(0, 0, 0);

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
    this._showUpstreamSky(false);
    this._applySkyFog();
  }

  // Upstream's sky (#166): the real sun, moon and stars over the world's
  // `_latitude` and `_longitude` at a Unix time -- now, or the frozen instant
  // `_syncTime` names -- as `SceneRenderer::setTimeOfDay` places them. Every
  // client reads the same instant, so every screen shows the same sky.
  // Recomputed only when the clock has moved `SKY_UPDATE_SECONDS`, as upstream
  // does, or when the place or the world changes.
  setCelestialTime(unixSeconds, latitude = 37.5, longitude = 122) {
    const worldSize = Number.isFinite(this.groundMapSize) ? this.groundMapSize : 100;
    const last = this._celestialState;
    if (last && Math.abs(unixSeconds - last.seconds) < SKY_UPDATE_SECONDS
      && last.latitude === latitude && last.longitude === longitude
      && last.worldSize === worldSize && last.skyTint === this._skyTint) {
      return;
    }
    this._celestialState = { seconds: unixSeconds, latitude, longitude, worldSize, skyTint: this._skyTint };
    this._worldTime = null;
    const julianDay = julianDayFromUnixSeconds(unixSeconds);
    const sunDir = getSunPosition(julianDay, latitude, longitude);
    const moonDir = getMoonPosition(julianDay, latitude, longitude);
    const distance = BZFLAG_CELESTIAL_DISTANCE_SCALE * worldSize;
    const [sunX, sunY, sunZ] = sunDir.map((value) => value * distance);
    const [moonX, moonY, moonZ] = moonDir.map((value) => value * distance);
    const sunUp = sunDir[2] >= SKY_BELOW_HORIZON;
    const moonUp = moonDir[2] > SKY_BELOW_HORIZON;
    const { color, ambient, brightness } = getSunColor(sunDir);
    const asColor = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2]);
    const directColor = asColor(color);

    if (this.ambientLight) {
      this.ambientLight.color.copy(asColor(ambient));
      this.ambientLight.intensity = 1.0;
    }
    // The sun lights the world while it is up, the moon while it is up and the
    // sun is not, and neither when both are down (SceneRenderer.cxx:599-616).
    // Only the sun casts shadows (`areShadowsCast`).
    if (this.sunLight) {
      this.sunLight.position.set(sunX, sunY, sunZ);
      this.sunLight.target.position.set(0, 0, 0);
      this.worldFrame.add(this.sunLight.target);
      this.sunLight.color.copy(directColor);
      this.sunLight.intensity = sunUp ? Math.max(0.35, brightness) : 0.0;
      this.sunLight.castShadow = areShadowsCast(sunDir);
    }
    if (this.moonLight) {
      this.moonLight.position.set(moonX, moonY, moonZ);
      this.moonLight.target.position.set(0, 0, 0);
      this.worldFrame.add(this.moonLight.target);
      this.moonLight.color.copy(asColor(SKY_MOON_COLOR));
      this.moonLight.intensity = !sunUp && moonUp ? 0.35 : 0.0;
      this.moonLight.castShadow = false;
    }

    const sky = getSkyColor(sunDir, this._skyTint);
    const skyOn = this._worldDraws('sky');
    const celestialOn = skyOn && this.celestialEnabled && this._worldDraws('celestial');
    // What shows where the pyramid does not reach -- below the horizon, with
    // no ground there -- is the zenith, as upstream's low-quality sky clears to.
    // With no sky at all, the clear colour is all there is.
    if (skyOn) this.scene.background.setRGB(sky[0][0], sky[0][1], sky[0][2], THREE.SRGBColorSpace);
    else this.scene.background.setRGB(0, 0, 0);
    this._showUpstreamSky(true);
    this._updateSkyPyramid(sky, sunDir, getSunsetTop(sunDir));
    this._skyPyramid.visible = skyOn;
    this._updateStars(julianDay, latitude, longitude, celestialOn && areStarsVisible(sunDir));

    this._updateCelestialBodies({
      sunX,
      sunY,
      sunZ,
      moonX,
      moonY,
      moonZ,
      sunColor: directColor,
      sunRadius: distance * BZFLAG_SUN_ANGULAR_RADIUS,
      moonRadius: distance * BZFLAG_MOON_ANGULAR_RADIUS,
      sunVisible: sunDir[2] > SKY_BELOW_HORIZON,
      // The phased moon below stands in for the sphere.
      moonVisible: false,
    });
    this._updateMoonPhase(sunDir, moonDir, distance, distance * BZFLAG_MOON_ANGULAR_RADIUS, celestialOn && moonUp);
    this._applySkyFog();
  }

  _showUpstreamSky(shown) {
    if (!shown) this._celestialState = null;
    if (this._skyPyramid) this._skyPyramid.visible = shown;
    if (this._starField) this._starField.visible = shown && this._starField.userData.wanted === true;
    if (this._phasedMoon) this._phasedMoon.visible = shown && this._phasedMoon.userData.wanted === true;
  }

  // BackgroundRenderer::drawSky: a pyramid over the eye, its apex the zenith
  // colour and its four base corners on the horizon, the one toward the sun in
  // the sun's horizon colour. Around sunrise and sunset the sun's two faces
  // split at `sunsetTop`, so the sunset climbs the sky and falls away again.
  // Unit-sized and scaled to the far plane each frame (`_followSky`), since it
  // stands for the sky at infinity.
  _updateSkyPyramid(sky, sunDir, sunsetTop) {
    if (!this._skyPyramid) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18 * 3), 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(18 * 3), 3));
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false,
        toneMapped: false,
      });
      this._skyPyramid = new THREE.Mesh(geometry, material);
      this._skyPyramid.renderOrder = SKY_RENDER_ORDER;
      this._skyPyramid.frustumCulled = false;
      this.worldFrame.add(this._tagDraws(this._skyPyramid, 'scenery'));
    }
    const [zenith, toward, away, across] = sky;
    const turn = ((Math.atan2(sunDir[1], sunDir[0]) * 180) / Math.PI + SKY_SUN_TURN_OFFSET_DEG) * (Math.PI / 180);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    // A point turned toward the sun.
    const at = (x, y, z) => [(x * cos) - (y * sin), (x * sin) + (y * cos), z];
    const corner = SKY_SQUARE.map(([x, y]) => at(x, y, 0));
    const apex = at(0, 0, 1);
    const vertices = [];
    if (sunsetTop === null) {
      // The fan apex, c0, c3, c2, c1, c0 as four triangles.
      vertices.push(
        [apex, zenith], [corner[0], across], [corner[3], toward],
        [apex, zenith], [corner[3], toward], [corner[2], across],
        [apex, zenith], [corner[2], across], [corner[1], away],
        [apex, zenith], [corner[1], away], [corner[0], across],
      );
    } else {
      const sun3 = SKY_SQUARE[3];
      const top = at(sun3[0] * (1 - sunsetTop), sun3[1] * (1 - sunsetTop), sunsetTop);
      vertices.push(
        [apex, zenith], [corner[2], across], [corner[1], away],
        [apex, zenith], [corner[1], away], [corner[0], across],
        [apex, zenith], [corner[0], across], [top, zenith],
        [apex, zenith], [top, zenith], [corner[2], across],
        [top, zenith], [corner[0], across], [corner[3], toward],
        [corner[2], across], [top, zenith], [corner[3], toward],
      );
    }
    const position = this._skyPyramid.geometry.getAttribute('position');
    const colour = this._skyPyramid.geometry.getAttribute('color');
    const scratch = new THREE.Color();
    vertices.forEach(([point, rgb], i) => {
      position.setXYZ(i, point[0], point[1], point[2]);
      scratch.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      colour.setXYZ(i, scratch.r, scratch.g, scratch.b);
    });
    position.needsUpdate = true;
    colour.needsUpdate = true;
    this._skyPyramid.geometry.setDrawRange(0, vertices.length);
  }

  // Upstream's 400 stars on the celestial sphere, turned into the local sky by
  // `getCelestialTransform` and shown while the sun is below the horizon. The
  // transform is set here, every few seconds; the position, each frame.
  _updateStars(julianDay, latitude, longitude, visible) {
    if (!this._starField) {
      const positions = new Float32Array(STAR_COUNT * 3);
      const colors = new Float32Array(STAR_COUNT * 3);
      const scratch = new THREE.Color();
      for (let i = 0; i < STAR_COUNT; i += 1) {
        const at = i * 6;
        positions.set([STARS[at + 3], STARS[at + 4], STARS[at + 5]], i * 3);
        scratch.setRGB(STARS[at], STARS[at + 1], STARS[at + 2], THREE.SRGBColorSpace);
        colors.set([scratch.r, scratch.g, scratch.b], i * 3);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      // Additive rather than blended: it is the one blending that stays in the
      // opaque queue, which is what puts the stars before the world rather
      // than over it, and on a night sky the two look the same.
      const material = new THREE.PointsMaterial({
        size: STAR_POINT_SIZE * (this.renderer?.getPixelRatio?.() || 1),
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      this._starField = new THREE.Points(geometry, material);
      this._starField.renderOrder = STARS_RENDER_ORDER;
      this._starField.frustumCulled = false;
      this._starField.matrixAutoUpdate = false;
      this.worldFrame.add(this._tagDraws(this._starField, 'scenery'));
    }
    const m = getCelestialTransform(julianDay, latitude, longitude);
    // Celestial into the local sky.
    this._starRotation = new THREE.Matrix4().set(
      m[0], m[1], m[2], 0,
      m[3], m[4], m[5], 0,
      m[6], m[7], m[8], 0,
      0, 0, 0, 1,
    );
    this._starField.userData.wanted = visible;
    this._starField.visible = visible;
  }

  // The moon as upstream draws it (`makeCelestialLists`): a flat strip from
  // its limb to its terminator, white and added to the sky, turned so its lit
  // edge faces the sun. Rebuilt with the sky, every few seconds.
  _updateMoonPhase(sunDir, moonDir, distance, radius, visible) {
    if (!this._phasedMoon) {
      const vertexCount = 2 + ((MOON_SEGMENTS - 1) * 2);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      const indices = [];
      for (let i = 0; i + 2 < vertexCount; i += 1) indices.push(i, i + 1, i + 2);
      geometry.setIndex(indices);
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.DoubleSide, depthTest: true, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      });
      this._phasedMoon = new THREE.Mesh(geometry, material);
      this._phasedMoon.renderOrder = CELESTIAL_RENDER_ORDER;
      this._phasedMoon.frustumCulled = false;
      this.worldFrame.add(this._tagDraws(this._phasedMoon, 'scenery'));
    }
    const { coverage, limbAngle, moonAzimuth, moonAltitude } = getMoonPhase(sunDir, moonDir);
    const cl = Math.cos(limbAngle); const sl = Math.sin(limbAngle);
    const ca = Math.cos(-moonAltitude); const sa = Math.sin(-moonAltitude);
    const cz = Math.cos(moonAzimuth); const sz = Math.sin(moonAzimuth);
    // Rz(azimuth) * Ry(-altitude) * Rx(limb), upstream's three glRotatefs.
    const place = (x, y, z) => {
      const y1 = (y * cl) - (z * sl);
      const z1 = (y * sl) + (z * cl);
      const x2 = (x * ca) + (z1 * sa);
      const z2 = (-x * sa) + (z1 * ca);
      const x3 = (x2 * cz) - (y1 * sz);
      const y3 = (x2 * sz) + (y1 * cz);
      return [x3, y3, z2];
    };
    const points = [place(distance, 0, -radius)];
    for (let i = 0; i < MOON_SEGMENTS - 1; i += 1) {
      const angle = (0.5 * Math.PI * (i - (MOON_SEGMENTS / 2) - 1)) / (MOON_SEGMENTS / 2);
      const sinA = Math.sin(angle);
      const cosA = Math.cos(angle);
      points.push(place(distance, coverage * radius * cosA, radius * sinA));
      points.push(place(distance, radius * cosA, radius * sinA));
    }
    points.push(place(distance, 0, radius));
    const position = this._phasedMoon.geometry.getAttribute('position');
    points.forEach((p, i) => position.setXYZ(i, p[0], p[1], p[2]));
    position.needsUpdate = true;
    this._phasedMoon.userData.wanted = visible;
    this._phasedMoon.visible = visible;
  }

  // Each frame: the sky pyramid and the stars stand around the eye, at the far
  // plane's reach, so they read as infinitely far away from wherever it goes.
  // In the game's frame, since the world groups carry the world's turn in an
  // XR session and the sky has to turn with the ground under it.
  _followSky() {
    if (!this.camera || !this.worldFrame) return;
    const pyramid = this._skyPyramid?.visible ? this._skyPyramid : null;
    const stars = this._starField?.visible ? this._starField : null;
    if (!pyramid && !stars) return;
    const eye = this.camera.getWorldPosition(SKY_EYE_SCRATCH);
    this.worldFrame.updateWorldMatrix(true, false);
    this.worldFrame.worldToLocal(eye);
    const worldScale = this.worldGroup.scale.x || 1;
    const reach = (this.camera.far * 0.6) / worldScale;
    if (pyramid) {
      pyramid.position.copy(eye);
      pyramid.scale.setScalar(reach);
    }
    if (stars && this._starRotation) {
      stars.matrix.copy(this._starRotation).scale(SKY_SCALE_SCRATCH.setScalar(reach))
        .setPosition(eye);
      stars.matrixWorldNeedsUpdate = true;
    }
  }

  clearWeather() {
    const weather = this._weather;
    if (!weather) return;
    weather.dropMesh.removeFromParent();
    weather.dropMesh.geometry.dispose();
    weather.dropMesh.material.map?.dispose();
    weather.dropMesh.material.dispose();
    if (weather.puddleMesh) {
      weather.puddleMesh.removeFromParent();
      weather.puddleMesh.geometry.dispose();
      weather.puddleMesh.material.map?.dispose();
      weather.puddleMesh.material.dispose();
    }
    this._weather = null;
  }

  // `_rainType` -- see "Weather" in docs/bzw.md and the comment over
  // `WEATHER_PRESETS`. `obstacles` is the same raw list `setObstacles` and
  // `setMeshes` split apart, kept here only for `getWeatherTopHeight`'s roof
  // raycast at each drop's reset -- not every frame, since a drop only needs a
  // new answer when it starts a new fall.
  buildWeather(mapSize, weather, obstacles) {
    if (!this.scene) return;
    this.clearWeather();
    const preset = weather && WEATHER_PRESETS[weather.type];
    if (!preset) return;

    const density = Math.max(0, Math.round(weather.density ?? preset.density ?? WEATHER_DEFAULT_DENSITY));
    if (density === 0) return;
    const spread = weather.spread ?? WEATHER_DEFAULT_SPREAD;
    const speed = weather.speed ?? preset.speed;
    const speedMod = weather.speedMod ?? preset.speedMod;
    const falling = speed < 0;
    let startZ = weather.startZ;
    let endZ = weather.endZ;
    if (!Number.isFinite(startZ) && !Number.isFinite(endZ)) {
      startZ = falling ? weatherSkyHeight() : 0;
      endZ = falling ? 0 : weatherSkyHeight();
    } else {
      startZ = Number.isFinite(startZ) ? startZ : 0;
      endZ = Number.isFinite(endZ) ? endZ : 0;
      // "make sure they make sense with the direction" -- WeatherRenderer.cxx:363-385.
      if (falling && endZ > startZ) [startZ, endZ] = [endZ, startZ];
      if (!falling && endZ < startZ) [startZ, endZ] = [endZ, startZ];
    }
    const roofs = weather.roofs ?? 1;
    const cullRoofTops = roofs >= 1;
    const roofPuddles = roofs >= 2;
    const doPuddles = weather.puddles ?? preset.puddles;
    const spin = weather.spin ?? preset.spin;
    const { billboard } = preset;
    const [halfW, halfH] = preset.size;
    const puddleColor = weather.puddleColor || preset.puddleColor || [1, 1, 1];
    const puddleSpeed = weather.puddleSpeed ?? preset.puddleSpeed ?? WEATHER_DEFAULT_PUDDLE_SPEED;
    const maxPuddleTime = weather.maxPuddleTime ?? WEATHER_DEFAULT_MAX_PUDDLE_TIME;

    const textureName = weather.texture || preset.texture;
    const puddleTextureName = weather.puddleTexture || 'puddle';
    const dropTexture = createStockMaterialTexture(textureName);
    const puddleTexture = createStockMaterialTexture(puddleTextureName);

    // `_useLineRain`: upstream's `GL_LINES` streak, one segment per drop
    // from its base colour at the drop up to its top colour.
    const lineRain = weather.lineRain === true;
    const lineColors = lineRain
      ? [weather.rainBaseColor || WEATHER_LINE_BASE_COLOR, weather.rainTopColor || WEATHER_LINE_TOP_COLOR]
        .map((rgba) => {
          const linear = new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace);
          return [linear.r, linear.g, linear.b, rgba[3] ?? 1];
        })
      : null;
    const lineHeight = preset.size[1];
    let dropMesh;
    if (lineRain) {
      dropTexture?.dispose();
      const lineGeometry = new THREE.BufferGeometry();
      const linePositions = new THREE.BufferAttribute(new Float32Array(density * 6), 3);
      const lineRgba = new THREE.BufferAttribute(new Float32Array(density * 8), 4);
      linePositions.setUsage(THREE.DynamicDrawUsage);
      lineRgba.setUsage(THREE.DynamicDrawUsage);
      lineGeometry.setAttribute('position', linePositions);
      lineGeometry.setAttribute('color', lineRgba);
      dropMesh = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false,
      }));
    } else {
      const dropGeometry = billboard
        ? buildWeatherBillboardGeometry(halfW, halfH)
        : buildWeatherCrossGeometry(halfW, halfH);
      const dropMaterial = createWeatherMaterial(dropTexture);
      dropMesh = new THREE.InstancedMesh(dropGeometry, dropMaterial, density);
      dropMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      dropGeometry.setAttribute(
        'instanceAlpha', new THREE.InstancedBufferAttribute(new Float32Array(density).fill(1), 1),
      );
    }
    // Upstream draws every drop with no frustum test at all --
    // `_CULLING_RAIN` is compiled out (`#define _CULLING_RAIN false`), so the
    // "smart" chunked culling in `WeatherRenderer.cxx` is dead code even
    // there.
    dropMesh.frustumCulled = false;
    dropMesh.renderOrder = WEATHER_RENDER_ORDER;

    let puddleMesh = null;
    if (doPuddles) {
      const puddleGeometry = buildWeatherPuddleGeometry();
      const puddleMaterial = createWeatherMaterial(puddleTexture, puddleColor);
      puddleMesh = new THREE.InstancedMesh(puddleGeometry, puddleMaterial, WEATHER_PUDDLE_CAPACITY);
      puddleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      puddleMesh.frustumCulled = false;
      puddleMesh.renderOrder = WEATHER_RENDER_ORDER;
      puddleMesh.count = 0;
      puddleGeometry.setAttribute(
        'instanceAlpha', new THREE.InstancedBufferAttribute(new Float32Array(WEATHER_PUDDLE_CAPACITY), 1),
      );
    }

    const posX = new Float32Array(density);
    const posY = new Float32Array(density);
    const posZ = new Float32Array(density);
    const dropSpeed = new Float32Array(density);
    const roofTop = new Float32Array(density);
    const spinPhase = new Float32Array(density);

    this._weather = {
      preset, density, spread, speed, speedMod, halfW, halfH, startZ, endZ, falling,
      cullRoofTops, roofPuddles, doPuddles, spin, billboard, puddleSpeed, maxPuddleTime,
      obstacles, dropMesh, posX, posY, posZ, dropSpeed, roofTop, spinPhase,
      lineRain, lineColors, lineHeight, puddleMesh, puddles: [], dummy: new THREE.Object3D(),
    };

    // Seed every drop scattered across the whole fall/rise, upstream's own
    // `rainStartZ + bzfrand() * rainHeightDelta` -- otherwise the sky would
    // visibly "fill in" from empty over the first few seconds.
    for (let i = 0; i < density; i += 1) {
      posX[i] = (Math.random() * 2 - 1) * spread;
      posY[i] = (Math.random() * 2 - 1) * spread;
      posZ[i] = startZ + (Math.random() * (endZ - startZ));
      dropSpeed[i] = speed + ((Math.random() * 2 - 1) * speedMod);
      roofTop[i] = (cullRoofTops && falling) ? getWeatherTopHeight(obstacles, posX[i], posY[i], startZ) : 0;
    }

    this.worldFrame.add(this._tagDraws(dropMesh, 'effect'));
    if (puddleMesh) this.worldFrame.add(this._tagDraws(puddleMesh, 'effect'));

    this._advanceWeatherDrops(this._weather, 0);
  }

  // `WeatherRenderer::update` -- moves every drop, resets one that reached the
  // ground or its roof (spawning a puddle first, unless the preset or
  // `_useRainPuddles`/`_rainRoofs` says otherwise), and ages the puddles
  // already down.
  updateWeather(deltaTime) {
    const weather = this._weather;
    if (!weather || !(deltaTime > 0)) return;
    // "not an important sim so just keep it smooth" -- WeatherRenderer.cxx:454.
    const dt = Math.min(deltaTime, 0.06);
    this._advanceWeatherDrops(weather, dt);
    this._advanceWeatherPuddles(weather, dt);
  }

  _advanceWeatherDrops(weather, dt) {
    const {
      density, dropMesh, posX, posY, posZ, dropSpeed, roofTop, spinPhase,
      spread, startZ, endZ, falling, cullRoofTops, roofPuddles, doPuddles,
      spin, billboard, speed, speedMod, obstacles, dummy, lineRain, lineColors, lineHeight,
    } = weather;
    // A billboard faces the camera, which turns in three.js's world; the
    // drops stand in the game's frame under the world groups.
    let cameraQuaternion = null;
    if (billboard && this.camera) {
      this.worldFrame.updateWorldMatrix(true, false);
      cameraQuaternion = WEATHER_BILLBOARD_QUATERNION
        .setFromRotationMatrix(this.worldFrame.matrixWorld)
        .invert()
        .multiply(this.camera.getWorldQuaternion(WEATHER_CAMERA_QUATERNION));
    }
    const dropAlpha = dropMesh.geometry.attributes.instanceAlpha;
    const linePositions = lineRain ? dropMesh.geometry.attributes.position : null;
    const lineRgba = lineRain ? dropMesh.geometry.attributes.color : null;

    for (let i = 0; i < density; i += 1) {
      posZ[i] += dropSpeed[i] * dt;
      spinPhase[i] += dt;

      const groundLevel = cullRoofTops ? roofTop[i] : endZ;
      const hitGround = falling ? posZ[i] < groundLevel : posZ[i] > endZ;
      if (hitGround) {
        if (doPuddles && (roofPuddles || !(cullRoofTops && falling && roofTop[i] !== 0))) {
          const puddleZ = falling ? groundLevel + 0.05 : endZ;
          this._addWeatherPuddle(weather, posX[i], posY[i], puddleZ);
        }
        posX[i] = (Math.random() * 2 - 1) * spread;
        posY[i] = (Math.random() * 2 - 1) * spread;
        posZ[i] = startZ;
        dropSpeed[i] = speed + ((Math.random() * 2 - 1) * speedMod);
        roofTop[i] = (cullRoofTops && falling)
          ? getWeatherTopHeight(obstacles, posX[i], posY[i], startZ)
          : 0;
      }

      if (lineRain) {
        this._writeLineDrop(linePositions.array, lineRgba.array, i, posX[i], posY[i], posZ[i],
          posZ[i] + lineHeight - (dropSpeed[i] * 0.15), lineColors);
        continue;
      }

      dummy.position.set(posX[i], posY[i], posZ[i]);
      if (billboard) {
        dummy.quaternion.copy(cameraQuaternion || dummy.quaternion);
      } else if (spin) {
        // A turn about the up axis over a tip about -y. Its billboard-path
        // spin (an extra roll on top of facing the camera) is dropped as not
        // worth the complication for a subtle, purely decorative tumble.
        dummy.rotation.set(0, 0 - (spinPhase[i] * dropSpeed[i] * 0.085), spinPhase[i] * dropSpeed[i] * 0.1, 'ZYX');
      } else {
        dummy.rotation.set(0, 0, 0);
      }
      dummy.updateMatrix();
      dropMesh.setMatrixAt(i, dummy.matrix);

      // `drawDrop`'s own near-ground fade -- within the last 2 units of the
      // surface a drop is about to hit.
      const heightAboveGround = falling ? (posZ[i] - groundLevel) : (endZ - posZ[i]);
      dropAlpha.array[i] = heightAboveGround < 2 ? Math.max(0, heightAboveGround * 0.5) : 1;
    }

    if (lineRain) {
      linePositions.needsUpdate = true;
      lineRgba.needsUpdate = true;
      return;
    }
    dropMesh.instanceMatrix.needsUpdate = true;
    dropAlpha.needsUpdate = true;
  }

  // `drawDrop`'s line branch, near-ground term included as upstream has it:
  // below 5 units `1 - 5/z` goes negative, so a streak brightens as it
  // lands rather than fading.
  _writeLineDrop(positions, rgba, i, x, y, z, topZ, colors) {
    const alphaMod = z < 5 ? 1 - (5 / z) : 0;
    const p = i * 6;
    positions[p] = x; positions[p + 1] = y; positions[p + 2] = z;
    positions[p + 3] = x; positions[p + 4] = y; positions[p + 5] = topZ;
    for (let end = 0; end < 2; end += 1) {
      const color = colors[end];
      const c = (i * 8) + (end * 4);
      rgba[c] = color[0]; rgba[c + 1] = color[1]; rgba[c + 2] = color[2];
      const alpha = color[3] - alphaMod;
      rgba[c + 3] = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    }
  }

  _addWeatherPuddle(weather, x, y, z) {
    if (!weather.puddleMesh) return;
    weather.puddles.push({ x, y, z, age: 0 });
    // A bound on live splashes, not upstream's unbounded vector -- see
    // `WEATHER_PUDDLE_CAPACITY`. Puddles age in the order they were laid, so
    // the oldest is always at the front.
    if (weather.puddles.length > WEATHER_PUDDLE_CAPACITY) weather.puddles.shift();
  }

  _advanceWeatherPuddles(weather, dt) {
    const { puddleMesh, puddles, maxPuddleTime, puddleSpeed, speed, dummy } = weather;
    if (!puddleMesh) return;
    while (puddles.length && puddles[0].age > maxPuddleTime) puddles.shift();
    const puddleAlpha = puddleMesh.geometry.attributes.instanceAlpha;
    for (let i = 0; i < puddles.length; i += 1) {
      const puddle = puddles[i];
      puddle.age += dt;
      // `drawPuddle`'s own growth curve: a splash widens as it ages rather
      // than starting full-size, `puddleSpeed` scaling how fast.
      const scale = Math.max(0.001, Math.abs(puddle.age * speed * 0.035 * puddleSpeed));
      dummy.position.set(puddle.x, puddle.y, puddle.z);
      dummy.rotation.set(0, 0, 0, 'XYZ');
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      puddleMesh.setMatrixAt(i, dummy.matrix);
      puddleAlpha.array[i] = Math.max(0, 1 - (puddle.age / maxPuddleTime));
    }
    puddleMesh.count = puddles.length;
    puddleMesh.instanceMatrix.needsUpdate = true;
    puddleAlpha.needsUpdate = true;
  }

  clearMountains() {
    if (!this.scene) return;
    this.mountainMeshes.forEach((mesh) => {
      mesh.removeFromParent();
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
      const y = 0 - (radius * Math.sin(angle));
      const nx = -Math.SQRT1_2 * Math.cos(angle);
      const ny = Math.SQRT1_2 * Math.sin(angle);
      let u = i / segmentCount;
      if (MOUNTAIN_TEXTURE_PATHS.length !== 1) {
        u = (u * (textureWidth - 2) + 1) / textureWidth;
      }

      positions.push(x, y, 0);
      positions.push(x, y, height);

      normals.push(nx, ny, Math.SQRT1_2);
      normals.push(nx, ny, Math.SQRT1_2);

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
    if (!this._worldDraws('mountains')) return;

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
      // `transparent: false` matters as much as the depth flags below: Three.js
      // always draws its transparent list after the whole opaque list, no
      // matter what `renderOrder` says, so a `transparent: true` material can
      // never be made to draw *before* an ordinary opaque box or tank --
      // only after, which is what let the mountain's own disabled depth test
      // paint over every already-drawn box, mesh and tank unconditionally.
      // `alphaTest` alone still cuts the silhouette out of the square
      // texture without needing the transparent list at all.
      const material = new THREE.MeshLambertMaterial({
        map: texture,
        transparent: false,
        alphaTest: 0.02,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
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
      frontMountain.renderOrder = MOUNTAIN_RENDER_ORDER;
      this.worldFrame.add(this._tagDraws(frontMountain, 'scenery'));
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
      backMountain.renderOrder = MOUNTAIN_RENDER_ORDER;
      this.worldFrame.add(this._tagDraws(backMountain, 'scenery'));
      this.mountainMeshes.push(backMountain);
    }
  }

  clearCelestialBodies() {
    if (!this.scene) return;
    // All three share one sphere, so it is disposed once rather than per mesh.
    const geometries = new Set();
    this.celestialMeshes.forEach((mesh) => {
      mesh.removeFromParent();
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
    if (!this.scene || !this.worldFrame) return;
    if (!this.celestialEnabled || !this._worldDraws('celestial') || !this._worldDraws('sky')) {
      this.clearCelestialBodies();
      return;
    }

    if (!this.sunMesh || !this.sunGlowMesh || !this.moonMesh) {
      this.clearCelestialBodies();

      const celestialGeometry = new THREE.SphereGeometry(1, 32, 32);
      const addCelestialMesh = (material, renderOrder) => {
        const mesh = this._tagDraws(new THREE.Mesh(celestialGeometry, material), 'scenery');
        mesh.renderOrder = renderOrder;
        this.worldFrame.add(mesh);
        this.celestialMeshes.push(mesh);
        return mesh;
      };

      this.sunMesh = addCelestialMesh(new THREE.MeshBasicMaterial({
        color: 0xffff00, fog: false, depthTest: true, depthWrite: false, toneMapped: false,
      }), CELESTIAL_RENDER_ORDER);
      // `transparent: true` would put this in Three.js's transparent render
      // list, which always draws after the *entire* opaque list -- mountains,
      // tanks, everything -- regardless of renderOrder (issue #102; the same
      // trap createMountains's own comment warns about, from the other side).
      // CustomBlending with plain alpha factors gets the same translucent
      // look while keeping the glow opaque-queue-sorted, so mountains still
      // paint over it as intended.
      this.sunGlowMesh = addCelestialMesh(new THREE.MeshBasicMaterial({
        color: 0xffff88, opacity: 0.3, fog: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
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
    this.skyBeaconTopZ = 0;
    if (!this.scene) return;
    this.clouds.forEach((cloud) => {
      cloud.removeFromParent();
      // A cloud owns its geometry outright; the material is the sky's.
      cloud.geometry.dispose();
    });
    this.clouds = [];
  }

  // One white for every cloud in the sky. Nothing about a puff varies but where
  // it is and how big, so nothing about the material can.
  _getCloudMaterial() {
    if (!this._cloudMaterial) {
      // A real translucent puff needs `transparent: true`, which puts it in
      // Three.js's transparent render list -- always drawn after the whole
      // opaque list regardless of `renderOrder`, unlike a mountain's hard
      // alpha-tested cutout (see `createMountains`). Disabling its depth
      // test the same way would then paint it over every already-drawn box,
      // mesh and tank unconditionally, so a cloud keeps ordinary depth
      // testing and only the occasional near-field z-fight issue #92's own
      // comment called "to a lesser extent".
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

  buildCloudLayer(mapSize) {
    this.clearCloudLayer();
    if (!this.scene || !this._worldDraws('clouds')) return;
    const groundSize = 10 * mapSize;
    const inner = BZFLAG_CLOUD_INNER_SCALE * groundSize;
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    const positions = [];
    const uvs = [];
    const colors = [];
    // Inner corners 0-3 at full opacity, outer 4-7 faded to nothing.
    [inner, groundSize].forEach((extent, ring) => {
      corners.forEach(([cx, cz]) => {
        positions.push(cx * extent, 0 - (cz * extent), 0);
        uvs.push((cx * extent / groundSize) * BZFLAG_CLOUD_REPEATS, (cz * extent / groundSize) * BZFLAG_CLOUD_REPEATS);
        colors.push(1, 1, 1, ring === 0 ? 1 : 0);
      });
    });
    const index = [0, 1, 2, 0, 2, 3];
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      index.push(i, 4 + i, 4 + next, i, 4 + next, next);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    geometry.setIndex(index);
    const texture = this._createSharedImageTexture(BZFLAG_CLOUD_LAYER_TEXTURE);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    // Blended but not `transparent`: three draws every transparent object after
    // every opaque one, whatever its render order, so a transparent layer drawn
    // without depth would paint over the whole world. In the opaque list it
    // sorts by `renderOrder` -- after the mountains, before everything else --
    // and the custom blend keeps its faded edge and the texture's own alpha.
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      vertexColors: true,
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    // Ten world sizes out is far past the camera's far plane, which only
    // reaches the mountains. Drawn without depth, the layer has no use for its
    // depth either, so every vertex is put just inside the far plane and none of
    // it is clipped away -- the whole layer out to its faded edge, as upstream's.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n  gl_Position.z = gl_Position.w * 0.9999;',
      );
    };
    const layer = new THREE.Mesh(geometry, material);
    layer.position.z = BZFLAG_CLOUD_HEIGHT_TANK_HEIGHTS * TANK.height;
    layer.renderOrder = CLOUD_LAYER_RENDER_ORDER;
    layer.frustumCulled = false;
    layer.visible = !this.cloudsHiddenForOverview;
    this.cloudLayer = layer;
    this.worldFrame.add(this._tagDraws(layer, 'scenery'));
  }

  clearCloudLayer() {
    if (!this.cloudLayer) return;
    this.cloudLayer.removeFromParent();
    this.cloudLayer.geometry.dispose();
    this.cloudLayer.material.map?.dispose();
    this.cloudLayer.material.dispose();
    this.cloudLayer = null;
  }

  // `cloudBase` is where a sky beacon hangs from: the server's lowest cloud
  // height, a jump above the world's tallest obstacle.
  createClouds(cloudsData = [], cloudBase = null) {
    if (!this.scene) return;
    this.clearClouds();
    if (!this._worldDraws('clouds')) return;

    cloudsData.forEach((cloudData) => {
      const cloud = this._tagDraws(
        new THREE.Mesh(this._buildCloudGeometry(cloudData.puffs), this._getCloudMaterial()),
        'cloud',
      );
      cloud.position.set(cloudData.x, cloudData.y, cloudData.z);
      // A world loaded while the overview is up -- the map picker cycling
      // through maps behind the entry dialog -- would otherwise arrive with
      // its weather showing over the map the picker is there to show.
      cloud.visible = !this.cloudsHiddenForOverview;
      cloud.userData.velocity = 0.5 + Math.random() * 1.0;
      cloud.userData.startX = cloudData.x;

      this.worldFrame.add(cloud);
      this.clouds.push(cloud);
    });

    // Where a sky beacon hangs from. The server puts the lowest cloud a jump
    // above the tallest thing in the world (generateClouds), so a mark that
    // reaches the bottom of the layer clears the map without being lost in it.
    // A world that sent no clouds leaves it on the ground and every beacon
    // falls back to a length of its own.
    this.skyBeaconTopZ = this.clouds.reduce(
      (lowest, cloud) => Math.min(lowest, cloud.position.z),
      Number.isFinite(cloudBase) ? cloudBase : Infinity,
    );
    if (!Number.isFinite(this.skyBeaconTopZ)) this.skyBeaconTopZ = 0;
  }

  getClouds() {
    return this.clouds;
  }

  updateClouds(deltaTime, mapSize) {
    // `addCloudDrift(1.0 * dt, 0.731 * dt)`, a hundredth of a repeat a unit.
    const layerMap = this.cloudLayer?.material.map;
    if (layerMap) {
      layerMap.offset.x = (layerMap.offset.x + ((0.01 * deltaTime) / BZFLAG_CLOUD_REPEATS)) % 1;
      layerMap.offset.y = (layerMap.offset.y + ((0.01 * 0.731 * deltaTime) / BZFLAG_CLOUD_REPEATS)) % 1;
    }
    const mapBoundary = mapSize / 2;
    this.clouds.forEach((cloud) => {
      cloud.position.x += cloud.userData.velocity * deltaTime;
      if (cloud.position.x > mapBoundary + 30) {
        cloud.position.x = -mapBoundary - 30;
      }
    });
  }
}
