/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Lights and shadows: the dynamic light pool, projected shadows, and the
// light shots and effects throw on the ground.
// RenderManager's own methods, kept here and installed on its prototype by
// render.js: `this` is the RenderManager.

import { supportsDynamicLighting, supportsProjectedShadows } from './capabilities.mjs';
import * as THREE from 'three';
import { BZFLAG_LIGHT_ATTENUATION } from './render.js';

const PROJECTED_SHADOW_MIN_LIGHT_Z = 0.05;

const PROJECTED_SHADOW_STENCIL_REF = 1;
// Write the stencil before the darkening overlay pass reads it.
const PROJECTED_SHADOW_RENDER_ORDER = 10;
const PROJECTED_SHADOW_DARKEN_OPACITY = 0.35;
const PROJECTED_SHADOW_CASTER_Z = 0.01;
// Height above the tallest obstacle that a shadow caster can still reach, for
// airborne tanks. Sizes the darkening pass, not the shadows themselves.
const PROJECTED_SHADOW_CASTER_HEADROOM = 20;
const PROJECTED_SHADOW_OVERLAY_Z = 0.03;

// Ground light receivers, mirroring BackgroundRenderer::drawGroundReceivers
// (BackgroundRenderer.cxx:1312): a small additive fan on the ground under every
// dynamic light, its falloff computed per vertex on the CPU rather than by a
// shader. Upstream draws these alongside the real lights, not instead of them,
// so bzo does too -- both are derived from the same attenuation below, which is
// what keeps the pair in the same proportion here as upstream has it. The fan
// reaches 19.2 units and the light itself carries further.
const GROUND_RECEIVER_RINGS = 4;              // receiverRings
const GROUND_RECEIVER_SLICES = 8;             // receiverSlices
const GROUND_RECEIVER_RING_SIZE = 1.2;        // receiverRingSize, in meters
const GROUND_RECEIVER_MIN_LUMINANCE = 0.02;   // draw(): (I * maxVal) < 0.02f
const GROUND_RECEIVER_SUN_DIMMING = 0.6;      // draw(): B = 1 - 0.6 * sunBrightness
// Above the shadow darkening pass, so a shot lights ground it has just darkened.
const GROUND_RECEIVER_Z = 0.04;
const GROUND_RECEIVER_RENDER_ORDER = 21;

// maxDist, the radius upstream culls a light at (OpenGLLight.cxx:40). Its own
// cutoff equation puts one of these lights at 2% around 41 units, so nothing
// worth seeing is lost by stopping there. Three's cutoff eases the last stretch
// to zero rather than clipping it.
const BZFLAG_LIGHT_MAX_DISTANCE = 50;
const BZFLAG_LIGHT_DECAY = 2;
// SceneRenderer.cxx:1275. Upstream ranks the lights it has been offered and
// keeps the first `maxLights` of them -- GL_MAX_LIGHTS less the one reserved
// for the sun or the moon, so seven of them.
//
// bzo needs the cap for a second reason upstream does not have. Three keys its
// shader program cache on how many lights are in the scene, so a light arriving
// or leaving recompiles every material in the world: a firefight took a Quest 2
// from 16 programs to 66 in two minutes, eleven of them inside one second, and
// each compile is a stall on that driver. A pool of a fixed size, always in the
// scene and dimmed to nothing when idle, is a count that never moves.
const BZFLAG_MAX_DYNAMIC_LIGHTS = 7;
const DYNAMIC_LIGHT_EYE = new THREE.Vector3();

const DYNAMIC_LIGHT_FORWARD = new THREE.Vector3();
const DYNAMIC_LIGHT_OFFSET = new THREE.Vector3();
const DYNAMIC_LIGHT_QUATERNION = new THREE.Quaternion();

export class LightingRendering {
  _initDynamicLights() {
    if (!this.scene) return;
    // Ambient, sun, and moon light will be updated dynamically
    this.ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    this.worldFrame.add(this.ambientLight);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.sunLight.castShadow = false;
    this.worldFrame.add(this.sunLight);
    this.moonLight = new THREE.DirectionalLight(0xffffff, 0.0);
    this.moonLight.castShadow = false;
    this.worldFrame.add(this.moonLight);
  }

  canUseDynamicLighting() {
    return supportsDynamicLighting(this.renderCapabilities);
  }

