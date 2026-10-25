#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Builds public/obj/bzflag.obj -- the stock tank, with tracks and road wheels --
// and bzflag-high.obj, bzflag-medium.obj and bzflag-low.obj from the BZFlag
// source tree, which is where upstream's tank actually lives.
//
// misc/tank.obj -- which bzflag-notracks.obj was made from -- is packaged but never
// read by the client: nothing compiles or loads it. What upstream draws is
// built in C++, one function per part per level of detail, in
// src/geometry/models/tank/. Those functions are immediate-mode OpenGL with
// the geometry written out as literals, so they can be read as data.
//
// Set BZFLAG_SRC to point at a BZFlag checkout; it defaults to ~/bzflag.
//
//   BZFLAG_SRC=~/bzflag node scripts/extract-bzflag-lod-tanks.mjs
//
// All three levels of detail, including the high one. bzflag-notracks.obj is
// upstream's high geometry too, but split into bzo's three-part tread convention -- a
// middle band with a cap at each end -- where upstream has one casing per
// side. So it never gets the one-piece treatment the other two do, and its
// belt is textured by three objects that each scale their own way. This
// extracts upstream's own shape instead, with the same handling as the
// cheaper two.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { navLightPositions, navLightSpot } from '../public/js/tank-dimensions.mjs';
import { CAMO_UNITS_PER_TILE } from '../public/js/tank-uv.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = process.env.BZFLAG_SRC || join(homedir(), 'bzflag');
const modelDir = join(srcRoot, 'src/geometry/models/tank');

if (!existsSync(modelDir)) {
  console.error(`No BZFlag tank models at ${modelDir}.`);
  console.error('Set BZFLAG_SRC to a BZFlag checkout.');
  process.exit(1);
}

// TankGeometryMgr.cxx: the medium barrel is the low one. Upstream substitutes
// it rather than building a third, so this does too instead of inventing one.
// The three levels of detail are read from the source. `treads` is the fourth
// tank here and the only one that is built: it takes the high body, turret and
// barrel, and replaces the casings with upstream's animated belt and its four
// road wheels a side. See buildTread above.
const LODS = {
  treads: {
    body: 'high_body.cxx',
    turret: 'high_turret.cxx',
    barrel: 'high_barrel.cxx',
  },
  high: {
    body: 'high_body.cxx',
    turret: 'high_turret.cxx',
    barrel: 'high_barrel.cxx',
    ltread: 'high_ltread.cxx',
    rtread: 'high_rtread.cxx',
  },
  medium: {
    body: 'medium_body.cxx',
    turret: 'medium_turret.cxx',
    barrel: 'low_barrel.cxx',
    ltread: 'medium_ltread.cxx',
    rtread: 'medium_rtread.cxx',
  },
  low: {
    body: 'low_body.cxx',
    turret: 'low_turret.cxx',
    barrel: 'low_barrel.cxx',
    ltread: 'low_ltread.cxx',
    rtread: 'low_rtread.cxx',
  },
};

// The tank is modelled with +X toward the muzzle, +Y to the left and +Z up.
// bzo's models are +X left, +Y up, +Z toward the rear -- the same conversion
// split-bzflag-tank.mjs makes for misc/tank.obj, so the two agree about which
// way a tank faces.
const toBzo = ([x, y, z]) => [-y, z, -x];

// A normal is a direction, so it takes the rotation but not any translation.
// This conversion has no translation in it, so it is the same arithmetic.
const toBzoNormal = toBzo;


// Upstream's animated tread, ported from AnimatedTreads.cxx.
//
// The casings the three levels of detail carry are a solid housing with the
// track painted on. The tank upstream actually draws when `animatedTreads` is
// on has a real belt instead: a closed loop -- a donut -- running round two
// drums a wheelbase apart, with an outer face, an inner face and an edge down
// each side, and four road wheels inside it. It is built rather than written
// out, so it cannot be read as literals the way the casings can.
//
// `setTreadStyle(Exposed)`, which is what a tank with no cover uses.
const TREAD = (() => {
  const fullLength = 6.0;
  const treadHeight = 1.2;
  const treadInside = 0.875;
  const treadOutside = 1.4;
  const treadThickness = 0.15;
  const treadWidth = treadOutside - treadInside;
  const treadRadius = 0.5 * treadHeight;
  const treadYCenter = treadInside + (0.5 * treadWidth);
  const treadLength = ((fullLength - treadHeight) * 2) + (Math.PI * treadHeight);
  const wheelRadius = treadRadius - (0.7 * treadThickness);
  const wheelWidth = treadWidth * 0.9;
  const wheelSpacing = (fullLength - treadHeight) / 3;
  return {
    fullLength,
    treadHeight,
    treadThickness,
    treadWidth,
    treadRadius,
    treadYCenter,
    treadLength,
    wheelRadius,
    wheelWidth,
    wheelSpacing,
    wheelInsideTexRad: 0.4,
    wheelOutsideTexRad: 0.5,
  };
})();

// A triangle strip, as upstream's GL_TRIANGLE_STRIP would have drawn it.
function stripToTriangles(strip) {
  const triangles = [];
  for (let i = 0; i + 2 < strip.length; i += 1) {
    const triangle = i % 2 === 0
      ? [strip[i], strip[i + 1], strip[i + 2]]
      : [strip[i + 1], strip[i], strip[i + 2]];
    // A strip that turns a corner repeats a vertex, which makes a triangle
    // with no area. It draws nothing, so it is not carried into the file.
    const [a, b, c] = triangle.map((vertex) => vertex.position);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area = Math.hypot(
      (e1[1] * e2[2]) - (e1[2] * e2[1]),
      (e1[2] * e2[0]) - (e1[0] * e2[2]),
      (e1[0] * e2[1]) - (e1[1] * e2[0]),
    ) / 2;
    if (area > 1e-9) triangles.push(triangle);
  }
  return triangles;
}

