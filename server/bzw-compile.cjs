/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// bzw-compile.cjs - A .bzw map compiled the way bzfs compiles one, into the
// tree `parseWorldDatabase` (remote-world-import.cjs) reads back out of a
// bzfs world, so `packWorldDatabase` (bzflag-world.cjs) can write what a
// native BZFlag client downloads without bzfs installed (issue #174).
//
// It mirrors upstream rather than bzo's own map reader, field for field:
// BZWReader.cxx's token loop and istream reads, each Custom*.cxx object, the
// obstacle classes under src/obstacle, and the managers under src/game. Upstream
// computes in single precision, so every float result here goes through
// `f` (Math.fround) at the same steps upstream rounds it to a float.
// scripts/test-bzflag-world.mjs holds the output to bzfs's own `-cacheout`.

'use strict';

const { BZDB_DEFAULTS } = require('../public/js/bzdb-defaults.mjs');
const { COLOR_NAMES } = require('../public/js/color-names.mjs');
const { FLAG_TYPES, FLAG_QUALITY, FLAG_ENDURANCE } = require('../public/js/flags.mjs');

const f = Math.fround;
const MAX_EXTENT = f(1.0e30);
const FLT_MAX = 3.4028234663852886e38;
const RAD_PER_DEG = Math.PI / 180.0;

// ---------------------------------------------------------------------------
// A std::istream over the map's text: the subset of libstdc++'s extraction
// semantics BZWReader and the Custom objects lean on, failbit included --
// a failed read stops the whole file, as it does upstream.
// ---------------------------------------------------------------------------

// `strtof`: the float nearest the decimal, decided exactly. Rounding the
// text to a double first and the double to a float can land one float off
// when the double sits on a float midpoint.
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
function floatStep(x, up) {
  if (x === 0) return up ? 1.401298464324817e-45 : -1.401298464324817e-45;
  F32[0] = x;
  if ((x > 0) === up) U32[0] += 1;
  else U32[0] -= 1;
  return F32[0];
}
function exactDouble(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exp !== 0) mant |= 1n << 52n;
  return { sign: x < 0 ? -1n : 1n, mant, pow2: (exp === 0 ? 1 : exp) - 1075 };
}
// -1, 0 or 1 as the decimal digits * 10^pow10 compare with x (both > 0).
function compareExact(digits, pow10, x) {
  const { mant, pow2 } = exactDouble(x);
  let left = digits;
  let right = mant;
  if (pow10 >= 0) left *= 10n ** BigInt(pow10);
  else right *= 10n ** BigInt(-pow10);
  if (pow2 >= 0) right <<= BigInt(pow2);
  else left <<= BigInt(-pow2);
  return left < right ? -1 : (left > right ? 1 : 0);
}
function strtof(text) {
  const d = Number(text);
  const c = f(d);
  if (!Number.isFinite(c) || c === 0 && d === 0) return c;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return c;
  const negative = m[1] === '-';
  const intPart = m[2] || '';
  const frac = m[3] || '';
  const digits = BigInt((intPart + frac).replace(/^0+(?=\d)/, '') || '0');
  if (digits === 0n) return c;
  const pow10 = (m[4] ? parseInt(m[4], 10) : 0) - frac.length;
  const mag = Math.abs(c);
  const side = compareExact(digits, pow10, mag);
  if (side === 0) return c;
  const neighbor = floatStep(mag, side > 0);
  const mid = (mag + neighbor) / 2;
  const toMid = compareExact(digits, pow10, mid);
  let result = mag;
  if (toMid === side) result = neighbor;
  else if (toMid === 0) {
    F32[0] = mag;
    if (U32[0] & 1) result = neighbor;
  }
  return negative ? -result : result;
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';

class Stream {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.eof = false;
    this.fail = false;
  }

  good() { return !this.eof && !this.fail; }

  get() {
    if (this.i >= this.s.length) {
      this.eof = true;
      this.fail = true;
      return -1;
    }
    return this.s[this.i++];
  }

  peek() {
    if (!this.good()) return -1;
    if (this.i >= this.s.length) {
      this.eof = true;
      return -1;
    }
    return this.s[this.i];
  }

  putback() {
    this.eof = false;
    if (this.fail) return;
    if (this.i > 0) this.i -= 1;
  }

  skipWs() {
    while (this.i < this.s.length && isSpace(this.s[this.i])) this.i += 1;
    if (this.i >= this.s.length) {
      this.eof = true;
      this.fail = true;
      return false;
    }
    return true;
  }

  // `>> float`: num_get collects a sign, digits, a point and an exponent,
  // and strtod reads them.
  readFloat() {
    if (this.fail || !this.skipWs()) return null;
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) {
      this.fail = true;
      return null;
    }
    this.i += m[0].length;
    if (this.i >= this.s.length) this.eof = true;
    return strtof(m[0]);
  }

  readInt() {
    if (this.fail || !this.skipWs()) return null;
    const m = /^[+-]?\d+/.exec(this.s.slice(this.i, this.i + 32));
    if (!m) {
      this.fail = true;
      return null;
    }
    this.i += m[0].length;
    if (this.i >= this.s.length) this.eof = true;
    return Number(m[0]) | 0;
  }

  readWord() {
    if (this.fail || !this.skipWs()) return null;
    const start = this.i;
    while (this.i < this.s.length && !isSpace(this.s[this.i])) this.i += 1;
    if (this.i >= this.s.length) this.eof = true;
    return this.s.slice(start, this.i);
  }

  // `std::getline`: to the newline, which is consumed and not kept.
  getline() {
    if (this.fail) return '';
    if (this.i >= this.s.length) {
      this.eof = true;
      this.fail = true;
      return '';
    }
    const nl = this.s.indexOf('\n', this.i);
    if (nl < 0) {
      const line = this.s.slice(this.i);
      this.i = this.s.length;
      this.eof = true;
      return line;
    }
    const line = this.s.slice(this.i, nl);
    this.i = nl + 1;
    return line;
  }

  // The "rest of the line" std::getline plus putback('\n') the Custom
  // objects use to read a line without consuming its end.
  restOfLine() {
    const line = this.getline();
    this.putback();
    return line;
  }
}

const lower = (s) => String(s).toLowerCase();
const ieq = (a, b) => lower(a) === lower(b);
const floatBits = (() => {
  const view = new DataView(new ArrayBuffer(4));
  return (x) => { view.setFloat32(0, x); return view.getUint32(0); };
})();
const sameFloats = (a, b, n) => {
  for (let i = 0; i < n; i += 1) if (floatBits(a[i]) !== floatBits(b[i])) return false;
  return true;
};

// ---------------------------------------------------------------------------
// BZDB, as `StateDatabase::eval` reads it: a variable is a float, the
// arithmetic between them double, and the result a float again.
// ---------------------------------------------------------------------------

const BZDB_TOKENS = /\d+\.?\d*(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/()^]|\s+/g;

function makeBzdb(vars) {
  const cache = new Map();
  const evalName = (name, seen = new Set()) => {
    if (cache.has(name)) return cache.get(name);
    if (seen.has(name)) return NaN;
    const raw = vars.has(name) ? vars.get(name) : BZDB_DEFAULTS[name];
    if (raw === undefined || String(raw).trim() === '') return NaN;
    const tokens = [];
    for (const match of String(raw).matchAll(BZDB_TOKENS)) if (match[0].trim()) tokens.push(match[0]);
    let at = 0;
    const next = new Set(seen).add(name);
    const expression = () => {
      let value = term();
      while (tokens[at] === '+' || tokens[at] === '-') {
        const op = tokens[at++];
        const right = term();
        value = op === '+' ? value + right : value - right;
      }
      return value;
    };
    const term = () => {
      let value = signed();
      while (tokens[at] === '*' || tokens[at] === '/') {
        const op = tokens[at++];
        const right = signed();
        value = op === '*' ? value * right : value / right;
      }
      return value;
    };
    const signed = () => {
      if (tokens[at] === '-') { at += 1; return -signed(); }
      if (tokens[at] === '+') { at += 1; return signed(); }
      return atom();
    };
    const atom = () => {
      const token = tokens[at++];
      if (token === undefined) return NaN;
      if (token === '(') {
        const value = expression();
        at += 1;
        return value;
      }
      if (/^[A-Za-z_]/.test(token)) return evalName(token, next);
      return Number(token);
    };
    const value = f(expression());
    cache.set(name, value);
    return value;
  };
  return {
    eval: (name) => evalName(name),
    set: (name, value) => { vars.set(name, value); cache.clear(); },
    isTrue: (name) => {
      const raw = vars.get(name);
      if (raw === undefined) return false;
      const v = lower(raw);
      return !(v === '0' || v === 'off' || v === 'false' || v === 'no' || v === 'disable' || v === '');
    },
  };
}

// ---------------------------------------------------------------------------
// ParseColor.cxx `parseColorCString`.
// ---------------------------------------------------------------------------

function scanFloats(str, max) {
  const out = [];
  let rest = str;
  for (let n = 0; n < max; n += 1) {
    const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
    if (!m) break;
    out.push(strtof(m[1]));
    rest = rest.slice(m[0].length);
  }
  return out;
}