  // The lights the scene is actually given. They are built once and never
  // hidden and never removed, because Three does not count a light it cannot
  // see -- hiding one costs the same recompile as deleting it, and a light
  // dimmed to nothing costs a uniform and changes no program.
  _getDynamicLightPool() {
    if (!this._dynamicLightingActive() || !this.worldGroup) {
      if (this._dynamicLightPool) {
        this._dynamicLightPool.forEach((light) => light.removeFromParent());
        this._dynamicLightPool = null;
      }
      return null;
    }
    if (this._dynamicLightPool) return this._dynamicLightPool;

    this._dynamicLightPool = [];
    for (let slot = 0; slot < BZFLAG_MAX_DYNAMIC_LIGHTS; slot += 1) {
      const light = new THREE.PointLight(0xffffff, 0, BZFLAG_LIGHT_MAX_DISTANCE, BZFLAG_LIGHT_DECAY);
      this.worldFrame.add(light);
      this._dynamicLightPool.push(light);
    }
    return this._dynamicLightPool;
  }

  // What a shot, an explosion or a jet asks for: somewhere to be, a colour and
  // a brightness. Not a light in the scene, because how many lights are in the
  // scene is the one thing that has to stay still.
  _createDynamicLight(color, intensity) {
    return {
      position: new THREE.Vector3(),
      color: new THREE.Color(color),
      intensity,
      visible: true,
      importance: 0,
    };
  }

  // Hand the pool to whichever effects matter most, once a frame.
  //
  // `OpenGLLight::calculateImportance`: a light further away than its own reach
  // is dropped outright, and what survives is ranked by how near the eye it is.
  // Upstream sorts every time; bzo sorts only when there are more candidates
  // than slots, which in an ordinary frame there are not.
  _applyDynamicLightPool() {
    const pool = this._getDynamicLightPool();
    if (!this._activeJumpJetLights) this._activeJumpJetLights = [];
    if (!pool) {
      this._activeJumpJetLights.length = 0;
      return;
    }

    // The eye and where it looks, in the game's frame, where the lights are:
    // the world groups carry the player's heading in a session, so the
    // camera's own world position is in a different frame from the lights'.
    this.worldFrame.updateWorldMatrix(true, false);
    const inverse = DYNAMIC_LIGHT_QUATERNION.setFromRotationMatrix(this.worldFrame.matrixWorld).invert();
    const eye = DYNAMIC_LIGHT_EYE;
    this.worldFrame.worldToLocal(this.camera.getWorldPosition(eye));
    const forward = DYNAMIC_LIGHT_FORWARD;
    this.camera.getWorldDirection(forward).applyQuaternion(inverse);

    if (!this._dynamicLightCandidates) this._dynamicLightCandidates = [];
    const candidates = this._dynamicLightCandidates;
    candidates.length = 0;
    const offset = DYNAMIC_LIGHT_OFFSET;
    this._forEachDynamicLight((light) => {
      if (light.visible === false || !(light.intensity > 0)) return;
      const distance = offset.copy(light.position).sub(eye).length();
      // `OpenGLLight::calculateImportance` drops a light for being far away
      // only when it is *behind* the viewer: `sphereCull` is cleared the moment
      // the light is in front of the front plane, and the distance test below
      // it never runs. A light in front is only ever ranked by distance, never
      // disqualified by it -- a shot lighting the ground a hundred units ahead
      // is a shot the player can see lighting the ground.
      //
      // Upstream also drops a light that has fallen outside a frustum side by
      // more than its own reach. That test is not here: it needs the frustum
      // planes, a session has two of them rather than one, and with seven slots
      // and a handful of shots a light off to the side costs a slot rather than
      // a wrong picture.
      if (distance > BZFLAG_LIGHT_MAX_DISTANCE && offset.dot(forward) <= 0) return;
      light.importance = distance > 0 ? 1 / distance : Infinity;
      candidates.push(light);
    });
    if (candidates.length > pool.length) {
      candidates.sort((a, b) => b.importance - a.importance);
    }

    for (let slot = 0; slot < pool.length; slot += 1) {
      const light = pool[slot];
      const source = candidates[slot];
      if (!source) {
        light.intensity = 0;
        continue;
      }
      light.position.copy(source.position);
      light.color.copy(source.color);
      light.intensity = source.intensity;
    }
    // Gathered afresh every frame from the tanks that are actually jetting, so
    // a tank that left the world leaves nothing behind here.
    this._activeJumpJetLights.length = 0;
  }