// `buildTread`. Upstream lays one copy of its tread texture round the whole
// belt; `tiles` is how many bzo lays, so a link here is the size it is on
// every other tank. And `u` and `v` are exchanged on the way out, because
// upstream runs its texture along the belt in `u` where bzo runs it in `v`.
function buildTread(yOffset, divisions, tiles) {
  const {
    treadHeight, treadThickness, treadWidth, treadRadius, treadLength,
    wheelSpacing, fullLength,
  } = TREAD;
  const divs = Math.floor(divisions / 2) * 2;
  const divScale = 2 / divs;
  const astep = (Math.PI * 2) / divs;
  const yLeft = yOffset + (0.5 * treadWidth);
  const yRight = yOffset - (0.5 * treadWidth);
  const halfBase = wheelSpacing * 1.5;

  const txScale = 1 / treadLength;
  const tx0 = 0;
  const tx1 = txScale * (treadRadius * Math.PI);
  const tx2 = txScale * ((treadRadius * Math.PI) + (fullLength - treadHeight));
  const tx3 = txScale * ((treadHeight * Math.PI) + (fullLength - treadHeight));
  const tx4 = 1;
  const tyScale = 1 / (2 * (treadWidth + treadThickness));
  const ty0 = 0;
  const ty1 = tyScale * treadWidth;
  const ty2 = tyScale * (treadWidth + treadThickness);
  const ty3 = tyScale * ((2 * treadWidth) + treadThickness);
  const ty4 = 1;

  const vertex = (x, y, z, normal, tx, ty) => ({
    position: toBzo([x, y, z]),
    normal: toBzoNormal(normal),
    // Exchanged, and the along-belt run multiplied up to bzo's tile count.
    //
    // Reversed as well. render.js scrolls a belt by advancing `offset.x`, and
    // which way that drives the track depends on which way round the belt was
    // numbered; built the other way, a tank turning left rolled its right
    // track backwards and its left forwards, which is a tank turning right.
    texcoord: [ty, (1 - tx) * tiles],
  });
  const steps = Math.floor(divisions / 2) + 1;
  const triangles = [];


  // Outer surface.
  {
    const strip = [];
    for (let i = 0; i < steps; i += 1) {
      const ang = (astep * i) - (Math.PI / 2);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const tx = tx0 + ((tx1 - tx0) * (i * divScale));
      const x = (c * treadRadius) + halfBase;
      const z = (s * treadRadius) + treadRadius;
      strip.push(vertex(x, yRight, z, [c, 0, s], tx, ty1));
      strip.push(vertex(x, yLeft, z, [c, 0, s], tx, ty0));
    }
    strip.push(vertex(-halfBase, yRight, treadHeight, [0, 0, 1], tx2, ty1));
    strip.push(vertex(-halfBase, yLeft, treadHeight, [0, 0, 1], tx2, ty0));
    for (let i = 0; i < steps; i += 1) {
      const ang = (astep * i) + (Math.PI / 2);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const tx = tx2 + ((tx3 - tx2) * (i * divScale));
      const x = (c * treadRadius) - halfBase;
      const z = (s * treadRadius) + treadRadius;
      strip.push(vertex(x, yRight, z, [c, 0, s], tx, ty1));
      strip.push(vertex(x, yLeft, z, [c, 0, s], tx, ty0));
    }
    strip.push(vertex(halfBase, yRight, 0, [0, 0, -1], tx4, ty1));
    strip.push(vertex(halfBase, yLeft, 0, [0, 0, -1], tx4, ty0));
    triangles.push(...stripToTriangles(strip));
  }

  // Inner surface.
  {
    const inner = treadRadius - treadThickness;
    const strip = [];
    for (let i = 0; i < steps; i += 1) {
      const ang = (astep * i) - (Math.PI / 2);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const tx = tx0 + ((tx1 - tx0) * (i * divScale));
      const x = (c * inner) + halfBase;
      const z = (s * inner) + treadRadius;
      strip.push(vertex(x, yLeft, z, [-c, 0, -s], tx, ty3));
      strip.push(vertex(x, yRight, z, [-c, 0, -s], tx, ty2));
    }
    strip.push(vertex(-halfBase, yLeft, treadHeight - treadThickness, [0, 0, -1], tx2, ty3));
    strip.push(vertex(-halfBase, yRight, treadHeight - treadThickness, [0, 0, -1], tx2, ty2));
    for (let i = 0; i < steps; i += 1) {
      const ang = (astep * i) + (Math.PI / 2);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const tx = tx2 + ((tx3 - tx2) * (i * divScale));
      const x = (c * inner) - halfBase;
      const z = (s * inner) + treadRadius;
      strip.push(vertex(x, yLeft, z, [-c, 0, -s], tx, ty3));
      strip.push(vertex(x, yRight, z, [-c, 0, -s], tx, ty2));
    }
    strip.push(vertex(halfBase, yLeft, treadThickness, [0, 0, 1], tx4, ty3));
    strip.push(vertex(halfBase, yRight, treadThickness, [0, 0, 1], tx4, ty2));
    triangles.push(...stripToTriangles(strip));
  }

  // The two edges. These are the faces that face along the tank's width, so
  // they are the ones the renderer gives the static end texture to.
  for (const [y, normal, outerTex, innerTex] of [
    [yRight, [0, -1, 0], ty1, ty2],
    [yLeft, [0, 1, 0], ty4, ty3],
  ]) {
    const inner = treadRadius - treadThickness;
    const strip = [];
    const outerFirst = y === yLeft;
    const pair = (x1, z1, t1, x2, z2, t2) => {
      strip.push(vertex(x1, y, z1, normal, t1[0], t1[1]));
      strip.push(vertex(x2, y, z2, normal, t2[0], t2[1]));
    };
    for (let i = 0; i < steps; i += 1) {
      const ang = (astep * i) - (Math.PI / 2);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const tx = tx0 + ((tx1 - tx0) * (i * divScale));
      const xo = (c * treadRadius) + halfBase;
      const zo = (s * treadRadius) + treadRadius;
      const xi = (c * inner) + halfBase;
      const zi = (s * inner) + treadRadius;
      if (outerFirst) pair(xo, zo, [tx, outerTex], xi, zi, [tx, innerTex]);
      else pair(xi, zi, [tx, innerTex], xo, zo, [tx, outerTex]);
    }
    const zt = treadHeight;
    const zti = treadHeight - treadThickness;
    if (outerFirst) pair(-halfBase, zt, [tx2, outerTex], -halfBase, zti, [tx2, innerTex]);
    else pair(-halfBase, zti, [tx2, innerTex], -halfBase, zt, [tx2, outerTex]);
    for (let i = 0; i < steps; i += 1) {
      const ang = (astep * i) + (Math.PI / 2);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const tx = tx2 + ((tx3 - tx2) * (i * divScale));
      const xo = (c * treadRadius) - halfBase;
      const zo = (s * treadRadius) + treadRadius;
      const xi = (c * inner) - halfBase;
      const zi = (s * inner) + treadRadius;
      if (outerFirst) pair(xo, zo, [tx, outerTex], xi, zi, [tx, innerTex]);
      else pair(xi, zi, [tx, innerTex], xo, zo, [tx, outerTex]);
    }
    if (outerFirst) pair(halfBase, 0, [tx4, outerTex], halfBase, treadThickness, [tx4, innerTex]);
    else pair(halfBase, treadThickness, [tx4, innerTex], halfBase, 0, [tx4, outerTex]);
    triangles.push(...stripToTriangles(strip));
  }

  return triangles;
}


