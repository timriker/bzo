/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A `.bzw` file read into the world bzo serves: the parser and the pure
// helpers it is built from. Its own module so a map can be converted on a
// worker thread (`server/map-convert-worker.cjs`) as well as in the server.
// The two things it needs from the server it is given (`configureBzwParse`).

const { BZDB_CONFIG_VARS, bzdbIsTrue, evalBzdb, gameplayFromBzdb, parseColorString, worldConfig } = require('./bzdb.cjs');
const { encodeMeshArrays, meshArrays, meshDrawArrays } = require('./mesh-arrays.cjs');
const { getObstacleHeight } = require('./collision.cjs');

// Everything here is built in upstream's own frame, the one a `.bzw` is
// written in: +Z up, +Y north, x east, an angle counter-clockwise about +Z.
const crypto = require('crypto');
const { parseBZWTeamMode, getTeamFromColorIndex } = require('./teams.cjs');
const { normalizeShotSlotCount, WORLD_WEAPON_DEFAULT_DELAY, normalizeWorldWeaponDelays } = require('./shots.cjs');
const { FLAG_ABBREVIATIONS, normalizeShakeTimeout, normalizeShakeWins, getFlagType, isBadFlag, isTeamFlag } = require('./flags.cjs');
const fs = require('fs');
const mapOverview = require('./map-overview.cjs');
const path = require('path');

// Where the parser's own log lines go, and the server's config defaults it
// reads a map's options against.
let log = () => {};
let GAME_CONFIG_DEFAULTS = {};
function configureBzwParse(options) {
  if (options.log) log = options.log;
  if (options.gameConfigDefaults) GAME_CONFIG_DEFAULTS = options.gameConfigDefaults;
}

// Top-level BZW keywords a real map may use that bzo does not read at all --
// not a passability keyword inside a box, a zone keyword, or anything else
// already partially supported, but whole obstacle/animation types with no bzo
// equivalent yet (docs/bzw.md is the full account of what is and is not
// read). None of these ever set `current`/`currentLink`/`currentZone`/
// `currentWeapon`, so their own inner lines already fall through the rest of
// parseBZWMap's dispatch untouched -- this only has to recognize the
// *opening* keyword to say how many of each a map asked for.
// `WorldInfo::makeWaterMaterial`'s own texture matrix (`WorldInfo.cxx:150-153`):
// `texmat->setDynamicShift(0.05f, 0.0f)`, a scroll along U alone, forever --
// `TextureMatrix::update`'s `ushf = fmod(t * uShiftFreq, 1.0)` is the same
// continuous cycle `applyTextureMatrix` in `render.js` already ports for every
// other `texmat` reference. Shared rather than rebuilt per map: nothing ever
// mutates the object itself, only replaces a `currentWaterLevel.textureMatrix`
// reference that pointed at it (a `texmat` line on the block does that, the
// same as any other material property overriding this default).
const DEFAULT_WATER_TEXTURE_MATRIX = Object.freeze({
  name: 'WaterMaterial',
  fixedShiftU: 0, fixedShiftV: 0, fixedScaleU: 1, fixedScaleV: 1, fixedSpin: 0,
  fixedCenterU: 0.5, fixedCenterV: 0.5,
  shiftU: 0.05, shiftV: 0, spin: 0, scaleUFreq: 0, scaleVFreq: 0,
  scaleU: 1, scaleV: 1, centerU: 0.5, centerV: 0.5,
});

const UNSUPPORTED_TOP_LEVEL_KEYWORDS = new Set([
  'transform',
]);

// Material keywords bzo reads and deliberately drops, because none of them
// can change what a real bzflag client draws either -- see
// `applyBzwMaterialToken` for the reason behind each. Inside a `material`
// block, a mesh or one of the mesh primitives that helper already consumes
// them; this set is how a plain `box` or `pyramid` (whose own branch reads
// only the handful of properties bzo's box model has a place for) reaches
// the same answer instead of reporting them as gaps it does not have.
const BZW_INERT_MATERIAL_KEYWORDS = new Set([
  'ambient', 'groupalpha', 'noculling',
  // `BzMaterial` parses and stores these three, and nothing in the whole
  // upstream tree ever reads them back -- `getShader`/`getShaderCount` have
  // no caller outside `BzMaterial` itself, confirmed by grep. Dead in a real
  // bzflag client, so dead here.
  'shader', 'addshader', 'noshaders',
]);

// `MeshTransform` (`src/game/MeshTransform.cxx`), the `shift`/`scale`/
// `shear`/`spin` sequence a `mesh` block states about itself. Upstream reads
// them in `WorldFileLocation::read` (`:95-135`) as an ordered list rather
// than as four independent settings, and `MeshTransform::Tool` folds that
// list into one 4x4 as it walks it -- so two `spin`s about different axes,
// or a `scale` before and after a `shift`, all mean what reading them in
// order says they mean. Ported here rather than approximated, because unlike
// a box (whose `shift`/`spin` bzo maps onto `position`/`rotation`, see
// docs/bzw.md "Groups") a mesh is a bag of arbitrary points: every one of
// these has an exact answer on it, including the `shear` and the off-vertical
// `spin` that have no place in bzo's axis-aligned box model.
//
// The matrix works on the map's own axes, the same frame every point here
// is already in, so the matrix and the map text agree axis for axis.

// `multiply` (`MeshTransform.cxx:154-168`), which composes the new transform
// on the *left*: after `m = multiply(m, t)` the accumulated matrix applies
// `t` last, so a vertex sees the list in the order the map wrote it.
function multiplyMeshTransform(m, n) {
  const t = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      t[i][j] = (m[0][j] * n[i][0]) + (m[1][j] * n[i][1])
        + (m[2][j] * n[i][2]) + (m[3][j] * n[i][3]);
    }
  }
  return t;
}

const MESH_TRANSFORM_IDENTITY = [
  [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
];

// `shift`/`scale`/`shear`/`spin` (`MeshTransform.cxx:169-236`), each as the
// 4x4 upstream multiplies in. `shear`'s own off-diagonal placement is
// upstream's exactly -- it is not the symmetric shear it looks like it should
// be, and copying it rather than deriving it is the point.
function meshTransformStep(op) {
  const [a, b, c] = op.data;
  if (op.type === 'shift') {
    return [[1, 0, 0, a], [0, 1, 0, b], [0, 0, 1, c], [0, 0, 0, 1]];
  }
  if (op.type === 'scale') {
    return [[a, 0, 0, 0], [0, b, 0, 0], [0, 0, c, 0], [0, 0, 0, 1]];
  }
  if (op.type === 'shear') {
    return [[1, 0, a, 0], [0, 1, b, 0], [c, 0, 1, 0], [0, 0, 0, 1]];
  }
  // `spin <degrees> <ax> <ay> <az>` -- Rodrigues about an arbitrary axis, and
  // a zero-length axis is skipped rather than producing NaNs, same as
  // `MeshTransform.cxx:203-210`.
  const lenSq = (a * a) + (b * b) + (c * c);
  if (!(lenSq > 0)) return null;
  const inv = 1 / Math.sqrt(lenSq);
  const nx = a * inv; const ny = b * inv; const nz = c * inv;
  const radians = op.data[3];
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const icos = 1 - cos;
  return [
    [(nx * nx * icos) + cos, (nx * ny * icos) - (nz * sin), (nx * nz * icos) + (ny * sin), 0],
    [(ny * nx * icos) + (nz * sin), (ny * ny * icos) + cos, (ny * nz * icos) - (nx * sin), 0],
    [(nz * nx * icos) - (ny * sin), (nz * ny * icos) + (nx * sin), (nz * nz * icos) + cos, 0],
    [0, 0, 0, 1],
  ];
}

// `MeshTransform::Tool`'s constructor (`:242-305`): the folded vertex matrix,
// the cofactor matrix normals go through instead (so a non-uniform scale
// leaves them perpendicular), and the determinant's sign, which says whether
// the transform turned the mesh inside out and every normal has to flip.
function buildMeshTransformTool(ops) {
  if (!ops || ops.length === 0) return null;
  let vm = MESH_TRANSFORM_IDENTITY;
  for (const op of ops) {
    const step = meshTransformStep(op);
    if (step) vm = multiplyMeshTransform(vm, step);
  }
  const normalMatrix = [
    [
      (vm[1][1] * vm[2][2]) - (vm[1][2] * vm[2][1]),
      (vm[1][2] * vm[2][0]) - (vm[1][0] * vm[2][2]),
      (vm[1][0] * vm[2][1]) - (vm[1][1] * vm[2][0]),
    ],
    [
      (vm[2][1] * vm[0][2]) - (vm[2][2] * vm[0][1]),
      (vm[2][2] * vm[0][0]) - (vm[2][0] * vm[0][2]),
      (vm[2][0] * vm[0][1]) - (vm[2][1] * vm[0][0]),
    ],
    [
      (vm[0][1] * vm[1][2]) - (vm[0][2] * vm[1][1]),
      (vm[0][2] * vm[1][0]) - (vm[0][0] * vm[1][2]),
      (vm[0][0] * vm[1][1]) - (vm[0][1] * vm[1][0]),
    ],
  ];
  const determinant = (vm[0][0] * normalMatrix[0][0])
    + (vm[0][1] * normalMatrix[0][1])
    + (vm[0][2] * normalMatrix[0][2]);
  return { vertexMatrix: vm, normalMatrix, inverted: determinant < 0 };
}

// `MeshDrawInfo`'s own draw commands (`MeshDrawInfo.cxx:681-694`), each an
// OpenGL primitive over a list of *corner* indices. bzo draws polygons, so
// every surface mode is expanded here into the faces it stands for and the
// two line modes and `points` are dropped -- they describe no surface, and
// upstream's own renderer draws them as lines and points rather than as part
// of the solid (`DrawCmd::draw`).
//
// The windings are GL's, not a guess: a strip alternates so every triangle
// faces the same way, a fan pivots on its first corner, and a quad strip
// takes its four corners in the order that keeps the quad convex.
function expandMeshDrawCommand(mode, indices) {
  const polys = [];
  if (indices.length < 3) return polys;
  if (mode === 'tris') {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      polys.push([indices[i], indices[i + 1], indices[i + 2]]);
    }
  } else if (mode === 'tristrip') {
    for (let i = 0; i + 2 < indices.length; i++) {
      polys.push(i % 2 === 0
        ? [indices[i], indices[i + 1], indices[i + 2]]
        : [indices[i + 1], indices[i], indices[i + 2]]);
    }
  } else if (mode === 'trifan') {
    for (let i = 1; i + 1 < indices.length; i++) {
      polys.push([indices[0], indices[i], indices[i + 1]]);
    }
  } else if (mode === 'quads') {
    for (let i = 0; i + 3 < indices.length; i += 4) {
      polys.push([indices[i], indices[i + 1], indices[i + 2], indices[i + 3]]);
    }
  } else if (mode === 'quadstrip') {
    for (let i = 0; i + 3 < indices.length; i += 2) {
      polys.push([indices[i], indices[i + 1], indices[i + 3], indices[i + 2]]);
    }
  } else if (mode === 'polygon') {
    polys.push(indices.slice());
  }
  return polys;
}

// Every mode `setupDrawModeMap` knows, so an unrecognized word inside a draw
// set is reported rather than silently dropped.
const MESH_DRAW_MODES = new Set([
  'points', 'lines', 'lineloop', 'linestrip',
  'tris', 'tristrip', 'trifan', 'quads', 'quadstrip', 'polygon',
]);

// `WorldFileLocation::read`'s own transform lines (`:88-135`), shared by
// every block that builds a mesh of its own -- `mesh`, and the `tetra`,
// `cone`/`meshpyr`, `arc`/`meshbox` and `sphere` primitives, whose
// `writeToGroupDef` is shaped exactly like `CustomMesh`'s. Returns whether
// the token was one of them, so a caller falls through for anything else.
function readMeshTransformToken(target, token, words) {
  if (token === 'shift' || token === 'scale' || token === 'shear') {
    const [a, b, c] = words.slice(1).map(Number);
    target.transformOps.push({ type: token, data: [a || 0, b || 0, c || 0, 0] });
    return true;
  }
  if (token === 'spin') {
    const [deg, ax, ay, az] = words.slice(1).map(Number);
    target.transformOps.push({
      type: 'spin', data: [ax || 0, ay || 0, az || 0, (deg || 0) * Math.PI / 180],
    });
    return true;
  }
  return false;
}

// The folded matrix as three functions over `{x, y, z}` points: one for a
// position, one for a surface normal, one for a direction.
function meshTransformMovers(ops) {
  const tool = buildMeshTransformTool(ops);
  if (!tool) return null;
  const vm = tool.vertexMatrix;
  const nm = tool.normalMatrix;

  const movePoint = ({ x, y, z }) => ({
    x: (x * vm[0][0]) + (y * vm[0][1]) + (z * vm[0][2]) + vm[0][3],
    y: (x * vm[1][0]) + (y * vm[1][1]) + (z * vm[1][2]) + vm[1][3],
    z: (x * vm[2][0]) + (y * vm[2][1]) + (z * vm[2][2]) + vm[2][3],
  });

  // `Tool::modifyNormal` (`:380-411`) -- cofactor, renormalize, and flip on a
  // mirroring transform. A normal that collapses to zero length falls back to
  // straight up, upstream's own "dunno, going with Z" case.
  const moveNormal = ({ x, y, z }) => {
    let tx = (x * nm[0][0]) + (y * nm[0][1]) + (z * nm[0][2]);
    let ty = (x * nm[1][0]) + (y * nm[1][1]) + (z * nm[1][2]);
    let tz = (x * nm[2][0]) + (y * nm[2][1]) + (z * nm[2][2]);
    const len = Math.hypot(tx, ty, tz);
    if (len > 0) {
      tx /= len; ty /= len; tz /= len;
    } else {
      tx = 0; ty = 0; tz = 1;
    }
    if (tool.inverted) {
      tx = -tx; ty = -ty; tz = -tz;
    }
    return { x: tx, y: ty, z: tz };
  };

  // A direction carried by the matrix itself rather than as a surface normal
  // -- a spinning mesh's axis, which upstream turns with the mesh
  // (`MeshSceneNode`'s transform wrapped around `MeshDrawMgr`'s `glRotatef`).
  const moveVector = ({ x, y, z }) => ({
    x: (x * vm[0][0]) + (y * vm[0][1]) + (z * vm[0][2]),
    y: (x * vm[1][0]) + (y * vm[1][1]) + (z * vm[1][2]),
    z: (x * vm[2][0]) + (y * vm[2][1]) + (z * vm[2][2]),
  });

  return { movePoint, moveNormal, moveVector };
}

function applyMeshTransform(mesh) {
  const movers = meshTransformMovers(mesh.transformOps);
  if (!movers) return mesh;
  const { movePoint, moveNormal } = movers;
  mesh.vertices = mesh.vertices.map(movePoint);
  mesh.normals = mesh.normals.map(moveNormal);
  mesh.checkPoints = mesh.checkPoints.map((p) => ({ ...movePoint(p), inside: p.inside }));
  // A `drawInfo` block that brought pools of its own is a second copy of the
  // same surface and moves with it.
  if (mesh.drawVertices) mesh.drawVertices = mesh.drawVertices.map(movePoint);
  if (mesh.drawNormals) mesh.drawNormals = mesh.drawNormals.map(moveNormal);
  return mesh;
}

// The `BzMaterial` flags that decide how a face blends -- `nosorting`,
// `notexalpha`, `notexcolor`, read by `applyBzwMaterialToken` below -- pulled
// off any material-shaped object onto a face bound for the renderer.
// `BzMaterial::reset`'s own defaults are all "ordinary": sort translucent
// faces, and use both the texture's alpha and the material's own colour,
// which is what a material that never stated any of them reads back as here.
// `noculling` is not among them: it is read and dropped, for the reason
// `applyBzwMaterialToken` gives.
const bzwMaterialFlags = (m) => ({
  noSorting: !!m.noSorting,
  useTextureAlpha: m.useTextureAlpha !== false,
  useColorOnTexture: m.useColorOnTexture !== false,
});

// Everything a face carries off the material it names. The four generated
// meshes -- `tetra`, `cone`/`meshpyr`, `arc`/`meshbox` and `sphere` -- resolve
// a material per side and then assemble ordinary faces from it field by field,
// so a field this does not name is silently dropped on the way. A hand-written
// `mesh` face never had that problem: it starts from the mesh's own material
// and keeps what it does not overwrite. Naming the whole set in one place is
// what stops the two routes drifting apart again -- `texmat` and `dyncol` were
// dead on an `arc` while the same material animated on a `mesh` beside it, and
// the lighting properties went the same way.
const bzwFaceMaterial = (m) => ({
  texture: m.texture,
  textureUrl: m.textureUrl,
  color: m.color,
  noRadar: m.noRadar,
  noLighting: m.noLighting,
  dynamicColor: m.dynamicColor ?? null,
  textureMatrix: m.textureMatrix ?? null,
  specular: m.specular ?? null,
  emission: m.emission ?? null,
  shininess: m.shininess ?? null,
  alphaThreshold: m.alphaThreshold ?? null,
  ...bzwMaterialFlags(m),
});

// `TetraBuilding::makeMesh`'s own fixed face topology (`MeshUtils.h`'s
// `addFace` calls, `TetraBuilding.cxx:110-121`): four triangles, each
// omitting one vertex, always in this order regardless of how a mapper
// wrote the four `vertex` lines. `TetraBuilding::checkVertexOrder` swaps
// vertices 1 and 2 first (and their own face-material slots along with
// them) whenever the raw order given would make every face point inward
// instead of out -- the same cross/dot sign test, on the same axes. Module
// scope rather than nested in `parseBZWMap`: neither this nor
// `buildTetraMesh` below closes over anything of its own, and nesting a
// `const` after the line-parsing loop that can call `buildTetraMesh` mid-
// loop is a temporal-dead-zone crash waiting to happen -- module scope
// initializes once, well before `parseBZWMap` is ever called at all.
const TETRA_FACE_TOPOLOGY = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]];

function buildTetraMesh(tetra) {
  const v = tetra.vertexPositions.slice();
  const mats = tetra.faceMaterials.slice();
  const edgeA = { x: v[1].x - v[0].x, y: v[1].y - v[0].y, z: v[1].z - v[0].z };
  const edgeB = { x: v[2].x - v[0].x, y: v[2].y - v[0].y, z: v[2].z - v[0].z };
  const edgeC = { x: v[3].x - v[0].x, y: v[3].y - v[0].y, z: v[3].z - v[0].z };
  const cross = {
    x: (edgeA.y * edgeB.z) - (edgeA.z * edgeB.y),
    y: (edgeA.z * edgeB.x) - (edgeA.x * edgeB.z),
    z: (edgeA.x * edgeB.y) - (edgeA.y * edgeB.x),
  };
  const dot = (cross.x * edgeC.x) + (cross.y * edgeC.y) + (cross.z * edgeC.z);
  if (dot < 0) {
    [v[1], v[2]] = [v[2], v[1]];
    [mats[1], mats[2]] = [mats[2], mats[1]];
  }

  // Every face is solid regardless of the tetra's own `drivethrough`/
  // `shootthrough`/`ricochet` -- upstream's own `addFace` call hardcodes
  // all three false per face (`TetraBuilding.cxx:115-121`), the same way
  // `MeshUtils.h`'s shared helper always does for this shape. The whole
  // object's own passability -- set below, from the BZW keywords a
  // mapper actually wrote -- is what a tetra answers with instead,
  // exactly as `findTankObstacle`'s `if (obs.driveThrough) continue;`
  // already reads for every other obstacle type.
  const faces = TETRA_FACE_TOPOLOGY.map((vertexIndices, i) => ({
    vertexIndices, normalIndices: [], texcoordIndices: [],
    phydrv: null, noclusters: false, smoothBounce: false,
    driveThrough: false, shootThrough: false, ricochet: false,
    ...bzwFaceMaterial(mats[i]),
  }));

  const center = {
    x: (v[0].x + v[1].x + v[2].x + v[3].x) / 4,
    y: (v[0].y + v[1].y + v[2].y + v[3].y) / 4,
    z: (v[0].z + v[1].z + v[2].z + v[3].z) / 4,
  };

  return {
    type: 'mesh', name: tetra.name, definedIn: tetra.definedIn,
    vertices: v, normals: [], texcoords: [], faces,
    checkPoints: [{ ...center, inside: true }],
    phydrv: null, noclusters: false, smoothBounce: false, decorative: false,
    driveThrough: tetra.driveThrough, shootThrough: tetra.shootThrough, ricochet: tetra.ricochet,
    texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
  };
}

// `ConeObstacle::makeMesh` (ConeObstacle.cxx:86-329), ported the same way as
// `buildTetraMesh` above: every position/size/angle stays in upstream's own
// BZW terms (degrees where upstream reads degrees) through the whole
// generator, and the finished vertices/normals are only spun and shifted
// into place at the very end -- `place` below. `meshpyr` is the same generator upstream itself
// reuses (`CustomCone(true)`, `BZWReader.cxx`): 4 divisions, defaults pulled
// from BZDB's `_pyrBase`/`_pyrHeight` (4x/5x `_tankHeight`, 2.05 -- 8.2 and
// 10.25 here, since bzo has no BZDB to read them from live), and upstream
// rebuilds it at the origin with a 45-degree internal twist and a sqrt(2)
// size scale (so the circle-inscribed square lands axis-aligned) before
// spinning it out to the mapper's own `rotation` and shifting to `position`
// -- see the call site below for why this port skips that transform stack
// and gets the same shape a simpler way.
const CONE_MIN_SIZE = 1e-6;

// `_pyrBase`/`_pyrHeight` (BZDB, `4.0*_tankHeight`/`5.0*_tankHeight`,
// `_tankHeight` = 2.05) -- `meshpyr`'s own default `size` when a mapper
// gives none, same as a plain `pyramid`'s.
const MESHPYR_DEFAULT_BASE = 4.0 * 2.05;

const MESHPYR_DEFAULT_HEIGHT = 5.0 * 2.05;