function parseColor(text) {
  const color = [1, 1, 1, 1];
  const str = String(text).replace(/^\s+/, '');
  if (!str || str[0] === '#') return null;
  if (/^[0-9.+-]/.test(str)) {
    const values = scanFloats(str, 4);
    if (values.length < 3) return null;
    for (let i = 0; i < values.length; i += 1) color[i] = values[i];
    return color;
  }
  for (const [name, rgb] of COLOR_NAMES) {
    const end = str[name.length];
    if (lower(str.slice(0, name.length)) === lower(name) && (end === undefined || isSpace(end))) {
      color[0] = f(rgb[0]); color[1] = f(rgb[1]); color[2] = f(rgb[2]);
      const alpha = scanFloats(str.slice(name.length), 1);
      if (alpha.length > 0) color[3] = alpha[0];
      return color;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Managers: DynamicColor, TextureMatrix, BzMaterial, PhysicsDriver and
// MeshTransform, each a list where a name or a leading-digit index finds an
// entry.
// ---------------------------------------------------------------------------

const validName = (name) => (name && !(name[0] >= '0' && name[0] <= '9') ? name : '');

function findIndex(list, target) {
  if (!target) return -1;
  if (target[0] >= '0' && target[0] <= '9') {
    const index = parseInt(target, 10);
    return index >= 0 && index < list.length ? index : -1;
  }
  return list.findIndex((entry) => entry.name === target);
}

function newMaterial() {
  return {
    name: '',
    aliases: [],
    dynamicColor: -1,
    ambient: [f(0.2), f(0.2), f(0.2), 1],
    diffuse: [1, 1, 1, 1],
    specular: [0, 0, 0, 1],
    emission: [0, 0, 0, 1],
    shininess: 0,
    alphaThreshold: 0,
    occluder: false,
    groupAlpha: false,
    noRadar: false,
    noShadow: false,
    noCulling: false,
    noSorting: false,
    noLighting: false,
    textures: [],
    shaders: [],
  };
}

function copyMaterial(m) {
  return {
    ...m,
    aliases: [...m.aliases],
    ambient: [...m.ambient],
    diffuse: [...m.diffuse],
    specular: [...m.specular],
    emission: [...m.emission],
    textures: m.textures.map((t) => ({ ...t })),
    shaders: [...m.shaders],
  };
}

// BzMaterial::operator== -- everything but the name and aliases, and only
// three components of specular and emission.
function sameMaterial(a, b) {
  if (a.dynamicColor !== b.dynamicColor
    || !sameFloats(a.ambient, b.ambient, 4) || !sameFloats(a.diffuse, b.diffuse, 4)
    || !sameFloats(a.specular, b.specular, 3) || !sameFloats(a.emission, b.emission, 3)
    || floatBits(a.shininess) !== floatBits(b.shininess)
    || floatBits(a.alphaThreshold) !== floatBits(b.alphaThreshold)
    || a.occluder !== b.occluder || a.groupAlpha !== b.groupAlpha || a.noRadar !== b.noRadar
    || a.noShadow !== b.noShadow || a.noCulling !== b.noCulling || a.noSorting !== b.noSorting
    || a.noLighting !== b.noLighting) return false;
  if (a.textures.length !== b.textures.length) return false;
  for (let i = 0; i < a.textures.length; i += 1) {
    const x = a.textures[i];
    const y = b.textures[i];
    if (x.name !== y.name || x.matrix !== y.matrix || x.combineMode !== y.combineMode
      || x.useAlpha !== y.useAlpha || x.useColor !== y.useColor || x.useSphereMap !== y.useSphereMap) return false;
  }
  if (a.shaders.length !== b.shaders.length) return false;
  return a.shaders.every((s, i) => s === b.shaders[i]);
}

const DECAL = 2;
function addTexture(m, name) {
  m.textures.push({
    name, matrix: -1, combineMode: DECAL, useAlpha: true, useColor: true, useSphereMap: false,
  });
}
function setTexture(m, name) {
  if (m.textures.length === 0) addTexture(m, name);
  else m.textures[m.textures.length - 1].name = name;
}
const lastTexture = (m) => m.textures[m.textures.length - 1];

class World {
  constructor(bzdb) {
    this.bzdb = bzdb;
    this.dynamicColors = [];
    this.textureMatrices = [];
    this.materials = [];
    this.physicsDrivers = [];
    this.transforms = [];
    this.world = { name: '', isWorld: true, lists: emptyLists(), groups: [] };
    this.groupDefs = [];
    this.links = [];
    this.waterLevel = -1;
    this.waterMat = null;
    this.weapons = [];
    this.zones = [];
    this.unsupported = [];
  }

  // BzMaterialManager::addMaterial: an equal material already in the list
  // is returned, gaining the new one's name as an alias.
  addMaterial(material) {
    for (const existing of this.materials) {
      if (sameMaterial(material, existing)) {
        if (material.name) addAlias(existing, material.name);
        return existing;
      }
    }
    const made = copyMaterial(material);
    if (this.findMaterial(made.name) !== null) made.name = '';
    this.materials.push(made);
    return made;
  }

  findMaterial(target) {
    if (!target) return null;
    if (target[0] >= '0' && target[0] <= '9') {
      const index = parseInt(target, 10);
      return index >= 0 && index < this.materials.length ? this.materials[index] : null;
    }
    for (const mat of this.materials) {
      if (mat.name === target || mat.aliases.includes(target)) return mat;
    }
    return null;
  }

  materialIndex(mat) { return mat ? this.materials.indexOf(mat) : -1; }
}

function addAlias(mat, alias) {
  if (!alias || (alias[0] >= '0' && alias[0] <= '9')) {
    mat.name = '';
    return;
  }
  if (!mat.aliases.includes(alias)) mat.aliases.push(alias);
}

const OBSTACLE_TYPES = ['wall', 'box', 'pyr', 'base', 'tele', 'mesh', 'arc', 'cone', 'sphere', 'tetra'];
function emptyLists() {
  return Object.fromEntries(OBSTACLE_TYPES.map((t) => [t, []]));
}

// ParseMaterial.cxx `parseMaterials`: true when `cmd` is a material
// property; `error` reports a bad one.
function parseMaterials(world, cmd, input, mats) {
  const each = (fn) => { for (const m of mats) fn(m); };
  const c = lower(cmd);
  let error = false;
  switch (c) {
    case 'matref': {
      const name = input.readWord();
      if (name === null) error = true;
      const ref = world.findMaterial(name);
      if (!ref) error = true;
      else for (let i = 0; i < mats.length; i += 1) Object.assign(mats[i], copyMaterial(ref));
      break;
    }
    case 'resetmat': each((m) => Object.assign(m, newMaterial())); break;
    case 'dyncol': {
      const name = input.readWord();
      if (name === null) error = true;
      const index = findIndex(world.dynamicColors, name || '');
      if (index === -1 && name !== '-1') error = true;
      else each((m) => { m.dynamicColor = index; });
      break;
    }
    case 'ambient': case 'diffuse': case 'color': case 'specular': case 'emission': {
      const color = parseColor(input.restOfLine());
      if (!color) error = true;
      else {
        each((m) => {
          if (c === 'ambient') m.ambient = [...color];
          else if (c === 'specular') m.specular = [color[0], color[1], color[2], 1];
          else if (c === 'emission') m.emission = [color[0], color[1], color[2], 1];
          else m.diffuse = [...color];
        });
      }
      break;
    }
    case 'shininess': case 'alphathresh': {
      let value = input.readFloat();
      if (value === null) { error = true; value = 0; }
      each((m) => { if (c === 'shininess') m.shininess = value; else m.alphaThreshold = value; });
      break;
    }
    case 'noculling': each((m) => { m.noCulling = true; }); break;
    case 'nosorting': each((m) => { m.noSorting = true; }); break;
    case 'noradar': each((m) => { m.noRadar = true; }); break;
    case 'noshadow': each((m) => { m.noShadow = true; }); break;
    case 'nolighting': each((m) => { m.noLighting = true; }); break;
    case 'occluder': each((m) => { m.occluder = true; }); break;
    case 'groupalpha': each((m) => { m.groupAlpha = true; }); break;
    case 'texture': {
      const name = input.readWord();
      if (name === null) error = true;
      else each((m) => setTexture(m, name));
      break;
    }
    case 'notextures': each((m) => { m.textures = []; }); break;
    case 'addtexture': {
      const name = input.readWord();
      if (name === null) error = true;
      each((m) => addTexture(m, name ?? ''));
      break;
    }
    case 'texmat': {
      const name = input.readWord();
      if (name === null) error = true;
      const index = findIndex(world.textureMatrices, name || '');
      each((m) => { if (m.textures.length) lastTexture(m).matrix = index; });
      break;
    }
    case 'notexalpha': each((m) => { if (m.textures.length) lastTexture(m).useAlpha = false; }); break;
    case 'notexcolor': each((m) => { if (m.textures.length) lastTexture(m).useColor = false; }); break;
    case 'spheremap': each((m) => { if (m.textures.length) lastTexture(m).useSphereMap = true; }); break;
    case 'shader': {
      const name = input.readWord();
      if (name === null) error = true;
      each((m) => {
        if (m.shaders.length === 0) m.shaders.push(name ?? '');
        else m.shaders[m.shaders.length - 1] = name ?? '';
      });
      break;
    }
    case 'addshader': {
      const name = input.readWord();
      if (name === null) error = true;
      each((m) => m.shaders.push(name ?? ''));
      break;
    }
    case 'noshaders': each((m) => { m.shaders = []; }); break;
    default: return null;
  }
  return { error };
}

// `parseMaterialsByName`: `<side> <material property>` for one named side.
function parseMaterialsByName(world, cmd, input, mats, names) {
  for (let n = 0; n < names.length; n += 1) {
    if (!ieq(cmd, names[n])) continue;
    const parms = new Stream(input.restOfLine());
    const matcmd = parms.readWord();
    if (matcmd === null) return { error: true };
    const result = parseMaterials(world, matcmd, parms, [mats[n]]);
    return { error: !result || result.error };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MeshTransform and its Tool (MeshTransform.cxx), in floats.
// ---------------------------------------------------------------------------

const SHIFT = 0;
const SCALE = 1;
const SHEAR = 2;
const SPIN = 3;
const INDEX = 4;

function addSpinOp(ops, degrees, normal) {
  ops.push({ type: SPIN, data: [normal[0], normal[1], normal[2]], spin: f(degrees * RAD_PER_DEG) });
}

function identity4() {
  return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
}

function multiply(m, n) {
  const t = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      t[i][j] = f(f(f(f(m[0][j] * n[i][0]) + f(m[1][j] * n[i][1])) + f(m[2][j] * n[i][2])) + f(m[3][j] * n[i][3]));
    }
  }
  for (let i = 0; i < 4; i += 1) m[i] = t[i];
}

class Tool {
  constructor(world, ops) {
    this.vm = identity4();
    this.empty = ops.length === 0;
    this.inverted = false;
    if (this.empty) return;
    this.process(world, ops);
    const vm = this.vm;
    const det = f(f(f(vm[0][0] * f(f(vm[1][1] * vm[2][2]) - f(vm[1][2] * vm[2][1])))
      + f(vm[0][1] * f(f(vm[1][2] * vm[2][0]) - f(vm[1][0] * vm[2][2]))))
      + f(vm[0][2] * f(f(vm[1][0] * vm[2][1]) - f(vm[1][1] * vm[2][0]))));
    this.inverted = det < 0;
    this.nm = [
      [f(f(vm[1][1] * vm[2][2]) - f(vm[1][2] * vm[2][1])), f(f(vm[1][2] * vm[2][0]) - f(vm[1][0] * vm[2][2])),
        f(f(vm[1][0] * vm[2][1]) - f(vm[1][1] * vm[2][0]))],
      [f(f(vm[2][1] * vm[0][2]) - f(vm[2][2] * vm[0][1])), f(f(vm[2][2] * vm[0][0]) - f(vm[2][0] * vm[0][2])),
        f(f(vm[2][0] * vm[0][1]) - f(vm[2][1] * vm[0][0]))],
      [f(f(vm[0][1] * vm[1][2]) - f(vm[0][2] * vm[1][1])), f(f(vm[0][2] * vm[1][0]) - f(vm[0][0] * vm[1][2])),
        f(f(vm[0][0] * vm[1][1]) - f(vm[0][1] * vm[1][0]))],
    ];
  }

  process(world, ops) {
    for (const op of ops) {
      const d = op.data;
      if (op.type === SHIFT) {
        multiply(this.vm, [[1, 0, 0, d[0]], [0, 1, 0, d[1]], [0, 0, 1, d[2]], [0, 0, 0, 1]]);
      } else if (op.type === SCALE) {
        multiply(this.vm, [[d[0], 0, 0, 0], [0, d[1], 0, 0], [0, 0, d[2], 0], [0, 0, 0, 1]]);
      } else if (op.type === SHEAR) {
        multiply(this.vm, [[1, 0, d[0], 0], [0, 1, d[1], 0], [d[2], 0, 1, 0], [0, 0, 0, 1]]);
      } else if (op.type === SPIN) {
        const len = f(f(f(d[0] * d[0]) + f(d[1] * d[1])) + f(d[2] * d[2]));
        if (len <= 0) continue;
        const scale = f(1 / f(Math.sqrt(len)));
        const n = [f(d[0] * scale), f(d[1] * scale), f(d[2] * scale)];
        const c = f(Math.cos(op.spin));
        const s = f(Math.sin(op.spin));
        const ic = f(1 - c);
        const t = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]];
        t[0][0] = f(f(f(n[0] * n[0]) * ic) + c);
        t[0][1] = f(f(f(n[0] * n[1]) * ic) - f(n[2] * s));
        t[0][2] = f(f(f(n[0] * n[2]) * ic) + f(n[1] * s));
        t[1][0] = f(f(f(n[1] * n[0]) * ic) + f(n[2] * s));
        t[1][1] = f(f(f(n[1] * n[1]) * ic) + c);
        t[1][2] = f(f(f(n[1] * n[2]) * ic) - f(n[0] * s));
        t[2][0] = f(f(f(n[2] * n[0]) * ic) - f(n[1] * s));
        t[2][1] = f(f(f(n[2] * n[1]) * ic) + f(n[0] * s));
        t[2][2] = f(f(f(n[2] * n[2]) * ic) + c);
        multiply(this.vm, t);
      } else if (op.type === INDEX) {
        const ref = world.transforms[op.index];
        if (ref) this.process(world, ref.ops);
      }
    }
  }

  vertex(v) {
    if (this.empty) return [v[0], v[1], v[2]];
    const vm = this.vm;
    const row = (r) => f(f(f(f(v[0] * vm[r][0]) + f(v[1] * vm[r][1])) + f(v[2] * vm[r][2])) + vm[r][3]);
    return [row(0), row(1), row(2)];
  }

  normal(n) {
    if (this.empty) return [n[0], n[1], n[2]];
    const nm = this.nm;
    const row = (r) => f(f(f(n[0] * nm[r][0]) + f(n[1] * nm[r][1])) + f(n[2] * nm[r][2]));
    const t = [row(0), row(1), row(2)];
    const len = f(f(f(t[0] * t[0]) + f(t[1] * t[1])) + f(t[2] * t[2]));
    let out;
    if (len > 0) {
      const scale = f(1 / f(Math.sqrt(len)));
      out = [f(t[0] * scale), f(t[1] * scale), f(t[2] * scale)];
    } else {
      out = [0, 0, 1];
    }
    if (this.inverted) out = [-out[0], -out[1], -out[2]];
    return out;
  }

  // `modifyOldStyle`: a box's or pyramid's position, size and angle under a
  // group's transform.
  oldStyle(pos, size, angle) {
    if (this.empty) return { pos: [...pos], size: [...size], angle, flipz: false };
    const p = this.vertex(pos);
    const c = f(Math.cos(angle));
    const s = f(Math.sin(angle));
    const vm = this.vm;
    const x = [0, 1, 2].map((r) => f(f(c * vm[r][0]) + f(s * vm[r][1])));
    const y = [0, 1, 2].map((r) => f(f(-s * vm[r][0]) + f(c * vm[r][1])));
    const z = [vm[0][2], vm[1][2], vm[2][2]];
    const len = (v) => f(Math.sqrt(f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]))));
    const sz = [f(size[0] * len(x)), f(size[1] * len(y)), f(size[2] * len(z))];
    const a = f(Math.atan2(x[1], x[0]));
    let flipz = false;
    if (z[2] < 0) {
      flipz = true;
      p[2] = f(p[2] - sz[2]);
    }
    return { pos: p, size: sz, angle: a, flipz };
  }
}

// ---------------------------------------------------------------------------
// Vectors, as vectors_old.h does them in floats.
// ---------------------------------------------------------------------------

const vsub = (a, b) => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const vdot = (a, b) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
const vcross = (a, b) => [
  f(f(a[1] * b[2]) - f(a[2] * b[1])),
  f(f(a[2] * b[0]) - f(a[0] * b[2])),
  f(f(a[0] * b[1]) - f(a[1] * b[0])),
];

function newExtents() {
  return { mins: [FLT_MAX, FLT_MAX, FLT_MAX], maxs: [-FLT_MAX, -FLT_MAX, -FLT_MAX] };
}
function expandToPoint(e, p) {
  for (let a = 0; a < 3; a += 1) {
    if (p[a] < e.mins[a]) e.mins[a] = p[a];
    if (p[a] > e.maxs[a]) e.maxs[a] = p[a];
  }
}
function expandToBox(e, b) {
  for (let a = 0; a < 3; a += 1) {
    if (b.mins[a] < e.mins[a]) e.mins[a] = b.mins[a];
    if (b.maxs[a] > e.maxs[a]) e.maxs[a] = b.maxs[a];
  }
}

// `Obstacle::setExtents`.
function boxExtents(pos, angle, size) {
  const c = f(Math.abs(f(Math.cos(angle))));
  const s = f(Math.abs(f(Math.sin(angle))));
  const xspan = f(f(c * size[0]) + f(s * size[1]));
  const yspan = f(f(c * size[1]) + f(s * size[0]));
  return {
    mins: [f(pos[0] - xspan), f(pos[1] - yspan), pos[2]],
    maxs: [f(pos[0] + xspan), f(pos[1] + yspan), f(pos[2] + size[2])],
  };
}

function obstacleValid(e) {
  for (let a = 0; a < 3; a += 1) if (e.mins[a] < -MAX_EXTENT || e.maxs[a] > MAX_EXTENT) return false;
  return true;
}

// ---------------------------------------------------------------------------
// MeshFace::finalize: whether a face is a plane it can use, and its extents.
// ---------------------------------------------------------------------------