// `buildCasing`. The plate that closes the hull in beside each belt --
// upstream's animated tank draws it from `buildHighLCasingAnim`, which is this
// plus a cover that only the Covered tread style has. Without it the hull has
// an open end where the tread runs past it.
function buildCasing(yOffset) {
  const { treadWidth, treadThickness, treadHeight, wheelSpacing } = TREAD;
  // Upstream makes this plate 0.6 of the track's width. Narrower here, so it
  // sits further inside the belt and leaves the edges of the road wheels
  // showing between the two -- which is most of what says the belt is a belt
  // and not a painted-on housing.
  const casingWidth = treadWidth * 0.35;
  const yLeft = yOffset + (0.5 * casingWidth);
  const yRight = yOffset - (0.5 * casingWidth);
  const xc = wheelSpacing * 1.5;
  const zb = treadThickness;
  const zt = treadHeight - treadThickness;
  const ty = 0.25;
  const tx = (2 * ty) * (xc / (zt - zb));

  const at = (x, y, z, normal, u, v) => ({
    position: toBzo([x, y, z]),
    normal: toBzoNormal(normal),
    texcoord: [u, v],
  });
  const right = [
    at(-xc, yRight, zb, [0, -1, 0], -tx, -ty),
    at(+xc, yRight, zb, [0, -1, 0], +tx, -ty),
    at(-xc, yRight, zt, [0, -1, 0], -tx, +ty),
    at(+xc, yRight, zt, [0, -1, 0], +tx, +ty),
  ];
  const left = [
    at(+xc, yLeft, zb, [0, 1, 0], -tx, -ty),
    at(-xc, yLeft, zb, [0, 1, 0], +tx, -ty),
    at(+xc, yLeft, zt, [0, 1, 0], -tx, +ty),
    at(-xc, yLeft, zt, [0, 1, 0], +tx, +ty),
  ];
  return [...stripToTriangles(right), ...stripToTriangles(left)];
}

// `buildWheel`, the four road wheels inside each belt.
//
// Upstream turns each wheel's texture by giving it a starting `angle`, so no
// two wheels are in phase. render.js already does that for itself -- it turns
// each wheel's cap texture by its own index -- so baking upstream's angle in
// as well turns every cap twice and the two disagree about which way a wheel
// is pointing. This is built square and the renderer turns it.
//
// `mirrored` lays the caps' picture the other way over, which a left wheel
// needs: render.js turns a left wheel's cap texture one way and a right
// wheel's the other, so the two sides' caps have to be mirror images for both
// to roll forward when the tank does -- as Wheeled 6's are.
function buildWheel(centre, angle, divisions, { mirrored = false } = {}) {
  const { wheelRadius, wheelWidth, wheelInsideTexRad } = TREAD;
  const astep = (Math.PI * 2) / divisions;
  const yLeft = centre[1] + (0.5 * wheelWidth);
  const yRight = centre[1] - (0.5 * wheelWidth);
  const triangles = [];

  const rim = [];
  const slotOf = [];
  for (let i = 0; i < divisions + 1; i += 1) {
    const ang = astep * i;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const x = (c * wheelRadius) + centre[0];
    const z = (s * wheelRadius) + centre[2];
    // The rim runs the texture round the wheel, not across a disc. Upstream
    // maps it from the same disc its caps use, because its wheel texture is
    // one picture of a wheel; bzo gives the rim a texture of its own and rolls
    // it by advancing `offset.x`, so `u` has to go round the circumference and
    // `v` across the width -- which is what a cylinder's side hands back, and
    // so what the wheels on Wheeled 6 already do.
    // Counted backwards round the wheel. `u` has to grow the way a cylinder's
    // does, and upstream's angle sweeps the opposite way once its axes are
    // converted to bzo's -- so a rim built straight from it rolls against the
    // direction the wheel is turning.
    const around = 1 - (i / divisions);
    // `v` runs the same way round as a cylinder's side does, so the rim reads
    // the same way up here as it does on Wheeled 6.
    rim.push({
      position: toBzo([x, yRight, z]),
      normal: toBzoNormal([c, 0, s]),
      texcoord: [around, 1],
    });
    rim.push({
      position: toBzo([x, yLeft, z]),
      normal: toBzoNormal([c, 0, s]),
      texcoord: [around, 0],
    });
  }
  const rimTriangles = stripToTriangles(rim);
  triangles.push(...rimTriangles);
  for (let i = 0; i < rimTriangles.length; i += 1) slotOf.push(0);

  // A face on each side, as a fan.
  for (const [y, normal, sign] of [[yLeft, [0, 1, 0], -1], [yRight, [0, -1, 0], 1]]) {
    const fan = [];
    for (let i = 0; i < divisions; i += 1) {
      const ang = astep * i * sign;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      // A cylinder's two ends take the same disc, mirrored: three.js lays both
      // caps out from the same angle and flips one of them in `v`. Both halves
      // of that matter here.
      //
      // The disc is mirrored again for a left wheel (`mirrored`), since
      // render.js turns the two sides' caps opposite ways.
      //
      // Flipping `v` is what keeps the two faces of a single wheel agreeing.
      // They look at each other from opposite sides, so a disc laid on both
      // the same way up turns with the wheel on the outside and against it on
      // the inside.
      const texAngle = angle + (astep * i);
      fan.push({
        position: toBzo([(c * wheelRadius) + centre[0], y, (s * wheelRadius) + centre[2]]),
        normal: toBzoNormal(normal),
        texcoord: [
          0.5 + (Math.cos(texAngle) * wheelInsideTexRad),
          0.5 + (Math.sin(texAngle) * wheelInsideTexRad * sign * (mirrored ? -1 : 1)),
        ],
      });
    }
    for (let i = 1; i + 1 < fan.length; i += 1) {
      triangles.push([fan[0], fan[i], fan[i + 1]]);
      slotOf.push(sign < 0 ? 1 : 2);
    }
  }

  triangles.materialSlots = slotOf;
  return triangles;
}


const NUMBER = '(-?[0-9]*\\.?[0-9]+(?:e-?[0-9]+)?)f?';
const reNormal = new RegExp(`doNormal3f\\s*\\(\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*\\)`);
const reTexCoord = new RegExp(`doTexCoord2f\\s*\\(\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*\\)`);
const reVertex = new RegExp(`doVertex3f\\s*\\(\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*\\)`);




