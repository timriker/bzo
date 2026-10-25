/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The radar: the panel in the corner, its range and its size, and what it
// shows -- obstacles, tanks, flags and shots, jammed or not. client.js owns the
// game it shows, handed over once by `useRadarClient`: what the client
// changes as it runs is read through `client`, the rest is kept here.

import { TANK, getObstacleBase, getObstacleHeight } from './collision.mjs';
import { ANTIDOTE_FLAG_COLOR, BURROW_RADAR_FACTOR, FLAG_RADIUS, FLAG_STATUS, RADAR_JAM_DECAY_MIN, getFlagTeamIndex, getNextRadarJamDecay } from './flags.mjs';
import { colorToCSS } from './hud.js';
import { HUNT_MARKER_COLOR } from './hunt.mjs';
import { FACE_NO_RADAR, meshArrays } from './mesh-arrays.mjs';
import { RADAR_BOX_CORNERS, clipPolygonToRadarSquare, ensureRadarPolygonBuffers, getRadarClipBuffer, getRadarMeshFaceCull, getRadarMeshObstacleCull, getRadarObstacleCullRadius, getRadarPolygonScratch, isOutsideRadarSquare as isOutsideRadarSquareOf, isTippedRadarSpin } from './radar-geometry.mjs';
import { meshSpinRadians } from './render.js';
import { PLAYER_TEAM, getPlayerTeamRadarColor, getTeamFromColorIndex } from './teams.mjs';

let DEFAULT_MAP_SIZE, flags, getEffectiveTankColor, getFlagRadarStyle, getMyFlag, getMyTeamColorIndex, isColorblind, isHiddenFromRadar, isHuntMarked, isPreviewingAltWorld, isRadarJammed, isSeer, isSoughtTeamFlag, isTheRabbit, radarSoughtFlags, showMessage, tankAzimuth;
let client;

export function useRadarClient(deps, liveClient) {
  ({ DEFAULT_MAP_SIZE, flags, getEffectiveTankColor, getFlagRadarStyle, getMyFlag, getMyTeamColorIndex, isColorblind, isHiddenFromRadar, isHuntMarked, isPreviewingAltWorld, isRadarJammed, isSeer, isSoughtTeamFlag, isTheRabbit, radarSoughtFlags, showMessage, tankAzimuth } = deps);
  client = liveClient;
}

const RADAR_ZOOM_LEVELS = [0.25, 0.5, 1.0];
const RADAR_ZOOM_LABELS = ['Short', 'Medium', 'Long'];
// BZFlag's displayRadarRange default (defaultBZDB.cxx). The level is deliberately
// not persisted: a headset has no key or button to zoom with, so every session
// starts at a range that reads well on every device.
export const RADAR_ZOOM_DEFAULT = 0.5;
const RADAR_ZOOM_MIN = 0.005;
const RADAR_ZOOM_MAX = 2.0;
const RADAR_ZOOM_STEP = 1.05;
export let radarZoomLevel = RADAR_ZOOM_DEFAULT;
// `?radarZoom=` -- a measurement knob, the same rules as the ones in render.js:
// URL only, never persisted, never in the UI, clamped on the way in, and on
// every `renderer.stats` line. The panel's cost is what its range puts on it,
// so a client asked to measure a map has to be able to start wide rather than
// be wheeled there by hand -- and a sample that did not say which range it was
// taken at could not be compared with the one beside it.
function readRadarZoomKnob() {
  const raw = new URLSearchParams(window.location.search).get('radarZoom');
  if (raw === null) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(RADAR_ZOOM_MIN, Math.min(RADAR_ZOOM_MAX, numeric));
}
export const radarZoomKnob = readRadarZoomKnob();
if (radarZoomKnob !== null) radarZoomLevel = radarZoomKnob;

function normalizeRadarZoomLevel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return RADAR_ZOOM_DEFAULT;
  return Math.max(RADAR_ZOOM_MIN, Math.min(RADAR_ZOOM_MAX, numeric));
}

function getRadarZoomLabel(level = radarZoomLevel) {
  const index = RADAR_ZOOM_LEVELS.findIndex((preset) => Math.abs(level - preset) < 1e-4);
  if (index >= 0) return RADAR_ZOOM_LABELS[index];
  const rounded = Math.round(level * 1000) / 1000;
  return `${rounded}x`;
}

export function updateRadarZoomButton() {
  const radarZoomBtn = document.getElementById('radarZoomBtn');
  if (!radarZoomBtn) return;
  const label = getRadarZoomLabel();
  radarZoomBtn.textContent = `Radar: ${label}`;
  radarZoomBtn.title = `Radar range preset: ${label}`;
}

export function setRadarZoomLevel(level, { announce = true } = {}) {
  const normalized = normalizeRadarZoomLevel(level);
  if (normalized === radarZoomLevel) return false;
  radarZoomLevel = normalized;
  updateRadarZoomButton();
  if (announce) {
    showMessage(`Radar range: ${getRadarZoomLabel(radarZoomLevel)}`);
  }
  return true;
}

export function cycleRadarZoomLevel(direction = 1) {
  let nearestIndex = 0;
  let nearestDelta = Math.abs(radarZoomLevel - RADAR_ZOOM_LEVELS[0]);
  for (let i = 1; i < RADAR_ZOOM_LEVELS.length; i++) {
    const delta = Math.abs(radarZoomLevel - RADAR_ZOOM_LEVELS[i]);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearestIndex = i;
    }
  }
  const step = direction < 0 ? -1 : 1;
  const nextIndex = (nearestIndex + step + RADAR_ZOOM_LEVELS.length) % RADAR_ZOOM_LEVELS.length;
  setRadarZoomLevel(RADAR_ZOOM_LEVELS[nextIndex]);
}

export function adjustRadarZoom(direction) {
  if (direction > 0) {
    setRadarZoomLevel(radarZoomLevel * RADAR_ZOOM_STEP);
  } else if (direction < 0) {
    setRadarZoomLevel(radarZoomLevel / RADAR_ZOOM_STEP);
  }
}

// The radar's size: half again its base size (`RADAR_BASE_SHARE` of the
// smaller screen dimension, `RADAR_BASE_MIN` to `RADAR_BASE_MAX`) as far as
// it stays clear of the targeting box and what hangs off its right -- the
// altimeter, and the reload bars with their shot-limit line. Each is cleared
// one way or the other: the radar in its corner ends left of it or above it,
// whichever lets it grow more. Never smaller than the base. The size is
// published as `--radar-size`, which the debug HUD below it measures its
// height against.
const RADAR_BASE_SHARE = 0.375;
const RADAR_BASE_MIN = 120;
const RADAR_BASE_MAX = 390;
const RADAR_GROWTH = 1.5;
const RADAR_HUD_EDGE = 10;
const RADAR_BOX_GAP = 10;

function radarSizeFor(width, height) {
  const base = Math.max(RADAR_BASE_MIN, Math.min(RADAR_BASE_MAX, Math.round(Math.min(width, height) * RADAR_BASE_SHARE)));
  // The box as styles.css draws it: `--motion-box` is 74 units of
  // min(width / 256, height / 192), and `--altimeter-width` 8 of them,
  // between 14 and 48 pixels.
  const unit = Math.min(width / 256, height / 192);
  const box = 74 * unit;
  const boxRight = (width / 2) + (box / 2);
  const altimeter = Math.max(14, Math.min(48, 8 * unit));
  // The reload bars as `updateShotStatus` (hud.js) places them: a bar's width
  // and 16 off the box, as wide as five of the shot-limit line's characters,
  // the bars centred on the box -- five of them at most -- and the line above.
  const bar = Math.max(18, Math.round(width / 50));
  const barHeight = Math.max(8, Math.round(height / 80));
  const barSpace = Math.max(2, Math.round(barHeight / 10) + 2);
  const font = Math.max(10, Math.round(barHeight * 1.2));
  const bars = (5 * barHeight) + (4 * barSpace);
  const blockers = [
    { right: boxRight + altimeter, top: (height / 2) - (box / 2) },
    {
      right: boxRight + bar + 16 + Math.max(bar, 5 * font),
      top: (height / 2) - (bars / 2) - (barSpace + font + 2),
    },
  ];
  const room = Math.floor(Math.min(...blockers.map(({ right, top }) => Math.max(
    width - RADAR_HUD_EDGE - right - RADAR_BOX_GAP,
    top - RADAR_HUD_EDGE - RADAR_BOX_GAP,
  ))));
  return Math.max(base, Math.min(Math.round(base * RADAR_GROWTH), room));
}

export function resizeRadar() {
  if (!client.radarCanvas) return;
  const size = radarSizeFor(window.innerWidth, window.innerHeight);
  client.radarCanvas.width = size;
  client.radarCanvas.height = size;
  client.radarCanvas.style.width = size + 'px';
  client.radarCanvas.style.height = size + 'px';
  document.documentElement.style.setProperty('--radar-size', `${size}px`);
}

const RADAR_WORLD_INSET_PX = 10;
const RADAR_EDGE_DOT_INSET_PX = 4;
const RADAR_TANK_ARROW_EXTENT_PX = 10;
// RadarRenderer::drawFlag and drawFlagOnTank size their crosses in world units
// with a pixel floor, so a distant flag stays visible at any radar range.
const RADAR_FLAG_MIN_HALF_PX = 3;
function radarFlagOnTankRadii() {
  return 2.5 * TANK.radius;
}
const RADAR_FLAG_ON_TANK_MIN_HALF_PX = 4;