function faceCheck(verts) {
  const n = verts.length;
  let maxCrossSqr = 0;
  let bestCross = [0, 0, 0];
  let bestJ = -1;
  for (let i = 0; i < n - 2; i += 1) {
    for (let j = i + 1; j < n - 1; j += 1) {
      const edge2 = vsub(verts[i], verts[j]);
      for (let k = j + 1; k < n; k += 1) {
        const edge1 = vsub(verts[k], verts[j]);
        const cross = vcross(edge1, edge2);
        const lenSqr = vdot(cross, cross);
        if (lenSqr > maxCrossSqr) {
          maxCrossSqr = lenSqr;
          bestJ = j;
          bestCross = cross;
        }
      }
    }
  }
  if (maxCrossSqr < f(1.0e-20)) return null;
  const scale = f(1 / f(Math.sqrt(maxCrossSqr)));
  const plane = [f(bestCross[0] * scale), f(bestCross[1] * scale), f(bestCross[2] * scale)];
  plane[3] = -vdot(plane, verts[bestJ]);
  for (let v = 0; v < n; v += 1) {
    const a = vsub(verts[(v + 1) % n], verts[v % n]);
    const b = vsub(verts[(v + 2) % n], verts[(v + 1) % n]);
    const c = vcross(a, b);
    if (vdot(c, plane) <= 0) return null;
  }
  for (let v = 0; v < n; v += 1) {
    const cross = vdot(verts[v], plane);
    if (Math.abs(f(cross + plane[3])) > 1.0e-3) return null;
  }
  const extents = newExtents();
  for (const v of verts) expandToPoint(extents, v);
  return extents;
}

// Triangulate.cxx `triangulateFace`.
function triangulateFace(verts) {
  let count = verts.length;
  const work = verts.map((_, i) => i);
  const norm = (v) => {
    const len = f(Math.sqrt(vdot(v, v)));
    if (len < f(1.0e-6)) return [0, 0, 0];
    const scale = f(1 / len);
    return [f(v[0] * scale), f(v[1] * scale), f(v[2] * scale)];
  };
  let normal = [0, 0, 0];
  for (let i = 0; i < count; i += 1) {
    const v0 = verts[i];
    const v1 = verts[(i + 1) % count];
    normal[0] = f(normal[0] + f(f(v0[1] - v1[1]) * f(v0[2] + v1[2])));
    normal[1] = f(normal[1] + f(f(v0[2] - v1[2]) * f(v0[0] + v1[0])));
    normal[2] = f(normal[2] + f(f(v0[0] - v1[0]) * f(v0[1] + v1[1])));
  }
  normal = norm(normal);
  const isConvex = (w0, w1, w2) => {
    const e0 = vsub(verts[work[w1]], verts[work[w0]]);
    const e1 = vsub(verts[work[w2]], verts[work[w1]]);
    return vdot(vcross(e0, e1), normal) > 0;
  };
  const isFaceClear = (w0, w1, w2) => {
    const v0 = verts[work[w0]];
    const v1 = verts[work[w1]];
    const v2 = verts[work[w2]];
    const edges = [vsub(v1, v0), vsub(v2, v1), vsub(v0, v2)];
    const n = vcross(edges[0], edges[1]);
    const planes = edges.map((e) => vcross(e, n));
    planes[0][3] = -vdot(planes[0], v0);
    planes[1][3] = -vdot(planes[1], v1);
    planes[2][3] = -vdot(planes[2], v2);
    for (let w = 0; w < count; w += 1) {
      if (w === w0 || w === w1 || w === w2) continue;
      const v = verts[work[w]];
      let i;
      for (i = 0; i < 3; i += 1) {
        if (f(vdot(planes[i], v) + planes[i][3]) > 0) break;
      }
      if (i === 3) return false;
    }
    return true;
  };
  const getDot = (w0, w1, w2) => {
    const e0 = norm(vsub(verts[work[w1]], verts[work[w0]]));
    const e1 = norm(vsub(verts[work[w2]], verts[work[w1]]));
    return vdot(e0, e1);
  };
  const tris = [];
  let best = 0;
  let left = false;
  let first = true;
  let score = 0;
  while (count >= 3) {
    let convex = false;
    let faceClear = false;
    let offset = best === count ? count - 1 : best % count;
    if (left) offset = (offset + (count - 1)) % count;
    left = !left;
    for (let w = offset; w < offset + (count - 2); w += 1) {
      const w0 = w % count;
      const w1 = (w + 1) % count;
      const w2 = (w + 2) % count;
      const convex2 = isConvex(w0, w1, w2);
      if (convex && !convex2) continue;
      const faceClear2 = isFaceClear(w0, w1, w2);
      if ((faceClear && !faceClear2) && (convex || !convex2)) continue;
      if (first) {
        const score2 = f(2 - getDot(w0, w1, w2));
        if (score2 < score && (convex || !convex2) && (faceClear || !faceClear2)) continue;
        score = score2;
      }
      best = w0;
      if (convex && faceClear) break;
      convex = convex2;
      faceClear = faceClear2;
    }
    first = false;
    tris.push([work[(best + 0) % count], work[(best + 1) % count], work[(best + 2) % count]]);
    const m = (best + 1) % count;
    work.splice(m, 1);
    count -= 1;
  }
  return tris;
}

// ---------------------------------------------------------------------------
// MeshObstacle: the constructor applies the transform, `addFace` keeps the
// faces that make a valid plane (triangulating one that does not when asked),
// and `finalize` sets the extents.
// ---------------------------------------------------------------------------

function makeMesh(world, ops, checkTypes, checkPoints, vertices, normals, texcoords, flags) {
  const tool = new Tool(world, ops);
  return {
    kind: 'mesh',
    inverted: tool.inverted,
    checks: checkTypes.map((type, i) => ({ type, point: tool.vertex(checkPoints[i]) })),
    vertices: vertices.map((v) => tool.vertex(v)),
    normals: normals.map((n) => tool.normal(n)),
    texcoords: texcoords.map((t) => [t[0], t[1]]),
    faces: [],
    noclusters: flags.noclusters,
    smoothBounce: flags.smoothBounce,
    driveThrough: flags.driveThrough,
    shootThrough: flags.shootThrough,
    ricochet: flags.ricochet,
    drawInfo: null,
    extents: newExtents(),
  };
}

function addFace(mesh, iv, inorm, it, material, phydrv, flags, triangulate) {
  const count = iv.length;
  if (count < 3 || (inorm.length > 0 && inorm.length !== count) || (it.length > 0 && it.length !== count)) return false;
  if (iv.some((i) => i >= mesh.vertices.length) || inorm.some((i) => i >= mesh.normals.length)
    || it.some((i) => i >= mesh.texcoords.length)) return false;
  // `makeFacePointers`: an inverting transform reverses the winding.
  const order = (list) => {
    if (list.length === 0) return null;
    const n = list.length;
    const out = new Array(n);
    for (let i = 0; i < n; i += 1) out[mesh.inverted ? n - 1 - i : i] = list[i];
    return out;
  };
  const face = {
    noclusters: flags.noclusters || mesh.noclusters,
    smoothBounce: flags.smoothBounce || mesh.smoothBounce,
    driveThrough: flags.driveThrough || mesh.driveThrough,
    shootThrough: flags.shootThrough || mesh.shootThrough,
    ricochet: flags.ricochet || mesh.ricochet,
    material,
    phydrv,
  };
  const vIdx = order(iv);
  const extents = faceCheck(vIdx.map((i) => mesh.vertices[i]));
  if (extents) {
    mesh.faces.push({ ...face, vertexIdx: vIdx, normalIdx: order(inorm), texcoordIdx: order(it), extents });
    return true;
  }
  if (!(triangulate && count > 3)) return false;
  const tris = triangulateFace(vIdx.map((i) => mesh.vertices[i]));
  if (tris.length === 0) return false;
  // The triangles are found on the face's own winding but index the lists
  // as given (MeshObstacle::addFace), and each is wound again as it is added.
  for (const tri of tris) {
    const tv = tri.map((i) => iv[i]);
    const tn = inorm.length > 0 ? tri.map((i) => inorm[i]) : [];
    const tt = it.length > 0 ? tri.map((i) => it[i]) : [];
    const ov = order(tv);
    const ext = faceCheck(ov.map((i) => mesh.vertices[i]));
    if (ext) mesh.faces.push({ ...face, vertexIdx: ov, normalIdx: order(tn), texcoordIdx: order(tt), extents: ext });
  }
  return true;
}

function finalizeMesh(mesh) {
  mesh.extents = newExtents();
  for (const face of mesh.faces) expandToBox(mesh.extents, face.extents);
}

function meshValid(mesh) {
  return mesh.vertices.every((v) => v.every((x) => Math.abs(x) <= MAX_EXTENT));
}

// ---------------------------------------------------------------------------
// Teleporter::finalize and makeLinks: the size it packs, its extents, and
// whether its two link faces are valid.
// ---------------------------------------------------------------------------

function makeTeleporter(pos, angle, size, border, horizontal, flags, name) {
  const origSize = [...size];
  const sz = [...size];
  if (!horizontal) {
    sz[1] = f(origSize[1] + f(border * 2));
    sz[2] = f(origSize[2] + border);
  }
  let sizeX = f(border * 0.5);
  if (sz[0] > sizeX) sizeX = sz[0];
  const c = f(Math.abs(f(Math.cos(angle))));
  const s = f(Math.abs(f(Math.sin(angle))));
  const xspan = f(f(c * sizeX) + f(s * sz[1]));
  const yspan = f(f(c * sz[1]) + f(s * sizeX));
  const extents = {
    mins: [f(pos[0] - xspan), f(pos[1] - yspan), pos[2]],
    maxs: [f(pos[0] + xspan), f(pos[1] + yspan), f(pos[2] + sz[2])],
  };
  // makeLinks
  const w = sz[0];
  const b = sz[1];
  const br = border;
  const h = sz[2];
  const cv = f(Math.cos(angle));
  const sv = f(Math.sin(angle));
  let back;
  let front;
  if (!horizontal) {
    const params = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    const wlen = [f(cv * w), f(sv * w)];
    const bb = f(b - br);
    const blen = [f(-sv * bb), f(cv * bb)];
    const hb = f(h - br);
    back = params.map((p) => [
      f(pos[0] + f(wlen[0] + f(blen[0] * p[0]))),
      f(pos[1] + f(wlen[1] + f(blen[1] * p[0]))),
      f(pos[2] + f(hb * p[1])),
    ]);
    front = params.map((p) => [
      f(pos[0] - f(wlen[0] + f(blen[0] * p[0]))),
      f(pos[1] - f(wlen[1] + f(blen[1] * p[0]))),
      f(pos[2] + f(hb * p[1])),
    ]);
  } else {
    const xl = f(w - br);
    const yl = f(b - br);
    const top = f(f(pos[2] + h) - br);
    const corner = (sx, sy) => [
      f(pos[0] + f(f(cv * f(sx * xl)) - f(sv * f(sy * yl)))),
      f(pos[1] + f(f(cv * f(sy * yl)) + f(sv * f(sx * xl)))),
      top,
    ];
    back = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
    front = [3, 2, 1, 0].map((i) => [back[i][0], back[i][1], f(pos[2] + h)]);
  }
  const linksValid = faceCheck(back) !== null && faceCheck(front) !== null;
  return {
    kind: 'tele',
    name,
    pos,
    angle,
    size: origSize,
    border,
    horizontal,
    driveThrough: flags.driveThrough,
    shootThrough: flags.shootThrough,
    ricochet: flags.ricochet,
    extents,
    valid: linksValid && obstacleValid(extents),
  };
}

// ---------------------------------------------------------------------------
// The Custom objects: each reads its own parameters and, at `end`, writes
// itself into the group definition being read or into a manager.
// ---------------------------------------------------------------------------

// WorldFileObject / WorldFileLocation / WorldFileObstacle::read.
function readLocation(obj, cmd, input, world, obstacle) {
  const c = lower(cmd);
  if (obstacle) {
    if (c === 'drivethrough') { obj.driveThrough = true; return true; }
    if (c === 'shootthrough') { obj.shootThrough = true; return true; }
    if (c === 'passable') { obj.driveThrough = true; obj.shootThrough = true; return true; }
    if (c === 'ricochet') { obj.ricochet = true; return true; }
  }
  const vec3 = () => {
    const a = input.readFloat(); const b = input.readFloat(); const d = input.readFloat();
    return d === null || b === null || a === null ? null : [a, b, d];
  };
  if (c === 'pos' || c === 'position') {
    const v = vec3();
    if (!v) return false;
    obj.pos = v;
    return true;
  }
  if (c === 'size') {
    const v = vec3();
    if (!v) return false;
    obj.size = v;
    return true;
  }
  if (c === 'rot' || c === 'rotation') {
    const r = input.readFloat();
    if (r === null) return false;
    obj.rotation = f(r * RAD_PER_DEG);
    return true;
  }
  if (c === 'shift' || c === 'scale' || c === 'shear') {
    const v = vec3();
    if (!v) return false;
    obj.transform.push({ type: c === 'shift' ? SHIFT : (c === 'scale' ? SCALE : SHEAR), data: v });
    return true;
  }
  if (c === 'spin') {
    const angle = input.readFloat();
    const v = vec3();
    if (angle === null || !v) return false;
    addSpinOp(obj.transform, angle, v);
    return true;
  }
  if (c === 'xform') {
    const name = input.readWord();
    if (name === null) return false;
    const index = findIndex(world.transforms, name);
    if (index !== -1) obj.transform.push({ type: INDEX, index });
    return true;
  }
  if (c === 'name') {
    const name = input.readWord();
    obj.name = name ?? '';
    return true;
  }
  return false;
}

function baseObject(extra = {}) {
  return {
    name: '',
    pos: [0, 0, 0],
    rotation: 0,
    size: [1, 1, 1],
    transform: [],
    driveThrough: false,
    shootThrough: false,
    ricochet: false,
    ...extra,
  };
}

const BOX_FACES = ['x+', 'x-', 'y+', 'y-', 'z+', 'z-'];
const PYR_FACES = ['x+', 'x-', 'y+', 'y-', 'bottom'];

