/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// One overview picture per map, built from the same geometry the radar panel
// draws and cached beside the map's own JSON under its hash (issue #147).
//
// It is a *rendering at a known size*, not a vector copy of the map: every
// obstacle is rasterised onto a grid of the pixels the picture will actually
// have, and what comes out is that grid re-encoded as merged rectangles. So
// the output is bounded by the target size rather than by the map -- a map of
// 81332 mesh faces and one of forty boxes both land in single-digit
// kilobytes. Anything smaller than a pixel is gone because the grid has
// nowhere to put it, which is the same trimming the panel's own LOD does in
// `RADAR_MESH_FOOTPRINT_PIXELS` terms and needs no separate rule here.
//
// SVG rather than a raster because the server has no display and no canvas:
// this needs nothing but string concatenation, compresses hard (brotli takes
// the worst map here to about 8 KB), and tolerates being shown at 2x on a
// dense screen without a second asset. It is deliberately not a zoomable
// vector drawing of the world -- that would be the 74 MB the map JSON already
// is.

const { getTeamFromColorIndex, getPlayerTeamRadarColor } = require('./teams.cjs');
const { meshArrays, FACE_NO_RADAR, NO_INDEX } = require('./mesh-arrays.cjs');
const { getObstacleBase } = require('./collision.cjs');

// The grid, and so the picture, in pixels square. 256 is what `/list`'s pane
// shows and about where the rectangle encoding stops paying for itself: 512
// more than doubles the bytes for detail a pane-sized picture cannot show.
const OVERVIEW_SIZE = 256;

// Where one band of the elevation ramp ends and the next starts, in units
// above the datum. Absolute, not a fraction of the map's own tallest thing,
// so a flat map's molehills do not read as mountains beside a real one --
// these pictures sit next to each other in a list and have to be comparable.
//
// The steps roughly double because that is how a map is read: close to the
// ground is where the differences are -- a 1.6-unit pad, a box to hide
// behind, a wall to shoot over -- and above that only "high" matters, which
// is the same place the panel's own dimming gives up (`getRadarDepthScale`
// hits its floor at 40 units). Evenly spaced bands flatten a map like
// `ahs3_INCOMING`, whose whole layout stands under 12 units, into one shape.
const BAND_EDGES = [1, 3, 6, 12, 24, 48];

// The datum: the altitude the map is played at, which is what elevation is
// measured from. Surfaces level with it are the floor and are washed in as
// background rather than drawn as obstacles -- otherwise a terrain mesh
// covering the whole world fills the picture and nothing reads at all.
//
// Taken as a low percentile of surface area by altitude, not as the lowest
// surface anywhere: a pit, a decorative slab under the world or a mesh's own
// skirt is not where anyone plays, and none of them holds a tenth of the
// map's surface. Area comes from the footprints themselves rather than from
// the grid below, because the grid is the thing that needs the answer.
const DATUM_QUANTUM = 2;
const DATUM_AREA_PERCENTILE = 0.1;

// A roof: one altitude, far enough above the datum to be over the game rather
// than part of it, holding so much of the map's surface that it can only be a
// lid -- `ahs3_INCOMING` is a domed arena whose dome is two altitudes each
// holding 40% of the map from 86 units up, and each cell's highest surface
// there is the dome rather than the game under it. A roof is skipped, but only
// where something else is under it, so a partly covered map keeps its cover
// where the cover is all there is.
//
// Measured to separate cleanly rather than guessed at: the busiest altitude
// above the ceiling is 40% on `ahs3_INCOMING` and 11% on
// `ahs3_Paradise_Valley`, whose mountains rise 300 units and are emphatically
// not a roof.
const CEILING_UNITS = 48;
const ROOF_AREA_SHARE = 0.25;

// `RADAR_NEUTRAL_FILL_RGB` and `RADAR_TINT_STRENGTH` (public/client.js): a
// surface on the panel keeps reading as ground rather than as a tank because
// whatever colour it has is shaded most of the way to a neutral grey. Same
// here, for the same reason and out of the same numbers.
const NEUTRAL_RGB = [180, 180, 180];
const TINT_STRENGTH = 0.65;