function buildConeMesh(cone) {
  const rawSize = cone.extent;
  // `meshpyr` rebuilds with a sqrt(2)-scaled footprint (upstream's own
  // `CustomCone::writeToGroupDef` computes this `newSize` before ever
  // constructing the `ConeObstacle` that `makeMesh` below is ported from, so
  // by the time upstream's own generator math runs, this -- not the
  // mapper's own `size` -- is already all it ever sees). `z` only ever gets
  // `fabsf`'d, never scaled.
  const sz = cone.isPyramid
    ? { x: Math.abs(rawSize.x) * Math.SQRT2, y: Math.abs(rawSize.y) * Math.SQRT2, z: Math.abs(rawSize.z) }
    : { x: Math.abs(rawSize.x), y: Math.abs(rawSize.y), z: Math.abs(rawSize.z) };
  let texU = cone.texsize.u;
  let texV = cone.texsize.v;
  if (sz.x < CONE_MIN_SIZE || sz.y < CONE_MIN_SIZE || sz.z < CONE_MIN_SIZE
    || Math.abs(texU) < CONE_MIN_SIZE || Math.abs(texV) < CONE_MIN_SIZE) {
    return null;
  }

  // Ramanujan's ellipse-circumference approximation, rounded to an integral
  // tile count so the wrap seam lines up -- upstream's own comment, and its
  // own math, verbatim.
  if (texU < 0) {
    const circ = Math.PI * ((3 * (sz.x + sz.y))
      - Math.sqrt((sz.x + (3 * sz.y)) * (sz.y + (3 * sz.x))));
    texU = -Math.floor(circ / texU);
  }
  if (texV < 0) texV = -(sz.z / texV);

  // `meshpyr` also rebuilds at the origin with a fixed 45-degree twist,
  // then spins to `rotation` and shifts to `position` as a whole extra
  // transform afterward. Baking straight into world space here skips that
  // stack: generate with `rotation` already folded into the sweep's own
  // start angle (exactly like a plain `cone` always does), then shift by
  // `position` once at the end -- the same net shape, since the 45-degree
  // twist never itself reads `position` or `rotation`.
  const baseHeading = cone.isPyramid ? (Math.PI / 4) : cone.heading;

  let r = baseHeading;
  let a = cone.sweepDeg;
  if (a > 360) a = 360;
  if (a < -360) a = -360;
  a *= Math.PI / 180;
  if (a < 0) {
    r += a;
    a = -a;
  }

  if (cone.divisions <= Math.floor((a + CONE_MIN_SIZE) / Math.PI)) return null;

  const isCircle = Math.abs(Math.PI - (((a + Math.PI) % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI))
    < CONE_MIN_SIZE;

  const { divisions } = cone;
  const astep = a / divisions;

  // A flipped `meshpyr` (`flipz`, or a negative `size` height) is the same
  // shape upside down -- swapping which end sits at `position`'s own height
  // and which sits `sz.z` above it reads the same as upstream's own
  // scale-then-shift flip, without needing that transform's own ordering.
  // `flipz`/a negative height are gated to `pyramidStyle` upstream, so a
  // plain `cone` never reaches this.
  const flipped = cone.isPyramid && (cone.flipz || rawSize.z < 0);
  const ringZ = flipped ? sz.z : 0;
  const apexZ = flipped ? 0 : sz.z;

  const ringVertsLocal = [];
  const ringNormsLocal = cone.useNormals ? [] : null;
  const ringTexcoords = [];

  for (let i = 0; i <= divisions; i++) {
    const ang = r + (astep * i);
    const cosv = Math.cos(ang);
    const sinv = Math.sin(ang);
    if (!isCircle || i !== divisions) {
      ringVertsLocal.push({ x: cosv * sz.x, y: sinv * sz.y, z: ringZ });
      if (cone.useNormals) {
        let nx = cosv / sz.x;
        let ny = sinv / sz.y;
        let nz = 1 / sz.z;
        const len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
        nx /= len; ny /= len; nz /= len;
        ringNormsLocal.push({ x: nx, y: ny, z: flipped ? -nz : nz });
      }
    }
    ringTexcoords.push({ u: texU * (0.5 + (0.5 * cosv)), v: texV * (0.5 + (0.5 * sinv)) });
  }

  const centralNormsLocal = [];
  if (cone.useNormals) {
    for (let i = 0; i < divisions; i++) {
      const ang = r + (astep * (0.5 + i));
      let nx = Math.cos(ang) / sz.x;
      let ny = Math.sin(ang) / sz.y;
      let nz = 1 / sz.z;
      const len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
      nx /= len; ny /= len; nz /= len;
      centralNormsLocal.push({ x: nx, y: ny, z: flipped ? -nz : nz });
    }
  }

  // Local (pre-`position`) coordinates so far. A `meshpyr`'s own `rotation`
  // never went into `baseHeading` above -- that is upstream's fixed
  // 45-degree twist -- because upstream applies the mapper's own heading as
  // a genuine second transform on top of that (`xform.addSpin(rotation,
  // zAxis)`, CustomCone.cxx, right before `xform.addShift(pos)`), the same
  // outer `MeshTransform` a `group` instance's own rotation goes through.
  // Composing that as a real transform stack is more machinery than baking
  // one more rotation into this same local-frame convention, so it lands
  // here instead: spin around the vertical axis, then shift -- a plain `cone`'s own `rotation` is already spent as `baseHeading`, so it
  // spins by nothing extra here.
  const pos = { ...cone.position };
  const spinAngle = cone.isPyramid ? cone.heading : 0;
  const cosSpin = Math.cos(spinAngle);
  const sinSpin = Math.sin(spinAngle);
  const spin = (p) => (spinAngle === 0 ? p : {
    x: (p.x * cosSpin) - (p.y * sinSpin), y: (p.x * sinSpin) + (p.y * cosSpin), z: p.z,
  });
  const place = (p) => {
    const s = spin(p);
    return { x: s.x + pos.x, y: s.y + pos.y, z: s.z + pos.z };
  };

  const vertices = ringVertsLocal.map(place);
  const vlen = vertices.length;
  const vbotIndex = vlen;
  const vtopIndex = vlen + 1;
  vertices.push(place({ x: 0, y: 0, z: ringZ }));
  vertices.push(place({ x: 0, y: 0, z: apexZ }));

  const normals = cone.useNormals
    ? ringNormsLocal.map(spin).concat(centralNormsLocal.map(spin))
    : [];

  const texcoords = ringTexcoords.slice();
  const tmidIndex = divisions + 1;
  texcoords.push({ u: texU * 0.5, v: texV * 0.5 });
  let t00Index = -1; let t10Index = -1; let t11Index = -1; let t01Index = -1;
  if (!isCircle) {
    t00Index = texcoords.length; texcoords.push({ u: 0, v: 0 });
    t10Index = texcoords.length; texcoords.push({ u: texU, v: 0 });
    t11Index = texcoords.length; texcoords.push({ u: texU, v: texV });
    t01Index = texcoords.length; texcoords.push({ u: 0, v: texV });
  }

  const faceBase = {
    phydrv: cone.phydrv, noclusters: false, smoothBounce: false,
    driveThrough: false, shootThrough: false, ricochet: false,
  };
  const matFields = bzwFaceMaterial;
  const [edgeMat, bottomMat, startMat, endMat] = cone.materials;

  // Every face below is wound the way upstream's own index math winds it,
  // which faces outward for the ordinary apex-up shape. A flipped `meshpyr`
  // swapped which physical end `ringZ`/`apexZ` sit at instead of mirroring
  // through a transform, and that swap inverts every face's own winding
  // (verified by hand: the edge face's cross product flips from
  // (+x,+y,+z)-ish to (-x,-y,+z)-ish between the two) -- swapping each
  // face's own last two corners undoes exactly that, corner-for-corner
  // across its vertex/normal/texcoord indices together.
  const pushFace = (vertexIndices, normalIndices, texcoordIndices, mat) => {
    const order = flipped ? [0, 2, 1] : [0, 1, 2];
    faces.push({
      ...faceBase,
      vertexIndices: order.map((k) => vertexIndices[k]),
      normalIndices: normalIndices.length ? order.map((k) => normalIndices[k]) : [],
      texcoordIndices: order.map((k) => texcoordIndices[k]),
      ...matFields(mat),
    });
  };

  const faces = [];
  for (let i = 0; i < divisions; i++) {
    const V = (x) => (x + i) % vlen;
    const T = (x) => x + i;
    const TI = (x) => divisions - T(x);
    pushFace(
      [vtopIndex, V(0), V(1)],
      cone.useNormals ? [vlen + i, V(0), V(1)] : [],
      [tmidIndex, T(0), T(1)],
      edgeMat,
    );
    // The bottom cap is always flat -- upstream's own shared `addFace`
    // helper never passes it a normal list regardless of `useNormals`,
    // since a flat disc has nothing for a smooth normal to interpolate.
    pushFace(
      [vbotIndex, V(1), V(0)],
      [],
      [tmidIndex, TI(1), TI(0)],
      bottomMat,
    );
  }
  if (!isCircle) {
    pushFace([vbotIndex, 0, vtopIndex], [], [t00Index, t10Index, t01Index], startMat);
    pushFace([vlen - 1, vbotIndex, vtopIndex], [], [t00Index, t10Index, t11Index], endMat);
  }

  const checkLocal = isCircle
    ? { x: 0, y: 0 }
    : { x: Math.cos(r + (0.5 * a)) * sz.x * 0.25, y: Math.sin(r + (0.5 * a)) * sz.y * 0.25 };
  const checkPoint = place({ x: checkLocal.x, y: checkLocal.y, z: (ringZ + apexZ) * 0.5 });

  return {
    type: 'mesh', name: cone.name, definedIn: cone.definedIn,
    vertices, normals, texcoords, faces,
    checkPoints: [{ ...checkPoint, inside: true }],
    phydrv: cone.phydrv, noclusters: false, smoothBounce: cone.smoothBounce, decorative: false,
    driveThrough: cone.driveThrough, shootThrough: cone.shootThrough, ricochet: cone.ricochet,
    texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
  };
}

// `ArcObstacle::makeMesh` (ArcObstacle.cxx:93-182), ported the same way as
// `buildConeMesh` above. Unlike a cone, an arc never tapers -- its cross-
// section is the same at every height -- and it has a `ratio` (0..1) between
// its inner and outer radius: `ratio=1` (the default) collapses the inner
// radius to zero, `isPie` in upstream's own terms, an ordinary solid wedge;
// anything less is a genuinely hollow tube with its own `inside` wall.
// `meshbox` is the exact same generator upstream itself reuses
// (`CustomArc(true)`, `BZWReader.cxx`): 4 divisions, defaults pulled from
// the world's `_boxBase`/`_boxHeight` (30 and `6*_muzzleHeight` = 9.42 by
// default), and upstream rebuilds it at
// the origin with a 45-degree internal twist and a sqrt(2) size scale --
// see `buildConeMesh`'s own comment for why this port folds that into the
// sweep's own start angle instead of composing upstream's transform stack.
// `checkPoints` is upstream's own aid for telling a mesh's inside from its
// outside on an arbitrary, possibly non-convex shape -- bzo's own collision
// never reads a mesh's `checkPoints` at all (every test here is per-face),
// so this keeps one simple, always-correct point rather than porting
// upstream's own six-point `CheckOutside` ring verbatim for something
// nothing downstream looks at.
const ARC_MIN_SIZE = 1e-6;

// `CustomArc.h`'s own material enum order, and the side names
// `parseMaterialsByName` matches a line's first word against.
const ARC_SIDE_NAMES = new Map([
  ['top', 0], ['bottom', 1], ['inside', 2], ['outside', 3], ['startside', 4], ['endside', 5],
]);

// A solid wedge (`ratio` collapses the inner radius to ~0) -- `ArcObstacle::
// makePie` (ArcObstacle.cxx:185-365). All in the arc's own local frame (no
// `position` yet, heading already folded into `r`); the edge ring's own
// vertices/normals/texcoords come first, then the two disc centres, matching
// upstream's own array layout exactly since the face index math below
// depends on it.
function buildArcPieLocal(a, r, h, radius, squish, texU, texV, texDiscU, texDiscV, divisions, useNormals, isCircle) {
  const astep = a / divisions;
  const ringVerts = [];
  const ringNorms = useNormals ? [] : null;
  const texcoords = [];

  for (let i = 0; i <= divisions; i++) {
    const ang = r + (astep * i);
    const cosv = Math.cos(ang);
    const sinv = Math.sin(ang);
    if (!isCircle || i !== divisions) {
      const dx = cosv * radius;
      const dy = sinv * radius * squish;
      ringVerts.push({ x: dx, y: dy, z: 0 });
      ringVerts.push({ x: dx, y: dy, z: h });
      if (useNormals) {
        let nx = cosv * squish;
        let ny = sinv;
        const len = Math.sqrt((nx * nx) + (ny * ny)) || 1;
        nx /= len; ny /= len;
        ringNorms.push({ x: nx, y: ny, z: 0 });
      }
    }
    const t0 = texU * (i / divisions);
    texcoords.push({ u: t0, v: 0 });
    texcoords.push({ u: t0, v: texV });
  }
  // The disc's own radial UV -- always from angle zero, regardless of the
  // sweep's own start angle `r`; upstream's own `astep * i`, not `r + ...`.
  for (let i = 0; i <= divisions; i++) {
    const ang = astep * i;
    texcoords.push({
      u: texDiscU * (0.5 + (0.5 * Math.cos(ang))),
      v: texDiscV * (0.5 + (0.5 * Math.sin(ang))),
    });
  }

  const vertices = ringVerts;
  const vlen = vertices.length;
  const vbotIndex = vlen;
  const vtopIndex = vlen + 1;
  vertices.push({ x: 0, y: 0, z: 0 });
  vertices.push({ x: 0, y: 0, z: h });

  const normals = useNormals ? ringNorms : [];
  const nlen = normals.length;

  const tmidIndex = texcoords.length;
  texcoords.push({ u: texDiscU * 0.5, v: texDiscV * 0.5 });

  const faces = [];
  for (let i = 0; i < divisions; i++) {
    const PV = (x) => (x + (i * 2)) % vlen;
    const PN = (x) => (x + i) % nlen;
    const PTO = (x) => x + (i * 2);
    const PTC = (x) => ((divisions + 1) * 2) + x + i;
    const PTCI = (x) => ((divisions + 1) * 3) - x - i - 1;

    faces.push({
      vertexIndices: [PV(0), PV(2), PV(3), PV(1)],
      normalIndices: useNormals ? [PN(0), PN(1), PN(1), PN(0)] : [],
      texcoordIndices: [PTO(0), PTO(2), PTO(3), PTO(1)],
      side: 3, // Outside_
    });
    faces.push({
      vertexIndices: [vtopIndex, PV(1), PV(3)],
      normalIndices: [],
      texcoordIndices: [tmidIndex, PTC(0), PTC(1)],
      side: 0, // Top
    });
    faces.push({
      vertexIndices: [vbotIndex, PV(2), PV(0)],
      normalIndices: [],
      texcoordIndices: [tmidIndex, PTCI(1), PTCI(0)],
      side: 1, // Bottom
    });
  }
  if (!isCircle) {
    const tc = divisions * 2;
    faces.push({
      vertexIndices: [vbotIndex, 0, 1, vtopIndex],
      normalIndices: [], texcoordIndices: [0, tc, tc + 1, 1], side: 4, // StartFace
    });
    const e = divisions * 2;
    faces.push({
      vertexIndices: [e, vbotIndex, vtopIndex, e + 1],
      normalIndices: [], texcoordIndices: [0, tc, tc + 1, 1], side: 5, // EndFace
    });
  }

  const checkLocal = isCircle
    ? { x: 0, y: 0 }
    : { x: Math.cos(r + (0.5 * a)) * radius * 0.5, y: Math.sin(r + (0.5 * a)) * radius * 0.5 * squish };
  return {
    vertices, normals, texcoords, faces,
    checkPoint: { x: checkLocal.x, y: checkLocal.y, z: 0.5 * h },
  };
}

// A hollow tube -- `ArcObstacle::makeRing` (ArcObstacle.cxx:368-558). Same
// local-frame convention as the pie builder above; every ring index pushes
// four vertices (inside-bottom, inside-top, outside-bottom, outside-top) and
// two normals (inside, outside) rather than the pie's two and one, and has
// no disc centre or radial UV at all -- a hollow tube's top and bottom are
// plain quads between the inside and outside walls, not a fan to a point.
function buildArcRingLocal(a, r, h, inrad, outrad, squish, texU, texV, divisions, useNormals, isCircle) {
  const astep = a / divisions;
  const vertices = [];
  const norms = useNormals ? [] : null;
  const texcoords = [];

  for (let i = 0; i <= divisions; i++) {
    const ang = r + (astep * i);
    const cosv = Math.cos(ang);
    const sinv = Math.sin(ang);
    if (!isCircle || i !== divisions) {
      const ix = cosv * inrad;
      const iy = squish * sinv * inrad;
      const ox = cosv * outrad;
      const oy = squish * sinv * outrad;
      vertices.push({ x: ix, y: iy, z: 0 });
      vertices.push({ x: ix, y: iy, z: h });
      vertices.push({ x: ox, y: oy, z: 0 });
      vertices.push({ x: ox, y: oy, z: h });
      if (useNormals) {
        let nx = -cosv * squish;
        let ny = -sinv;
        const len = Math.sqrt((nx * nx) + (ny * ny)) || 1;
        nx /= len; ny /= len;
        norms.push({ x: nx, y: ny, z: 0 });
        norms.push({ x: -nx, y: -ny, z: 0 });
      }
    }
    const t0 = texU * (i / divisions);
    texcoords.push({ u: t0, v: 0 });
    texcoords.push({ u: t0, v: texV });
  }

  const vlen = vertices.length;
  const normals = useNormals ? norms : [];
  const nlen = normals.length;

  const faces = [];
  for (let i = 0; i < divisions; i++) {
    const RV = (x) => (x + (i * 4)) % vlen;
    const RN = (x) => (x + (i * 2)) % nlen;
    const RT = (x) => x + (i * 2);
    const RIT = (x) => ((divisions + (x % 2)) * 2) - (x + (i * 2));

    faces.push({
      vertexIndices: [RV(4), RV(0), RV(1), RV(5)],
      normalIndices: useNormals ? [RN(2), RN(0), RN(0), RN(2)] : [],
      texcoordIndices: [RIT(2), RIT(0), RIT(1), RIT(3)],
      side: 2, // Inside
    });
    faces.push({
      vertexIndices: [RV(2), RV(6), RV(7), RV(3)],
      normalIndices: useNormals ? [RN(1), RN(3), RN(3), RN(1)] : [],
      texcoordIndices: [RT(0), RT(2), RT(3), RT(1)],
      side: 3, // Outside_
    });
    faces.push({
      vertexIndices: [RV(3), RV(7), RV(5), RV(1)],
      normalIndices: [],
      texcoordIndices: [RT(0), RT(2), RT(3), RT(1)],
      side: 0, // Top
    });
    faces.push({
      vertexIndices: [RV(0), RV(4), RV(6), RV(2)],
      normalIndices: [],
      texcoordIndices: [RT(0), RT(2), RT(3), RT(1)],
      side: 1, // Bottom
    });
  }
  if (!isCircle) {
    const tc = divisions * 2;
    faces.push({
      vertexIndices: [0, 2, 3, 1],
      normalIndices: [], texcoordIndices: [0, tc, tc + 1, 1], side: 4, // StartFace
    });
    const e = divisions * 4;
    faces.push({
      vertexIndices: [e + 2, e, e + 1, e + 3],
      normalIndices: [], texcoordIndices: [0, tc, tc + 1, 1], side: 5, // EndFace
    });
  }

  const midAng = isCircle ? r : (r + (0.5 * a));
  const midRad = (inrad + outrad) * 0.5;
  return {
    vertices, normals, texcoords, faces,
    checkPoint: { x: Math.cos(midAng) * midRad, y: Math.sin(midAng) * midRad * squish, z: 0.5 * h },
  };
}

function buildArcMesh(arc) {
  const rawSize = arc.extent;
  const sz = arc.isBox
    ? { x: Math.abs(rawSize.x) * Math.SQRT2, y: Math.abs(rawSize.y) * Math.SQRT2, z: Math.abs(rawSize.z) }
    : { x: Math.abs(rawSize.x), y: Math.abs(rawSize.y), z: Math.abs(rawSize.z) };

  let texU = arc.texsize.u;
  let texV = arc.texsize.v;
  let texDiscU = arc.texsize.du;
  let texDiscV = arc.texsize.dv;
  if (sz.x < ARC_MIN_SIZE || sz.y < ARC_MIN_SIZE || sz.z < ARC_MIN_SIZE
    || Math.abs(texU) < ARC_MIN_SIZE || Math.abs(texV) < ARC_MIN_SIZE
    || Math.abs(texDiscU) < ARC_MIN_SIZE || Math.abs(texDiscV) < ARC_MIN_SIZE
    || arc.ratio < 0 || arc.ratio > 1) {
    return null;
  }

  if (texU < 0) {
    const circ = Math.PI * ((3 * (sz.x + sz.y))
      - Math.sqrt((sz.x + (3 * sz.y)) * (sz.y + (3 * sz.x))));
    texU = -Math.floor(circ / texU);
  }
  if (texV < 0) texV = -(sz.z / texV);

  const baseHeading = arc.isBox ? (Math.PI / 4) : arc.heading;
  let r = baseHeading;
  let a = arc.sweepDeg;
  if (a > 360) a = 360;
  if (a < -360) a = -360;
  a *= Math.PI / 180;
  if (a < 0) {
    r += a;
    a = -a;
  }
  if (arc.divisions <= Math.floor((a + ARC_MIN_SIZE) / Math.PI)) return null;
  const isCircle = Math.abs(Math.PI - (((a + Math.PI) % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI))
    < ARC_MIN_SIZE;

  let inrad = sz.x * (1 - arc.ratio);
  let outrad = sz.x;
  if (inrad > outrad) {
    const tmp = inrad;
    inrad = outrad;
    outrad = tmp;
  }
  if (outrad < ARC_MIN_SIZE || (outrad - inrad) < ARC_MIN_SIZE) return null;
  const isPie = inrad < ARC_MIN_SIZE;
  const squish = sz.y / sz.x;
  if (isPie) {
    if (texDiscU < 0) texDiscU = -((2 * outrad) / texDiscU);
    if (texDiscV < 0) texDiscV = -((2 * outrad * squish) / texDiscV);
  }

  const built = isPie
    ? buildArcPieLocal(a, r, sz.z, outrad, squish, texU, texV, texDiscU, texDiscV, arc.divisions, arc.useNormals, isCircle)
    : buildArcRingLocal(a, r, sz.z, inrad, outrad, squish, texU, texV, arc.divisions, arc.useNormals, isCircle);

  // See `buildConeMesh`'s own comment on `spinAngle` -- the same reasoning
  // applies here: a `meshbox`'s own `rotation` is upstream's own second
  // transform on top of the fixed 45-degree twist, not part of `baseHeading`.
  const pos = { ...arc.position };
  const spinAngle = arc.isBox ? arc.heading : 0;
  const cosSpin = Math.cos(spinAngle);
  const sinSpin = Math.sin(spinAngle);
  const spin = (p) => (spinAngle === 0 ? p : {
    x: (p.x * cosSpin) - (p.y * sinSpin), y: (p.x * sinSpin) + (p.y * cosSpin), z: p.z,
  });
  const place = (p) => {
    const s = spin(p);
    return { x: s.x + pos.x, y: s.y + pos.y, z: s.z + pos.z };
  };

  const vertices = built.vertices.map(place);
  const normals = built.normals.map(spin);
  const { texcoords } = built;

  const faceBase = {
    phydrv: arc.phydrv, noclusters: false, smoothBounce: false,
    driveThrough: false, shootThrough: false, ricochet: false,
  };
  const matFields = bzwFaceMaterial;
  const faces = built.faces.map(({ side, ...face }) => ({
    ...faceBase, ...face, ...matFields(arc.materials[side]),
  }));

  const checkPoint = place(built.checkPoint);

  return {
    type: 'mesh', name: arc.name, definedIn: arc.definedIn,
    vertices, normals, texcoords, faces,
    checkPoints: [{ ...checkPoint, inside: true }],
    phydrv: arc.phydrv, noclusters: false, smoothBounce: arc.smoothBounce, decorative: false,
    driveThrough: arc.driveThrough, shootThrough: arc.shootThrough, ricochet: arc.ricochet,
    texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
  };
}

// `SphereObstacle::makeMesh` (SphereObstacle.cxx:86-433), the least like any
// of the other three -- not a swept cross-section at all, but a recursive
// triangular subdivision of a quarter-sphere, mirrored four ways around
// (the `q` loop) and, for a full sphere, once more top-to-bottom (`factor`
// doubling every ring vertex except the shared equator). Ported the same
// way as the others (local frame, upstream's own variable names kept as
// close as JS allows so this can be checked against the source line for
// line), but this one earned real hand-verification before trusting it at
// all: traced `divisions=1` by hand, vertex by vertex and face by face,
// checked every one of its 8 faces against the octant it sits in, before
// ever running it -- the index math (`((k*k)+k)*2`, `ringOffset`,
// `lastStrip`/`lastCircle`) is upstream's own triangular-number recursion,
// not something to trust by inspection alone. The fuzz sweep afterward
// (see the `cone`/`arc` entries above for the method) is what actually
// confirms it across every `divisions` this hand trace didn't cover.
const SPHERE_MIN_SIZE = 1e-6;

const SPHERE_SIDE_NAMES = new Map([['edge', 0], ['bottom', 1]]);

function buildSphereMesh(sphere) {
  const factor = sphere.hemisphere ? 1 : 2;
  const sz = {
    x: Math.abs(sphere.extent.x), y: Math.abs(sphere.extent.y), z: Math.abs(sphere.extent.z),
  };
  let texU = sphere.texsize.u;
  let texV = sphere.texsize.v;
  if (texU < 0) {
    const circ = Math.PI * ((3 * (sz.x + sz.y))
      - Math.sqrt((sz.x + (3 * sz.y)) * (sz.y + (3 * sz.x))));
    texU = -Math.floor(circ / texU);
  }
  if (texV < 0) texV = -((2 * sz.z) / texV);

  const { divisions } = sphere;
  if (divisions < 1 || Math.abs(texU) < SPHERE_MIN_SIZE || Math.abs(texV) < SPHERE_MIN_SIZE
    || sz.x < SPHERE_MIN_SIZE || sz.y < SPHERE_MIN_SIZE || sz.z < SPHERE_MIN_SIZE) {
    return null;
  }

  const r = sphere.heading;
  const { useNormals, hemisphere } = sphere;
  const vertices = [];
  const normals = useNormals ? [] : null;
  const texcoords = [];

  vertices.push({ x: 0, y: 0, z: sz.z });
  if (!hemisphere) vertices.push({ x: 0, y: 0, z: -sz.z });
  if (useNormals) {
    normals.push({ x: 0, y: 0, z: 1 });
    if (!hemisphere) normals.push({ x: 0, y: 0, z: -1 });
  }
  texcoords.push({ u: 0.5, v: 1.0 });
  if (!hemisphere) texcoords.push({ u: 0.5, v: 0.0 });

  for (let i = 0; i < divisions; i++) {
    const ringCount = 4 * (i + 1);
    for (let j = 0; j < ringCount; j++) {
      const hAngle = (((2 * Math.PI) * j) / ringCount) + r;
      const vAngle = ((Math.PI / 2) * (divisions - i - 1)) / divisions;
      const cosV = Math.cos(vAngle);
      const ux = Math.cos(hAngle) * cosV;
      const uy = Math.sin(hAngle) * cosV;
      const uz = Math.sin(vAngle);
      vertices.push({ x: sz.x * ux, y: sz.y * uy, z: sz.z * uz });

      let nx = 0; let ny = 0; let nz = 0;
      if (useNormals) {
        nx = ux / sz.x; ny = uy / sz.y; nz = uz / sz.z;
        const len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
        nx /= len; ny /= len; nz /= len;
        normals.push({ x: nx, y: ny, z: nz });
      }

      let vFrac = (divisions - i - 1) / divisions;
      if (!hemisphere) vFrac = 0.5 + (0.5 * vFrac);
      const scaledV = vFrac * texV;
      texcoords.push({ u: (j / ringCount) * texU, v: scaledV });

      if (!hemisphere && i !== divisions - 1) {
        vertices.push({ x: sz.x * ux, y: sz.y * uy, z: -sz.z * uz });
        if (useNormals) normals.push({ x: nx, y: ny, z: -nz });
        texcoords.push({ u: (j / ringCount) * texU, v: texV - scaledV });
      }
    }
  }

  // The closing strip -- one more texcoord per ring (and the two poles) for
  // the seam where `j` wraps from the last position back to zero, needing
  // U at the *far* edge (`texU`) rather than wrapping back to the near one.
  const texStripOffset = texcoords.length;
  texcoords.push({ u: texU * 0.5, v: texV });
  if (!hemisphere) texcoords.push({ u: texU * 0.5, v: 0 });
  for (let i = 0; i < divisions; i++) {
    let vFrac = (divisions - i - 1) / divisions;
    if (!hemisphere) vFrac = 0.5 + (0.5 * vFrac);
    const scaledV = texV * vFrac;
    texcoords.push({ u: texU, v: scaledV });
    if (!hemisphere && i !== divisions - 1) {
      texcoords.push({ u: texU, v: texV - scaledV });
    }
  }

  // A hemisphere's own flat bottom cap, textured like a cone/arc's disc.
  const bottomTexOffset = texcoords.length;
  if (hemisphere) {
    const astep = (2 * Math.PI) / (divisions * 4);
    for (let i = 0; i < divisions * 4; i++) {
      const ang = astep * i;
      texcoords.push({
        u: texU * (0.5 + (0.5 * Math.cos(ang))), v: texV * (0.5 + (0.5 * Math.sin(ang))),
      });
    }
  }

  const faces = [];
  const kLast = divisions - 1;
  const ringOffset = hemisphere ? 0 : 1 + (((kLast * kLast) + kLast) * 2);

  for (let q = 0; q < 4; q++) {
    for (let i = 0; i < divisions; i++) {
      for (let j = 0; j < i + 1; j++) {
        const lastStrip = q === 3 && j === i;
        const lastCircle = i === divisions - 1;

        let a;
        if (i > 0) {
          const k = i - 1;
          a = lastStrip
            ? 1 + (((k * k) + k) * 2)
            : 1 + (((k * k) + k) * 2) + (q * (k + 1)) + j;
        } else {
          a = 0;
        }
        let b = 1 + (((i * i) + i) * 2) + (q * (i + 1)) + j;
        let c = lastStrip ? 1 + (((i * i) + i) * 2) : b + 1;
        const kNext = i + 1;
        let d = 1 + (((kNext * kNext) + kNext) * 2) + (q * (kNext + 1)) + (j + 1);

        a *= factor;
        if (!lastCircle) {
          b *= factor;
          c *= factor;
        } else {
          b += ringOffset;
          c += ringOffset;
        }
        if (i !== divisions - 2) d *= factor;
        else d += ringOffset;

        let ta;
        let tc;
        if (!lastStrip) {
          ta = a;
          tc = c;
        } else {
          ta = texStripOffset + (i * factor);
          tc = texStripOffset + ((i + 1) * factor);
        }

        faces.push({ vertexIndices: [a, b, c], normalIndices: useNormals ? [a, b, c] : [], texcoordIndices: [ta, b, tc], side: 0 });
        if (!lastCircle) {
          faces.push({ vertexIndices: [b, d, c], normalIndices: useNormals ? [b, d, c] : [], texcoordIndices: [b, d, tc], side: 0 });
        }

        if (!hemisphere) {
          a += 1;
          ta += 1;
          if (!lastCircle) {
            b += 1;
            c += 1;
            tc += 1;
          }
          if (i !== divisions - 2) d += 1;
          faces.push({ vertexIndices: [a, c, b], normalIndices: useNormals ? [a, c, b] : [], texcoordIndices: [ta, tc, b], side: 0 });
          if (!lastCircle) {
            faces.push({ vertexIndices: [b, c, d], normalIndices: useNormals ? [b, c, d] : [], texcoordIndices: [b, tc, d], side: 0 });
          }
        }
      }
    }
  }

  if (hemisphere) {
    const offset = 1 + (((kLast * kLast) + kLast) * 2);
    const discVertexIndices = [];
    const discTexcoordIndices = [];
    for (let i = 0; i < divisions * 4; i++) {
      const vv = (divisions * 4) - i - 1;
      discVertexIndices.push(vv + offset);
      discTexcoordIndices.push(i + bottomTexOffset);
    }
    faces.push({
      vertexIndices: discVertexIndices, normalIndices: [], texcoordIndices: discTexcoordIndices, side: 1,
    });
  }

  const pos = { ...sphere.position };
  const place = (p) => ({ x: p.x + pos.x, y: p.y + pos.y, z: p.z + pos.z });

  const outVertices = vertices.map(place);
  const outNormals = useNormals ? normals : [];

  const faceBase = {
    phydrv: sphere.phydrv, noclusters: false, smoothBounce: false,
    driveThrough: false, shootThrough: false, ricochet: false,
  };
  const matFields = bzwFaceMaterial;
  const outFaces = faces.map(({ side, ...face }) => ({
    ...faceBase, ...face, ...matFields(sphere.materials[side]),
  }));

  const checkLocal = { x: 0, y: 0, z: hemisphere ? 0.5 * sz.z : 0 };
  const checkPoint = place(checkLocal);

  return {
    type: 'mesh', name: sphere.name, definedIn: sphere.definedIn,
    vertices: outVertices, normals: outNormals, texcoords, faces: outFaces,
    checkPoints: [{ ...checkPoint, inside: true }],
    phydrv: sphere.phydrv, noclusters: false, smoothBounce: sphere.smoothBounce, decorative: false,
    driveThrough: sphere.driveThrough, shootThrough: sphere.shootThrough, ricochet: sphere.ricochet,
    texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
  };
}

// `_rainType` (`WeatherRenderer.cxx`): the preset names upstream recognizes.
// bzo picks one rendering path per effects-menu.md's rule -- textured, spun or
// billboarded, roof-culled and puddled -- and builds every preset on it rather
// than porting `doLineRain`'s plain streaks, so "rain" gets the same textured
// look as "fatrain" rather than upstream's `GL_LINES` streak. See "Weather" in
// docs/bzw.md.


const WEATHER_RAIN_TYPES = new Set(['rain', 'snow', 'fatrain', 'frog', 'particle', 'bubble']);

// The single-value `_rain*` variables bzo's weather reads. Mapped to the `weather` field bzo's own JSON
// uses, not upstream's BZDB name, since the client never reads a BZDB var.
const WEATHER_RAIN_NUMERIC_VARS = new Map([
  ['_rainDensity', 'density'],
  ['_rainSpread', 'spread'],
  ['_rainSpeed', 'speed'],
  ['_rainSpeedMod', 'speedMod'],
  ['_rainStartZ', 'startZ'],
  ['_rainEndZ', 'endZ'],
  ['_rainMaxPuddleTime', 'maxPuddleTime'],
  ['_rainPuddleSpeed', 'puddleSpeed'],
  ['_rainRoofs', 'roofs'],
]);

// Options in a map's `options` block that `parseBZWTeamMode`
// (server/teams.cjs) reads rather than `parseBZWServerOptions` below. Kept so
// the unread-option tally does not report an option bzo does in fact act on;
// `test-team-mode.mjs` holds it to what that parser really claims.
const TEAM_MODE_OPTIONS = new Set(['-c', '-offa', '-rabbit', '-autoTeam', '-mp']);

function parseBZWServerOptions(lines) {
  let inOptions = false;
  // Every other field is left absent unless the map names it. `forbiddenFlags`
  // is the exception because `-f` may appear any number of times, and an empty
  // list says the same thing as no list.
  const options = {
    // Server options in the map's own `options` block that no test above
    // claims, by option, so a map says which of its settings bzo ignored.
    unreadOptions: new Map(),
    forbiddenFlags: [], requiredFlagCounts: {}, unreadBZDBVars: [], serverMessages: [], adMessages: [], gameplay: {},
  };
  // Every `-set`, in order, so a value may be a formula over the others and
  // upstream's defaults -- `12*_muzzleHeight` -- evaluated as BZDB evaluates
  // one (`evalBzdb`).
  const setVars = new Map();
  const evalSet = (name) => evalBzdb(setVars, name);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!inOptions) {
      if (line === 'options') inOptions = true;
      continue;
    }
    if (line === 'end') {
      inOptions = false;
      continue;
    }
    const [option, value, rawSetValue] = line.split(/\s+/);
    // `-set <name> "<value>"`: upstream has world variables whose value is a
    // list (`_ambientLight` and the other colours), and a remote import
    // writes those back out quoted rather than dropping them. Nothing else in
    // this block takes a quoted value, so the quotes are unwrapped here and
    // every reader below sees the plain string either way.
    const quotedSetValue = option === '-set' ? line.match(/^-set\s+\S+\s+"([^"]*)"\s*$/) : null;
    const setValue = quotedSetValue ? quotedSetValue[1] : rawSetValue;
    // Each option below is tested through this, so an option no test claims
    // is an option bzo does not read -- recorded rather than passed over, the
    // same as `unreadBZDBVars` already does for a `-set` variable.
    let optionRead = false;
    const readOption = (name) => {
      if (option !== name) return false;
      optionRead = true;
      return true;
    };
    // -fb: superflags may come to rest on buildings, and may spawn on them.
    if (readOption('-fb')) options.flagsOnBuildings = true;
    // -noradar: `_radarLimit` -1, no radar for anyone (CmdLineOptions.cxx:935).
    if (readOption('-noradar')) setVars.set('_radarLimit', '-1.0');
    // -j: tanks may jump. bzo already defaults this on, so the switch only
    // matters on a server whose config has turned jumping off.
    if (readOption('-j')) options.jumping = true;
    // +r: every shot ricochets, whatever flag fired it.
    if (readOption('+r')) options.ricochet = true;
    // -st <seconds>: how long a bad flag sticks before it shakes off, and -sw
    // <kills>: how many wins shake one off. Both take a value.
    if (readOption('-st')) options.flagShakeTimeout = normalizeShakeTimeout(value);
    if (readOption('-sw')) options.flagShakeWins = normalizeShakeWins(value);
    // -sa: put an antidote flag in the world for whoever is carrying a bad one.
    if (readOption('-sa')) options.antidoteFlags = true;
    // -time <seconds>: the match clock. Upstream also reads an `h:mm:ss`
    // clock-time form; bzo does not.
    if (readOption('-time')) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) options.timeLimit = seconds;
    }
    // -timemanual: the clock above waits for /countdown rather than starting
    // on its own.
    if (readOption('-timemanual')) options.timeManualStart = true;
    // -mps <score>: ends the match the moment any player's wins minus losses
    // reaches it.
    if (readOption('-mps')) {
      const score = Number(value);
      if (Number.isFinite(score) && score > 0) options.maxPlayerScore = score;
    }
    // -mts <score>: ends the match the moment any colour team's wins minus
    // losses reaches it.
    if (readOption('-mts')) {
      const score = Number(value);
      if (Number.isFinite(score) && score > 0) options.maxTeamScore = score;
    }
    // -a <vel> <rot>: the world's acceleration limit, upstream's inertia switch.
    // The only option here that takes two values, which is why it reads
    // `setValue` as well.
    if (readOption('-a')) {
      const linear = Number(value);
      const angular = Number(setValue);
      if (Number.isFinite(linear)) options.linearAcceleration = Math.max(0, linear);
      if (Number.isFinite(angular)) options.angularAcceleration = Math.max(0, angular);
    }
    // -noTeamKills: "Players on the same team are immune to each other's shots.
    // Rogue is excepted." Friendly fire off, which upstream enforces on each
    // client in LocalPlayer::checkHit; bzo's server decides every hit, so it
    // enforces it in the one place instead.
    if (readOption('-noTeamKills')) options.noTeamKills = true;
    // -disableBots: "disallow clients from using autopilot or robots".
    if (readOption('-disableBots')) options.disableBots = true;
    // -tk: "player does not die when killing a teammate". Note which way round
    // this runs -- upstream kills a team killer *by default*, and the switch is
    // what turns that off, so `-tk` is the lenient setting rather than the
    // strict one.
    if (readOption('-tk')) options.teamKillerDies = false;
    // -ms <count>: how many shots a tank may have in the air at once. Unlike the
    // switches above this carries a value, and upstream parses a map's options
    // where `-world` sits on the command line, so the map's number simply
    // replaces whatever came before it rather than only ever raising it.
    // A count of 0 means "tanks cannot shoot" upstream; bzo has no such mode, so
    // normalizeShotSlotCount clamps it to one shot as it clamps the config.
    if (readOption('-ms')) {
      const requestedShots = Number(value);
      if (Number.isFinite(requestedShots)) {
        options.shotMaxActive = normalizeShotSlotCount(Math.round(requestedShots));
        // Also part of how this map shoots, so a Map Viewer preview reloads at
        // its rate rather than the live match's -- see `worldConfig`.
        options.gameplay.SHOT_MAX_ACTIVE = options.shotMaxActive;
      }
    }
    // -s <count>, and +s <count>: how many superflag slots the world holds,
    // upstream's numExtraFlags. The count is optional and anything that is not a
    // positive number means 16, which is upstream's own reading -- `atoi` gives 0
    // for a missing or unparseable count and 0 is turned into 16 outright, so
    // even `-s 0` is sixteen flags rather than none.
    //
    // `+s` additionally marks every slot `required`, so upstream keeps all of
    // them in the world at all times where `-s` lets a slot sit empty between
    // insertions. bzo has only the one behaviour -- a slot refills on the
    // insertion schedule -- so both spellings land in the same place.
    if (readOption('-s') || readOption('+s')) {
      const requestedFlags = Math.round(Number(value));
      options.superFlagCount = Number.isFinite(requestedFlags) && requestedFlags > 0
        ? requestedFlags
        : 16;
    }
    // +f <abbreviation|good|bad>[{count}]: flags of a type that are always in
    // the world, upstream's `flagCount` (CmdLineOptions.cxx:1635-1675) --
    // one by default, `{n}` for n, `good`/`bad` one of every type in the set.
    // Unlike a `zoneflag` they have no zone of their own, so they spawn and
    // respawn anywhere, or in a zone a `flag` line names their type in.
    // `team` and a team type ask for extra team flags, which bzo does not have.
    if (readOption('+f') && value) addRequiredFlags(value, options.requiredFlagCounts);
    // -f <abbreviation|good|bad>: take a flag type out of the pool a slot draws
    // from, upstream's flagDisallowed table. Disallows accumulate and nothing
    // puts one back, so this is a switch like the rest even though it names its
    // target.
    if (readOption('-f') && value) {
      const disallowed = value.trim().toUpperCase();
      const disallowedQuality = disallowed === 'GOOD' || disallowed === 'BAD'
        ? disallowed === 'BAD'
        : null;
      for (const abbreviation of FLAG_ABBREVIATIONS) {
        if (isTeamFlag(abbreviation)) continue;
        const matches = disallowedQuality === null
          ? abbreviation === disallowed
          : isBadFlag(abbreviation) === disallowedQuality;
        if (matches && !options.forbiddenFlags.includes(abbreviation)) {
          options.forbiddenFlags.push(abbreviation);
        }
      }
    }
    // -gndtex <name>: the map's ground texture. Upstream's own bzfs option
    // (`CmdLineOptions.cxx:785-792`) never calls `checkFromWorldFile` for
    // it, so unlike most options here it is legal both on the command line
    // and inside a map's own `options` block; it registers a material
    // literally named `GroundMaterial` holding that one texture, the same
    // name `BackgroundRenderer::setupGroundMaterials`
    // (`BackgroundRenderer.cxx:265-303`) looks up to draw the ground, and
    // the same name a mapper can write an explicit `material` block under
    // instead (resolved against `materialsByName` once the whole file is
    // read; see the `groundMaterial` build below).
    if (readOption('-gndtex') && value) options.groundTexture = value;
    // -srvmsg <text>: a line said to each player as they join. Upstream
    // accumulates every occurrence into one string separated by a literal `\n`
    // and splits it again on the way out (bzfs.cxx:2507), so a map may write
    // several lines either way -- one option each, or one option carrying `\n`.
    // The quotes a map wraps the text in are the option parser's, not the text's.
    if (readOption('-srvmsg')) {
      // Taken off the raw line rather than from the split tokens, because the
      // text's own spacing is part of it -- upstream's parseWorldOptions reads a
      // quoted argument as one token and never touches what is inside it.
      const rest = line.replace(/^\S+\s*/, '');
      const quoted = rest.match(/^"([\s\S]*)"$/);
      const text = quoted ? quoted[1] : rest;
      for (const messageLine of text.split('\\n')) options.serverMessages.push(messageLine);
    }
    // -admsg <text>: the same accumulation and `\n` splitting as -srvmsg
    // above, but said periodically to everyone already playing rather than
    // once to a player as they join (bzfs.cxx:7555-7591, every 900 seconds).
    // Upstream also takes a file-backed multi-line form (`-helpmsg`'s sibling
    // in `textChunker`); bzo has only the inline-text form, the same limit
    // `docs/bzw.md` already notes for `-helpmsg` itself.
    if (readOption('-admsg')) {
      const rest = line.replace(/^\S+\s*/, '');
      const quoted = rest.match(/^"([\s\S]*)"$/);
      const text = quoted ? quoted[1] : rest;
      for (const messageLine of text.split('\\n')) options.adMessages.push(messageLine);
    }
    // -set <variable> <value>: a BZDB assignment. bzo's world constants are
    // constants, so the only variable it can honour is one it already keeps a
    // configurable copy of. Every other name is collected and reported, because
    // a map that sets `_tankSpeed` and is quietly played at bzo's is worse than
    // a map that says so on load.
    if (readOption('-set') && value) {
      setVars.set(value, setValue ?? '');
      if (value === '_rainType') {
        // The one weather variable whose value is a preset name rather than a
        // number. Nothing here turns weather on without it -- a map that sets
        // only `_rainDensity` or another tuning variable below is read but has
        // nothing to apply it to, upstream's own `rainType`-less path being an
        // edge case not worth reproducing.
        const type = (setValue || '').trim().toLowerCase();
        if (WEATHER_RAIN_TYPES.has(type)) {
          options.weather = { ...(options.weather || {}), type };
        } else if (type && type !== 'none') {
          options.unreadBZDBVars.push(`_rainType=${setValue}`);
        }
      } else if (WEATHER_RAIN_NUMERIC_VARS.has(value)) {
        const num = evalSet(value);
        if (Number.isFinite(num)) {
          options.weather = { ...(options.weather || {}), [WEATHER_RAIN_NUMERIC_VARS.get(value)]: num };
        }
      } else if (value === '_useRainPuddles' || value === '_rainSpins') {
        // `BZDB.isTrue`'s own reading: `atoi(value) != 0`, so "true" is false
        // and only a nonzero number is true.
        const parsed = parseInt(setValue, 10);
        const truthy = Number.isFinite(parsed) && parsed !== 0;
        const field = value === '_useRainPuddles' ? 'puddles' : 'spin';
        options.weather = { ...(options.weather || {}), [field]: truthy };
      } else if (value === '_rainPuddleColor') {
        // `WeatherRenderer::set` (WeatherRenderer.cxx:322): the puddle tint,
        // over the preset's own. A colour that will not parse leaves it.
        const color = parseColorString(setValue || '');
        if (color) options.weather = { ...(options.weather || {}), puddleColor: color.slice(0, 3) };
      } else if (value === '_rainBaseColor' || value === '_rainTopColor') {
        // `WeatherRenderer::set`: the line streak's two vertex colours.
        const color = parseColorString(setValue || '');
        if (color) {
          const field = value === '_rainBaseColor' ? 'rainBaseColor' : 'rainTopColor';
          options.weather = { ...(options.weather || {}), [field]: color.slice(0, 4) };
        }
      } else if (value === '_useLineRain') {
        const parsed = parseInt(setValue, 10);
        options.weather = { ...(options.weather || {}), lineRain: Number.isFinite(parsed) && parsed !== 0 };
      } else if (value === '_rainTexture' || value === '_rainPuddleTexture') {
        const textureName = (setValue || '').trim().toLowerCase();
        if (BZW_STOCK_TEXTURES.has(textureName)) {
          const field = value === '_rainTexture' ? 'texture' : 'puddleTexture';
          options.weather = { ...(options.weather || {}), [field]: textureName };
        }
      } else if (BZDB_CONFIG_VARS.has(value)) {
        // The world's own physics. Upstream locks every one of these, which
        // means the server states them and each client obeys -- so a map that
        // names one is naming how it is meant to be driven and shot on, and
        // bzo reads it the same way it already reads `-a` and `-ms`. Kept out
        // of the flag variables next to them on purpose: those describe
        // superflags, and a Map Viewer preview has no flags in it (see
        // "Map physics" in docs/bzw.md). Read once the block is done
        // (`gameplayFromBzdb`), so a formula sees every `-set` in it, as
        // upstream's does when it is used.
      } else if (value === '_flagHeight') {
        // The same number as the `world` block's `flagHeight`, which is how
        // upstream saves it (CustomWorld.cxx:41-44); the block wins.
        const height = evalSet(value);
        if (Number.isFinite(height) && height >= 0) options.flagHeight = height;
      } else if (value === 'noWalls' || value === 'freeCtfSpawns') {
        // The `world` block's two switches, which upstream keeps as plain
        // BZDB (CustomWorld.cxx:46-49), so a `-set` of either does the same.
        options[value] = bzdbIsTrue(setValue ?? '');
      } else {
        options.unreadBZDBVars.push(value);
      }
    }

    // `parseBZWTeamMode` (server/teams.cjs) is the other reader of this same
    // block, and it owns everything about who plays on which side. An option
    // it claims is read by bzo even though nothing here claimed it, so it is
    // not a gap -- naming that list here is the price of the block having two
    // readers, and the tests hold the two in step.
    if (!optionRead && !TEAM_MODE_OPTIONS.has(option)) {
      options.unreadOptions.set(option, (options.unreadOptions.get(option) || 0) + 1);
    }
  }

  options.bzdbVars = setVars;

  return options;
}