// How much of the world one unit of texture covers on a part, measured off the
// part itself.
//
// A new face has to be painted at the size its neighbours are painted, and
// CAMO_UNITS_PER_TILE is not that size: upstream's coordinates index a skin
// rather than tile a pattern, so they have no single scale. The body runs
// about 3.1 world units to a unit of texture and the turret nearer 4.2, and a
// patch laid at 4 on either reads as the wrong size against everything around
// it. Taken by area, over every face that has both, so a face given
// coordinates here carries as much of the texture per unit of surface as
// upstream's own faces do. Averaging edge lengths instead weights long thin
// faces' long edges and comes out more than twice as dense.
function uvScaleOf(triangles, fallback = CAMO_UNITS_PER_TILE) {
  let world = 0;
  let texture = 0;
  for (const triangle of triangles) {
    if (triangle.some((v) => v.texcoord === null)) continue;
    const [p0, p1, p2] = triangle.map((v) => v.position);
    const [t0, t1, t2] = triangle.map((v) => v.texcoord);
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const area = Math.hypot(
      (e1[1] * e2[2]) - (e1[2] * e2[1]),
      (e1[2] * e2[0]) - (e1[0] * e2[2]),
      (e1[0] * e2[1]) - (e1[1] * e2[0]),
    ) / 2;
    const texels = Math.abs(((t1[0] - t0[0]) * (t2[1] - t0[1])) - ((t2[0] - t0[0]) * (t1[1] - t0[1]))) / 2;
    if (area > 1e-9 && texels > 1e-9) {
      world += area;
      texture += texels;
    }
  }
  return texture > 0 ? Math.sqrt(world / texture) : fallback;
}

// The edges a part leaves open: edges belonging to exactly one triangle.
// Chained head to tail they make the outline of each hole.
function boundaryLoops(triangles) {
  const key = (v) => v.position.map((n) => n.toFixed(4)).join(',');
  const count = new Map();
  const owner = new Map();
  for (const triangle of triangles) {
    for (let i = 0; i < 3; i += 1) {
      const a = key(triangle[i]);
      const b = key(triangle[(i + 1) % 3]);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(edge, (count.get(edge) || 0) + 1);
      if (!owner.has(edge)) owner.set(edge, triangle);
    }
  }
  const at = new Map();
  for (const triangle of triangles) for (const v of triangle) at.set(key(v), v);

  const next = new Map();
  const open = [];
  for (const [edge, n] of count) {
    if (n !== 1) continue;
    const [a, b] = edge.split('|');
    open.push([a, b, owner.get(edge)]);
    if (!next.has(a)) next.set(a, []);
    if (!next.has(b)) next.set(b, []);
    next.get(a).push(b);
    next.get(b).push(a);
  }

  const visited = new Set();
  const loops = [];
  for (const [start] of open) {
    if (visited.has(start)) continue;
    const loop = [start];
    visited.add(start);
    let here = start;
    for (;;) {
      const step = (next.get(here) || []).find((n) => !visited.has(n));
      if (!step) break;
      visited.add(step);
      loop.push(step);
      here = step;
    }
    if (loop.length >= 3) {
      loops.push({
        points: loop.map((k) => at.get(k)),
        neighbours: open.filter(([a, b]) => loop.includes(a) || loop.includes(b)).map(([, , t]) => t),
      });
    }
  }
  return loops;
}

// Closes every hole in a part, so the part is a solid in its own right.
//
// This matters because an exploding tank is taken apart and its pieces thrown
// across the map: each one is then seen from every side, including the side
// that used to face another part. Whether something else covers the hole on
// the assembled tank is beside the point.
//
// Each hole is filled with a fan from the middle of its outline, wound so the
// new face points away from the solid it closes -- worked out from where the
// triangles around the hole sit, rather than assumed.
function capBoundaryLoops(triangles) {
  const caps = [];

  // Only holes you can see out of. A hole facing into the part's own bulk is
  // already closed by the part: the two tabs at the back of the hull open
  // forwards into it, and they are thrown with the hull rather than on their
  // own, so a face across them could never be seen. A hatch sunk into the
  // turret's roof looks out at the sky, and can.
  //
  // Asked by firing a ray out of the hole along the way it faces and seeing
  // whether the part is in the way. That is the question itself rather than a
  // stand-in for it, and it does not care where the hole sits in the part's
  // bounding box -- both of these are well inside it.
  const escapes = (from, direction) => {
    for (const triangle of triangles) {
      const [a, b, c] = triangle.map((v) => v.position);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const h = [
        (direction[1] * e2[2]) - (direction[2] * e2[1]),
        (direction[2] * e2[0]) - (direction[0] * e2[2]),
        (direction[0] * e2[1]) - (direction[1] * e2[0]),
      ];
      const det = (e1[0] * h[0]) + (e1[1] * h[1]) + (e1[2] * h[2]);
      if (Math.abs(det) < 1e-9) continue;
      const inv = 1 / det;
      const s = [from[0] - a[0], from[1] - a[1], from[2] - a[2]];
      const u = inv * ((s[0] * h[0]) + (s[1] * h[1]) + (s[2] * h[2]));
      if (u < 0 || u > 1) continue;
      const q = [
        (s[1] * e1[2]) - (s[2] * e1[1]),
        (s[2] * e1[0]) - (s[0] * e1[2]),
        (s[0] * e1[1]) - (s[1] * e1[0]),
      ];
      const v = inv * ((direction[0] * q[0]) + (direction[1] * q[1]) + (direction[2] * q[2]));
      if (v < 0 || u + v > 1) continue;
      const t = inv * ((e2[0] * q[0]) + (e2[1] * q[1]) + (e2[2] * q[2]));
      // Past the lip of the hole itself, so the rim it sits in does not count
      // as the part getting in its own way.
      if (t > 1e-3) return false;
    }
    return true;
  };

  for (const loop of boundaryLoops(triangles)) {
    const { points, neighbours } = loop;
    const centre = [0, 1, 2].map((axis) =>
      points.reduce((sum, v) => sum + v.position[axis], 0) / points.length);

    // Newell's normal, which is the plane the outline lies in however many
    // corners it has and whether or not they are quite coplanar.
    const n = [0, 0, 0];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i].position;
      const b = points[(i + 1) % points.length].position;
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const length = Math.hypot(...n) || 1;
    const unit = n.map((c) => c / length);

    // Away from the material: the triangles along the hole's edge have their
    // bulk on one side of it, so the cap faces the other way.
    const inside = [0, 1, 2].map((axis) => {
      let sum = 0;
      let seen = 0;
      for (const triangle of neighbours) {
        for (const v of triangle) {
          sum += v.position[axis];
          seen += 1;
        }
      }
      return seen ? (sum / seen) - centre[axis] : 0;
    });
    const facingIn = (unit[0] * inside[0]) + (unit[1] * inside[1]) + (unit[2] * inside[2]) > 0;
    const normal = facingIn ? unit.map((c) => -c) : unit;

    // A new face on a textured part needs coordinates of its own, at the same
    // patch size as everything else; on a part that carries none -- the barrel
    // -- it stays bare so the renderer wraps the whole thing.
    const textured = triangles[0][0].texcoord !== null;
    const scale = textured ? uvScaleOf(triangles) : 1;
    const flat = (position) => {
      if (!textured) return null;
      const ax = Math.abs(normal[0]);
      const ay = Math.abs(normal[1]);
      const az = Math.abs(normal[2]);
      const pair = (ax >= ay && ax >= az) ? [position[2], position[1]]
        : ((ay >= az) ? [position[0], position[2]] : [position[0], position[1]]);
      return [pair[0] / scale, pair[1] / scale];
    };
    const at = (position) => ({ position, normal, texcoord: flat(position) });
    if (!escapes(centre.map((c, axis) => c + (normal[axis] * 1e-3)), normal)) continue;

    const hub = at(centre);
    for (let i = 0; i < points.length; i += 1) {
      const a = at(points[i].position);
      const b = at(points[(i + 1) % points.length].position);
      caps.push(facingIn ? [hub, b, a] : [hub, a, b]);
    }
  }
  return caps;
}

