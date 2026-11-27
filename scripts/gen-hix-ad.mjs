#!/usr/bin/env node
// Builds data/maps/hix_ad.bzw: HiX's layout in the night-time, line-lit look of
// KTL's Delirious City. Collision geometry is maps/hix.bzw's own, recoloured;
// everything that glows is a decorative drawInfo mesh generated here --
// obstacle outlines, circuit traces, ripples, spirographs, Maurer roses,
// string-art curtains, a turning hyperboloid crown and stars.
//
//   node scripts/gen-hix-ad.mjs
//
// Edit this script or hix.bzw, then re-run it; never edit the output by hand.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parseBZWMap, seededRandom } = require(join(root, 'server/bzw-parse.cjs'));

const HIX = join(root, 'maps/hix.bzw');
const OUT = join(root, 'data/maps/hix_ad.bzw');
const GRADIENT = 'http://images.bzflag.org/kktl/horizontal_gradient_blue_begin_red_and_transparant_end.png';
const GROUND_Z = 0.04;
const MAP_EDGE = 400;

const random = seededRandom(0xdc415);
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- vectors

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => (a[0] * b[0]) + (a[1] * b[1]) + (a[2] * b[2]);
const length = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => { const l = length(a) || 1; return scale(a, 1 / l); };
const rotateZ = ([x, y, z], angle) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [(x * c) - (y * s), (x * s) + (y * c), z];
};

// Newell's method: a polygon's unit normal, whatever its vertex count.
function faceNormal(points) {
  const n = [0, 0, 0];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize(n);
}

const fmt = (n) => {
  const s = (Math.abs(n) < 5e-5 ? 0 : n).toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
};

// ------------------------------------------------------------ hix's solids

const decode = (b64, Type) => new Type(Uint8Array.from(Buffer.from(b64, 'base64')).buffer);

// Every solid as world-space polygons, so one crease finder outlines boxes,
// pyramids and meshes alike.
function solidFaces(obs) {
  // A teleporter's frame, as bzo and upstream draw it: two posts and a
  // crossbar, `border` thick, round the opening -- one U-shaped prism.
  if (obs.kind === 'teleporter') {
    const [x, y, z] = obs.pos;
    const [, H, top] = obs.size;
    const B = obs.border;
    const half = B / 2;
    const outline = [[-H, 0], [-H + B, 0], [-H + B, top - B], [H - B, top - B], [H - B, 0], [H, 0], [H, top], [-H, top]];
    const at = (px, py, pz) => {
      const q = rotateZ([px, py, 0], obs.angle);
      return [x + q[0], y + q[1], z + pz];
    };
    const front = outline.map(([py, pz]) => at(half, py, pz));
    const back = outline.map(([py, pz]) => at(-half, py, pz));
    const faces = [front, [...back].reverse()];
    for (let i = 0; i < outline.length; i += 1) {
      const j = (i + 1) % outline.length;
      faces.push([front[j], front[i], back[i], back[j]]);
    }
    return faces;
  }
  if (obs.type === 'box') {
    const [x, y, z] = obs.pos;
    const [sx, sy, h] = obs.size;
    const ring = [[sx, sy], [-sx, sy], [-sx, -sy], [sx, -sy]]
      .map(([px, py]) => rotateZ([px, py, 0], obs.angle));
    const lo = ring.map((p) => [x + p[0], y + p[1], z]);
    const hi = ring.map((p) => [x + p[0], y + p[1], z + h]);
    const faces = [hi, [...lo].reverse()];
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4;
      faces.push([lo[i], lo[j], hi[j], hi[i]]);
    }
    return faces;
  }
  if (obs.type === 'pyramid') {
    const [x, y, z] = obs.pos;
    const [sx, sy, h] = obs.size;
    const baseZ = obs.inverted ? z + h : z;
    const apex = [x, y, obs.inverted ? z : z + h];
    const base = [[sx, sy], [-sx, sy], [-sx, -sy], [sx, -sy]]
      .map(([px, py]) => rotateZ([px, py, 0], obs.angle))
      .map((p) => [x + p[0], y + p[1], baseZ]);
    const faces = [obs.inverted ? base : [...base].reverse()];
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4;
      faces.push(obs.inverted ? [base[j], base[i], apex] : [base[i], base[j], apex]);
    }
    return faces;
  }
  if (obs.type === 'mesh') {
    const a = obs.arrays;
    const vertices = decode(a.vertices, Float32Array);
    const starts = decode(a.faceStart, Int32Array);
    const corners = decode(a.corners, Int32Array);
    const faces = [];
    for (let f = 0; f + 1 < starts.length; f += 1) {
      const face = [];
      for (let c = starts[f]; c < starts[f + 1]; c += 1) {
        const v = corners[c] * 3;
        face.push([vertices[v], vertices[v + 1], vertices[v + 2]]);
      }
      if (face.length >= 3) faces.push(face);
    }
    return faces;
  }
  return [];
}