function getRadarWorldHalfExtent(radius) {
  return Math.max(1, radius - RADAR_WORLD_INSET_PX);
}

function radarPixelsToWorldDistance(pixelDistance, radarDistance, radarWorldHalfExtent) {
  if (pixelDistance <= 0) return 0;
  const pixelsPerWorldUnit = radarWorldHalfExtent / Math.max(radarDistance, 1e-6);
  return pixelDistance / Math.max(pixelsPerWorldUnit, 1e-6);
}

// A world point (x, y) on the panel, relative to its centre at the player
// (px, py) and turned so the player's azimuth points up: x to the right, y
// down, as a canvas row runs.
//
// The azimuth is one value for the whole frame and this runs once per vertex
// of every obstacle in the map, so a caller that draws more than one thing
// hands its own sine and cosine in rather than paying for them again here.
function worldToRadarRelative(worldX, worldY, px, py, azimuth, azimuthCos, azimuthSin) {
  const dx = worldX - px;
  const dy = worldY - py;
  const cos = azimuthCos === undefined ? Math.cos(azimuth) : azimuthCos;
  const sin = azimuthSin === undefined ? Math.sin(azimuth) : azimuthSin;
  return { x: (dx * sin) - (dy * cos), y: 0 - ((dx * cos) + (dy * sin)) };
}

function radarRelativeToCanvas(radarX, radarY, center, radarWorldHalfExtent, radarDistance) {
  return {
    x: center + (radarX / radarDistance) * radarWorldHalfExtent,
    y: center + (radarY / radarDistance) * radarWorldHalfExtent,
  };
}

function world2Radar(worldX, worldY, px, py, azimuth, center, radius, shotDistance) {
  const rel = worldToRadarRelative(worldX, worldY, px, py, azimuth);
  return radarRelativeToCanvas(rel.x, rel.y, center, getRadarWorldHalfExtent(radius), shotDistance);
}

// RadarRenderer::colorScale and transScale. Anything at the player's own level
// is drawn at full strength and everything else fades with the altitude gap,
// over `RADAR_DEPTH_FACTOR` units and no further than its own floor. The two
// upstream functions differ only in that floor: objects stop at 0.35, the
// obstacles they stand on at 0.5.
const RADAR_DEPTH_FACTOR = 40;
const RADAR_OBJECT_DEPTH_FLOOR = 0.35;
const RADAR_OBSTACLE_DEPTH_FLOOR = 0.5;

function getRadarDepthScale(playerZ, base, height, floor) {
  const top = base + height;
  if (playerZ >= base && playerZ <= top) return 1;
  const gap = playerZ > top ? (playerZ - top) : (base - playerZ);
  return Math.max(floor, 1 - (gap / RADAR_DEPTH_FACTOR));
}

function getRadarOpacity(playerZ, base = 0, height = 0) {
  return getRadarDepthScale(playerZ, base, height, RADAR_OBSTACLE_DEPTH_FLOOR);
}

// A top-down panel should read like a height map: where two obstacles overlap,
// the higher surface is the one you are looking at, so the lowest are painted
// first. Upstream draws its boxes and then its pyramids in map order and lets a
// pyramid cover the base standing beside it, which is what made the ring of
// supports around a hix base look like it was on top of the base.
//
// Sorted once per map rather than per frame, keyed on the obstacle list itself.
let radarObstacleOrder = { source: null, list: [] };
let radarBaseList = { source: null, list: [] };

// The bases, drawn apart from the obstacles and after them: an outline in the
// team's own radar colour, as upstream's `RadarRenderer::renderBasesAndTeles`
// draws them (a `GL_LINE_LOOP` in `Team::getRadarColor`). Filled, a base hid
// the players and the flag on it, which is what a base is for. Unshaded and
// undimmed, as upstream's is -- an outline has no area to read as ground.
function getRadarBases() {
  if (radarBaseList.source !== client.OBSTACLES) {
    radarBaseList = {
      source: client.OBSTACLES,
      list: client.OBSTACLES
        .filter((obs) => obs.kind === 'base' && !obs.noRadar)
        .map((obs) => {
          const team = getTeamFromColorIndex(Number(obs.team));
          const color = team ? getPlayerTeamRadarColor(team) : null;
          return {
            obs,
            cullRadius: getRadarObstacleCullRadius(obs),
            stroke: Number.isFinite(color) ? colorToCSS(color) : RADAR_NEUTRAL_FILL,
          };
        }),
    };
  }
  return radarBaseList.list;
}

function getRadarObstacleTop(obs) {
  return getObstacleBase(obs) + getObstacleHeight(obs);
}

function getRadarObstacles() {
  if (radarObstacleOrder.source !== client.OBSTACLES) {
    radarObstacleOrder = {
      source: client.OBSTACLES,
      // A material's `noradar` flag (docs/bzw.md, "Materials and appearance")
      // -- upstream's RadarRenderer skips a face whose material asks for it;
      // bzo has no per-face radar drawing to skip, so the whole obstacle sits
      // out instead. A mesh draws through `getRadarMeshObstacles` below instead of
      // here -- it has no single footprint the way a box's `w`/`d` gives one.
      list: [...client.OBSTACLES]
        .filter((obs) => !obs.noRadar && obs.type !== 'mesh' && obs.kind !== 'base')
        .sort((left, right) => getRadarObstacleTop(left) - getRadarObstacleTop(right))
        .map((obs) => ({ obs, cullRadius: getRadarObstacleCullRadius(obs) })),
    };
  }
  return radarObstacleOrder.list;
}

// A mesh's own radar footprint -- upstream's own "enhanced" radar mode
// (RadarRenderer.cxx), the higher-quality one of its two ("bzo does not
// mirror BZFlag's client display options", AGENTS.md): each face draws for
// itself rather than the mesh as one shape, and only a face angled at least
// partly upward (`plane[1] > 0`, bzo's Y the same up axis upstream's Z is)
// draws at all from a plan view -- a vertical wall would draw edge-on as
// noise, not signal, the same reason upstream skips it. A face's own
// `noradar` (inherited from the mesh's own default, same as any other
// material property a face does not restate) drops it same as any other
// obstacle's. Sorted and cached the same way `getRadarObstacles` is.
// Grouped by the mesh rather than kept flat, because how much of a mesh is
// worth drawing is one decision for the whole of it -- see
// `RADAR_MESH_FOOTPRINT_PIXELS`. Every face of a mesh shares its top altitude,
// so sorting the meshes by that gives the same paint order a flat list sorted
// face by face did.
let radarMeshOrder = { source: null, list: [] };

// A mesh's drawn faces all share one colour where every one of them states the
// same, which is the colour its footprint can stand in with. Mixed, the panel's
// neutral grey is the only honest answer for a shape that is several colours.
function getRadarMeshFootprintTint(arrays, faces) {
  let tint = null;
  for (const { f } of faces) {
    const { color } = arrays.materials[arrays.faceMaterial[f]];
    if (!color) return null;
    if (!tint) tint = color;
    else if (color[0] !== tint[0] || color[1] !== tint[1] || color[2] !== tint[2]) {
      return null;
    }
  }
  return tint;
}

function getRadarMeshObstacles() {
  if (radarMeshOrder.source !== client.OBSTACLES) {
    const entries = [];
    let widestFace = 0;
    client.OBSTACLES.forEach((obs) => {
      if (obs.type !== 'mesh' || !obs.bounds) return;
      // Out of the mesh's flat arrays rather than a face object apiece
      // (issue #153). The panel keeps only faces that point upward and are
      // not `noradar`, both of which the arrays carry.
      const arrays = meshArrays(obs);
      const faces = [];
      for (let f = 0; f < arrays.faceCount; f += 1) {
        if (arrays.facePlanes[(f * 4) + 2] <= 0) continue;
        if (arrays.faceFlags[f] & FACE_NO_RADAR) continue;
        const cornerCount = arrays.faceStart[f + 1] - arrays.faceStart[f];
        widestFace = Math.max(widestFace, cornerCount);
        faces.push({ f, ...getRadarMeshFaceCull(obs, arrays, f) });
      }
      if (!faces.length) return;
      entries.push({
        obs,
        arrays,
        faces,
        footprintTint: getRadarMeshFootprintTint(arrays, faces),
        ...getRadarMeshObstacleCull(obs),
      });
    });
    // Sized for the widest face the map has, once, rather than growing the
    // scratch buffers part-way through a frame.
    ensureRadarPolygonBuffers((widestFace * 2) + 8);
    radarMeshOrder = {
      source: client.OBSTACLES,
      list: entries.sort((left, right) => left.obs.bounds.maxZ - right.obs.bounds.maxZ),
    };
  }
  return radarMeshOrder.list;
}

// The obstacles that never move, painted once into a world-space image and
// drawn each frame as that one image (#133). The only thing that changes the
// picture is the player's height, through `getRadarOpacity`: so the image is
// baked at one height and stays good while the player stays near it, and a
// player going up or down draws live until they have held a height long
// enough to bake again. A tank spends most of its life on the ground, so most
// frames are one `drawImage` however much map there is.
//
// Resolution is the panel's own pixels per world unit at the current zoom,
// oversampled because the image is turned with the heading every frame and
// resampling a texel per pixel would blur. Zoomed far enough in that the
// image would be too big, the live path draws instead -- and there it is
// already cheap, because nearly everything is outside the panel.
const RADAR_CACHE_OVERSAMPLE = 2;
const RADAR_CACHE_MAX_PIXELS = 2048;
// How long a height has to hold before it is worth baking at.
const RADAR_CACHE_SETTLE_MS = 250;
let radarObstacleCache = null;
// Frames drawn each way since the last `renderer.stats` line.
export const radarCacheFrames = { cached: 0, live: 0, bakes: 0 };