// CustomBox and CustomPyramid share their reader: a face name first picks
// the faces a property applies to, and any of these turns the plain box or
// pyramid into a mesh.
function readFaced(obj, cmd, input, world, faceNames, extraFaces) {
  const line = input.restOfLine();
  const parms = new Stream(line);
  const faceCount = faceNames.length;
  let faceList = [];
  const named = faceNames.findIndex((n) => ieq(cmd, n));
  if (named >= 0) faceList.push(named);
  if (faceList.length === 0) faceList = extraFaces(lower(cmd));
  let command = cmd;
  if (faceList.length > 0) {
    obj.isOld = false;
    const tmp = parms.readWord();
    if (tmp === null) return false;
    command = tmp;
  } else {
    for (let i = 0; i < faceCount; i += 1) faceList.push(i);
  }
  const c = lower(command);
  if (obj.flipzAllowed && c === 'flipz') { obj.flipz = true; return true; }
  if (c === 'drivethrough') { faceList.forEach((i) => { obj.drivethrough[i] = true; }); obj.driveThrough = true; return true; }
  if (c === 'shootthrough') { faceList.forEach((i) => { obj.shootthrough[i] = true; }); obj.shootThrough = true; return true; }
  if (c === 'passable') {
    faceList.forEach((i) => { obj.drivethrough[i] = true; obj.shootthrough[i] = true; });
    obj.driveThrough = true;
    obj.shootThrough = true;
    return true;
  }
  if (c === 'ricochet') { faceList.forEach((i) => { obj.ricochets[i] = true; }); obj.ricochet = true; return true; }
  if (c === 'texsize' || c === 'texoffset') {
    obj.isOld = false;
    const a = parms.readFloat();
    const b = parms.readFloat();
    if (a === null || b === null) return false;
    faceList.forEach((i) => { obj[c][i] = [a, b]; });
    return true;
  }
  if (c === 'phydrv') {
    obj.isOld = false;
    const name = parms.readWord();
    if (name === null) return false;
    const pd = findIndex(world.physicsDrivers, name);
    if (pd === -1 && name !== '-1') return false;
    faceList.forEach((i) => { obj.phydrv[i] = pd; });
    return true;
  }
  let gotMaterial = false;
  let gotMatError = false;
  for (let i = 0; i < faceList.length; i += 1) {
    const copy = new Stream(line);
    if (faceList.length !== faceCount) copy.readWord();
    const result = parseMaterials(world, command, copy, [obj.materials[faceList[i]]]);
    if (!result) break;
    gotMaterial = true;
    if (result.error) gotMatError = true;
  }
  if (gotMaterial) {
    obj.isOld = false;
    return !gotMatError;
  }
  return readLocation(obj, command, parms, world, true);
}

function edgeLengths(world, ops, pairs) {
  const tool = new Tool(world, ops);
  return pairs.map(([a, b]) => {
    const d = vsub(tool.vertex(b), tool.vertex(a));
    return f(Math.sqrt(vdot(d, d)));
  });
}

function facedTexcoords(obj, faces, lengths, axes, corners) {
  const txcds = [];
  for (let face = 0; face < faces; face += 1) {
    for (const corner of corners(face)) {
      const t = [0, 0];
      for (let a = 0; a < 2; a += 1) {
        const size = obj.texsize[face][a];
        const scale = size >= 0 ? size : f(lengths[axes[face][a]] / -size);
        t[a] = f(f(corner[a] - obj.texoffset[face][a]) * scale);
      }
      txcds.push(t);
    }
  }
  return txcds;
}

function facedMesh(world, obj, xform, verts, txcds, faces, extraRicochet) {
  const mesh = makeMesh(world, xform, [0], [[0, 0, 0.5]], verts, [], txcds,
    { noclusters: false, smoothBounce: false, driveThrough: false, shootThrough: false, ricochet: false });
  const mats = obj.materials.map((m) => world.addMaterial(m));
  faces.forEach(([iv, it], face) => {
    addFace(mesh, iv, [], it, mats[face], obj.phydrv[face], {
      noclusters: false,
      smoothBounce: false,
      driveThrough: obj.drivethrough[face],
      shootThrough: obj.shootthrough[face],
      ricochet: obj.ricochets[extraRicochet ? extraRicochet(face) : face],
    }, false);
  });
  // No `finalize` here, as in CustomBox and CustomPyramid: the mesh keeps
  // empty extents, so the height sort leaves it where it was added.
  return meshValid(mesh) ? mesh : null;
}

