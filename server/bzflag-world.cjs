/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// bzflag-world.cjs - BZFlag's binary world, written. The inverse of
// `parseWorldDatabase` (remote-world-import.cjs), field for field, so the
// tree that reads a bzfs world back is also what writes one: what a native
// BZFlag client downloads from bzo (issue #174). `WorldInfo::packDatabase`
// and each manager's and obstacle's own `pack` (under $HOME/bzflag/src) are
// the reference. scripts/test-bzflag-world.mjs holds it to bzfs's own
// `-cacheout` output.

'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const { OBSTACLE_ORDER } = require('./remote-world-import.cjs');
const { compileBzwWorld } = require('./bzw-compile.cjs');

// Protocol.h:117-142 and global.h:121.
const WORLD_CODE_HEADER = 0x6865;
const WORLD_CODE_HEADER_SIZE = 10;
const WORLD_CODE_END = 0x6564;
const WORLD_CODE_END_SIZE = 0;
const MAP_VERSION = 1;

class Writer {
  constructor(size = 1 << 16) {
    this.buf = Buffer.alloc(size);
    this.o = 0;
  }

  ensure(n) {
    if (this.o + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.o + n));
    this.buf.copy(next, 0, 0, this.o);
    this.buf = next;
  }

  u8(v) { this.ensure(1); this.buf.writeUInt8(v & 0xff, this.o); this.o += 1; }

  u16(v) { this.ensure(2); this.buf.writeUInt16BE(v & 0xffff, this.o); this.o += 2; }

  i32(v) { this.ensure(4); this.buf.writeInt32BE(v | 0, this.o); this.o += 4; }

  u32(v) { this.ensure(4); this.buf.writeUInt32BE(v >>> 0, this.o); this.o += 4; }

  f32(v) { this.ensure(4); this.buf.writeFloatBE(v, this.o); this.o += 4; }

  vec3(v) { this.f32(v[0]); this.f32(v[1]); this.f32(v[2]); }

  bytes(b) { this.ensure(b.length); b.copy(this.buf, this.o); this.o += b.length; }

  // `nboPackStdString`: a u32 length, then the bytes.
  str(s) {
    const b = Buffer.from(String(s ?? ''), 'utf8');
    this.u32(b.length);
    this.bytes(b);
  }

  // `FlagType::pack`: two bytes, NUL padded.
  flagAbbv(abbv) {
    const b = Buffer.alloc(2);
    if (abbv) b.write(String(abbv), 0, 2, 'latin1');
    this.bytes(b);
  }

  done() { return this.buf.subarray(0, this.o); }
}

const bit = (flag, value) => (flag ? value : 0);

function packDynamicColor(w, color) {
  w.str(color.name);
  for (const channel of color.channels) {
    w.f32(channel.min);
    w.f32(channel.max);
    w.u32(channel.sinusoids.length);
    for (const s of channel.sinusoids) { w.f32(s.period); w.f32(s.offset); w.f32(s.weight); }
    w.u32(channel.clampUps.length);
    for (const c of channel.clampUps) { w.f32(c.period); w.f32(c.offset); w.f32(c.width); }
    w.u32(channel.clampDowns.length);
    for (const c of channel.clampDowns) { w.f32(c.period); w.f32(c.offset); w.f32(c.width); }
    const list = channel.sequence?.list || [];
    w.u32(list.length);
    if (list.length > 0) {
      w.f32(channel.sequence.period);
      w.f32(channel.sequence.offset);
      for (const value of list) w.u8(value);
    }
  }
}

function packTextureMatrix(w, t) {
  w.str(t.name);
  w.u8(bit(t.useStatic, 1) | bit(t.useDynamic, 2));
  if (t.useStatic) {
    w.f32(t.rotation);
    w.f32(t.uFixedShift); w.f32(t.vFixedShift);
    w.f32(t.uFixedScale); w.f32(t.vFixedScale);
    w.f32(t.uFixedCenter); w.f32(t.vFixedCenter);
  }
  if (t.useDynamic) {
    w.f32(t.spinFreq);
    w.f32(t.uShiftFreq); w.f32(t.vShiftFreq);
    w.f32(t.uScaleFreq); w.f32(t.vScaleFreq);
    w.f32(t.uScale); w.f32(t.vScale);
    w.f32(t.uCenter); w.f32(t.vCenter);
  }
}