  // Capability and switch kept apart, as `_dynamicLightingActive` does: the
  // stencil bits say what the machine can do, the knob says what this run is
  // measuring.
  _projectedShadowsActive() {
    return this.projectedShadowsEnabled && this._worldDraws('shadows') && this.canUseProjectedShadows();
  }

  // The world's own scene switches -- `_drawMountains`, `_drawClouds`,
  // `_drawCelestial`, `_drawGround` and `_noShadows` -- which a server locks
  // and every client obeys. They take away; the viewer's own settings can take
  // away more.
  setSceneSwitches(config = null) {
    this._sceneSwitches = {
      mountains: config?.DRAW_MOUNTAINS !== false,
      clouds: config?.DRAW_CLOUDS !== false,
      celestial: config?.DRAW_CELESTIAL !== false,
      ground: config?.DRAW_GROUND !== false,
      shadows: config?.NO_SHADOWS !== true,
      // `_drawSky`: off, upstream's `renderSky` returns before drawing
      // anything -- the colours, the sun, the moon and the stars alike.
      sky: config?.DRAW_SKY !== false,
      // `_fogNoSky`: on, the sky is drawn with the fog off
      // (SceneRenderer.cxx:950); off, upstream's default, fog covers it too.
      skyFog: config?.FOG_NO_SKY !== true,
      // `_drawGroundLights`: the pools of light under shots and flags.
      groundLights: config?.DRAW_GROUND_LIGHTS !== false,
    };
    this._applySkyFog();
    this._celestialState = null;
  }

  // Fog over the sky parts, as `_fogNoSky` says. A material's fog flag changes
  // its program, so it is set only when the answer does.
  _applySkyFog() {
    const fog = this._worldDraws('skyFog');
    const materials = [this._skyPyramid?.material, this._starField?.material, this._phasedMoon?.material,
      this.sunMesh?.material, this.sunGlowMesh?.material, this.moonMesh?.material];
    for (const material of materials) {
      if (!material || material.fog === fog) continue;
      material.fog = fog;
      material.needsUpdate = true;
    }
  }

  _worldDraws(part) {
    return this._sceneSwitches?.[part] !== false;
  }

  canUseProjectedShadows() {
    return supportsProjectedShadows(this.renderCapabilities);
  }

  _dynamicLightingActive() {
    return this.dynamicLightingEnabled && this.canUseDynamicLighting();
  }

  // --- Projected Planar Shadows (Stencil-style) ---
  // Build each shadow in the game's frame so XR can move the whole world
  // without applying the camera transform to the shadow twice.
  _getProjectedShadowDirection(lightDirection) {
    if (!lightDirection) return null;

    const dir = lightDirection.clone();
    const lengthSq = dir.lengthSq();
    if (!Number.isFinite(lengthSq) || lengthSq < Number.EPSILON) return null;

    dir.normalize();
    // A light at or below the horizon would produce an unbounded or inverted
    // projection. Keep the last valid shadow until the light rises again.
    if (!Number.isFinite(dir.z) || dir.z <= PROJECTED_SHADOW_MIN_LIGHT_Z) return null;
    return dir;
  }

  // Upstream does not move any vertices to project a shadow: drawGroundShadows
  // (BackgroundRenderer.cxx:1227) builds a degenerate matrix, multiplies it in,
  // and redraws the same geometry. This is that matrix, taking (x, y, z) to
  // (x - z*dx/dz, y - z*dy/dz, casterZ).
  _setProjectedShadowFlattenMatrix(matrix, dir) {
    const slopeX = dir.x / dir.z;
    const slopeY = dir.y / dir.z;
    return matrix.set(
      1, 0, -slopeX, 0,
      0, 1, -slopeY, 0,
      0, 0, 0, PROJECTED_SHADOW_CASTER_Z,
      0, 0, 0, 1,
    );
  }