// Parse a BZW file and convert to obstacle format
// WorldFileObstacle::read. Four bare keywords, no arguments and matched without
// regard to case as upstream's strcasecmp does, that say who an obstacle is solid
// to. `passable` is the pair of the first two together, and `ricochet` bounces
// even an ordinary shot -- upstream's third source of a bounce, after the world
// switch and the Ricochet flag.
//
// Every obstacle upstream reads inherits these, so a box, a pyramid, a base and
// a teleporter all take them, and so do bzo's.
// CustomGate's constructor defaults, as a `size` line states them: half
// width 0.56, half breadth 4.48, and a full height of 2 * _teleportHeight.
const BZW_TELEPORTER_DEFAULTS = Object.freeze({
  size: Object.freeze([0.56, 4.48, 2 * 10.08]),
  border: 2 * 0.56,
});

const BZW_PASSABILITY_KEYWORDS = new Map([
  ['drivethrough', { driveThrough: true }],
  ['shootthrough', { shootThrough: true }],
  ['passable', { driveThrough: true, shootThrough: true }],
  ['ricochet', { ricochet: true }],
]);

// `cone`/`meshpyr`'s own four material slots, in `CustomCone.h`'s own enum
// order (`Edge, Bottom, StartFace, EndFace`) -- naming one of these first on
// a line applies only to that slot (`parseMaterialsByName`); anything else
// recognized applies to all four at once (`parseMaterials`), same as a bare
// material line before a `tetra`'s first `vertex`.
const CONE_SIDE_NAMES = new Map([
  ['edge', 0], ['bottom', 1], ['startside', 2], ['endside', 3],
]);

// A material property may name the faces it applies to first, and upstream's own
// names for a box's faces are these, with `top`, `bottom`, `sides` and
// `outside` as extras over the six (CustomBox.cxx:34 and :104). bzo draws a box
// as two groups -- its four walls and its two caps -- so a selector lands on one
// of the two: the upright faces are walls and the flat ones are caps. Naming a
// single wall tints all four, which is as finely as bzo's geometry divides.
//
// Upstream's z is up where bzo's y is, so `z+` and `z-` are the caps.
const BZW_FACE_GROUPS = new Map([
  ['x+', 'walls'],
  ['x-', 'walls'],
  ['y+', 'walls'],
  ['y-', 'walls'],
  ['sides', 'walls'],
  ['outside', 'walls'],
  ['z+', 'caps'],
  ['z-', 'caps'],
  ['top', 'caps'],
  ['bottom', 'caps'],
]);

// `color`, and `diffuse` which is the same thing under the name bzflag itself
// writes (ParseMaterial.cxx:90). Three or four numbers, which is upstream's
// numeric colour (ParseColor.cxx): the fourth is alpha, read so that a map
// stating it is not turned away, and then dropped, because an obstacle bzo draws
// is opaque. Upstream also takes an X11 colour name in the same place, with an
// optional alpha (`red 0.5`), and so does this (`parseColorString`).
function parseBzwColor(words) {
  const parsed = parseColorString(words.join(' '));
  if (!parsed) return null;
  const [r, g, b, a] = parsed;
  // Alpha kept alongside RGB (rather than dropped) so a material that is
  // meant to be invisible -- `diffuse 0 0 0 0`, a common "solid for
  // collision/radar, drawn as nothing" trick -- actually renders as nothing
  // in bzo too, instead of the fully opaque black RGB-only would otherwise
  // produce (see `_buildMeshObject` in public/render.js, the one reader of
  // this fourth value).
  return [r, g, b, a === undefined ? 1 : a].map((value) => Math.max(0, Math.min(1, value)));
}

// Every stock texture name upstream's own `data/` ships an asset for --
// not just the handful `material`/`matref`/`addtexture` names most often in
// the wild (docs/bzw-plan.md's "Evidence from real maps"), because there is
// no way to predict which one a map maker reaches for. bzo runtime-colours a
// tank/shot's own grey base per team rather than shipping one file per
// colour (`loadTintedTexture`/`getBaseTeamTint`, public/texture.js) -- but a
// material block names a *file*, not a game concept, so a map that puts
// "the blue shot" on a wall as decoration needs `blue_bolt` to be a real
// picture regardless of how bzo's own shot rendering gets its colour.
// Kept in sync with `STOCK_MATERIAL_TEXTURE_FILES` in `public/texture.js`,
// which is the other half of this: this set decides what a map is *allowed*
// to name, that one decides what picture the name actually draws.
//
// A name not in this set -- anything not shipped in upstream's own `data/`,
// or an external URL a map links a texture in from -- resolves to nothing:
// no network fetch, no CORS/CSP surface, and the obstacle keeps its type's
// plain default texture.
const BZW_STOCK_TEXTURES = new Set([
  'automatic_icon', 'blend_flash', 'blue_basetop', 'blue_basewall', 'blue_bolt', 'blue_icon',
  'blue_laser', 'blue_super_bolt', 'blue_tank', 'boxwall', 'bubble', 'bzflag-256x256',
  'bzflag-48x48', 'caution', 'clouds', 'dusty_flare', 'explode1', 'explode2', 'flag', 'frog',
  'green_basetop', 'green_basewall', 'green_bolt', 'green_icon', 'green_laser',
  'green_super_bolt', 'green_tank', 'hunter_bolt', 'hunter_laser', 'hunter_super_bolt',
  'hunter_tank', 'jumpjets', 'menu_arrow', 'mesh', 'missile', 'moon', 'mountain1', 'mountain2',
  'mountain3', 'mountain4', 'mountain5', 'observer_icon', 'puddle', 'puffs', 'purple_basetop',
  'purple_basewall', 'purple_bolt', 'purple_icon', 'purple_laser', 'purple_super_bolt',
  'purple_tank', 'pyrwall', 'rabbit_bolt', 'rabbit_laser', 'rabbit_super_bolt', 'rabbit_tank',
  'radar', 'raindrop', 'red_basetop', 'red_basewall', 'red_bolt', 'red_icon', 'red_laser',
  'red_super_bolt', 'red_tank', 'rogue_bolt', 'rogue_icon', 'rogue_laser', 'rogue_super_bolt',
  'rogue_tank', 'roof', 'shot_tail', 'snowflake', 'std_ground', 'telelink', 'tetrawall', 'thief',
  'title', 'treads', 'wall', 'water', 'zone_ground',
]);

// A texture name as a `material`/`addtexture`/`texture` line states it --
// upstream's own bare stock name, or a mapper's own file name or URL -- down
// to whichever of bzo's local assets it might match: no path, no extension,
// case-folded, the way upstream's TextureManager itself keys textures by name.
function resolveBzwStockTexture(rawName) {
  if (!rawName) return null;
  const bare = rawName.trim().split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  return BZW_STOCK_TEXTURES.has(bare) ? bare : null;
}

// An absolute `http`/`https` URL, the other thing a real map's `addtexture`
// names (docs/bzw-plan.md's "Evidence from real maps" found exactly one:
// `http://images.bzflag.org/astevens/pine.png`). This is a syntax check
// only -- the server never fetches it, upstream's `ftp` is dropped since no
// browser still fetches it for an image, and whether the picture actually
// *loads* is `isExternalTextureUrlLoadable` in `public/texture.js`, a
// separate decision made in the browser rather than here (every host is
// attempted; see that file for why), so bzo's own server is never the one
// making an outbound request on a mapper's say-so.
function parseBzwTextureUrl(rawName) {
  if (!rawName) return null;
  // A protocol-relative URL (`//host/path`) has no scheme of its own to
  // validate here -- only the browser that eventually loads it has a page
  // to resolve one against, so this borrows a throwaway scheme just to
  // confirm the rest still parses as a real URL, and forwards the original
  // protocol-relative string rather than the resolved one. Each connected
  // client re-resolves it against its own `window.location.href`
  // (`isExternalTextureUrlLoadable`, public/texture.js), which is what lets
  // the same map serve `http://` on a plain local server and `https://` on
  // one that terminates TLS, from the one line a mapper wrote.
  if (rawName.startsWith('//')) {
    try {
      return new URL(`https:${rawName}`).host ? rawName : null;
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(rawName);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Real bzflag's own downloader needs a literal scheme to parse a texture
    // URL at all (a mapper-written `//host/path` line, confirmed earlier,
    // fails there outright) -- but confirmed directly against a real client
    // that it only reliably follows `http://`, not `https://`, so a `.bzw`
    // file should write `http://` for a mapper-hosted texture from here on.
    // bzo's own browser clients would then hit mixed-content blocking
    // loading `http://` from an `https://` page (bz.rikers.org, most
    // notably), so this strips the scheme down to protocol-relative before
    // forwarding -- exactly the form a mapper-written `//host/path` line
    // already takes above, and each client already re-resolves against its
    // own page's protocol (`isExternalTextureUrlLoadable`, public/texture.js).
    return rawName.replace(/^https?:/i, '');
  } catch {
    return null;
  }
}

// Classifies one `addtexture`/`texture` argument -- a material's own, or a
// bare one straight on an obstacle -- into whichever of the two things bzo
// can do with it, or neither.
function resolveBzwTextureName(rawName) {
  const stock = resolveBzwStockTexture(rawName);
  if (stock) return { stock };
  const url = parseBzwTextureUrl(rawName);
  if (url) return { url };
  return null;
}

// `MeshFace::finalize` (MeshFace.cxx:80-129) picks the vertex triple with
// the largest cross product to build a face's plane from, and a face whose
// best triple is degenerate has no plane to make: upstream logs "invalid
// mesh face" and sets `vertexCount` to 0, discarding the face and loading
// the world anyway. Same test, same threshold, same outcome here -- a map
// that draws a warning from bzfs draws one from bzo rather than loading
// clean in one and noisy in the other.
function faceMaxCrossSqr(vertices, indices) {
  let max = 0;
  for (let i = 0; i < indices.length - 2; i++) {
    for (let j = i + 1; j < indices.length - 1; j++) {
      const a = vertices[indices[i]];
      const b = vertices[indices[j]];
      if (!a || !b) continue;
      const e2 = [a.x - b.x, a.y - b.y, a.z - b.z];
      for (let k = j + 1; k < indices.length; k++) {
        const c = vertices[indices[k]];
        if (!c) continue;
        const e1 = [c.x - b.x, c.y - b.y, c.z - b.z];
        const cross = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        ];
        const lenSqr = cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2];
        if (lenSqr > max) max = lenSqr;
      }
    }
  }
  return max;
}

// Upstream's own threshold, `MeshFace.cxx:114`.
const MIN_FACE_CROSS_SQR = 1.0e-20;

