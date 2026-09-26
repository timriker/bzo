#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `MeshFace::finalize` (MeshFace.cxx:80-129) builds a face's plane from the
// vertex triple with the largest cross product, and a face whose best triple
// is degenerate has no plane to make: upstream logs "invalid mesh face" and
// sets `vertexCount` to 0, dropping the face and loading the world anyway.
// server.js's `faceMaxCrossSqr` is that test, and this holds it to the same
// answers -- including on the coordinates real bzfs actually complained about,
// so the case that motivated the check cannot silently stop being caught.

import fs from 'node:fs';

const src = fs.readFileSync('server.js', 'utf8');
const start = src.indexOf('function faceMaxCrossSqr');
if (start < 0) {
  console.error('FAIL server.js has no faceMaxCrossSqr');
  process.exit(1);
}
const body = src.slice(start, src.indexOf('\n  }\n', start) + 5);
const faceMaxCrossSqr = eval(`(${body.replace(/^function faceMaxCrossSqr/, 'function')})`);

// Upstream's own threshold, MeshFace.cxx:114.
const MIN_FACE_CROSS_SQR = 1.0e-20;
const V = (x, y, z) => ({ x, y, z });

const cases = [
  // The four side faces of a flush box, as bzfs printed them for bzo.bzw's
  // own death pad: two coincident vertex pairs, so no area in any triple.
  ['flush box south wall', [V(-138, -128, 0), V(-132, -128, 0), V(-132, -128, 0), V(-138, -128, 0)], [0, 1, 2, 3], false],
  ['flush box east wall', [V(-132, -128, 0), V(-132, -122, 0), V(-132, -122, 0), V(-132, -128, 0)], [0, 1, 2, 3], false],
  // The same box's top: a real 3x3, which upstream keeps and so must bzo.
  ['flush box top', [V(-138, -128, 0), V(-132, -128, 0), V(-132, -122, 0), V(-138, -122, 0)], [0, 1, 2, 3], true],
  ['collinear triangle', [V(0, 0, 0), V(1, 0, 0), V(2, 0, 0)], [0, 1, 2], false],
  ['duplicate vertices', [V(5, 0, 0), V(5, 0, 0), V(5, 0, 0)], [0, 1, 2], false],
  ['ordinary triangle', [V(0, 0, 0), V(5, 0, 0), V(0, 5, 0)], [0, 1, 2], true],
  // A face can be small and still real; the threshold is for degeneracy, not
  // for size, so a millimetre triangle has to survive it.
  ['tiny but real', [V(0, 0, 0), V(1e-3, 0, 0), V(0, 1e-3, 0)], [0, 1, 2], true],
  // A quad whose fourth corner is the only one off the line: upstream scans
  // every triple rather than the first, so this is valid.
  ['valid only in one triple', [V(0, 0, 0), V(1, 0, 0), V(2, 0, 0), V(0, 3, 0)], [0, 1, 2, 3], true],
];

let failures = 0;
for (const [label, vertices, indices, expectValid] of cases) {
  const valid = faceMaxCrossSqr(vertices, indices) >= MIN_FACE_CROSS_SQR;
  if (valid !== expectValid) {
    console.error(`FAIL ${label}: valid=${valid}, expected ${expectValid}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`test-mesh-face-area: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`test-mesh-face-area: ${cases.length} cases pass`);