  // One material for every shadow: they differ only in where they land, and a
  // shared material is a shared program and one piece of GL state to set.
  _getProjectedShadowMaterial() {
    if (!this._projectedShadowMaterial) {
      const material = new THREE.MeshBasicMaterial({
        color: 0x000000,
        depthWrite: false,
        depthTest: false,
        colorWrite: false,
        transparent: false,
      });
      material.stencilWrite = true;
      material.stencilRef = PROJECTED_SHADOW_STENCIL_REF;
      material.stencilFunc = THREE.AlwaysStencilFunc;
      material.stencilFail = THREE.KeepStencilOp;
      material.stencilZFail = THREE.KeepStencilOp;
      material.stencilZPass = THREE.ReplaceStencilOp;
      this._projectedShadowMaterial = material;
    }
    return this._projectedShadowMaterial;
  }

  // The shadow shares its caster's geometry -- it is the same shape, drawn flat
  // -- so it owns no vertices, no buffer, and nothing that can fall out of step
  // with the caster. Neither the geometry nor the material is this mesh's to
  // dispose; _removeProjectedShadowMesh is the only way it goes away.
  _ensureProjectedShadowMesh(mesh) {
    const existing = mesh.userData.shadowMesh;
    if (existing) {
      if (existing.geometry === mesh.geometry
        && !!existing.isInstancedMesh === !!mesh.isInstancedMesh) return existing;
      this._removeProjectedShadowMesh(mesh);
    }

    // An `InstancedMesh` caster casts an instanced shadow. Its own
    // `matrixWorld` is the identity the batch sits at -- every placement is in
    // `instanceMatrix` -- so a plain `THREE.Mesh` over the same geometry lays
    // the whole template down once at the world origin: one large shadow in
    // the middle of the map, and none under the objects that cast it.
    //
    // The buffer is shared rather than copied. `setMeshInstances` fills it
    // once and never replaces it, and the shader's
    // `matrixWorld * instanceMatrix * position` composes with the flattening
    // matrix exactly as a plain caster's `matrixWorld` does, since that
    // product is associative either way.
    const shadowMaterial = this._shadowMaterialFor(mesh);
    const shadowMesh = mesh.isInstancedMesh
      ? new THREE.InstancedMesh(mesh.geometry, shadowMaterial, mesh.count)
      : new THREE.Mesh(mesh.geometry, shadowMaterial);
    if (mesh.isInstancedMesh) shadowMesh.instanceMatrix = mesh.instanceMatrix;
    // Its placement is written straight into matrixWorld below, so Three has
    // nothing to recompute for it.
    shadowMesh.matrixAutoUpdate = false;
    shadowMesh.matrixWorldAutoUpdate = false;
    shadowMesh.renderOrder = PROJECTED_SHADOW_RENDER_ORDER;
    // The bound Three would derive from a flattening matrix can under-estimate,
    // and a shadow that pops out is worse than one that is always submitted.
    shadowMesh.frustumCulled = false;
    this._tagDraws(shadowMesh, 'shadow');
    this.worldFrame.add(shadowMesh);
    mesh.userData.shadowMesh = shadowMesh;
    return shadowMesh;
  }

  // A caster's faces whose material says `noshadow` cast nothing, as
  // upstream's do (`MeshSceneNode.cxx:530`): in a multi-material mesh their
  // groups draw with a material that is never drawn. A map's ground layers
  // are the case that shows -- sheets a hair above the ground, each throwing
  // a shadow the size of the map for the darkening pass to fill.
  _shadowMaterialFor(mesh) {
    const shadow = this._getProjectedShadowMaterial();
    if (!Array.isArray(mesh.material)) return shadow;
    if (!mesh.material.some((material) => material.userData?.noShadow)) return shadow;
    if (!this._noShadowMaterial) this._noShadowMaterial = new THREE.MeshBasicMaterial({ visible: false });
    return mesh.material.map((material) => (material.userData?.noShadow ? this._noShadowMaterial : shadow));
  }

  _removeProjectedShadowMesh(mesh) {
    const shadowMesh = mesh?.userData?.shadowMesh;
    if (!shadowMesh) return;
    shadowMesh.removeFromParent();
    mesh.userData.shadowMesh = null;
  }