const CUSTOM = {
  box: (world) => {
    const obj = baseObject({
      kind: 'box',
      isOld: true,
      size: [world.bzdb.eval('_boxBase'), world.bzdb.eval('_boxBase'), world.bzdb.eval('_boxHeight')],
      materials: [0, 1, 2, 3, 4, 5].map((i) => {
        const m = newMaterial();
        setTexture(m, i >= 4 ? 'roof' : 'boxwall');
        return m;
      }),
      texsize: [0, 1, 2, 3, 4, 5].map((i) => (i >= 4 ? [-2, -2] : [-8, -8])),
      texoffset: [0, 1, 2, 3, 4, 5].map(() => [0, 0]),
      phydrv: [-1, -1, -1, -1, -1, -1],
      drivethrough: [false, false, false, false, false, false],
      shootthrough: [false, false, false, false, false, false],
      ricochets: [false, false, false, false, false, false],
    });
    obj.read = (cmd, input) => readFaced(obj, cmd, input, world, BOX_FACES, (c) => {
      if (c === 'top') return [4];
      if (c === 'bottom') return [5];
      if (c === 'sides' || c === 'outside') return [0, 1, 2, 3];
      return [];
    });
    obj.write = (def) => {
      if (obj.isOld && obj.transform.length === 0) {
        const size = obj.size.map((v) => Math.abs(v));
        def.lists.box.push({
          kind: 'box', pos: obj.pos, angle: obj.rotation, size, flipZ: false,
          driveThrough: obj.driveThrough, shootThrough: obj.shootThrough, ricochet: obj.ricochet,
          extents: boxExtents(obj.pos, obj.rotation, size),
        });
        return;
      }
      const xform = [{ type: SCALE, data: obj.size }];
      addSpinOp(xform, f(obj.rotation * (180.0 / Math.PI)), [0, 0, 1]);
      xform.push({ type: SHIFT, data: obj.pos }, ...obj.transform);
      const lengths = edgeLengths(world, xform, [
        [[-1, -1, 0], [1, -1, 0]], [[-1, -1, 0], [-1, 1, 0]], [[-1, -1, 0], [-1, -1, 1]]]);
      const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
      const txcds = facedTexcoords(obj, 6, lengths, [[1, 2], [1, 2], [0, 2], [0, 2], [0, 1], [0, 1]], () => quad);
      const verts = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
      const mesh = facedMesh(world, obj, xform, verts, txcds, [
        [[1, 2, 6, 5], [0, 1, 2, 3]], [[3, 0, 4, 7], [4, 5, 6, 7]], [[2, 3, 7, 6], [8, 9, 10, 11]],
        [[0, 1, 5, 4], [12, 13, 14, 15]], [[4, 5, 6, 7], [16, 17, 18, 19]], [[1, 0, 3, 2], [20, 21, 22, 23]],
      ]);
      if (mesh) def.lists.mesh.push(mesh);
    };
    return obj;
  },

  pyramid: (world) => {
    const obj = baseObject({
      kind: 'pyramid',
      isOld: true,
      flipz: false,
      flipzAllowed: true,
      size: [world.bzdb.eval('_pyrBase'), world.bzdb.eval('_pyrBase'), world.bzdb.eval('_pyrHeight')],
      materials: [0, 1, 2, 3, 4].map(() => {
        const m = newMaterial();
        setTexture(m, 'pyrwall');
        return m;
      }),
      texsize: [0, 1, 2, 3, 4].map(() => [-8, -8]),
      texoffset: [0, 1, 2, 3, 4].map(() => [0, 0]),
      phydrv: [-1, -1, -1, -1, -1],
      drivethrough: [false, false, false, false, false],
      shootthrough: [false, false, false, false, false],
      ricochets: [false, false, false, false, false],
    });
    obj.read = (cmd, input) => readFaced(obj, cmd, input, world, PYR_FACES, (c) => {
      if (c === 'bottom') return [4];
      if (c === 'edge' || c === 'sides') return [0, 1, 2, 3];
      return [];
    });
    obj.write = (def) => {
      const flipped = obj.flipz || obj.size[2] < 0;
      if (obj.isOld && obj.transform.length === 0) {
        const size = obj.size.map((v) => Math.abs(v));
        def.lists.pyr.push({
          kind: 'pyr', pos: obj.pos, angle: obj.rotation, size, flipZ: flipped,
          driveThrough: obj.driveThrough, shootThrough: obj.shootThrough, ricochet: obj.ricochet,
          extents: boxExtents(obj.pos, obj.rotation, size),
        });
        return;
      }
      const xform = [];
      if (flipped) xform.push({ type: SCALE, data: [1, 1, -1] }, { type: SHIFT, data: [0, 0, 1] });
      xform.push({ type: SCALE, data: obj.size });
      addSpinOp(xform, f(obj.rotation * (180.0 / Math.PI)), [0, 0, 1]);
      xform.push({ type: SHIFT, data: obj.pos }, ...obj.transform);
      const top = [0, 0, 1];
      const lengths = edgeLengths(world, xform, [
        [[-1, -1, 0], [1, -1, 0]], [[-1, -1, 0], [-1, 1, 0]],
        [top, [1, 0, 0]], [top, [-1, 0, 0]], [top, [0, 1, 0]], [top, [0, -1, 0]]]);
      const tri = [[0, 0], [1, 0], [0.5, 1]];
      const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
      const txcds = facedTexcoords(obj, 5, lengths, [[1, 2], [1, 3], [0, 4], [0, 5], [0, 1]],
        (face) => (face < 4 ? tri : quad));
      const verts = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 1]];
      // Upstream's y+ face takes its ricochet from x- (CustomPyramid.cxx).
      const mesh = facedMesh(world, obj, xform, verts, txcds, [
        [[1, 2, 4], [0, 1, 2]], [[3, 0, 4], [3, 4, 5]], [[2, 3, 4], [6, 7, 8]],
        [[0, 1, 4], [9, 10, 11]], [[1, 0, 3, 2], [12, 13, 14, 15]],
      ], (face) => (face === 2 ? 1 : face));
      if (mesh) def.lists.mesh.push(mesh);
    };
    return obj;
  },

  base: (world) => {
    const size = world.bzdb.eval('_baseSize');
    const obj = baseObject({ kind: 'base', size: [size, size, 1], color: 0 });
    obj.read = (cmd, input) => {
      if (cmd === 'color') {
        const color = input.readInt();
        obj.color = color ?? 0;
        return !(obj.color <= 0 || obj.color >= 5);
      }
      if (cmd === 'oncap') {
        input.readWord();
        return true;
      }
      return readLocation(obj, cmd, input, world, true);
    };
    obj.write = (def) => {
      const size = obj.size.map((v) => Math.abs(v));
      def.lists.base.push({
        kind: 'base', team: obj.color, pos: obj.pos, angle: obj.rotation, size, flipZ: false,
        driveThrough: false, shootThrough: false, ricochet: obj.ricochet,
        extents: boxExtents(obj.pos, obj.rotation, size),
      });
    };
    return obj;
  },

  teleporter: (world, telename) => {
    const width = f(0.5 * world.bzdb.eval('_teleportWidth'));
    const obj = baseObject({
      kind: 'teleporter',
      telename,
      size: [width, world.bzdb.eval('_teleportBreadth'), f(2 * world.bzdb.eval('_teleportHeight'))],
      border: f(width * 2),
      horizontal: false,
    });
    obj.read = (cmd, input) => {
      if (cmd === 'border') {
        const b = input.readFloat();
        if (b !== null) obj.border = b;
        return true;
      }
      if (cmd === 'horizontal') {
        obj.horizontal = true;
        return true;
      }
      return readLocation(obj, cmd, input, world, true);
    };
    obj.write = (def) => {
      const name = !obj.telename && obj.name ? obj.name : obj.telename;
      def.lists.tele.push(makeTeleporter(obj.pos, obj.rotation, obj.size.map((v) => Math.abs(v)),
        obj.border, obj.horizontal, obj, name));
    };
    return obj;
  },

  link: (world) => {
    const obj = baseObject({ kind: 'link', from: '', to: '' });
    obj.read = (cmd, input) => {
      if (cmd === 'from') { obj.from = input.readWord() ?? obj.from; return true; }
      if (cmd === 'to') { obj.to = input.readWord() ?? obj.to; return true; }
      return readLocation(obj, cmd, input, world, false) && ieq(cmd, 'name');
    };
    obj.toWorld = () => {
      // LinkManager::addLink: a number names a teleporter face.
      const linkName = (s) => {
        if (s[0] >= '0' && s[0] <= '9') {
          const n = parseInt(s, 10);
          return `/t${Math.trunc(n / 2)}:${n % 2 === 0 ? 'f' : 'b'}`;
        }
        return s;
      };
      world.links.push({ src: linkName(obj.from), dst: linkName(obj.to) });
    };
    return obj;
  },

  mesh: (world) => {
    const material = newMaterial();
    setTexture(material, 'mesh');
    const obj = baseObject({
      kind: 'mesh', face: null, faces: [], checkTypes: [], checkPoints: [], vertices: [], normals: [],
      texcoords: [], phydrv: -1, noclusters: false, smoothBounce: false, decorative: false,
      drawInfo: null, material,
    });
    obj.read = (cmd, input) => {
      const c = lower(cmd);
      if (c.startsWith('lod')) {
        input.restOfLine();
        return true;
      }
      if (c === 'endface') {
        if (obj.face) obj.faces.push(obj.face);
        obj.face = null;
        return true;
      }
      if (obj.face) return readMeshFace(world, obj.face, cmd, input);
      if (c === 'face') {
        obj.face = {
          vertices: [], normals: [], texcoords: [], phydrv: obj.phydrv, noclusters: obj.noclusters,
          smoothBounce: obj.smoothBounce, driveThrough: obj.driveThrough, shootThrough: obj.shootThrough,
          ricochet: false, material: copyMaterial(obj.material),
        };
        return true;
      }
      const vec = (n) => {
        const out = [];
        for (let i = 0; i < n; i += 1) {
          const v = input.readFloat();
          if (v === null) return null;
          out.push(v);
        }
        return out;
      };
      if (c === 'inside' || c === 'outside') {
        const v = vec(3);
        if (!v) return false;
        obj.checkTypes.push(c === 'inside' ? 0 : 1);
        obj.checkPoints.push(v);
        return true;
      }
      if (c === 'vertex' || c === 'normal') {
        const v = vec(3);
        if (!v) return false;
        (c === 'vertex' ? obj.vertices : obj.normals).push(v);
        return true;
      }
      if (c === 'texcoord') {
        const v = vec(2);
        if (!v) return false;
        obj.texcoords.push(v);
        return true;
      }
      if (c === 'phydrv') {
        const name = input.readWord();
        if (name === null) return false;
        obj.phydrv = findIndex(world.physicsDrivers, name);
        return true;
      }
      if (c === 'smoothbounce') { obj.smoothBounce = true; return true; }
      if (c === 'noclusters') { obj.noclusters = true; return true; }
      if (c === 'decorative') { obj.decorative = true; return true; }
      if (c === 'drawinfo') {
        if (!obj.drawInfo) obj.drawInfo = parseDrawInfo(world, input) || null;
        return true;
      }
      const result = parseMaterials(world, cmd, input, [obj.material]);
      if (result) return !result.error;
      return readLocation(obj, cmd, input, world, true);
    };
    obj.write = (def) => {
      const xform = [];
      if (obj.size[0] !== 1 || obj.size[1] !== 1 || obj.size[2] !== 1) xform.push({ type: SCALE, data: obj.size });
      if (obj.rotation !== 0) addSpinOp(xform, f(obj.rotation * (180.0 / Math.PI)), [0, 0, 1]);
      if (obj.pos[0] !== 0 || obj.pos[1] !== 0 || obj.pos[2] !== 0) xform.push({ type: SHIFT, data: obj.pos });
      xform.push(...obj.transform);
      let forcePassable = false;
      const vertices = [...obj.vertices];
      if (obj.drawInfo) {
        if (obj.decorative) {
          const far = f(MAX_EXTENT * 2);
          vertices.push([far, far, far]);
          if (obj.faces.length > 0 && !(obj.driveThrough && obj.shootThrough)) forcePassable = true;
        } else {
          vertices.push([0, 0, 0]);
        }
      }
      const mesh = makeMesh(world, xform, obj.checkTypes, obj.checkPoints, vertices, obj.normals, obj.texcoords, {
        noclusters: obj.noclusters,
        smoothBounce: obj.smoothBounce,
        driveThrough: obj.driveThrough || forcePassable,
        shootThrough: obj.shootThrough || forcePassable,
        ricochet: obj.ricochet,
      });
      for (const face of obj.faces) {
        const mat = world.addMaterial(face.material);
        addFace(mesh, face.vertices, face.normals, face.texcoords, mat, face.phydrv, face, true);
      }
      finalizeMesh(mesh);
      if (obj.drawInfo && setupDrawInfo(obj.drawInfo, mesh)) mesh.drawInfo = obj.drawInfo;
      def.lists.mesh.push(mesh);
    };
    return obj;
  },

  arc: (world, boxStyle) => curvedObject(world, 'arc', boxStyle),
  cone: (world, pyramidStyle) => curvedObject(world, 'cone', pyramidStyle),
  sphere: (world) => curvedObject(world, 'sphere', false),

  tetra: (world) => {
    const obj = baseObject({
      kind: 'tetra',
      vertexCount: 0,
      vertices: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
      normals: [0, 1, 2, 3].map(() => [[0, 0, 0], [0, 0, 0], [0, 0, 0]]),
      texcoords: [0, 1, 2, 3].map(() => [[0, 0], [0, 0], [0, 0]]),
      useNormals: [false, false, false, false],
      useTexcoords: [false, false, false, false],
      materials: [0, 1, 2, 3].map(() => {
        const m = newMaterial();
        setTexture(m, 'mesh');
        return m;
      }),
    });
    obj.read = (cmd, input) => {
      if (obj.vertexCount > 4) return true;
      const target = obj.vertexCount === 0 ? obj.materials : [obj.materials[Math.min(obj.vertexCount - 1, 3)]];
      const result = parseMaterials(world, cmd, input, target);
      if (result) return !result.error;
      const c = lower(cmd);
      if (c === 'vertex') {
        if (obj.vertexCount < 4) {
          const v = obj.vertices[obj.vertexCount];
          for (let i = 0; i < 3; i += 1) { const x = input.readFloat(); if (x !== null) v[i] = x; }
          obj.vertexCount += 1;
        }
        return true;
      }
      if (c === 'normals' || c === 'texcoords') {
        if (obj.vertexCount >= 1 && obj.vertexCount <= 4) {
          const vi = obj.vertexCount - 1;
          const isNormals = c === 'normals';
          (isNormals ? obj.useNormals : obj.useTexcoords)[vi] = true;
          for (let v = 0; v < 3; v += 1) {
            const target2 = (isNormals ? obj.normals : obj.texcoords)[vi][v];
            for (let i = 0; i < (isNormals ? 3 : 2); i += 1) {
              const x = input.readFloat();
              if (x !== null) target2[i] = x;
            }
          }
        }
        return true;
      }
      return readLocation(obj, cmd, input, world, true);
    };
    obj.write = (def) => {
      if (obj.vertexCount < 4) return;
      const mats = obj.materials.map((m) => world.addMaterial(m));
      def.lists.tetra.push({
        kind: 'tetra',
        transformOps: [...obj.transform],
        vertices: obj.vertices,
        normals: obj.normals.map((n, i) => (obj.useNormals[i] ? n : null)),
        texcoords: obj.texcoords.map((t, i) => (obj.useTexcoords[i] ? t : null)),
        materialRefs: mats,
        driveThrough: obj.driveThrough,
        shootThrough: obj.shootThrough,
        ricochet: obj.ricochet,
        extents: newExtents(),
      });
    };
    return obj;
  },

  weapon: (world) => {
    const obj = baseObject({
      kind: 'weapon', initdelay: f(10), delay: [f(10)], type: '', triggered: false,
    });
    obj.read = (cmd, input) => {
      if (cmd === 'initdelay') {
        const v = input.readFloat();
        if (v !== null) obj.initdelay = v;
        return true;
      }
      if (cmd === 'delay') {
        const parms = new Stream(input.restOfLine());
        obj.delay = [];
        for (let d = parms.readFloat(); d !== null; d = parms.readFloat()) {
          if (d >= f(0.1)) obj.delay.push(d);
        }
        return obj.delay.length > 0;
      }
      if (cmd === 'type') {
        const abbv = (input.readWord() || '').toUpperCase();
        obj.type = FLAG_TYPES[abbv] ? abbv : '';
        return true;
      }
      if (cmd === 'color') { input.readInt(); return true; }
      if (cmd === 'tilt') { input.readFloat(); return true; }
      if (cmd === 'trigger') {
        const name = lower(input.readWord() || '');
        if (name === 'oncap' || name === 'onspawn' || name === 'ondie') obj.triggered = true;
        return true;
      }
      if (cmd === 'eventteam') { input.readInt(); return true; }
      return readLocation(obj, cmd, input, world, false);
    };
    obj.toWorld = () => {
      if (obj.triggered) return;
      world.weapons.push({
        flagAbbv: obj.type, pos: obj.pos, dir: obj.rotation, initDelay: obj.initdelay, delay: obj.delay,
      });
    };
    return obj;
  },

  zone: (world) => {
    const obj = baseObject({ kind: 'zone', qualifiers: [] });
    const nonNormal = (quality) => Object.entries(FLAG_TYPES)
      .filter(([, t]) => t.quality === quality && t.endurance !== FLAG_ENDURANCE.NORMAL).map(([abbv]) => abbv);
    obj.read = (cmd, input) => {
      if (cmd === 'flag') {
        const parms = new Stream(input.restOfLine());
        for (let flag = parms.readWord(); flag !== null; flag = parms.readWord()) {
          if (flag === 'good' || flag === 'bad') {
            for (const abbv of nonNormal(flag === 'good' ? FLAG_QUALITY.GOOD : FLAG_QUALITY.BAD)) obj.qualifiers.push(`f${abbv}`);
          } else {
            const abbv = flag.toUpperCase();
            const type = FLAG_TYPES[abbv];
            if (!type || type.endurance === FLAG_ENDURANCE.NORMAL) return false;
            obj.qualifiers.push(`f${abbv}`);
          }
        }
        return obj.qualifiers.length > 0;
      }
      if (cmd === 'zoneflag') {
        const parms = new Stream(input.restOfLine());
        const flag = parms.readWord();
        if (flag === null) return false;
        if (flag !== 'good' && flag !== 'bad' && !FLAG_TYPES[flag.toUpperCase()]) return false;
        return true;
      }
      if (cmd === 'team' || cmd === 'safety') {
        const parms = new Stream(input.restOfLine());
        for (let color = parms.readInt(); color !== null; color = parms.readInt()) {
          if (color < 0 || color >= 5) return false;
          if (cmd === 'safety') {
            if (color > 0) obj.qualifiers.push(`$${color}`);
          } else {
            obj.qualifiers.push(`t${color}`);
          }
        }
        return obj.qualifiers.length > 0;
      }
      return readLocation(obj, cmd, input, world, false);
    };
    obj.toWorld = () => world.zones.push(obj);
    return obj;
  },

  waterLevel: (world) => {
    const obj = baseObject({ kind: 'waterLevel', height: 0, material: newMaterial(), moded: false });
    obj.read = (cmd, input) => {
      if (ieq(cmd, 'height')) {
        const h = input.readFloat();
        if (h === null) return false;
        obj.height = h;
        return true;
      }
      const result = parseMaterials(world, cmd, input, [obj.material]);
      if (result) {
        if (result.error) return false;
        obj.moded = true;
        return true;
      }
      return readLocation(obj, cmd, input, world, false) && ieq(cmd, 'name');
    };
    obj.toWorld = () => {
      world.waterLevel = obj.height;
      world.waterMat = obj.moded ? world.addMaterial(obj.material) : null;
    };
    return obj;
  },

  dynamicColor: (world) => {
    const color = {
      name: '',
      channels: [0, 1, 2, 3].map(() => ({
        min: 0, max: 1, sinusoids: [], clampUps: [], clampDowns: [], sequence: { period: 0, offset: 0, list: [] },
      })),
    };
    const obj = baseObject({ kind: 'dynamicColor' });
    const MIN_PERIOD = f(0.01);
    obj.read = (cmd, input) => {
      const channel = ['red', 'green', 'blue', 'alpha'].indexOf(lower(cmd));
      if (channel < 0) return readLocation(obj, cmd, input, world, false) && ieq(cmd, 'name');
      const parms = new Stream(input.restOfLine());
      const command = parms.readWord();
      if (command === null) return false;
      const ch = color.channels[channel];
      const three = () => {
        const a = parms.readFloat(); const b = parms.readFloat(); const c = parms.readFloat();
        return c === null || b === null || a === null ? null : [a, b, c];
      };
      const clamp = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));
      switch (lower(command)) {
        case 'limits': {
          const min = parms.readFloat(); const max = parms.readFloat();
          if (min === null || max === null) return false;
          ch.min = clamp(min);
          ch.max = clamp(max);
          return true;
        }
        case 'sinusoid': case 'clampup': case 'clampdown': {
          const d = three();
          if (!d) return false;
          if (d[0] >= MIN_PERIOD && d[2] > 0) {
            const c = lower(command);
            if (c === 'sinusoid') ch.sinusoids.push({ period: d[0], offset: d[1], weight: d[2] });
            else (c === 'clampup' ? ch.clampUps : ch.clampDowns).push({ period: d[0], offset: d[1], width: d[2] });
          }
          return true;
        }
        case 'sequence': {
          const period = parms.readFloat(); const offset = parms.readFloat();
          if (period === null || offset === null) return false;
          const list = [];
          for (let v = parms.readInt(); v !== null; v = parms.readInt()) list.push(((v & 0xff) << 24) >> 24);
          ch.sequence = period >= MIN_PERIOD ? { period, offset, list } : { period: 0, offset: 0, list: [] };
          return true;
        }
        default: return false;
      }
    };
    obj.toManager = () => {
      color.name = validName(obj.name);
      for (const ch of color.channels) ch.sequence.list = ch.sequence.list.map((v) => (v < 0 ? 0 : (v > 2 ? 2 : v)));
      world.dynamicColors.push(color);
    };
    return obj;
  },

  textureMatrix: (world) => {
    const t = {
      rotation: 0, uFixedShift: 0, vFixedShift: 0, uFixedScale: 1, vFixedScale: 1, uFixedCenter: 0.5, vFixedCenter: 0.5,
      spinFreq: 0, uShiftFreq: 0, vShiftFreq: 0, uScaleFreq: 0, vScaleFreq: 0, uScale: 1, vScale: 1, uCenter: 0.5, vCenter: 0.5,
    };
    const obj = baseObject({ kind: 'textureMatrix' });
    obj.read = (cmd, input) => {
      const c = lower(cmd);
      const read = (n) => {
        const out = [];
        for (let i = 0; i < n; i += 1) {
          const v = input.readFloat();
          if (v === null) return null;
          out.push(v);
        }
        return out;
      };
      const table = {
        fixedshift: [2, (v) => { t.uFixedShift = v[0]; t.vFixedShift = v[1]; }],
        fixedscale: [2, (v) => { if (v[0] !== 0) t.uFixedScale = v[0]; if (v[1] !== 0) t.vFixedScale = v[1]; }],
        fixedspin: [1, (v) => { t.rotation = v[0]; }],
        fixedcenter: [2, (v) => { t.uFixedCenter = v[0]; t.vFixedCenter = v[1]; }],
        shift: [2, (v) => { t.uShiftFreq = v[0]; t.vShiftFreq = v[1]; }],
        spin: [1, (v) => { t.spinFreq = v[0]; }],
        scale: [4, (v) => {
          t.uScaleFreq = v[0]; t.vScaleFreq = v[1];
          if (v[2] >= 1) t.uScale = v[2];
          if (v[3] >= 1) t.vScale = v[3];
        }],
        center: [2, (v) => { t.uCenter = v[0]; t.vCenter = v[1]; }],
      };
      if (!table[c]) return readLocation(obj, cmd, input, world, false) && ieq(cmd, 'name');
      const v = read(table[c][0]);
      if (!v) return false;
      table[c][1](v);
      return true;
    };
    obj.toManager = () => {
      const useStatic = t.rotation !== 0 || t.uFixedShift !== 0 || t.vFixedShift !== 0 || t.uFixedScale !== 1 || t.vFixedScale !== 1;
      const useDynamic = t.spinFreq !== 0 || t.uShiftFreq !== 0 || t.vShiftFreq !== 0 || t.uScaleFreq !== 0 || t.vScaleFreq !== 0;
      world.textureMatrices.push({ name: validName(obj.name), useStatic, useDynamic, ...t });
    };
    return obj;
  },

  physics: (world) => {
    const d = {
      linear: [0, 0, 0], angularVel: 0, angularPos: [0, 0], radialVel: 0, radialPos: [0, 0], slideTime: 0, deathMsg: '',
    };
    const obj = baseObject({ kind: 'physics' });
    obj.read = (cmd, input) => {
      const c = lower(cmd);
      const read = (n) => {
        const out = [];
        for (let i = 0; i < n; i += 1) {
          const v = input.readFloat();
          if (v === null) return null;
          out.push(v);
        }
        return out;
      };
      if (c === 'linear') { const v = read(3); if (!v) return false; d.linear = v; return true; }
      if (c === 'angular') {
        const v = read(3);
        if (!v) return false;
        d.angularVel = f(v[0] * (2.0 * Math.PI));
        d.angularPos = [v[1], v[2]];
        return true;
      }
      if (c === 'radial') { const v = read(3); if (!v) return false; d.radialVel = v[0]; d.radialPos = [v[1], v[2]]; return true; }
      if (c === 'slide') { const v = read(1); if (!v) return false; d.slideTime = v[0]; return true; }
      if (c === 'death') {
        d.deathMsg = input.restOfLine().replace(/^[ \t\n\v\f\r]+/, '').slice(0, 256);
        return true;
      }
      return readLocation(obj, cmd, input, world, false) && ieq(cmd, 'name');
    };
    obj.toManager = () => {
      if (!(d.slideTime > 0)) d.slideTime = 0;
      world.physicsDrivers.push({ name: validName(obj.name), ...d });
    };
    return obj;
  },

  transform: (world) => {
    const ops = [];
    const obj = baseObject({ kind: 'transform' });
    obj.read = (cmd, input) => {
      const c = lower(cmd);
      if (c === 'spin') {
        const a = input.readFloat(); const x = input.readFloat(); const y = input.readFloat(); const z = input.readFloat();
        if (z === null || y === null || x === null || a === null) return false;
        addSpinOp(ops, a, [x, y, z]);
        return true;
      }
      if (c === 'shift' || c === 'scale' || c === 'shear') {
        const x = input.readFloat(); const y = input.readFloat(); const z = input.readFloat();
        if (z === null || y === null || x === null) return false;
        ops.push({ type: c === 'shift' ? SHIFT : (c === 'scale' ? SCALE : SHEAR), data: [x, y, z] });
        return true;
      }
      if (c === 'xform') {
        const name = input.readWord();
        if (name === null) return false;
        const index = findIndex(world.transforms, name);
        if (index !== -1) ops.push({ type: INDEX, index });
        return true;
      }
      return readLocation(obj, cmd, input, world, false) && ieq(cmd, 'name');
    };
    obj.toManager = () => world.transforms.push({ name: validName(obj.name), ops });
    return obj;
  },

  material: (world) => {
    const material = newMaterial();
    const obj = baseObject({ kind: 'material' });
    obj.read = (cmd, input) => {
      const result = parseMaterials(world, cmd, input, [material]);
      if (result) return !result.error;
      return readLocation(obj, cmd, input, world, false) && ieq(cmd, 'name');
    };
    obj.toManager = () => {
      material.name = validName(obj.name);
      world.addMaterial(material);
    };
    return obj;
  },

  world: (world) => {
    const obj = baseObject({ kind: 'world' });
    obj.read = (cmd, input) => {
      const c = lower(cmd);
      if (c === 'size') {
        let size = input.readFloat();
        if (size === null) size = 0;
        size = f(size * 2.0);
        world.bzdb.set('_worldSize', size.toFixed(6));
        return true;
      }
      if (c === 'flagheight') {
        const h = input.readFloat();
        world.bzdb.set('_flagHeight', (h ?? 0).toFixed(6));
        return true;
      }
      if (c === 'nowalls') { world.bzdb.set('noWalls', '1'); return true; }
      if (c === 'freectfspawns') return true;
      return readLocation(obj, cmd, input, world, false) && c === 'name';
    };
    obj.toWorld = () => {};
    return obj;
  },

  group: (world, groupdef) => {
    const obj = baseObject({
      kind: 'group', groupdef, modifyTeam: false, team: 0, modifyColor: false, tint: [1, 1, 1, 1],
      modifyPhysicsDriver: false, phydrv: -1, modifyMaterial: false, material: null, matMap: new Map(),
    });
    obj.read = (cmd, input) => {
      const c = lower(cmd);
      if (cmd === 'team') {
        const team = input.readInt();
        if (team === null || team < 0 || team >= 5) return false;
        obj.modifyTeam = true;
        obj.team = team;
        return true;
      }
      if (c === 'tint') {
        const tint = parseColor(input.restOfLine());
        if (!tint) return false;
        obj.modifyColor = true;
        obj.tint = tint;
        return true;
      }
      if (c === 'phydrv') {
        const name = input.readWord();
        if (name === null) return false;
        const pd = findIndex(world.physicsDrivers, name);
        if (!(pd === -1 && name !== '-1')) {
          obj.modifyPhysicsDriver = true;
          obj.phydrv = pd;
        }
        return true;
      }
      if (c === 'matref') {
        const name = input.readWord() ?? '';
        const ref = world.findMaterial(name);
        if (!(ref === null && name !== '-1')) {
          obj.modifyMaterial = true;
          obj.material = ref;
        }
        return true;
      }
      if (c === 'matswap') {
        const src = world.findMaterial(input.readWord() ?? '');
        const dst = world.findMaterial(input.readWord() ?? '');
        if (src && dst) obj.matMap.set(src, dst);
        return true;
      }
      return readLocation(obj, cmd, input, world, true);
    };
    obj.write = (def) => {
      if (!obj.groupdef) return;
      const xform = [];
      if (obj.size[0] !== 1 || obj.size[1] !== 1 || obj.size[2] !== 1) xform.push({ type: SCALE, data: obj.size });
      if (obj.rotation !== 0) addSpinOp(xform, f(obj.rotation * (180.0 / Math.PI)), [0, 0, 1]);
      if (obj.pos[0] !== 0 || obj.pos[1] !== 0 || obj.pos[2] !== 0) xform.push({ type: SHIFT, data: obj.pos });
      xform.push(...obj.transform);
      def.groups.push({ ...obj, transformOps: xform });
    };
    return obj;
  },
};