// The barrel as a pipe rather than a capped rod: an outer wall, an inner wall
// down the bore, and a ring closing the gap between them at each end. Upstream
// draws a tube with the muzzle capped over and the breech left open, which is
// a bore that is sealed at the end you look down and open at the end buried in
// the turret.
//
// The outer surface is kept exactly as upstream has it. The bore is that
// surface brought in toward the barrel's own axis by `wall`.
function barrelToPipe(triangles, wall = 0.04) {
  const rings = new Map();
  for (const triangle of triangles) {
    for (const v of triangle) {
      const z = v.position[2].toFixed(3);
      if (!rings.has(z)) rings.set(z, new Map());
      rings.get(z).set(v.position.map((n) => n.toFixed(4)).join(','), v.position);
    }
  }
  // The two ends are the rings the most vertices sit on; anything else is the
  // middle of the cap that is about to be thrown away.
  const ends = [...rings.entries()]
    .map(([z, members]) => ({ z: Number(z), points: [...members.values()] }))
    .filter((ring) => ring.points.length >= 3)
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, 2)
    .sort((a, b) => a.z - b.z);
  if (ends.length !== 2) return null;

  const ordered = (ring) => {
    const cx = ring.points.reduce((s, p) => s + p[0], 0) / ring.points.length;
    const cy = ring.points.reduce((s, p) => s + p[1], 0) / ring.points.length;
    return {
      centre: [cx, cy],
      points: [...ring.points].sort((a, b) =>
        Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)),
      z: ring.z,
    };
  };
  const [muzzle, breech] = [ordered(ends[0]), ordered(ends[1])];
  if (muzzle.points.length !== breech.points.length) return null;
  const sides = muzzle.points.length;

  const shrink = (ring) => ring.points.map((p) => {
    const dx = p[0] - ring.centre[0];
    const dy = p[1] - ring.centre[1];
    const r = Math.hypot(dx, dy) || 1;
    const inner = Math.max(r * 0.25, r - wall);
    return [ring.centre[0] + ((dx / r) * inner), ring.centre[1] + ((dy / r) * inner), p[2]];
  });
  const muzzleIn = shrink(muzzle);
  const breechIn = shrink(breech);

  const vertex = (position, normal) => ({ position, normal, texcoord: null });
  const radial = (p, centre, sign) => {
    const dx = p[0] - centre[0];
    const dy = p[1] - centre[1];
    const r = Math.hypot(dx, dy) || 1;
    return [(dx / r) * sign, (dy / r) * sign, 0];
  };
  const out = [];
  // Upstream's own outer wall, minus the disc that closed the muzzle over.
  for (const triangle of triangles) {
    const zs = triangle.map((v) => v.position[2].toFixed(3));
    if (zs[0] === zs[1] && zs[1] === zs[2]) continue;
    out.push(triangle);
  }
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    const mo = muzzle.points[i];
    const mo2 = muzzle.points[j];
    const bo = breech.points[i];
    const bo2 = breech.points[j];
    const mi = muzzleIn[i];
    const mi2 = muzzleIn[j];
    const bi = breechIn[i];
    const bi2 = breechIn[j];
    const inward = radial(mi, muzzle.centre, -1);
    const inward2 = radial(mi2, muzzle.centre, -1);
    // The bore, facing in.
    out.push([vertex(mi, inward), vertex(bi, inward), vertex(mi2, inward2)]);
    out.push([vertex(mi2, inward2), vertex(bi, inward), vertex(bi2, inward2)]);
    // The ring of metal at each end, facing along the barrel.
    //
    // Wound to agree with that facing. A normal only tells the light where the
    // surface points; what decides whether the face is drawn at all is the
    // order its corners are in. Wound the other way the muzzle ring faces back
    // down the barrel, so it is culled from in front -- which is the one angle
    // it exists for, a tank coming at you.
    const ahead = [0, 0, -1];
    const behind = [0, 0, 1];
    out.push([vertex(mo, ahead), vertex(mi, ahead), vertex(mo2, ahead)]);
    out.push([vertex(mi, ahead), vertex(mi2, ahead), vertex(mo2, ahead)]);
    out.push([vertex(bo, behind), vertex(bo2, behind), vertex(bi, behind)]);
    out.push([vertex(bi, behind), vertex(bo2, behind), vertex(bi2, behind)]);
  }
  return out;
}