  // A tank's whole shape as one geometry, in the tank's own space, shared by
  // every tank wearing the same model.
  //
  // A tank arrives from the loader as seventeen objects and cast a shadow from
  // each, which the draw breakdown measured at three quarters of everything the
  // map itself costs -- and none of them cull, because a shadow's flattening
  // matrix can under-estimate its bound. The shadow does not need the parts: it
  // is one flat silhouette, the parts do not move against each other, and what
  // does move on a tank moves by scrolling a texture rather than by turning a
  // wheel.
  _getTankShadowGeometry(tank) {
    const key = tank.userData.modelPath || 'default';
    if (!this._tankShadowGeometry) this._tankShadowGeometry = new Map();
    const existing = this._tankShadowGeometry.get(key);
    if (existing) return existing;

    const positions = [];
    const indices = [];
    const matrix = new THREE.Matrix4();
    const vertex = new THREE.Vector3();
    tank.updateWorldMatrix(true, true);
    const tankInverse = new THREE.Matrix4().copy(tank.matrixWorld).invert();

    tank.traverse((child) => {
      // A sprite is a name label, and a label casts nothing.
      if (!child.isMesh || !child.geometry) return;
      const position = child.geometry.getAttribute('position');
      if (!position) return;
      matrix.multiplyMatrices(tankInverse, child.matrixWorld);
      const offset = positions.length / 3;
      for (let i = 0; i < position.count; i += 1) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
        positions.push(vertex.x, vertex.y, vertex.z);
      }
      const index = child.geometry.getIndex();
      if (index) {
        for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
      } else {
        for (let i = 0; i < position.count; i += 1) indices.push(i + offset);
      }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    this._tankShadowGeometry.set(key, geometry);
    return geometry;
  }

  // One shadow for a whole tank, hung off the tank rather than off its parts.
  _ensureTankShadowMesh(tank) {
    const existing = tank.userData.shadowMesh;
    if (existing) return existing;

    const shadowMesh = this._tagDraws(
      new THREE.Mesh(this._getTankShadowGeometry(tank), this._getProjectedShadowMaterial()),
      'shadow',
    );
    shadowMesh.matrixAutoUpdate = false;
    shadowMesh.matrixWorldAutoUpdate = false;
    shadowMesh.renderOrder = PROJECTED_SHADOW_RENDER_ORDER;
    shadowMesh.frustumCulled = false;
    this.worldFrame.add(shadowMesh);
    tank.userData.shadowMesh = shadowMesh;
    return shadowMesh;
  }

  // Everything under `object3D` stops casting for good. A tank's meshes are
  // clones sharing their geometry and materials with every other tank, so
  // nothing here is disposed -- only the shadows pointing at them, which the
  // world group would otherwise keep drawing after the caster has left it.
  dropProjectedShadows(object3D) {
    if (!object3D) return;
    object3D.traverse((child) => this._removeProjectedShadowMesh(child));
  }

  // The whole cost of a shadow, per frame: one matrix multiply.
  //
  // A caster is either a mesh with geometry of its own -- an obstacle
  // fragment, or a `mesh`-block object (#88's own spin wrapper included) --
  // or a tank, which is a group of parts casting one merged silhouette.
  _projectShadowForMesh(mesh, projection, casting = true) {
    if (!mesh) return;
    const isTank = mesh.userData.drawGroup === 'tank';
    if (!isTank && !mesh.geometry) {
      // A group that is not a tank has no geometry of its own to project --
      // a spinning mesh's own pivot wrapper (`_wrapMeshSpin`, #88) is the one
      // case today. Its child already carries the group's own rotation in
      // its `matrixWorld` (`updateWorldMatrices` runs first), so projecting
      // each child is exactly as correct as projecting the group would be,
      // and still one matrix multiply per real mesh underneath.
      mesh.children.forEach((child) => this._projectShadowForMesh(child, projection, casting));
      return;
    }
    const castsNone = !isTank && !Array.isArray(mesh.material) && mesh.material?.userData?.noShadow;
    if (!casting || mesh.visible === false || castsNone) {
      const shadowMesh = mesh.userData.shadowMesh;
      if (shadowMesh) shadowMesh.visible = false;
      return;
    }

    const shadowMesh = isTank
      ? this._ensureTankShadowMesh(mesh)
      : this._ensureProjectedShadowMesh(mesh);
    shadowMesh.visible = true;
    if (shadowMesh.isInstancedMesh) shadowMesh.count = mesh.count;
    shadowMesh.matrixWorld.multiplyMatrices(projection, mesh.matrixWorld);
  }

  // Shadows only land where a caster can throw one: inside the world border,
  // plus the longest shadow the lowest light the pass accepts can cast. The
  // ground reaches ten times the world in every direction, and covering all of
  // it means blending most of the screen -- every frame the horizon is in view
  // -- over ground no shadow can reach. The headroom is for airborne tanks
  // above the tallest obstacle.
  _getProjectedShadowOverlayExtent() {
    const border = Number.isFinite(this.groundMapSize) ? this.groundMapSize / 2 : 100;
    const casterHeight = this.maxObstacleHeight + PROJECTED_SHADOW_CASTER_HEADROOM;
    return Math.min(this.groundExtent, border + (casterHeight / PROJECTED_SHADOW_MIN_LIGHT_Z));
  }

  // Called again once the obstacles are in, because the tallest of them is what
  // decides how far a shadow reaches.
  _refreshProjectedShadowOverlay() {
    if (!this._projectedShadowsActive() || !Number.isFinite(this.groundExtent)) return;

    const extent = this._getProjectedShadowOverlayExtent();
    if (!this.projectedShadowOverlay) {
      this.projectedShadowOverlay = this._buildProjectedShadowOverlay(extent);
      this.worldFrame.add(this._tagDraws(this.projectedShadowOverlay, 'shadow'));
      return;
    }
    if (this.projectedShadowOverlay.userData.extent === extent) return;
    this.projectedShadowOverlay.geometry.dispose();
    this.projectedShadowOverlay.geometry = new THREE.PlaneGeometry(extent * 2, extent * 2);
    this.projectedShadowOverlay.userData.extent = extent;
  }

  _buildProjectedShadowOverlay(overlayExtent) {
    const overlayGeometry = new THREE.PlaneGeometry(overlayExtent * 2, overlayExtent * 2);
    const overlayMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: PROJECTED_SHADOW_DARKEN_OPACITY,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });

    overlayMaterial.stencilWrite = true;
    overlayMaterial.stencilRef = PROJECTED_SHADOW_STENCIL_REF;
    overlayMaterial.stencilFunc = THREE.EqualStencilFunc;
    overlayMaterial.stencilFail = THREE.KeepStencilOp;
    overlayMaterial.stencilZFail = THREE.KeepStencilOp;
    overlayMaterial.stencilZPass = THREE.KeepStencilOp;

    const overlayMesh = new THREE.Mesh(overlayGeometry, overlayMaterial);
    overlayMesh.position.z = PROJECTED_SHADOW_OVERLAY_Z;
    overlayMesh.renderOrder = 20;
    overlayMesh.userData.extent = overlayExtent;
    return overlayMesh;
  }

  // Expects updateWorldMatrices to have run this frame.
  updateProjectedShadows(tankMeshes = []) {
    // Each shadow mesh writes the stencil the ground overlay reads. Without a
    // stencil buffer there is no overlay to read it, so the meshes would draw
    // for nothing.
    if (!this._projectedShadowsActive() || !this.worldFrame) return;
    // Whichever light casts: the sun once it is high enough (`areShadowsCast`),
    // and the moon only on bzo's day clock -- upstream's moon casts none, so
    // under its sky a night has no shadows at all.
    const light = this.sunLight?.castShadow ? this.sunLight
      : (this.moonLight?.castShadow ? this.moonLight : null);
    if (!light) {
      for (const mesh of [...this.obstacleMeshes, ...this.meshObjects, ...tankMeshes]) {
        this._projectShadowForMesh(mesh, null, false);
      }
      return;
    }
    const dir = this._getProjectedShadowDirection(light.position);
    if (!dir) return;

    if (!this._projectedShadowProjection) {
      this._projectedShadowProjection = new THREE.Matrix4();
      this._projectedShadowFlatten = new THREE.Matrix4();
      this._projectedShadowWorldToLocal = new THREE.Matrix4();
    }

    this._setProjectedShadowFlattenMatrix(this._projectedShadowFlatten, dir);
    this._projectedShadowWorldToLocal.copy(this.worldFrame.matrixWorld).invert();
    // Flatten in the game's frame, whatever the world is doing in XR.
    const projection = this._projectedShadowProjection
      .multiplyMatrices(this.worldFrame.matrixWorld, this._projectedShadowFlatten)
      .multiply(this._projectedShadowWorldToLocal);

    for (const mesh of this.obstacleMeshes) {
      this._projectShadowForMesh(mesh, projection);
    }

    // A `mesh` block's own render object (`setMeshes`) -- the same
    // projection as the box/pyramid fragments above, so a drawInfo tank, a
    // beam, or any other `mesh` obstacle casts one too.
    for (const mesh of this.meshObjects) {
      this._projectShadowForMesh(mesh, projection);
    }

    for (const tank of tankMeshes) {
      if (!tank) continue;
      // A dead tank is hidden by its group, and the group is what casts: one
      // silhouette for the whole tank rather than one shadow per part. A
      // shadow keeps the last matrix it was handed -- written straight into
      // matrixWorld, where nothing re-derives it from the world group -- so a
      // caster that stops being projected leaves its shadow behind: a dark
      // patch on a desktop, and in a session, where the world group carries the
      // player's own heading, a shadow that appears stuck to the view. It comes
      // back when the tank does.
      //
      // A Burrow tank sinks below ground (`position.z < 0`) and the ground
      // already hides its mesh the ordinary way, by depth. The flatten matrix
      // has no such test: it offsets every vertex by its own z, so a caster
      // below the plane shifts the other way along the light instead of
      // disappearing, and the result is the tank's full standing-height
      // silhouette drawn over the hole it is hiding in. Stop casting once the
      // tank is at or below ground rather than shrinking the shadow with it,
      // matching the mesh, which the ground occludes outright the moment it
      // dips under rather than fading it.
      const burrowed = tank.position.z < 0;
      this._projectShadowForMesh(tank, projection, tank.visible !== false && !burrowed);
    }
  }

  // --- Ground light receivers ---
  // Upstream's ring radii are receiverRingSize * i*i, so the fan reaches 19.2
  // units in four steps that get coarser as the light falls off. Position and
  // index buffers are shared by every receiver; only the colours differ.
  _getGroundReceiverGeometry() {
    if (!this._groundReceiverPosition) {
      const positions = [0, 0, 0];
      for (let ring = 1; ring <= GROUND_RECEIVER_RINGS; ring += 1) {
        const radius = GROUND_RECEIVER_RING_SIZE * ring * ring;
        for (let slice = 0; slice < GROUND_RECEIVER_SLICES; slice += 1) {
          const angle = (slice / GROUND_RECEIVER_SLICES) * Math.PI * 2;
          positions.push(Math.cos(angle) * radius, 0 - (Math.sin(angle) * radius), 0);
        }
      }

      const indices = [];
      for (let slice = 0; slice < GROUND_RECEIVER_SLICES; slice += 1) {
        const next = (slice + 1) % GROUND_RECEIVER_SLICES;
        indices.push(0, 1 + slice, 1 + next);
      }
      for (let ring = 1; ring < GROUND_RECEIVER_RINGS; ring += 1) {
        const inner = 1 + ((ring - 1) * GROUND_RECEIVER_SLICES);
        const outer = 1 + (ring * GROUND_RECEIVER_SLICES);
        for (let slice = 0; slice < GROUND_RECEIVER_SLICES; slice += 1) {
          const next = (slice + 1) % GROUND_RECEIVER_SLICES;
          indices.push(inner + slice, outer + slice, outer + next);
          indices.push(inner + slice, outer + next, inner + next);
        }
      }

      this._groundReceiverPosition = new THREE.BufferAttribute(new Float32Array(positions), 3);
      this._groundReceiverIndex = indices;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this._groundReceiverPosition);
    geometry.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(this._groundReceiverPosition.count * 4), 4,
    ));
    geometry.setIndex(this._groundReceiverIndex);
    return geometry;
  }

  _getGroundReceiverMaterial() {
    if (!this._groundReceiverMaterial) {
      this._groundReceiverMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        // What upstream's receiverGState blends with: GL_SRC_ALPHA, GL_ONE.
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // A flat additive decal is worth seeing from either side, and eight
        // slices are not worth a winding argument.
        side: THREE.DoubleSide,
        fog: false,
      });
    }
    return this._groundReceiverMaterial;
  }

  // I = B / (c + d*(l + d*q)), and past the centre also the cosine term
  // height/d, exactly as upstream computes it per ring.
  _getGroundReceiverIntensity(distance, dimming) {
    const [constant, linear, quadratic] = BZFLAG_LIGHT_ATTENUATION;
    return dimming / (constant + (distance * (linear + (distance * quadratic))));
  }

  // Repaint a receiver's vertex colours. The profile depends only on the light's
  // colour, its height, and how bright the sun is, none of which change on a
  // shot in flight -- so a receiver is painted once and then only moved.
  _paintGroundReceiver(mesh, color, height, dimming) {
    const profileKey = `${color.getHex()}|${Math.round(height * 4)}|${Math.round(dimming * 64)}`;
    if (mesh.userData.receiverProfile === profileKey) return;
    mesh.userData.receiverProfile = profileKey;

    const attribute = mesh.geometry.getAttribute('color');
    const alphaForRing = (ring) => {
      if (ring >= GROUND_RECEIVER_RINGS) return 0; // upstream forces the rim to 0
      if (ring === 0) return this._getGroundReceiverIntensity(height, dimming);
      const radius = GROUND_RECEIVER_RING_SIZE * ring * ring;
      const distance = Math.hypot(radius, height);
      return this._getGroundReceiverIntensity(distance, dimming) * (height / distance);
    };

    let vertex = 0;
    for (let ring = 0; ring <= GROUND_RECEIVER_RINGS; ring += 1) {
      const alpha = Math.max(0, Math.min(1, alphaForRing(ring)));
      const sliceCount = ring === 0 ? 1 : GROUND_RECEIVER_SLICES;
      for (let slice = 0; slice < sliceCount; slice += 1) {
        attribute.setXYZW(vertex, color.r, color.g, color.b, alpha);
        vertex += 1;
      }
    }
    attribute.needsUpdate = true;
  }

  // Upstream's sunBrightness dims the receivers in daylight so a shot does not
  // paint a bright pool on ground the sun is already lighting.
  _getGroundReceiverDimming() {
    const sunBrightness = Math.max(0, Math.min(1, this.sunLight ? this.sunLight.intensity : 0));
    return 1 - (GROUND_RECEIVER_SUN_DIMMING * sunBrightness);
  }

  // Every dynamic light bzo casts belongs to something parented to worldGroup,
  // so the light's own position is already in the space the receivers live in.
  // Everything asking for a light this frame, which is more than the scene can
  // be given.
  _forEachDynamicLight(visit) {
    if (this.projectileLights) {
      for (const light of this.projectileLights.values()) {
        if (light) visit(light);
      }
    }
    for (const effect of this.activeShotExplosions) {
      if (effect.light) visit(effect.light);
    }
    for (const effect of this.activeExplosions) {
      if (effect.light) visit(effect.light);
    }
    if (this._activeJumpJetLights) {
      for (const light of this._activeJumpJetLights) visit(light);
    }
  }

  // And the ones it was given. A receiver stands for light landing on the
  // ground, so it follows what is lighting the ground rather than what asked
  // to.
  _forEachPooledLight(visit) {
    if (!this._dynamicLightPool) return;
    for (const light of this._dynamicLightPool) {
      if (light.intensity > 0) visit(light);
    }
  }

  updateGroundReceivers() {
    if (!this.worldGroup) return;
    if (!this._groundReceivers) this._groundReceivers = [];

    const dimming = this._getGroundReceiverDimming();
    const receivers = this._groundReceivers;
    let used = 0;

    if (this._worldDraws('groundLights')) this._forEachPooledLight((light) => {
      const height = light.position.z;
      if (!(height > 0)) return;
      const color = light.color;
      const peak = this._getGroundReceiverIntensity(height, dimming)
        * Math.max(color.r, color.g, color.b);
      if (peak < GROUND_RECEIVER_MIN_LUMINANCE) return;

      let mesh = receivers[used];
      if (!mesh) {
        mesh = new THREE.Mesh(this._getGroundReceiverGeometry(), this._getGroundReceiverMaterial());
        mesh.renderOrder = GROUND_RECEIVER_RENDER_ORDER;
        this.worldFrame.add(this._tagDraws(mesh, 'effect'));
        receivers[used] = mesh;
      }
      mesh.position.set(light.position.x, light.position.y, GROUND_RECEIVER_Z);
      this._paintGroundReceiver(mesh, color, height, dimming);
      mesh.visible = true;
      used += 1;
    });

    for (let index = used; index < receivers.length; index += 1) {
      receivers[index].visible = false;
    }
  }
}