function packMaterial(w, m) {
  w.str(m.name);
  w.u8(bit(m.noCulling, 1) | bit(m.noSorting, 2) | bit(m.noRadar, 4) | bit(m.noShadow, 8)
    | bit(m.occluder, 16) | bit(m.groupAlpha, 32) | bit(m.noLighting, 64));
  w.i32(m.dynamicColor);
  for (const color of [m.ambient, m.diffuse, m.specular, m.emission]) for (const c of color) w.f32(c);
  w.f32(m.shininess);
  w.f32(m.alphaThreshold);
  w.u8(m.textures.length);
  for (const t of m.textures) {
    w.str(t.name);
    w.i32(t.matrix);
    w.i32(t.combineMode);
    w.u8(bit(t.useAlpha, 1) | bit(t.useColor, 2) | bit(t.useSphereMap, 4));
  }
  w.u8(m.shaders.length);
  for (const shader of m.shaders) w.str(shader.name);
}

function packPhysicsDriver(w, d) {
  w.str(d.name);
  w.vec3(d.linear);
  w.f32(d.angularVel);
  w.f32(d.angularPos[0]); w.f32(d.angularPos[1]);
  w.f32(d.radialVel);
  w.f32(d.radialPos[0]); w.f32(d.radialPos[1]);
  w.f32(d.slideTime);
  w.str(d.deathMsg);
}

function packTransform(w, t) {
  w.str(t.name);
  w.u32(t.ops.length);
  for (const op of t.ops) {
    w.u8(op.type);
    if (op.type === 4) {
      w.i32(op.index);
      continue;
    }
    w.vec3(op.data);
    if (op.type === 3) w.f32(op.spin);
  }
}

function packBoxLike(w, o) {
  w.vec3(o.pos);
  w.f32(o.angle);
  w.vec3(o.size);
  w.u8(bit(o.driveThrough, 1) | bit(o.shootThrough, 2) | bit(o.flipZ, 4) | bit(o.ricochet, 8));
}

function packBase(w, o) {
  w.u16(o.team);
  packBoxLike(w, o);
}

function packTeleporter(w, o) {
  w.str(o.name);
  w.vec3(o.pos);
  w.f32(o.angle);
  w.vec3(o.size);
  w.f32(o.border);
  w.u8(o.horizontal ? 1 : 0);
  w.u8(bit(o.driveThrough, 1) | bit(o.shootThrough, 2) | bit(o.ricochet, 8));
}

function packWall(w, o) {
  w.vec3(o.pos);
  w.f32(o.angle);
  w.f32(o.y);
  w.f32(o.z);
  w.u8(bit(o.ricochet, 8));
}

function packMeshFace(w, f) {
  const useNormals = Array.isArray(f.normalIdx);
  const useTexcoords = Array.isArray(f.texcoordIdx);
  w.u8(bit(useNormals, 1) | bit(useTexcoords, 2) | bit(f.driveThrough, 4) | bit(f.shootThrough, 8)
    | bit(f.smoothBounce, 16) | bit(f.noclusters, 32) | bit(f.ricochet, 64));
  w.i32(f.vertexIdx.length);
  for (const i of f.vertexIdx) w.i32(i);
  if (useNormals) for (const i of f.normalIdx) w.i32(i);
  if (useTexcoords) for (const i of f.texcoordIdx) w.i32(i);
  w.i32(f.matindex);
  w.i32(f.phydrv);
}

