/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `public/js/map-banners.mjs` against TimeTrial, whose flag poles carry a
// banner on each and whose winner's circle wears the same texture flat on the
// ground: the banner is found, hung from the pole, and the circle is not.
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { meshDrawArrays } from '../public/js/mesh-arrays.mjs';
import { findMeshBanners } from '../public/js/map-banners.mjs';

const require = createRequire(import.meta.url);
const { parseBZWMap } = require('../server/bzw-parse.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const expect = (ok, message) => { if (!ok) failures.push(message); };
const near = (a, b) => Math.abs(a - b) < 1e-3;

const map = parseBZWMap(path.join(root, 'maps', 'TimeTrial.bzw'), { quiet: true });

const found = [];
for (const [name, meshes] of Object.entries(map.meshTemplates || {})) {
  for (const mesh of meshes) {
    const result = findMeshBanners(meshDrawArrays(mesh));
    if (result.banners.length) found.push({ name, ...result });
  }
}
for (const mesh of map.meshes || []) {
  if (mesh.drawnByInstance) continue;
  const result = findMeshBanners(meshDrawArrays(mesh));
  if (result.banners.length) found.push({ name: mesh.name, ...result });
}

expect(found.length === 1 && found[0].name === 'flag', `banners in ${found.map((f) => f.name).join(', ') || 'nothing'}, not the flag define alone`);
const flag = found[0];
if (flag) {
  const [banner] = flag.banners;
  expect(flag.banners.length === 1, `${flag.banners.length} banners on one pole`);
  // The box's two broad faces and its four thin edges.
  expect(flag.dropFaces.size === 6, `${flag.dropFaces.size} faces dropped, not 6`);
  expect(near(banner.hinge.x, 0) && near(banner.hinge.z, 3.25), `hinge at ${JSON.stringify(banner.hinge)}, not the pole`);
  expect(near(banner.free.x, 2) && near(banner.free.z, 3.25), `free edge at ${JSON.stringify(banner.free)}`);
  expect(near(banner.top.x, 0) && near(banner.top.z, 4.75), `top at ${JSON.stringify(banner.top)}`);
  expect(banner.material.textureMatrix?.name === 'FlagBanner1', `front face wears ${banner.material.textureMatrix?.name}`);
  expect(near(banner.uvs.free[0], 0.25) && near(banner.uvs.top[1], 0.1875), `uvs ${JSON.stringify(banner.uvs)}`);
}

if (failures.length) {
  console.error(`map-banners: ${failures.length} failure(s)`);
  failures.forEach((failure) => console.error(`  ${failure}`));
  process.exit(1);
}
console.log('map-banners: TimeTrial banner found and hung from its pole; the winner\'s circle left alone');