// How far an outline stands off each face: Delirious City's own 0.09.
const OUTLINE_GAP = 0.09;

// Cramer's rule for a 3x3 system.
function solve3(m, r) {
  const det = (a) => (a[0][0] * ((a[1][1] * a[2][2]) - (a[1][2] * a[2][1])))
    - (a[0][1] * ((a[1][0] * a[2][2]) - (a[1][2] * a[2][0])))
    + (a[0][2] * ((a[1][0] * a[2][1]) - (a[1][1] * a[2][0])));
  const d = det(m);
  return [0, 1, 2].map((c) => det(m.map((row, i) => row.map((x, j) => (j === c ? r[i] : x)))) / d);
}

// The edges a viewer reads as the map's shape, taken across every solid at
// once: a face two solids share (a walkway's mitre cut against the bridge it
// meets) is inside and dropped, and an edge is drawn only where the faces
// meeting on it bend, or where it has one face. A seam between two coplanar
// decks is no edge. Each corner is moved to stand OUTLINE_GAP off every face
// meeting there, so it draws in front of the faces rather than fighting their
// depth, and every edge into a corner ends on the same point.
// Each edge comes back with the solid that owns it, for its colour.
function creaseEdges(solidsFaces) {
  const key = (p) => p.map((n) => n.toFixed(3)).join(',');
  const faceKey = (face) => face.map(key).sort().join('|');
  const faceOwners = new Map();
  for (const { owner, faces } of solidsFaces) {
    for (const face of faces) {
      const k = faceKey(face);
      faceOwners.set(k, (faceOwners.get(k) || new Set()).add(owner));
    }
  }
  const edges = new Map();
  const cornerNormals = new Map();
  for (const { owner, faces } of solidsFaces) {
    for (const face of faces) {
      if (faceOwners.get(faceKey(face)).size > 1) continue;
      const normal = faceNormal(face);
      for (let i = 0; i < face.length; i += 1) {
        const a = face[i];
        const b = face[(i + 1) % face.length];
        const ka = key(a);
        const kb = key(b);
        let normals = cornerNormals.get(ka);
        if (!normals) cornerNormals.set(ka, normals = []);
        if (!normals.some((n) => dot(n, normal) > 0.999)) normals.push(normal);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        let edge = edges.get(k);
        if (!edge) edges.set(k, edge = { a, b, owner, normals: [] });
        edge.normals.push(normal);
      }
    }
  }
  // The corner that stands OUTLINE_GAP off every face meeting there: the
  // least-squares solution of n . v = gap over its normals, with a whisker of
  // ridge so two faces (an edge, not a corner) take the shortest such v. A
  // knife-sharp corner would fly off, so the step is held to a few gaps.
  const lift = (p) => {
    const normals = cornerNormals.get(key(p));
    const m = [[1e-6, 0, 0], [0, 1e-6, 0], [0, 0, 1e-6]];
    const r = [0, 0, 0];
    for (const n of normals) {
      for (let i = 0; i < 3; i += 1) {
        r[i] += n[i] * OUTLINE_GAP;
        for (let j = 0; j < 3; j += 1) m[i][j] += n[i] * n[j];
      }
    }
    let v = solve3(m, r);
    if (length(v) > OUTLINE_GAP * 4) v = scale(normalize(v), OUTLINE_GAP * 4);
    const q = add(p, v);
    if (p[2] < 0.01) q[2] = Math.max(q[2], GROUND_Z);
    return q;
  };
  const out = [];
  for (const edge of edges.values()) {
    const [n1] = edge.normals;
    if (edge.normals.length > 1 && edge.normals.every((n) => dot(n1, n) > 0.999)) continue;
    out.push({ owner: edge.owner, points: [lift(edge.a), lift(edge.b)] });
  }
  return out;
}

