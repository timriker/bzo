/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import * as THREE from 'three';

const textureLoader = new THREE.TextureLoader();

// How far a base is tinted towards its team's colour. The rest stays white, so
// a red base reads as a light red rather than as the tank colour laid flat.
const BASE_TINT_STRENGTH = 0.6;

// One Texture per source image, handed out as clones. A clone shares its
// Source with the original, so the image is fetched, decoded and uploaded to
// the GPU once however many faces sample it, while each clone still carries
// its own repeat, offset and rotation -- none of which Three counts when it
// decides two textures can share an upload. It refcounts that shared upload,
// so disposing one clone leaves the rest drawing.
//
// This matters at map scale: a `hix.bzw` box spends six materials on two
// images, and the map has 58 of them. Without the sharing that is ~350
// separate uploads of the same two pictures.
const sharedTextures = new Map();
const sharedTintedTextures = new Map();

function configureTexture(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// `Texture.copy()` flags every clone for update, which is what a clone of a
// loaded image wants: its own version counter starts behind the upload it
// shares. A clone taken before the image arrives has nothing to upload yet,
// though, and Three warns once a frame for each one until it does -- so put
// that one back to unflagged and flag it when the pixels actually land. It
// draws the same empty texture in the meantime that it did unshared.
function cloneSharedTexture(entry) {
  const texture = entry.texture.clone();
  if (!entry.texture.image) {
    texture.version = 0;
    entry.pending.push(texture);
  }
  return texture;
}

function resolveSharedTexture(entry) {
  entry.pending.forEach((texture) => {
    texture.needsUpdate = true;
  });
  entry.pending.length = 0;
}

// Whether any pixel in a decoded image is not fully opaque -- the same scan
// upstream's own `OpenGLTexture::getBestFormat` runs (`OpenGLTexture.cxx:
// 336-351`: `alpha = true` the instant one byte is not `0xff`), which is what
// upstream's own material rendering (`MeshSceneNode::updateMaterial`) reads
// as `imageInfo.alpha` to decide whether a face needs blending at all. A
// texture with an alpha channel that never actually varies (checked directly
// against real map textures -- some ship one anyway, an export artifact) is
// not blend-worthy by this same upstream rule, and shouldn't cost every
// other opaque texture the sorting/blending overhead transparency asks for.
function detectImageAlpha(image) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) return true;
    }
    return false;
  } catch {
    // A cross-origin image reaching here without a clean CORS response
    // would taint the canvas and throw -- shouldn't happen, since WebGL's
    // own upload already demands the same CORS response this read does, but
    // if it ever does, treat the texture as opaque rather than crash a
    // render loop over a picture that already displays fine on the GPU.
    return false;
  }
}

// Fires once a texture's `hasAlpha` is known (the moment its image decodes),
// immediately if it already is. Any later caller sharing the same texture --
// `resolveObstacleTextureFactory`'s callers, one per face group naming the
// same picture -- gets the same answer without re-scanning pixels twice.
function resolveTextureAlpha(entry) {
  if (entry.hasAlpha !== null || !entry.texture?.image) return;
  entry.hasAlpha = detectImageAlpha(entry.texture.image);
  const callbacks = entry.alphaCallbacks;
  entry.alphaCallbacks = [];
  callbacks.forEach((onAlpha) => onAlpha(entry.hasAlpha));
}

function registerAlphaCallback(entry, onAlpha) {
  if (!onAlpha) return;
  if (entry.hasAlpha !== null) {
    // Deferred even though the answer is already known: a caller building a
    // material from this same call stack (`_getSharedObstacleMaterials`)
    // hasn't necessarily finished assigning it to a variable this callback
    // closes over yet -- a same-tick call would run into that variable's own
    // temporal dead zone. A microtask runs after the current synchronous
    // call chain returns, same as the genuinely-async case below always was.
    queueMicrotask(() => onAlpha(entry.hasAlpha));
  } else {
    entry.alphaCallbacks.push(onAlpha);
  }
}

function loadTexture(path, onAlpha) {
  let entry = sharedTextures.get(path);
  if (!entry) {
    entry = {
      texture: null, pending: [], hasAlpha: null, alphaCallbacks: [],
    };
    entry.texture = configureTexture(textureLoader.load(path, () => {
      resolveSharedTexture(entry);
      resolveTextureAlpha(entry);
    }));
    sharedTextures.set(path, entry);
  }
  registerAlphaCallback(entry, onAlpha);
  return cloneSharedTexture(entry);
}

