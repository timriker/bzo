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

function loadTexture(path) {
  let entry = sharedTextures.get(path);
  if (!entry) {
    entry = { texture: null, pending: [] };
    entry.texture = configureTexture(textureLoader.load(path, () => resolveSharedTexture(entry)));
    sharedTextures.set(path, entry);
  }
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