// 2D footprints of whatever stands on the ground, for routing traces round.
function footprint(obs) {
  const points = solidFaces(obs).flat().filter((p) => p[2] < 1).map((p) => [p[0], p[1]]);
  if (points.length < 3) return null;
  points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => ((a[0] - o[0]) * (b[1] - o[1])) - ((a[1] - o[1]) * (b[0] - o[0]));
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...points].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function nearPolygon(p, poly, margin) {
  let inside = true;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const side = (ex * (p[1] - a[1])) - (ey * (p[0] - a[0]));
    if (side < 0) inside = false;
    const t = Math.max(0, Math.min(1, (((p[0] - a[0]) * ex) + ((p[1] - a[1]) * ey)) / ((ex * ex) + (ey * ey))));
    const dx = p[0] - (a[0] + (t * ex));
    const dy = p[1] - (a[1] + (t * ey));
    if ((dx * dx) + (dy * dy) < margin * margin) return true;
  }
  return inside;
}

// --------------------------------------------------------- mesh emission

// One line mesh: a vertex pool and a drawInfo whose every command is lines,
// line loops, line strips or points -- nothing that collides, unless solid
// faces are added with face().
class LineMesh {
  constructor(name) {
    this.name = name;
    this.vertices = [];
    this.texcoords = [];
    this.sets = new Map();
    this.faces = [];
    this.angvel = 0;
  }

  // A solid face: it collides, but with a drawInfo present only the lines
  // are drawn, so it stands there unseen.
  face(points) {
    this.faces.push(points.map((p) => this.vertex(p)));
  }

  vertex(p, u = 0) {
    this.vertices.push(p);
    this.texcoords.push(u);
    return this.vertices.length - 1;
  }

  command(material, mode, points, uOf = null) {
    if (!this.sets.has(material)) this.sets.set(material, []);
    const indices = points.map((p, i) => this.vertex(p, uOf ? uOf(i) : 0));
    this.sets.get(material).push(`${mode} ${indices.join(' ')}`);
  }

  // A polyline whose texcoord u runs with its own length, so a scrolling
  // gradient flows along it.
  strip(material, points, unitsPerTile) {
    let run = 0;
    const us = points.map((p, i) => {
      if (i > 0) run += length(sub(p, points[i - 1]));
      return run / unitsPerTile;
    });
    this.command(material, 'linestrip', points, (i) => us[i]);
  }

  toBzw() {
    if (this.vertices.length === 0) return '';
    if (this.vertices.length > 65535) throw new Error(`${this.name}: ${this.vertices.length} vertices`);
    const lines = ['mesh', `  name ${this.name}`];
    if (this.faces.length === 0) lines.push('  decorative', '  passable');
    for (const v of this.vertices) lines.push(`  vertex ${v.map(fmt).join(' ')}`);
    lines.push('  normal 0 0 1');
    for (const u of this.texcoords) lines.push(`  texcoord ${fmt(u)} 0.5`);
    for (const f of this.faces) lines.push('  face', `    vertices ${f.join(' ')}`, '  endface');
    lines.push('  drawinfo');
    if (this.angvel) lines.push(`    angvel ${fmt(this.angvel)}`);
    for (let i = 0; i < this.vertices.length; i += 1) lines.push(`    corner ${i} 0 ${i}`);
    lines.push('    lod', '      lengthPerPixel 0');
    for (const [material, commands] of this.sets) {
      lines.push(`      matref ${material}`);
      for (const c of commands) lines.push(`        ${c}`);
      lines.push('      end');
    }
    lines.push('    end', '  end', 'end', '');
    return lines.join('\n');
  }
}

// ----------------------------------------------------- shared definitions

const blocks = [];
const block = (text) => blocks.push(text.replace(/^\n/, ''));

// A colour that walks the colour wheel once per `period` seconds, starting
// `offset` seconds in: three full-range cosines a third of a turn apart.
function wheel(name, period, offset) {
  const lines = ['dynamicColor', `  name ${name}`];
  ['red', 'green', 'blue'].forEach((channel, i) => {
    lines.push(`  ${channel} sinusoid ${fmt(period)} ${fmt(offset + ((i * period) / 3))} 1`);
  });
  lines.push('end', '');
  block(lines.join('\n'));
}