export function createBoundaryTexture() {
  return loadTexture('/textures/wall.png');
}

export function createBoxWallTexture() {
  return loadTexture('/textures/boxwall.png');
}

export function createRoofTexture() {
  return loadTexture('/textures/roof.png');
}

export function createPyramidTexture() {
  return loadTexture('/textures/pyrwall.png');
}

export function createTeleporterBorderTexture() {
  return loadTexture('/textures/caution.png');
}

export function createTeleporterPortalTexture() {
  return loadTexture('/textures/telelink.png');
}

// Upstream's own stock texture names, resolved against bzo's local asset for
// each -- `material`/`matref`/`addtexture` naming one of these paints an
// obstacle with the same picture bzo already ships for it (see "Materials
// and appearance" in docs/bzw.md). Every name upstream's own `data/` ships a
// picture for is here, not just the common wall/roof/pyramid handful, since
// there is no predicting which one a map maker's `material` block reaches
// for -- see `BZW_STOCK_TEXTURES`'s own comment in server.js, which this list
// has to agree with: that is what turns away, at parse time, any name not
// one of these, or an external URL a map links a texture in from -- so a
// name reaching here always resolves.
const STOCK_MATERIAL_TEXTURE_FILES = new Map([
  ['automatic_icon', 'automatic_icon.png'],
  ['blend_flash', 'blend_flash.png'],
  ['blue_basetop', 'blue_basetop.png'],
  ['blue_basewall', 'blue_basewall.png'],
  ['blue_bolt', 'blue_bolt.png'],
  ['blue_icon', 'blue_icon.png'],
  ['blue_laser', 'blue_laser.png'],
  ['blue_super_bolt', 'blue_super_bolt.png'],
  ['blue_tank', 'blue_tank.png'],
  ['boxwall', 'boxwall.png'],
  ['bubble', 'bubble.png'],
  ['bzflag-256x256', 'bzflag-256x256.png'],
  ['bzflag-48x48', 'bzflag-48x48.png'],
  ['caution', 'caution.png'],
  ['clouds', 'clouds.png'],
  ['dusty_flare', 'dusty_flare.png'],
  ['explode1', 'explode1.png'],
  ['explode2', 'explode2.png'],
  ['flag', 'flag.png'],
  ['frog', 'frog.png'],
  ['green_basetop', 'green_basetop.png'],
  ['green_basewall', 'green_basewall.png'],
  ['green_bolt', 'green_bolt.png'],
  ['green_icon', 'green_icon.png'],
  ['green_laser', 'green_laser.png'],
  ['green_super_bolt', 'green_super_bolt.png'],
  ['green_tank', 'green_tank.png'],
  ['hunter_bolt', 'hunter_bolt.png'],
  ['hunter_laser', 'hunter_laser.png'],
  ['hunter_super_bolt', 'hunter_super_bolt.png'],
  ['hunter_tank', 'hunter_tank.png'],
  ['jumpjets', 'jumpjets.png'],
  ['menu_arrow', 'menu_arrow.png'],
  ['mesh', 'mesh.png'],
  ['missile', 'missile.png'],
  ['moon', 'moon.png'],
  ['mountain1', 'mountain1.png'],
  ['mountain2', 'mountain2.png'],
  ['mountain3', 'mountain3.png'],
  ['mountain4', 'mountain4.png'],
  ['mountain5', 'mountain5.png'],
  ['observer_icon', 'observer_icon.png'],
  ['puddle', 'puddle.png'],
  ['puffs', 'puffs.png'],
  ['purple_basetop', 'purple_basetop.png'],
  ['purple_basewall', 'purple_basewall.png'],
  ['purple_bolt', 'purple_bolt.png'],
  ['purple_icon', 'purple_icon.png'],
  ['purple_laser', 'purple_laser.png'],
  ['purple_super_bolt', 'purple_super_bolt.png'],
  ['purple_tank', 'purple_tank.png'],
  ['pyrwall', 'pyrwall.png'],
  ['rabbit_bolt', 'rabbit_bolt.png'],
  ['rabbit_laser', 'rabbit_laser.png'],
  ['rabbit_super_bolt', 'rabbit_super_bolt.png'],
  ['rabbit_tank', 'rabbit_tank.png'],
  ['radar', 'radar.png'],
  ['raindrop', 'raindrop.png'],
  ['red_basetop', 'red_basetop.png'],
  ['red_basewall', 'red_basewall.png'],
  ['red_bolt', 'red_bolt.png'],
  ['red_icon', 'red_icon.png'],
  ['red_laser', 'red_laser.png'],
  ['red_super_bolt', 'red_super_bolt.png'],
  ['red_tank', 'red_tank.png'],
  ['rogue_bolt', 'rogue_bolt.png'],
  ['rogue_icon', 'rogue_icon.png'],
  ['rogue_laser', 'rogue_laser.png'],
  ['rogue_super_bolt', 'rogue_super_bolt.png'],
  ['rogue_tank', 'rogue_tank.png'],
  ['roof', 'roof.png'],
  ['shot_tail', 'shot_tail.png'],
  ['snowflake', 'snowflake.png'],
  ['std_ground', 'std_ground.png'],
  ['telelink', 'telelink.png'],
  ['tetrawall', 'tetrawall.png'],
  ['thief', 'thief.png'],
  ['title', 'title.png'],
  ['treads', 'treads.png'],
  ['wall', 'wall.png'],
  ['water', 'water.png'],
  ['zone_ground', 'zone_ground.png'],
]);