function getRadarObstacleCache({ mapSize, pz, size, radarDistance, scale }) {
  const resolution = scale * RADAR_CACHE_OVERSAMPLE;
  const pixels = Math.ceil(mapSize * resolution);
  if (!(pixels > 0) || pixels > RADAR_CACHE_MAX_PIXELS) {
    radarCacheFrames.live += 1;
    return { ready: false, bakeNow: false };
  }
  const now = performance.now();
  let cache = radarObstacleCache;
  if (!cache || cache.source !== client.OBSTACLES || cache.mapSize !== mapSize
    || cache.size !== size || cache.radarDistance !== radarDistance) {
    const canvas = cache?.canvas || document.createElement('canvas');
    canvas.width = pixels;
    canvas.height = pixels;
    cache = {
      source: client.OBSTACLES,
      mapSize,
      size,
      radarDistance,
      canvas,
      ctx: canvas.getContext('2d'),
      resolution,
      bakedZ: NaN,
      lastZ: pz,
      stillSince: now,
    };
    radarObstacleCache = cache;
  }
  if (Math.abs(pz - cache.lastZ) > 1e-3) {
    cache.lastZ = pz;
    cache.stillSince = now;
  }
  // Half an opacity step of `addRadarFill`'s rounding, in height: within it,
  // a live paint would round to the same fill the image holds.
  const heightTolerance = (RADAR_DEPTH_FACTOR / RADAR_FILL_ALPHA_STEPS) / 2;
  if (Math.abs(pz - cache.bakedZ) <= heightTolerance) {
    radarCacheFrames.cached += 1;
    return { ready: true, canvas: cache.canvas };
  }
  radarCacheFrames.live += 1;
  const bakeNow = now - cache.stillSince >= RADAR_CACHE_SETTLE_MS;
  return {
    ready: false,
    bakeNow,
    canvas: cache.canvas,
    ctx: cache.ctx,
    resolution: cache.resolution,
    markBaked: () => {
      cache.bakedZ = pz;
      radarCacheFrames.bakes += 1;
    },
  };
}

// Team::getRadarColor is what upstream's radar draws a base in
// (RadarRenderer.cxx:1186), and bzo has the same table. That colour and the one
// a map paints an obstacle are both shaded towards the radar's neutral grey, so
// a coloured surface still reads as ground rather than as a tank.
const RADAR_NEUTRAL_FILL_RGB = [180, 180, 180];
const RADAR_TINT_STRENGTH = 0.65;
// A base's outline, in panel pixels. Upstream's is a one-pixel line on a panel
// a fraction the size of this one.
const RADAR_BASE_OUTLINE_WIDTH = 1.5;
const RADAR_NEUTRAL_FILL = `rgb(${RADAR_NEUTRAL_FILL_RGB.join(',')})`;

// How finely an obstacle's depth opacity is rounded before it decides whether
// the batched fill can keep going -- see `addRadarFill`.
const RADAR_FILL_ALPHA_STEPS = 32;

// How small a mesh has to be on the panel before its own footprint stands in
// for its faces. A mesh this wide has faces a pixel or two across, which the
// panel cannot tell apart from the outline around them -- and a map built out
// of a few `define` blocks placed a couple of hundred times puts tens of
// thousands of such faces on the panel at a wide zoom, each one a polygon the
// radar walks and fills for a pixel. It is bzo's own answer to what a map that
// ships `radarLods` would have answered for itself (#90): the detail a plan
// view cannot show is not drawn.
const RADAR_MESH_FOOTPRINT_PIXELS = 10;

// And how small one face of a mesh too big to collapse has to be before it is
// left out. A polygon narrower than a pixel cannot draw a pixel: it tints one,
// faintly, under whatever its neighbours put there. Measured on
// `import-xs.bzexcess.com_5155.bzw` at the widest range, 2160 of the 7429
// faces that survive the footprint test are this small, and they are the
// interior detail of structures whose own large faces draw the shape either
// way.
const RADAR_FACE_MIN_PIXELS = 1;

// Channels are 0 to 1, as the colour a map states is.
function getRadarShadedFill(red, green, blue) {
  const shade = (value, neutral) => Math.round(
    (neutral * (1 - RADAR_TINT_STRENGTH))
    + (Math.max(0, Math.min(1, value)) * 0xff * RADAR_TINT_STRENGTH)
  );
  const [neutralRed, neutralGreen, neutralBlue] = RADAR_NEUTRAL_FILL_RGB;
  return `rgb(${shade(red, neutralRed)},${shade(green, neutralGreen)},${shade(blue, neutralBlue)})`;
}

// Cached by the colour rather than by the obstacle: a map that paints fifty
// pads one colour cuts one string, and a colour means the same fill whatever
// map it came from.
const radarTintFills = new Map();

function getRadarTintFill(tint) {
  const key = `${tint[0]},${tint[1]},${tint[2]}`;
  const cached = radarTintFills.get(key);
  if (cached) return cached;
  const fill = getRadarShadedFill(tint[0], tint[1], tint[2]);
  radarTintFills.set(key, fill);
  return fill;
}

// An obstacle takes the colour its map painted it, if it painted one. The cap
// first: the radar looks down. A base is not filled at all (`getRadarBases`).
function getObstacleRadarFillStyle(obs) {
  if (!obs) return RADAR_NEUTRAL_FILL;
  const tint = obs.capColor || obs.wallColor;
  return tint ? getRadarTintFill(tint) : RADAR_NEUTRAL_FILL;
}

// A blip the player is looking for is ringed: a hunted tank, the player's own
// team flags, and the antidote. Upstream rings none of the three. It marks the
// hunted tank by flashing its blip cyan every fifth of a second
// (RadarRenderer.cxx:136), and it leaves the two flag bearings to the heading
// tape (prepareTheHUD, playing.cxx:6820), which an immersive session has no room
// for.
//
// A ring rather than a flash: a flash is half invisible on a client running at a
// low frame rate, which is the client bzo has to draw for.
//
// The hunted ring is upstream's own hunt cyan, because its blip is one of a
// panel full of per-player colours and grey is the one shade that does not read
// against a dark panel. A flag's ring takes the colour of the cross it rings,
// which is already the team's or the antidote's yellow, so a second colour would
// say nothing the cross does not.
//
// XR needs no separate path: the XR radar panel is textured from this canvas.
//
// The cyan itself lives in `hunt.mjs`, because the scoreboard's bullseye wears
// it too and a second literal is how the two would eventually disagree.
const RADAR_HUNT_RING_COLOR = colorToCSS(HUNT_MARKER_COLOR);
// The antidote's yellow as a style, cut once. Every other flag colour on the
// panel goes through `getFlagRadarStyle`'s cache for the same reason: the radar
// is redrawn every frame on a client with one core to spend.
export const ANTIDOTE_FLAG_STYLE = colorToCSS(ANTIDOTE_FLAG_COLOR);
// A `#rrggbb` style scaled toward black, cut once per colour for the same reason.
const dimmedRadarStyles = new Map();
function dimRadarColor(style, factor) {
  const key = `${style}|${factor}`;
  let dimmed = dimmedRadarStyles.get(key);
  if (dimmed === undefined) {
    const rgb = /^#[0-9a-f]{6}$/i.test(style) ? parseInt(style.slice(1), 16) : 0x888888;
    const scale = (shift) => Math.round(((rgb >> shift) & 0xff) * factor) << shift;
    dimmed = colorToCSS(scale(16) | scale(8) | scale(0));
    dimmedRadarStyles.set(key, dimmed);
  }
  return dimmed;
}
const RADAR_MARKER_RING_RADIUS = 9;
const RADAR_MARKER_RING_WIDTH = 1.5;
// Clear air between a ringed cross and its ring, for the zoom levels where the
// cross is sized in world units and has grown past the default radius.
const RADAR_MARKER_RING_GAP = 3;

// RadarRenderer::drawTank's height box: a diamond round the tank that grows
// with its height over the world's `_boxHeight`, half again as wide at one box
// up, so a tank on a building reads as one (RadarRenderer.cxx:204). Upstream
// starts it at the tank's own blip size, as this does at its arrow's; a tank
// below the ground starts it small. Drawn in the tank's own frame, which is
// screen-aligned here, as upstream's is.
const RADAR_HEIGHT_BOX_BURROWED_PX = 3;
function drawRadarHeightBox(height, style) {
  const boxHeight = client.gameConfig?.BOX_HEIGHT > 0 ? client.gameConfig.BOX_HEIGHT : 6.0 * 1.57;
  const y = Number.isFinite(height) ? height : 0;
  const base = y < 0 ? RADAR_HEIGHT_BOX_BURROWED_PX : RADAR_TANK_ARROW_EXTENT_PX;
  const half = Math.max(1, base * (1 + (0.5 * (y / boxHeight))));
  client.radarCtx.save();
  client.radarCtx.strokeStyle = style;
  client.radarCtx.lineWidth = 1;
  client.radarCtx.globalAlpha = 0.9;
  client.radarCtx.beginPath();
  client.radarCtx.moveTo(-half, 0);
  client.radarCtx.lineTo(0, -half);
  client.radarCtx.lineTo(half, 0);
  client.radarCtx.lineTo(0, half);
  client.radarCtx.closePath();
  client.radarCtx.stroke();
  client.radarCtx.restore();
}