function lineMaterial(name, body) {
  block(`material\n  name ${name}\n${body}\n  nolighting\n  noshadow\n  noradar\nend\n`);
}

// ------------------------------------------------------------------- build

const hix = readFileSync(HIX, 'utf8');
const world = parseBZWMap(HIX, { quiet: true, text: hix });
const solids = world.obstacles;
const centre = (o) => [(o.bounds.minX + o.bounds.maxX) / 2, (o.bounds.minY + o.bounds.maxY) / 2];

// Obstacle outlines. The map is cut into eight sectors round the middle, each
// one a step further round the same colour wheel, so the hue sweeps round the
// arena once every EDGE_PERIOD seconds. The tower in the middle burns gold;
// a base outlines in its own team's colour.
const EDGE_PERIOD = 10;
const SECTORS = 8;
for (let k = 0; k < SECTORS; k += 1) {
  wheel(`edge${k}`, EDGE_PERIOD, (k * EDGE_PERIOD) / SECTORS);
  lineMaterial(`edge${k}`, `  dyncol edge${k}`);
}
block(`dynamicColor
  name core
  red limits 1 1
  green limits 0.45 0.85
  green sinusoid 3 0 1
  blue limits 0 0.2
  blue sinusoid 3 0 1
end
`);
lineMaterial('core', '  dyncol core');
const TEAM_RGB = { 1: [1, 0.15, 0.1], 2: [0.1, 1, 0.2], 3: [0.15, 0.35, 1], 4: [0.85, 0.2, 1] };
for (const [team, rgb] of Object.entries(TEAM_RGB)) {
  block(`dynamicColor
  name team${team}
${['red', 'green', 'blue'].map((c, i) => `  ${c} limits ${fmt(rgb[i] * 0.35)} ${fmt(rgb[i])}\n  ${c} sinusoid 2 0 1`).join('\n')}
end
`);
  lineMaterial(`team${team}`, `  dyncol team${team}`);
}

const edgeMeshes = Array.from({ length: SECTORS }, (_, k) => new LineMesh(`ad_edges_${k}`));
const coreMesh = new LineMesh('ad_edges_core');
const outlineOf = (obs) => {
  const [cx, cy] = centre(obs);
  if (obs.kind === 'base') return [coreMesh, `team${obs.team}`];
  if (Math.hypot(cx, cy) < 15) return [coreMesh, 'core'];
  const k = Math.floor((((Math.atan2(cy, cx) / TAU) + 1 + (0.5 / SECTORS)) % 1) * SECTORS);
  return [edgeMeshes[k], `edge${k}`];
};
const outlines = new Map();
for (const { owner, points } of creaseEdges(solids.map((obs) => ({ owner: obs, faces: solidFaces(obs) })))) {
  if (!outlines.has(owner)) outlines.set(owner, []);
  outlines.get(owner).push(...points);
}
for (const [obs, points] of outlines) {
  const [mesh, material] = outlineOf(obs);
  mesh.command(material, 'lines', points);
}

// Ripples: concentric octagons round Top of the World, lined up with it. Six
// materials pulse in turn, so a ring of light spreads outward every second
// and a half.
const RIPPLE_PHASES = 6;
const RIPPLE_PERIOD = 1.5;
for (let k = 0; k < RIPPLE_PHASES; k += 1) {
  block(`dynamicColor
  name ripple${k}
  red limits 0.05 0.5
  red sinusoid ${RIPPLE_PERIOD} ${fmt((k * RIPPLE_PERIOD) / RIPPLE_PHASES)} 1.6
  green limits 0.1 1
  green sinusoid ${RIPPLE_PERIOD} ${fmt((k * RIPPLE_PERIOD) / RIPPLE_PHASES)} 1.6
  blue limits 0.25 1
  blue sinusoid ${RIPPLE_PERIOD} ${fmt((k * RIPPLE_PERIOD) / RIPPLE_PHASES)} 1.6
end
`);
  lineMaterial(`ripple${k}`, `  dyncol ripple${k}`);
}
const ripples = new LineMesh('ad_ripples');
const octagon = (cx, cy, r, z, spin = -Math.PI / 8) => Array.from({ length: 8 }, (_, i) => {
  const a = spin + ((i * TAU) / 8);
  return [cx + (r * Math.cos(a)), cy + (r * Math.sin(a)), z];
});
for (let ring = 0, r = 14; r <= 134; ring += 1, r += 8) {
  ripples.command(`ripple${ring % RIPPLE_PHASES}`, 'lineloop', octagon(0, 0, r, GROUND_Z));
}

