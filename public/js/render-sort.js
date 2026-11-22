/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// See-through draws sorted back to front by where each one is, not by where
// its whole object is. Three sorts a multi-material mesh's groups by the
// mesh's own centre, so a mesh holding a sign and its arch, or a tower and its
// glass, draws all its see-through parts at one depth, and a part nearer the
// eye can land behind another object's. Upstream gives a translucent face a
// scene node of its own and sorts it by its own place
// (`MeshSceneNodeGenerator.cxx:212`). A geometry group that carries a
// `center` (`_buildMeshObject`) is sorted by it here; anything else, and an
// instanced template, keeps Three's own depth.

import * as THREE from 'three';

const viewProjection = new THREE.Matrix4();
const point = new THREE.Vector3();
let frame = 0;

// Render items are pooled and handed out again every render, so a depth is
// kept only for the render it was worked out in.
function itemDepth(item) {
  // An instanced template's centre is its own, not any placement's.
  const center = item.group?.center;
  if (!center || item.object.isInstancedMesh) return item.z;
  if (item.sortFrame !== frame) {
    item.sortFrame = frame;
    point.set(center[0], center[1], center[2])
      .applyMatrix4(item.object.matrixWorld)
      .applyMatrix4(viewProjection);
    item.groupZ = point.z;
  }
  return item.groupZ;
}

// Three's `reversePainterSortStable`, with each item's own depth.
function transparentSort(a, b) {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  const za = itemDepth(a);
  const zb = itemDepth(b);
  if (za !== zb) return zb - za;
  return a.id - b.id;
}

// The scene's `onBeforeRender` runs with the camera the render uses, the
// headset's under WebXR, after its matrices are current and before the sort.
export function installTransparentSort(renderer, scene) {
  const previous = scene.onBeforeRender;
  scene.onBeforeRender = function onBeforeRender(r, s, camera, target) {
    frame += 1;
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    previous.call(this, r, s, camera, target);
  };
  renderer.setTransparentSort(transparentSort);
}