function readMeshFace(world, face, cmd, input) {
  const c = lower(cmd);
  const ints = () => {
    const parms = new Stream(input.restOfLine());
    const out = [];
    for (let v = parms.readInt(); v !== null; v = parms.readInt()) out.push(v);
    return out;
  };
  if (c === 'vertices' || c === 'normals' || c === 'texcoords') {
    face[c] = ints();
    return face[c].length >= 3;
  }
  if (c === 'phydrv') {
    const name = input.readWord();
    if (name === null) return false;
    face.phydrv = findIndex(world.physicsDrivers, name);
    return true;
  }
  if (c === 'smoothbounce') { face.smoothBounce = true; return true; }
  if (c === 'noclusters') { face.noclusters = true; return true; }
  if (c === 'drivethrough') { face.driveThrough = true; return true; }
  if (c === 'shootthrough') { face.shootThrough = true; return true; }
  if (c === 'passable') { face.driveThrough = true; face.shootThrough = true; return true; }
  if (c === 'ricochet') { face.ricochet = true; return true; }
  const result = parseMaterials(world, cmd, input, [face.material]);
  if (result) return !result.error;
  return false;
}

// CustomArc / CustomCone / CustomSphere: the curved obstacles bzfs packs as
// themselves, with the box and pyramid styles (`meshbox`, `meshpyr`) folded
// into their transform.
function curvedObject(world, kind, boxStyle) {
  const sideNames = {
    arc: ['top', 'bottom', 'inside', 'outside', 'startside', 'endside'],
    cone: ['edge', 'bottom', 'startside', 'endside'],
    sphere: ['edge', 'bottom'],
  }[kind];
  const textures = {
    arc: ['roof', 'roof', 'boxwall', 'boxwall', 'wall', 'wall'],
    cone: boxStyle ? ['pyrwall', 'pyrwall', 'pyrwall', 'pyrwall'] : ['boxwall', 'roof', 'wall', 'wall'],
    sphere: ['boxwall', 'roof'],
  }[kind];
  const obj = baseObject({
    kind,
    divisions: kind === 'sphere' ? 4 : 16,
    size: [10, 10, 10],
    ratio: 1,
    angle: 360,
    texsize: kind === 'arc' ? [-8, -8, -8, -8] : (kind === 'sphere' ? [-4, -4] : [-8, -8]),
    phydrv: -1,
    useNormals: true,
    smoothBounce: false,
    hemisphere: false,
    flipz: false,
    materials: textures.map((t) => {
      const m = newMaterial();
      setTexture(m, t);
      return m;
    }),
  });
  if (kind === 'sphere') obj.pos = [0, 0, 10];
  if (boxStyle) {
    obj.divisions = 4;
    obj.useNormals = false;
    if (kind === 'arc') obj.size = [world.bzdb.eval('_boxBase'), world.bzdb.eval('_boxBase'), world.bzdb.eval('_boxHeight')];
    else obj.size = [world.bzdb.eval('_pyrBase'), world.bzdb.eval('_pyrBase'), world.bzdb.eval('_pyrHeight')];
  }
  obj.read = (cmd, input) => {
    const c = lower(cmd);
    if (c === 'divisions') { const v = input.readInt(); if (v === null) return false; obj.divisions = v; return true; }
    if (kind !== 'sphere' && c === 'angle') { const v = input.readFloat(); if (v === null) return false; obj.angle = v; return true; }
    if (kind === 'arc' && c === 'ratio') { const v = input.readFloat(); if (v === null) return false; obj.ratio = v; return true; }
    if (kind === 'sphere' && c === 'radius') {
      const v = input.readFloat();
      if (v === null) return false;
      obj.size = [v, v, v];
      return true;
    }
    if (kind === 'sphere' && (c === 'hemi' || c === 'hemisphere')) { obj.hemisphere = true; return true; }
    if (c === 'texsize') {
      const out = [];
      for (let i = 0; i < obj.texsize.length; i += 1) {
        const v = input.readFloat();
        if (v === null) return false;
        out.push(v);
      }
      obj.texsize = out;
      return true;
    }
    if (c === 'phydrv') {
      const name = input.readWord();
      if (name === null) return false;
      obj.phydrv = findIndex(world.physicsDrivers, name);
      return true;
    }
    if (c === 'smoothbounce') { obj.smoothBounce = true; return true; }
    if (c === 'flatshading') { obj.useNormals = false; return true; }
    const result = parseMaterials(world, cmd, input, obj.materials);
    if (result) return !result.error;
    const byName = parseMaterialsByName(world, cmd, input, obj.materials, sideNames);
    if (byName) return !byName.error;
    if (kind === 'cone' && boxStyle && c === 'flipz') { obj.flipz = true; return true; }
    return readLocation(obj, cmd, input, world, true);
  };
  obj.write = (def) => {
    const mats = obj.materials.map((m) => world.addMaterial(m));
    let transformOps = [...obj.transform];
    let pos = obj.pos;
    let size = obj.size;
    let angle = obj.rotation;
    if (boxStyle) {
      transformOps = [];
      if (kind === 'cone' && (obj.flipz || obj.size[2] < 0)) {
        transformOps.push({ type: SCALE, data: [1, 1, -1] }, { type: SHIFT, data: [0, 0, obj.size[2]] });
      }
      addSpinOp(transformOps, f(obj.rotation * (180.0 / Math.PI)), [0, 0, 1]);
      transformOps.push({ type: SHIFT, data: obj.pos }, ...obj.transform);
      pos = [0, 0, 0];
      size = [f(obj.size[0] * Math.SQRT2), f(obj.size[1] * Math.SQRT2), kind === 'cone' ? Math.abs(obj.size[2]) : obj.size[2]];
      angle = f(Math.PI * 0.25);
    }
    def.lists[kind].push({
      kind,
      transformOps,
      pos,
      size,
      angle,
      sweepAngle: kind === 'sphere' ? null : obj.angle,
      ratio: kind === 'arc' ? obj.ratio : null,
      divisions: obj.divisions,
      phydrv: obj.phydrv,
      texsize: obj.texsize,
      materialRefs: mats,
      driveThrough: obj.driveThrough,
      shootThrough: obj.shootThrough,
      smoothBounce: obj.smoothBounce,
      useNormals: obj.useNormals,
      hemisphere: obj.hemisphere,
      ricochet: obj.ricochet,
      extents: newExtents(),
    });
  };
  return obj;
}

// MeshDrawInfo::parse (MeshDrawInfo.cxx:874): a mesh's own render geometry,
// line by line to its `end`. Anything malformed makes the whole block
// invalid, and CustomMesh then drops it.
const DRAW_MODES = {
  points: 0, lines: 1, lineloop: 2, linestrip: 3, tris: 4, tristrip: 5, trifan: 6, quads: 7, quadstrip: 8, polygon: 9,
};
const DRAW_INDEX_USHORT = 0x1403;
const DRAW_INDEX_UINT = 0x1405;