function drawRadarMarkerRing(x, y, style, radius = RADAR_MARKER_RING_RADIUS) {
  client.radarCtx.save();
  client.radarCtx.globalAlpha = 1;
  client.radarCtx.lineWidth = RADAR_MARKER_RING_WIDTH;
  client.radarCtx.strokeStyle = style;
  client.radarCtx.beginPath();
  client.radarCtx.arc(x, y, radius, 0, Math.PI * 2);
  client.radarCtx.stroke();
  client.radarCtx.restore();
}

// SegmentedShotStrategy::radarRender (SegmentedShotStrategy.cxx:329) draws a
// bolt as a line along its own velocity rather than a dot, so the panel says
// which way a shot is going and not just where it is. The line runs forward
// from the shot -- upstream's `leadingShotLine` default of 1, the one that
// shows where the shot will be rather than where it has been.
//
// Its length is `_shotTailLength * linedradarshots`, and upstream's defaults
// are 4.0 and 5. That is a world distance, not a pixel one, so the line grows
// and shrinks with the radar's range exactly as the map under it does.
const RADAR_SHOT_LINE_TAIL_MULTIPLIER = 5;
const RADAR_SHOT_LINE_TAIL_LENGTH_DEFAULT = 4.0;
// A guided missile draws a longer line than anything else. Upstream draws every
// shot's the same length -- `GuidedMissileStrategy::radarRender` is the
// segmented one's line word for word -- but a missile is the one shot whose
// direction is a live answer rather than a fixed one, and the one shot you most
// need to read off the panel in the second you have to turn away from it. The
// extra third is enough to pick it out of a crowded panel without making it the
// only thing on there.
const RADAR_SHOT_LINE_GM_FACTOR = 1.3;
const RADAR_SHOT_LINE_WIDTH = 2;
// Upstream's "bright bullet tip": `sizedradarshots` pixels of grey 0.75 at the
// shot's own position, drawn over the line's near end. It is deliberately not
// the shot's colour -- the line carries that, and a tip brighter than its line
// is what picks the shot itself out of the streak it is drawing.
const RADAR_SHOT_TIP_SIZE = 4;
const RADAR_SHOT_TIP_COLOR = 'rgb(191,191,191)';

// RadarRenderer::render's noise branch (RadarRenderer.cxx:433). Upstream paints a
// noise texture over the whole panel at full white and draws nothing else, so the
// radar is gone rather than dimmed -- "Radar doesn't work" is the flag's own help
// text. bzo has no noise texture, so the static is generated: one greyscale value
// per cell of a coarse grid, which reads as static at radar size and costs a few
// hundred fills rather than a texture upload.
//
// XR needs no separate path. The XR radar panel is textured from this very
// canvas, so whatever lands here lands in the headset on the same frame.
const RADAR_JAM_CELL = 4;
// The panel the working radar sits on: a half-transparent black square at 95%,
// so about 47% of the world behind it shows through. Named because the jammed
// frames are tied to it.
const RADAR_PANEL_FILL_ALPHA = 0.5;
const RADAR_PANEL_GLOBAL_ALPHA = 0.95;
const RADAR_PANEL_BORDER = 'rgba(76, 175, 80, 0.65)';

// Upstream's noise is opaque, and it can afford to be: its radar owns a region of
// the screen outside the 3D viewport, so covering it costs the view nothing. bzo's
// radar floats *over* the 3D view, where opaque static would take away part of
// what the flag explicitly leaves you -- "Radar doesn't work.  Can still see."
//
// So a jammed frame replaces the panel background rather than covering it, at the
// same alpha the background would have had. The jammed panel is then exactly as
// heavy as a working one: no more of the world is hidden while jammed than the
// radar hides anyway, and the panel does not visibly change weight as static and
// good frames alternate.
const RADAR_JAM_STATIC_ALPHA = RADAR_PANEL_FILL_ALPHA * RADAR_PANEL_GLOBAL_ALPHA;
let radarJamDecay = RADAR_JAM_DECAY_MIN;

function drawRadarPanelBorder(size) {
  client.radarCtx.strokeStyle = RADAR_PANEL_BORDER;
  client.radarCtx.lineWidth = Math.max(2, Math.round(size * 0.01));
  client.radarCtx.strokeRect(0, 0, size, size);
}

function drawRadarPanelBackground(size) {
  client.radarCtx.clearRect(0, 0, size, size);
  client.radarCtx.save();
  client.radarCtx.globalAlpha = RADAR_PANEL_GLOBAL_ALPHA;
  client.radarCtx.fillStyle = `rgba(0,0,0,${RADAR_PANEL_FILL_ALPHA})`;
  client.radarCtx.fillRect(0, 0, size, size);
  drawRadarPanelBorder(size);
  client.radarCtx.restore();
}

function drawJammedRadar(size) {
  client.radarCtx.clearRect(0, 0, size, size);
  client.radarCtx.save();
  client.radarCtx.globalAlpha = RADAR_JAM_STATIC_ALPHA;
  for (let y = 0; y < size; y += RADAR_JAM_CELL) {
    for (let x = 0; x < size; x += RADAR_JAM_CELL) {
      const level = Math.floor(Math.random() * 256);
      client.radarCtx.fillStyle = `rgb(${level},${level},${level})`;
      client.radarCtx.fillRect(x, y, RADAR_JAM_CELL, RADAR_JAM_CELL);
    }
  }
  client.radarCtx.restore();
  // Outside the static's alpha, so the frame stays as crisp as it is on a good
  // frame and the panel keeps its edge while jammed.
  client.radarCtx.save();
  drawRadarPanelBorder(size);
  client.radarCtx.restore();
}

// The world's `_radarLimit`: none means upstream's default, the world's size.
function worldRadarLimit() {
  return Number.isFinite(client.gameConfig?.RADAR_LIMIT) ? client.gameConfig.RADAR_LIMIT : (client.currentWorldMapSize ?? DEFAULT_MAP_SIZE);
}