// The panel is black at half alpha over the world; a picture with no world
// behind it needs a background of its own, dark enough that the greys above
// read the way they do in game.
const BACKGROUND = '#12140f';
const BORDER = 'rgba(76, 175, 80, 0.65)';

// How opaque each band is drawn, floor first -- one more than `BAND_EDGES`
// has steps. The floor sits well below solid so that anything standing on it
// separates at a glance, and the top band is full: higher reads as nearer,
// which is how a picture taken from above wants to be read.
const BAND_ALPHA = [0.3, 0.44, 0.55, 0.66, 0.78, 0.89, 1];

// A colour the map asked for, shaded towards the panel's neutral the way
// `getRadarShadedFill` shades it.
function shadeTowardsNeutral(red, green, blue) {
  const shade = (value, neutral) => Math.round(
    (neutral * (1 - TINT_STRENGTH))
    + (Math.max(0, Math.min(1, value)) * 0xff * TINT_STRENGTH)
  );
  return `rgb(${shade(red, NEUTRAL_RGB[0])},${shade(green, NEUTRAL_RGB[1])},`
    + `${shade(blue, NEUTRAL_RGB[2])})`;
}

const NEUTRAL_FILL = `rgb(${NEUTRAL_RGB.join(',')})`;

// A base is an outline in its team's own radar colour, as upstream draws it
// (`RadarRenderer::renderBasesAndTeles`, a `GL_LINE_LOOP` in
// `Team::getRadarColor`) and as the panel does (`drawRadarBaseOutlines`):
// filled, it hid the players and the flag standing on it. Unshaded, since an
// outline has no area to read as ground.
function baseStroke(team) {
  const name = getTeamFromColorIndex(Number(team));
  const colour = name ? getPlayerTeamRadarColor(name) : null;
  if (!Number.isFinite(colour)) return NEUTRAL_FILL;
  return `#${colour.toString(16).padStart(6, '0')}`;
}

// Bumped whenever a change here would draw an existing world differently. A
// picture is drawn once and kept under its world's hash, so without this an
// old drawing would be served for as long as its world stayed listed; the
// server clears the directory once when this differs from what drew it.
const OVERVIEW_STYLE = 2;

const BASE_OUTLINE_WIDTH = 1.5;

// A `color` on a mesh or a painted box, as the panel reads it. An array of
// floats is what the parser leaves behind; anything else is left to neutral
// rather than guessed at.
function tintFill(colour) {
  if (!Array.isArray(colour) || colour.length < 3) return null;
  const [red, green, blue] = colour;
  if (![red, green, blue].every((value) => Number.isFinite(value))) return null;
  return shadeTowardsNeutral(red, green, blue);
}

function obstacleFill(obs) {
  return tintFill(obs.capColor) || tintFill(obs.wallColor) || tintFill(obs.color)
    || NEUTRAL_FILL;
}