// Spirographs: two eight-lobed hypotrochoids round the foot of each octagon
// tower, the second turned half a lobe and coloured the other way round.
wheel('spiroA', 14, 0);
wheel('spiroB', 14, 7);
lineMaterial('spiroA', '  dyncol spiroA');
lineMaterial('spiroB', '  dyncol spiroB');
const spiros = new LineMesh('ad_spirographs');
const towers = solids.filter((o) => /(^|:)oct$/.test(o.name));
for (const tower of towers) {
  const [cx, cy] = centre(tower);
  ['spiroA', 'spiroB'].forEach((material, i) => {
    const R = 8;
    const r = 3;
    const d = 1.5;
    const size = 6.5;
    const twist = (i * Math.PI) / 8;
    const steps = 480;
    const points = [];
    for (let s = 0; s <= steps; s += 1) {
      const t = (s / steps) * TAU * 3;
      const p = [
        ((R - r) * Math.cos(t)) + (d * Math.cos(((R - r) / r) * t)),
        ((R - r) * Math.sin(t)) - (d * Math.sin(((R - r) / r) * t)),
        0,
      ];
      const q = rotateZ(scale(p, size), twist);
      points.push([cx + q[0], cy + q[1], GROUND_Z]);
    }
    spiros.command(material, 'linestrip', points);
  });
}

// Maurer roses under each raised base, in the team's colour: the rose
// r = sin(6θ) visited 71 degrees at a time.
const roses = new LineMesh('ad_roses');
for (const base of world.obstacles.filter((o) => o.kind === 'base')) {
  const [cx, cy] = centre(base);
  const points = [];
  for (let i = 0; i <= 360; i += 1) {
    const theta = (i * 71 * Math.PI) / 180;
    const r = 40 * Math.sin(6 * theta);
    const p = rotateZ([r * Math.cos(theta), r * Math.sin(theta), 0], base.angle);
    points.push([cx + p[0], cy + p[1], GROUND_Z]);
  }
  roses.command(`team${base.team}`, 'linestrip', points);
}

// Circuit traces: random walks on a square grid, turning only at right
// angles, out from the ripples and all over the board, routed round every
// footprint and round the other patterns, each ending on a via. A scrolling
// gradient sends pulses along them at eight speeds, two of them running
// backwards, so the current never marches in step. Grown in the east quarter
// and turned to the other three.
const PULSES = [-0.45, -0.7, -1, -1.4, -1.9, -2.6, 0.8, 1.6].map((speed, i) => [`trace${i}`, speed]);
PULSES.forEach(([name, speed], i) => {
  block(`textureMatrix\n  name ${name}\n  shift ${fmt(speed)} 0\n  fixedshift ${fmt(i / PULSES.length)} 0\nend\n`);
  lineMaterial(name, `  texture ${GRADIENT}\n  texmat ${name}`);
});
// Cyan, not white: a white dot on the floor reads as a flag at a distance.
block(`dynamicColor
  name via
  red limits 0 0
  green limits 0.6 1
  green clampup 0.8 0 0.12
  blue limits 1 1
end
`);
lineMaterial('via', '  dyncol via');