// Faces upstream leaves without texture coordinates of their own.
//
// Immediate mode carries the last `doTexCoord2f` forward onto every vertex
// until the next one, and the body does not set them for every face it draws:
// four of the six faces across the back and half of those down the sides come
// out with all three corners on one texel. Upstream can afford that -- those
// faces are nearly edge-on to a player most of the time. bzo cannot, because
// the whole side of the body is thrown across the map when a tank explodes,
// and a face painted from one texel reads as a flat plastic panel.
//
// So those faces, and only those, are given coordinates from their own
// position, at the same size a camo patch is everywhere else.
function repairFlatTexCoords(triangles) {
  // Measured before anything is rewritten, so the faces being repaired do not
  // drag the average they are being matched to.
  const scale = uvScaleOf(triangles.filter((triangle) => {
    const [a, b, c] = triangle.map((v) => v.texcoord);
    if (!a || !b || !c) return false;
    return Math.abs(((b[0] - a[0]) * (c[1] - a[1])) - ((c[0] - a[0]) * (b[1] - a[1]))) / 2 > 1e-9;
  }));
  for (const triangle of triangles) {
    const [a, b, c] = triangle.map((vertex) => vertex.texcoord);
    const area = Math.abs(((b[0] - a[0]) * (c[1] - a[1])) - ((c[0] - a[0]) * (b[1] - a[1]))) / 2;
    if (area > 1e-9) continue;

    // The plane the face most nearly lies in, so it is never textured edge-on.
    //
    // From the corners rather than from the stored normal. A strip carries one
    // `doNormal3f` forward over several faces, so the normal a face is holding
    // need not be its own -- and projecting onto the plane that normal picks
    // can lay the face down edge-on, which leaves its three corners on a line
    // and no better off than before.
    const [p0, p1, p2] = triangle.map((vertex) => vertex.position);
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const n = [
      (e1[1] * e2[2]) - (e1[2] * e2[1]),
      (e1[2] * e2[0]) - (e1[0] * e2[2]),
      (e1[0] * e2[1]) - (e1[1] * e2[0]),
    ];
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    let axis = 0;
    if (ay >= ax && ay >= az) axis = 1;
    else if (az >= ax && az >= ay) axis = 2;

    for (const vertex of triangle) {
      const [x, y, z] = vertex.position;
      const pair = axis === 0 ? [z, y] : (axis === 1 ? [x, z] : [x, y]);
      vertex.texcoord = [pair[0] / scale, pair[1] / scale];
    }
  }
}

// Immediate mode carries the last normal and texcoord forward onto every
// vertex until they are set again, so they are state rather than per-vertex
// data and have to be tracked that way.
function readPart(file) {
  const text = readFileSync(join(modelDir, file), 'utf-8');
  const triangles = [];
  let mode = null;
  let strip = [];
  let normal = [0, 0, 1];
  let texcoord = [0, 0];
  let sawTexCoord = false;

  const emitStrip = () => {
    if (mode === 'GL_TRIANGLES') {
      for (let i = 0; i + 2 < strip.length; i += 3) {
        triangles.push([strip[i], strip[i + 1], strip[i + 2]]);
      }
    } else if (mode === 'GL_TRIANGLE_STRIP') {
      // Every vertex after the second closes a triangle with the two before
      // it, and every other one is wound backwards.
      for (let i = 0; i + 2 < strip.length; i += 1) {
        triangles.push(i % 2 === 0
          ? [strip[i], strip[i + 1], strip[i + 2]]
          : [strip[i + 1], strip[i], strip[i + 2]]);
      }
    } else if (mode === 'GL_TRIANGLE_FAN') {
      for (let i = 1; i + 1 < strip.length; i += 1) {
        triangles.push([strip[0], strip[i], strip[i + 1]]);
      }
    }
    strip = [];
    mode = null;
  };

  for (const line of text.split('\n')) {
    const begin = line.match(/glBegin\s*\(\s*(GL_\w+)\s*\)/);
    if (begin) {
      mode = begin[1];
      strip = [];
      continue;
    }
    if (/glEnd\s*\(\s*\)/.test(line)) {
      emitStrip();
      continue;
    }
    if (mode === null) continue;

    const n = line.match(reNormal);
    if (n) {
      normal = toBzoNormal([Number(n[1]), Number(n[2]), Number(n[3])]);
      continue;
    }
    const t = line.match(reTexCoord);
    if (t) {
      sawTexCoord = true;
      texcoord = [Number(t[1]), Number(t[2])];
      continue;
    }
    const v = line.match(reVertex);
    if (v) {
      strip.push({
        position: toBzo([Number(v[1]), Number(v[2]), Number(v[3])]),
        normal,
        texcoord,
      });
    }
  }

  if (triangles.length === 0) throw new Error(`${file} produced no triangles`);
  // Upstream gives the barrel no texture coordinates at all -- it is drawn
  // untextured. Writing the zeros out would paint the whole barrel from one
  // texel; leaving them out lets bzo's own `_generateMissingTankUVs` wrap it
  // with the rest of the tank.
  if (!sawTexCoord) for (const triangle of triangles) for (const v of triangle) v.texcoord = null;
  else repairFlatTexCoords(triangles);
  return triangles;
}

// bzo's own part names, which TANK_PART_ALIASES in client.js matches on.
// `ltread`/`rtread` are the one-piece spelling: they alias to the middle band
// and to both caps at once, which is how render.js recognises a tread that is
// a single casing rather than a band with two caps bolted on.
const PART_NAMES = {
  body: 'body',
  turret: 'turret',
  barrel: 'barrel',
  ltread: 'ltread',
  rtread: 'rtread',
};

// A wheel names itself; everything else is looked up above.
const partName = (part) => PART_NAMES[part] || part;

// One tread tile per this many world units, so a tread link is the same size
// here as on every other tank.
//
// Measured off the models rather than taken from TREAD_UNITS_PER_TILE in
// render-tanks.js, which is 6.4: that constant is what `_projectTankUVsAroundBelt`
// uses for a model that ships no texture coordinates of its own, and the
// models that do ship them are laid out differently. Modern and Simple run
// four tiles round a belt of 13.36, which is this.
const TREAD_UNITS_PER_TILE = 3.34;

// The casing's two materials, in the order render.js binds them: the band the
// tread pattern runs along, then the flat plates on either side of it.
const TREAD_MATERIAL = 'tread';
const TREAD_SIDE_MATERIAL = 'treadSide';

// A wheel's three, in the order render.js binds them: the rim it rolls on,
// then the cap on each side. The caps take the turning wheel-cap texture, so
// they have to be their own groups rather than sharing the rim's.
const WHEEL_MATERIALS = ['wheelRim', 'wheelCapLeft', 'wheelCapRight'];

// A face pointing along the tank's width is a side plate; anything else is on
// the belt. Upstream draws the whole casing from one tank skin, so its own
// texture coordinates index an atlas bzo does not have and cannot be reused.
const isSideFace = (normal) => Math.abs(normal[0]) >= Math.max(Math.abs(normal[1]), Math.abs(normal[2]));