function parseDrawLod(world, input, lod) {
  let success = true;
  const sets = [];
  while (input.good()) {
    const line = input.getline();
    if (input.fail) break;
    const parms = new Stream(line);
    const cmd = parms.readWord();
    if (cmd === null || cmd === '' || cmd[0] === '#') continue;
    const c = lower(cmd);
    if (c === 'end') break;
    if (c === 'length' || c === 'lengthperpixel') {
      const v = parms.readFloat();
      if (v !== null) lod.lengthPerPixel = v;
      else success = false;
    } else if (c === 'matref') {
      const matName = parms.readWord();
      if (matName === null) {
        success = false;
        continue;
      }
      const set = { cmds: [], material: world.findMaterial(matName), wantList: false, sphere: [FLT_MAX, FLT_MAX, FLT_MAX, FLT_MAX] };
      let setOk = true;
      while (input.good()) {
        const setLine = input.getline();
        if (input.fail) break;
        const sp = new Stream(setLine);
        const label = sp.readWord();
        if (label === null || label === '' || label[0] === '#') continue;
        const l = lower(label);
        if (l === 'end') break;
        if (l === 'dlist') set.wantList = true;
        else if (l === 'center' || l === 'sphere') {
          const n = l === 'center' ? 3 : 4;
          for (let i = 0; i < n; i += 1) {
            const v = sp.readFloat();
            if (v === null) { setOk = false; break; }
            set.sphere[i] = v;
          }
        } else if (Object.prototype.hasOwnProperty.call(DRAW_MODES, label)) {
          const indices = [];
          for (let v = sp.readInt(); v !== null; v = sp.readInt()) indices.push(v >>> 0);
          const short = indices.every((v) => v <= 0xffff);
          set.cmds.push({ drawMode: DRAW_MODES[label], indices, indexType: short ? DRAW_INDEX_USHORT : DRAW_INDEX_UINT });
        } else {
          setOk = false;
        }
      }
      if (setOk) sets.push(set);
      else success = false;
    }
  }
  return { success, lod: { sets, lengthPerPixel: lod.lengthPerPixel } };
}

function parseDrawInfo(world, input) {
  input.getline();
  const info = {
    name: '', options: [], angvel: null, corners: [], rawVerts: [], rawNorms: [], rawTxcds: [], lods: [], radarLods: [],
    extents: newExtents(), sphere: [FLT_MAX, FLT_MAX, FLT_MAX, FLT_MAX],
  };
  let success = true;
  let allDList = false;
  const lod = { lengthPerPixel: 0 };
  const floats = (parms, n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const v = parms.readFloat();
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };
  while (input.good()) {
    const line = input.getline();
    if (input.fail) break;
    const parms = new Stream(line);
    const cmd = parms.readWord();
    if (cmd === null || cmd === '' || cmd[0] === '#') continue;
    const c = lower(cmd);
    if (c === 'end') break;
    if (c === 'dlist') allDList = true;
    else if (c === 'angvel') {
      if (info.angvel !== null) success = false;
      const v = parms.readFloat();
      if (v !== null) info.angvel = v;
      else success = false;
    } else if (c === 'extents') {
      const v = floats(parms, 6);
      if (v) info.extents = { mins: v.slice(0, 3), maxs: v.slice(3) };
      else success = false;
    } else if (c === 'center' || c === 'sphere') {
      const v = floats(parms, c === 'center' ? 3 : 4);
      if (v) v.forEach((x, i) => { info.sphere[i] = x; });
      else success = false;
    } else if (c === 'option') {
      info.options.push(line.replace(/^[ \t\n\v\f\r]+/, ''));
    } else if (c === 'corner') {
      const v = parms.readInt(); const n = parms.readInt(); const t = parms.readInt();
      if (v === null || n === null || t === null) success = false;
      else info.corners.push({ vertex: v, normal: n, texcoord: t });
    } else if (c === 'vertex' || c === 'normal') {
      const v = floats(parms, 3);
      if (v) (c === 'vertex' ? info.rawVerts : info.rawNorms).push(v);
      else success = false;
    } else if (c === 'texcoord') {
      const v = floats(parms, 2);
      if (v) info.rawTxcds.push(v);
      else success = false;
    } else if (c === 'lod' || c === 'radarlod') {
      // The same DrawLod is read into every time, so a length a lod does not
      // state is the one before it.
      const result = parseDrawLod(world, input, lod);
      if (result.success) (c === 'lod' ? info.lods : info.radarLods).push(result.lod);
      else success = false;
    }
  }
  input.putback();
  if (allDList) for (const l of [...info.lods, ...info.radarLods]) for (const set of l.sets) set.wantList = true;
  return success ? info : null;
}

// MeshDrawInfo::serverSetup: checks the corners and indices, and fills in
// the extents and bounding spheres the block did not state.
function setupDrawInfo(info, mesh) {
  const raw = info.rawVerts.length > 0;
  const vCount = raw ? info.rawVerts.length : mesh.vertices.length;
  const nCount = raw ? info.rawNorms.length : mesh.normals.length;
  const tCount = raw ? info.rawTxcds.length : mesh.texcoords.length;
  for (const c of info.corners) {
    if (c.vertex < 0 || c.vertex >= vCount || c.normal < 0 || c.normal >= nCount
      || c.texcoord < 0 || c.texcoord >= tCount) return false;
  }
  for (const l of info.lods) {
    for (const set of l.sets) {
      for (const cmd of set.cmds) {
        if (cmd.indices.some((i) => (i | 0) >= info.corners.length)) return false;
      }
    }
  }
  const verts = raw ? info.rawVerts : mesh.vertices;
  const reset = newExtents();
  const calcCenter = info.sphere[0] === FLT_MAX && info.sphere[1] === FLT_MAX && info.sphere[2] === FLT_MAX;
  const calcRadius = info.sphere[3] === FLT_MAX;
  const calcExtents = [0, 1, 2].every((a) => info.extents.mins[a] === reset.mins[a] && info.extents.maxs[a] === reset.maxs[a]);
  if (calcCenter || calcRadius || calcExtents) {
    let tmp = newExtents();
    if (info.angvel === null || info.angvel === 0) {
      for (const v of verts) expandToPoint(tmp, v);
    } else {
      let minZ = FLT_MAX;
      let maxZ = -FLT_MAX;
      let maxDistSqr = -FLT_MAX;
      for (const p of verts) {
        if (p[2] < minZ) minZ = p[2];
        if (p[2] > maxZ) maxZ = p[2];
        const distSqr = f(f(p[0] * p[0]) + f(p[1] * p[1]));
        if (distSqr > maxDistSqr) maxDistSqr = distSqr;
      }
      const dist = f(Math.sqrt(maxDistSqr));
      tmp = { mins: [-dist, -dist, minZ], maxs: [dist, dist, maxZ] };
    }
    if (calcExtents) info.extents = tmp;
  }
  const e = info.extents;
  if (calcCenter) {
    for (let a = 0; a < 3; a += 1) info.sphere[a] = f(0.5 * f(e.maxs[a] + e.mins[a]));
  }
  const radiusSqr = (ex) => {
    const dx = f(ex.maxs[0] - ex.mins[0]);
    const dy = f(ex.maxs[1] - ex.mins[1]);
    const dz = f(ex.maxs[2] - ex.mins[2]);
    return f(0.25 * f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz)));
  };
  if (calcRadius) info.sphere[3] = radiusSqr(e);
  for (const l of info.lods) {
    for (const set of l.sets) {
      const setCenter = set.sphere[0] === FLT_MAX && set.sphere[1] === FLT_MAX && set.sphere[2] === FLT_MAX;
      const setRadius = set.sphere[3] === FLT_MAX;
      if (!setCenter && !setRadius) continue;
      const ex = newExtents();
      for (const cmd of set.cmds) for (const i of cmd.indices) expandToPoint(ex, verts[info.corners[i].vertex]);
      if (setCenter) for (let a = 0; a < 3; a += 1) set.sphere[a] = f(0.5 * f(ex.maxs[a] + ex.mins[a]));
      if (setRadius) set.sphere[3] = radiusSqr(ex);
    }
  }
  // qsort by lengthPerPixel, three-way, so stable under glibc's merge sort.
  info.lods = msort(info.lods, (a, b) => (a.lengthPerPixel < b.lengthPerPixel ? -1 : (a.lengthPerPixel > b.lengthPerPixel ? 1 : 0)));
  return true;
}

// MeshDrawInfo::pack, with the material indices the world settled on.
function packDrawInfo(info, index) {
  const parts = [];
  const u8 = (v) => { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); parts.push(b); };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); parts.push(b); };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); parts.push(b); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); parts.push(b); };
  const fl = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); parts.push(b); };
  const str = (s) => { const b = Buffer.from(String(s), 'utf8'); u32(b.length); parts.push(b); };
  str(info.name);
  i32(info.options.length);
  for (const o of info.options) str(o);
  u32(info.angvel !== null ? 1 : 0);
  if (info.angvel !== null) {
    fl(info.angvel);
    str('');
  }
  i32(info.corners.length);
  for (const c of info.corners) {
    const wide = [c.vertex, c.normal, c.texcoord].some((v) => v > 0xffff || v < 0);
    u8(wide ? 0 : 1);
    if (wide) { i32(c.vertex); i32(c.normal); i32(c.texcoord); } else { u16(c.vertex); u16(c.normal); u16(c.texcoord); }
  }
  i32(info.rawVerts.length);
  for (const v of info.rawVerts) v.forEach(fl);
  i32(info.rawNorms.length);
  for (const v of info.rawNorms) v.forEach(fl);
  i32(info.rawTxcds.length);
  for (const v of info.rawTxcds) v.forEach(fl);
  const lod = (l) => {
    i32(l.sets.length);
    for (const set of l.sets) {
      i32(set.cmds.length);
      for (const cmd of set.cmds) {
        u32(cmd.drawMode);
        i32(cmd.indices.length);
        u32(cmd.indexType);
        for (const i of cmd.indices) (cmd.indexType === DRAW_INDEX_USHORT ? u16 : u32)(i);
      }
      i32(index(set.material));
      set.sphere.forEach(fl);
      u8(set.wantList ? 1 : 0);
    }
    fl(l.lengthPerPixel);
  };
  i32(info.lods.length);
  info.lods.forEach(lod);
  i32(info.radarLods.length);
  info.radarLods.forEach(lod);
  info.sphere.forEach(fl);
  info.extents.mins.forEach(fl);
  info.extents.maxs.forEach(fl);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// BZWReader::readWorldStream and defineWorldFromFile.
// ---------------------------------------------------------------------------

function readToken(input) {
  let c = -1;
  while (input.good()) {
    c = input.get();
    if (c === -1 || !isSpace(c) || c === '\n') break;
  }
  let token = '';
  if (c !== -1 && c !== '\n') {
    token += c;
    while (input.good() && token.length < 1023) {
      c = input.get();
      if (c === -1 || isSpace(c)) break;
      token += c;
    }
  }
  if (c !== -1 && isSpace(c)) input.putback();
  return token;
}

function skipRestOfLine(input) {
  while (input.good() && input.peek() !== '\n') {
    const nl = input.s.indexOf('\n', input.i);
    input.i = nl < 0 ? input.s.length : nl;
    if (nl < 0) input.eof = true;
  }
  if (input.good()) input.getline();
  else if (!input.fail && input.i >= input.s.length) { input.eof = true; input.fail = true; }
}

const NORMAL_OBJECTS = {
  box: (w) => CUSTOM.box(w),
  pyramid: (w) => CUSTOM.pyramid(w),
  base: (w) => CUSTOM.base(w),
  link: (w) => CUSTOM.link(w),
  mesh: (w) => CUSTOM.mesh(w),
  arc: (w) => CUSTOM.arc(w, false),
  meshbox: (w) => CUSTOM.arc(w, true),
  cone: (w) => CUSTOM.cone(w, false),
  meshpyr: (w) => CUSTOM.cone(w, true),
  sphere: (w) => CUSTOM.sphere(w),
  tetra: (w) => CUSTOM.tetra(w),
  weapon: (w) => CUSTOM.weapon(w),
  zone: (w) => CUSTOM.zone(w),
  waterlevel: (w) => CUSTOM.waterLevel(w),
  dynamiccolor: (w) => CUSTOM.dynamicColor(w),
  texturematrix: (w) => CUSTOM.textureMatrix(w),
  material: (w) => CUSTOM.material(w),
  physics: (w) => CUSTOM.physics(w),
  transform: (w) => CUSTOM.transform(w),
};

function readWorldStream(world, input, list) {
  let groupDef = world.world;
  let object = null;
  let newObject = null;
  const OPTIONS = { options: true };
  let gotWorld = false;
  while (input.good()) {
    if (newObject) {
      object = newObject;
      newObject = null;
    }
    const token = readToken(input);
    const t = lower(token);
    if (token === '' || token[0] === '#') {
      // blank or comment
    } else if (t === 'end') {
      if (object) {
        if (object !== OPTIONS) {
          if (object.toManager) object.toManager();
          else if (object.write) object.write(groupDef);
          else list.push(object);
        }
        object = null;
      } else {
        return false;
      }
    } else if (NORMAL_OBJECTS[t]) {
      newObject = NORMAL_OBJECTS[t](world);
    } else if (t === 'define') {
      if (groupDef === world.world) {
        const name = readToken(input);
        if (name) groupDef = { name, isWorld: false, lists: emptyLists(), groups: [] };
      }
    } else if (t === 'enddef') {
      if (groupDef !== world.world) {
        if (groupDef.name) world.groupDefs.push(groupDef);
        groupDef = world.world;
      }
    } else if (t === 'group') {
      newObject = CUSTOM.group(world, readToken(input));
    } else if (t === 'teleporter') {
      newObject = CUSTOM.teleporter(world, readToken(input));
    } else if (t === 'options') {
      newObject = OPTIONS;
    } else if (t === 'world') {
      if (!gotWorld) {
        newObject = CUSTOM.world(world);
        gotWorld = true;
      }
    } else if (object) {
      if (object !== OPTIONS) object.read(token, input);
    } else {
      // unknown object type, skipped
    }
    skipRestOfLine(input);
  }
  return object === null && groupDef === world.world;
}