const footprints = solids.map(footprint).filter(Boolean);
const keepOut = [
  ...towers.map((t) => [...centre(t), 46]),
  ...world.obstacles.filter((o) => o.kind === 'base').map((b) => [...centre(b), 44]),
];
const GRID = 6;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const used = new Set();
const cell = (p) => `${Math.round(p[0] / (GRID / 2))},${Math.round(p[1] / (GRID / 2))}`;
const inEast = (p) => p[0] > Math.abs(p[1]) + 2;
function open(p) {
  if (!inEast(p) || Math.hypot(p[0], p[1]) < 142) return false;
  if (Math.abs(p[0]) > 382 || Math.abs(p[1]) > 382) return false;
  if (used.has(cell(p))) return false;
  if (keepOut.some(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) < r)) return false;
  return !footprints.some((poly) => nearPolygon(p, poly, 3));
}
function segmentOpen(a, b) {
  for (let s = 0.25; s <= 1.0001; s += 0.25) {
    if (!open([a[0] + ((b[0] - a[0]) * s), a[1] + ((b[1] - a[1]) * s)])) return false;
  }
  return true;
}
function grow(start, dir) {
  if (!open(start)) return null;
  const path = [start];
  used.add(cell(start));
  for (let step = 0; step < 48; step += 1) {
    const turn = random() < 0.3 ? (random() < 0.5 ? 1 : 3) : 0;
    const tries = [(dir + turn) % 4, dir, (dir + 1) % 4, (dir + 3) % 4];
    let moved = false;
    for (const d of tries) {
      const [dx, dy] = DIRS[d];
      const p = path.at(-1);
      const next = [p[0] + (dx * GRID), p[1] + (dy * GRID)];
      if (!segmentOpen(p, next)) continue;
      for (let s = 0.5; s <= 1; s += 0.5) used.add(cell([p[0] + ((next[0] - p[0]) * s), p[1] + ((next[1] - p[1]) * s)]));
      path.push(next);
      dir = d;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  if (path.length < 6) return null;
  // One vertex per corner, not per grid step.
  return path.filter((p, i) => i === 0 || i === path.length - 1
    || (p[0] - path[i - 1][0]) * (path[i + 1][1] - p[1]) !== (p[1] - path[i - 1][1]) * (path[i + 1][0] - p[0]));
}
const quarterTraces = [];
for (let attempt = 0; attempt < 900 && quarterTraces.length < 80; attempt += 1) {
  const fromRipple = attempt < 120;
  const angle = (random() - 0.5) * (Math.PI / 2.2);
  const r = fromRipple ? 144 + (random() * 10) : 150 + (random() * 230);
  const start = [Math.round((r * Math.cos(angle)) / GRID) * GRID, Math.round((r * Math.sin(angle)) / GRID) * GRID];
  const path = grow(start, fromRipple ? 0 : Math.floor(random() * 4));
  if (path) quarterTraces.push(path);
}
const traces = [0, 1, 2, 3].map((q) => new LineMesh(`ad_traces_${q}`));
quarterTraces.forEach((path, i) => {
  for (let q = 0; q < 4; q += 1) {
    const turn = (q * Math.PI) / 2;
    const points = path.map(([x, y]) => rotateZ([x, y, GROUND_Z], turn));
    traces[q].strip(PULSES[i % PULSES.length][0], points, 10);
    const end = points.at(-1);
    traces[q].command('via', 'lineloop', octagon(end[0], end[1], 1.4, GROUND_Z, 0));
  }
});

// Curtains along the map edge, under the edge walkway: curve-stitched panels,
// each a four-pointed star of parabolic envelopes, alternating panels one
// colour behind the other.
wheel('curtainA', 18, 0);
wheel('curtainB', 18, 6);
lineMaterial('curtainA', '  dyncol curtainA');
lineMaterial('curtainB', '  dyncol curtainB');
const curtains = new LineMesh('ad_curtains');
const PANELS = 18;
const STITCHES = 7;
const CURTAIN_TOP = 28.7;
const CURTAIN_X = MAP_EDGE - 0.4;
const SPAN = 372;
for (let side = 0; side < 4; side += 1) {
  const turn = (side * Math.PI) / 2;
  const at = (y, z) => rotateZ([CURTAIN_X, y, z], turn);
  const width = (2 * SPAN) / PANELS;
  for (let p = 0; p < PANELS; p += 1) {
    const y0 = -SPAN + (p * width);
    const y1 = y0 + width;
    const material = p % 2 ? 'curtainB' : 'curtainA';
    const segs = [];
    const corners = [[y0, GROUND_Z, 1, 1], [y1, GROUND_Z, -1, 1], [y0, CURTAIN_TOP, 1, -1], [y1, CURTAIN_TOP, -1, -1]];
    for (const [cy, cz, dy, dz] of corners) {
      for (let i = 1; i <= STITCHES; i += 1) {
        const along = (i / (STITCHES + 1)) * (width / 2);
        const up = ((STITCHES + 1 - i) / (STITCHES + 1)) * ((CURTAIN_TOP - GROUND_Z) / 2);
        segs.push(at(cy + (dy * along), cz), at(cy, cz + (dz * up)));
      }
    }
    segs.push(at(y0, GROUND_Z), at(y1, GROUND_Z), at(y0, CURTAIN_TOP), at(y1, CURTAIN_TOP));
    curtains.command(material, 'lines', segs);
  }
}

// The world's edge, as Delirious City draws its own: the stock walls are
// gone (`_wallHeight 0`) and a slab stands outside each side in their place,
// tall enough that nothing jumps it, drawn as nothing but two rails above
// the edge walkway.
const wall = new LineMesh('ad_boundary');
const WALL_TOP = 120;
for (let side = 0; side < 4; side += 1) {
  const turn = (side * Math.PI) / 2;
  const at = (x, y, z) => rotateZ([x, y, z], turn);
  const e = MAP_EDGE;
  const o = MAP_EDGE + 2;
  const w = MAP_EDGE + 2;
  const inner = [at(e, w, 0), at(e, -w, 0), at(e, -w, WALL_TOP), at(e, w, WALL_TOP)];
  const outer = [at(o, -w, 0), at(o, w, 0), at(o, w, WALL_TOP), at(o, -w, WALL_TOP)];
  wall.face(inner);
  wall.face(outer);
  wall.face([inner[3], inner[2], outer[3], outer[2]]);
  wall.face([outer[0], outer[1], inner[0], inner[1]].reverse());
  wall.face([inner[1], outer[0], outer[3], inner[2]]);
  wall.face([outer[1], inner[0], inner[3], outer[2]]);
  for (const z of [32, 34.5]) {
    wall.command('curtainA', 'lines', [at(CURTAIN_X, -MAP_EDGE, z), at(CURTAIN_X, MAP_EDGE, z)]);
  }
}

// The sky: a hyperboloid crown over the middle, both families of its ruling
// lines strung between two rings, turning slowly; and a dome of stars from
// horizon to horizon.
block(`dynamicColor
  name crownA
  red limits 0.1 0.3
  green limits 0.5 1
  green sinusoid 7 0 1
  blue limits 1 1
end
`);
block(`dynamicColor
  name crownB
  red limits 0.8 1
  green limits 0.1 0.4
  green sinusoid 7 3.5 1
  blue limits 0.6 1
end
`);
lineMaterial('crownA', '  dyncol crownA');
lineMaterial('crownB', '  dyncol crownB');
const crown = new LineMesh('ad_crown');
crown.angvel = 2;
// The lower lip level with Top of the World's roof deck.
const CROWN_LIP = world.obstacles.find((o) => o.name === 'totw').bounds.maxZ;
const CROWN_IN = [200, CROWN_LIP];
const CROWN_OUT = [200, CROWN_LIP + 70];
const STRINGS = 64;
const ringPoint = ([r, z], a) => [r * Math.cos(a), r * Math.sin(a), z];
const ringAt = (ring) => Array.from({ length: STRINGS + 1 }, (_, i) => ringPoint(ring, (i * TAU) / STRINGS));
crown.command('crownA', 'linestrip', ringAt(CROWN_IN));
crown.command('crownA', 'linestrip', ringAt(CROWN_OUT));
for (const [material, twist] of [['crownA', 0.375], ['crownB', -0.375]]) {
  const segs = [];
  for (let i = 0; i < STRINGS; i += 1) {
    const a = (i * TAU) / STRINGS;
    segs.push(ringPoint(CROWN_IN, a), ringPoint(CROWN_OUT, a + (twist * TAU)));
  }
  crown.command(material, 'lines', segs);
}

// The stars are dealt at random into a dozen groups, interlaced across the
// whole sky, each group fading in and out in its own colour and at its own
// pace.
const dome = (azimuth, elevation, r) => [
  r * Math.cos(elevation) * Math.cos(azimuth),
  r * Math.cos(elevation) * Math.sin(azimuth),
  r * Math.sin(elevation),
];
const randomElevation = () => Math.asin(0.005 + (random() * 0.99));
const STAR_GROUPS = 12;
const starGroups = Array.from({ length: STAR_GROUPS }, (_, k) => {
  const hue = random() * TAU;
  const rgb = [0, 1, 2].map((c) => 0.55 + (0.45 * Math.cos(hue - ((c * TAU) / 3))));
  const period = 5 + (random() * 9);
  block(`dynamicColor
  name star${k}
${['red', 'green', 'blue'].map((c, i) => `  ${c} limits 0.03 ${fmt(rgb[i])}\n  ${c} sinusoid ${fmt(period)} ${fmt(random() * period)} 1.4`).join('\n')}
end
`);
  lineMaterial(`star${k}`, `  dyncol star${k}`);
  return [];
});
const stars = new LineMesh('ad_stars');
// 620 encloses the map's corners (566 out) and, seen from one corner, keeps
// the far horizon (566 + 620) inside upstream's far plane, 1.5 world sizes.
for (let i = 0; i < 2400; i += 1) {
  starGroups[i % STAR_GROUPS].push(dome(random() * TAU, randomElevation(), 620));
}
starGroups.forEach((points, k) => stars.command(`star${k}`, 'points', points));

// ------------------------------------------------------------ hix, relit

let base = hix;
const swap = (from, to) => {
  if (!base.includes(from)) throw new Error(`hix.bzw no longer has: ${from.split('\n')[0]}`);
  base = base.replace(from, to);
};
const materialBlock = (name) => new RegExp(`material\\n  name ${name}\\n[\\s\\S]*?\\nend\\n`);
const swapMaterial = (name, body) => {
  const re = materialBlock(name);
  if (!re.test(base)) throw new Error(`hix.bzw no longer has material ${name}`);
  base = base.replace(re, `material\n  name ${name}\n${body}\nend\n`);
};

// hix's comments explain its own look, not this one.
base = base.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n').replace(/\n{3,}/g, '\n\n');
base = base.replace(/metadata\n[\s\S]*?endmetadata\n/, `metadata
  title HiX After Dark
  version 1
  author Tim Riker <timriker@gmail.com>
  created 2026-11-24
  license AGPL-3.0-only
  description HiX's team play layout, drawn in glowing lines under a night sky.
  note Layout from HiX; look after KTL's Delirious City, with patterns of its own.
endmetadata
`);
swap('world\n  name HiX 3.0\n', 'world\n  name HiX After Dark\n');
swap(`  -sa
end
`, `  -sa
  # Night: a black sky with nothing in it, and no shadows, so the lines
  # carry the whole picture.
  -set _skyColor black
  -set _drawCelestial 0
  -set _drawClouds 0
  -set _drawMountains 0
  -set _noShadows 1
  # The world's edge is a mesh of its own, drawn as lines.
  -set _wallHeight 0
end
`);
// hix's own textures, tinted almost to black: surfaces read as surfaces, and
// the lines still carry the picture.
const tint = (name, rgb) => {
  const re = materialBlock(name);
  if (!re.test(base)) throw new Error(`hix.bzw no longer has material ${name}`);
  base = base.replace(re, (m) => m.replace(/\nend\n$/, `\n  color ${rgb}\nend\n`));
};
tint('industrial', '0.1 0.1 0.22');
tint('strut', '0.06 0.16 0.2');
tint('concrete', '0.14 0.08 0.22');
tint('GroundMaterial', '0.06 0.06 0.12');
swapMaterial('seethrough', `  addtexture http://images.bzflag.org/gbratley/Spazzy%20McGee_fence-barbs.png
  color 0.3 0.85 1
  alphathresh 0.05`);
swapMaterial('cautiontape', '  addtexture caution\n  texmat cautionCrawl\n  dyncol hazard');
swap('  edge texture pyrwall\n  bottom texture roof\n', '  edge matref concrete\n  bottom matref industrial\n');
swap(`material
  name cautiontape`, `dynamicColor
  name hazard
  red limits 1 1
  green limits 0.1 0.8
  green sinusoid 5 0 1
  blue limits 0 0.9
  blue sinusoid 5 2.5 1
end

material
  name cautiontape`);

const meshes = [...edgeMeshes, coreMesh, ripples, spiros, roses, ...traces, curtains, wall, crown, stars];
const header = `# HiX After Dark -- generated by scripts/gen-hix-ad.mjs from maps/hix.bzw.
# Edit those and re-run the script; changes made here are lost.
`;
const output = [
  header + base.trimEnd(),
  '',
  '# ---------------------------------------------------------------- the glow',
  '',
  ...blocks,
  ...meshes.map((m) => m.toBzw()).filter(Boolean),
].join('\n');
writeFileSync(OUT, output);
const total = meshes.reduce((n, m) => n + m.vertices.length, 0);
console.log(`${OUT}: ${total} line vertices in ${meshes.length} meshes, ${quarterTraces.length * 4} traces`);