// `MeshObstacle::pack`. A mesh's packed MeshDrawInfo (`drawInfoBlob`, made
// by bzw-compile.cjs) rides in its texcoord list: padded to a texcoord's
// eight bytes, counted as texcoords, and followed by its own length so a
// reader can step back to it (MeshObstacle.cxx:672-694). The reader keeps
// what the draw info draws rather than the blob, so a tree it made packs
// plain faces.
function packMesh(w, m) {
  w.i32(m.checks.length);
  for (const check of m.checks) { w.u8(check.type); w.vec3(check.point); }
  w.i32(m.vertices.length);
  for (const v of m.vertices) w.vec3(v);
  w.i32(m.normals.length);
  for (const n of m.normals) w.vec3(n);
  const blob = m.drawInfoBlob || null;
  let fullLength = 0;
  if (blob) fullLength = blob.length + ((8 - (blob.length % 8)) % 8);
  w.i32(blob ? m.texcoords.length + (fullLength / 8) + 1 : m.texcoords.length);
  for (const t of m.texcoords) { w.f32(t[0]); w.f32(t[1]); }
  if (blob) {
    w.bytes(blob);
    for (let i = blob.length; i < fullLength; i += 1) w.u8(0);
    w.i32(fullLength + 8);
    w.i32(0);
  }
  w.i32(m.faces.length);
  for (const f of m.faces) packMeshFace(w, f);
  w.u8(bit(m.driveThrough, 1) | bit(m.shootThrough, 2) | bit(m.smoothBounce, 4)
    | bit(m.noclusters, 8) | bit(blob, 16) | bit(m.ricochet, 32));
}

function packCurved(w, o, kind) {
  packTransform(w, o.transform);
  w.vec3(o.pos);
  w.vec3(o.size);
  w.f32(o.angle);
  if (kind !== 'sphere') w.f32(o.sweepAngle);
  if (kind === 'arc') w.f32(o.ratio);
  w.i32(o.divisions);
  w.i32(o.phydrv);
  for (const t of o.texsize) w.f32(t);
  for (const m of o.materials) w.i32(m);
  const tail = kind === 'sphere'
    ? bit(o.hemisphere, 16) | bit(o.ricochet, 32)
    : bit(o.ricochet, 16);
  w.u8(bit(o.driveThrough, 1) | bit(o.shootThrough, 2) | bit(o.smoothBounce, 4)
    | bit(o.useNormals, 8) | tail);
}

function packTetra(w, o) {
  w.u8(bit(o.driveThrough, 1) | bit(o.shootThrough, 2) | bit(o.ricochet, 4));
  packTransform(w, o.transform);
  for (const v of o.vertices) w.vec3(v);
  w.u8(o.normals.reduce((bits, n, i) => bits | (n ? 1 << i : 0), 0));
  for (const n of o.normals) if (n) for (const v of n) w.vec3(v);
  w.u8(o.texcoords.reduce((bits, t, i) => bits | (t ? 1 << i : 0), 0));
  for (const t of o.texcoords) if (t) for (const uv of t) { w.f32(uv[0]); w.f32(uv[1]); }
  for (const m of o.materials) w.i32(m);
}

// `GroupInstance::pack`: the name carries the material map behind a NUL when
// there is one.
function packGroupInstance(w, g) {
  w.str(g.groupdef);
  let name = Buffer.from(String(g.name ?? ''), 'utf8');
  if (g.matMap && g.matMap.length > 0) {
    const tail = Buffer.alloc(1 + 4 + (g.matMap.length * 8));
    tail.writeInt32BE(g.matMap.length, 1);
    g.matMap.forEach(([src, dst], i) => {
      tail.writeInt32BE(src, 5 + (i * 8));
      tail.writeInt32BE(dst, 9 + (i * 8));
    });
    name = Buffer.concat([name, tail]);
  }
  w.u32(name.length);
  w.bytes(name);
  packTransform(w, g.transform);
  w.u8(bit(g.modifyTeam, 1) | bit(g.modifyColor, 2) | bit(g.modifyPhysicsDriver, 4)
    | bit(g.modifyMaterial, 8) | bit(g.driveThrough, 16) | bit(g.shootThrough, 32) | bit(g.ricochet, 64));
  if (g.modifyTeam) w.u16(g.team);
  if (g.modifyColor) { w.vec3(g.tint); w.f32(g.tint[3]); }
  if (g.modifyPhysicsDriver) w.i32(g.phydrv);
  if (g.modifyMaterial) w.i32(g.material);
}