// Every horizontal surface the picture could show, handed to `visit` as its
// footprint in pixel coordinates, the altitude of its top and the colour it
// is drawn in. Walked twice -- once to find the datum, once to draw -- so it
// lives here rather than inside either pass.
function walkSurfaces(obstacles, mapSize, size, visit) {
  const half = mapSize / 2;
  const toPixel = (value) => ((value + half) / mapSize) * size;
  for (const obs of obstacles) {
    // A material's `noradar` keeps an obstacle off the panel, so it keeps it
    // out of the picture too -- the same whole-obstacle reading
    // `getRadarObstacles` makes, bzo having no per-face radar pass to skip.
    // A base is drawn last, as an outline (`baseOutlines`).
    if (!obs || obs.noRadar || obs.kind === 'base') continue;
    const fill = obstacleFill(obs);
    if (obs.type === 'mesh') {
      // Read out of the mesh's flat arrays, which by this point are the only
      // description it carries (issue #153).
      const arrays = meshArrays(obs);
      for (let f = 0; f < arrays.faceCount; f += 1) {
        const start = arrays.faceStart[f];
        const end = arrays.faceStart[f + 1];
        if (end - start < 3) continue;
        const vertices = [];
        let top = -Infinity;
        for (let c = start; c < end; c += 1) {
          const vi = arrays.corners[c] * 3;
          const vertex = {
            x: arrays.vertices[vi], y: arrays.vertices[vi + 1], z: arrays.vertices[vi + 2],
          };
          vertices.push(vertex);
          if (vertex.z > top) top = vertex.z;
        }
        // Faces standing on edge project to a line and have nothing to fill:
        // a wall's footprint is already covered by whatever caps it, and a
        // face with no area cannot be seen from above.
        const firstX = vertices[1].x - vertices[0].x;
        const firstY = vertices[1].y - vertices[0].y;
        const secondX = vertices[2].x - vertices[0].x;
        const secondY = vertices[2].y - vertices[0].y;
        const wind = (firstX * secondY) - (firstY * secondX);
        if (Math.abs(wind) < 1e-9) continue;
        // Only surfaces that face upwards. A mesh is usually a closed solid,
        // so every cell of a terrain has an underside as well as a top, and
        // taking either one drew a heightfield as the flat sheet sealing its
        // bottom. The winding tells which is which and agrees with the map's
        // own normals wherever it supplies them (39763 faces against 2380 on
        // `ahs3_Paradise_Valley`); the normal wins where there is one, since
        // a mesh may be wound inconsistently and most are not normalled at
        // all.
        let up = wind > 0;
        const normalIndex = arrays.cornerNormal[start];
        if (normalIndex !== NO_INDEX) {
          const normalZ = arrays.normals[(normalIndex * 3) + 2];
          if (Number.isFinite(normalZ)) up = normalZ > 0;
        }
        if (!up) continue;
        // A material's `noradar` keeps a face off the panel, and the picture
        // follows the panel -- the obstacle-level flag is checked above, but
        // the flag is per face and a mesh may hide only some of itself.
        if ((arrays.faceFlags[f] & FACE_NO_RADAR) !== 0) continue;
        const color = arrays.materials[arrays.faceMaterial[f]]?.color;
        // North is up the picture.
        visit(vertices.map((vertex) => [toPixel(vertex.x), toPixel(0 - vertex.y)]), top,
          color ? (tintFill(color) || fill) : fill);
      }
      continue;
    }
    visit(footprintCorners(obs, toPixel), getObstacleBase(obs) + ((obs.size && obs.size[2]) || 0), fill);
  }
}

// A box's or a pyramid's four corners from above, rotated as the map rotated
// it, in order round it. Its own `bounds` would be the axis-aligned box around
// this, which on a map of angled walls reads as a blur. North is up the
// picture, so a pixel's row is from -y.
// Every base's outline, over everything else -- upstream's order too: its
// bases follow the boxes, pyramids and meshes (`RadarRenderer::renderObstacles`).
function baseOutlines(obstacles, mapSize, size) {
  const half = mapSize / 2;
  const toPixel = (value) => ((value + half) / mapSize) * size;
  let out = '';
  for (const obs of obstacles) {
    if (!obs || obs.noRadar || obs.kind !== 'base') continue;
    const points = footprintCorners(obs, toPixel)
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    out += `<polygon points="${points}" fill="none" stroke="${baseStroke(obs.team)}"`
      + ` stroke-width="${BASE_OUTLINE_WIDTH}"/>`;
  }
  return out;
}

function footprintCorners(obs, toPixel) {
  const cos = Math.cos(obs.angle || 0);
  const sin = Math.sin(obs.angle || 0);
  const halfWidth = obs.size ? obs.size[0] : 0;
  const halfDepth = obs.size ? obs.size[1] : 0;
  const [x, y] = obs.pos || [0, 0];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([signX, signY]) => [
    toPixel(x + (signX * halfWidth * cos) - (signY * halfDepth * sin)),
    toPixel(0 - (y + (signX * halfWidth * sin) + (signY * halfDepth * cos))),
  ]);
}