// The `-set` lines of a map's options block, as bzfs reads them before the
// world (CmdLineOptions.cxx).
function optionVars(text) {
  const vars = new Map();
  let inOptions = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const word = lower(line.split(/\s+/)[0] || '');
    if (!inOptions) {
      if (word === 'options') inOptions = true;
      continue;
    }
    if (word === 'end') {
      inOptions = false;
      continue;
    }
    const args = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line))) args.push(m[1] !== undefined ? m[1] : m[2]);
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-set' && i + 2 < args.length) {
        vars.set(args[i + 1], args[i + 2]);
        i += 2;
      }
    }
  }
  return vars;
}

// glibc's qsort for an array of pointers is a top-down merge sort
// (msort.c), stable for a comparison that answers "equal".
function msort(list, cmp) {
  if (list.length <= 1) return list;
  const n1 = list.length >> 1;
  const a = msort(list.slice(0, n1), cmp);
  const b = msort(list.slice(n1), cmp);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (cmp(a[i], b[j]) <= 0) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}
// bzfs 2.4.26's `compareHeights` leaves equal heights in the order they
// were added, which `-cacheout` output shows (the outer walls come out in
// makeWalls' order).
const compareHeights = (a, b) => {
  const ha = a.extents.maxs[2];
  const hb = b.extents.maxs[2];
  if (ha > hb) return -1;
  return ha < hb ? 1 : 0;
};

// `compileBzwWorld(text, { bzdb })`: the world tree for a map, `bzdb` being
// the server's own variables (a Map of names to raw strings) under the map's.
function compileBzwWorld(text, { bzdb = null } = {}) {
  const vars = new Map(bzdb ? [...bzdb] : []);
  for (const [name, value] of optionVars(text)) vars.set(name, value);
  const world = new World(makeBzdb(vars));
  const input = new Stream(text);
  const list = [];
  if (!readWorldStream(world, input, list)) throw new Error('the world file failed to load');

  // makeWalls (bzfs.cxx:1061).
  if (!world.bzdb.isTrue('noWalls')) {
    const size = world.bzdb.eval('_worldSize');
    const h = world.bzdb.eval('_wallHeight');
    const half = f(0.5 * size);
    const wall = (x, y, r) => ({
      kind: 'wall', pos: [x, y, 0], angle: r, y: half, z: h, ricochet: false, extents: newExtents(),
    });
    world.world.lists.wall.push(
      wall(0, half, f(1.5 * Math.PI)),
      wall(half, 0, f(Math.PI)),
      wall(0, -half, f(0.5 * Math.PI)),
      wall(-half, 0, 0),
    );
  }

  makeWorld(world);

  for (const obj of list) obj.toWorld?.();

  // packDatabase's water material, made last so it does not move anyone's
  // indices.
  if (world.waterLevel >= 0 && world.waterMat === null) {
    world.textureMatrices.push({
      name: 'WaterMaterial', useStatic: false, useDynamic: true,
      rotation: 0, uFixedShift: 0, vFixedShift: 0, uFixedScale: 1, vFixedScale: 1, uFixedCenter: 0.5, vFixedCenter: 0.5,
      spinFreq: 0, uShiftFreq: f(0.05), vShiftFreq: 0, uScaleFreq: 0, vScaleFreq: 0, uScale: 1, vScale: 1, uCenter: 0.5, vCenter: 0.5,
    });
    const water = newMaterial();
    water.name = 'WaterMaterial';
    setTexture(water, 'water');
    lastTexture(water).matrix = world.textureMatrices.length - 1;
    water.diffuse = [f(0.65), 1, f(0.5), f(0.9)];
    lastTexture(water).useAlpha = true;
    lastTexture(water).useColor = false;
    lastTexture(water).useSphereMap = false;
    water.noRadar = true;
    water.noShadow = true;
    world.waterMat = world.addMaterial(water);
  }

  return toTree(world);
}

// ObstacleModifier's constructor (ObstacleModifier.cxx): what a group
// instance changes about what it places, combined with what the instances
// above it already change.
function combineModifier(outer, group) {
  const mod = {
    modifyColor: false, tint: [1, 1, 1, 1], modifyMaterial: false, material: null, matMap: new Map(),
  };
  if (group.modifyColor || outer.modifyColor) {
    mod.modifyColor = true;
    if (group.modifyColor && outer.modifyColor) mod.tint = group.tint.map((v, i) => f(v * outer.tint[i]));
    else mod.tint = [...(outer.modifyColor ? outer.tint : group.tint)];
  }
  if (outer.modifyMaterial) {
    mod.modifyMaterial = true;
    mod.material = outer.material;
  } else if (outer.matMap.size > 0) {
    if (group.modifyMaterial) {
      mod.modifyMaterial = true;
      mod.material = outer.matMap.has(group.material) ? outer.matMap.get(group.material) : group.material;
    } else {
      mod.matMap = new Map(outer.matMap);
      for (const [src, dst] of group.matMap) mod.matMap.set(src, outer.matMap.has(dst) ? outer.matMap.get(dst) : dst);
    }
  } else if (group.modifyMaterial) {
    mod.modifyMaterial = true;
    mod.material = group.material;
  } else if (group.matMap.size > 0) {
    mod.matMap = new Map(group.matMap);
  }
  return mod;
}

// ObstacleModifier::execute, the part that reaches the packed world: a tint
// makes a new material per face material it meets (getTintedMaterial).
function executeModifier(world, mod, mesh) {
  if (!(mod.modifyColor || mod.modifyMaterial || mod.matMap.size > 0)) return;
  for (const face of mesh.faces) {
    if (mod.modifyMaterial) face.material = mod.material;
    else if (mod.matMap.has(face.material)) face.material = mod.matMap.get(face.material);
    if (mod.modifyColor) {
      const tinted = copyMaterial(face.material || newMaterial());
      tinted.diffuse = tinted.diffuse.map((v, i) => f(v * mod.tint[i]));
      face.material = world.addMaterial(tinted);
    }
  }
}

// MeshObstacle::copyWithTransform: a group's mesh placed by its instance,
// each face re-checked under the new transform (copyFace).
function copyMesh(world, mesh, ops) {
  if (mesh.drawInfo && (mesh.faces.length <= 0 || (mesh.driveThrough && mesh.shootThrough))) {
    return makeMesh(world, ops, [], [], [], [], [], mesh);
  }
  const copy = makeMesh(world, ops, mesh.checks.map((c) => c.type), mesh.checks.map((c) => c.point),
    mesh.vertices, mesh.normals, mesh.texcoords, mesh);
  for (const face of mesh.faces) {
    addFace(copy, face.vertexIdx, face.normalIdx || [], face.texcoordIdx || [], face.material, face.phydrv, face, false);
  }
  finalizeMesh(copy);
  return copy;
}

// GroupDefinition::makeGroups: every instance placed, recursively. Nothing
// it places is packed, but a tint on the way makes materials that are.
// Containers (arc, cone, sphere, tetra) under a tint would need their meshes
// built as well; such a world is reported rather than guessed at.
function makeGroups(world, def, ops, mod, active) {
  if (active.has(def)) return;
  active.add(def);
  if (!def.isWorld) {
    for (const mesh of def.lists.mesh) {
      const copy = copyMesh(world, mesh, ops);
      if (meshValid(copy)) executeModifier(world, mod, copy);
    }
    if (mod.modifyColor || mod.modifyMaterial || mod.matMap.size > 0) {
      for (const type of ['arc', 'cone', 'sphere', 'tetra']) {
        if (def.lists[type].length > 0) world.unsupported.push(`${type} under a modified group instance`);
      }
    }
  }
  for (const group of def.groups) {
    const target = world.groupDefs.find((d) => d.name === group.groupdef);
    if (!target) continue;
    makeGroups(world, target, [...group.transformOps, ...ops], combineModifier(mod, group), active);
  }
  active.delete(def);
}

// GroupDefinitionMgr::makeWorld: the world's teleporters get their default
// names, instances are placed, invalid teleporters go, and every list is
// sorted top down.
function makeWorld(world) {
  const lists = world.world.lists;
  lists.tele.forEach((tele, i) => {
    if (!tele.name) tele.name = `/t${i}`;
  });
  makeGroups(world, world.world, [], combineModifier({
    modifyColor: false, tint: [1, 1, 1, 1], modifyMaterial: false, material: null, matMap: new Map(),
  }, { modifyColor: false, modifyMaterial: false, matMap: new Map() }), new Set());
  lists.tele = lists.tele.filter((tele) => tele.valid);
  for (const type of OBSTACLE_TYPES) lists[type] = msort(lists[type], compareHeights);
}

// ---------------------------------------------------------------------------
// The tree `packWorldBody` writes.
// ---------------------------------------------------------------------------

function toTree(world) {
  const index = (mat) => world.materialIndex(mat);
  const transform = (ops) => ({
    name: '',
    ops: ops.map((op) => (op.type === INDEX ? { type: INDEX, index: op.index } : {
      type: op.type, data: op.data, spin: op.type === SPIN ? op.spin : 0,
    })),
  });
  const obstacle = {
    wall: (o) => ({ pos: o.pos, angle: o.angle, y: o.y, z: o.z, ricochet: o.ricochet }),
    box: (o) => o,
    pyr: (o) => o,
    base: (o) => o,
    tele: (o) => o,
    mesh: (o) => ({
      checks: o.checks,
      vertices: o.vertices,
      normals: o.normals,
      texcoords: o.texcoords,
      faces: o.faces.map((face) => ({
        vertexIdx: face.vertexIdx,
        normalIdx: face.normalIdx,
        texcoordIdx: face.texcoordIdx,
        matindex: index(face.material),
        phydrv: face.phydrv,
        driveThrough: face.driveThrough,
        shootThrough: face.shootThrough,
        smoothBounce: face.smoothBounce,
        noclusters: face.noclusters,
        ricochet: face.ricochet,
      })),
      driveThrough: o.driveThrough,
      shootThrough: o.shootThrough,
      smoothBounce: o.smoothBounce,
      noclusters: o.noclusters,
      ricochet: o.ricochet,
      ...(o.drawInfo ? { drawInfoBlob: packDrawInfo(o.drawInfo, index) } : {}),
    }),
    arc: (o) => curvedTree(o),
    cone: (o) => curvedTree(o),
    sphere: (o) => curvedTree(o),
    tetra: (o) => ({
      transform: transform(o.transformOps),
      vertices: o.vertices,
      normals: o.normals,
      texcoords: o.texcoords,
      materials: o.materialRefs.map(index),
      driveThrough: o.driveThrough,
      shootThrough: o.shootThrough,
      ricochet: o.ricochet,
    }),
  };
  function curvedTree(o) {
    return {
      transform: transform(o.transformOps),
      pos: o.pos,
      size: o.size,
      angle: o.angle,
      sweepAngle: o.sweepAngle,
      ratio: o.ratio,
      divisions: o.divisions,
      phydrv: o.phydrv,
      texsize: o.texsize,
      materials: o.materialRefs.map(index),
      driveThrough: o.driveThrough,
      shootThrough: o.shootThrough,
      smoothBounce: o.smoothBounce,
      useNormals: o.useNormals,
      hemisphere: o.hemisphere,
      ricochet: o.ricochet,
    };
  }
  const groupDef = (def) => ({
    name: def.name,
    isWorld: def.isWorld,
    obstacles: Object.fromEntries(OBSTACLE_TYPES.map((type) => [type, def.lists[type]
      .filter((o) => !o.fromGroup).map((o) => obstacle[type](o))])),
    groupInstances: def.groups.map((g) => ({
      groupdef: g.groupdef,
      name: g.name,
      matMap: [...g.matMap].map(([src, dst]) => [index(src), index(dst)])
        .sort((a, b) => a[0] - b[0]),
      transform: transform(g.transformOps),
      modifyTeam: g.modifyTeam,
      modifyColor: g.modifyColor,
      modifyPhysicsDriver: g.modifyPhysicsDriver,
      modifyMaterial: g.modifyMaterial,
      driveThrough: g.driveThrough,
      shootThrough: g.shootThrough,
      ricochet: g.ricochet,
      team: g.team,
      tint: g.tint,
      phydrv: g.phydrv,
      material: index(g.material),
    })),
  });
  return {
    mapVersion: 1,
    // What this compiler cannot reproduce for this map, said rather than
    // guessed at; a caller with bzfs to hand uses it instead.
    unsupported: world.unsupported,
    managers: {
      dynamicColors: world.dynamicColors,
      textureMatrices: world.textureMatrices,
      materials: world.materials.map((m) => ({
        ...m,
        textures: m.textures,
        shaders: m.shaders.map((name) => ({ name })),
      })),
      physicsDrivers: world.physicsDrivers,
      meshTransforms: world.transforms.map((t) => ({ name: t.name, ops: transform(t.ops).ops })),
    },
    world: groupDef(world.world),
    groupDefs: world.groupDefs.map(groupDef),
    links: world.links,
    waterLevel: world.waterLevel,
    waterMaterial: world.waterLevel >= 0 ? index(world.waterMat) : -1,
    weapons: world.weapons,
    // EntryZones::pack: the qualifiers come out of a std::map, so in sorted
    // order, flags then teams then safeties.
    zones: world.zones.map((zone) => {
      const quals = [...zone.qualifiers].sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
      return {
        pos: zone.pos,
        size: zone.size,
        rot: zone.rotation,
        flags: quals.filter((q) => q[0] === 'f').map((q) => q.slice(1)),
        teams: quals.filter((q) => q[0] === 't').map((q) => Number(q.slice(1))),
        safety: quals.filter((q) => q[0] === '$').map((q) => Number(q.slice(1))),
      };
    }),
  };
}

module.exports = { compileBzwWorld };
