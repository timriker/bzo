/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// bzflag-extras.cjs - What bzo adds to the world it sends a native BZFlag
// client (issue #174), and to nobody else's: bzo's browsers draw these their
// own way already. Everything here is passable and out of reach, so a native
// client's physics still agree with bzo's server, which never knows it is
// there. Built from geometry and material colour alone: a stock client only
// loads images from images.bzflag.org.

'use strict';

// bzo's compass letters (`_addCompassMarker`, public/js/render.js): N red, S
// blue, E green, W purple, white edged, over the middle of each wall at
// `max(wall + 8, tallest + 5)`.
const LETTERS = [
  { letter: 'N', color: [0.70, 0, 0], inward: [0, -1] },
  { letter: 'S', color: [0.10, 0.46, 0.82], inward: [0, 1] },
  { letter: 'E', color: [0.22, 0.56, 0.24], inward: [-1, 0] },
  { letter: 'W', color: [0.61, 0.15, 0.69], inward: [1, 0] },
];
const HEIGHT = 30;
const WIDTH = 20;
const STROKE = 4.5;
const EDGE = 1.2;
// Beyond the wall by this much, so no part of a letter overhangs the arena.
const OUTSIDE = 20;
// Tilted back from upright: readable from inside the walls, and with enough
// footprint seen from above that the radar draws the letter.
const TILT = Math.PI / 4;

// Each letter as strokes in its own plane, (u, v) from its bottom left, each
// a quad counter clockwise as seen from the front, with its white edge: an
// upright bar, or a slanted one cut level top and bottom. N, E and W are
// straight strokes; S is squared off.
function letterStrokes(letter) {
  const W = WIDTH;
  const H = HEIGHT;
  const t = STROKE;
  const rect = (u0, v0, u1, v1) => {
    const quad = (by) => [[u0 - by, v0 - by], [u1 + by, v0 - by], [u1 + by, v1 + by], [u0 - by, v1 + by]];
    return { quad: quad(0), edge: quad(EDGE) };
  };
  // A stroke whose centre runs from (bottomU, v0) to (topU, v1), `t` across
  // measured square to it: level ends are wider by 1/cos of its lean.
  const slant = (bottomU, topU, v0 = 0, v1 = H) => {
    const run = (topU - bottomU) / (v1 - v0);
    const widen = Math.hypot(1, run);
    const at = (v) => bottomU + (run * (v - v0));
    const quad = (by) => {
      const half = ((t / 2) + by) * widen;
      const lo = v0 - by;
      const hi = v1 + by;
      return [[at(lo) - half, lo], [at(lo) + half, lo], [at(hi) + half, hi], [at(hi) - half, hi]];
    };
    return { quad: quad(0), edge: quad(EDGE) };
  };
  switch (letter) {
    case 'N':
      return [rect(0, 0, t, H), rect(W - t, 0, W, H), slant(W - (t / 2), t / 2)];
    case 'E':
      return [rect(0, 0, t, H), rect(0, H - t, W, H), rect(0, (H - t) / 2, W * 0.8, (H + t) / 2), rect(0, 0, W, t)];
    case 'S':
      return [
        rect(0, H - t, W, H), rect(0, H / 2, t, H), rect(0, (H - t) / 2, W, (H + t) / 2),
        rect(W - t, 0, W, H / 2), rect(0, 0, W, t),
      ];
    case 'W':
      // The outer strokes from the top corners down, the inner ones up to a
      // middle peak below the top.
      return [
        slant(W * 0.25, t / 2), slant(W * 0.25, W * 0.5, 0, H * 0.6),
        slant(W * 0.75, W * 0.5, 0, H * 0.6), slant(W * 0.75, W - (t / 2)),
      ];
    default:
      return [];
  }
}

function material(name, color, { noRadar }) {
  return {
    name,
    noCulling: false,
    noSorting: false,
    noRadar,
    noShadow: true,
    occluder: false,
    groupAlpha: false,
    noLighting: true,
    dynamicColor: -1,
    ambient: [...color, 1],
    diffuse: [...color, 1],
    specular: [0, 0, 0, 1],
    // Its own light, so it reads at night as bzo's does.
    emission: [...color, 1],
    shininess: 0,
    alphaThreshold: 0,
    textures: [],
    shaders: [],
  };
}

function passableMesh(vertices, faces) {
  return {
    checks: [],
    vertices,
    normals: [],
    texcoords: [],
    faces,
    driveThrough: true,
    shootThrough: true,
    smoothBounce: false,
    noclusters: false,
    ricochet: false,
  };
}

// The four letters, added to `tree` (`parseWorldDatabase`'s shape) in place.
// `mapSize` is the world's edge to edge; `height` the centre of each letter
// above the ground.
//
// On the radar, which draws every face as seen from above in one colour
// (`RadarRenderer::renderBoxPyrMesh`), the tilt shows the letter shape; the
// white edge is kept off it. N is drawn red there because its faces carry a
// death physics driver, the one face colour the radar has -- harmless, since
// nothing can reach a letter beyond the wall.
function addCardinalLetters(tree, { mapSize, height }) {
  const { materials, physicsDrivers } = tree.managers;
  const edgeMaterial = materials.length;
  materials.push(material('bzo_compass_edge', [1, 1, 1], { noRadar: true }));
  const northDriver = physicsDrivers.length;
  physicsDrivers.push({
    name: 'bzo_compass_north',
    linear: [0, 0, 0],
    angularVel: 0,
    angularPos: [0, 0],
    radialVel: 0,
    radialPos: [0, 0],
    slideTime: 0,
    deathMsg: 'north',
  });

  const half = mapSize / 2;
  for (const { letter, color, inward } of LETTERS) {
    const letterMaterial = materials.length;
    materials.push(material(`bzo_compass_${letter}`, color, { noRadar: false }));
    const [ix, iy] = inward;
    // Facing in and up; its top leaning away from the arena; its right as a
    // player inside sees it.
    const front = [ix * Math.cos(TILT), iy * Math.cos(TILT), Math.sin(TILT)];
    const up = [-ix * Math.sin(TILT), -iy * Math.sin(TILT), Math.cos(TILT)];
    const right = [(up[1] * front[2]) - (up[2] * front[1]), (up[2] * front[0]) - (up[0] * front[2]), (up[0] * front[1]) - (up[1] * front[0])];
    const center = [-ix * (half + OUTSIDE), -iy * (half + OUTSIDE), height];
    const place = ([u, v], push = 0) => [0, 1, 2].map((axis) => center[axis]
      + (right[axis] * (u - (WIDTH / 2))) + (up[axis] * (v - (HEIGHT / 2))) + (front[axis] * push));

    const vertices = [];
    const faces = [];
    const addQuad = (quad, matindex, phydrv, push) => {
      const start = vertices.length;
      for (const point of quad) vertices.push(place(point, push));
      faces.push({
        vertexIdx: [start, start + 1, start + 2, start + 3],
        normalIdx: null,
        texcoordIdx: null,
        matindex,
        phydrv,
        driveThrough: true,
        shootThrough: true,
        smoothBounce: false,
        noclusters: false,
        ricochet: false,
      });
    };
    const strokes = letterStrokes(letter);
    for (const { edge } of strokes) addQuad(edge, edgeMaterial, -1, -0.3);
    for (const { quad } of strokes) addQuad(quad, letterMaterial, letter === 'N' ? northDriver : -1, 0);
    tree.world.obstacles.mesh.push(passableMesh(vertices, faces));
  }
  return tree;
}

module.exports = { addCardinalLetters };