// Two facts about a map's altitudes, from one walk of its surfaces: the datum
// (see `DATUM_QUANTUM` above) and which altitudes are roofs (see
// `ROOF_AREA_SHARE`). Areas are in pixels squared, which is all either
// question needs.
function analyseAltitudes(obstacles, mapSize, size) {
  const areas = new Map();
  let total = 0;
  walkSurfaces(obstacles, mapSize, size, (points, top) => {
    let area = 0;
    for (let index = 0, count = points.length; index < count; index++) {
      const from = points[index];
      const to = points[(index + 1) % count];
      area += (from[0] * to[1]) - (to[0] * from[1]);
    }
    area = Math.abs(area) / 2;
    if (!(area > 0)) return;
    const step = Math.round(top / DATUM_QUANTUM);
    areas.set(step, (areas.get(step) || 0) + area);
    total += area;
  });
  if (total === 0) return { datum: 0, roofSteps: new Set() };

  const steps = [...areas.keys()].sort((left, right) => left - right);
  const wanted = total * DATUM_AREA_PERCENTILE;
  let datum = 0;
  let running = 0;
  for (const step of steps) {
    running += areas.get(step);
    if (running >= wanted) { datum = step * DATUM_QUANTUM; break; }
  }

  const ceiling = datum + CEILING_UNITS;
  const roofSteps = new Set();
  for (const step of steps) {
    if (step * DATUM_QUANTUM > ceiling && areas.get(step) >= total * ROOF_AREA_SHARE) {
      roofSteps.add(step);
    }
  }
  return { datum, roofSteps };
}

// Scanline fill of one convex footprint into the grid, keeping the highest
// surface each cell has seen and the colour that surface came with.
function fillFootprint(grid, size, points, top, fill, roof) {
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const point of points) {
    if (point[1] < minRow) minRow = point[1];
    if (point[1] > maxRow) maxRow = point[1];
  }
  const firstRow = Math.max(0, Math.floor(minRow));
  const lastRow = Math.min(size - 1, Math.ceil(maxRow));
  if (firstRow > lastRow) return;

  // A footprint thinner than a scanline would fall through the crossing test
  // below and draw nothing, which would lose every catwalk on a map built out
  // of them. It gets its own width on the one row it lies in instead. Only a
  // footprint that is genuinely this thin, and only here rather than per row:
  // a large triangle also fails the crossing test on the rows it merely clips
  // a corner of, and its own width on those rows is a streak across the
  // picture.
  if (maxRow - minRow < 1) {
    let left = Infinity;
    let right = -Infinity;
    for (const point of points) {
      if (point[0] < left) left = point[0];
      if (point[0] > right) right = point[0];
    }
    markSpan(grid, size, Math.max(0, Math.min(size - 1, Math.floor((minRow + maxRow) / 2))),
      Math.floor(left), Math.floor(right), top, fill, roof);
    return;
  }
  for (let row = firstRow; row <= lastRow; row++) {
    const centre = row + 0.5;
    const crossings = [];
    for (let index = 0, count = points.length; index < count; index++) {
      const from = points[index];
      const to = points[(index + 1) % count];
      if ((from[1] <= centre && to[1] > centre) || (to[1] <= centre && from[1] > centre)) {
        crossings.push(from[0] + ((centre - from[1]) / (to[1] - from[1])) * (to[0] - from[0]));
      }
    }
    // A row this footprint reaches into without crossing its centre covers
    // none of that row's cells. The thin case is handled above.
    if (crossings.length === 0) continue;
    crossings.sort((left, right) => left - right);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      markSpan(grid, size, row, Math.floor(crossings[pair]),
        Math.floor(crossings[pair + 1]), top, fill, roof);
    }
  }
}

// A roof's cells go in a second pair of arrays, and keep the *lowest* surface
// rather than the highest: if a roof is all a cell has, the lowest one is what
// looking down on it would find.
function markSpan(grid, size, row, fromColumn, toColumn, top, fill, roof) {
  const left = Math.max(0, fromColumn);
  const right = Math.min(size - 1, Math.max(toColumn, fromColumn));
  for (let column = left; column <= right; column++) {
    const cell = (row * size) + column;
    if (roof) {
      if (top < grid.roofTop[cell]) {
        grid.roofTop[cell] = top;
        grid.roofFill[cell] = fill;
      }
    } else if (top > grid.top[cell]) {
      grid.top[cell] = top;
      grid.fill[cell] = fill;
    }
  }
}

