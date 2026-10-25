/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The world viewer's summary of a whole world (docs/editor-plan.md), from the
// world JSON alone: what is in it, how many faces, which textures, and its
// largest meshes. What only the map file knows -- texture names that resolved
// to nothing -- the server adds (`/api/world/<hash>/summary`).

import { meshArrays } from './mesh-arrays.mjs';

const LARGEST_MESHES = 8;

// The textures one obstacle draws with, by stock name or URL.
export function obstacleTextures(obs) {
  const found = new Set();
  const add = (name, url) => {
    if (url) found.add(url);
    else if (name) found.add(name);
  };
  add(obs.wallTexture, obs.wallTextureUrl);
  add(obs.capTexture, obs.capTextureUrl);
  add(obs.texture, obs.textureUrl);
  for (const material of obs.arrays?.materials || []) {
    if (material) add(material.texture, material.textureUrl);
  }
  return [...found];
}

function faceCount(obs) {
  if (obs.arrays) return obs.arrays.faceCount;
  if (obs.faces) return meshArrays(obs).faceCount;
  return 0;
}

export function summarizeWorld(world) {
  const obstacles = world?.obstacles || [];
  const types = new Map();
  const textures = new Map();
  const meshes = [];
  let faces = 0;
  obstacles.forEach((obs, index) => {
    const type = obs.kind || obs.type;
    types.set(type, (types.get(type) || 0) + 1);
    for (const texture of obstacleTextures(obs)) textures.set(texture, (textures.get(texture) || 0) + 1);
    if (obs.type === 'mesh') {
      const count = faceCount(obs);
      faces += count;
      meshes.push({ index, name: obs.name, faces: count });
    }
  });
  meshes.sort((a, b) => b.faces - a.faces || a.index - b.index);
  return {
    mapSize: world?.mapSize ?? null,
    obstacles: obstacles.length,
    types: [...types].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))),
    meshFaces: faces,
    // Definitions drawn as one batch per placement (#153).
    instances: world?.meshInstances?.length || 0,
    templates: Object.keys(world?.meshTemplates || {}).length,
    teleporterLinks: world?.teleporterGraph?.links?.length || 0,
    zones: {
      flag: world?.flagZones?.length || 0,
      spawn: world?.spawnZones?.length || 0,
      safety: world?.safetyZones?.length || 0,
    },
    textures: [...textures].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    largestMeshes: meshes.slice(0, LARGEST_MESHES),
  };
}