// `text` is a world given rather than read from `filename`, which then only
// names it: a generated one (server/world-generator.cjs).
function parseBZWMap(filename, { quiet = false, extraMessages = [], text: givenText = null } = {}) {
  const degenerateFaceCounts = new Map();
  // Diagnostic detail about this one file -- which refs, textures, or spins
  // it dropped -- worth an operator's attention for the live map and for one
  // just imported, but not for the hundred cached maps
  // `hashRemainingMapsInBackground` revisits on every restart purely to keep
  // the Map Viewer's hash list current. `quiet` is how a caller that is not
  // loading a map anyone is about to play says so -- it only silences the
  // console line; every warning is still collected into `warnedMessages`
  // below so a caller that DOES want them (a remote import writing them back
  // as `-srvmsg` lines, see `performRemoteMapImport`) always can, regardless
  // of `quiet`.
  //
  // `warnedMessages` is the one list, for the one reason -- every one of
  // these is "here is a thing bzo does not do", console and player alike:
  // `warn` both logs it (unless `quiet`) and collects it, and `messages`
  // below is built directly from this same list rather than each caller
  // re-wording the same fact a second time for a chat line.
  const warnedMessages = [];
  const warn = (message) => { warnedMessages.push(message); if (!quiet) log(message); };
  // Facts about how bzo built the map, said to a player but not warnings --
  // see where `messages` is built.
  const notes = [];
  // `extraMessages` -- a fact only knowable outside this function's own text
  // parsing (a remote import's own wire-protocol decode -- `performRemote
  // MapImportNow`) fed through the exact same `warn`, so it is logged,
  // collected, and (once baked back into the file as its own `-srvmsg` line)
  // shown to a player the same way as everything this function detects on
  // its own.
  extraMessages.forEach(warn);
  // The map's own name is all a warning needs to say -- `filename` itself is
  // always this same process's own absolute `maps/` path, which only repeats
  // noise a reader already knows on every line.
  const mapLabel = path.basename(filename);
  const text = givenText ?? fs.readFileSync(filename, 'utf8');
  const lines = text.split(/\r?\n/);
  const teamMode = parseBZWTeamMode(lines);
  const serverOptions = parseBZWServerOptions(lines);
  // The options block is read first, as upstream reads it before the world, so
  // its `_boxBase` and the rest size every box that states no size of its own.
  const worldVariables = gameplayFromBzdb(serverOptions.bzdbVars);
  const gameplayOr = (key) => worldVariables[key] ?? GAME_CONFIG_DEFAULTS[key];
  const worldBoxBase = gameplayOr('BOX_BASE');
  const worldBoxHeight = gameplayOr('BOX_HEIGHT');
  const worldPyrBase = gameplayOr('PYR_BASE');
  const worldPyrHeight = gameplayOr('PYR_HEIGHT');
  const obstacles = [];
  const teleporters = [];
  const parsedLinks = [];
  const zones = [];
  // A `mesh` block's own vertex/normal/texcoord pools and face list, parsed
  // in full (CustomMesh.cxx, CustomMeshFace.cxx) and merged into `obstacles`
  // below (see the merge just above the dropped-feature tally) -- a mesh
  // renders, collides (tank and shot alike, oriented tank box included),
  // shows on radar and gets a debug label the same as a box or a pyramid
  // now, so it counts as a supported obstacle rather than a dropped one.
  // What is still missing is in `docs/bzw-plan.md`'s "Mesh geometry": mainly
  // the `meshbox`/`meshpyr`/`arc`/`cone`/`sphere`/`tetra` generators, which
  // still fall through to the generic dropped-token tally below like any
  // other unhandled keyword.
  const meshes = [];
  // The map's `world size` directive, applied to `GAME_CONFIG.MAP_SIZE` only
  // at the call site that loads the live map -- never inside this function,
  // which the background map-hashing trickle (see `MAP_REGISTRY`) also calls
  // for every other map on the server. Mutating the shared config here would
  // let whichever map that trickle parses last silently resize the live
  // match for every later connection.
  let mapSize = null;
  // `flagHeight`, `noWalls` and `freeCtfSpawns` on the `world` block --
  // CustomWorld.cxx:41-49. `mapFlagHeight` is applied at the live-map call
  // site the same way `mapSize` is, since `GAME_CONFIG.FLAG_HEIGHT` is shared
  // state the background map-hashing trickle must not touch. `noWalls` and
  // `freeCtfSpawns` ride along in this function's own return value instead --
  // one because the client needs it in the map's own JSON (see `noWalls` in
  // `registerMapFile`), the other because it only ever matters to
  // `getSpawnPosition`, which already reads `mapServerOptions`.
  let mapFlagHeight = null;
  let mapNoWalls = false;
  let mapFreeCtfSpawns = false;
  // `waterLevel` / `end` (`CustomWaterLevel.cxx`) -- a map-wide singleton
  // like `noWalls`, not an obstacle, so it fills in one variable on `end`
  // rather than collecting into a registry a `matref` looks up later.
  // Carried out through this function's own return value the same way
  // `noWalls` is, for the same two reasons: the client needs it to draw the
  // plane, and `validateMovement` needs it for the kill-on-touch rule.
  let mapWaterLevel = null;
  let currentWaterLevel = null;
  let current = null;
  let currentLink = null;
  let currentZone = null;
  // The one `face` / `endface` block currently open inside a `mesh` --
  // a second scope nested inside `current` (still the mesh itself), since a
  // face's own properties start from the mesh's defaults at the moment
  // `face` was read (`CustomMeshFace`'s constructor snapshot) and nothing
  // else parsed here has that shape.
  let currentMeshFace = null;
  // The `drawInfo { ... }` block a mesh may carry -- upstream's
  // `MeshDrawInfo`, the render-optimized copy of the same surface, and the
  // only place upstream reads `angvel` from. Non-null exactly while one is
  // open; `depth` walks its own nested `lod`/`matref` blocks so their `end`
  // lines close them rather than the mesh around them, which is what used to
  // cut a mesh short at the first one.
  let currentDrawInfo = null;
  // `define <name>` / `enddef`. Everything closed while this is set collects
  // into its obstacle list instead of `obstacles`, keyed by name so any number
  // of `group` instances can place transformed copies of it later.
  let currentDefine = null;
  const defineTemplates = new Map();
  // A `group <name>` instance is recorded here rather than expanded in place --
  // `group` may reference a `define` the file states later, the same deferred
  // resolution upstream gives it -- and expanded once the whole file is read.
  const groupInstanceRequests = [];
  const unknownGroupDefs = new Set();
  // A definition that names itself again while still being placed, directly
  // or through others -- `GroupDefinition::makeGroups`'s own `active` guard,
  // logged the same way upstream does ("avoided recursion") rather than
  // hanging or overflowing the stack. Ordinary, non-cyclic nesting recurses
  // freely; this is only ever a cycle.
  const groupCycleWarnings = new Set();
  // A `spin <deg> <ax> <ay> <az>` line whose axis isn't the map's own
  // vertical -- tips the shape off bzo's axis-aligned box/pyramid model the
  // same way `shear` always does, so it is counted here and named once
  // rather than applied wrong. A spin about the vertical is read like
  // `rotation` (see the `spin` branch below); this is only the rest of it.
  let nonVerticalSpinCount = 0;
  // Boxes, pyramids and teleporters placed by a group spun off vertical or
  // sheared -- its meshes take the whole transform, these stay upright.
  let tippedObstacleCount = 0;
  // Which zone keywords a map asked for that bzo does not act on, gathered so
  // the load can say so once rather than for every zone. `zone` blocks are
  // otherwise the one place a map states something invisible: a spawn zone that
  // is skipped moves every tank in the world.
  const unreadZoneKeywords = new Set();
  // A world weapon occupies nothing, so it is not an obstacle.
  const weapons = [];
  let currentWeapon = null;
  const unreadWeaponKeywords = new Set();
  const unreadWeaponTypes = new Set();
  // `material` / `end` (CustomMaterial.cxx, ParseMaterial.cxx). A material is
  // not an obstacle either -- it is a named bundle of a texture and a tint
  // that a `matref` line looks up later, so it collects into its own registry
  // the same way a zone or a weapon does. Keyed case-insensitively, the way
  // upstream's own MaterialManager looks a name up.
  let currentMaterial = null;
  const materialsByName = new Map();
  // Every material in file order, so `findMaterial`'s own digit-first branch
  // (`BzMaterial.cxx:79-86`, upstream) can resolve a numeric `matref` as an
  // index into this list -- how a `material` block with no `name` line at
  // all is still reachable, a common map-editor export style
  // (`import-bz.rikers.org_5154.bzw`'s 18 materials, 17 of them unnamed and
  // referenced as `matref 0` through `matref 17`).
  // See the `end` handler below for why this is plain file order rather than
  // upstream's own dedup-on-add.
  const materialRegistry = [];
  // A `matref` naming a material this file never defined.
  const unresolvedMaterialRefs = new Set();
  // `physics` / `end` (`CustomPhysicsDriver.cxx`, `PhysicsDriver.cxx`). A
  // physics driver is not an obstacle either -- it is a named velocity (and,
  // separately, a named instant-kill message) a `phydrv` line looks up
  // later, collected the same way a material is. `findDriver`'s own
  // digit-first branch (`PhysicsDriver.cxx:78-89`) is the exact same
  // convention `BzMaterial::findMaterial` uses for `matref`, so this keeps
  // the same file-order registry plus case-insensitive name map.
  let currentPhysicsDriver = null;
  const physicsDriversByName = new Map();
  const physicsDriverRegistry = [];
  // A `phydrv` naming a driver this file never defined.
  const unresolvedPhysicsDriverRefs = new Set();
  // `angular`/`radial`/`slide` lines inside a `physics` block -- read as far
  // as recognizing the keyword so it never falls through as a stray unknown
  // token, but not applied to motion: no real map sampled uses any of the
  // three (`docs/bzw-plan.md`, "Physics drivers"), and upstream's own
  // `radial` has no consumer anywhere in its renderer either. Counted the
  // same way `unsupportedCounts` tracks any other partially-read block.
  const unreadPhysicsDriverKeywords = new Set();
  // `dynamicColor` / `end` (`CustomDynamicColor.cxx`, `DynamicColor.cxx`). A
  // named, time-varying RGBA a `material`'s own `dyncol <name>` line pulls
  // in -- collected the same way a material or a physics driver is, with the
  // same digit-first-then-name resolution (`DynamicColor.cxx:80-101`).
  let currentDynamicColor = null;
  const dynamicColorsByName = new Map();
  const dynamicColorRegistry = [];
  // A `dyncol` naming a dynamic color this file never defined.
  const unresolvedDynamicColorRefs = new Set();
  // `textureMatrix` / `end` (`CustomTextureMatrix.cxx`, `TextureMatrix.cxx`).
  // A named, time-varying UV transform a `material`'s own `texmat <name>`
  // line pulls in -- collected and resolved the same way.
  let currentTextureMatrix = null;
  const textureMatricesByName = new Map();
  const textureMatrixRegistry = [];
  // A `texmat` naming a texture matrix this file never defined.
  const unresolvedTextureMatrixRefs = new Set();
  // A texture name (on a `material` or straight on an obstacle) bzo has no
  // local asset for -- see `resolveBzwStockTexture` -- named on load rather
  // than silently kept at the obstacle's plain default.
  const unresolvedTextureNames = new Set();
  // An absolute `http`/`https` texture URL a map names -- forwarded to the
  // client as-is (see `resolveBzwTextureName`) rather than resolved here:
  // the server never fetches one, and whether it actually loads is each
  // client's own decision (`isExternalTextureUrlLoadable` in
  // `public/texture.js` -- every host is attempted, so this is a CORS/
  // load-failure outcome, not a host it refused to try). Named on load so
  // it is visible that a map asked for one at all.
  const externalTextureUrls = new Set();
  // How many of each UNSUPPORTED_TOP_LEVEL_KEYWORDS block this map asked for,
  // by keyword -- what turns into the player-facing chat message below and
  // (with `serverOptions.serverMessages`, i.e. -srvmsg) this function's
  // `messages` return value.
  const unsupportedCounts = new Map();
  // Keywords no branch of the parser recognises, by keyword. Separate from
  // `unsupportedCounts` above, which counts whole blocks bzo deliberately
  // declines: these are words nobody has taught it, and the difference
  // matters to whoever reads the warning.
  const unreadKeywordCounts = new Map();

  function getTeleporterEndpointName(teleporter, face) {
    return `${teleporter.linkName}:${face === 0 ? 'f' : 'b'}`;
  }

  // CustomGate's constructor, for a teleporter that gave no size or border of
  // its own: half width 0.5 * _teleportWidth, half breadth _teleportBreadth,
  // height 2 * _teleportHeight, and a border twice the half width. Filled in
  // here rather than left to each reader, because a dimension left undefined
  // is not a small teleporter -- it is NaN, and testOrigRectRect answers
  // "overlapping" for a NaN half extent, since every comparison against NaN
  // is false and the corner is classified into the obstacle. One sizeless
  // obstacle then supports a tank anywhere in the world.
  //
  // Applied once, at parse time, whether the teleporter is a plain top-level
  // one or a `define` template member -- upstream resolves a `CustomGate`'s
  // dimensions the same way regardless, before any group instance ever
  // copies or transforms it (`ObstacleMgr.cxx`'s `copyWithTransform`).
  function applyTeleporterDefaults(teleporter) {
    const stated = BZW_TELEPORTER_DEFAULTS.size.map((fallback, i) => (
      Number.isFinite(teleporter.size?.[i]) ? teleporter.size[i] : fallback
    ));
    if (!Number.isFinite(teleporter.border)) teleporter.border = BZW_TELEPORTER_DEFAULTS.border;
    // Teleporter::finalize (Teleporter.cxx). The border grows the solid --
    // `size[1] = origSize[1] + border * 2`, `size[2] = origSize[2] + border`
    // -- and those grown values *are* the obstacle's extents, so they are
    // what collides, what supports a tank and what is drawn.
    //
    // Applied here, once, so `size` on a teleporter means the same thing it
    // means on a box: the solid. The stated size is the hole rather than the
    // frame, and reading it directly is the easy mistake, so no reader ever
    // sees it.
    const statedBorder = Math.max(0.12, teleporter.border);
    const statedHalfWidth = Math.max(0.25, stated[0]);
    const statedHalfBreadth = Math.max(0.25, stated[1]);
    const statedHeight = Math.max(1.0, stated[2]);
    teleporter.border = statedBorder;
    // Upstream takes the larger of the border half-width and the stated
    // width for the x extent, which is its own line in finalize().
    teleporter.size = [
      Math.max(statedBorder * 0.5, statedHalfWidth),
      statedHalfBreadth + (statedBorder * 2),
      statedHeight + statedBorder,
    ];
  }

  // Gives a teleporter its place in the world's flat teleporter list -- a
  // sequential face index and an entry `buildTeleporterLinks` can match a
  // `link` block's endpoint name against. Called once per *real* placement,
  // whether that is an ordinary top-level teleporter or one a `group`
  // instance places from a `define` -- never for a template member still
  // sitting in `defineTemplates`, which is not a placement yet.
  function registerTeleporter(teleporter) {
    const teleporterIndex = teleporters.length;
    const linkName = teleporter.name || `teleporter_${teleporterIndex}`;
    teleporter.teleporterIndex = teleporterIndex;
    teleporter.linkName = linkName;
    teleporters.push({
      teleporterIndex,
      linkName,
      obstacle: teleporter,
    });
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function globMatch(pattern, candidate) {
    const source = `^${escapeRegExp(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`;
    return new RegExp(source, 'i').test(candidate);
  }

  function normalizeEndpointPattern(value) {
    if (typeof value !== 'string') return '';
    let endpoint = value.trim();
    if (!endpoint) return '';
    if (endpoint.startsWith(':')) {
      endpoint = endpoint.slice(1);
    }
    const last = endpoint.slice(-1);
    if (last === 'F' || last === 'B') {
      endpoint = `${endpoint.slice(0, -1)}${last.toLowerCase()}`;
    }
    return endpoint;
  }

  function resolveNumericFace(faceId) {
    if (!Number.isInteger(faceId) || faceId < 0 || faceId >= teleporters.length * 2) {
      return [];
    }
    return [faceId];
  }

  function resolveNamedFaces(pattern) {
    const normalizedPattern = normalizeEndpointPattern(pattern);
    if (!normalizedPattern) return [];
    const matches = [];
    for (const teleporter of teleporters) {
      const frontName = getTeleporterEndpointName(teleporter, 0);
      const backName = getTeleporterEndpointName(teleporter, 1);
      if (globMatch(normalizedPattern, frontName)) {
        matches.push(teleporter.teleporterIndex * 2);
      }
      if (globMatch(normalizedPattern, backName)) {
        matches.push(teleporter.teleporterIndex * 2 + 1);
      }
    }
    return matches;
  }

  function resolveEndpointFaces(endpoint) {
    if (!endpoint || typeof endpoint.value !== 'string') return [];
    if (endpoint.kind === 'numeric') {
      return resolveNumericFace(endpoint.faceId);
    }
    return resolveNamedFaces(endpoint.value);
  }

  function parseLinkEndpoint(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      return {
        kind: 'numeric',
        value: raw,
        faceId: parseInt(raw, 10),
      };
    }
    return {
      kind: 'named',
      value: raw,
      pattern: normalizeEndpointPattern(raw),
    };
  }

  function faceIdToEndpoint(faceId) {
    const teleporterIndex = Math.floor(faceId / 2);
    const face = faceId % 2;
    const teleporter = teleporters[teleporterIndex];
    if (!teleporter) return null;
    return {
      faceId,
      teleporterIndex,
      face,
      endpoint: getTeleporterEndpointName(teleporter, face),
    };
  }

  function buildTeleporterLinks() {
    const linksBySource = new Map();

    for (const link of parsedLinks) {
      const srcFaces = resolveEndpointFaces(link.from);
      const dstFaces = resolveEndpointFaces(link.to);

      if (!srcFaces.length || !dstFaces.length) {
        warn(`Ignoring broken teleporter link from "${link.from?.value || ''}" to "${link.to?.value || ''}" in ${mapLabel}`);
        continue;
      }

      for (const sourceFaceId of srcFaces) {
        if (!linksBySource.has(sourceFaceId)) {
          linksBySource.set(sourceFaceId, new Set());
        }
        const destinationSet = linksBySource.get(sourceFaceId);
        for (const destFaceId of dstFaces) {
          destinationSet.add(destFaceId);
        }
      }
    }

    // Match BZFlag link behavior: any unlinked source face defaults to
    // passing through to the opposite face on the same teleporter.
    for (let sourceFaceId = 0; sourceFaceId < teleporters.length * 2; sourceFaceId++) {
      if (!linksBySource.has(sourceFaceId) || linksBySource.get(sourceFaceId).size === 0) {
        const oppositeFaceId = (Math.floor(sourceFaceId / 2) * 2) + (1 - (sourceFaceId % 2));
        linksBySource.set(sourceFaceId, new Set([oppositeFaceId]));
      }
    }

    const normalizedLinks = [];
    for (const [sourceFaceId, destinationSet] of linksBySource.entries()) {
      const source = faceIdToEndpoint(sourceFaceId);
      if (!source) continue;

      for (const destFaceId of destinationSet) {
        const destination = faceIdToEndpoint(destFaceId);
        if (!destination) continue;

        normalizedLinks.push({
          sourceFaceId,
          sourceEndpoint: source.endpoint,
          sourceTeleporter: source.teleporterIndex,
          sourceFace: source.face,
          destFaceId,
          destEndpoint: destination.endpoint,
          destTeleporter: destination.teleporterIndex,
          destFace: destination.face,
        });
      }
    }

    normalizedLinks.sort((a, b) => {
      if (a.sourceFaceId !== b.sourceFaceId) return a.sourceFaceId - b.sourceFaceId;
      return a.destFaceId - b.destFaceId;
    });

    return {
      teleporters: teleporters.map((teleporter) => ({
        teleporterIndex: teleporter.teleporterIndex,
        name: teleporter.linkName,
        obstacleName: teleporter.obstacle.name,
        frontFaceId: teleporter.teleporterIndex * 2,
        backFaceId: teleporter.teleporterIndex * 2 + 1,
        frontEndpoint: `${teleporter.linkName}:f`,
        backEndpoint: `${teleporter.linkName}:b`,
      })),
      links: normalizedLinks,
    };
  }

  // The one texture/tint/flag bundle a `material` block, a mesh's own
  // defaults, and a mesh face's own overrides all read the same way --
  // `matref`/`color`/`diffuse`/`addtexture`/`texture`/`notextures`/
  // `noradar`/`nolighting` -- each setting `target`'s own texture/
  // textureUrl/color/noRadar/noLighting fields in the same read-order-wins
  // sequence every caller already gives its own block. Returns whether
  // `token` was one of these, so a caller falls through to whatever else
  // its own block reads for anything this returns false for.
  function applyBzwMaterialToken(target, token, words) {
    if (token === 'matref') {
      const rawRef = words[1] || '';
      // `findMaterial`'s own check (`BzMaterial.cxx:79`) looks at the
      // target's first character alone, before it ever tries a name match --
      // so a `matref` that starts with a digit is always an index, never a
      // name, matching upstream exactly rather than only as a fallback.
      let referenced;
      if (/^[0-9]/.test(rawRef)) {
        const index = parseInt(rawRef, 10);
        referenced = materialRegistry[index] || null;
      } else {
        referenced = materialsByName.get(rawRef.toLowerCase()) || null;
      }
      // `-1` is upstream's own spelling of "no material", not a name it
      // failed to find: every caller suppresses its own warning for exactly
      // that string (`CustomGroup.cxx:87`, `ObstacleModifier`, and the
      // `phydrv`/`texmat` readers beside them), so it is left unreported
      // here too rather than named on load as a map's mistake.
      if (referenced) {
        target.texture = referenced.texture;
        target.textureUrl = referenced.textureUrl;
        target.color = referenced.color;
        target.noRadar = referenced.noRadar;
        target.noLighting = referenced.noLighting;
        target.noShadow = referenced.noShadow;
        target.dynamicColor = referenced.dynamicColor;
        target.textureMatrix = referenced.textureMatrix;
        target.specular = referenced.specular;
        target.emission = referenced.emission;
        target.shininess = referenced.shininess;
        target.alphaThreshold = referenced.alphaThreshold;
        target.noCulling = referenced.noCulling;
        target.noSorting = referenced.noSorting;
        target.useTextureAlpha = referenced.useTextureAlpha;
        target.useColorOnTexture = referenced.useColorOnTexture;
      } else if (rawRef && rawRef !== '-1') {
        unresolvedMaterialRefs.add(rawRef.toLowerCase());
      }
      return true;
    }
    if (token === 'dyncol') {
      // `BzMaterial::setDynamicColor` -- replaces the whole material's own
      // diffuse with the named `dynamicColor`'s live RGBA (resolved fully
      // below, not just a name) rather than tinting it, matching
      // `MeshSceneNode.cxx:487-491`'s `mat->colorPtr = dyncol->getColor()`.
      const rawRef = words[1] || '';
      const referenced = /^[0-9]/.test(rawRef)
        ? dynamicColorRegistry[parseInt(rawRef, 10)] || null
        : dynamicColorsByName.get(rawRef.toLowerCase()) || null;
      if (referenced) {
        target.dynamicColor = referenced;
      } else if (rawRef && rawRef !== '-1') {
        unresolvedDynamicColorRefs.add(rawRef.toLowerCase());
      }
      return true;
    }
    if (token === 'texmat') {
      // `BzMaterial::setTextureMatrix` -- a UV transform applied in the
      // texture-coordinate stage (`OpenGLGState.cxx:536-544`), independent of
      // whatever baked tiling the geometry itself already carries. Upstream
      // attaches it to whichever texture slot was added most recently
      // (`textures[textureCount - 1].matrix = matrix`, `BzMaterial.cxx:
      // 850-855`) and silently does nothing if no texture has been added yet
      // -- real for a fresh `material` block (`textureCount` starts at 0
      // there, confirmed against `import-Planet-MoFo.com_4202.bzw`'s own
      // `addtexture`-then-`texmat` convention, "Animated materials" in
      // docs/bzw.md) but genuinely unclear for an inline box/mesh-face
      // property with no `material` block at all, where the obstacle's own
      // constructor may pre-seed a stock texture first. Not replicated here
      // pending that answer -- bzo stays order-independent for `texmat`
      // rather than risk dropping a reference upstream would actually keep.
      const rawRef = words[1] || '';
      const referenced = /^[0-9]/.test(rawRef)
        ? textureMatrixRegistry[parseInt(rawRef, 10)] || null
        : textureMatricesByName.get(rawRef.toLowerCase()) || null;
      if (referenced) {
        target.textureMatrix = referenced;
      } else if (rawRef && rawRef !== '-1') {
        unresolvedTextureMatrixRefs.add(rawRef.toLowerCase());
      }
      return true;
    }
    if (token === 'color' || token === 'diffuse') {
      const tint = parseBzwColor(words.slice(1));
      if (tint) target.color = tint;
      return true;
    }
    if (token === 'addtexture' || token === 'texture') {
      // Upstream keeps every texture a material names, in order --
      // `BzMaterial::addTexture` (`BzMaterial.cxx:812-822`) always appends a
      // new slot, while `texture`'s `setTexture` (`:833-838`) replaces the
      // *last* one instead (or creates the first, if the list is still
      // empty). But every renderer that draws a material -- `OpenGLUtils.cxx`,
      // `MeshSceneNode.cxx`, `MeshSceneNodeGenerator.cxx`,
      // `BackgroundRenderer.cxx` -- reads only slot 0
      // (`getTextureLocal(0)`/`getUseColorOnTexture(0)`/`getTextureMatrix(0)`),
      // with no exception anywhere in the tree. A stacked second or third
      // `addtexture` is therefore inert in real play: only the first texture
      // a material names is ever drawn. bzo has no multi-texture model, so an
      // `addtexture` once a texture is already set is the same no-op it is
      // upstream, and only a `texture` line (or the first `addtexture`,
      // `notextures` having cleared the slot) actually changes what shows.
      if (token === 'addtexture' && (target.texture || target.textureUrl)) {
        return true;
      }
      const rawName = words.slice(1).join(' ');
      const resolved = resolveBzwTextureName(rawName);
      if (resolved?.stock) {
        target.texture = resolved.stock;
        target.textureUrl = null;
      } else if (resolved?.url) {
        target.textureUrl = resolved.url;
        target.texture = null;
        externalTextureUrls.add(resolved.url);
      } else if (rawName) {
        unresolvedTextureNames.add(rawName);
      }
      return true;
    }
    if (token === 'notextures') {
      target.texture = null;
      target.textureUrl = null;
      return true;
    }
    if (token === 'noradar') {
      target.noRadar = true;
      return true;
    }
    if (token === 'nolighting') {
      target.noLighting = true;
      return true;
    }
    if (token === 'noshadow') {
      target.noShadow = true;
      return true;
    }
    if (token === 'alphathresh') {
      // `BzMaterial::reset` defaults this to 0, and upstream reads 0 as "no
      // alpha test at all" rather than as a threshold of zero
      // (`MeshSceneNode.cxx:525`: `if (alphaThreshold != 0.0f)`). Kept the
      // same way here so a map that states 0 explicitly means what upstream
      // means by it, and `render.js` can tell "stated" from "not stated".
      const value = Number(words[1]);
      target.alphaThreshold = Number.isFinite(value) ? value : 0;
      return true;
    }
    if (token === 'noculling') {
      // `BzMaterial::setNoCulling`. Kept, but it reaches the renderer down
      // one path only, which is upstream's rule rather than a bzo limit.
      //
      // A plain `mesh` face draws through `MeshPolySceneNode`, and both it
      // (`MeshPolySceneNode.cxx:255-261`) and its base `WallSceneNode::cull`
      // (`:87-95`) open with "cull if eye is behind (or on) plane" and return
      // true -- the node never reaches a render list, so the
      // `disableCulling()` this sets (`WallSceneNode.cxx:371-372`) never
      // runs. A box's or a pyramid's quad faces go the same way. A map
      // wanting a two-sided surface writes the face twice with reversed
      // winding, which is what real maps do and what `maps/bzo.bzw`'s own
      // billboards do.
      //
      // The exception is a mesh drawn from its own `drawInfo` block, where
      // `MeshSceneNode::cull` (`:287-300`) is bounding-box alone with no
      // plane test at all and the flag really does show the far side. bzo
      // carries it onto those faces and nowhere else -- see
      // `buildMeshDrawFaces`.
      target.noCulling = true;
      return true;
    }
    if (token === 'nosorting') {
      // `BzMaterial::setNoSorting` -- keeps a translucent material out of
      // upstream's own back-to-front ordered pass (`MeshSceneNode.cxx:520`),
      // which is the one pass `SceneRenderer::doRender` draws under
      // `glDepthMask(GL_FALSE)`. What that means for a single-list renderer
      // like bzo's is exactly the depth mask: a `nosorting` face goes on
      // writing depth even once its texture or its tint turns it
      // transparent. See `applyTextureAlpha` in `render.js`.
      target.noSorting = true;
      return true;
    }
    if (token === 'notexalpha') {
      // `BzMaterial::setUseTextureAlpha(false)` -- upstream looks at a
      // texture's own alpha channel only while this is set
      // (`MeshSceneNode.cxx:429-433`, `MeshSceneNodeGenerator.cxx:471-477`,
      // both feeding `setBlending` alone), so a picture that happens to
      // carry alpha draws fully opaque instead of blending. It says nothing
      // about the alpha *test*: `alphathresh` reaches `GL_GEQUAL` whatever
      // this flag said (`WallSceneNode.cxx:369-370`), so a material stating
      // both still cuts its transparent pixels away. See `render.js`.
      target.useTextureAlpha = false;
      return true;
    }
    if (token === 'notexcolor') {
      // `BzMaterial::setUseColorOnTexture(false)` -- upstream stops
      // modulating the texture by the material's own diffuse and uses plain
      // white in its place (`MeshSceneNode.cxx:428`, `:470-481`), which is
      // what a mapper wants where a material's tint exists for the
      // untextured fallback rather than for the picture. Only ever reached
      // with a texture actually on the material, upstream and here alike.
      target.useColorOnTexture = false;
      return true;
    }
    if (token === 'shader' || token === 'addshader' || token === 'noshaders') {
      // `BzMaterial` parses and stores a material's shader list, and nothing
      // anywhere upstream ever reads it back -- `getShader`/`getShaderCount`
      // have no caller outside `BzMaterial` itself. Read and dropped, the
      // same as `ambient` below.
      return true;
    }
    if (token === 'groupalpha') {
      // `BzMaterial::setGroupAlpha`. Its only reader anywhere upstream
      // (`MeshSceneNodeGenerator.cxx:213-215`) decides whether a translucent
      // face gets a scene node of its own -- sorted against the world
      // individually -- or is collated into one node with the faces sharing
      // its material; `MeshSceneNode.cxx:517-519` states outright that it
      // does not use the flag, because everything there is grouped already.
      // bzo builds one merged geometry group per material and draws the
      // whole mesh as a single object, which *is* the collated case, so a
      // map stating this asks for what bzo does regardless. Read and
      // dropped, the same as `ambient` below -- not a parity gap to report.
      return true;
    }
    if (token === 'specular' || token === 'emission' || token === 'shininess') {
      // `BzMaterial::reset` defaults for a component this line leaves
      // unstated: specular/emission `0 0 0 1`, shininess `0`. These are the
      // three of `BzMaterial`'s four lighting coefficients that reach real
      // GL state upstream (`OpenGLMaterial`, fed from
      // `MeshSceneNode.cxx:463-465`), which is why `render.js` mirrors them
      // with `MeshPhongMaterial`'s `specular`/`shininess`/`emissive` --
      // see `hasRealSpecular` there.
      const defaults = token === 'shininess' ? [0] : [0, 0, 0, 1];
      const values = words.slice(1).map(Number);
      const resolved = defaults.map((def, i) => (Number.isFinite(values[i]) ? values[i] : def));
      target[token] = token === 'shininess' ? resolved[0] : resolved;
      return true;
    }
    if (token === 'ambient') {
      // `BzMaterial::reset`'s own default (`0.2 0.2 0.2 1`) is exactly
      // OpenGL's compiled-in material ambient, and nothing upstream ever
      // calls `glMaterial(..., GL_AMBIENT, ...)` anywhere in its tree --
      // confirmed by grep across the whole source. A mapper's own `ambient`
      // line is therefore just as inert in a real bzflag client as it would
      // be here, matching `BzMaterial.cxx:652`'s own comment on the field:
      // "not really used". Read and dropped like any other property this
      // parser recognizes but does not act on -- not a bzo gap to report.
      return true;
    }
    return false;
  }

  // The `options` block and the `world` block are each read by a pass of their
  // own -- the map options parser, and the lookahead in the `world` branch
  // below -- and this loop walks their lines again on the way past. Naming the
  // block being skipped keeps a keyword another pass already read out of the
  // unread tally, where it would otherwise look like a gap that is not there.
  let consumedBlock = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // Every keyword upstream reads it reads with strcasecmp, and it reads the
    // first whitespace-delimited token rather than a prefix of the line -- so
    // `Position` is a position and `basey` is not a base.
    const token = line.split(/\s+/)[0].toLowerCase();

    // A `drawInfo { ... }` block owns every line until its own `end`.
    // Upstream reads it by consuming the stream outright
    // (`MeshDrawInfo::parse`), and bzo has to claim it just as early: half
    // its vocabulary is shared with the top level, and a `sphere` bounding
    // hint inside a draw set would otherwise open a sphere obstacle in the
    // middle of a mesh and throw the mesh away with it
    // (`ahs3_Paradise_Valley.bzw`, whose largest mesh vanished exactly that
    // way). Opened from the mesh branch below, which is the only place one
    // can appear.
    if (currentDrawInfo) {
      readMeshDrawInfoLine(current, currentDrawInfo, token, line.split(/\s+/));
      if (currentDrawInfo.closed) currentDrawInfo = null;
      continue;
    }

    if (currentLink && token === 'end') {
      if (currentLink.from && currentLink.to) {
        parsedLinks.push(currentLink);
      } else {
        warn(`Ignoring incomplete link block in ${mapLabel}`);
      }
      currentLink = null;
      continue;
    }

    if (currentLink && token === 'from') {
      const [, ...fromParts] = line.split(/\s+/);
      currentLink.from = parseLinkEndpoint(fromParts.join(' ').replace(/"/g, '').trim());
      continue;
    }

    if (currentLink && token === 'to') {
      const [, ...toParts] = line.split(/\s+/);
      currentLink.to = parseLinkEndpoint(toParts.join(' ').replace(/"/g, '').trim());
      continue;
    }

    if (!current && token === 'link') {
      currentLink = { from: null, to: null };
      continue;
    }

    // CustomZone. A zone is not an obstacle -- nothing collides with it and
    // nothing draws it -- so it goes to its own list rather than through
    // `current`. Upstream ships zones to clients only so the client's
    // `World::writeWorld` can write the map back out; no gameplay on either side
    // reads them, so bzo keeps them on the server and sends nothing.
    if (currentZone) {
      if (token === 'end') {
        currentZone.index = zones.length;
        zones.push(currentZone);
        currentZone = null;
        continue;
      }
      if (token === 'position' || token === 'pos') {
        const [, x, y, z] = line.split(/\s+/);
        currentZone.x = parseFloat(x) || 0;
        currentZone.y = parseFloat(y) || 0;
        currentZone.z = parseFloat(z) || 0;
        continue;
      }
      if (token === 'size') {
        // Half extents in BZW's own x/y, kept in those axes because
        // getRandomZonePoint rotates the offset the way upstream does and
        // converts only the result.
        const [, x, y] = line.split(/\s+/);
        currentZone.halfWidth = Math.abs(parseFloat(x) || 0);
        currentZone.halfDepth = Math.abs(parseFloat(y) || 0);
        continue;
      }
      if (token === 'rotation' || token === 'rot') {
        // Left in BZW's frame -- degrees counter-clockwise about +Z -- for the
        // same reason the size is.
        const [, deg] = line.split(/\s+/);
        currentZone.rotation = (parseFloat(deg) || 0) * Math.PI / 180;
        continue;
      }
      if (token === 'zoneflag') {
        // zoneflag <abbreviation|good|bad> [count]. The count is optional and
        // upstream defaults it to 1 when it does not parse; a count given as 0
        // really does mean none. Repeats accumulate, as addZoneFlagCount does.
        const [, requested, rawCount] = line.split(/\s+/);
        if (!requested) continue;
        const parsedCount = Number(rawCount);
        const count = Number.isFinite(parsedCount) ? Math.max(0, Math.round(parsedCount)) : 1;
        const wanted = requested.trim().toUpperCase();
        const wantedQuality = wanted === 'GOOD' || wanted === 'BAD' ? wanted === 'BAD' : null;
        for (const abbreviation of FLAG_ABBREVIATIONS) {
          if (isTeamFlag(abbreviation)) continue;
          const matches = wantedQuality === null
            ? abbreviation === wanted
            : isBadFlag(abbreviation) === wantedQuality;
          if (!matches) continue;
          currentZone.flagCounts.set(
            abbreviation,
            (currentZone.flagCounts.get(abbreviation) || 0) + count
          );
        }
        // A type with no `FLAG_TYPES` row matched nothing above, so it is
        // recorded here for the load to name. That is `WA`, which bzo does not
        // carry and will not (see docs/flags.md), or a typo in the map.
        if (wantedQuality === null && !getFlagType(wanted)) {
          currentZone.unknownFlags.add(wanted);
        }
        continue;
      }
      // team <n> [n ...]. CustomZone::read's spawn-area qualifier: n is a
      // BZFlag team index, 0 rogue and 1-4 red/green/blue/purple, and a zone
      // may list more than one either on one line or across repeats -- upstream
      // accumulates both ways, since each is just another qualifier pushed onto
      // the same zone.
      if (token === 'team') {
        const [, ...rest] = line.split(/\s+/);
        for (const raw of rest) {
          const teamIndex = parseInt(raw, 10);
          if (Number.isInteger(teamIndex) && teamIndex >= 0 && teamIndex <= 4) {
            currentZone.teams.add(teamIndex);
          }
        }
        continue;
      }
      // `safety <n> [n ...]` -- CustomZone.cxx:184-206, the same accumulation
      // as `team` above (upstream reads them in one shared branch), but a
      // landing spot for a *dropped team flag*, not a spawn qualifier: see
      // `getSafetyZonePosition`, used from `dropFlag`.
      if (token === 'safety') {
        const [, ...rest] = line.split(/\s+/);
        for (const raw of rest) {
          const teamIndex = parseInt(raw, 10);
          if (Number.isInteger(teamIndex) && teamIndex >= 0 && teamIndex <= 4) {
            currentZone.safety.add(teamIndex);
          }
        }
        continue;
      }
      // flag <abbreviation|good|bad> [...] (CustomZone.cxx:80-140): every flag
      // of a named type spawns, and respawns, somewhere in a zone that names
      // it -- `getFlagSpawnZone`. Unlike `zoneflag` it puts no flags into the
      // world; it only says where the ones already there come back. A team
      // flag is not a type this takes: upstream refuses it ("you probably
      // want a safety") and so does this, the word skipped.
      if (token === 'flag') {
        const [, ...rest] = line.split(/\s+/);
        for (const raw of rest) {
          const wanted = raw.trim().toUpperCase();
          if (!wanted) continue;
          if (wanted === 'GOOD' || wanted === 'BAD') {
            for (const abbreviation of FLAG_ABBREVIATIONS) {
              if (isTeamFlag(abbreviation)) continue;
              if (isBadFlag(abbreviation) === (wanted === 'BAD')) currentZone.flagTypes.add(abbreviation);
            }
          } else if (!getFlagType(wanted)) {
            currentZone.unknownFlags.add(wanted);
          } else if (!isTeamFlag(wanted)) {
            currentZone.flagTypes.add(wanted);
          }
        }
        continue;
      }
      // `name` is a zone's label and nothing else reads it; anything else is a
      // keyword bzo does not act on, named once for the whole map.
      if (token !== 'name') unreadZoneKeywords.add(token);
      continue;
    }

    // CustomWeapon (CustomWeapon.cxx). A world weapon is not an obstacle -- it
    // occupies nothing and is drawn as nothing -- so it collects in its own list
    // rather than in `obstacles`, and `end` closes it the way a zone's does.
    if (!current && !currentLink && !currentZone && token === 'weapon') {
      currentWeapon = {
        x: 0,
        y: 0,
        z: 0,
        rotation: 0,
        tilt: 0,
        type: null,
        initDelay: WORLD_WEAPON_DEFAULT_DELAY,
        delays: [],
      };
      continue;
    }
    if (currentWeapon) {
      if (token === 'end') {
        // A weapon with no readable type fires upstream's Null flag, which is an
        // ordinary shell -- `Flags::Null` is CustomWeapon's own default.
        currentWeapon.delays = normalizeWorldWeaponDelays(currentWeapon.delays);
        weapons.push(currentWeapon);
        currentWeapon = null;
        continue;
      }
      if (token === 'position' || token === 'pos') {
        const [, x, y, z] = line.split(/\s+/);
        currentWeapon.x = parseFloat(x) || 0;
        currentWeapon.y = parseFloat(y) || 0;
        currentWeapon.z = parseFloat(z) || 0;
        continue;
      }
      if (token === 'rotation' || token === 'rot') {
        const [, deg] = line.split(/\s+/);
        currentWeapon.rotation = (parseFloat(deg) || 0) * Math.PI / 180;
        continue;
      }
      if (token === 'tilt') {
        const [, deg] = line.split(/\s+/);
        currentWeapon.tilt = (parseFloat(deg) || 0) * Math.PI / 180;
        continue;
      }
      // `color <team>` (CustomWeapon.cxx:81): the team its shots are drawn in
      // and fired for, by upstream's own number -- 0 rogue, 1 red, 2 green,
      // 3 blue, 4 purple. Rogue when a map says nothing.
      if (token === 'color') {
        const team = getTeamFromColorIndex(parseInt(line.split(/\s+/)[1], 10));
        if (team) currentWeapon.team = team;
        continue;
      }
      if (token === 'type') {
        const [, abbreviation] = line.split(/\s+/);
        const wanted = (abbreviation || '').trim().toUpperCase();
        // Flag::getDescFromAbbreviation, which leaves the type Null when it does
        // not recognise the name. `WA` reaches here as any other unknown does.
        if (getFlagType(wanted) && !isTeamFlag(wanted)) currentWeapon.type = wanted;
        else if (wanted) unreadWeaponTypes.add(wanted);
        continue;
      }
      if (token === 'initdelay') {
        const [, seconds] = line.split(/\s+/);
        const value = Number(seconds);
        if (Number.isFinite(value)) currentWeapon.initDelay = Math.max(0, value);
        continue;
      }
      if (token === 'delay') {
        // A list, which upstream cycles a shot at a time.
        const [, ...values] = line.split(/\s+/);
        currentWeapon.delays = values;
        continue;
      }
      // `trigger` and `eventteam` make an event-fired weapon rather than a timed
      // one (CustomWeapon.cxx:100). bzo has no event hooks to hang one on, so a
      // map using them is named on load rather than quietly firing on a timer it
      // never asked for.
      if (token === 'trigger' || token === 'eventteam') {
        unreadWeaponKeywords.add(token);
        continue;
      }
      continue;
    }

    // `material` / `end`. Registered by name for `matref` to look up, the way
    // upstream's `CustomMaterial::writeToManager` adds it to the
    // `MaterialManager` for later `matref` lookups to find.
    //
    // A `define` does not scope this, and the same goes for the `physics`,
    // `dynamicColor` and `textureMatrix` blocks below. Upstream's
    // `parseNormalObject` (`BZWReader.cxx:139-184`) builds the object before
    // the reader's own `define`/`enddef` branches ever run and without
    // consulting the group definition, and on `end` the block takes the
    // `usesManager()` path (`:250-253`) into one global registry rather than
    // the `usesGroupDef()` path an obstacle takes. So a material written
    // inside a definition is visible to every `matref` in the file, exactly
    // as if it had been written at the top level -- real maps rely on it
    // (`tricolor.bzw` states seven that way).
    if (!current && !currentLink && !currentZone && !currentWeapon
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'material') {
      currentMaterial = {
        name: null, texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
        dynamicColor: null, textureMatrix: null,
        specular: null, emission: null, shininess: null, alphaThreshold: null,
        noSorting: false, useTextureAlpha: true, useColorOnTexture: true,
      };
      continue;
    }
    if (currentMaterial) {
      if (token === 'end') {
        // Upstream's own `MaterialManager` (`BzMaterialManager::addMaterial`)
        // reuses an existing entry instead of appending a second one for a
        // block whose properties already match one it already holds --
        // fully, on every field it parses, some of which (`ambient`, a full
        // multi-layer `addtexture` list, ...) bzo itself never keeps.
        // Approximating that dedup against only the fields bzo
        // *does* keep collapses distinct upstream entries whose difference
        // lives entirely in a dropped field -- checked directly against
        // `import-bz.rikers.org_5154.bzw`'s own 18 materials, where two
        // pairs share their final `addtexture` layer once bzo has already
        // discarded the layer before it (no multi-texture model -- see
        // "Materials" in docs/bzw.md) but nothing else, and collapsing them
        // shifted every later index enough to break that map's own highest
        // `matref`s. Every material this file (or any other sampled) writes
        // is otherwise distinct, so appending unconditionally reproduces
        // upstream's real numbering exactly for real maps, at the cost of
        // drifting by one from wherever a map writes two blocks that
        // genuinely are identical on every field upstream tracks.
        materialRegistry.push(currentMaterial);
        if (currentMaterial.name) {
          materialsByName.set(currentMaterial.name.toLowerCase(), currentMaterial);
        }
        currentMaterial = null;
        continue;
      }
      if (token === 'name') {
        const [, ...nameParts] = line.split(/\s+/);
        const materialName = nameParts.join(' ').replace(/"/g, '').trim();
        if (materialName) currentMaterial.name = materialName;
        continue;
      }
      // `matref`/`color`/`diffuse`/`addtexture`/`texture`/`notextures`/
      // `noradar`/`nolighting`/`noshadow`/`dyncol`/`texmat` -- a material's
      // own `matref <name>` copies another already-defined material wholesale
      // (BzMaterial's plain struct assignment), which a property stated
      // after it then overrides, the same sequential-read semantics as
      // everything else in this block. `applyBzwMaterialToken` is the same
      // read a mesh's own defaults and a mesh face's own overrides use.
      if (applyBzwMaterialToken(currentMaterial, token, line.split(/\s+/))) {
        continue;
      }
      // Everything else a material block can say -- ambient and groupAlpha
      // (both read and dropped; see `applyBzwMaterialToken` above),
      // shader/addshader/noshaders, occluder, spheremap, resetmat -- is
      // dropped, and counted on the way out. A material keyword bzo does not read changes
      // what a map looks like, so the map should say which ones it wanted
      // rather than leaving it to be discovered by surveying the tree.
      unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
      continue;
    }

    // `physics` / `end` (`CustomPhysicsDriver.cxx`). Registered by name (or
    // left to resolve by file-order index, the same as a `material` with no
    // `name`) for `phydrv` to look up later.
    if (!current && !currentLink && !currentZone && !currentWeapon
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'physics') {
      currentPhysicsDriver = { name: null, linear: null, death: null };
      continue;
    }
    if (currentPhysicsDriver) {
      if (token === 'end') {
        // Upstream's own number for it, its place in the world's driver
        // table (PHYDRVMGR), which MsgKilled names a death-touch by.
        currentPhysicsDriver.index = physicsDriverRegistry.length;
        physicsDriverRegistry.push(currentPhysicsDriver);
        if (currentPhysicsDriver.name) {
          physicsDriversByName.set(currentPhysicsDriver.name.toLowerCase(), currentPhysicsDriver);
        }
        currentPhysicsDriver = null;
        continue;
      }
      if (token === 'name') {
        const [, ...nameParts] = line.split(/\s+/);
        const driverName = nameParts.join(' ').replace(/"/g, '').trim();
        if (driverName) currentPhysicsDriver.name = driverName;
        continue;
      }
      if (token === 'linear') {
        const [, vx, vy, vz] = line.split(/\s+/).map((word) => {
          const value = Number(word);
          return Number.isFinite(value) ? value : 0;
        });
        currentPhysicsDriver.linear = [vx, vy, vz];
        continue;
      }
      if (token === 'death') {
        // `CustomPhysicsDriver.cxx` reads the rest of the line verbatim as
        // the message shown to whoever dies on this surface.
        const [, ...rest] = line.split(/\s+/);
        currentPhysicsDriver.death = rest.join(' ').trim() || null;
        continue;
      }
      if (token === 'angular' || token === 'radial' || token === 'slide') {
        unreadPhysicsDriverKeywords.add(token);
        continue;
      }
      continue;
    }

    // `dynamicColor` / `end` (`CustomDynamicColor.cxx`, `DynamicColor.cxx`).
    // A named, time-varying RGBA -- registered by name (or file-order index)
    // for a `material`'s own `dyncol` to look up later, the same as a
    // `physics` block is for `phydrv`.
    if (!current && !currentLink && !currentZone && !currentWeapon
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'dynamiccolor') {
      currentDynamicColor = {
        name: null,
        channels: {
          red: { min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: null },
          green: { min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: null },
          blue: { min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: null },
          alpha: { min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: null },
        },
      };
      continue;
    }
    if (currentDynamicColor) {
      if (token === 'end') {
        dynamicColorRegistry.push(currentDynamicColor);
        if (currentDynamicColor.name) {
          dynamicColorsByName.set(currentDynamicColor.name.toLowerCase(), currentDynamicColor);
        }
        currentDynamicColor = null;
        continue;
      }
      if (token === 'name') {
        const [, ...nameParts] = line.split(/\s+/);
        const dcName = nameParts.join(' ').replace(/"/g, '').trim();
        if (dcName) currentDynamicColor.name = dcName;
        continue;
      }
      if (token === 'red' || token === 'green' || token === 'blue' || token === 'alpha') {
        // `DynamicColor::read` -- each channel line names its own sub-type
        // (`limits`, `sinusoid`, `clampup`/`clampdown`, `sequence`), any
        // number of times each; `update` (`public/render.js`) combines
        // every one of them each frame rather than the last stated winning.
        const [, sub, ...nums] = line.split(/\s+/);
        const values = nums.map(Number);
        const channel = currentDynamicColor.channels[token];
        const subtype = (sub || '').toLowerCase();
        if (subtype === 'limits') {
          const [min, max] = values;
          if (Number.isFinite(min)) channel.min = Math.max(0, Math.min(1, min));
          if (Number.isFinite(max)) channel.max = Math.max(0, Math.min(1, max));
        } else if (subtype === 'sinusoid') {
          const [period, offset, weight] = values;
          if (Number.isFinite(period) && period >= 0.01 && Number.isFinite(weight) && weight > 0) {
            channel.sinusoids.push({ period, offset: Number.isFinite(offset) ? offset : 0, weight });
          }
        } else if (subtype === 'clampup' || subtype === 'clampdown') {
          const [period, offset, width] = values;
          if (Number.isFinite(period) && period >= 0.01) {
            const list = subtype === 'clampup' ? channel.clampUps : channel.clampDowns;
            list.push({
              period,
              offset: Number.isFinite(offset) ? offset : 0,
              width: Number.isFinite(width) ? width : 0,
            });
          }
        } else if (subtype === 'sequence') {
          const [period, offset, ...states] = values;
          if (Number.isFinite(period) && period >= 0.01 && states.length > 0) {
            channel.sequence = {
              period,
              offset: Number.isFinite(offset) ? offset : 0,
              // `DynamicColor::finalize` clamps every raw state into
              // colorMin(0)/colorMid(1)/colorMax(2) -- a stray 3+ (or
              // negative) in the file reads as whichever end it is closer to
              // rather than an out-of-range index client-side.
              states: states.map((v) => Math.max(0, Math.min(2, Math.round(v)))),
            };
          }
        }
        continue;
      }
      continue;
    }

    // `textureMatrix` / `end` (`CustomTextureMatrix.cxx`, `TextureMatrix.cxx`).
    // A named, time-varying UV transform -- registered the same way, for a
    // `material`'s own `texmat` to look up.
    if (!current && !currentLink && !currentZone && !currentWeapon
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'texturematrix') {
      currentTextureMatrix = {
        name: null,
        fixedShiftU: 0,
        fixedShiftV: 0,
        fixedScaleU: 1,
        fixedScaleV: 1,
        fixedSpin: 0,
        fixedCenterU: 0.5,
        fixedCenterV: 0.5,
        shiftU: 0,
        shiftV: 0,
        spin: 0,
        scaleUFreq: 0,
        scaleVFreq: 0,
        scaleU: 1,
        scaleV: 1,
        centerU: 0.5,
        centerV: 0.5,
      };
      continue;
    }
    if (currentTextureMatrix) {
      if (token === 'end') {
        textureMatrixRegistry.push(currentTextureMatrix);
        if (currentTextureMatrix.name) {
          textureMatricesByName.set(currentTextureMatrix.name.toLowerCase(), currentTextureMatrix);
        }
        currentTextureMatrix = null;
        continue;
      }
      if (token === 'name') {
        const [, ...nameParts] = line.split(/\s+/);
        const tmName = nameParts.join(' ').replace(/"/g, '').trim();
        if (tmName) currentTextureMatrix.name = tmName;
        continue;
      }
      if (token === 'fixedshift') {
        const [, u, v] = line.split(/\s+/).map(Number);
        if (Number.isFinite(u)) currentTextureMatrix.fixedShiftU = u;
        if (Number.isFinite(v)) currentTextureMatrix.fixedShiftV = v;
        continue;
      }
      if (token === 'fixedscale') {
        // `TextureMatrix::setFixedScale` -- 0 leaves the prior value (1)
        // alone rather than zeroing the scale out.
        const [, u, v] = line.split(/\s+/).map(Number);
        if (Number.isFinite(u) && u !== 0) currentTextureMatrix.fixedScaleU = u;
        if (Number.isFinite(v) && v !== 0) currentTextureMatrix.fixedScaleV = v;
        continue;
      }
      if (token === 'fixedspin') {
        const [, deg] = line.split(/\s+/).map(Number);
        if (Number.isFinite(deg)) currentTextureMatrix.fixedSpin = deg;
        continue;
      }
      if (token === 'fixedcenter') {
        const [, u, v] = line.split(/\s+/).map(Number);
        if (Number.isFinite(u)) currentTextureMatrix.fixedCenterU = u;
        if (Number.isFinite(v)) currentTextureMatrix.fixedCenterV = v;
        continue;
      }
      if (token === 'shift') {
        const [, uFreq, vFreq] = line.split(/\s+/).map(Number);
        if (Number.isFinite(uFreq)) currentTextureMatrix.shiftU = uFreq;
        if (Number.isFinite(vFreq)) currentTextureMatrix.shiftV = vFreq;
        continue;
      }
      if (token === 'spin') {
        const [, freq] = line.split(/\s+/).map(Number);
        if (Number.isFinite(freq)) currentTextureMatrix.spin = freq;
        continue;
      }
      if (token === 'scale') {
        // `TextureMatrix::setScale` -- a uScale/vScale under 1.0 leaves the
        // prior value (1, no scaling) alone rather than shrinking below it.
        const [, uFreq, vFreq, uScale, vScale] = line.split(/\s+/).map(Number);
        if (Number.isFinite(uFreq)) currentTextureMatrix.scaleUFreq = uFreq;
        if (Number.isFinite(vFreq)) currentTextureMatrix.scaleVFreq = vFreq;
        if (Number.isFinite(uScale) && uScale >= 1.0) currentTextureMatrix.scaleU = uScale;
        if (Number.isFinite(vScale) && vScale >= 1.0) currentTextureMatrix.scaleV = vScale;
        continue;
      }
      if (token === 'center') {
        const [, u, v] = line.split(/\s+/).map(Number);
        if (Number.isFinite(u)) currentTextureMatrix.centerU = u;
        if (Number.isFinite(v)) currentTextureMatrix.centerV = v;
        continue;
      }
      continue;
    }

    // `waterLevel` / `end` (`CustomWaterLevel.cxx`). One plane, the whole
    // width of the world, at a fixed height -- a map-wide singleton like
    // `noWalls`, not an obstacle, so this fills in `mapWaterLevel` directly on
    // `end` rather than collecting into a registry a `matref` looks up later.
    if (!current && !currentLink && !currentZone && !currentWeapon && !currentDefine
      && !currentMaterial && !currentPhysicsDriver && !currentDynamicColor && !currentTextureMatrix
      && !currentWaterLevel
      && token === 'waterlevel') {
      currentWaterLevel = {
        height: 0,
        // `WorldInfo::makeWaterMaterial` (`WorldInfo.cxx:147-170`) -- the
        // default a map's own material lines (read below, the same as a
        // `material` block's own) overwrite as they're read. bzo has no
        // alpha channel on a plain `color`/`diffuse` line (docs/bzw.md,
        // "Colour"), so the 0.9 alpha upstream's own default carries is
        // water's own fixed translucency in `render.js` instead of part of
        // this tint.
        texture: 'water', textureUrl: null, color: [0.65, 1.0, 0.5],
        noRadar: true, noLighting: false, dynamicColor: null,
        textureMatrix: DEFAULT_WATER_TEXTURE_MATRIX,
      };
      continue;
    }
    if (currentWaterLevel) {
      if (token === 'end') {
        mapWaterLevel = currentWaterLevel;
        currentWaterLevel = null;
        continue;
      }
      if (token === 'height') {
        // A height on the world's own +Z, the same axis as a `position`'s z.
        const [, height] = line.split(/\s+/).map(Number);
        if (Number.isFinite(height)) currentWaterLevel.height = height;
        continue;
      }
      if (applyBzwMaterialToken(currentWaterLevel, token, line.split(/\s+/))) {
        continue;
      }
      // `name`, and everything else a plain `WorldFileObject` reads
      // (`passable` and friends) -- meaningless on a plane that always
      // covers the whole world, and upstream's own `writeToWorld` never
      // reads any of them back either.
      continue;
    }

    if (consumedBlock) {
      if (token === 'end') consumedBlock = null;
      continue;
    }
    if (token === 'options') {
      consumedBlock = 'options';
      continue;
    }

    // `define <name>` / `enddef` (CustomGroup's template registry). Upstream
    // refuses to nest one define inside another (BZWReader.cxx warns and skips
    // it), so a `define` seen while one is already open is dropped the same way.
    if (!current && !currentLink && !currentZone && !currentWeapon && !currentDefine && !currentWaterLevel
      && token === 'define') {
      const [, name] = line.split(/\s+/);
      if (name) {
        currentDefine = { name, obstacles: [], groupInstances: [], meshes: [] };
      } else {
        warn(`Ignoring "define" with no name in ${mapLabel}`);
      }
      continue;
    }
    if (currentDefine && !current && token === 'enddef') {
      if (defineTemplates.has(currentDefine.name)) {
        warn(`Duplicate group definition "${currentDefine.name}" in ${mapLabel}, using the newest`);
      }
      defineTemplates.set(currentDefine.name, {
        obstacles: currentDefine.obstacles,
        groupInstances: currentDefine.groupInstances,
        meshes: currentDefine.meshes,
      });
      // A definition's own meshes reach `meshes` only once a `group`
      // instance actually places it (below), same as its box/pyramid
      // members already reach `obstacles` -- a definition nothing ever
      // instantiates contributes nothing, meshes included.
      currentDefine = null;
      continue;
    }

    if (!current && !currentLink && token === 'zone') {
      currentZone = {
        index: zones.length,
        x: 0,
        y: 0,
        z: 0,
        halfWidth: 0,
        halfDepth: 0,
        rotation: 0,
        flagCounts: new Map(),
        flagTypes: new Set(),
        unknownFlags: new Set(),
        teams: new Set(),
        safety: new Set(),
      };
      continue;
    }

    if (token === 'world') {
      consumedBlock = 'world';
      // Look ahead through the block for every field bzo reads on it, rather
      // than stopping at the first one found -- a map may state `size` after
      // `noWalls`, and upstream's own `WorldFileLocation::read` has no
      // ordering requirement either.
      for (let j = i + 1; j < lines.length; j++) {
        const wline = lines[j].trim();
        const wtoken = wline.split(/\s+/)[0].toLowerCase();
        if (wtoken === 'end') break;
        if (wtoken === 'size') {
          const [, size] = wline.split(/\s+/);
          if (size) {
            mapSize = parseFloat(size) * 2;
          }
        } else if (wtoken === 'flagheight') {
          // No lower bound upstream (CustomWorld.cxx:39-42 sets `_fHeight`
          // straight from the stream) -- 0 is a real value, not "unset", the
          // same reasoning `docs/bzw.md` already gives box/pyramid `size` for
          // "A zero height is a real height."
          const [, height] = wline.split(/\s+/);
          const parsed = parseFloat(height);
          if (Number.isFinite(parsed) && parsed >= 0) mapFlagHeight = parsed;
        } else if (wtoken === 'nowalls') {
          mapNoWalls = true;
        } else if (wtoken === 'freectfspawns') {
          mapFreeCtfSpawns = true;
        }
      }
    // `angle` is stated here rather than left to whether the block carries a
    // `rotation` line, because everything downstream turns it into a cosine: a
    // box or a pyramid with no rotation is a box at angle 0, and saying so
    // once is what lets the client, the collision pair and every log read the
    // field instead of guessing a default for it. The rest of the shape has the
    // same treatment further down, where `end` fills in what the block left out.
    } else if (token === 'box') {
      // CustomBox's own size until a `size` line says otherwise (CustomBox.cxx:49).
      current = { type: 'box', angle: 0, size: [worldBoxBase, worldBoxBase, worldBoxHeight] };
    } else if (token === 'pyramid') {
      // CustomPyramid's, likewise (CustomPyramid.cxx:50).
      current = { type: 'pyramid', angle: 0, size: [worldPyrBase, worldPyrBase, worldPyrHeight] };
    } else if (token === 'base') {
      current = { type: 'box', kind: 'base', team: 1, angle: 0 };
    } else if (token === 'teleporter') {
      current = { type: 'box', kind: 'teleporter', angle: 0 };
      const [, ...teleporterNameParts] = line.split(/\s+/);
      const inlineTeleporterName = teleporterNameParts.join(' ').replace(/"/g, '').trim();
      if (inlineTeleporterName) {
        current.name = inlineTeleporterName;
      }
    } else if (token === 'group') {
      // `spin` is the group's own rotation in radians, counter-clockwise about
      // +Z -- it turns each member's position about the group's origin and
      // adds to each member's own `angle`. See the `rotation`/`rot` branch.
      const [, groupDefName] = line.split(/\s+/);
      //
      // `transformOps` and `xformPos`/`xformSize`/`xformRotation` are the same
      // block read the way upstream reads it (`WorldFileLocation::read`), kept
      // beside the box-model fields above for the one case those cannot say:
      // a group spun off vertical or sheared, which tips every mesh it places.
      current = {
        type: 'group', groupDefName: groupDefName || '', spin: 0, scale: [1, 1, 1],
        transformOps: [], xformPos: null, xformSize: null, xformRotation: 0, tipped: false,
      };
    } else if (token === 'tetra') {
      // CustomTetra's own defaults (CustomTetra.cxx:27-38): `drivethrough`/
      // `shootthrough`/`ricochet` are WorldFileObstacle's usual false, and
      // each of the four triangular faces defaults to upstream's own stock
      // "mesh" texture independently -- a material line before the first
      // `vertex` sets all four at once, one stated after the Nth sets only
      // that vertex's own face slot (CustomTetra::read's `vc = vertexCount
      // - 1`, clamped to 3 once all four are read) -- see the branch below.
      current = {
        type: 'tetra', name: null,
        definedIn: currentDefine ? currentDefine.name : null,
        vertexPositions: [],
        transformOps: [],
        faceMaterials: [0, 1, 2, 3].map(() => (
          { texture: 'mesh', textureUrl: null, color: null, noRadar: false, noLighting: false }
        )),
        driveThrough: false, shootThrough: false, ricochet: false,
      };
    } else if (current && current.type === 'tetra') {
      // A `tetra`'s own grammar: up to four `vertex` lines (no shared pool,
      // unlike `mesh` -- CustomTetra keeps its own four-slot array), each
      // one's own material read either before any vertex (every face) or
      // right after it (that face alone). `normals`/`texcoords` are read
      // and discarded rather than wired to a face: upstream's own
      // `TetraBuilding::makeMesh` never attaches them either (`MeshUtils.h`'s
      // shared `addFace` helper always receives empty normal/texcoord index
      // lists for a tetra's four faces, `TetraBuilding.cxx:110-121`), so a
      // tetra always falls back to bzo's generic per-face auto-planar UV --
      // matching real bzflag exactly, not a gap on bzo's side.
      const words = line.split(/\s+/);
      if (token === 'end') {
        if (current.vertexPositions.length < 4) {
          warn(`Not creating tetrahedron in ${mapLabel}, not enough vertices (${current.vertexPositions.length})`);
        } else {
          const tetraMesh = buildTetraMesh(current);
          tetraMesh.transformOps = current.transformOps;
          applyMeshTransform(tetraMesh);
          if (currentDefine) {
            currentDefine.meshes.push(tetraMesh);
          } else {
            meshes.push(finalizeMeshGeometry(tetraMesh));
          }
        }
        current = null;
      } else if (token === 'vertex') {
        if (current.vertexPositions.length >= 4) {
          warn(`Extra tetrahedron vertex in ${mapLabel}, ignoring`);
        } else {
          const [x, y, z] = words.slice(1).map(Number);
          current.vertexPositions.push({ x: x || 0, y: y || 0, z: z || 0 });
        }
      } else if (readMeshTransformToken(current, token, words)) {
        // See the same arm on `cone`/`arc`/`sphere` below.
      } else if (token === 'normals' || token === 'texcoords') {
        // See the comment above -- intentionally a no-op.
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else {
        const vc = Math.min(Math.max(current.vertexPositions.length - 1, 0), 3);
        if (current.vertexPositions.length === 0) {
          current.faceMaterials.forEach((mat) => applyBzwMaterialToken(mat, token, words));
        } else {
          applyBzwMaterialToken(current.faceMaterials[vc], token, words);
        }
      }
    } else if (token === 'cone' || token === 'meshpyr') {
      // `CustomCone`'s own defaults (CustomCone.cxx:43-75): `meshpyr` is the
      // exact same generator as `cone`, just constructed with `pyramid=true`
      // (`BZWReader.cxx`'s own `new CustomCone(true)` for the keyword) --
      // 4 divisions instead of 16, flat shading instead of smooth, its own
      // default size pulled from a plain pyramid's (`_pyrBase`/`_pyrHeight`),
      // and every one of its four faces defaulting to "pyrwall" rather than
      // a cone's own boxwall/roof/wall/wall. `position`/`size`/`rotation`
      // are kept in upstream's own raw BZW terms (see `buildConeMesh`) --
      // this parses the same as every other obstacle's, it's only the
      // *storage* that differs, until the generator converts once at `end`.
      const isPyramid = token === 'meshpyr';
      current = {
        type: 'cone', name: null,
        definedIn: currentDefine ? currentDefine.name : null,
        isPyramid,
        position: { x: 0, y: 0, z: 0 },
        transformOps: [],
        extent: isPyramid
          ? { x: MESHPYR_DEFAULT_BASE, y: MESHPYR_DEFAULT_BASE, z: MESHPYR_DEFAULT_HEIGHT }
          : { x: 10, y: 10, z: 10 },
        heading: 0,
        sweepDeg: 360,
        divisions: isPyramid ? 4 : 16,
        texsize: { u: -8, v: -8 },
        useNormals: !isPyramid,
        flipz: false,
        smoothBounce: false,
        phydrv: null,
        driveThrough: false, shootThrough: false, ricochet: false,
        materials: isPyramid
          ? [0, 1, 2, 3].map(() => ({ texture: 'pyrwall', textureUrl: null, color: null, noRadar: false, noLighting: false }))
          : ['boxwall', 'roof', 'wall', 'wall'].map((texture) => (
            { texture, textureUrl: null, color: null, noRadar: false, noLighting: false }
          )),
      };
    } else if (current && current.type === 'cone') {
      const words = line.split(/\s+/);
      if (token === 'end') {
        const coneMesh = buildConeMesh(current);
        if (!coneMesh) {
          warn(`Not creating ${current.isPyramid ? 'meshpyr' : 'cone'} in ${mapLabel}, invalid size/divisions/texsize`);
        } else {
          coneMesh.transformOps = current.transformOps;
          applyMeshTransform(coneMesh);
          if (currentDefine) {
            currentDefine.meshes.push(coneMesh);
          } else {
            meshes.push(finalizeMeshGeometry(coneMesh));
          }
        }
        current = null;
      } else if (token === 'position' || token === 'pos') {
        const [x, y, z] = words.slice(1).map(Number);
        current.position = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (readMeshTransformToken(current, token, words)) {
        // `shift`/`scale`/`shear`/`spin` -- the ordered transform list,
        // folded into one matrix and applied to the finished mesh at `end`,
        // after this block's own `position`/`size`/`rotation`. That is
        // upstream's order: `writeToGroupDef` builds the trio into a
        // `MeshTransform` and then `append`s the stated list to it.
      } else if (token === 'size') {
        const [x, y, z] = words.slice(1).map(Number);
        current.extent = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (token === 'rotation' || token === 'rot') {
        // Upstream's own raw convention -- degrees CCW about +Z, no sign or
        // offset fixup -- since `buildConeMesh` bakes this straight into the
        // sweep math in the same BZW terms everything else there uses.
        current.heading = (parseFloat(words[1]) || 0) * Math.PI / 180;
      } else if (token === 'divisions') {
        const n = parseInt(words[1], 10);
        if (Number.isInteger(n)) current.divisions = n;
      } else if (token === 'angle') {
        // The sweep, not the heading -- `rotation` above is the heading.
        const deg = parseFloat(words[1]);
        if (!Number.isNaN(deg)) current.sweepDeg = deg;
      } else if (token === 'texsize') {
        const [, u, v] = words;
        current.texsize = { u: parseFloat(u) || current.texsize.u, v: parseFloat(v) || current.texsize.v };
      } else if (token === 'phydrv') {
        current.phydrv = words[1] || null;
      } else if (token === 'smoothbounce') {
        current.smoothBounce = true;
      } else if (token === 'flatshading') {
        current.useNormals = false;
      } else if (current.isPyramid && token === 'flipz') {
        current.flipz = true;
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else if (CONE_SIDE_NAMES.has(token)) {
        const subWords = words.slice(1);
        applyBzwMaterialToken(current.materials[CONE_SIDE_NAMES.get(token)], (subWords[0] || '').toLowerCase(), subWords);
      } else {
        current.materials.forEach((mat) => applyBzwMaterialToken(mat, token, words));
      }
    } else if (token === 'arc' || token === 'meshbox') {
      // `CustomArc`'s own defaults (CustomArc.cxx:44-73): `meshbox` is the
      // exact same generator as `arc`, just constructed with `box=true`
      // (`BZWReader.cxx`'s own `new CustomArc(true)` for the keyword) -- 4
      // divisions instead of 16, flat shading instead of smooth, its own
      // default size pulled from a plain box's (`_boxBase`/`_boxHeight`),
      // but the *same* default materials as a plain `arc` -- unlike
      // `meshpyr`, `CustomArc`'s constructor never branches on `boxStyle` to
      // change them. `ratio` (1 collapses the inner radius to zero, an
      // ordinary solid wedge; less than that is a genuinely hollow tube)
      // and a 4-value `texsize` (edge U, edge V, disc U, disc V -- the last
      // two only used by the solid case) are `arc`'s own two differences
      // from `cone`.
      const isBox = token === 'meshbox';
      current = {
        type: 'arc', name: null,
        definedIn: currentDefine ? currentDefine.name : null,
        isBox,
        position: { x: 0, y: 0, z: 0 },
        transformOps: [],
        extent: isBox
          ? { x: worldBoxBase, y: worldBoxBase, z: worldBoxHeight }
          : { x: 10, y: 10, z: 10 },
        heading: 0,
        sweepDeg: 360,
        ratio: 1,
        divisions: isBox ? 4 : 16,
        texsize: {
          u: -8, v: -8, du: -8, dv: -8,
        },
        useNormals: !isBox,
        smoothBounce: false,
        phydrv: null,
        driveThrough: false, shootThrough: false, ricochet: false,
        materials: ['roof', 'roof', 'boxwall', 'boxwall', 'wall', 'wall'].map((texture) => (
          { texture, textureUrl: null, color: null, noRadar: false, noLighting: false }
        )),
      };
    } else if (current && current.type === 'arc') {
      const words = line.split(/\s+/);
      if (token === 'end') {
        const arcMesh = buildArcMesh(current);
        if (!arcMesh) {
          warn(`Not creating ${current.isBox ? 'meshbox' : 'arc'} in ${mapLabel}, invalid size/divisions/ratio/texsize`);
        } else {
          arcMesh.transformOps = current.transformOps;
          applyMeshTransform(arcMesh);
          if (currentDefine) {
            currentDefine.meshes.push(arcMesh);
          } else {
            meshes.push(finalizeMeshGeometry(arcMesh));
          }
        }
        current = null;
      } else if (token === 'position' || token === 'pos') {
        const [x, y, z] = words.slice(1).map(Number);
        current.position = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (readMeshTransformToken(current, token, words)) {
        // `shift`/`scale`/`shear`/`spin` -- the ordered transform list,
        // folded into one matrix and applied to the finished mesh at `end`,
        // after this block's own `position`/`size`/`rotation`. That is
        // upstream's order: `writeToGroupDef` builds the trio into a
        // `MeshTransform` and then `append`s the stated list to it.
      } else if (token === 'size') {
        const [x, y, z] = words.slice(1).map(Number);
        current.extent = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (token === 'rotation' || token === 'rot') {
        current.heading = (parseFloat(words[1]) || 0) * Math.PI / 180;
      } else if (token === 'divisions') {
        const n = parseInt(words[1], 10);
        if (Number.isInteger(n)) current.divisions = n;
      } else if (token === 'angle') {
        const deg = parseFloat(words[1]);
        if (!Number.isNaN(deg)) current.sweepDeg = deg;
      } else if (token === 'ratio') {
        const ratio = parseFloat(words[1]);
        if (!Number.isNaN(ratio)) current.ratio = ratio;
      } else if (token === 'texsize') {
        const [, u, v, du, dv] = words;
        current.texsize = {
          u: parseFloat(u) || current.texsize.u,
          v: parseFloat(v) || current.texsize.v,
          du: parseFloat(du) || current.texsize.du,
          dv: parseFloat(dv) || current.texsize.dv,
        };
      } else if (token === 'phydrv') {
        current.phydrv = words[1] || null;
      } else if (token === 'smoothbounce') {
        current.smoothBounce = true;
      } else if (token === 'flatshading') {
        current.useNormals = false;
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else if (ARC_SIDE_NAMES.has(token)) {
        const subWords = words.slice(1);
        applyBzwMaterialToken(current.materials[ARC_SIDE_NAMES.get(token)], (subWords[0] || '').toLowerCase(), subWords);
      } else {
        current.materials.forEach((mat) => applyBzwMaterialToken(mat, token, words));
      }
    } else if (token === 'sphere') {
      // `CustomSphere`'s own defaults (CustomSphere.cxx:34-47) -- notably a
      // default `position` of `0 0 10` (not the usual origin), so a mapper
      // who never writes one still gets a radius-10 sphere resting on the
      // ground rather than centred on it, and `divisions` defaulting to 4
      // rather than a cone's 16 (this generator's own face count grows with
      // the *square* of `divisions`, `divisions**2 * 8`, not linearly).
      current = {
        type: 'sphere', name: null,
        definedIn: currentDefine ? currentDefine.name : null,
        position: { x: 0, y: 0, z: 10 },
        transformOps: [],
        extent: { x: 10, y: 10, z: 10 },
        heading: 0,
        divisions: 4,
        hemisphere: false,
        texsize: { u: -4, v: -4 },
        useNormals: true,
        smoothBounce: false,
        phydrv: null,
        driveThrough: false, shootThrough: false, ricochet: false,
        materials: ['boxwall', 'roof'].map((texture) => (
          { texture, textureUrl: null, color: null, noRadar: false, noLighting: false }
        )),
      };
    } else if (current && current.type === 'sphere') {
      const words = line.split(/\s+/);
      if (token === 'end') {
        const sphereMesh = buildSphereMesh(current);
        if (!sphereMesh) {
          warn(`Not creating sphere in ${mapLabel}, invalid size/divisions/texsize`);
        } else {
          sphereMesh.transformOps = current.transformOps;
          applyMeshTransform(sphereMesh);
          if (currentDefine) {
            currentDefine.meshes.push(sphereMesh);
          } else {
            meshes.push(finalizeMeshGeometry(sphereMesh));
          }
        }
        current = null;
      } else if (token === 'position' || token === 'pos') {
        const [x, y, z] = words.slice(1).map(Number);
        current.position = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (readMeshTransformToken(current, token, words)) {
        // `shift`/`scale`/`shear`/`spin` -- the ordered transform list,
        // folded into one matrix and applied to the finished mesh at `end`,
        // after this block's own `position`/`size`/`rotation`. That is
        // upstream's order: `writeToGroupDef` builds the trio into a
        // `MeshTransform` and then `append`s the stated list to it.
      } else if (token === 'size') {
        const [x, y, z] = words.slice(1).map(Number);
        current.extent = { x: x || 0, y: y || 0, z: z || 0 };
      } else if (token === 'radius') {
        const radius = parseFloat(words[1]);
        if (!Number.isNaN(radius)) current.extent = { x: radius, y: radius, z: radius };
      } else if (token === 'rotation' || token === 'rot') {
        current.heading = (parseFloat(words[1]) || 0) * Math.PI / 180;
      } else if (token === 'divisions') {
        const n = parseInt(words[1], 10);
        if (Number.isInteger(n)) current.divisions = n;
      } else if (token === 'hemi' || token === 'hemisphere') {
        current.hemisphere = true;
      } else if (token === 'texsize') {
        const [, u, v] = words;
        current.texsize = { u: parseFloat(u) || current.texsize.u, v: parseFloat(v) || current.texsize.v };
      } else if (token === 'phydrv') {
        current.phydrv = words[1] || null;
      } else if (token === 'smoothbounce') {
        current.smoothBounce = true;
      } else if (token === 'flatshading') {
        current.useNormals = false;
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else if (SPHERE_SIDE_NAMES.has(token)) {
        const subWords = words.slice(1);
        applyBzwMaterialToken(current.materials[SPHERE_SIDE_NAMES.get(token)], (subWords[0] || '').toLowerCase(), subWords);
      } else {
        current.materials.forEach((mat) => applyBzwMaterialToken(mat, token, words));
      }
    } else if (token === 'mesh') {
      // CustomMesh's own defaults -- a mesh's default texture is upstream's
      // stock "mesh" (a wireframe/grid picture, unrelated to mesh geometry --
      // see the callout in docs/bzw.md's Materials section), and driveThrough/
      // shootThrough/ricochet/phydrv/noclusters/smoothBounce all start unset,
      // the same as `WorldFileObstacle`'s own obstacle defaults.
      current = {
        type: 'mesh', name: null,
        // Which `define` this mesh was read inside, if any -- kept on a
        // placed copy too (see `applyGroupInstanceTransformToMesh`) purely
        // for debugging which template a mesh reaching the client came from.
        definedIn: currentDefine ? currentDefine.name : null,
        vertices: [], normals: [], texcoords: [], faces: [], checkPoints: [],
        phydrv: null, noclusters: false, smoothBounce: false, decorative: false,
        driveThrough: false, shootThrough: false, ricochet: false,
        texture: 'mesh', textureUrl: null, color: null, noRadar: false, noLighting: false,
        specular: null, emission: null, shininess: null, alphaThreshold: null,
        noSorting: false, useTextureAlpha: true, useColorOnTexture: true,
        // `MeshTransform`'s own ordered `shift`/`scale`/`shear`/`spin`
        // list, plus the `position`/`size`/`rotation` trio that is shorthand
        // for one of each -- both folded into one matrix at `end`, below.
        transformOps: [],
        xformPos: null, xformSize: null, xformRotation: 0,
        // `drawInfo`'s own render-only surface, and the pools it may bring
        // with it -- see `readMeshDrawInfoLine`. Null unless a map states one.
        drawFaces: null, drawVertices: null, drawNormals: null, drawTexcoords: null,
        // `MeshDrawInfo`'s own `angvel` (#88, degrees/sec) -- upstream states
        // it inside an unrelated render-optimization sub-block bzo does not
        // otherwise read (`drawInfo { ... }`, see `server/remote-world-
        // import.cjs`'s `printMesh`), so bzo takes it as a plain mesh
        // property instead. 0 (no spin) unless a mesh states it.
        angvel: 0,
      };
      currentMeshFace = null;
    } else if (current && current.type === 'mesh') {
      // A mesh's own grammar -- its vertex/normal/texcoord pools, its
      // checkpoints, its own defaults, and the `face`/`endface` blocks that
      // read off them -- kept self-contained here rather than folded into
      // the generic per-obstacle branches below, since nothing else parsed
      // in this function has a face nested inside it.
      const words = line.split(/\s+/);
      if (token === 'drawinfo') {
        currentDrawInfo = {
          depth: 0, closed: false,
          corners: [], vertices: [], normals: [], texcoords: [],
          // Only the first `lod` is kept. Upstream picks one per frame by
          // `lengthPerPixel` against the screen size (`MeshSceneNode::
          // notifyStyleChange`); bzo has no LOD machinery, so it takes the
          // one a map lists first, which is the highest detail.
          lod: null, set: null,
        };
      } else if (currentMeshFace) {
        // Inside `face` / `endface`. Every property here is scoped to this
        // one face, which already started from the mesh's own defaults at
        // the moment `face` was read, below -- CustomMeshFace's own
        // constructor snapshot.
        if (token === 'endface') {
          if (currentMeshFace.vertexIndices.length < 3) {
            warn(`Ignoring a mesh face with fewer than 3 vertices in ${mapLabel}`);
          } else {
            current.faces.push(currentMeshFace);
          }
          currentMeshFace = null;
        } else if (token === 'vertices') {
          currentMeshFace.vertexIndices = words.slice(1).map(Number).filter(Number.isInteger);
        } else if (token === 'normals') {
          currentMeshFace.normalIndices = words.slice(1).map(Number).filter(Number.isInteger);
        } else if (token === 'texcoords') {
          currentMeshFace.texcoordIndices = words.slice(1).map(Number).filter(Number.isInteger);
        } else if (token === 'phydrv') {
          currentMeshFace.phydrv = words[1] || null;
        } else if (token === 'smoothbounce') {
          currentMeshFace.smoothBounce = true;
        } else if (token === 'noclusters') {
          currentMeshFace.noclusters = true;
        } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
          Object.assign(currentMeshFace, BZW_PASSABILITY_KEYWORDS.get(token));
        } else {
          applyBzwMaterialToken(currentMeshFace, token, words);
        }
      } else if (token === 'end') {
        // A supported obstacle now (see the note on `meshes` above), so this
        // does not touch `unsupportedCounts` -- but still does not fold into
        // the generic `current && token === 'end'` obstacle-closing branch
        // below, which assumes a finished box/pyramid/group.
        // A mesh with vertices but zero faces draws and collides as nothing
        // -- not a mapper error bzo can see in the text (a real `mesh`
        // block, correctly closed), but the signature a source mesh built
        // with BZFlag's MeshDrawInfo optimization leaves once reconstructed
        // from a remote server's wire protocol, which does not carry that
        // format's actual geometry at all (see `parseMesh` in
        // `server/remote-world-import.cjs`). Worth a warning either way: an
        // operator who hand-wrote a genuinely empty mesh gets the same nudge
        // to remove it.
        if (current.vertices.length > 0 && current.faces.length === 0
          && !(current.drawFaces && current.drawFaces.length > 0)) {
          warn(`Ignoring mesh "${current.name || current.definedIn || '(unnamed)'}" in ${mapLabel}, `
            + `${current.vertices.length} vertices with no faces`);
        }
        // The mesh's own transform, baked into its points here -- upstream
        // hands the same folded matrix to `MeshObstacle`'s constructor
        // (`CustomMesh::writeToGroupDef`), so it is part of what the mesh
        // *is* before anything places it. A `group` instance's own transform
        // then applies on top, the same order as upstream's, where the
        // instance's modifier runs at `makeGroups` time.
        //
        // `position`/`size`/`rotation` are the older spelling of one scale,
        // one spin about the vertical and one shift, in that order, and
        // upstream prepends them to whatever the explicit list already holds
        // (`xform.append(transform)`) rather than replacing it -- so a mesh
        // may state both, and the trio happens first.
        if (current.xformSize || current.xformRotation || current.xformPos) {
          const oldStyle = [];
          const size = current.xformSize;
          if (size && (size[0] !== 1 || size[1] !== 1 || size[2] !== 1)) {
            oldStyle.push({ type: 'scale', data: [size[0], size[1], size[2], 0] });
          }
          if (current.xformRotation) {
            oldStyle.push({ type: 'spin', data: [0, 0, 1, current.xformRotation] });
          }
          const pos = current.xformPos;
          if (pos && (pos[0] !== 0 || pos[1] !== 0 || pos[2] !== 0)) {
            oldStyle.push({ type: 'shift', data: [pos[0], pos[1], pos[2], 0] });
          }
          current.transformOps = [...oldStyle, ...current.transformOps];
        }
        applyMeshTransform(current);
        if (currentDefine) {
          // Still a template in its own local frame -- `finalizeMeshGeometry`
          // runs later, once a `group` instance places it (or not at all, if
          // nothing ever does), never here.
          currentDefine.meshes.push(current);
        } else {
          meshes.push(finalizeMeshGeometry(current));
        }
        current = null;
      } else if (token === 'vertex') {
        const [x, y, z] = words.slice(1).map(Number);
        current.vertices.push({ x: x || 0, y: y || 0, z: z || 0 });
      } else if (token === 'normal') {
        const [x, y, z] = words.slice(1).map(Number);
        current.normals.push({ x: x || 0, y: y || 0, z: z || 0 });
      } else if (token === 'texcoord') {
        const [u, v] = words.slice(1).map(Number);
        current.texcoords.push({ u: u || 0, v: v || 0 });
      } else if (token === 'inside' || token === 'outside') {
        const [x, y, z] = words.slice(1).map(Number);
        current.checkPoints.push({ x: x || 0, y: y || 0, z: z || 0, inside: token === 'inside' });
      } else if (token === 'phydrv') {
        current.phydrv = words[1] || null;
      } else if (token === 'smoothbounce') {
        current.smoothBounce = true;
      } else if (token === 'noclusters') {
        current.noclusters = true;
      } else if (token === 'decorative') {
        current.decorative = true;
      } else if (token === 'angvel') {
        current.angvel = Number(words[1]) || 0;
      } else if (readMeshTransformToken(current, token, words)) {
        // `shift`/`scale`/`shear`/`spin` -- one ordered list, folded into a
        // matrix at `end`. Unlike a box or a `group`, where bzo takes only a
        // spin about the map's own vertical (nothing else survives an
        // axis-aligned model), a mesh spins about any axis at all: its
        // vertices are arbitrary points and the matrix is exact.
      } else if (token === 'position' || token === 'pos') {
        const [x, y, z] = words.slice(1).map(Number);
        current.xformPos = [x || 0, y || 0, z || 0];
      } else if (token === 'size') {
        const [x, y, z] = words.slice(1).map(Number);
        current.xformSize = [x ?? 1, y ?? 1, z ?? 1];
      } else if (token === 'rotation' || token === 'rot') {
        current.xformRotation = (Number(words[1]) || 0) * Math.PI / 180;
      } else if (token === 'face') {
        // CustomMeshFace's own constructor -- a snapshot of the mesh's
        // defaults as they stand right now, not a live reference to them:
        // a mesh-level line stated after this `face` affects only a later
        // face, never one already open or already closed.
        currentMeshFace = {
          vertexIndices: [], normalIndices: [], texcoordIndices: [],
          phydrv: current.phydrv, noclusters: current.noclusters,
          smoothBounce: current.smoothBounce,
          driveThrough: current.driveThrough, shootThrough: current.shootThrough,
          ricochet: false,
          texture: current.texture, textureUrl: current.textureUrl,
          color: current.color, noRadar: current.noRadar, noLighting: current.noLighting,
          specular: current.specular, emission: current.emission, shininess: current.shininess,
          alphaThreshold: current.alphaThreshold,
          ...bzwMaterialFlags(current),
        };
      } else if (BZW_PASSABILITY_KEYWORDS.has(token)) {
        Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
      } else if (token === 'name') {
        const [, ...nameParts] = words;
        const name = nameParts.join(' ').replace(/"/g, '').trim();
        if (name) current.name = name;
      } else if (!applyBzwMaterialToken(current, token, words)) {
        // `lod`, `drawInfo`, and a mesh's own position/size/rotation (its
        // transform -- not read yet, see docs/bzw-plan.md) all fall here,
        // along with any material property a mesh states inline that bzo has
        // no handling for. Counted rather than dropped in silence: a mesh is
        // where a map states `noculling` or `nosorting` on a billboard, and
        // those change what the map looks like.
        unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
      }
    } else if (current && current.type === 'group' && (token === 'size' || token === 'scale')) {
      // A group's `size` is CustomGroup's own name for what WorldFileLocation
      // itself calls `scale` (MeshTransform::addScale) -- both spellings are
      // read here, and a mapper may state either -- not a box's
      // half-extent: 1 1 1 leaves every member at its own size.
      const [, sx, sy, sz] = line.split(/\s+/);
      const parsedX = parseFloat(sx);
      const parsedY = parseFloat(sy);
      const parsedZ = parseFloat(sz);
      current.scale = [
        Number.isFinite(parsedX) ? parsedX : 1,
        Number.isFinite(parsedY) ? parsedY : 1,
        Number.isFinite(parsedZ) ? parsedZ : 1,
      ];
      if (token === 'scale') current.transformOps.push({ type: 'scale', data: [...current.scale, 0] });
      else current.xformSize = current.scale;
    } else if (current && current.type === 'group' && token === 'shear') {
      // No box-model equivalent at all, so only the meshes a sheared group
      // places can show it -- see `tipped` at the group's `end`.
      const [a, b, c] = line.split(/\s+/).slice(1).map(Number);
      current.transformOps.push({ type: 'shear', data: [a || 0, b || 0, c || 0, 0] });
      if (a || b || c) current.tipped = true;
    } else if (current && BZW_PASSABILITY_KEYWORDS.has(token)) {
      Object.assign(current, BZW_PASSABILITY_KEYWORDS.get(token));
    } else if (current && token === 'name') {
      // name <string>
      const [, ...nameParts] = line.split(/\s+/);
      const name = nameParts.join(' ').replace(/"/g, '').trim();
      if (name) current.name = name;
    } else if (current && (token === 'position' || token === 'pos' || token === 'shift')) {
      // position x y z, its `pos` alias, or `shift` -- WorldFileLocation's own
      // translate primitive, which `position` is shorthand for composing
      // with `size`/`rotation` (CustomGroup.cxx, CustomBox.cxx). A pure
      // translation never distorts a shape, so reading it the same as
      // `position` is exact, not an approximation -- unlike `scale`/`spin`,
      // which only line up with `size`/`rotation` on a `group` (see the
      // branches for each).
      const [, x, y, z] = line.split(/\s+/);
      current.pos = [parseFloat(x), parseFloat(y), parseFloat(z) || 0];
      if (current.type === 'group') {
        const pos = [parseFloat(x) || 0, parseFloat(y) || 0, parseFloat(z) || 0];
        if (token === 'shift') current.transformOps.push({ type: 'shift', data: [...pos, 0] });
        else current.xformPos = pos;
      }
    } else if (current && token === 'size') {
      // size w d h (BZFlag x/y are center-to-edge half extents, z is full height)
      const [, w, d, h] = line.split(/\s+/);
      const rawW = parseFloat(w);
      const rawD = parseFloat(d);
      const rawH = parseFloat(h);
      current.size = [Math.abs(rawW), Math.abs(rawD), Math.abs(rawH)];
      if (current.type === 'pyramid') {
        // Deferred to `end` (see its own comment) -- whether a negative
        // height here means a real flip depends on whether a per-face
        // command shows up anywhere else in this same block, which may
        // still be ahead of this line.
        current.rawH = rawH;
      }
    } else if (current && (token === 'rotation' || token === 'rot')) {
      // rotation <deg>, counter-clockwise about +Z.
      const [, deg] = line.split(/\s+/);
      current.angle = (parseFloat(deg) || 0) * Math.PI / 180;
      if (current.type === 'group') {
        current.spin = (parseFloat(deg) || 0) * Math.PI / 180;
        current.xformRotation = current.spin;
      }
    } else if (current && token === 'spin') {
      // spin <deg> <ax> <ay> <az> (WorldFileLocation::read) -- the more
      // general primitive `rotation` is shorthand for, about the map's own
      // vertical axis. About any other axis it tips the shape off bzo's
      // axis-aligned box/pyramid model the same way `shear` always does, so
      // only a spin about the vertical is read here; any other axis is
      // counted for the load to name, same as an unresolved matref.
      const [, rawAngle, rawAx, rawAy, rawAz] = line.split(/\s+/).map(Number);
      const isVertical = Math.abs(rawAx || 0) < 1e-6 && Math.abs(rawAy || 0) < 1e-6
        && Math.abs(rawAz || 0) > 1e-6;
      if (current.type === 'group') {
        current.transformOps.push({
          type: 'spin', data: [rawAx || 0, rawAy || 0, rawAz || 0, (rawAngle || 0) * Math.PI / 180],
        });
      }
      if (isVertical) {
        const signedDeg = (rawAngle || 0) * Math.sign(rawAz);
        current.angle = signedDeg * Math.PI / 180;
        if (current.type === 'group') {
          current.spin = signedDeg * Math.PI / 180;
        }
      } else if (current.type === 'group') {
        // A mesh can tip, so the group's meshes take the whole transform;
        // only its boxes and pyramids are left upright, and counted where
        // the group is placed.
        if (rawAngle) current.tipped = true;
      } else {
        nonVerticalSpinCount++;
      }
    } else if (current && current.type === 'pyramid' && token === 'flipz') {
      // Deferred to `end` -- see its own comment on why `flipz` alone means
      // something different once a per-face command also shows up.
      current.explicitFlipZ = true;
    } else if (current && token === 'border') {
      const [, border] = line.split(/\s+/);
      current.border = Math.abs(parseFloat(border) || 0);
    } else if (current && token === 'phydrv'
      && (current.type === 'box' || current.type === 'pyramid' || current.type === 'group')) {
      // A plain box/pyramid's own whole-obstacle driver (`CustomBox.cxx`),
      // or a `group` instance's own only-if-unset override onto each member
      // (`CustomGroup.cxx:70-82`) -- applied to the members themselves
      // where a `group` instance is expanded, below.
      const [, driverName] = line.split(/\s+/);
      current.phydrv = driverName || null;
      if (current.type === 'pyramid') {
        // CustomPyramid.cxx: `phydrv` also flips `isOldPyramid` false, same
        // as any per-face command -- see the `end` handler.
        current.hasFaceCommand = true;
      }
      if (current.type !== 'group') current.meshedByBzfs = true;
    } else if (current && current.kind === 'base' && token === 'color') {
      const [, color] = line.split(/\s+/);
      const team = parseInt(color, 10);
      current.team = Number.isInteger(team) ? Math.max(1, Math.min(4, team)) : 1;
    } else if (current && current.type === 'group' && token === 'tint') {
      // `CustomGroup::read`'s own `tint` (`CustomGroup.cxx:58-67`) -- not a
      // material property at all, and read nowhere else in a map. It
      // multiplies each mesh face's diffuse RGBA component-wise
      // (`getTintedMaterial`, `ObstacleModifier.cxx:158-176`; ambient,
      // specular and emission are left alone there on purpose), and it is
      // applied *after* whatever `matref`/`addtexture` the same instance
      // states, so an instance can both replace a material and tint the
      // replacement. Two nested instances multiply, which falls out of
      // applying each level's own tint as the nesting unwinds.
      const tint = parseBzwColor(line.split(/\s+/).slice(1));
      if (tint) current.tint = tint;
    } else if (current && current.type === 'group'
      && (token === 'matref' || token === 'addtexture' || token === 'texture'
        || token === 'dyncol' || token === 'texmat')) {
      // A group instance's own material override -- unlike a box/pyramid's
      // walls/caps split just below, this is one plain material applied
      // wholesale to a mesh member's every face (`ObstacleModifier::execute`,
      // `ObstacleModifier.cxx:189-208`: `face->bzMaterial = material`,
      // unconditional), so it is kept as one resolved material object rather
      // than the wallTexture/capTexture pair a box reads the same tokens
      // into. `applyGroupMeshModifiers` (above `applyGroupInstanceTransform`)
      // is what actually applies it, once the member is known.
      current.materialOverride ??= {
        texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
        dynamicColor: null, textureMatrix: null,
        specular: null, emission: null, shininess: null, alphaThreshold: null,
        noSorting: false, useTextureAlpha: true, useColorOnTexture: true,
      };
      applyBzwMaterialToken(current.materialOverride, token, line.split(/\s+/));
    } else if (current && (BZW_FACE_GROUPS.has(token) || token === 'color' || token === 'diffuse'
      || token === 'matref' || token === 'addtexture' || token === 'texture'
      || token === 'noradar' || token === 'nolighting' || token === 'dyncol' || token === 'texmat')
      && current.kind !== 'base' && current.kind !== 'teleporter') {
      // The colour, texture or material a map paints an obstacle with, which
      // the branch above reads as a team on a base -- upstream's CustomBase
      // takes the word that way too -- and which a teleporter has no use for,
      // since bzo's carries its own materials. Everything else a material
      // block can say is skipped here rather than rejected: `top texsize 4 4`
      // names a face bzo understands and a property it does not, and arrives
      // as an untextured box either way.
      if (current.type === 'pyramid') {
        // CustomPyramid.cxx: any per-face command (sides/edge/bottom/a named
        // face, or that face's own matref/texture/color) flips isOldPyramid
        // to false -- see the `end` handler for what that changes.
        current.hasFaceCommand = true;
      }
      current.meshedByBzfs = true;
      const words = line.split(/\s+/);
      const group = BZW_FACE_GROUPS.get(token);
      const keyword = (group ? words[1] || '' : words[0]).toLowerCase();
      if (keyword === 'color' || keyword === 'diffuse') {
        const tint = parseBzwColor(words.slice(group ? 2 : 1));
        if (tint) {
          if (group !== 'caps') current.wallColor = tint;
          if (group !== 'walls') current.capColor = tint;
        }
      } else if (keyword === 'matref') {
        // `matref <name>` pulls in a whole named material -- its texture, its
        // tint and its noRadar/noLighting flags -- in one line, the same
        // only-if-stated way a plain `addtexture`/`color` line does below.
        // Read at this point in the sequence, so a property line stated after
        // it (upstream's own read order) still overrides what the material gave.
        const refName = (words[group ? 2 : 1] || '').toLowerCase();
        const material = materialsByName.get(refName);
        if (material) {
          if (group !== 'caps') {
            if (material.texture) { current.wallTexture = material.texture; current.wallTextureUrl = null; }
            else if (material.textureUrl) { current.wallTextureUrl = material.textureUrl; current.wallTexture = null; }
            if (material.color) current.wallColor = material.color;
            if (material.noLighting) current.wallNoLighting = true;
            if (material.dynamicColor) current.wallDynamicColor = material.dynamicColor;
            if (material.textureMatrix) current.wallTextureMatrix = material.textureMatrix;
            if (material.specular) current.wallSpecular = material.specular;
            if (material.emission) current.wallEmission = material.emission;
            if (material.shininess != null) current.wallShininess = material.shininess;
          }
          if (group !== 'walls') {
            if (material.texture) { current.capTexture = material.texture; current.capTextureUrl = null; }
            else if (material.textureUrl) { current.capTextureUrl = material.textureUrl; current.capTexture = null; }
            if (material.color) current.capColor = material.color;
            if (material.noLighting) current.capNoLighting = true;
            if (material.dynamicColor) current.capDynamicColor = material.dynamicColor;
            if (material.textureMatrix) current.capTextureMatrix = material.textureMatrix;
            if (material.specular) current.capSpecular = material.specular;
            if (material.emission) current.capEmission = material.emission;
            if (material.shininess != null) current.capShininess = material.shininess;
          }
          if (material.noRadar) current.noRadar = true;
        } else if (refName && refName !== '-1') {
          unresolvedMaterialRefs.add(refName);
        }
      } else if (keyword === 'addtexture' || keyword === 'texture') {
        const rawName = words.slice(group ? 2 : 1).join(' ');
        const resolved = resolveBzwTextureName(rawName);
        if (resolved?.stock) {
          if (group !== 'caps') { current.wallTexture = resolved.stock; current.wallTextureUrl = null; }
          if (group !== 'walls') { current.capTexture = resolved.stock; current.capTextureUrl = null; }
        } else if (resolved?.url) {
          if (group !== 'caps') { current.wallTextureUrl = resolved.url; current.wallTexture = null; }
          if (group !== 'walls') { current.capTextureUrl = resolved.url; current.capTexture = null; }
          externalTextureUrls.add(resolved.url);
        } else if (rawName) {
          unresolvedTextureNames.add(rawName);
        }
      } else if (keyword === 'dyncol') {
        const refName = (words[group ? 2 : 1] || '');
        const referenced = /^[0-9]/.test(refName)
          ? dynamicColorRegistry[parseInt(refName, 10)] || null
          : dynamicColorsByName.get(refName.toLowerCase()) || null;
        if (referenced) {
          if (group !== 'caps') current.wallDynamicColor = referenced;
          if (group !== 'walls') current.capDynamicColor = referenced;
        } else if (refName && refName !== '-1') {
          unresolvedDynamicColorRefs.add(refName.toLowerCase());
        }
      } else if (keyword === 'texmat') {
        const refName = (words[group ? 2 : 1] || '');
        const referenced = /^[0-9]/.test(refName)
          ? textureMatrixRegistry[parseInt(refName, 10)] || null
          : textureMatricesByName.get(refName.toLowerCase()) || null;
        if (referenced) {
          if (group !== 'caps') current.wallTextureMatrix = referenced;
          if (group !== 'walls') current.capTextureMatrix = referenced;
        } else if (refName && refName !== '-1') {
          unresolvedTextureMatrixRefs.add(refName.toLowerCase());
        }
      } else if (keyword === 'noradar') {
        current.noRadar = true;
      } else if (keyword === 'nolighting') {
        if (group !== 'caps') current.wallNoLighting = true;
        if (group !== 'walls') current.capNoLighting = true;
      }
    } else if (current && token === 'end') {
      if (current.type === 'group') {
        // No geometry of its own to place yet -- a `group` may name a `define`
        // the file hasn't reached, the same deferred resolution upstream gives
        // it, so every instance waits for the expansion pass below, once every
        // `define` in the file is known. One found inside a `define` block is
        // itself a template entry rather than a placement -- upstream's own
        // `GroupDefinition` holds its nested `group` instances the same way,
        // recursing into them only once something actually places *this*
        // definition (`GroupDefinition::makeGroups`).
        const instanceRequest = {
          groupDefName: current.groupDefName,
          name: current.name || null,
          pos: [current.pos?.[0] || 0, current.pos?.[1] || 0, current.pos?.[2] || 0],
          spin: current.spin || 0,
          scale: current.scale || [1, 1, 1],
          driveThrough: !!current.driveThrough,
          shootThrough: !!current.shootThrough,
          ricochet: !!current.ricochet,
          phydrv: current.phydrv || null,
          materialOverride: current.materialOverride || null,
          tint: current.tint || null,
          // Upstream's whole transform (`CustomGroup.cxx:129-139`: `size`,
          // `rotation`, `position`, then the ordered list), carried only
          // when the box-model fields above cannot say it.
          transformOps: current.tipped ? [
            ...(current.xformSize ? [{ type: 'scale', data: [...current.xformSize, 0] }] : []),
            ...(current.xformRotation ? [{ type: 'spin', data: [0, 0, 1, current.xformRotation] }] : []),
            ...(current.xformPos ? [{ type: 'shift', data: [...current.xformPos, 0] }] : []),
            ...current.transformOps,
          ] : null,
        };
        if (currentDefine) {
          currentDefine.groupInstances.push(instanceRequest);
        } else {
          groupInstanceRequests.push(instanceRequest);
        }
        current = null;
      } else {
        // CustomPyramid.cxx:319-350: a plain pyramid (no per-face command
        // anywhere in its block) builds a `PyramidBuilding` straight from
        // `fabsf()` of each size component, and negative height there really
        // is `setZFlip()` -- an actual, visible inversion. But the moment a
        // pyramid uses even one per-face command -- `sides`/`edge`/`bottom`/
        // an individual face name, a face's own `matref`/texture/color,
        // `texsize`, `texoffset`, or `phydrv` -- upstream's own `isOldPyramid`
        // flag goes false and it switches to building a `MeshTransform`
        // instead, scaled by the *signed*, non-`fabsf`'d size. `hix.bzw`
        // gives every one of its pyramids `sides matref`, so every one of
        // them takes this second path in real bzflag, and on this path a
        // negative height is not a flip at all: `position`'s own Z anchors
        // whichever end the sign points at (the apex when height is
        // negative, the base otherwise), and the shape extends by `|height|`
        // toward the other end -- so it is always apex-up, base-down, however
        // its height's sign was chosen for the map author's own convenience
        // in anchoring the piece. The one condition that still produces a
        // real, visible inversion here is upstream's own literal `flipz`
        // command with a *non-negative* height (`flipActive` below true from
        // `explicitFlipZ` alone) -- confirmed against `bz.rikers.org:5154`'s
        // own wire-protocol geometry for this exact map's support struts:
        // its cap pieces (negative height, no `flipz`) come back apex at the
        // stated position and base below it, base-down like every other
        // pyramid there.
        if (current.type === 'pyramid' && current.hasFaceCommand) {
          const rawH = Number.isFinite(current.rawH) ? current.rawH : current.size[2];
          const statedZ = current.pos?.[2] || 0;
          const flipActive = current.explicitFlipZ === true || rawH < 0;
          const apexZ = flipActive ? statedZ : statedZ + rawH;
          const baseZ = flipActive ? statedZ + rawH : statedZ;
          current.pos = [current.pos?.[0], current.pos?.[1], Math.min(apexZ, baseZ)];
          current.inverted = apexZ < baseZ;
          // `size[2]` is already `Math.abs(rawH)` from the `size` line -- unchanged.
        } else if (current.type === 'pyramid') {
          // Old-style pyramid (no per-face command at all): upstream's own
          // `isOldPyramid` path -- `position` is the base, and a negative height or literal `flipz`
          // really does mean `setZFlip()`. `pos` stays exactly as parsed.
          const rawH = Number.isFinite(current.rawH) ? current.rawH : current.size[2];
          current.inverted = rawH < 0 || current.explicitFlipZ === true;
        }

        // BaseBuilding::inMovingBox (BaseBuilding.cxx:77), in upstream's own words:
        // "if a base is just the ground (z == 0 && height == 0) no collision --
        // ground is already handled". A pad with no height is not something
        // anything can hit, so no map has to say so: a flush base or box is
        // passable by construction, to shots as much as to tanks.
        //
        // Upstream writes that guard on the base alone, because a zero-height box
        // is vanishingly rare there. Its *box* arithmetic has none, and the case
        // that exposes the difference is a burrowed tank: it drives below zero, so
        // its own span reaches up through a pad's [0, 0] and it stops dead on one.
        // `bzo.bzw` puts a pad under every flag zone, which turned that into
        // forty-two places a `BU` tank came to a halt.
        //
        // Read from the dimensions rather than from the keyword, so it is true of
        // every flush pad and not only of the ones somebody remembered to mark.
        // Teleporters are excluded because theirs are not final yet -- the block
        // below fills in a sizeless one from CustomGate's defaults.
        if (current.kind !== 'teleporter' && current.size?.[2] === 0 && (current.pos?.[2] || 0) === 0) {
          current.driveThrough = true;
          current.shootThrough = true;
        }

        if (currentDefine) {
          // A define's contents are a template, not finished obstacles --
          // names and teleporter registration wait for a `group` instance to
          // place a copy, in the expansion pass below (matching upstream:
          // `GroupDefinition::makeGroups` calls `makeTeleName` and adds a
          // teleporter to the world's teleporter list once per real
          // placement, not once per template). Its own dimensions are
          // resolved now regardless -- see `applyTeleporterDefaults`.
          if (current.kind === 'teleporter') {
            applyTeleporterDefaults(current);
          }
          currentDefine.obstacles.push(current);
          current = null;
        } else {
          // Use BZW name if present, otherwise assign a generated name
          if (!current.name) {
            if (current.kind === 'teleporter') {
              current.name = `t${teleporters.length}`;
            } else {
              current.name = `${current.type[0].toUpperCase()}${obstacles.length}`;
            }
          }

          if (current.kind === 'teleporter') {
            applyTeleporterDefaults(current);
            registerTeleporter(current);
          }

          obstacles.push(current);
          current = null;
        }
      }
    } else if (!current && !currentLink && !currentZone && !currentWeapon
      && UNSUPPORTED_TOP_LEVEL_KEYWORDS.has(token)) {
      unsupportedCounts.set(token, (unsupportedCounts.get(token) || 0) + 1);
    } else if (current && BZW_INERT_MATERIAL_KEYWORDS.has(token)) {
      // Read and dropped rather than tallied -- a box or pyramid stating one
      // of these gets exactly what upstream gives it, which is nothing.
    } else {
      // Nothing above claimed this line. Every branch that reads a keyword is
      // one of the arms this falls off the end of, so reaching here means bzo
      // has no handling for the word at all -- which is worth counting rather
      // than dropping in silence. `alphathresh` went unread in 26 of the maps
      // in `maps/` without any of them ever saying so.
      unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
    }
  }

  // One line inside a `drawInfo { ... }` block (`MeshDrawInfo::parse`,
  // `MeshDrawInfo.cxx:874-1029`, with `parseDrawLod`/`parseDrawSet` for the
  // two nested levels). The block is upstream's render-optimized copy of the
  // same surface the mesh's own `face` list describes -- a flat corner table
  // plus GL draw commands over it -- and a real map may state *only* this,
  // with no faces at all, which is how `RatsNest.bzw`'s own tank models are
  // written and why bzo used to draw them as nothing.
  //
  // A corner is `vertex normal texcoord`, indexing the mesh's own pools --
  // unless the block states pools of its own, which replace them for drawing
  // (`MeshDrawInfo::clientSetup`, `:464-478`). Draw commands index corners.
  function readMeshDrawInfoLine(mesh, info, token, words) {
    // Inside a draw set: the commands themselves, and the per-set hints bzo
    // has no use for.
    if (info.depth === 2) {
      if (token === 'end') {
        info.set = null;
        info.depth = 1;
        return;
      }
      if (token === 'dlist' || token === 'sphere') return;
      if (MESH_DRAW_MODES.has(token)) {
        const indices = words.slice(1).map(Number).filter(Number.isInteger);
        if (info.set) info.set.commands.push({ mode: token, indices });
        return;
      }
      unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
      return;
    }
    // Inside a lod: its own screen-size threshold, and one draw set per
    // material.
    if (info.depth === 1) {
      if (token === 'end') {
        info.depth = 0;
        return;
      }
      if (token === 'length' || token === 'lengthperpixel') return;
      if (token === 'matref') {
        const set = { materialRef: words[1] || '', commands: [] };
        if (info.lod) info.lod.sets.push(set);
        info.set = set;
        info.depth = 2;
        return;
      }
      unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
      return;
    }
    // The block's own body.
    if (token === 'end') {
      info.closed = true;
      buildMeshDrawFaces(mesh, info);
      return;
    }
    if (token === 'angvel') {
      // Upstream's own home for it (`:910-926`). A mesh-level `angvel` is
      // bzo's own spelling of the same thing (see the `mesh` branch above),
      // and a map stating it here is stating it where bzflag reads it.
      mesh.angvel = Number(words[1]) || 0;
      return;
    }
    if (token === 'corner') {
      const [v, n, t] = words.slice(1).map(Number);
      info.corners.push({
        vertex: Number.isInteger(v) ? v : -1,
        normal: Number.isInteger(n) ? n : -1,
        texcoord: Number.isInteger(t) ? t : -1,
      });
      return;
    }
    if (token === 'vertex') {
      const [x, y, z] = words.slice(1).map(Number);
      info.vertices.push({ x: x || 0, y: y || 0, z: z || 0 });
      return;
    }
    if (token === 'normal') {
      const [x, y, z] = words.slice(1).map(Number);
      info.normals.push({ x: x || 0, y: y || 0, z: z || 0 });
      return;
    }
    if (token === 'texcoord') {
      const [u, v] = words.slice(1).map(Number);
      info.texcoords.push({ u: u || 0, v: v || 0 });
      return;
    }
    if (token === 'lod' || token === 'radarlod') {
      // `radarlod` is a second, coarser copy for the radar alone. bzo draws
      // its radar from the obstacle's own footprint rather than from mesh
      // geometry, so it is walked for its `end` lines and otherwise dropped.
      const lod = { sets: [] };
      if (token === 'lod' && !info.lod) info.lod = lod;
      info.depth = 1;
      return;
    }
    // `extents`/`center`/`sphere` are bounds upstream precomputes and bzo
    // derives itself; `option` is a renderer hint; `dlist` asks for a display
    // list, which WebGL has no equivalent of. All read and dropped.
    if (token === 'extents' || token === 'center' || token === 'sphere'
      || token === 'option' || token === 'dlist') {
      return;
    }
    unreadKeywordCounts.set(token, (unreadKeywordCounts.get(token) || 0) + 1);
  }

  // Turns a finished `drawInfo` block into the faces bzo draws it with. These
  // are render-only, kept apart from the mesh's own `faces`: upstream draws
  // from `drawInfo` and collides against the face list, and a mesh that
  // states only a `drawInfo` -- every tank in `RatsNest.bzw` -- is decoration
  // a tank drives straight through, which falls out of leaving `faces` empty.
  function buildMeshDrawFaces(mesh, info) {
    if (!info.lod || info.corners.length === 0) return;
    // Pools of its own replace the mesh's for drawing, all three together
    // (`clientSetup` switches on `rawVertCount` alone).
    if (info.vertices.length > 0) {
      mesh.drawVertices = info.vertices;
      mesh.drawNormals = info.normals;
      mesh.drawTexcoords = info.texcoords;
    }
    const drawFaces = [];
    for (const set of info.lod.sets) {
      // The set's own material, resolved the way every other `matref` is.
      const material = {
        texture: null, textureUrl: null, color: null, noRadar: false, noLighting: false,
        dynamicColor: null, textureMatrix: null,
        specular: null, emission: null, shininess: null, alphaThreshold: null,
        noSorting: false, useTextureAlpha: true, useColorOnTexture: true,
      };
      applyBzwMaterialToken(material, 'matref', ['matref', set.materialRef]);
      for (const command of set.commands) {
        for (const poly of expandMeshDrawCommand(command.mode, command.indices)) {
          const corners = poly.map((index) => info.corners[index]).filter(Boolean);
          if (corners.length < 3) continue;
          drawFaces.push({
            vertexIndices: corners.map((corner) => corner.vertex),
            normalIndices: corners.every((corner) => corner.normal >= 0)
              ? corners.map((corner) => corner.normal) : [],
            texcoordIndices: corners.every((corner) => corner.texcoord >= 0)
              ? corners.map((corner) => corner.texcoord) : [],
            texture: material.texture,
            textureUrl: material.textureUrl,
            color: material.color,
            noRadar: material.noRadar,
            noLighting: material.noLighting,
            specular: material.specular,
            emission: material.emission,
            shininess: material.shininess,
            alphaThreshold: material.alphaThreshold,
            dynamicColor: material.dynamicColor,
            textureMatrix: material.textureMatrix,
            // Only here: this is the one route on which upstream's own
            // renderer honours `noculling` -- see `applyBzwMaterialToken`.
            noCulling: !!material.noCulling,
            ...bzwMaterialFlags(material),
          });
        }
      }
    }
    if (drawFaces.length > 0) mesh.drawFaces = drawFaces;
  }

  // Applies one `group` instance's composed transform (scale, then spin, then
  // shift -- CustomGroup::writeToGroupDef's order) to a list of members
  // already resolved in the frame the instance itself sits in -- either a
  // definition's own plain obstacles, or a nested instance's own already-
  // placed output, one level in. Applying it once per level as nesting
  // unwinds is what makes recursion work without composing an N-level
  // transform up front.
  // A group instance's own `phydrv`/`matref`/`addtexture` never touch a
  // plain box or pyramid member at all -- `ObstacleModifier::execute`
  // (`ObstacleModifier.cxx:179-223`) gates both behind `obstacle->getType()
  // == MeshObstacle::getClassName()`, full stop. On a mesh member the two
  // are opposite rules, not the same "only if unset" shape a member's own
  // passability gets: a matref/addtexture override *replaces* every face's
  // material outright (`face->bzMaterial = material`, unconditional), while
  // a phydrv override only ever touches a face that *already* names some
  // driver (upstream's own comment: "only modify faces that already have a
  // physics driver") -- a face with none stays driver-less under a moving
  // group. A `tint` is mesh-only for the same reason, and multiplies each
  // face's diffuse rather than replacing it, after any material override the
  // same instance states. Building new face objects rather than mutating the
  // member's own:
  // the same `define` this member came from may be instantiated again
  // elsewhere with a different override, and that later instance must not
  // see this one's.
  function applyGroupMeshModifiers(member, request) {
    if (member.type !== 'mesh') return member;
    const hasPhydrvOverride = !!request.phydrv;
    const hasMaterialOverride = !!request.materialOverride;
    const tint = request.tint || null;
    if (!hasPhydrvOverride && !hasMaterialOverride && !tint) return member;
    return {
      ...member,
      faces: member.faces.map((face) => {
        const next = { ...face };
        if (hasPhydrvOverride && face.phydrv) next.phydrv = request.phydrv;
        if (hasMaterialOverride) {
          next.texture = request.materialOverride.texture;
          next.textureUrl = request.materialOverride.textureUrl;
          next.color = request.materialOverride.color;
          next.noRadar = request.materialOverride.noRadar;
          next.noLighting = request.materialOverride.noLighting;
          next.specular = request.materialOverride.specular;
          next.emission = request.materialOverride.emission;
          next.shininess = request.materialOverride.shininess;
          next.alphaThreshold = request.materialOverride.alphaThreshold;
          Object.assign(next, bzwMaterialFlags(request.materialOverride));
        }
        // `tint` last, over whatever the material override just wrote --
        // `ObstacleModifier::execute` tints the face's *replacement*
        // material, not the one it replaced. A face with no diffuse of its
        // own starts from `BzMaterial::reset`'s own opaque white, so
        // multiplying leaves the tint itself.
        if (tint) {
          const base = next.color || [1, 1, 1, 1];
          next.color = tint.map((component, i) => component * (base[i] ?? 1));
        }
        return next;
      }),
    };
  }

  function applyGroupInstanceTransform(members, request, instanceLabel) {
    if (request.transformOps) tippedObstacleCount += members.length;
    const [scaleX, scaleY, scaleZ] = request.scale;
    const cos = Math.cos(request.spin);
    const sin = Math.sin(request.spin);

    return members.map((member, memberIndex) => {
      // The spin is a plain counter-clockwise turn about +Z: it carries a
      // member's position around the group's origin, and adds to the
      // member's own facing.
      const memberX = (member.pos?.[0] || 0) * scaleX;
      const memberY = (member.pos?.[1] || 0) * scaleY;
      const memberZ = (member.pos?.[2] || 0) * scaleZ;
      const placed = {
        pos: [
          request.pos[0] + ((memberX * cos) - (memberY * sin)),
          request.pos[1] + ((memberX * sin) + (memberY * cos)),
          request.pos[2] + memberZ,
        ],
        angle: (member.angle || 0) + request.spin,
      };
      if (member.size) {
        placed.size = [
          member.size[0] * Math.abs(scaleX), member.size[1] * Math.abs(scaleY), member.size[2] * Math.abs(scaleZ),
        ];
      }

      return {
        ...member,
        ...placed,
        // The group's own passability only adds permission -- true on every
        // member type, unlike matref/phydrv below, which upstream restricts
        // to a mesh member's own faces.
        driveThrough: !!member.driveThrough || request.driveThrough,
        shootThrough: !!member.shootThrough || request.shootThrough,
        ricochet: !!member.ricochet || request.ricochet,
        // A member already named -- one that came back from a nested `group`,
        // already carrying its own instance prefix -- keeps that name; only a
        // still-bare plain obstacle falls back to its place in the
        // definition, `t<n>` for a teleporter (upstream's own default,
        // `GroupDefinition::makeTeleName`) rather than a type-letter one.
        name: `${instanceLabel}:${member.name
          || (member.kind === 'teleporter' ? `t${memberIndex}` : `${(member.type || 'O')[0].toUpperCase()}${memberIndex}`)}`,
      };
    }).map((member) => applyGroupMeshModifiers(member, request));
  }

  // A group instance's own scale/spin, applied to one point in the
  // definition's local frame -- a mesh vertex or checkpoint (translated by
  // `request.pos` after this, the same as a member's own position above) or
  // a mesh normal (left untranslated, `scaleX`/`Y`/`Z` all 1 --
  // a direction has no position to scale, and no rigorous inverse-transpose
  // for a non-uniform one either; real local usage only ever scales a mesh
  // uniformly, so a plain rotation is exact there and a close approximation
  // otherwise).
  function transformGroupPoint(point, scaleX, scaleY, scaleZ, cos, sin) {
    const localX = (point.x || 0) * scaleX;
    const localY = (point.y || 0) * scaleY;
    return {
      x: (localX * cos) - (localY * sin),
      y: (localX * sin) + (localY * cos),
      z: (point.z || 0) * scaleZ,
    };
  }

  // The mesh equivalent of `applyGroupInstanceTransform` above -- same
  // scale/spin/shift, applied per vertex/checkpoint (and per normal, minus
  // the translation) rather than to one obstacle position, since a mesh's
  // geometry is many points rather than a position plus a size.
  function applyGroupInstanceTransformToMesh(mesh, request, instanceLabel) {
    const [scaleX, scaleY, scaleZ] = request.scale;
    const cos = Math.cos(request.spin);
    const sin = Math.sin(request.spin);
    let placePoint = (point) => {
      const local = transformGroupPoint(point, scaleX, scaleY, scaleZ, cos, sin);
      return { x: request.pos[0] + local.x, y: request.pos[1] + local.y, z: request.pos[2] + local.z };
    };
    let placeNormal = (n) => transformGroupPoint(n, 1, 1, 1, cos, sin);
    let placeVector = (v) => transformGroupPoint(v, scaleX, scaleY, scaleZ, cos, sin);
    // A group spun off vertical or sheared: upstream's own matrix, which the
    // scale/spin/shift above cannot express (#168).
    const movers = request.transformOps && meshTransformMovers(request.transformOps);
    if (movers) {
      placePoint = movers.movePoint;
      placeNormal = movers.moveNormal;
      placeVector = movers.moveVector;
    }
    // The axis a spinning mesh turns about: its own local up, carried
    // through every enclosing group so a tipped group tips the spin too.
    let spinAxis = mesh.spinAxis;
    if (mesh.angvel) {
      const axis = placeVector(mesh.spinAxis || { x: 0, y: 0, z: 1 });
      const len = Math.hypot(axis.x, axis.y, axis.z);
      spinAxis = len > 0 ? { x: axis.x / len, y: axis.y / len, z: axis.z / len } : mesh.spinAxis;
    }
    const placedMesh = {
      ...mesh,
      name: `${instanceLabel}:${mesh.name || 'Mesh'}`,
      vertices: mesh.vertices.map(placePoint),
      normals: mesh.normals.map(placeNormal),
      checkPoints: mesh.checkPoints.map((p) => ({ ...placePoint(p), inside: p.inside })),
      // Fresh face objects, never the template's own -- the same definition
      // may be placed more than once, each with its own transform, and
      // `finalizeMeshGeometry` below writes a world-space `plane` onto each
      // face in place. Reusing the template's array would let the last
      // instance placed overwrite every earlier one's collision plane.
      faces: mesh.faces.map((face) => ({ ...face })),
      drawFaces: mesh.drawFaces ? mesh.drawFaces.map((face) => ({ ...face })) : null,
      drawVertices: mesh.drawVertices ? mesh.drawVertices.map(placePoint) : null,
      drawNormals: mesh.drawNormals ? mesh.drawNormals.map(placeNormal) : null,
      // The point a spinning mesh (`angvel`, #88) rotates about -- upstream
      // has no per-mesh pivot of its own (a hand-authored `drawInfo` spins
      // about world origin), so this is just the mesh's own local (0,0,0)
      // carried through the same placement every vertex above gets. Treating
      // a definition already placed once (nested `group`s) as one more local
      // point rather than always restarting from world origin here is what
      // makes an arbitrarily deep nesting land in the right place.
      spinPivot: mesh.angvel ? placePoint(mesh.spinPivot || { x: 0, y: 0, z: 0 }) : mesh.spinPivot,
      spinAxis,
    };
    // The instance's own `phydrv`/`matref` override, same rule and same
    // helper `applyGroupInstanceTransform` uses for a nested plain-obstacle
    // group whose member happens to be a mesh -- this is the direct path a
    // top-level `group <meshDefine> \n matref <name> \n end` instance
    // actually takes (`resolveDefineMeshes`, above), so it needs the same
    // application, not just the indirect one.
    //
    // Before `finalizeMeshGeometry`, not after: the override replaces face
    // objects wholesale, and finalize is meant to be the last thing that
    // changes a mesh's faces. It touches material and physics fields only,
    // never geometry, so which side of finalize it runs on cannot change
    // what it produces.
    return finalizeMeshGeometry(applyGroupMeshModifiers(placedMesh, request));
  }

  // A vertex pool's own axis-aligned bounding box -- `MeshObstacle::finalize`
  // builds the same thing by expanding over every face's extents, and prints
  // it back as a real map's own `# mins`/`# maxs` comment. Used as a cheap
  // whole-mesh reject before a collision check ever looks at an individual
  // face -- see `meshIntersectsCylinder` in the collision pair -- so a tank
  // nowhere near a 100-face mesh costs one bounds check, not 100 polygon ones.
  function computeMeshBounds(vertices) {
    if (!vertices.length) return null;
    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    for (const v of vertices) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }

  // The plane a mesh face's own vertices define, as `[nx, ny, nz, d]` with
  // `nx*x + ny*y + nz*z + d === 0` on the plane -- `MeshFace::finalize`'s own
  // best-of-every-triple search, kept for the same reason: three corners that
  // happen to be near-collinear give a plane close to (0,0,0), and the
  // largest cross product among every triple is the one least likely to be
  // that unlucky, on an otherwise-valid but oddly-ordered polygon. Returns
  // null for a face with no real plane at all -- upstream's own "invalid mesh
  // face" case (bzo.bzw's own real-bzfs pass turned up the same failure mode
  // on a flush, tinted box; see docs/bzw.md, "A pad flush with the ground").
  function computeMeshFacePlane(vertices, vertexIndices) {
    let bestLenSq = 0;
    let bestCross = null;
    let bestAt = null;
    const n = vertexIndices.length;
    for (let i = 0; i < n - 2; i++) {
      const vi = vertices[vertexIndices[i]];
      for (let j = i + 1; j < n - 1; j++) {
        const vj = vertices[vertexIndices[j]];
        const edge2 = { x: vi.x - vj.x, y: vi.y - vj.y, z: vi.z - vj.z };
        for (let k = j + 1; k < n; k++) {
          const vk = vertices[vertexIndices[k]];
          const edge1 = { x: vk.x - vj.x, y: vk.y - vj.y, z: vk.z - vj.z };
          const cx = (edge1.y * edge2.z) - (edge1.z * edge2.y);
          const cy = (edge1.z * edge2.x) - (edge1.x * edge2.z);
          const cz = (edge1.x * edge2.y) - (edge1.y * edge2.x);
          const lenSq = (cx * cx) + (cy * cy) + (cz * cz);
          if (lenSq > bestLenSq) {
            bestLenSq = lenSq;
            bestCross = { cx, cy, cz };
            bestAt = vj;
          }
        }
      }
    }
    if (!bestCross || bestLenSq < 1e-20) return null;
    const len = Math.sqrt(bestLenSq);
    const nx = bestCross.cx / len;
    const ny = bestCross.cy / len;
    const nz = bestCross.cz / len;
    const d = -((nx * bestAt.x) + (ny * bestAt.y) + (nz * bestAt.z));
    return [nx, ny, nz, d];
  }

  // A face's own per-edge "fence" planes -- `MeshFace::finalize`'s own
  // precomputation (MeshFace.cxx:201-214): one plane per polygon edge, each
  // containing that edge and perpendicular to the face's own plane, oriented
  // so the polygon's interior is its negative side. A point actually inside a
  // convex face's real 3D area sits on the negative side of every one of
  // these, which needs no 2D projection at all -- unlike a flattened
  // point-in-polygon test, it cannot be fooled by a thin, steeply angled
  // polygon (a cone's narrow wedge face, near its own shared apex) into
  // accepting a point that was never really on it. Returns `[]` alongside a
  // `null` plane -- a degenerate face has no edges worth fencing either.
  function computeMeshFaceEdgePlanes(vertices, vertexIndices, plane) {
    if (!plane) return [];
    const [pnx, pny, pnz] = plane;
    const n = vertexIndices.length;
    const edgePlanes = [];
    for (let v = 0; v < n; v++) {
      const vv = vertices[vertexIndices[v]];
      const vn = vertices[vertexIndices[(v + 1) % n]];
      const ex = vn.x - vv.x;
      const ey = vn.y - vv.y;
      const ez = vn.z - vv.z;
      let nx = (ey * pnz) - (ez * pny);
      let ny = (ez * pnx) - (ex * pnz);
      let nz = (ex * pny) - (ey * pnx);
      const len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
      nx /= len; ny /= len; nz /= len;
      const d = -((nx * vv.x) + (ny * vv.y) + (nz * vv.z));
      edgePlanes.push([nx, ny, nz, d]);
    }
    return edgePlanes;
  }

  // Whether a planar face's own vertices wind consistently convex -- the
  // same test upstream's `MeshFace::finalize` runs (MeshFace.cxx:139-151)
  // before it trusts a face's whole polygon: for every vertex, the turn
  // from the incoming edge to the outgoing one must agree with the face's
  // own plane normal. Upstream never plays a mapper's non-convex face as
  // broken, though -- it falls back to triangulating it
  // (`MeshObstacle::addFace`, MeshObstacle.cxx:181-249) rather than either
  // dropping it or handing it to a collision test that assumes convexity,
  // which is exactly what `computeMeshFaceEdgePlanes`'s own per-edge
  // "fence" planes do (a point inside a concave face's real area can sit
  // outside one of those, since a concave shape is not the intersection of
  // its edges' own half-spaces the way a convex one is). `triangulateFace`
  // below is that same fallback, not upstream's exact algorithm (its own
  // scoring picks prettier strips; this only needs a correct, gap-free
  // covering).
  function isFaceConvex(vertices, vertexIndices, plane) {
    const n = vertexIndices.length;
    if (n <= 3) return true;
    const [pnx, pny, pnz] = plane;
    for (let i = 0; i < n; i++) {
      const v0 = vertices[vertexIndices[i]];
      const v1 = vertices[vertexIndices[(i + 1) % n]];
      const v2 = vertices[vertexIndices[(i + 2) % n]];
      const e0x = v1.x - v0.x; const e0y = v1.y - v0.y; const e0z = v1.z - v0.z;
      const e1x = v2.x - v1.x; const e1y = v2.y - v1.y; const e1z = v2.z - v1.z;
      const cx = (e0y * e1z) - (e0z * e1y);
      const cy = (e0z * e1x) - (e0x * e1z);
      const cz = (e0x * e1y) - (e0y * e1x);
      const d = (cx * pnx) + (cy * pny) + (cz * pnz);
      if (d <= 0) return false;
    }
    return true;
  }

  // Ear-clipping a simple (non-self-intersecting) planar polygon into
  // triangles -- upstream's own fallback for a face that fails
  // `isFaceConvex` above. Repeatedly clips a convex corner whose triangle
  // holds none of the polygon's other corners, until three vertices are
  // left, projecting to 2D by dropping whichever axis the face's own plane
  // normal points along most (the ear test only needs positions within the
  // face's own flat plane). Returns `null` -- caller keeps the original
  // face rather than risk a wrong cut -- if no valid ear is ever found,
  // which a genuinely simple polygon should never do.
  function triangulateFacePolygon(vertices, indices, plane) {
    const [pnx, pny, pnz] = plane;
    const ax = Math.abs(pnx); const ay = Math.abs(pny); const az = Math.abs(pnz);
    // Drop whichever axis the normal points along most, keeping the other two
    // in whichever cyclic order (x->y->z->x) makes a positive-signed
    // component project a CCW polygon to a CCW one -- a negative component
    // needs the pair swapped instead, or the ear test's sign convention
    // silently flips for half of all possible face orientations (every axis
    // this picks the same way `computeMeshFacePlane`'s own right-hand-rule
    // cross product already does, just projected rather than kept in 3D).
    // A tie between the vertical and north goes to the vertical.
    let pt;
    if (ax >= ay && ax >= az) {
      pt = (i) => { const v = vertices[i]; return pnx >= 0 ? [v.y, v.z] : [v.z, v.y]; };
    } else if (az >= ax && az >= ay) {
      pt = (i) => { const v = vertices[i]; return pnz >= 0 ? [v.x, v.y] : [v.y, v.x]; };
    } else {
      pt = (i) => { const v = vertices[i]; return pny >= 0 ? [v.z, v.x] : [v.x, v.z]; };
    }
    const cross2 = (o, a, b) => (((a[0] - o[0]) * (b[1] - o[1])) - ((a[1] - o[1]) * (b[0] - o[0])));

    const remaining = indices.slice();
    const triangles = [];
    let guard = (remaining.length * remaining.length) + 8;
    while (remaining.length > 3 && guard-- > 0) {
      const n = remaining.length;
      let clipped = false;
      for (let i = 0; i < n; i++) {
        const iPrev = (i + n - 1) % n;
        const iNext = (i + 1) % n;
        const a = pt(remaining[iPrev]);
        const b = pt(remaining[i]);
        const c = pt(remaining[iNext]);
        if (cross2(a, b, c) <= 0) continue;
        let containsOther = false;
        for (let j = 0; j < n; j++) {
          if (j === iPrev || j === i || j === iNext) continue;
          const p = pt(remaining[j]);
          const c1 = cross2(a, b, p);
          const c2 = cross2(b, c, p);
          const c3 = cross2(c, a, p);
          if ((c1 >= 0 && c2 >= 0 && c3 >= 0) || (c1 <= 0 && c2 <= 0 && c3 <= 0)) { containsOther = true; break; }
        }
        if (containsOther) continue;
        triangles.push([remaining[iPrev], remaining[i], remaining[iNext]]);
        remaining.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) return null;
    }
    if (remaining.length === 3) triangles.push(remaining);
    return triangles;
  }

  // A non-convex face split into triangles, each a shallow copy of the
  // original carrying its own three vertices/texcoords/normals -- every
  // other property (texture, matref-resolved fields, passability, phydrv)
  // stays shared, the same as upstream's own triangles all keeping the
  // one face's own material. Falls back to the untouched original,
  // singly, if `triangulateFacePolygon` can't safely clip it.
  function triangulateMeshFace(vertices, face) {
    const tris = triangulateFacePolygon(vertices, face.vertexIndices, face.plane);
    if (!tris) return [face];
    const hasTex = face.texcoordIndices && face.texcoordIndices.length === face.vertexIndices.length;
    const hasNorm = face.normalIndices && face.normalIndices.length === face.vertexIndices.length;
    const posOf = (globalVertexIndex) => face.vertexIndices.indexOf(globalVertexIndex);
    return tris.map((triVertexIndices) => ({
      ...face,
      vertexIndices: triVertexIndices,
      texcoordIndices: hasTex ? triVertexIndices.map((gi) => face.texcoordIndices[posOf(gi)]) : [],
      normalIndices: hasNorm ? triVertexIndices.map((gi) => face.normalIndices[posOf(gi)]) : [],
    }));
  }


  // Bounds plus a per-face plane (and its edge planes), computed once a
  // mesh's vertices are in their final world positions -- a top-level mesh
  // right when it closes, or a `group`-placed one right after its own
  // transform, never on a `define`'s own still-local template
  // (`resolveDefineMeshes` holds those unfinalized, since the same
  // definition may be placed more than once, each landing somewhere
  // different). A face that fails
  // `isFaceConvex` is replaced here by its own triangulation, root and
  // branch, rather than finalized as-is -- so nothing downstream of this
  // function ever sees a concave face at all, the same guarantee upstream
  // gives every one of its own collision/rendering paths.
  // Meshes that differ only by where they stand and which way they face: a
  // compiled world writes each placement of a `define` out in full, so
  // `bmbz.ducatileague.org:5172` is 693 meshes and far fewer shapes. Each is
  // matched vertex for vertex against a reference turned about the vertical,
  // and verified before it is shared, so the match is exact -- a
  // planar-projected face's UVs run from its own first corner and turn with
  // it, and a face's normal turns with the instance's matrix.
  //
  // A mirrored copy is a turn of the reference's mirror image, never of the
  // reference, so it lands in a group of its own with a template of its own.
  // That costs a draw per handedness and keeps every instance a proper
  // rotation: an instanced batch has one winding, and a negative scale on
  // one copy would cull the wrong side of it.
  //
  // Left out: a spinning mesh, which turns about a pivot of its own; one a
  // batch already draws; and one with a see-through material, because a
  // batch is sorted as one object and its copies would draw in the wrong
  // order through each other.
  const REPEAT_TOLERANCE = 0.005;
  function instanceRepeatedMeshes(candidates) {
    const groups = new Map();
    for (const mesh of candidates) {
      if (mesh.drawnByInstance || mesh.angvel) continue;
      const arrays = meshDrawArrays(mesh);
      if (!arrays || arrays.vertices.length < 3 || arrays.faceCount === 0) continue;
      if (arrays.materials.some((m) => m.dynamicColor || (Array.isArray(m.color) && (m.color[3] ?? 1) < 1))) continue;
      const v = arrays.vertices;
      const count = v.length / 3;
      const centre = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < v.length; i += 3) {
        centre.x += v[i] / count;
        centre.y += v[i + 1] / count;
        centre.z += v[i + 2] / count;
      }
      // What a turn about the vertical leaves alone, vertex by vertex: each
      // one's distance from the vertical through the centre, and its height.
      // Coarse on purpose -- the exact test is the verification below.
      const round = (n) => Math.round(n * 100);
      const invariant = [];
      for (let i = 0; i < v.length; i += 3) {
        invariant.push(round(Math.hypot(v[i] - centre.x, v[i + 1] - centre.y)), round(v[i + 2] - centre.z));
      }
      const hash = crypto.createHash('sha1');
      hash.update(invariant.join(','));
      for (const field of ['faceStart', 'corners', 'cornerNormal', 'cornerTexcoord', 'faceMaterial']) {
        hash.update(`|${field}:${Array.from(arrays[field]).join(',')}`);
      }
      hash.update(`|t:${Array.from(arrays.texcoords, (n) => Math.round(n * 1000)).join(',')}`);
      hash.update(`|m:${JSON.stringify(arrays.materials)}`);
      const key = hash.digest('hex');
      const list = groups.get(key) || [];
      list.push({ mesh, arrays, centre });
      groups.set(key, list);
    }

    // The turn about the vertical that carries the reference onto `entry`,
    // in radians counter-clockwise about +Z as an instance's `spin` reads it,
    // or null where no turn does: every vertex and every normal has to land
    // within tolerance.
    const solveTurn = (reference, entry) => {
      const rv = reference.arrays.vertices;
      const ev = entry.arrays.vertices;
      let pivot = -1;
      let best = 0;
      for (let i = 0; i < rv.length; i += 3) {
        const r = Math.hypot(rv[i] - reference.centre.x, rv[i + 1] - reference.centre.y);
        if (r > best) { best = r; pivot = i; }
      }
      let angle = 0;
      if (pivot >= 0 && best > REPEAT_TOLERANCE) {
        const x = rv[pivot] - reference.centre.x;
        const y = rv[pivot + 1] - reference.centre.y;
        const tx = ev[pivot] - entry.centre.x;
        const ty = ev[pivot + 1] - entry.centre.y;
        angle = Math.atan2((x * ty) - (y * tx), (x * tx) + (y * ty));
      }
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const turned = (x, y) => [(x * cos) - (y * sin), (x * sin) + (y * cos)];
      for (let i = 0; i < rv.length; i += 3) {
        const [x, y] = turned(rv[i] - reference.centre.x, rv[i + 1] - reference.centre.y);
        if (Math.abs(x - (ev[i] - entry.centre.x)) > REPEAT_TOLERANCE
          || Math.abs(y - (ev[i + 1] - entry.centre.y)) > REPEAT_TOLERANCE
          || Math.abs((rv[i + 2] - reference.centre.z) - (ev[i + 2] - entry.centre.z)) > REPEAT_TOLERANCE) {
          return null;
        }
      }
      const rn = reference.arrays.normals;
      const en = entry.arrays.normals;
      for (let i = 0; i < rn.length; i += 3) {
        const [x, y] = turned(rn[i], rn[i + 1]);
        if (Math.abs(x - en[i]) > REPEAT_TOLERANCE || Math.abs(y - en[i + 1]) > REPEAT_TOLERANCE
          || Math.abs(rn[i + 2] - en[i + 2]) > REPEAT_TOLERANCE) {
          return null;
        }
      }
      return angle;
    };

    let meshCount = 0;
    let shapeCount = 0;
    for (const candidatesForKey of groups.values()) {
      // Each member joins the first set whose reference it is a turn of, or
      // starts one: its mirror image, or a near miss the coarse key let in.
      const sets = [];
      for (const entry of candidatesForKey) {
        let placed = false;
        for (const set of sets) {
          const angle = solveTurn(set.reference, entry);
          if (angle === null) continue;
          set.members.push({ entry, angle });
          placed = true;
          break;
        }
        if (!placed) sets.push({ reference: entry, members: [{ entry, angle: 0 }] });
      }
      for (const { reference, members } of sets) {
        if (members.length < 2) continue;
        const { mesh: first, centre } = reference;
        const toLocal = (p) => ({ ...p, x: p.x - centre.x, y: p.y - centre.y, z: p.z - centre.z });
        const template = finalizeMeshGeometry({
          ...first,
          vertices: first.vertices.map(toLocal),
          checkPoints: (first.checkPoints || []).map(toLocal),
          drawVertices: first.drawVertices ? first.drawVertices.map(toLocal) : first.drawVertices,
          faces: first.faces.map((face) => ({ ...face })),
          drawFaces: first.drawFaces ? first.drawFaces.map((face) => ({ ...face })) : first.drawFaces,
        });
        const name = `repeat#${shapeCount}:${first.name || 'mesh'}`;
        meshTemplates.set(name, [template]);
        for (const { entry, angle } of members) {
          meshInstances.push({
            define: name, x: entry.centre.x, y: entry.centre.y, z: entry.centre.z, spin: angle, scale: [1, 1, 1],
          });
          entry.mesh.drawnByInstance = true;
        }
        meshCount += members.length;
        shapeCount += 1;
      }
    }
    return { meshes: meshCount, shapes: shapeCount };
  }

  function finalizeMeshGeometry(mesh) {
    mesh.bounds = computeMeshBounds(mesh.vertices);
    // A mesh placed directly in the world, never through any `group`
    // instance, never runs `applyGroupInstanceTransformToMesh`'s own
    // `spinPivot` line above -- give it the same default that line would
    // have (world origin, matching upstream's own hand-authored `drawInfo`).
    if (mesh.angvel && !mesh.spinPivot) mesh.spinPivot = { x: 0, y: 0, z: 0 };
    const finalFaces = [];
    for (const face of mesh.faces) {
      face.plane = computeMeshFacePlane(mesh.vertices, face.vertexIndices);
      if (face.plane && face.vertexIndices.length > 3
        && !isFaceConvex(mesh.vertices, face.vertexIndices, face.plane)) {
        const triFaces = triangulateMeshFace(mesh.vertices, face);
        if (triFaces.length > 1) {
          for (const triFace of triFaces) {
            triFace.plane = computeMeshFacePlane(mesh.vertices, triFace.vertexIndices);
            triFace.edgePlanes = computeMeshFaceEdgePlanes(mesh.vertices, triFace.vertexIndices, triFace.plane);
            finalFaces.push(triFace);
          }
          continue;
        }
        log(`Could not triangulate a non-convex mesh face in ${mesh.name || '(unnamed mesh)'}, using it as-is`);
      }
      face.edgePlanes = computeMeshFaceEdgePlanes(mesh.vertices, face.vertexIndices, face.plane);
      finalFaces.push(face);
    }
    // Upstream drops a zero-area face in `MeshFace::finalize` itself, and so
    // does this -- after triangulation, so what is tested is the faces the
    // mesh ends up with, slivers a split produced included. Here rather than
    // in a pass over the finished obstacle list because the arrays are built
    // from these faces and a face dropped afterwards would mean rebuilding
    // them; a `define`'s own template meshes reach this too, and a pass over
    // `obstacles` never saw those at all.
    mesh.faces = finalFaces.filter((face) => {
      const indices = face.vertexIndices || [];
      if (indices.length >= 3
        && faceMaxCrossSqr(mesh.vertices, indices) >= MIN_FACE_CROSS_SQR) return true;
      const name = mesh.name || mesh.type || 'mesh';
      degenerateFaceCounts.set(name, (degenerateFaceCounts.get(name) || 0) + 1);
      return false;
    });
    // The arrays, here rather than at registration: this is the last moment
    // a mesh's faces change, and building now is what lets them be dropped
    // (issue #153). An instance's `matref`/`tint`/`phydrv` override runs
    // before this, not after -- see `applyGroupInstanceTransformToMesh`.
    //
    // Held decoded and under their own names: `arrays` is the encoded field
    // the wire carries, and `attachMeshArrayPayloads` is what turns one into
    // the other.
    mesh.arrayData = meshArrays(mesh);
    const draw = meshDrawArrays(mesh);
    if (draw !== mesh.arrayData) mesh.drawArrayData = draw;
    return mesh;
  }

  // Resolves a `define` into the meshes it holds, the same way `resolveDefine`
  // below resolves its plain obstacles -- its own meshes, plus every nested
  // `group` instance's own definition recursively resolved and placed by that
  // instance's transform. A definition `resolveDefine` already found unknown
  // or cyclic reports it for both; this only ever returns fewer meshes in
  // that case, never a second warning for the same thing.
  function resolveDefineMeshes(defName, visiting) {
    const template = defineTemplates.get(defName);
    if (!template || visiting.has(defName)) return [];
    visiting.add(defName);

    const resolved = [...template.meshes];
    const nestedOrdinals = new Map();
    for (const nestedRequest of template.groupInstances) {
      const ordinal = nestedOrdinals.get(nestedRequest.groupDefName) || 0;
      nestedOrdinals.set(nestedRequest.groupDefName, ordinal + 1);
      const nestedLabel = nestedRequest.name || `${nestedRequest.groupDefName}#${ordinal}`;
      const nestedMeshes = resolveDefineMeshes(nestedRequest.groupDefName, visiting);
      resolved.push(...nestedMeshes.map((m) => applyGroupInstanceTransformToMesh(m, nestedRequest, nestedLabel)));
    }

    visiting.delete(defName);
    return resolved;
  }

  // Resolves a `define` into the obstacles it holds, in its own local frame --
  // its plain obstacles as written, plus every nested `group` instance's own
  // definition recursively resolved and placed by that instance's transform.
  // This is real recursion, matching `GroupDefinition::makeGroups`, not the
  // flat single level bzo read before: a `group` found while parsing inside a
  // `define` is a template entry (see the `token === 'group'` branch above),
  // expanded only once something actually places *this* definition.
  //
  // `visiting` is this one call's own root-to-here path, mirroring
  // `GroupDefinition`'s own `active` flag: a definition already on this path
  // is a cycle (through itself, or through others), not ordinary reuse -- two
  // independent instances of the same definition, the way `bzo.bzw`'s two
  // `Watchtower`s are, never touch it, since each starts its own empty path.
  function resolveDefine(defName, visiting) {
    const template = defineTemplates.get(defName);
    if (!template) {
      unknownGroupDefs.add(defName);
      return [];
    }
    if (visiting.has(defName)) {
      groupCycleWarnings.add(defName);
      return [];
    }
    visiting.add(defName);

    const resolved = [...template.obstacles];
    // Ordinal counting is local to this one definition's own nested
    // instances, not shared with the world's top-level list or any other
    // definition's -- `GroupDefinition::appendGroupName` counts only within
    // the one `groups` vector a definition owns, so the same definition
    // placed from two different parents independently starts back at `#0`.
    const nestedOrdinals = new Map();
    for (const nestedRequest of template.groupInstances) {
      const ordinal = nestedOrdinals.get(nestedRequest.groupDefName) || 0;
      nestedOrdinals.set(nestedRequest.groupDefName, ordinal + 1);
      const nestedLabel = nestedRequest.name || `${nestedRequest.groupDefName}#${ordinal}`;
      const nestedMembers = resolveDefine(nestedRequest.groupDefName, visiting);
      resolved.push(...applyGroupInstanceTransform(nestedMembers, nestedRequest, nestedLabel));
    }

    visiting.delete(defName);
    return resolved;
  }

  // Expand every top-level `group` instance now that the whole file (and
  // every `define` in it, however late) has been read -- `group` may name a
  // `define` the file states later, the same deferred resolution upstream
  // gives it.

  // Whether a definition places nothing a tank or a shot can hit, resolved
  // once per definition rather than once per instance -- the whole point is
  // to avoid resolving 1,939 copies to find out (issue #153). A definition
  // that is entirely passable can be carried as a template plus a transform
  // apiece, because the only thing that reads its geometry is the renderer.
  //
  // Both flags, not either: something shots pass through but tanks do not is
  // still collision geometry, and so is the reverse.
  const defineSpins = new Map();
  function definedMeshesSpin(defName) {
    const cached = defineSpins.get(defName);
    if (cached !== undefined) return cached;
    defineSpins.set(defName, false);
    const spins = resolveDefineMeshes(defName, new Set()).some((mesh) => mesh.angvel);
    defineSpins.set(defName, spins);
    return spins;
  }

  const definePassability = new Map();
  function isPassableDefine(defName) {
    const cached = definePassability.get(defName);
    if (cached !== undefined) return cached;
    // Guards recursion the same way `resolveDefine`'s own `visiting` does: a
    // definition reached while deciding about itself cannot make the answer
    // any more passable than the rest of it already is.
    definePassability.set(defName, true);
    const members = resolveDefine(defName, new Set());
    const definedMeshes = resolveDefineMeshes(defName, new Set());
    // A box or a pyramid carries the flags itself. A mesh carries them per
    // face -- `passable` sits inside the `face` block, beside its `matref`,
    // which is how every flower in `bmbz.ducatileague.org:5180` is written --
    // so a mesh is passable when the mesh says so or when every one of its
    // faces does. An empty mesh collides with nothing either way.
    const meshPassable = (mesh) => (mesh.driveThrough && mesh.shootThrough)
      || (Array.isArray(mesh.faces)
        && mesh.faces.every((face) => face.driveThrough && face.shootThrough));
    const passable = members.every((m) => m.driveThrough && m.shootThrough)
      && definedMeshes.every(meshPassable);
    definePassability.set(defName, passable);
    return passable;
  }

  const topGroupOrdinals = new Map();
  // A definition's geometry held once, in its own local frame, and the
  // placements that share it (#153). Only definitions nothing collides with
  // land here -- see `isPassableDefine` above -- so collision, the radar and
  // the overview all go on reading `obstacles` and `meshes` as before.
  const meshTemplates = new Map();
  const meshInstances = [];
  // `<definition>\u0000<overrides>` -> the name its template is published
  // under, and how many distinct override sets each definition has so far.
  const templateNames = new Map();
  const templateVariants = new Map();
  let passableInstances = 0;
  // The counts the line below logs, returned too so a quiet caller can sum
  // them over many maps instead.
  let instancing = null;
  for (const request of groupInstanceRequests) {
    let instancedMeshMembers = false;
    const ordinal = topGroupOrdinals.get(request.groupDefName) || 0;
    topGroupOrdinals.set(request.groupDefName, ordinal + 1);
    const instanceLabel = request.name || `${request.groupDefName}#${ordinal}`;
    // Carried as a template and a transform rather than expanded (#153).
    //
    // An instance may name its own material, tint or physics driver, which
    // makes its copy genuinely different from a plain one's -- so the
    // template is keyed by the definition *and* those overrides, and every
    // instance sharing both shares a template. On `bzo.bzw` that is the
    // difference between 3 of its passable instances being shared and 15:
    // its flag panels are one definition worn in several colours.
    const overrideKey = JSON.stringify([
      request.materialOverride || null, request.tint || null, request.phydrv || null,
      !!request.driveThrough, !!request.shootThrough, !!request.ricochet,
    ]);
    // A definition holding a spinning mesh turns about a pivot placed per
    // instance, which one local template cannot carry -- and there are seven
    // such instances across every map bzo has seen, so they stay expanded.
    // A tipped instance (#168) is placed by a matrix the template's
    // scale/spin/shift cannot carry either.
    const spins = definedMeshesSpin(request.groupDefName) || !!request.transformOps;
    const passable = isPassableDefine(request.groupDefName);
    if (!spins) {
      const templateKey = `${request.groupDefName}\u0000${overrideKey}`;
      let templateName = templateNames.get(templateKey);
      if (templateName === undefined) {
        // One name per definition per override set. The suffix only appears
        // where a definition really is worn more than one way, so the common
        // case stays the definition's own name.
        const seen = templateVariants.get(request.groupDefName) || 0;
        templateVariants.set(request.groupDefName, seen + 1);
        templateName = seen === 0 ? request.groupDefName : `${request.groupDefName}#${seen}`;
        // Local space, once. `finalizeMeshGeometry` gives each face the plane
        // the renderer's planar-UV fallback needs; a template never placed
        // has none, which is why an unexpanded definition needs it here
        // rather than at placement. The instance's own overrides go on after,
        // exactly as `applyGroupInstanceTransformToMesh` applies them to an
        // expanded copy.
        // The face copy stays explicit: `applyGroupMeshModifiers` makes its
        // own only when the instance actually states an override, and
        // `finalizeMeshGeometry` writes a plane onto each face in place --
        // a template placed twice must not have the second placement
        // overwrite the first's.
        const templateMeshes = resolveDefineMeshes(request.groupDefName, new Set())
          .map((mesh) => applyGroupMeshModifiers(
            { ...mesh, faces: mesh.faces.map((f) => ({ ...f })) }, request,
          ))
          .map((mesh) => finalizeMeshGeometry(mesh));
        // A definition made of boxes and pyramids has no meshes to batch --
        // those draw through the obstacle path, which shares its geometry
        // already. Naming an empty template would put an instance on the
        // wire that draws nothing.
        if (templateMeshes.length === 0) {
          templateNames.set(templateKey, null);
          templateName = null;
        } else {
          templateNames.set(templateKey, templateName);
          meshTemplates.set(templateName, templateMeshes);
        }
      }
      if (templateName === null) {
        // Nothing to batch, so this instance expands exactly as it always
        // did -- including its passable case, which has no mesh geometry to
        // leave out either.
        instancedMeshMembers = false;
      } else {
      meshInstances.push({
        define: templateName,
        x: request.pos[0],
        y: request.pos[1],
        z: request.pos[2],
        spin: request.spin,
        scale: request.scale,
      });
      passableInstances += 1;
      // Nothing collides with a passable definition, so its copies need not
      // exist at all. A solid one still has to be expanded -- collision on
      // both sides reads those copies, and this changes where the geometry
      // is *drawn* from, never what it is -- so it falls through, and the
      // copies below are marked as already drawn by the batch.
      if (passable) continue;
      instancedMeshMembers = true;
      }
    }
    const members = resolveDefine(request.groupDefName, new Set());
    const placed = applyGroupInstanceTransform(members, request, instanceLabel);
    // A teleporter only becomes a real, linkable placement here, at the
    // outermost instance -- one full pass through every enclosing transform,
    // however many levels deep it started. `buildTeleporterLinks` (below,
    // once every instance in the file has run this) glob-matches a `link`
    // block's endpoint names against this list the same way upstream's own
    // `LinkManager::doLinking` does against `OBSTACLEMGR.getTeles()` -- a
    // `link` is never itself scoped inside a `define` (`CustomLink::
    // usesGroupDef` is false upstream), so one written with a wildcard
    // matches every instance uniformly rather than needing one per instance.
    for (const member of placed) {
      if (member.kind === 'teleporter') registerTeleporter(member);
    }
    obstacles.push(...placed);

    // Same instance, its definition's own meshes rather than its box/pyramid
    // members -- `resolveDefineMeshes`/`applyGroupInstanceTransformToMesh`
    // are `resolveDefine`/`applyGroupInstanceTransform`'s own mesh
    // equivalents, so a `group` placing a mesh-only definition (real local
    // maps do this -- `import-Planet-MoFo.com_4202.bzw`'s "base_pillar")
    // reaches `meshes` the same way a box/pyramid one reaches `obstacles`.
    const definedMeshes = resolveDefineMeshes(request.groupDefName, new Set());
    meshes.push(...definedMeshes.map((m) => {
      const placed = applyGroupInstanceTransformToMesh(m, request, instanceLabel);
      // Drawn by the batch above, not one by one: the copy still exists
      // because collision reads it, on this side and the client's.
      if (instancedMeshMembers) placed.drawnByInstance = true;
      return placed;
    }));
  }
  // How many group instances are drawn from a shared template rather than a
  // copy apiece (#153).
  // Logged once the repeated meshes below have joined them.
  const logInstancing = (repeats) => {
    if (passableInstances === 0 && repeats.meshes === 0) return;
    const templateFaces = [...meshTemplates.values()]
      .reduce((sum, list) => sum + list.reduce((n, m) => n + meshArrays(m).faceCount, 0), 0);
    instancing = {
      instanced: passableInstances,
      groups: groupInstanceRequests.length,
      templates: meshTemplates.size,
      faces: templateFaces,
      repeats: repeats.meshes,
      repeatShapes: repeats.shapes,
    };
    if (!quiet) log(`${mapLabel}: ${formatInstancing(instancing)}`);
    notes.push(`${mapLabel}: ${formatInstancing(instancing)}`);
  };
  if (unknownGroupDefs.size > 0) {
    warn(
      `Ignoring "group" instances naming a "define" not in ${mapLabel}:`
      + ` ${Array.from(unknownGroupDefs).sort().join(', ')}`
    );
  }
  if (groupCycleWarnings.size > 0) {
    warn(
      `Avoided recursion in ${mapLabel}: definition(s) `
      + `${Array.from(groupCycleWarnings).sort().join(', ')} reference themselves `
      + 'through a group instance, directly or through others'
    );
  }

  if (nonVerticalSpinCount > 0) {
    warn(
      `Ignoring ${nonVerticalSpinCount} "spin" line(s) about an axis other than `
      + `vertical in ${mapLabel} -- bzo's box/pyramid model can't tip that way`
    );
  }
  if (tippedObstacleCount > 0) {
    warn(
      `Not tipping ${tippedObstacleCount} obstacle(s) placed by a group spun off `
      + `vertical or sheared in ${mapLabel} -- bzo's box/pyramid model can't tip that way`
    );
  }
  if (unreadZoneKeywords.size > 0) {
    warn(
      `Ignoring zone keywords bzo does not read in ${mapLabel}:`
      + ` ${Array.from(unreadZoneKeywords).sort().join(', ')}`
    );
  }
  if (unreadWeaponKeywords.size > 0) {
    warn(
      `Ignoring weapon keywords bzo does not read in ${mapLabel}:`
      + ` ${Array.from(unreadWeaponKeywords).sort().join(', ')}`
      + ' (those weapons fire on their timer instead)'
    );
  }
  if (unreadWeaponTypes.size > 0) {
    warn(
      `Weapon types bzo does not have in ${mapLabel}:`
      + ` ${Array.from(unreadWeaponTypes).sort().join(', ')}`
      + ' (those weapons fire an ordinary shell)'
    );
  }
  if (unresolvedMaterialRefs.size > 0) {
    warn(
      `Ignoring "matref" naming a material not defined in ${mapLabel}:`
      + ` ${Array.from(unresolvedMaterialRefs).sort().join(', ')}`
    );
  }
  if (unresolvedDynamicColorRefs.size > 0) {
    warn(
      `Ignoring "dyncol" naming a dynamicColor not defined in ${mapLabel}:`
      + ` ${Array.from(unresolvedDynamicColorRefs).sort().join(', ')}`
    );
  }
  if (unresolvedTextureMatrixRefs.size > 0) {
    warn(
      `Ignoring "texmat" naming a textureMatrix not defined in ${mapLabel}:`
      + ` ${Array.from(unresolvedTextureMatrixRefs).sort().join(', ')}`
    );
  }
  if (unresolvedTextureNames.size > 0) {
    warn(
      `Texture name(s) bzo has no local asset for in ${mapLabel}, kept at the `
      + `obstacle's plain default: ${Array.from(unresolvedTextureNames).sort().join(', ')}`
    );
  }
  if (externalTextureUrls.size > 0) {
    // Counted by host, not listed one URL at a time -- a real map can name a
    // few dozen of these (every one of `import-xs.bzexcess.com_5155.bzw`'s
    // own materials does), and every client already attempts every host
    // regardless (`isExternalTextureUrlLoadable`, public/texture.js) -- what
    // is worth a player's attention on join is which hosts this map trusted,
    // not each individual picture.
    const hostCounts = new Map();
    for (const url of externalTextureUrls) {
      let host = 'local';
      try {
        host = new URL(`https:${url}`).host || 'local';
      } catch {
        host = 'local';
      }
      hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    }
    const summary = Array.from(hostCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([host, count]) => `${count} - ${host}`)
      .join(', ');
    warn(`${mapLabel} textures: ${summary}`);
  }

  // The same mesh written out at many places and facings -- a compiled world
  // arrives with its groups flattened -- drawn as one template and a
  // placement apiece, through the same path a passable `group` takes (#153). Every copy stays in `meshes`
  // for collision and the radar, marked as drawn by the batch.
  logInstancing(instanceRepeatedMeshes(meshes));

  // Joined into `obstacles` before the tally below, so "included" counts a
  // mesh along with everything else that actually collides, renders, and
  // shows on radar now -- the same list a client draws from, so the radar,
  // the buried-face test and the box/pyramid fragment builder all see one
  // obstacle list and only have to skip a shape they don't handle, not learn
  // a second array.
  obstacles.push(...meshes);

  // A world-space AABB for every obstacle, in the same `{minX, maxX, minY,
  // maxY, minZ, maxZ}` shape a mesh's own `.bounds` (`computeMeshBounds`,
  // above) already has -- computed once, here, rather than re-derived from
  // `pos`/`size`/`angle` inside a hot collision loop every time a query
  // happens to reach this obstacle. `xSpan`/`ySpan` is upstream's own
  // rotated-rectangle extent formula (`Obstacle::setExtents`,
  // `Obstacle.cxx:87-98`): the half-extent a box or a pyramid's own bounding
  // rectangle needs on each axis to contain every corner at any rotation,
  // exact rather than a looser circle. A mesh already has a real one from
  // its own vertices and is left alone. This is what lets the shared
  // `findTankObstacle` loop (`server/collision.cjs`/`public/collision.mjs`)
  // reject an obstacle that is entirely out of range on any one axis --
  // above, below, or to any one side -- the same one-line way regardless of
  // which of these shapes it actually is.
  for (const obstacle of obstacles) {
    if (obstacle.bounds) continue;
    const x = obstacle.pos?.[0] || 0;
    const y = obstacle.pos?.[1] || 0;
    const base = obstacle.pos?.[2] || 0;
    const angle = obstacle.angle || 0;
    const halfW = obstacle.size?.[0] || 0;
    const halfD = obstacle.size?.[1] || 0;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const xSpan = (cos * halfW) + (sin * halfD);
    const ySpan = (cos * halfD) + (sin * halfW);
    obstacle.bounds = {
      minX: x - xSpan,
      maxX: x + xSpan,
      minY: y - ySpan,
      maxY: y + ySpan,
      minZ: base,
      maxZ: base + getObstacleHeight(obstacle),
    };
  }

  // Resolves every obstacle's (and every mesh face's) raw `phydrv` string
  // against the driver registry above, the same digit-first-then-name check
  // `matref` uses. Deferred to one pass over the whole obstacle list, rather
  // than resolved inline the way `matref` is, since `phydrv` is set across
  // many different shapes (box, pyramid, a group member, every mesh
  // generator, and a mesh's own per-face default) and one shared pass here
  // is simpler than teaching each of them the same lookup. This also makes
  // bzo strictly more lenient than upstream, which requires a `physics`
  // block to appear before anything referencing it -- no sampled map
  // depends on that stricter order, since a real map always defines its
  // drivers first regardless.
  function resolvePhysicsDriverRef(rawRef) {
    if (!rawRef) return null;
    const driver = /^[0-9]/.test(rawRef)
      ? physicsDriverRegistry[parseInt(rawRef, 10)] || null
      : physicsDriversByName.get(rawRef.toLowerCase()) || null;
    if (!driver) unresolvedPhysicsDriverRefs.add(rawRef.toLowerCase());
    return driver;
  }
  // A mesh names its drivers in a table of its own that `facePhydrv` indexes
  // -- a handful of entries, not one per face -- so resolving there is both
  // less work than walking faces and the only form that still works once a
  // mesh carries no face objects at all (issue #153).
  const resolveArrayPhydrvs = (mesh) => {
    for (const arrays of [mesh.arrayData, mesh.drawArrayData]) {
      if (!arrays || !Array.isArray(arrays.phydrvs)) continue;
      arrays.phydrvs = arrays.phydrvs.map(
        (phydrv) => (typeof phydrv === 'string' ? resolvePhysicsDriverRef(phydrv) : phydrv),
      );
    }
  };
  const resolveMeshPhydrvs = (mesh) => resolveArrayPhydrvs(mesh);
  for (const obstacle of obstacles) {
    if (typeof obstacle.phydrv === 'string') {
      obstacle.phydrv = resolvePhysicsDriverRef(obstacle.phydrv);
    }
    resolveMeshPhydrvs(obstacle);
  }
  // A `define`'s own template meshes are never in `obstacles` -- the client
  // places them by transform rather than by copy (#153) -- so a pass over
  // that list alone left their drivers as the bare names they were written
  // with, and a face riding one behaved as though it had none.
  for (const meshes of meshTemplates.values()) {
    for (const mesh of meshes) resolveMeshPhydrvs(mesh);
  }
  if (unresolvedPhysicsDriverRefs.size > 0) {
    warn(
      `Ignoring "phydrv" naming a physics driver not defined in ${mapLabel}:`
      + ` ${Array.from(unresolvedPhysicsDriverRefs).sort().join(', ')}`
    );
  }

  if (degenerateFaceCounts.size > 0) {
    const dropped = Array.from(degenerateFaceCounts.values()).reduce((sum, n) => sum + n, 0);
    const list = Array.from(degenerateFaceCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
      .join(', ');
    warn(`${mapLabel} dropped ${dropped} zero-area mesh face${dropped === 1 ? '' : 's'}: ${list}`);
  }

  // The same fault in the one shape bzo does not build as a mesh. A box or
  // pyramid naming a material or a physics driver is a mesh to bzfs
  // (`isOldBox`, CustomBox.cxx:304; `isOldPyramid`, CustomPyramid.cxx) and
  // stays a box here, so the faces that would be degenerate are never built
  // and the check above cannot see them. Flush is legal for a plain box --
  // this map puts a passable pad under every flag zone (see the `end`
  // handler) -- so only the meshed kind is worth a word, and it is a warning
  // rather than a repair: bzfs discards those faces and plays on, and the
  // operator is the one who can decide whether the pad wanted a height.
  //
  // `texsize` and `texoffset` also clear `isOldBox` upstream. bzo reads
  // neither on a box, so they arrive in `unreadKeywordCounts` above instead
  // of here.
  const flushMeshedNames = [];
  for (const obstacle of obstacles) {
    if (!obstacle.meshedByBzfs) continue;
    if (obstacle.type !== 'box' && obstacle.type !== 'pyramid') continue;
    if (obstacle.size?.[0] !== 0 && obstacle.size?.[1] !== 0 && obstacle.size?.[2] !== 0) continue;
    flushMeshedNames.push(obstacle.name || obstacle.type);
  }
  if (flushMeshedNames.length > 0) {
    warn(
      `${mapLabel} has ${flushMeshedNames.length} zero-size`
      + ` ${flushMeshedNames.length === 1 ? 'obstacle' : 'obstacles'} naming a material or`
      + ` physics driver, which bzfs builds as a mesh with faces it then`
      + ` discards: ${flushMeshedNames.sort().join(', ')}`
    );
  }
  if (unreadPhysicsDriverKeywords.size > 0) {
    warn(
      `Physics driver keywords bzo does not read in ${mapLabel}:`
      + ` ${Array.from(unreadPhysicsDriverKeywords).sort().join(', ')}`
    );
  }

  if (unsupportedCounts.size > 0) {
    const dropped = Array.from(unsupportedCounts.values()).reduce((sum, n) => sum + n, 0);
    const droppedList = Array.from(unsupportedCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([keyword, count]) => `${count} ${keyword}`)
      .join(', ');
    warn(`${mapLabel} ignored: ${dropped} unsupported block${dropped === 1 ? '' : 's'} (${droppedList})`);
  }

  if (serverOptions.unreadOptions && serverOptions.unreadOptions.size > 0) {
    const unreadOptionList = Array.from(serverOptions.unreadOptions.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([option, count]) => (count > 1 ? `${option} x${count}` : option))
      .join(', ');
    warn(`${mapLabel} ignored options: ${unreadOptionList}`);
  }

  if (serverOptions.unreadBZDBVars && serverOptions.unreadBZDBVars.length > 0) {
    warn(
      `${mapLabel} ignored -set variables: `
      + Array.from(new Set(serverOptions.unreadBZDBVars)).sort().join(', ')
    );
  }

  if (unreadKeywordCounts.size > 0) {
    const unreadList = Array.from(unreadKeywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([keyword, count]) => `${keyword} x${count}`)
      .join(', ');
    warn(`${mapLabel} ignored: ${unreadList}`);
  }

  // What a player actually sees when they view or join this map -- not just
  // server.log. `-srvmsg` (serverOptions.serverMessages) reads as a message
  // the *map* says to whoever arrives on it (bzfs.cxx:2507); every "bzo does
  // not do this" fact this function found is the same kind of thing, so it
  // rides along in the same list rather than a separate, re-worded one --
  // `warnedMessages` already carries the exact line each one was logged
  // with. Deduplicated: a second parse of the same file (see
  // `performRemoteMapImportNow`, after baking these back in as `-srvmsg`)
  // re-detects the same facts fresh *and* reads them back off
  // `serverOptions.serverMessages`, so without this every line would say
  // itself twice. Built here, once, per file (see `registerMapFile`): the
  // client reads this from the map's own registry entry and says it locally
  // the moment a player actually starts viewing that map, never during the
  // entry dialog's preview-while-choosing.
  //
  // `notes` follow them: what bzo did with the map rather than what it could
  // not do, so they are said to a player but never baked into an import's
  // `-srvmsg` lines, where they would go stale the moment bzo changed.
  const messages = Array.from(new Set([...serverOptions.serverMessages, ...warnedMessages, ...notes]));

  // Ground texture (issue #81) -- the one surface that is never an
  // obstacle, so it gets no `matref`d registry entry of its own the way
  // box/pyramid/mesh materials do. Upstream reads either spelling into the
  // same registry entry (see the `-gndtex` comment above), so a map's own
  // explicit `material name GroundMaterial ... end` block -- fuller, since
  // it can also carry a tint `BackgroundRenderer::setupGroundMaterials`
  // reads for `groundColor` -- wins when a map somehow writes both.
  let mapGroundMaterial = null;
  const groundMaterialBlock = materialsByName.get('groundmaterial') || null;
  if (groundMaterialBlock
    && (groundMaterialBlock.texture || groundMaterialBlock.textureUrl || groundMaterialBlock.color)) {
    mapGroundMaterial = {
      texture: groundMaterialBlock.texture,
      textureUrl: groundMaterialBlock.textureUrl,
      color: groundMaterialBlock.color,
      // A `GroundMaterial`'s own `dyncol`/`texmat` (resolved above like any
      // other material's) -- `render.js`'s `buildGround` registers these
      // with `_animatedMaterials` the same way `buildWater` already does.
      dynamicColor: groundMaterialBlock.dynamicColor,
      textureMatrix: groundMaterialBlock.textureMatrix,
    };
  } else if (serverOptions.groundTexture) {
    const resolved = resolveBzwTextureName(serverOptions.groundTexture);
    if (resolved) {
      mapGroundMaterial = { texture: resolved.stock || null, textureUrl: resolved.url || null, color: null };
    }
  }

  const teleporterGraph = buildTeleporterLinks();
  const world = {
    obstacles,
    // A definition's geometry once, and the placements sharing it -- only
    // definitions nothing collides with, so these are never in `obstacles`
    // and nothing but the renderer reads them (#153). Plain objects rather
    // than the `Map`, since this goes into the world JSON as it stands.
    meshTemplates: Object.fromEntries(meshTemplates),
    meshInstances,
    teleporterGraph,
    teamMode,
    serverOptions,
    zones,
    weapons,
    mapSize,
    flagHeight: mapFlagHeight,
    physicsDrivers: physicsDriverRegistry,
    noWalls: mapNoWalls || serverOptions.noWalls === true,
    freeCtfSpawns: mapFreeCtfSpawns || serverOptions.freeCtfSpawns === true,
    waterLevel: mapWaterLevel,
    weather: serverOptions.weather || null,
    groundMaterial: mapGroundMaterial,
    messages,
    warnedMessages,
    instancing,
  };
  attachMeshArrayPayloads(world);
  return world;
}

// Which layout a world file is in. Raised whenever a parse of the same map
// would come out different, so a server does not restore a world it wrote
// in an older one: 2 is upstream's frame (#182).
const WORLD_FORMAT = 3;

// `instanced 18/22 groups, 15 templates, 52 faces` -- group instances drawn
// from a shared template rather than a copy apiece (#153).
function formatInstancing({ instanced, groups, templates, faces, repeats = 0, repeatShapes = 0 }) {
  return `instanced ${instanced}/${groups} groups, ${templates} templates, ${faces} faces`
    + (repeats > 0 ? `, ${repeats} repeated meshes as ${repeatShapes}` : '');
}

// Every mesh in a world, carrying its own flat arrays beside its faces. A
// template's meshes get them too: the client draws those without ever seeing
// them in `obstacles`.
function attachMeshArrayPayloads(entry) {
  const attach = (mesh) => {
    // A template's meshes carry no `type`, being meshes by construction; an
    // obstacle list carries every kind, so only the meshes are taken.
    if (!mesh || (mesh.type !== undefined && mesh.type !== 'mesh')) return;
    if (!mesh.arrayData && (!Array.isArray(mesh.faces) || !Array.isArray(mesh.vertices))) return;
    // Built by the same two functions the client reads them back with, so
    // what counts as a separate draw geometry is decided in one place, and
    // built in `finalizeMeshGeometry` where a mesh's faces settle -- rebuilt
    // here only for a mesh that never went through it. A mesh with no
    // separate draw geometry gets no `drawArrays`: `meshDrawArrays` hands
    // back the collision arrays, and the two are then the same object.
    const collision = mesh.arrayData || meshArrays(mesh);
    const draw = mesh.drawArrayData || meshDrawArrays(mesh);
    mesh.arrays = encodeMeshArrays(collision);
    if (draw !== collision) mesh.drawArrays = encodeMeshArrays(draw);
    // And now the objects they were built from go (issue #153). Nothing
    // reads them past here -- collision, the renderer, the radar, the
    // overview picture and the map summary all take the arrays -- and this
    // is what the conversion was for. `MAP_REGISTRY` holds the entry for the
    // life of the process, so a face object kept here is kept for every map
    // this server has ever parsed: 113.8MB of a 172MB cache, at roughly
    // 2,134 bytes a face against the arrays' 93.
    //
    // The vertex, normal and texcoord pools go with them: the arrays carry
    // the same numbers, and a face index is the only way in now.
    for (const field of [
      'faces', 'vertices', 'normals', 'texcoords',
      'drawFaces', 'drawVertices', 'drawNormals', 'drawTexcoords',
    ]) delete mesh[field];
    // The decoded arrays are the parser's own working copy; `arrays` carries
    // the same thing on the wire, far smaller.
    delete mesh.arrayData;
    delete mesh.drawArrayData;
  };
  for (const obstacle of entry.obstacles || []) attach(obstacle);
  for (const meshes of Object.values(entry.meshTemplates || {})) {
    for (const mesh of meshes) attach(mesh);
  }
}

function getMaxObstacleTopY(obstacles = []) {
  return obstacles.reduce((maxTop, obstacle) => {
    // A mesh (a plain `mesh`, or any of the six generators, all of which
    // finish as `type: 'mesh'`) has no `size` at all -- its real extent is
    // `.bounds`, the world-space vertex box `computeMeshBounds` already
    // computed. Falling through to the box/pyramid-style `pos[2] + size[2]` below
    // for one of these silently answers 4 units tall regardless of its real
    // height (a tree, a tall building), which is short enough that clouds
    // end up level with a real map's own rooftops instead of above them.
    if (obstacle?.bounds && Number.isFinite(obstacle.bounds.maxZ)) {
      return Math.max(maxTop, obstacle.bounds.maxZ);
    }
    const base = Number.isFinite(obstacle?.pos?.[2]) ? obstacle.pos[2] : 0;
    const height = Number.isFinite(obstacle?.size?.[2]) ? obstacle.size[2] : 4;
    return Math.max(maxTop, base + height);
  }, 0);
}

// How high a tank can get, which is where the clouds have to start. Wings
// out-climbs an ordinary jump wherever a server raises _wingsJumpCount, because
// a flap taken at the top of the last one adds another whole apex. Upstream asks
// the same question in getMaxWorldHeight (bzfs.cxx:1264) and answers it with a
// deliberately generous over-estimate; this is the arithmetic behind it.
//
// `config` is the world's own (`worldConfig`), so the answer is that map's.
function getJumpApexHeight(config) {
  const apex = (velocity, gravity) => (velocity * velocity) / (2 * gravity);
  return Math.max(
    apex(config.JUMP_VELOCITY, config.GRAVITY),
    config.WINGS_JUMP_COUNT * apex(config.WINGS_JUMP_VELOCITY, config.WINGS_GRAVITY)
  );
}

// How high a map's cloud base is: a jump above its tallest obstacle, as that
// map plays here -- this server's `-set`s (`serverBzdb`) with the map's own
// over them, on the server's config (`gameConfig`).
function getCloudBaseY(obstacles, bzdbVars, { gameConfig, serverBzdb }) {
  const config = worldConfig(gameConfig, new Map([...serverBzdb, ...(bzdbVars || [])]));
  return getMaxObstacleTopY(obstacles) + getJumpApexHeight(config);
}

// Generate random clouds with fractal patter. `random` defaults to `Math.random`
// but `registerMapFile` passes a seeded one: clouds ride into the hashed,
// cached world file (see `MAP_REGISTRY`), and a hash that changed every boot
// for the same map -- because the decoration on top of it kept re-rolling --
// would defeat the whole reason that cache exists.
function generateClouds(cloudBaseY, random = Math.random) {
  const clouds = [];
  const numClouds = 15;

  for (let i = 0; i < numClouds; i++) {
    // Random position in sky. The rolls come in the order east, up, south,
    // so a seed keeps the clouds it has always rolled.
    const x = (random() - 0.5) * 200;
    const z = cloudBaseY + random() * 40;
    const y = 0 - ((random() - 0.5) * 200);

    // Fractal puffs (multiple spheres clustered together)
    const puffs = [];
    const numPuffs = 5 + Math.floor(random() * 8);

    for (let j = 0; j < numPuffs; j++) {
      const offsetX = (random() - 0.5) * 10;
      const offsetZ = (random() - 0.5) * 3;
      const offsetY = 0 - ((random() - 0.5) * 10);
      puffs.push({ offsetX, offsetY, offsetZ, radius: 2 + random() * 4 });
    }

    clouds.push({ x, y, z, puffs });
  }

  return clouds;
}

// A small, deterministic PRNG (mulberry32) seeded from the map's own
// obstacles/teleporters, so the same map always rolls the same clouds --
// across a restart, not just within one process -- which is what lets its
// world file keep the same hash and never orphan the one before it.
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One `+f <abbreviation|good|bad>[{count}]` into a type -> count table:
// upstream's `flagCount` (CmdLineOptions.cxx:1635-1675), one by default,
// `{n}` for n, `good`/`bad` one of every type in the set. A team type is not
// one bzo adds extras of.
function addRequiredFlags(spec, into) {
  const raw = String(spec).trim();
  const brace = raw.indexOf('{');
  const parsedCount = brace >= 0 ? parseInt(raw.slice(brace + 1), 10) : 1;
  const count = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 1;
  const wanted = (brace >= 0 ? raw.slice(0, brace) : raw).toUpperCase();
  const add = (abbreviation) => {
    into[abbreviation] = (into[abbreviation] || 0) + count;
  };
  if (wanted === 'GOOD' || wanted === 'BAD') {
    for (const abbreviation of FLAG_ABBREVIATIONS) {
      if (!isTeamFlag(abbreviation) && isBadFlag(abbreviation) === (wanted === 'BAD')) add(abbreviation);
    }
  } else if (getFlagType(wanted) && !isTeamFlag(wanted)) {
    add(wanted);
  }
  return into;
}

// Helper to send the map list and current map to a given websocket
// The same shape `init.viewableMaps` sends -- a map still hashing in the
// background is simply absent until the next call, same caveat as `init`'s
// own copy. Shared so the View dialog (which asks fresh, on demand, rather
// than waiting for a reconnect) and `init` never compute this two ways.
// What the View dialog says about a map before anyone opens it. Counting only
// -- everything here was parsed on the way in.
//
// Faces is the number worth having and the one nothing else predicts: among
// the bundled maps, 47 objects is 81,332 faces on one and 4,280 on another,
// while 409 objects is 56. Object count measures how much a mapper typed;
// faces measure what a browser has to draw, which is what decides whether a
// map is worth opening on a phone or a headset.
function summariseMap(entry) {
  const obstacles = Array.isArray(entry.obstacles) ? entry.obstacles : [];
  const counts = { box: 0, pyramid: 0, mesh: 0 };
  // A base is a box with a `kind` (`base` in parseBZWMap), so counting by
  // `type` alone files it under boxes. It is counted separately because it is
  // what decides the style below, and because "12 boxes" reads wrong when
  // four of them are the bases.
  let bases = 0;
  let faces = 0;
  for (const obstacle of obstacles) {
    if (obstacle.kind === 'base') bases += 1;
    else if (counts[obstacle.type] !== undefined) counts[obstacle.type] += 1;
    // From the arrays, which by now are the mesh's own description of
    // itself -- a count of face objects would be a count of something the
    // world no longer carries.
    if (obstacle.type === 'mesh' && obstacle.arrays) faces += meshArrays(obstacle).faceCount;
  }
  const teamMode = entry.teamMode || {};
  return {
    size: entry.mapSize,
    objects: obstacles.length,
    faces,
    // Upstream's own order, from the world file rather than from the
    // switches: a map with bases is Classic CTF, then Rabbit Chase, then
    // free-for-all (`bzfs.cxx:1120-1130`, where `worldData.ctf` is set by the
    // map having bases at all). So a map that states no mode is described by
    // what it contains, which is how bzfs would run it.
    style: bases > 0 ? 'CTF' : (teamMode.rabbitSelection ? 'Rabbit' : 'FFA'),
    counts,
    bases,
    // Teleporters are not obstacles in this JSON; the graph is where they are,
    // and it is an object of two lists rather than a list itself
    // (`{ teleporters, links }`, as `applyWorldData` reads it). A map with
    // them plays differently enough to be worth saying.
    teleporters: Array.isArray(entry.teleporterGraph?.teleporters)
      ? entry.teleporterGraph.teleporters.length
      : 0,
    water: entry.waterLevel !== null && entry.waterLevel !== undefined,
    weather: Boolean(entry.weather),
    ground: Boolean(entry.groundMaterial),
  };
}

// A parsed map as the world file bzo serves, and what is known of it: the
// JSON, its hash, the stats the map lists show, and the overview picture when
// `withOverview` asks for one (`server/map-overview.cjs`, issue #147). Pure, so
// it runs on a worker as well as in the server; writing any of it is the
// caller's.
//
// `gameConfig` and `serverBzdb` are the server's own, which a map's cloud base
// is reckoned against; `puffClouds` whether bzo's puffs are drawn at all.
function buildWorldFile(map, { gameConfig, serverBzdb, puffClouds, defaultMapSize, withOverview = false }) {
  const { obstacles, teleporterGraph, serverOptions } = map;
  // Seeded from the map's own geometry (not from its file name, so a map that
  // is renamed but not edited still lands on the same clouds and the same
  // hash) -- deterministic across processes, unlike a generated world's
  // obstacles, which are expected to roll a new hash every boot along with
  // everything else about them.
  //
  // Fed one obstacle at a time, the same bytes `JSON.stringify({ obstacles,
  // teleporterGraph })` would give: at this point a mesh still carries its
  // faces and decoded arrays, and a big map's whole list as one string is
  // past V8's string limit.
  const seedHash = crypto.createHash('sha256').update('{"obstacles":[');
  obstacles.forEach((obstacle, index) => {
    if (index > 0) seedHash.update(',');
    seedHash.update(JSON.stringify(obstacle) ?? 'null');
  });
  seedHash.update(`],"teleporterGraph":${JSON.stringify(teleporterGraph)}}`);
  const seed = seedHash.digest().readUInt32BE(0);
  const cloudBase = getCloudBaseY(obstacles, serverOptions?.bzdbVars, { gameConfig, serverBzdb });
  const entry = {
    obstacles,
    teleporterGraph,
    teamMode: map.teamMode,
    // Where a sky beacon hangs from, and bzo's puffs float from when asked for.
    cloudBase,
    clouds: puffClouds ? generateClouds(cloudBase, seededRandom(seed)) : [],
    // A Map Viewer's ground plane, boundary walls and mountains (issue #68)
    // need to match whichever map it is looking at, not the live match's --
    // see the client's `applyWorldData`.
    mapSize: Number.isFinite(map.mapSize) ? map.mapSize : defaultMapSize,
    // `noWalls` -- read here rather than derived from `mapSize`, since a Map
    // Viewer preview builds this same border from this same JSON (see
    // `applyWorldData`/`createMapBoundaries` in client.js/render.js) and has
    // no other way to know a map asked for none.
    noWalls: !!map.noWalls,
    // `waterLevel` -- a Map Viewer preview draws the plane from this same
    // JSON too (see `applyWorldData`/`buildWater` in client.js/render.js),
    // `null` when the map states none.
    waterLevel: map.waterLevel || null,
    // `weather` -- a Map Viewer preview draws it from this same JSON too (see
    // `applyWorldData`/`buildWeather` in client.js/render.js), `null` when the
    // map states no `_rainType`. Purely a client render: no collision, so
    // there is no server-side equivalent of `mapWaterLevel`'s kill check.
    weather: map.weather || null,
    // `groundMaterial` -- a Map Viewer preview draws it from this same JSON
    // too (see `applyWorldData`/`buildGround` in client.js/render.js),
    // `null` when the map states no `-gndtex` or `GroundMaterial` block.
    groundMaterial: map.groundMaterial || null,
    // `gameplay` -- how this map drives and shoots, for a Map Viewer preview
    // to lay over its own `gameConfig` (see `applyWorldData` in client.js).
    // Only what the map itself states, so a preview of a map that says
    // nothing about physics plays by whatever the viewer already had.
    // Deliberately no jumping or ricochet in here (bzo forces both on) and no
    // flag variables (a preview has no flags to grab).
    // The map's own game settings that are not BZDB (`-ms`), and its BZDB as
    // the `-set` lines wrote it, which a viewer evaluates itself (`worldConfig`).
    gameplay: serverOptions?.gameplay && Object.keys(serverOptions.gameplay).length ? serverOptions.gameplay : null,
    bzdb: serverOptions?.bzdbVars?.size ? Object.fromEntries(serverOptions.bzdbVars) : null,
    // What this map says to a player who arrives on it -- -srvmsg lines and
    // the dropped-unsupported-feature tally, both from parseBZWMap. Read by
    // the client only at the moment it actually starts viewing this map
    // (never during the entry dialog's preview-while-choosing); see
    // `announceWorldMessages` in client.js.
    messages: Array.isArray(map.messages) ? map.messages : [],
  };
  // Only when a map actually places something this way. Adding empty fields
  // to every other map would reissue every hash for nothing -- the entry is
  // what the hash is taken over.
  if (map.meshInstances && map.meshInstances.length) {
    entry.meshTemplates = map.meshTemplates;
    entry.meshInstances = map.meshInstances;
  }
  // Each mesh's geometry as flat arrays in place of its face objects (issue
  // #153).
  attachMeshArrayPayloads(entry);
  const json = JSON.stringify(entry);
  // A picture that will not draw is not worth losing the map over: it is
  // said, and the map goes without one.
  let svg = null;
  let overviewError = null;
  if (withOverview) {
    try {
      svg = mapOverview.buildMapOverviewSvg(entry);
    } catch (error) {
      overviewError = error.message || String(error);
    }
  }
  return {
    json,
    hash: crypto.createHash('sha256').update(json).digest('hex').slice(0, 12),
    // Outside the hashed entry: a description *of* the map rather than part
    // of it.
    stats: summariseMap(entry),
    svg,
    overviewError,
  };
}

module.exports = {
  WORLD_FORMAT,
  configureBzwParse,
  buildWorldFile,
  DEFAULT_WATER_TEXTURE_MATRIX,
  UNSUPPORTED_TOP_LEVEL_KEYWORDS,
  BZW_INERT_MATERIAL_KEYWORDS,
  multiplyMeshTransform,
  MESH_TRANSFORM_IDENTITY,
  meshTransformStep,
  buildMeshTransformTool,
  expandMeshDrawCommand,
  MESH_DRAW_MODES,
  readMeshTransformToken,
  meshTransformMovers,
  applyMeshTransform,
  bzwMaterialFlags,
  bzwFaceMaterial,
  TETRA_FACE_TOPOLOGY,
  buildTetraMesh,
  CONE_MIN_SIZE,
  MESHPYR_DEFAULT_BASE,
  MESHPYR_DEFAULT_HEIGHT,
  buildConeMesh,
  ARC_MIN_SIZE,
  ARC_SIDE_NAMES,
  buildArcPieLocal,
  buildArcRingLocal,
  buildArcMesh,
  SPHERE_MIN_SIZE,
  SPHERE_SIDE_NAMES,
  buildSphereMesh,
  WEATHER_RAIN_TYPES,
  WEATHER_RAIN_NUMERIC_VARS,
  TEAM_MODE_OPTIONS,
  parseBZWServerOptions,
  BZW_TELEPORTER_DEFAULTS,
  BZW_PASSABILITY_KEYWORDS,
  CONE_SIDE_NAMES,
  BZW_FACE_GROUPS,
  parseBzwColor,
  BZW_STOCK_TEXTURES,
  resolveBzwStockTexture,
  parseBzwTextureUrl,
  resolveBzwTextureName,
  faceMaxCrossSqr,
  MIN_FACE_CROSS_SQR,
  parseBZWMap,
  formatInstancing,
  attachMeshArrayPayloads,
  getMaxObstacleTopY,
  getJumpApexHeight,
  getCloudBaseY,
  generateClouds,
  seededRandom,
  addRequiredFlags,
  summariseMap,
};