// Texture coordinates for one casing.
//
// The belt is a loop, so the pattern has to advance by the same amount per
// unit of track all the way round -- an angle measured about the middle would
// spend most of its range rounding the two ends and bunch the links there.
// So `u` is arc length around the casing's own silhouette: the outline is
// sampled by angle once, turned into a running total of distance, and each
// vertex reads its distance back out of that table. `v` runs across the width.
//
// The side plates are not on the belt and do not move with it. They take a
// flat mapping of the same silhouette, at the same units per tile, and the
// renderer gives them the tread's end texture, which never scrolls.
function casingUVs(triangles) {
  const vertices = triangles.flat();
  const xs = vertices.map((vertex) => vertex.position[0]);
  const minX = Math.min(...xs);
  const widthX = (Math.max(...xs) - minX) || 1;

  // The belt's outline, seen from the side, as its convex hull.
  //
  // The hull rather than the vertices themselves, because not every vertex is
  // on the outline: the high casing's nose is faceted, so it carries points
  // like (-2.86, 0.74) sitting behind the tip at (-3.00, 0.77). Threading the
  // contour through those zigzags it and counts length that no track has.
  const seen = new Map();
  for (const vertex of vertices) {
    const [, y, z] = vertex.position;
    seen.set(`${z.toFixed(4)},${y.toFixed(4)}`, [z, y]);
  }
  const points = [...seen.values()].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (((a[0] - o[0]) * (b[1] - o[1])) - ((a[1] - o[1]) * (b[0] - o[0])));
  const half = (list) => {
    const out = [];
    for (const point of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  const hull = [...half(points), ...half([...points].reverse())];

  const centreZ = hull.reduce((sum, [z]) => sum + z, 0) / hull.length;
  const centreY = hull.reduce((sum, [, y]) => sum + y, 0) / hull.length;
  const angleOf = (z, y) => {
    const a = Math.atan2(y - centreY, z - centreZ);
    return a < 0 ? a + (Math.PI * 2) : a;
  };

  // Distance round the hull, and the angle each corner stands at. A vertex is
  // then placed by its own angle, which is monotonic all the way round and so
  // cannot doubie back -- and an inset vertex lands where the outline is at
  // that bearing, which is where its own face is pointing anyway.
  const corners = hull
    .map(([z, y]) => ({ z, y, angle: angleOf(z, y) }))
    .sort((a, b) => a.angle - b.angle);
  const arc = [0];
  for (let i = 1; i <= corners.length; i += 1) {
    const a = corners[i - 1];
    const b = corners[i % corners.length];
    arc.push(arc[i - 1] + Math.hypot(b.z - a.z, b.y - a.y));
  }
  const perimeter = arc[corners.length];

  const distanceAt = (y, z) => {
    const angle = angleOf(z, y);
    let i = corners.length - 1;
    while (i > 0 && corners[i].angle > angle) i -= 1;
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    let span = b.angle - a.angle;
    if (span <= 0) span += Math.PI * 2;
    let along = angle - a.angle;
    if (along < 0) along += Math.PI * 2;
    const t = span > 1e-9 ? Math.min(1, along / span) : 0;
    return arc[i] + ((arc[i + 1] - arc[i]) * t);
  };

  // Across the track in `u` and along it in `v`, which is the convention every
  // other tread in bzo already uses: a BoxGeometry's top and bottom faces come
  // out that way, and render.js turns the tread texture a quarter turn to suit
  // them. That rotation is also what makes the belt scroll along the track
  // when `offset.x` moves, so a casing mapped the other way round scrolls
  // across the track instead -- thin stripes running side to side.
  //
  // The tile count is rounded so the pattern meets itself at the seam rather
  // than being cut off part way through a link.
  const tiles = Math.max(1, Math.round(perimeter / TREAD_UNITS_PER_TILE));
  const perUnit = tiles / perimeter;

  return (vertex) => {
    const [x, y, z] = vertex.position;
    if (isSideFace(vertex.normal)) {
      return [y / TREAD_UNITS_PER_TILE, z / TREAD_UNITS_PER_TILE];
    }
    return [(x - minX) / widthX, distanceAt(y, z) * perUnit];
  };
}

function buildObj(parts, label) {
  let out = `# BZFlag ${label} tank, extracted from the BZFlag source tree by\n`;
  out += '# scripts/extract-bzflag-lod-tanks.mjs. The geometry is upstream\'s own,\n';
  out += `# from src/geometry/models/tank (BZFlag, LGPL 2.1).\n`;
  // `v`, `vt` and `vn` are each numbered from one across the whole file, and a
  // part that writes no `vt` stops the three running in step -- so they are
  // counted apart rather than assumed equal.
  let vOffset = 0;
  let vtOffset = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  for (const [part, triangles] of Object.entries(parts)) {
    const isCasing = (part === 'ltread' || part === 'rtread') && label !== 'treads';
    // A casing's texture coordinates are bzo's, not upstream's: upstream draws
    // the whole tank from one skin and its own coordinates index an atlas bzo
    // does not have.
    const uvOf = isCasing ? casingUVs(triangles) : ((vertex) => vertex.texcoord);
    // The belt faces are written first and the side plates after, so each ends
    // up one run of faces the loader can turn into one material group.
    // The belt's faces are grouped the same way whether they were read or
    // built: everything on the track first, then the plates down each side.
    const isBelt = part === 'ltread' || part === 'rtread';
    // A wheel carries the slot each of its triangles belongs in, from the way
    // it was built; sorting by that groups the rim and the two caps.
    const slots = triangles.materialSlots || null;
    const order = slots
      ? triangles.map((triangle, i) => ({ triangle, slot: slots[i] }))
        .sort((left, right) => left.slot - right.slot)
      : null;
    const ordered = order
      ? order.map((entry) => entry.triangle)
      : (isBelt
        ? [...triangles].sort((left, right) =>
          Number(isSideFace(left[0].normal)) - Number(isSideFace(right[0].normal)))
        : triangles);

    out += `\no ${partName(part)}\n`;
    const flat = ordered.flat();
    for (const vertex of flat) {
      out += `v ${vertex.position.map((n) => n.toFixed(6)).join(' ')}\n`;
      for (let axis = 0; axis < 3; axis += 1) {
        bounds.min[axis] = Math.min(bounds.min[axis], vertex.position[axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], vertex.position[axis]);
      }
    }
    // A part with no texture coordinates writes none, and its faces leave the
    // slot empty -- `v//vn`, which is the OBJ spelling for "normals but no
    // texture". The loader then hands back a geometry with no `uv`, which is
    // what `_generateMissingTankUVs` looks for.
    const textured = flat[0].texcoord !== null;
    if (textured) {
      for (const vertex of flat) out += `vt ${uvOf(vertex).map((n) => n.toFixed(6)).join(' ')}\n`;
    }
    for (const vertex of flat) out += `vn ${vertex.normal.map((n) => n.toFixed(6)).join(' ')}\n`;

    let material = null;
    for (let i = 0; i < ordered.length; i += 1) {
      const wanted = order
        ? WHEEL_MATERIALS[order[i].slot]
        : (isBelt
          ? (isSideFace(ordered[i][0].normal) ? TREAD_SIDE_MATERIAL : TREAD_MATERIAL)
          : null);
      if (wanted && wanted !== material) {
        material = wanted;
        out += `usemtl ${material}\n`;
      }
      const v = vOffset + (i * 3) + 1;
      const vt = vtOffset + (i * 3) + 1;
      const corner = (o) => (textured
        ? `${v + o}/${vt + o}/${v + o}`
        : `${v + o}//${v + o}`);
      out += `f ${corner(0)} ${corner(1)} ${corner(2)}\n`;
    }
    vOffset += flat.length;
    if (textured) vtOffset += flat.length;
  }

  return { out, bounds, vOffset };
}

for (const [label, files] of Object.entries(LODS)) {
  const parts = {};
  for (const [part, file] of Object.entries(files)) parts[part] = readPart(file);

  if (label === 'treads') {
    // How many of bzo's tread tiles go round upstream's belt. Upstream lays
    // exactly one copy of its own texture round it; bzo's links are smaller,
    // and this keeps them the size they are on every other tank.
    const tiles = Math.max(1, Math.round(TREAD.treadLength / TREAD_UNITS_PER_TILE));
    // Upstream's own division counts, from `divisionLevels` at its highest
    // quality: 32 round the belt and 16 round a wheel.
    const TREAD_DIVS = 32;
    const WHEEL_DIVS = 16;
    // The hull is closed before the casing plates are added to it. The plates
    // are flat quads with no thickness, so their rim reads as a hole, and
    // capping one would only lay a second quad on top of the first.
    parts.body = [...parts.body, ...capBoundaryLoops(parts.body)];
    parts.body = [
      ...parts.body,
      ...buildCasing(+TREAD.treadYCenter),
      ...buildCasing(-TREAD.treadYCenter),
    ];
    parts.barrel = barrelToPipe(parts.barrel) || parts.barrel;
    parts.ltread = buildTread(+TREAD.treadYCenter, TREAD_DIVS, tiles);
    parts.rtread = buildTread(-TREAD.treadYCenter, TREAD_DIVS, tiles);
    for (let wheel = 0; wheel < 4; wheel += 1) {
      const along = TREAD.wheelSpacing * (-1.5 + wheel);
      parts[`leftWheel${wheel + 1}`] = buildWheel(
        [along, +TREAD.treadYCenter, TREAD.treadRadius], 0, WHEEL_DIVS, { mirrored: true },
      );
      parts[`rightWheel${wheel + 1}`] = buildWheel(
        [along, -TREAD.treadYCenter, TREAD.treadRadius], 0, WHEEL_DIVS,
      );
    }
  }
  // Every part a solid in its own right, because an explosion takes the tank
  // apart and throws the pieces: each is then seen from every side, including
  // the one that used to face another part. The treads variant has already had
  // its hull done above, before its casing plates went on.
  for (const part of ['body', 'turret', 'barrel']) {
    if (!parts[part]) continue;
    if (label === 'treads' && (part === 'body' || part === 'barrel')) continue;
    parts[part] = [...parts[part], ...capBoundaryLoops(parts[part])];
  }

  const { out, bounds, vOffset } = buildObj(parts, label);

  // The nav lights bzo hangs on every tank. Upstream draws these from
  // TankSceneNode rather than from the model, so there is nothing to extract
  // and they are placed here -- resting on the deck in their own column, which
  // is what test-tank-models.mjs measures. A light sunk into the hull is
  // depth-tested away and one floating over it reads as detached.
  const CLEARANCE = 0.03;
  const surfaceUnder = (x, z) => {
    let best = null;
    for (const triangle of Object.values(parts).flat()) {
      const [a, b, c] = triangle.map((vertex) => vertex.position);
      // Barycentric containment in the XZ plane, then the plane's height there.
      const d = ((b[2] - c[2]) * (a[0] - c[0])) + ((c[0] - b[0]) * (a[2] - c[2]));
      if (Math.abs(d) < 1e-9) continue;
      const u = (((b[2] - c[2]) * (x - c[0])) + ((c[0] - b[0]) * (z - c[2]))) / d;
      const v = (((c[2] - a[2]) * (x - c[0])) + ((a[0] - c[0]) * (z - c[2]))) / d;
      const w = 1 - u - v;
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
      const y = (u * a[1]) + (v * b[1]) + (w * c[1]);
      if (best === null || y > best) best = y;
    }
    return best;
  };

  let text = out;
  text += '\n# Navigation lights. One `p` vertex each, read by the renderer for its\n';
  text += '# position only; see docs/tank-model-format.md.\n';
  const light = (name, x, z) => {
    const surface = surfaceUnder(x, z);
    if (surface === null) throw new Error(`${label}: ${name} at ${x},${z} is over empty space`);
    const y = surface + CLEARANCE;
    text += `\no ${name}\nv ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\np -1\n`;
  };
  // The same placement the generated tanks use, against this tank's own
  // turret: all three belong on the turret, not on the hull beside it.
  const partBounds = new Map(Object.entries(parts).map(([part, triangles]) => {
    const positions = triangles.flat().map((vertex) => vertex.position);
    return [PART_NAMES[part], {
      min: [0, 1, 2].map((axis) => Math.min(...positions.map((p) => p[axis]))),
      max: [0, 1, 2].map((axis) => Math.max(...positions.map((p) => p[axis]))),
    }];
  }));
  const navLights = navLightPositions(partBounds);
  const surfaceTriangles = Object.values(parts).flat().flat().map((v) => v.position);
  for (const [name, spot] of Object.entries(navLights)) {
    const [lx, lz] = navLightSpot(surfaceTriangles, spot, partBounds.get('turret'));
    light(name, lx, lz);
  }

  // The treads tank is the stock one, `bzflag.obj`; the levels of detail are
  // named for their level.
  const path = resolve(__dirname, `../public/obj/${label === 'treads' ? 'bzflag' : `bzflag-${label}`}.obj`);
  writeFileSync(path, `${text}\n`, 'utf-8');
  const size = bounds.max.map((max, axis) => (max - bounds.min[axis]).toFixed(2));
  console.log(`${label}: ${vOffset} vertices, ${vOffset / 3} triangles, `
    + `w ${size[0]} h ${size[1]} len ${size[2]} -> ${path}`);
}