export function updateRadar() {
  if (!client.radarCtx || !client.myTank || !client.gameConfig) return;
  // Declare radar variables only once
  const size = client.radarCanvas.width;
  // RadarRenderer::render: a world with a radar limit of 0 or less -- upstream's
  // `-noradar` -- has no radar for anyone (RadarRenderer.cxx:377).
  const radarLimit = worldRadarLimit();
  client.radarCanvas.style.visibility = radarLimit > 0 ? '' : 'hidden';
  if (!(radarLimit > 0)) return;

  // `bzfrand() > decay` is upstream's roll, and the decay it leaves behind is
  // what makes a jammed radar break through for a frame or two at a time rather
  // than flicker evenly. Kept out of the flags module only in its randomness: the
  // decay rule itself is shared, so both copies agree on the cadence.
  if (isRadarJammed()) {
    const showNoise = Math.random() > radarJamDecay;
    radarJamDecay = getNextRadarJamDecay(radarJamDecay, showNoise);
    if (showNoise) {
      drawJammedRadar(size);
      return;
    }
  } else if (radarJamDecay !== RADAR_JAM_DECAY_MIN) {
    radarJamDecay = RADAR_JAM_DECAY_MIN;
  }
  const center = size / 2;
  const radius = center * 0.95;
  const radarWorldHalfExtent = getRadarWorldHalfExtent(radius);
  // RadarRenderer::render (RadarRenderer.cxx:400): the range is the zoom times
  // the world's radar limit, and never past the limit -- a quarter of it while
  // burrowed, "when burrowed, limit radar range". Upstream caps the range rather
  // than scaling it, so a player already zoomed further in than the cap keeps
  // their own setting, and gets it back untouched on surfacing.
  const burrowed = (getMyFlag()?.type ?? null) === 'BU' && client.myTank.position.z < 0;
  const maxRange = burrowed ? radarLimit * BURROW_RADAR_FACTOR : radarLimit;
  const radarDistance = Math.min(radarLimit * radarZoomLevel, maxRange);
  const tankArrowWorldMargin = radarPixelsToWorldDistance(
    RADAR_TANK_ARROW_EXTENT_PX,
    radarDistance,
    radarWorldHalfExtent
  );
  // A Map Viewer preview's own size (issue #68), not the live match's --
  // see currentWorldMapSize.
  const mapSize = client.currentWorldMapSize ?? DEFAULT_MAP_SIZE;
  // Where the player is and which way they face.
  const px = client.myTank.position.x;
  const py = client.myTank.position.y;
  const pz = client.myTank.position.z;
  const azimuth = tankAzimuth(client.myTank);
  // One pair for the whole panel. The obstacle and mesh-face loops below run
  // over every obstacle in the map at four or more vertices each, and a sine
  // and a cosine per vertex is thousands of them for one value that does not
  // change inside a frame.
  const azimuthCos = Math.cos(azimuth);
  const azimuthSin = Math.sin(azimuth);
  const toRadarRelative = (worldX, worldY) => worldToRadarRelative(
    worldX,
    worldY,
    px,
    py,
    azimuth,
    azimuthCos,
    azimuthSin,
  );
  const radarToCanvas = (radarX, radarY) => radarRelativeToCanvas(
    radarX,
    radarY,
    center,
    radarWorldHalfExtent,
    radarDistance,
  );
  const isOutsideRadarSquare = (radarX, radarY, margin = 0) => (
    isOutsideRadarSquareOf(radarX, radarY, radarDistance, margin)
  );
  // Refreshed each time it is read: `clipPolygonToRadarSquare` grows the
  // buffers to fit the widest polygon it is handed, and a grow replaces them.
  const radarPolygonScratch = () => getRadarPolygonScratch();

  // One `fill()` a colour rather than one an obstacle, which is the same trade
  // a batched draw makes against a per-primitive one: the panel repaints every
  // frame over every obstacle in the map, and on a large one the call overhead
  // outweighs the filling.
  //
  // The order obstacles paint in is load-bearing -- a higher surface has to
  // cover the lower one it overlaps, which is what the altitude sort above is
  // for -- so this coalesces *runs* of neighbours that share a fill rather than
  // gathering the whole list by colour. The sequence is exactly what it was.
  // The sort is by top altitude, so neighbours mostly share an opacity too, and
  // most of a map wears the one neutral grey.
  //
  // Two obstacles inside one run that overlap fill as their union, once, so a
  // partly transparent overlap does not darken at the seam. The panel reads as
  // a height map off the sort, and a doubled patch says nothing the sort does
  // not.
  let radarFillPath = null;
  let radarFillStyle = '';
  let radarFillAlpha = -1;
  // Where fills land and how a radar-relative unit becomes a pixel there: the
  // panel itself, or the world-space cache `paintRadarObstacleLayer` bakes.
  let fillTarget = { ctx: client.radarCtx, offset: center, scale: radarWorldHalfExtent / radarDistance };
  const flushRadarFills = () => {
    if (!radarFillPath) return;
    const { ctx } = fillTarget;
    ctx.globalAlpha = radarFillAlpha;
    ctx.fillStyle = radarFillStyle;
    ctx.fill(radarFillPath);
    ctx.globalAlpha = 1;
    radarFillPath = null;
  };
  // `polygon` is a flat `x, y` buffer in radar-relative units, as the clip
  // leaves it.
  const addRadarFill = (polygon, count, fillStyle, opacity) => {
    // Quantised so a run is not broken by a difference the panel cannot show:
    // the depth scale spans 0.5 to 1, and a thirty-secondth of that is well
    // under what a two-hundred-pixel panel resolves.
    const alpha = Math.round(opacity * RADAR_FILL_ALPHA_STEPS) / RADAR_FILL_ALPHA_STEPS;
    if (radarFillPath && (fillStyle !== radarFillStyle || alpha !== radarFillAlpha)) {
      flushRadarFills();
    }
    if (!radarFillPath) {
      radarFillPath = new Path2D();
      radarFillStyle = fillStyle;
      radarFillAlpha = alpha;
    }
    const { offset, scale } = fillTarget;
    for (let i = 0; i < count; i += 1) {
      const panelX = offset + (polygon[i * 2] * scale);
      const panelY = offset + (polygon[(i * 2) + 1] * scale);
      if (i === 0) radarFillPath.moveTo(panelX, panelY);
      else radarFillPath.lineTo(panelX, panelY);
    }
    radarFillPath.closePath();
  };
  // Something past radar range is pinned to the border of the panel in its own
  // direction, which is bzo's own -- upstream's radar simply stops at its range.
  // The direction is preserved rather than the distance, so the marker sits on
  // the side the thing is on and never mirrors. Null for a direction with no
  // length, which is something standing exactly where the player is.
  const projectToRadarEdge = (radarX, radarY) => {
    const len = Math.hypot(radarX, radarY);
    if (len < 1e-6) return null;
    const nx = radarX / len;
    const ny = radarY / len;
    const halfExtent = Math.max(1, (size / 2) - RADAR_EDGE_DOT_INSET_PX);
    const denom = Math.max(Math.abs(nx), Math.abs(ny), 1e-6);
    return {
      x: center + (nx / denom) * halfExtent,
      y: center + (ny / denom) * halfExtent,
    };
  };
  drawRadarPanelBackground(size);


  // Draw world border (clip to radar distance area, rotated to player forward)
  if (mapSize) {
    client.radarCtx.save();
    client.radarCtx.globalAlpha = 0.7;
    // Calculate visible world border segment within radar distance
    const border = mapSize / 2;
    const west = Math.max(px - radarDistance, -border);
    const east = Math.min(px + radarDistance, border);
    const north = Math.min(py + radarDistance, border);
    const south = Math.max(py - radarDistance, -border);
    // One edge, dashed from world coordinates so the dashes stay put as the
    // player moves.
    const drawEdge = (x1, y1, x2, y2, color, dashOffset) => {
      const p1 = world2Radar(x1, y1, px, py, azimuth, center, radius, radarDistance);
      const p2 = world2Radar(x2, y2, px, py, azimuth, center, radius, radarDistance);
      client.radarCtx.save();
      client.radarCtx.strokeStyle = color;
      client.radarCtx.lineWidth = 2.5;
      client.radarCtx.setLineDash([6, 6]);
      client.radarCtx.lineDashOffset = dashOffset;
      client.radarCtx.beginPath();
      client.radarCtx.moveTo(p1.x, p1.y);
      client.radarCtx.lineTo(p2.x, p2.y);
      client.radarCtx.stroke();
      client.radarCtx.restore();
    };
    if (north === border) drawEdge(west, border, east, border, '#B20000', west * 2);
    if (south === -border) drawEdge(west, -border, east, -border, '#1976D2', west * 2);
    if (west === -border) drawEdge(-border, north, -border, south, '#9C27B0', -north * 2);
    if (east === border) drawEdge(border, north, border, south, '#388E3C', -north * 2);
    client.radarCtx.restore();
  }

  // Draw cardinal direction letters (N/E/S/W) at border, facing outward,
  // rotating with the map. Each at its own azimuth: the panel turns a
  // direction `a` to `azimuth - a` clockwise from up.
  const cardinalLabels = [
    { angle: Math.PI / 2, label: 'N', color: '#B20000' },
    { angle: 0, label: 'E', color: '#388E3C' },
    { angle: -Math.PI / 2, label: 'S', color: '#1976D2' },
    { angle: Math.PI, label: 'W', color: '#9C27B0' },
  ];
  cardinalLabels.forEach(dir => {
    client.radarCtx.save();
    client.radarCtx.translate(center, center);
    // Rotate with the map/radar, so compass turns as player turns
    client.radarCtx.rotate(azimuth - dir.angle);
    client.radarCtx.textAlign = 'center';
    client.radarCtx.textBaseline = 'middle';
    client.radarCtx.font = `bold ${Math.round(radius * 0.22)}px sans-serif`;
    client.radarCtx.fillStyle = dir.color;
    client.radarCtx.strokeStyle = '#222';
    client.radarCtx.lineWidth = 3;
    // Place letter on a slightly larger circle so cardinal letters clip at square edges.
    const labelRadius = radius + Math.max(2, Math.round(size * 0.015));
    client.radarCtx.save();
    client.radarCtx.translate(0, -labelRadius);
    // Keep letters upright (vertical) at top
    client.radarCtx.rotate(dir.angle - azimuth);
    client.radarCtx.strokeText(dir.label, 0, 0);
    client.radarCtx.fillText(dir.label, 0, 0);
    client.radarCtx.restore();
    client.radarCtx.restore();
  });

  // The obstacles, painted through one routine whatever they land on. `view`
  // is the frame a world point is measured in -- the player's, turned to the
  // heading, for the panel; the world's own for the cache -- and the square
  // it is clipped and culled against. `spinning` says which meshes this pass
  // owns: a spinning one turns every frame, so the cache leaves it out and the
  // panel draws it live over the cached image.
  const paintRadarObstacleLayer = (view, spinning) => {
    const { ox, oy, cos: viewCos, sin: viewSin, half } = view;
    // `worldToRadarRelative` for this view, and the same turn for an offset.
    const turnX = (dx, dy) => (dx * viewSin) - (dy * viewCos);
    const turnY = (dx, dy) => 0 - ((dx * viewCos) + (dy * viewSin));
    const relative = (worldX, worldY) => {
      const dx = worldX - ox;
      const dy = worldY - oy;
      return { x: turnX(dx, dy), y: turnY(dx, dy) };
    };
    const outside = (x, y, margin) => isOutsideRadarSquareOf(x, y, half, margin);

    if (spinning !== 'only') {
      getRadarObstacles().forEach(({ obs, cullRadius }) => {
        const centerRel = relative(obs.pos[0], obs.pos[1]);
        // The whole footprint against the square, so a long obstacle whose
        // centre is off it still draws the span of it that is on -- see
        // `getRadarObstacleCullRadius`. Ahead of the corner work rather than
        // after it, which is the point: on a large map most of the list is out
        // of range and costs one comparison rather than a clipped polygon.
        if (outside(centerRel.x, centerRel.y, cullRadius)) return;

        const halfW = obs.size ? obs.size[0] : 4;
        const halfD = obs.size ? obs.size[1] : 4;
        const cosA = Math.cos(obs.angle || 0);
        const sinA = Math.sin(obs.angle || 0);
        const scratch = radarPolygonScratch();
        for (let i = 0; i < 4; i += 1) {
          const localX = RADAR_BOX_CORNERS[i * 2] * halfW;
          const localY = RADAR_BOX_CORNERS[(i * 2) + 1] * halfD;
          const dx = (localX * cosA) - (localY * sinA);
          const dy = (localX * sinA) + (localY * cosA);
          scratch[i * 2] = centerRel.x + turnX(dx, dy);
          scratch[(i * 2) + 1] = centerRel.y + turnY(dx, dy);
        }
        const clippedCount = clipPolygonToRadarSquare(scratch, 4, half);
        if (clippedCount < 3) return;

        // Opacity from the player's height against the obstacle's span.
        addRadarFill(
          getRadarClipBuffer(),
          clippedCount,
          getObstacleRadarFillStyle(obs),
          getRadarOpacity(pz, getObstacleBase(obs), getObstacleHeight(obs)),
        );
      });
    }

    // A mesh's own upward-facing faces -- see `getRadarMeshObstacles`. Each
    // face's own vertices are already in world space (no obstacle rotation to
    // apply, unlike a box), so this projects them directly rather than
    // rotating a local rectangle the way the obstacle loop above does -- unless
    // the mesh itself has an `angvel` (#88), in which case its faces are
    // rotated live about its own `spinPivot` first, the flat equivalent of
    // `renderManager`'s own turn about z on that mesh's 3D pivot group
    // (`meshSpinRadians` is the one shared formula both read).
    //
    // A mesh too small on the panel for its faces to separate draws its
    // footprint instead -- see `RADAR_MESH_FOOTPRINT_PIXELS`. The footprint is
    // the same world-space box, so a spin turns it the same way a face turns.
    // The test is in panel pixels at the current zoom whichever target this
    // is, so the cache keeps exactly the detail the panel would draw.
    const worldToPanelPixels = radarWorldHalfExtent / radarDistance;
    getRadarMeshObstacles().forEach((entry) => {
      const { obs, arrays, faces, footprint, footprintTint, cullX, cullY, cullRadius } = entry;
      const spins = Boolean(obs.angvel && obs.spinPivot);
      if ((spinning === 'skip' && spins) || (spinning === 'only' && !spins)) return;
      // Same rejection as the obstacle loop, on the circle the cached list
      // carries for this mesh -- a spinning one's is centred on the pivot, so
      // it holds whatever angle the mesh is at this frame.
      const cullRel = relative(cullX, cullY);
      if (outside(cullRel.x, cullRel.y, cullRadius)) return;

      const spinAngle = spins ? meshSpinRadians(obs.angvel) : 0;
      const spinCos = Math.cos(spinAngle);
      const spinSin = Math.sin(spinAngle);
      // A tipped spin (#168) turns about a tilted axis, so the point's height
      // feeds its flat position: Rodrigues about `spinAxis`, then dropped to
      // x/y like every other radar point. A down-pointing vertical axis is
      // the same turn the other way.
      const pivot = obs.spinPivot;
      const tippedAxis = spinAngle && isTippedRadarSpin(obs) ? obs.spinAxis : null;
      const flatSin = obs.spinAxis && obs.spinAxis.z < 0 ? -spinSin : spinSin;
      // Projects one world point into the scratch buffer at `slot`, spinning
      // it about the mesh's pivot first where the mesh turns.
      const project = (scratch, slot, worldX, worldY, worldZ = pivot ? pivot.z : 0) => {
        let spunX = worldX;
        let spunY = worldY;
        if (tippedAxis) {
          const offX = worldX - pivot.x;
          const offY = worldY - pivot.y;
          const offZ = worldZ - pivot.z;
          const { x: ax, y: ay, z: az } = tippedAxis;
          const dot = ((ax * offX) + (ay * offY) + (az * offZ)) * (1 - spinCos);
          spunX = pivot.x + (offX * spinCos) + (((ay * offZ) - (az * offY)) * spinSin) + (ax * dot);
          spunY = pivot.y + (offY * spinCos) + (((az * offX) - (ax * offZ)) * spinSin) + (ay * dot);
        } else if (spinAngle) {
          const offsetX = worldX - pivot.x;
          const offsetY = worldY - pivot.y;
          spunX = pivot.x + (offsetX * spinCos) - (offsetY * flatSin);
          spunY = pivot.y + (offsetX * flatSin) + (offsetY * spinCos);
        }
        const dx = spunX - ox;
        const dy = spunY - oy;
        scratch[slot * 2] = turnX(dx, dy);
        scratch[(slot * 2) + 1] = turnY(dx, dy);
      };

      // A single face has no height of its own to speak of -- upstream's own
      // `BZDBCache::useMeshForRadar` fallback for exactly this, using the
      // whole mesh's own vertical span instead of one infinitely thin face.
      // The footprint reads the same figure, being the same mesh.
      const opacity = getRadarOpacity(pz, obs.bounds.minZ, obs.bounds.maxZ - obs.bounds.minZ);

      if ((cullRadius * 2 * worldToPanelPixels) < RADAR_MESH_FOOTPRINT_PIXELS) {
        const scratch = radarPolygonScratch();
        for (let i = 0; i < 4; i += 1) {
          project(scratch, i, footprint[i * 2], footprint[(i * 2) + 1]);
        }
        const clippedCount = clipPolygonToRadarSquare(scratch, 4, half);
        if (clippedCount < 3) return;
        addRadarFill(
          getRadarClipBuffer(),
          clippedCount,
          footprintTint ? getRadarTintFill(footprintTint) : RADAR_NEUTRAL_FILL,
          opacity,
        );
        return;
      }

      faces.forEach(({ f, cullRadius: faceRadius }) => {
        if ((faceRadius * 2 * worldToPanelPixels) < RADAR_FACE_MIN_PIXELS) return;
        const start = arrays.faceStart[f];
        const vertexCount = arrays.faceStart[f + 1] - start;
        const scratch = radarPolygonScratch();
        for (let i = 0; i < vertexCount; i += 1) {
          const v = arrays.corners[start + i] * 3;
          project(scratch, i, arrays.vertices[v], arrays.vertices[v + 1], arrays.vertices[v + 2]);
        }

        const clippedCount = clipPolygonToRadarSquare(scratch, vertexCount, half);
        if (clippedCount < 3) return;

        const { color } = arrays.materials[arrays.faceMaterial[f]];
        addRadarFill(
          getRadarClipBuffer(),
          clippedCount,
          color ? getRadarTintFill(color) : RADAR_NEUTRAL_FILL,
          opacity,
        );
      });
    });
    flushRadarFills();
  };

  const panelView = {
    ox: px, oy: py, cos: azimuthCos, sin: azimuthSin, half: radarDistance,
  };
  if (typeof client.OBSTACLES !== 'undefined' && Array.isArray(client.OBSTACLES)) {
    const cache = getRadarObstacleCache({
      mapSize, pz, size, radarDistance, scale: radarWorldHalfExtent / radarDistance,
    });
    if (cache.ready) {
      // One image for every obstacle that does not move: the world-space bake,
      // north up, turned and placed the way the panel's own projection would
      // put each polygon, clipped to the square the live path clips to. The
      // image holds (x, -y), so the player is at (px, -py) on it.
      const k = radarWorldHalfExtent / radarDistance;
      const halfMap = mapSize / 2;
      client.radarCtx.save();
      client.radarCtx.beginPath();
      client.radarCtx.rect(center - radarWorldHalfExtent, center - radarWorldHalfExtent,
        radarWorldHalfExtent * 2, radarWorldHalfExtent * 2);
      client.radarCtx.clip();
      client.radarCtx.translate(center, center);
      client.radarCtx.scale(k, k);
      client.radarCtx.rotate(azimuth - (Math.PI / 2));
      client.radarCtx.translate(-px, py);
      client.radarCtx.drawImage(cache.canvas, -halfMap, -halfMap, mapSize, mapSize);
      client.radarCtx.restore();
      paintRadarObstacleLayer(panelView, 'only');
    } else {
      paintRadarObstacleLayer(panelView, 'all');
      if (cache.bakeNow) {
        // Painted in the world's own frame, north up: no player offset, the
        // map's whole square, a pixel per `cache.resolution` world units.
        const target = fillTarget;
        fillTarget = { ctx: cache.ctx, offset: (mapSize / 2) * cache.resolution, scale: cache.resolution };
        cache.ctx.clearRect(0, 0, cache.canvas.width, cache.canvas.height);
        paintRadarObstacleLayer({ ox: 0, oy: 0, cos: 0, sin: 1, half: mapSize / 2 }, 'skip');
        fillTarget = target;
        cache.markBaked();
      }
    }
  }

  // The bases over the obstacles, as outlines -- see `getRadarBases`. Clipped
  // to the panel rather than polygon-clipped, so a base half off the edge does
  // not draw the edge as part of its outline.
  const radarBases = typeof client.OBSTACLES !== 'undefined' && Array.isArray(client.OBSTACLES) ? getRadarBases() : [];
  if (radarBases.length) {
    client.radarCtx.save();
    client.radarCtx.beginPath();
    client.radarCtx.rect(center - radarWorldHalfExtent, center - radarWorldHalfExtent,
      radarWorldHalfExtent * 2, radarWorldHalfExtent * 2);
    client.radarCtx.clip();
    client.radarCtx.lineWidth = RADAR_BASE_OUTLINE_WIDTH;
    client.radarCtx.lineJoin = 'miter';
    for (const { obs, cullRadius, stroke } of radarBases) {
      const centerRel = toRadarRelative(obs.pos[0], obs.pos[1]);
      if (isOutsideRadarSquare(centerRel.x, centerRel.y, cullRadius)) continue;
      const halfW = obs.size ? obs.size[0] : 4;
      const halfD = obs.size ? obs.size[1] : 4;
      const cosA = Math.cos(obs.angle || 0);
      const sinA = Math.sin(obs.angle || 0);
      client.radarCtx.beginPath();
      for (let i = 0; i < 4; i += 1) {
        const localX = RADAR_BOX_CORNERS[i * 2] * halfW;
        const localY = RADAR_BOX_CORNERS[(i * 2) + 1] * halfD;
        const corner = toRadarRelative(
          obs.pos[0] + (localX * cosA) - (localY * sinA),
          obs.pos[1] + (localX * sinA) + (localY * cosA),
        );
        const relX = corner.x;
        const relY = corner.y;
        const panelX = center + ((relX / radarDistance) * radarWorldHalfExtent);
        const panelY = center + ((relY / radarDistance) * radarWorldHalfExtent);
        if (i === 0) client.radarCtx.moveTo(panelX, panelY);
        else client.radarCtx.lineTo(panelX, panelY);
      }
      client.radarCtx.closePath();
      client.radarCtx.strokeStyle = stroke;
      client.radarCtx.stroke();
    }
    client.radarCtx.restore();
  }

  // Draw projectiles (shots) within radar distance
  const shotRadarColorOf = (proj) => proj.userData?.radarColor || '#FFD700';
  // One length for the whole panel: it comes off the server's `_shotTailLength`
  // and cannot change inside a frame.
  const shotTailLength = Number.isFinite(client.gameConfig.SHOT_TAIL_LENGTH)
    ? client.gameConfig.SHOT_TAIL_LENGTH
    : RADAR_SHOT_LINE_TAIL_LENGTH_DEFAULT;
  const shotLineWorldLength = shotTailLength * RADAR_SHOT_LINE_TAIL_MULTIPLIER;
  if (typeof client.projectiles !== 'undefined' && client.projectiles.forEach) {
    client.projectiles.forEach((proj) => {
      // RadarRenderer.cxx:664. An Invisible Bullet is drawn on its owner's radar
      // and nobody else's -- upstream sweeps its own shots (:585) before it asks
      // the question at all. Seer is the exception, below.
      // RadarRenderer.cxx:665's `iSeeAll`: Seer puts invisible bullets back on
      // the radar, so a seer is the counter to an invisible shooter.
      if (
        proj.userData?.hiddenOnRadar
        && proj.userData.playerId !== client.myPlayerId
        && !isSeer()
      ) return;
      // ShockWaveStrategy::radarRender draws a circle of the current radius, as
      // its scene node is a sphere of it out the window. The radar's world-to-
      // canvas scale is uniform, so the radius scales with it.
      const projAt = proj.position;
      if (proj.userData?.shockwave) {
        const rel = toRadarRelative(projAt.x, projAt.y);
        const waveRadius = Number.isFinite(proj.userData.shockWaveRadius)
          ? proj.userData.shockWaveRadius
          : 0;
        if (isOutsideRadarSquare(rel.x, rel.y, waveRadius)) return;
        const pos = radarToCanvas(rel.x, rel.y);
        const panelRadius = (waveRadius / radarDistance) * radarWorldHalfExtent;
        if (panelRadius <= 0) return;
        client.radarCtx.save();
        client.radarCtx.strokeStyle = shotRadarColorOf(proj);
        client.radarCtx.globalAlpha = 0.85;
        client.radarCtx.lineWidth = 2;
        client.radarCtx.beginPath();
        client.radarCtx.arc(pos.x, pos.y, panelRadius, 0, Math.PI * 2);
        client.radarCtx.stroke();
        client.radarCtx.restore();
        return;
      }
      // A beam is a line on the radar, as its scene node is out the window. Its
      // segments are each two points.
      if (proj.userData?.beam) {
        const segments = proj.userData.segments || [];
        if (segments.length === 0) return;
        client.radarCtx.save();
        client.radarCtx.strokeStyle = shotRadarColorOf(proj);
        client.radarCtx.globalAlpha = 0.85;
        client.radarCtx.lineWidth = 2;
        client.radarCtx.beginPath();
        for (const segment of segments) {
          const fromRel = toRadarRelative(segment.from.x, segment.from.y);
          const toRel = toRadarRelative(segment.to.x, segment.to.y);
          if (isOutsideRadarSquare(fromRel.x, fromRel.y) && isOutsideRadarSquare(toRel.x, toRel.y)) {
            continue;
          }
          const fromPos = radarToCanvas(fromRel.x, fromRel.y);
          const toPos = radarToCanvas(toRel.x, toRel.y);
          client.radarCtx.moveTo(fromPos.x, fromPos.y);
          client.radarCtx.lineTo(toPos.x, toPos.y);
        }
        client.radarCtx.stroke();
        client.radarCtx.restore();
        return;
      }
      const rel = toRadarRelative(projAt.x, projAt.y);
      const lineLength = proj.userData?.guided
        ? shotLineWorldLength * RADAR_SHOT_LINE_GM_FACTOR
        : shotLineWorldLength;
      // The line reaches forward from the shot, so a shot already past the edge
      // can still have the near end of its line on the panel. The margin is the
      // whole line: one that has nothing on the panel is dropped, and one that
      // has any of itself on it is drawn and clipped by the canvas.
      if (isOutsideRadarSquare(rel.x, rel.y, lineLength)) return;
      const pos = radarToCanvas(rel.x, rel.y);
      const shotRadarColor = shotRadarColorOf(proj);

      // `dirX/dirY/dirZ` rather than the trail's direction: these are rewritten
      // by every bounce, every teleport and every step a missile steers, so the
      // line turns with the shot instead of pointing at the muzzle forever.
      //
      // Upstream normalises the whole velocity and then draws the x and y of
      // it, which shortens the line as the shot climbs or dives -- the panel is
      // a top-down view, and a shot going mostly upwards is covering little
      // ground. Dividing the horizontal components by the 3D length does that.
      const dirX = Number.isFinite(proj.userData?.dirX) ? proj.userData.dirX : 0;
      const dirY = Number.isFinite(proj.userData?.dirY) ? proj.userData.dirY : 0;
      const dirZ = Number.isFinite(proj.userData?.dirZ) ? proj.userData.dirZ : 0;
      const dirLength = Math.hypot(dirX, dirY, dirZ);

      client.radarCtx.save();
      client.radarCtx.globalAlpha = 0.85;
      if (dirLength > 1e-6) {
        const reach = lineLength / dirLength;
        const tipRel = toRadarRelative(
          projAt.x + (dirX * reach),
          projAt.y + (dirY * reach),
        );
        const tipPos = radarToCanvas(tipRel.x, tipRel.y);
        client.radarCtx.strokeStyle = shotRadarColor;
        client.radarCtx.lineWidth = RADAR_SHOT_LINE_WIDTH;
        client.radarCtx.beginPath();
        client.radarCtx.moveTo(pos.x, pos.y);
        client.radarCtx.lineTo(tipPos.x, tipPos.y);
        client.radarCtx.stroke();
      }
      client.radarCtx.fillStyle = RADAR_SHOT_TIP_COLOR;
      client.radarCtx.fillRect(
        pos.x - (RADAR_SHOT_TIP_SIZE / 2),
        pos.y - (RADAR_SHOT_TIP_SIZE / 2),
        RADAR_SHOT_TIP_SIZE,
        RADAR_SHOT_TIP_SIZE,
      );
      client.radarCtx.restore();
    });
  }

  // Draw tanks within radar distance, or as edge dots if beyond
  client.tanks.forEach((tank, playerId) => {
    if (!tank.position) return;
    const state = tank.userData && tank.userData.playerState;
    const isSelf = playerId === client.myPlayerId;
    // An observer's own tank is never alive and is invisible in the 3D
    // world by design (see handleRoamMotion's "nothing draws it"), which
    // would otherwise hide it here same as anyone else's -- but a Map Viewer
    // or spectator has no other reference point on an empty radar without it,
    // so the local player's own marker is exempt from both gates.
    //
    // These are asked directly rather than through `tank.visible`: `CL`
    // (issue #85) drives that same flag to false once cloak alpha hits zero
    // (see applyTankAlpha), which would silently buy every cloaked tank the
    // radar-blip immunity that only `ST` is supposed to grant.
    if (!isSelf && state && !state.alive) return;
    if (!isSelf && isPreviewingAltWorld()) return;
    // RadarRenderer.cxx:628. A stealthed tank has no blip at all rather than a
    // dim one, and Seer is the only thing that brings it back. A cloaked tank is
    // the mirror image and stays on the radar: `CL` hides you from the window,
    // `ST` hides you from the panel, and carrying one does not buy the other.
    if (!isSelf && state && isHiddenFromRadar(state.id)) return;

    // Get player color (convert from hex number to CSS string). RadarRenderer.cxx
    // asks the same question of every blip it draws: colourblindness reaches the
    // radar, or the panel would still say what the world no longer does.
    let playerColor = '#4CAF50'; // Default green
    if (state && typeof state.color === 'number') {
      const effective = getEffectiveTankColor(state.id, state.color);
      playerColor = '#' + effective.toString(16).padStart(6, '0');
    }
    // Team::getRadarColor for the rabbit, which is white where its tank is grey
    // (Team.cxx:38). The radar's team colours are lifted so a team reads against
    // a dark panel, and grey is the one shade that does not -- least of all
    // inside the cyan ring below. This is the only blip bzo paints from a team
    // rather than from the player, because the rabbit is the only tank that
    // wears a team's colour at all. Colourblindness takes it, as it takes the
    // tank's.
    if (isTheRabbit(playerId) && !isColorblind()) {
      playerColor = colorToCSS(getPlayerTeamRadarColor(PLAYER_TEAM.RABBIT));
    }
    // RadarRenderer.cxx:115: a paused or not-responding tank's blip is its
    // colour at 40%, darker rather than more transparent.
    if (!isSelf && state && (state.paused || state.notResponding)) {
      playerColor = dimRadarColor(playerColor, 0.4);
    }

    const tankAt = tank.position;
    const rel = toRadarRelative(tankAt.x, tankAt.y);
    const rotX = rel.x;
    const rotY = rel.y;
    const tankOutsideRadarSquare = isOutsideRadarSquare(rotX, rotY, tankArrowWorldMargin);
    const pos = radarToCanvas(rel.x, rel.y);
    const ringTheHunted = isHuntMarked(playerId);

    if (tankOutsideRadarSquare) {
      // Tank is outside radar range - draw as small dot against square edge.
      const edge = projectToRadarEdge(rotX, rotY);
      if (!edge) return;

      client.radarCtx.save();
      client.radarCtx.beginPath();
      client.radarCtx.arc(edge.x, edge.y, 3, 0, Math.PI * 2);
      client.radarCtx.fillStyle = playerColor;
      client.radarCtx.globalAlpha = 0.8;
      client.radarCtx.fill();
      client.radarCtx.restore();
      // A hunted tank that has run off the panel is exactly the one a hunter
      // wants marked, so the ring follows it out to the edge.
      if (ringTheHunted) drawRadarMarkerRing(edge.x, edge.y, RADAR_HUNT_RING_COLOR);
      return;
    }

    client.radarCtx.save();
    client.radarCtx.translate(pos.x, pos.y);
    drawRadarHeightBox(tankAt.z, playerColor);
    if (playerId === client.myPlayerId) {
      // Player tank: always point up (no rotation needed)
      client.radarCtx.beginPath();
      client.radarCtx.moveTo(0, -10);
      client.radarCtx.lineTo(-6, 8);
      client.radarCtx.lineTo(6, 8);
      client.radarCtx.closePath();
      client.radarCtx.fillStyle = playerColor;
      client.radarCtx.globalAlpha = 1;
      client.radarCtx.fill();
    } else {
      // Other tanks: turned by how far their azimuth is from the player's,
      // clockwise on the panel as an azimuth runs counter-clockwise.
      client.radarCtx.rotate(azimuth - tankAzimuth(tank));
      client.radarCtx.beginPath();
      client.radarCtx.moveTo(0, -10);
      client.radarCtx.lineTo(-6, 8);
      client.radarCtx.lineTo(6, 8);
      client.radarCtx.closePath();
      client.radarCtx.fillStyle = playerColor;
      client.radarCtx.globalAlpha = 0.95;
      client.radarCtx.fill();
    }
    client.radarCtx.restore();
    if (ringTheHunted) drawRadarMarkerRing(pos.x, pos.y, RADAR_HUNT_RING_COLOR);
  });

  // Flags on the ground, drawn as RadarRenderer::drawFlag does: a cross a flag
  // radius across, never smaller than three pixels. Belongs to the live match
  // the same way the 3D flag meshes do (see updateFlags), so it is withheld
  // for the same reason during a Map Viewer preview or session (issue #68).
  if (flags.size > 0 && !isPreviewingAltWorld()) {
    const pixelsPerWorldUnit = radarWorldHalfExtent / Math.max(radarDistance, 1e-6);
    const crossHalf = Math.max(FLAG_RADIUS * pixelsPerWorldUnit, RADAR_FLAG_MIN_HALF_PX);
    const tankCrossHalf = Math.max(
      radarFlagOnTankRadii() * pixelsPerWorldUnit,
      RADAR_FLAG_ON_TANK_MIN_HALF_PX
    );
    // Crosses that share a colour and an altitude go into one path and one
    // stroke. Sixteen white superflags standing on the ground -- the common case
    // -- cost a single stroke rather than sixteen, which matters because the
    // radar is redrawn every frame on a client with one core to spend.
    let batchStyle = null;
    let batchAlpha = null;
    const flushRadarFlags = () => {
      if (batchStyle === null) return;
      client.radarCtx.stroke();
      batchStyle = null;
    };
    const drawRadarFlag = (flag) => {
      if (flag.status === FLAG_STATUS.NO_EXIST || flag.status === FLAG_STATUS.ON_TANK) return;
      const at = flag.position;
      const rel = toRadarRelative(at.x, at.y);
      if (isOutsideRadarSquare(rel.x, rel.y)) return;

      const style = getFlagRadarStyle(flag);
      const alpha = getRadarDepthScale(pz, at.z, 0, RADAR_OBJECT_DEPTH_FLOOR);
      if (style !== batchStyle || alpha !== batchAlpha) {
        flushRadarFlags();
        client.radarCtx.globalAlpha = alpha;
        client.radarCtx.strokeStyle = style;
        client.radarCtx.beginPath();
        batchStyle = style;
        batchAlpha = alpha;
      }

      const pos = radarToCanvas(rel.x, rel.y);
      client.radarCtx.moveTo(pos.x - crossHalf, pos.y);
      client.radarCtx.lineTo(pos.x + crossHalf, pos.y);
      client.radarCtx.moveTo(pos.x, pos.y - crossHalf);
      client.radarCtx.lineTo(pos.x, pos.y + crossHalf);
    };

    // A flag the player is looking for is drawn on its own after the rest: in
    // flat colour rather than depth-scaled, since dimming the one flag you are
    // hunting for by how far above or below you it is works against the point;
    // pinned to the border of the panel when it is past radar range, where an
    // ordinary flag is simply dropped; and ringed wherever it lands.
    //
    // It stays a cross out at the edge, where a tank degrades to a dot. A tank's
    // blip is an arrow because it carries a heading, and a heading is the thing
    // a pinned marker no longer has; a cross carries nothing but a position, so
    // it loses none of its meaning by being pinned and stays the shape that says
    // "flag" everywhere else on the panel.
    //
    // A flag on a tank takes drawFlagOnTank's larger cross over the carrier's
    // blip, which is upstream's own mark for a carried flag -- so the one
    // marker answers who has it and which way they went.
    const drawSoughtFlag = (position, style, onTank) => {
      const rel = toRadarRelative(position.x, position.y);
      const pos = isOutsideRadarSquare(rel.x, rel.y)
        ? projectToRadarEdge(rel.x, rel.y)
        : radarToCanvas(rel.x, rel.y);
      if (!pos) return;
      const half = onTank ? tankCrossHalf : crossHalf;
      client.radarCtx.globalAlpha = 1;
      client.radarCtx.strokeStyle = style;
      client.radarCtx.beginPath();
      client.radarCtx.moveTo(pos.x - half, pos.y);
      client.radarCtx.lineTo(pos.x + half, pos.y);
      client.radarCtx.moveTo(pos.x, pos.y - half);
      client.radarCtx.lineTo(pos.x, pos.y + half);
      client.radarCtx.stroke();
      drawRadarMarkerRing(
        pos.x,
        pos.y,
        style,
        Math.max(RADAR_MARKER_RING_RADIUS, half + RADAR_MARKER_RING_GAP)
      );
    };

    const myTeamIndex = getMyTeamColorIndex();
    client.radarCtx.save();
    client.radarCtx.lineWidth = 1.5;
    // Upstream walks the flags backwards purely so the team flags, which come
    // first, end up drawn over the superflags. Two passes say that outright.
    // `_hideFlagsOnRadar` takes every flag on the ground off the panel, and
    // `_hideTeamFlagsOnRadar` the team flags (RadarRenderer.cxx:688-707); a
    // carried flag is the tank's, and shows with it either way.
    const hideAllFlags = client.gameConfig?.HIDE_FLAGS_ON_RADAR === true;
    const hideTeamFlags = hideAllFlags || client.gameConfig?.HIDE_TEAM_FLAGS_ON_RADAR === true;
    flags.forEach((flag) => {
      if (getFlagTeamIndex(flag.type) === null && !hideAllFlags) drawRadarFlag(flag);
    });
    radarSoughtFlags.length = 0;
    flags.forEach((flag) => {
      if (getFlagTeamIndex(flag.type) === null) return;
      if (hideTeamFlags && flag.status !== FLAG_STATUS.ON_TANK) return;
      // A sought flag is held back rather than batched, so its cross is not
      // drawn twice in two different alphas.
      if (isSoughtTeamFlag(flag, myTeamIndex)) {
        radarSoughtFlags.push(flag);
        return;
      }
      drawRadarFlag(flag);
    });
    flushRadarFlags();
    radarSoughtFlags.forEach((flag) => {
      drawSoughtFlag(flag.position, getFlagRadarStyle(flag), flag.status === FLAG_STATUS.ON_TANK);
    });
    // RadarRenderer.cxx:715 draws the antidote last and in flat yellow, over
    // every flag in the world, because it is the one you are looking for.
    if (client.antidotePosition) {
      drawSoughtFlag(client.antidotePosition, ANTIDOTE_FLAG_STYLE, false);
    }
    client.radarCtx.restore();

    // drawFlagOnTank(): carrying a flag puts a larger cross on your own blip.
    const carried = getMyFlag();
    if (carried) {
      client.radarCtx.save();
      client.radarCtx.strokeStyle = getFlagRadarStyle(carried);
      client.radarCtx.lineWidth = 1.5;
      client.radarCtx.beginPath();
      client.radarCtx.moveTo(center - tankCrossHalf, center);
      client.radarCtx.lineTo(center + tankCrossHalf, center);
      client.radarCtx.moveTo(center, center - tankCrossHalf);
      client.radarCtx.lineTo(center, center + tankCrossHalf);
      client.radarCtx.stroke();
      client.radarCtx.restore();
    }
  }
}