const OBSTACLE_PACKERS = {
  wall: packWall, box: packBoxLike, pyr: packBoxLike, base: packBase, tele: packTeleporter,
  mesh: packMesh, arc: (w, o) => packCurved(w, o, 'arc'), cone: (w, o) => packCurved(w, o, 'cone'),
  sphere: (w, o) => packCurved(w, o, 'sphere'), tetra: packTetra,
};

function packGroupDefinition(w, def) {
  w.str(def.name);
  for (const kind of OBSTACLE_ORDER) {
    const list = def.obstacles[kind] || [];
    w.u32(list.length);
    for (const o of list) OBSTACLE_PACKERS[kind](w, o);
  }
  w.u32(def.groupInstances.length);
  for (const g of def.groupInstances) packGroupInstance(w, g);
}

function packWeapon(w, weapon) {
  w.flagAbbv(weapon.flagAbbv);
  w.vec3(weapon.pos);
  w.f32(weapon.dir);
  w.f32(weapon.initDelay);
  w.u16(weapon.delay.length);
  for (const d of weapon.delay) w.f32(d);
}

function packEntryZone(w, zone) {
  w.vec3(zone.pos);
  w.vec3(zone.size);
  w.f32(zone.rot);
  w.u16(zone.flags.length);
  w.u16(zone.teams.length);
  w.u16(zone.safety.length);
  for (const f of zone.flags) w.flagAbbv(f);
  for (const t of zone.teams) w.u16(t);
  for (const s of zone.safety) w.u16(s);
}

// `WorldInfo::packDatabase`'s body, before compression.
function packWorldBody(tree) {
  const w = new Writer();
  const { managers } = tree;
  const list = (items, pack) => { w.u32(items.length); for (const item of items) pack(w, item); };
  list(managers.dynamicColors, packDynamicColor);
  list(managers.textureMatrices, packTextureMatrix);
  list(managers.materials, packMaterial);
  list(managers.physicsDrivers, packPhysicsDriver);
  list(managers.meshTransforms, packTransform);
  packGroupDefinition(w, tree.world);
  list(tree.groupDefs, packGroupDefinition);
  list(tree.links, (ww, link) => { ww.str(link.src); ww.str(link.dst); });
  w.f32(tree.waterLevel);
  if (tree.waterLevel >= 0) w.i32(tree.waterMaterial);
  list(tree.weapons, packWeapon);
  list(tree.zones, packEntryZone);
  return w.done();
}

// The blob a client downloads (bzfs.cxx:1188-1205): a header, the body
// deflated at level 9 as `compress2` does, and an empty end marker.
function packWorldDatabase(tree) {
  const body = packWorldBody(tree);
  const compressed = zlib.deflateSync(body, { level: 9 });
  const out = Buffer.alloc(4 + WORLD_CODE_HEADER_SIZE + compressed.length + 4 + WORLD_CODE_END_SIZE);
  let o = 0;
  o = out.writeUInt16BE(WORLD_CODE_HEADER_SIZE, o);
  o = out.writeUInt16BE(WORLD_CODE_HEADER, o);
  o = out.writeUInt16BE(tree.mapVersion ?? MAP_VERSION, o);
  o = out.writeUInt32BE(body.length, o);
  o = out.writeUInt32BE(compressed.length, o);
  o += compressed.copy(out, o);
  o = out.writeUInt16BE(WORLD_CODE_END_SIZE, o);
  out.writeUInt16BE(WORLD_CODE_END, o);
  return out;
}

// The hash bzfs gives a world loaded from a `.bzw`: `p` and the MD5 of the
// database it sends (bzfs.cxx:1208). bzo's packing is bzfs's byte for byte
// (scripts/test-bzflag-world.mjs), so this is what a recording made on that
// map carries, and how a replay names its local map. Null for a map the
// compiler cannot reproduce.
function bzfsWorldHashOfBzw(text) {
  try {
    const tree = compileBzwWorld(text);
    if (tree.unsupported && tree.unsupported.length > 0) return null;
    return `p${crypto.createHash('md5').update(packWorldDatabase(tree)).digest('hex')}`;
  } catch {
    return null;
  }
}

module.exports = { packWorldBody, packWorldDatabase, bzfsWorldHashOfBzw };