export function createStockMaterialTexture(name, onAlpha) {
  const file = STOCK_MATERIAL_TEXTURE_FILES.get(name);
  return file ? loadTexture(`/textures/${file}`, onAlpha) : null;
}

// A material's own texture may name an absolute URL instead of a stock name
// (`server.js`'s `resolveBzwTextureName` sends either one through as
// `wallTextureUrl`/`capTextureUrl`, never both). bzo never fetches one
// server-side -- see the note there -- so this, in the browser, is the one
// place that decides whether a map-named URL is even worth attempting to
// load.
//
// Deliberately not an allowlist. Upstream trusts one host by default
// (`DownloadAccess.txt`'s shipped `allow *images.bzflag.org` / `deny *`,
// `Downloads.cxx:37-59`) and leaves widening that to the *player's* own
// local config file -- a real per-viewer decision upstream's own client
// supports. bzo has nothing equivalent (a browser has no such file, and
// there is no server-side equivalent to put one in either), and the party
// who picked the host -- whoever ran the source server this map was
// imported from, or hand-wrote the `.bzw` -- has no channel to tell bzo
// "trust this one too": the only lever bzo had was to guess a fixed
// allowlist on their behalf, which is exactly backwards. Any host is
// attempted now; a mapper or an operator who wants a picture blocked can
// already do that on their own end (ad blockers, `NoScript`-style
// extensions, a browser's own site permissions), same as with any other
// third-party image on the web. This is a deliberate deviation from
// upstream -- see "Intentional deviations from BZFlag" in `AGENTS.md`.
export function isExternalTextureUrlLoadable(url) {
  let parsed;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

const sharedExternalTextures = new Map();

// `fallbackPath` is what this obstacle's own type would have drawn with no
// material override at all (`/textures/boxwall.png`, `/textures/pyrwall.png`,
// ...) -- used both for a malformed URL/scheme, which is never even
// requested, and for a well-formed one whose request still fails: a
// `crossOrigin`-tagged image load is not "tainted, but shown" the way an
// ordinary cross-origin `<img>` is, it is refused outright (`onerror`, not
// `onload`) the instant the response carries no matching
// `Access-Control-Allow-Origin` -- which, with every host now attempted,
// is a real outcome for a picture hosted somewhere that never expected a
// cross-origin `<canvas>` to read its pixels back, not only a hypothetical
// one.
export function loadExternalTexture(url, fallbackPath, onAlpha) {
  if (!isExternalTextureUrlLoadable(url)) return loadTexture(fallbackPath, onAlpha);

  let entry = sharedExternalTextures.get(url);
  if (!entry) {
    entry = {
      texture: null, pending: [], hasAlpha: null, alphaCallbacks: [],
    };
    entry.texture = configureTexture(textureLoader.load(
      url,
      () => {
        resolveSharedTexture(entry);
        resolveTextureAlpha(entry);
      },
      undefined,
      () => {
        console.warn(`External texture blocked or failed to load, using this obstacle's plain default instead: ${url}`);
        // Every clone already handed out for this URL still points at
        // `entry.texture`'s ORIGINAL `Source` object -- `clone()`/`copy()`
        // only copies the reference at the moment it runs (Texture.js's
        // `copy()`: `this.source = source.source`), so reassigning
        // `entry.texture.source` itself here would only ever reach a clone
        // made *after* this line, not the ones already sitting in a mesh's
        // material. Setting `.image` instead mutates that same original
        // Source's `.data` in place (the `image` setter is just
        // `this.source.data = value`), which every existing clone reads
        // live through the Source object they already share.
        entry.texture.image = loadTexture(fallbackPath).image;
        resolveSharedTexture(entry);
        resolveTextureAlpha(entry);
      },
    ));
    sharedExternalTextures.set(url, entry);
  }
  registerAlphaCallback(entry, onAlpha);
  return cloneSharedTexture(entry);
}

function paintTintedTexture(path, tint, onReady) {
  const texture = configureTexture(new THREE.Texture());

  textureLoader.load(path, (loadedTexture) => {
    const image = loadedTexture?.image;
    if (!image) {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) {
      texture.image = image;
      texture.needsUpdate = true;
      onReady();
      return;
    }

    context.drawImage(image, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    const tr = Math.max(0, tint[0] ?? 1);
    const tg = Math.max(0, tint[1] ?? 1);
    const tb = Math.max(0, tint[2] ?? 1);

    for (let i = 0; i < pixels.length; i += 4) {
      const sr = pixels[i];
      const sg = pixels[i + 1];
      const sb = pixels[i + 2];
      const luminance = (0.2126 * sr) + (0.7152 * sg) + (0.0722 * sb);

      pixels[i] = Math.max(0, Math.min(255, Math.round(luminance * tr)));
      pixels[i + 1] = Math.max(0, Math.min(255, Math.round(luminance * tg)));
      pixels[i + 2] = Math.max(0, Math.min(255, Math.round(luminance * tb)));
    }

    context.putImageData(imageData, 0, 0);
    texture.image = canvas;
    texture.needsUpdate = true;
    onReady();
  });

  return texture;
}

// The tint runs over every pixel on the CPU, so a base's six faces are six
// passes over the same picture for the same team. One per team and image is
// enough; the faces differ only in the repeat they set on their own clone.
function loadTintedTexture(path, tint) {
  const key = `${path}|${tint.join(',')}`;
  let entry = sharedTintedTextures.get(key);
  if (!entry) {
    entry = { texture: null, pending: [] };
    entry.texture = paintTintedTexture(path, tint, () => resolveSharedTexture(entry));
    sharedTintedTextures.set(key, entry);
  }
  return cloneSharedTexture(entry);
}

// The multiplier a base's team puts on its texture, taken from the team's own
// colour rather than from a table of its own. Every team bzo ever adds arrives
// with a colour, so every team can hold a base without anything here changing.
export function getBaseTeamTint(teamColor) {
  const channel = (shift) => ((teamColor >> shift) & 0xff) / 0xff;
  const tint = (value) => (1 - BASE_TINT_STRENGTH) + (BASE_TINT_STRENGTH * value);
  return [tint(channel(16)), tint(channel(8)), tint(channel(0))];
}

// Untinted, and shared by every base on the map whatever team holds it: the
// team's colour rides on the vertices instead, which is what lets the bases
// merge into one mesh. Loaded through the tinting path at full white, which is
// what reduces the picture to the luminance the tint is applied to.
export function createBaseTopTexture() {
  return loadTintedTexture('/textures/base_top.png', [1, 1, 1]);
}

export function createBaseWallTexture() {
  return loadTintedTexture('/textures/base_wall.png', [1, 1, 1]);
}

export function createGroundTexture() {
  return loadTexture('/textures/std_ground.png');
}

// `zoneGroundTexture` (defaultBZDB.cxx:149). What a Phantom Zone tank sees the
// ground as while it is zoned: BackgroundRenderer keeps a second set of ground
// gstates and colours and swaps to them on `setInvert` (BackgroundRenderer.cxx:330),
// which is upstream's whole "zoned" screen effect -- not a colour inversion of
// the view, despite the name, but a different ground under a purple sky-clear.
export function createZoneGroundTexture() {
  return loadTexture('/textures/zone_ground.png');
}