// Every cell's highest surface below the ceiling, and what colour it is, with
// a roof standing in wherever that leaves a cell empty.
function rasteriseObstacles(obstacles, mapSize, size, roofSteps) {
  const cells = size * size;
  const grid = {
    top: new Float32Array(cells).fill(-Infinity),
    fill: new Array(cells).fill(null),
    roofTop: new Float32Array(cells).fill(Infinity),
    roofFill: new Array(cells).fill(null),
  };
  walkSurfaces(obstacles, mapSize, size, (points, top, fill) => {
    fillFootprint(grid, size, points, top, fill,
      roofSteps.has(Math.round(top / DATUM_QUANTUM)));
  });
  for (let cell = 0; cell < cells; cell++) {
    if (grid.top[cell] === -Infinity && grid.roofTop[cell] !== Infinity) {
      grid.top[cell] = grid.roofTop[cell];
      grid.fill[cell] = grid.roofFill[cell];
    }
  }
  return grid;
}

// Which band a surface falls in: the floor (0) for anything level with the
// datum or below it, then one band per step of `BAND_EDGES` above it.
function bandOf(top, datum) {
  const above = top - datum;
  let band = 0;
  while (band < BAND_EDGES.length && above >= BAND_EDGES[band]) band++;
  return band;
}

// The grid re-encoded as the fewest axis-aligned rectangles a greedy walk
// finds: widest run on the row, then down as far as every column of that run
// continues. One pass per (band, colour) group, because a path can carry one
// fill and one opacity.
function encodeGroup(cells, size) {
  const used = new Uint8Array(size * size);
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const cell = (row * size) + column;
      if (!cells[cell] || used[cell]) continue;
      let width = 0;
      while (column + width < size
        && cells[cell + width] && !used[cell + width]) width++;
      let height = 1;
      grow: while (row + height < size) {
        const next = ((row + height) * size) + column;
        for (let step = 0; step < width; step++) {
          if (!cells[next + step] || used[next + step]) break grow;
        }
        height++;
      }
      for (let down = 0; down < height; down++) {
        const start = ((row + down) * size) + column;
        for (let across = 0; across < width; across++) used[start + across] = 1;
      }
      path += `M${column} ${row}h${width}v${height}h-${width}z`;
    }
  }
  return path;
}

// The picture. `entry` is a `MAP_REGISTRY` entry or anything with the same
// `obstacles`/`mapSize` -- nothing here reads the live world, so a map nobody
// has joined draws the same as the one being played.
function buildMapOverviewSvg(entry, options = {}) {
  const size = options.size || OVERVIEW_SIZE;
  const obstacles = Array.isArray(entry && entry.obstacles) ? entry.obstacles : [];
  const mapSize = Number.isFinite(entry && entry.mapSize) && entry.mapSize > 0
    ? entry.mapSize : 800;
  const { datum, roofSteps } = analyseAltitudes(obstacles, mapSize, size);
  const grid = rasteriseObstacles(obstacles, mapSize, size, roofSteps);

  // Grouped by band and colour together: a red base and a grey wall at the
  // same height are two paths, and the same wall one band higher is a third.
  const groups = new Map();
  for (let cell = 0; cell < grid.top.length; cell++) {
    const top = grid.top[cell];
    if (top === -Infinity) continue;
    const band = bandOf(top, datum);
    const fill = grid.fill[cell] || NEUTRAL_FILL;
    const key = `${band}|${fill}`;
    let group = groups.get(key);
    if (!group) {
      group = { band, fill, cells: new Uint8Array(grid.top.length) };
      groups.set(key, group);
    }
    group.cells[cell] = 1;
  }

  // Floor first and up, which is the panel's own order -- a higher surface has
  // to cover the lower one it stands on, not the other way about.
  const ordered = [...groups.values()].sort((left, right) => left.band - right.band);
  let body = '';
  for (const group of ordered) {
    const path = encodeGroup(group.cells, size);
    if (!path) continue;
    body += `<path fill="${group.fill}" fill-opacity="${BAND_ALPHA[group.band]}"`
      + ` d="${path}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"`
    + ` width="${size}" height="${size}" role="img">`
    + `<rect width="${size}" height="${size}" fill="${BACKGROUND}"/>`
    + body
    + baseOutlines(obstacles, mapSize, size)
    + `<rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}"`
    + ` fill="none" stroke="${BORDER}"/>`
    + `</svg>`;
}

module.exports = {
  OVERVIEW_SIZE,
  OVERVIEW_STYLE,
  buildMapOverviewSvg,
};
