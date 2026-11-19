/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Flags: the waving flags, their labels and fades, and the sky beacons.
// RenderManager's own methods, kept here and installed on its prototype by
// render.js: `this` is the RenderManager.

import { FLAG_POLE_WIDTH, SUPER_FLAG_COLOR, getFlagTuning } from './flags.mjs';
import * as THREE from 'three';
import { LABEL_MATERIAL_DEPTH, standUpGeometry } from './render.js';

// Flags, mirroring FlagSceneNode (FlagSceneNode.cxx) at upstream's default
// quality, where `geoPole` is on and `realFlag` is off: pole and cloth are one
// billboarded pair facing the camera, and the cloth is a strip of eight quads
// rippling on two out-of-phase waves. Because the cloth is billboarded at that
// quality upstream's wind only turns a flag nobody can see turning, so bzo has
// no wind at all -- see AGENTS.md on implementing the default variant.
const BZFLAG_FLAG_TEXTURE = '/textures/flag.png';
const BZFLAG_FLAG_UNIT = 0.8;                              // Unit
const BZFLAG_FLAG_WIDTH = 1.5 * BZFLAG_FLAG_UNIT;          // Width
const BZFLAG_FLAG_HEIGHT = BZFLAG_FLAG_UNIT;               // Height
const BZFLAG_FLAG_CHUNKS = 8;                              // flagChunks
const BZFLAG_FLAG_WAVE_SETS = 8;                           // waveLists
const BZFLAG_FLAG_RIPPLE_SPEED_1 = 2.4 * Math.PI;          // RippleSpeed1
const BZFLAG_FLAG_RIPPLE_SPEED_2 = 1.724 * Math.PI;        // RippleSpeed2
const BZFLAG_FLAG_RIPPLE_PHASE = 1.16 * Math.PI;           // sinRipple2S offset
const BZFLAG_FLAG_RIPPLE_LAG = 0.28 * Math.PI;             // angle2 offset
const BZFLAG_FLAG_RIPPLE_TURNS = 4 * Math.PI;              // angle1 slope
const BZFLAG_FLAG_RIPPLE_DAMP = 0.1;                       // damp
// setAlphaFunc(GL_GEQUAL, 0.9) in notifyStyleChange: an ordinary flag is opaque
// geometry with the cloth's own shape cut out of it by the texture's alpha, and
// only a flag whose colour is fading turns blending on.
const BZFLAG_FLAG_ALPHA_THRESHOLD = 0.9;
// Flags are drawn after the world, and an opaque one occludes whatever is
// behind it rather than blending with it.
const FLAG_RENDER_ORDER = 5;

// The warp a flag arrives and leaves through, from FlagWarpSceneNode.cxx:28.
// Seven horizontal twelve-sided discs in a fixed rainbow at half alpha, each
// one step smaller than the last and a hair further along the stack.
const BZFLAG_FLAG_WARP_SIZE = 7.5;
const BZFLAG_FLAG_WARP_ALPHA = 0.5;
const BZFLAG_FLAG_WARP_SEGMENTS = 12;
const BZFLAG_FLAG_WARP_STEP = 0.05;
const BZFLAG_FLAG_WARP_SPACING = 0.01;
const BZFLAG_FLAG_WARP_WOBBLE_MIN = 0.9;
const BZFLAG_FLAG_WARP_WOBBLE_RANGE = 0.2;
const BZFLAG_FLAG_WARP_COLORS = [
  0x40ff40, 0x4040ff, 0xff00ff, 0xff4040, 0xff8000, 0xffff00, 0xffffff,
];
// A sky beacon: a wedge hanging out of the cloud layer down to just above
// something the player is looking for. Upstream has nothing like it -- its
// bearings live on the heading tape (prepareTheHUD, playing.cxx:6820), which an
// immersive session has no room for and which a flat client reads by looking
// away from the world. bzo's radar rings the same things, and a ring answers
// "where is it on the map"; what it leaves the player to do is turn a top-down
// panel into a direction to drive. A mark standing in the world has already
// done that, so a beacon marks exactly what a ring marks and never anything
// else.
//
// A cone rather than a flat triangle turned to face the viewer. The triangle is
// the cheaper draw, but it has to be re-aimed every frame, and two of them seen
// from an angle both face you and so lie about which way they stand. A cone is
// a triangle pointing down from wherever it is looked at; eight radial segments
// leave its silhouette without corners.
//
// Front faces only: the viewer then looks through one wall rather than two, so
// the wedge is an even wash of colour instead of twice as solid down its middle
// as at its edges.
const SKY_BEACON_RADIUS = 4;                 // 8 across at the top, over a drop of 16 and up
const SKY_BEACON_SEGMENTS = 8;
const SKY_BEACON_OPACITY = 0.5;
// The top is the cloud layer, so a beacon over a tank in the air is shorter
// than one over the ground -- which is the altitude a top-down panel cannot
// show. A target at cloud height would leave nothing to see at all, so the
// wedge keeps a length of its own and climbs past the clouds instead.
const SKY_BEACON_MIN_LENGTH = 16;
// Gone by the time the thing itself is in front of the player: a team flag
// resting on its own base would otherwise stand a wedge over every spawn.
// Faded rather than switched, because a beacon appearing whole reads as
// something new arriving rather than as the one already being driven towards.
const SKY_BEACON_FADE_NEAR = 15;
const SKY_BEACON_FADE_FAR = 45;

const FLAG_BILLBOARD_SCRATCH = new THREE.Vector3();
const SKY_BEACON_SCRATCH = new THREE.Vector3();
// One flag's place in the batch, written and handed over once per flag per
// frame rather than allocated per flag.
const FLAG_INSTANCE_MATRIX = new THREE.Matrix4();
const FLAG_INSTANCE_COLOR = new THREE.Color();

const BANNER_ALONG = new THREE.Vector3();
const BANNER_UP = new THREE.Vector3();
const BANNER_ACROSS = new THREE.Vector3();
const BANNER_ORIGIN = new THREE.Vector3();

// The game flag's cloth, from its pole edge at `poleSize` up, onto a banner:
// its width along the banner, its height up the pole edge, and its ripple
// across, scaled as its width is so the banner waves as a game flag does.
function flagBannerMatrix(matrix, banner, poleSize) {
  const { hinge, free, top } = banner;
  BANNER_ALONG.set(free.x - hinge.x, free.y - hinge.y, free.z - hinge.z);
  BANNER_UP.set(top.x - hinge.x, top.y - hinge.y, top.z - hinge.z);
  const width = BANNER_ALONG.length();
  BANNER_ACROSS.crossVectors(BANNER_UP, BANNER_ALONG).normalize().multiplyScalar(width / BZFLAG_FLAG_WIDTH);
  BANNER_ALONG.multiplyScalar(1 / BZFLAG_FLAG_WIDTH);
  BANNER_UP.multiplyScalar(1 / BZFLAG_FLAG_HEIGHT);
  matrix.makeBasis(BANNER_ALONG, BANNER_ACROSS, BANNER_UP);
  BANNER_ORIGIN.set(hinge.x, hinge.y, hinge.z).addScaledVector(BANNER_UP, -poleSize);
  return matrix.setPosition(BANNER_ORIGIN);
}

export class FlagRendering {
  _getFlagTexture() {
    if (!this._flagTexture) {
      this._flagTexture = this._createSharedImageTexture(BZFLAG_FLAG_TEXTURE);
    }
    return this._flagTexture;
  }

  // FlagSceneNode::waveFlag steps eight wave sets once a frame and lets every
  // flag in the world share them, however many flags there are. bzo shares the
  // same eight BufferGeometry instances for the same reason: on a CPU-bound
  // client the cloth must not cost per flag.
  _getFlagWaveSets() {
    if (this._flagWaveSets) return this._flagWaveSets;

    const vertexCount = (BZFLAG_FLAG_CHUNKS + 1) * 2;
    // Upstream draws a GL_TRIANGLE_STRIP; the same vertices indexed as
    // triangles are the strip, every other one swapped as a strip's are so all
    // of them face -y. A lit map banner shades each triangle by the side it
    // shows, so a mixed winding would draw it as alternating triangles.
    const indices = [];
    for (let vertex = 0; vertex < vertexCount - 2; vertex += 1) {
      if (vertex % 2 === 0) indices.push(vertex, vertex + 1, vertex + 2);
      else indices.push(vertex + 1, vertex, vertex + 2);
    }
    const uvs = new Float32Array(vertexCount * 2);
    for (let chunk = 0; chunk <= BZFLAG_FLAG_CHUNKS; chunk += 1) {
      const u = chunk / BZFLAG_FLAG_CHUNKS;
      uvs[(chunk * 4) + 0] = u;
      uvs[(chunk * 4) + 1] = 1;
      uvs[(chunk * 4) + 2] = u;
      uvs[(chunk * 4) + 3] = 0;
    }

    this._flagWaveSets = [];
    for (let set = 0; set < BZFLAG_FLAG_WAVE_SETS; set += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs.slice(), 2));
      geometry.setIndex(indices);
      // The vertices move every frame, so the bounding sphere is set once to
      // cover the whole ripple rather than recomputed for each step.
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(BZFLAG_FLAG_WIDTH / 2, getFlagTuning().flagPoleSize + (BZFLAG_FLAG_HEIGHT / 2), 0),
        BZFLAG_FLAG_WIDTH
      );
      this._flagWaveSets.push({
        geometry,
        // Each set starts at its own phase so neighbouring flags do not ripple
        // in lockstep.
        ripple1: Math.random() * 2 * Math.PI,
        ripple2: Math.random() * 2 * Math.PI,
      });
    }
    this._stepFlagWaveSets(0);
    return this._flagWaveSets;
  }

  // waveFlag(). Two ripples run along the cloth at different speeds; the top and
  // bottom edges of each chunk ride different combinations of them, damped
  // towards the pole so the cloth stays attached to it.
  _stepFlagWaveSets(deltaTime) {
    const twoPi = 2 * Math.PI;
    // Asked for rather than assumed: the first frame of a world steps the sets
    // before anything else has had reason to build them.
    (this._flagWaveSets ?? this._getFlagWaveSets()).forEach((set) => {
      set.ripple1 = (set.ripple1 + (deltaTime * BZFLAG_FLAG_RIPPLE_SPEED_1)) % twoPi;
      set.ripple2 = (set.ripple2 + (deltaTime * BZFLAG_FLAG_RIPPLE_SPEED_2)) % twoPi;
      const sinRipple2 = Math.sin(set.ripple2);
      const sinRipple2Shifted = Math.sin(set.ripple2 + BZFLAG_FLAG_RIPPLE_PHASE);
      const positions = set.geometry.attributes.position;

      for (let chunk = 0; chunk <= BZFLAG_FLAG_CHUNKS; chunk += 1) {
        const along = chunk / BZFLAG_FLAG_CHUNKS;
        const damp = BZFLAG_FLAG_RIPPLE_DAMP * along;
        const angle1 = set.ripple1 - (BZFLAG_FLAG_RIPPLE_TURNS * along);
        const angle2 = angle1 - BZFLAG_FLAG_RIPPLE_LAG;
        const wave0 = damp * Math.sin(angle1);
        const wave1 = damp * (Math.sin(angle2) + sinRipple2Shifted);
        const wave2 = wave0 + (damp * sinRipple2);
        const x = BZFLAG_FLAG_WIDTH * along;
        const poleSize = getFlagTuning().flagPoleSize;
        positions.setXYZ(chunk * 2, x, 0 - wave1, poleSize + BZFLAG_FLAG_HEIGHT - wave0);
        positions.setXYZ((chunk * 2) + 1, x, 0 - wave2, poleSize - wave0);
      }
      positions.needsUpdate = true;
    });
  }

  _createFlagWarp() {
    const group = new THREE.Group();
    group.visible = false;
    // One perturbed ring shared by the whole stack, as upstream builds one
    // `geom` per render call and scales it seven times.
    const geometry = new THREE.BufferGeometry();
    const vertexCount = BZFLAG_FLAG_WARP_SEGMENTS + 1;
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    const indices = [];
    for (let segment = 0; segment < BZFLAG_FLAG_WARP_SEGMENTS; segment += 1) {
      indices.push(0, segment + 1, ((segment + 1) % BZFLAG_FLAG_WARP_SEGMENTS) + 1);
    }
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), BZFLAG_FLAG_WARP_SIZE * 1.25);

    const rings = BZFLAG_FLAG_WARP_COLORS.map((color, ring) => {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: BZFLAG_FLAG_WARP_ALPHA,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // Upstream stacks the discs towards or away from the eye depending on
      // which side of the flag it is on, purely so the nearest draws last. With
      // depth writing off and both sides visible that ordering is free, so the
      // stack always climbs.
      mesh.position.z = ring * BZFLAG_FLAG_WARP_SPACING;
      mesh.renderOrder = FLAG_RENDER_ORDER;
      group.add(mesh);
      return { mesh, material };
    });

    return { group, geometry, rings };
  }

  _perturbFlagWarp(warp) {
    const positions = warp.geometry.attributes.position;
    positions.setXYZ(0, 0, 0, 0);
    for (let segment = 0; segment < BZFLAG_FLAG_WARP_SEGMENTS; segment += 1) {
      const angle = (2 * Math.PI * segment) / BZFLAG_FLAG_WARP_SEGMENTS;
      const radius = BZFLAG_FLAG_WARP_SIZE
        * (BZFLAG_FLAG_WARP_WOBBLE_MIN + (BZFLAG_FLAG_WARP_WOBBLE_RANGE * Math.random()));
      positions.setXYZ(segment + 1, radius * Math.cos(angle), 0 - (radius * Math.sin(angle)), 0);
    }
    positions.needsUpdate = true;
  }

  // Every flag in the world, in as few draws as there are cloth ripples plus
  // one. `FlagSceneNode::notifyStyleChange` draws an ordinary flag opaque --
  // no blending, `setAlphaFunc(GL_GEQUAL, 0.9)` against the texture -- and only
  // reaches for blending when the flag's own colour has alpha below one, which
  // is a flag warping in or out. An opaque flag needs no sorting against its
  // neighbours, and that is what lets the whole world's flags ride in
  // InstancedMeshes: one per wave set for the cloth, because a set is a shared
  // geometry and instancing draws one geometry many times, and one for every
  // pole in the world, which are identical.
  //
  // Capacity is grown in powers of two and the meshes are never culled: they
  // stand for flags scattered over the whole map, so a bound around them is the
  // map, and computing one per frame would cost more than the draw it saves.
  _getFlagBatch(needed) {
    if (this._flagBatch && this._flagBatch.capacity >= needed) return this._flagBatch;

    this._disposeFlagBatch();
    const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, needed))));
    const waveSets = this._getFlagWaveSets();
    const clothMaterial = new THREE.MeshBasicMaterial({
      map: this._getFlagTexture(),
      side: THREE.DoubleSide,
      alphaTest: BZFLAG_FLAG_ALPHA_THRESHOLD,
    });
    const poleMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    // The pole stands on the flag's position, so its offset is baked into the
    // geometry and the instance matrix carries nothing but the flag's place and
    // the way it faces.
    const poleHeight = getFlagTuning().flagPoleSize + BZFLAG_FLAG_HEIGHT;
    const poleGeometry = standUpGeometry(new THREE.PlaneGeometry(2 * FLAG_POLE_WIDTH, poleHeight)
      .translate(0, poleHeight / 2, 0));

    const prepare = (mesh) => {
      this._tagDraws(mesh, 'flag');
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = FLAG_RENDER_ORDER;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.worldFrame.add(mesh);
      return mesh;
    };

    this._flagBatch = {
      capacity,
      clothMaterial,
      poleMaterial,
      poleGeometry,
      cloth: waveSets.map((set) => prepare(new THREE.InstancedMesh(set.geometry, clothMaterial, capacity))),
      pole: prepare(new THREE.InstancedMesh(poleGeometry, poleMaterial, capacity)),
    };
    return this._flagBatch;
  }

  _disposeFlagBatch() {
    const batch = this._flagBatch;
    if (!batch) return;
    [...batch.cloth, batch.pole].forEach((mesh) => {
      mesh.parent?.remove(mesh);
      mesh.dispose();
    });
    batch.poleGeometry.dispose();
    batch.clothMaterial.dispose();
    batch.poleMaterial.dispose();
    this._flagBatch = null;
  }

  // What a flag looks like right now, and nothing that draws it. A record is
  // cheap enough that a world of 200 can carry one each whether or not that
  // slot has ever held a flag.
  _ensureFlagRecord(index) {
    if (!this.flagRecords) this.flagRecords = new Map();
    const existing = this.flagRecords.get(index);
    if (existing) return existing;

    const record = {
      x: 0,
      y: 0,
      z: 0,
      color: SUPER_FLAG_COLOR,
      alpha: 1,
      visible: false,
      // Fixed for the life of the flag, so a flag does not change its ripple
      // when it is picked up and put down again.
      waveSet: Math.floor(Math.random() * BZFLAG_FLAG_WAVE_SETS),
      fade: null,
      warp: null,
      label: null,
    };
    this.flagRecords.set(index, record);
    return record;
  }

  // The one flag the batch cannot draw: upstream turns blending on for a flag
  // whose colour has alpha below one, and an InstancedMesh has one material for
  // every instance in it. A warping flag gets a mesh of its own for as long as
  // it is fading, which is a second at a time and rarely more than one flag.
  _ensureFlagFade(record) {
    if (record.fade) return record.fade;

    const waveSet = this._getFlagWaveSets()[record.waveSet];
    const group = new THREE.Group();
    const clothMaterial = new THREE.MeshBasicMaterial({
      map: this._getFlagTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const cloth = new THREE.Mesh(waveSet.geometry, clothMaterial);
    cloth.renderOrder = FLAG_RENDER_ORDER;
    group.add(cloth);

    const poleMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const poleHeight = getFlagTuning().flagPoleSize + BZFLAG_FLAG_HEIGHT;
    const pole = new THREE.Mesh(
      standUpGeometry(new THREE.PlaneGeometry(2 * FLAG_POLE_WIDTH, poleHeight)), poleMaterial,
    );
    pole.position.z = poleHeight / 2;
    pole.renderOrder = FLAG_RENDER_ORDER;
    group.add(pole);

    this.worldFrame.add(this._tagDraws(group, 'flag'));
    record.fade = { group, clothMaterial, poleMaterial, pole };
    return record.fade;
  }

  _ensureFlagWarp(record) {
    if (record.warp) return record.warp;
    record.warp = this._createFlagWarp();
    this.worldFrame.add(record.warp.group);
    return record.warp;
  }

  // The debug label over a flag, created the first time that flag has anything
  // to say. Most flags in a world are unidentified, so a world of 200 would
  // otherwise pay for 200 label canvases to draw nothing.
  //
  // It hangs off `worldFrame` rather than off the flag, because a flag is
  // billboarded every frame and a child would be swung around with it.
  _ensureFlagLabel(record) {
    if (record.label) return record.label;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ ...LABEL_MATERIAL_DEPTH }));
    label.scale.set(4, 1, 1);
    this.worldFrame.add(label);
    record.label = label;
    return label;
  }

  // Places a flag and sets how solid it looks. `warp` is the size fraction of
  // the arrival/departure disc stack, zero for no warp at all. `label` is the
  // abbreviation of a flag whose identity this client knows, or null for one it
  // does not, and it draws only while the debug labels are on.
  //
  // The label wears the colour of the cloth under it, so it says what the flag
  // says: a team's colour for a team flag, bzo's orange for a bad one this
  // client has identified, and white for every other superflag -- which is what
  // upstream draws all of them, and what an unidentified one stays.
  //
  // Nothing here touches a mesh: the cloth and the pole are written into the
  // batch once a frame by updateFlagVisuals, which is the only place that knows
  // which way each flag has to face.
  showFlag(index, {
    x, y, z, color = SUPER_FLAG_COLOR, alpha = 1, warp = 0, label = null,
  }) {
    const record = this._ensureFlagRecord(index);
    record.x = x;
    record.y = y;
    record.z = z;
    record.color = color;
    record.alpha = alpha;
    record.visible = alpha > 0;

    const showLabel = Boolean(label) && this.debugLabelsEnabled && alpha > 0;
    if (showLabel) {
      const sprite = this._ensureFlagLabel(record);
      this.updateSpriteLabel(sprite, label, color);
      sprite.position.set(x, y, z + BZFLAG_FLAG_HEIGHT + getFlagTuning().flagPoleSize + 1);
      sprite.visible = true;
    } else if (record.label) {
      record.label.visible = false;
    }

    if (warp > 0) {
      const flagWarp = this._ensureFlagWarp(record);
      flagWarp.group.visible = true;
      flagWarp.group.position.set(x, y, z);
    } else {
      this._releaseFlagWarp(record);
    }
    if (warp > 0) {
      record.warp.rings.forEach((ring, index2) => {
        const size = warp - (BZFLAG_FLAG_WARP_STEP * index2);
        ring.mesh.visible = size > 0;
        if (size > 0) ring.mesh.scale.set(size, size, 1);
      });
    }
  }

  hideFlag(index) {
    const record = this.flagRecords?.get(index);
    if (!record) return;
    record.visible = false;
    this._releaseFlagFade(record);
    this._releaseFlagWarp(record);
    if (record.label) record.label.visible = false;
  }

  // The unit beacon: apex down and at the origin, so an instance is placed at
  // the tip and scaled to whatever length the target's height leaves it.
  _getSkyBeaconGeometry() {
    if (!this.skyBeaconGeometry) {
      this.skyBeaconGeometry = standUpGeometry(new THREE.ConeGeometry(1, 1, SKY_BEACON_SEGMENTS, 1, true)
        .rotateX(Math.PI)
        .translate(0, 0.5, 0));
    }
    return this.skyBeaconGeometry;
  }

  _ensureSkyBeacon(index) {
    const existing = this.skyBeacons[index];
    if (existing) return existing;

    const mesh = this._tagDraws(new THREE.Mesh(this._getSkyBeaconGeometry(), new THREE.MeshBasicMaterial({
      transparent: true,
      // The wedge tints what is behind it rather than hiding it: it stands over
      // the part of the world the player is driving into.
      depthWrite: false,
      side: THREE.FrontSide,
    })), 'effect');
    mesh.renderOrder = FLAG_RENDER_ORDER;
    this.worldFrame.add(mesh);
    this.skyBeacons[index] = mesh;
    return mesh;
  }

  // One wedge for each thing the player is looking for, hung from the clouds
  // down to the tip the caller places just clear of the target. `count` says
  // how much of `targets` to read, so a caller can keep one array and refill it
  // every frame rather than allocating one per frame.
  //
  // A mesh each rather than one instanced batch, which is what every other
  // repeated thing in the world rides: a world holds a handful of these -- a
  // team flag, an antidote, a rabbit -- and each fades on its own distance,
  // which instancing has no per-instance opacity to carry.
  showSkyBeacons(targets, count = targets?.length || 0) {
    for (let index = count; index < this.skyBeacons.length; index += 1) {
      this.skyBeacons[index].visible = false;
    }
    if (count === 0) return;

    const viewer = this._getViewerInWorldFrame(SKY_BEACON_SCRATCH);
    for (let index = 0; index < count; index += 1) {
      const target = targets[index];
      const color = target.color;
      const mesh = this._ensureSkyBeacon(index);
      const distance = Math.hypot(viewer.x - target.x, viewer.y - target.y);
      const fade = (distance - SKY_BEACON_FADE_NEAR) / (SKY_BEACON_FADE_FAR - SKY_BEACON_FADE_NEAR);
      const alpha = SKY_BEACON_OPACITY * Math.min(1, Math.max(0, fade));
      mesh.visible = alpha > 0;
      if (!mesh.visible) continue;

      mesh.position.set(target.x, target.y, target.z);
      mesh.scale.set(
        SKY_BEACON_RADIUS,
        SKY_BEACON_RADIUS,
        Math.max(SKY_BEACON_MIN_LENGTH, this.skyBeaconTopZ - target.z),
      );
      mesh.material.color.setHex(color);
      mesh.material.opacity = alpha;
    }
  }

  clearSkyBeacons() {
    this.skyBeacons.forEach((mesh) => {
      mesh.parent?.remove(mesh);
      mesh.material.dispose();
    });
    this.skyBeacons = [];
    this.skyBeaconGeometry?.dispose();
    this.skyBeaconGeometry = null;
  }

  // A fading flag's own mesh and a warp's disc stack exist only while the fade
  // or the warp lasts, and go as soon as it ends. Kept, they piled up one set
  // per flag that had ever faded: a world of 242 respawning flags grew by
  // eight flags' worth every twenty seconds, hidden but still walked by every
  // frame's matrix update. The cloth geometry is shared by every flag, so only
  // what a record owns outright is disposed.
  _releaseFlagFade(record) {
    if (!record.fade) return;
    record.fade.group.parent?.remove(record.fade.group);
    record.fade.clothMaterial.dispose();
    record.fade.poleMaterial.dispose();
    record.fade.pole.geometry.dispose();
    record.fade = null;
  }

  _releaseFlagWarp(record) {
    if (!record.warp) return;
    record.warp.group.parent?.remove(record.warp.group);
    record.warp.geometry.dispose();
    record.warp.rings.forEach((ring) => ring.material.dispose());
    record.warp = null;
  }

  clearFlags() {
    this._disposeFlagBatch();
    if (!this.flagRecords) return;
    this.flagRecords.forEach((record) => {
      this._releaseFlagFade(record);
      this._releaseFlagWarp(record);
      if (record.label) {
        record.label.parent?.remove(record.label);
        record.label.material.map?.dispose();
        record.label.material.dispose();
      }
    });
    this.flagRecords.clear();
  }

  // A map's own banners (`findMeshBanners`) as cloth on the same eight waves.
  // Each group is one material and one set of texcoords, drawn as an
  // InstancedMesh per wave set; the cloth's shape is the wave set's own,
  // copied each frame, and its texcoords are the banner face's, so the map's
  // `texmat` on that material lands on the cloth as it did on the face.
  // Hung from the banner's pole edge and facing where the banner faced, not
  // turned to the viewer: it has a pole of its own that does not turn.
  addFlagBanners(groups) {
    const waveSets = this._getFlagWaveSets();
    const vertexCount = (BZFLAG_FLAG_CHUNKS + 1) * 2;
    this._flagBanners ??= [];
    let next = this._flagBanners.reduce((sum, group) => sum + group.count, 0);
    for (const { material, uvs, banners } of groups) {
      const uv = new Float32Array(vertexCount * 2);
      const normals = new Float32Array(vertexCount * 3);
      for (let chunk = 0; chunk <= BZFLAG_FLAG_CHUNKS; chunk += 1) {
        const along = chunk / BZFLAG_FLAG_CHUNKS;
        const u = uvs.hinge[0] + (along * (uvs.free[0] - uvs.hinge[0]));
        const v = uvs.hinge[1] + (along * (uvs.free[1] - uvs.hinge[1]));
        uv.set([u + (uvs.top[0] - uvs.hinge[0]), v + (uvs.top[1] - uvs.hinge[1]), u, v], chunk * 4);
      }
      // The cloth's front faces its own -y, as a game flag's does.
      for (let vertex = 0; vertex < vertexCount; vertex += 1) normals[(vertex * 3) + 1] = -1;
      const placed = waveSets.map(() => []);
      banners.forEach((banner) => {
        placed[next % waveSets.length].push(banner);
        next += 1;
      });
      const meshes = [];
      waveSets.forEach((set, index) => {
        if (!placed[index].length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(set.geometry.attributes.position.array.slice(), 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geometry.setIndex(new THREE.BufferAttribute(set.geometry.index.array.slice(), 1));
        const mesh = new THREE.InstancedMesh(geometry, material, placed[index].length);
        // Spread over the whole map, as the game flags' batches are.
        mesh.frustumCulled = false;
        this._tagDraws(mesh, 'flag');
        this.worldFrame.add(mesh);
        meshes.push({ mesh, set, banners: placed[index] });
      });
      this._flagBanners.push({ material, meshes, count: banners.length, poleSize: null });
    }
    this._stepFlagBanners();
  }

  clearFlagBanners() {
    (this._flagBanners || []).forEach(({ material, meshes }) => {
      meshes.forEach(({ mesh }) => {
        mesh.parent?.remove(mesh);
        mesh.geometry.dispose();
        mesh.dispose();
      });
      // The texture is the shared one every face wearing it draws with.
      material.dispose();
    });
    this._flagBanners = [];
  }

  // The wave sets' new shape onto each banner's copy, and the banners placed
  // again whenever `_flagPoleSize` moves the cloth the wave sets are built at.
  _stepFlagBanners() {
    if (!this._flagBanners?.length) return;
    const poleSize = getFlagTuning().flagPoleSize;
    const matrix = FLAG_INSTANCE_MATRIX;
    for (const group of this._flagBanners) {
      const place = group.poleSize !== poleSize;
      group.poleSize = poleSize;
      for (const { mesh, set, banners } of group.meshes) {
        const positions = mesh.geometry.attributes.position;
        positions.array.set(set.geometry.attributes.position.array);
        positions.needsUpdate = true;
        if (!place) continue;
        banners.forEach((banner, i) => {
          mesh.setMatrixAt(i, flagBannerMatrix(matrix, banner, poleSize));
        });
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  // Where the viewer stands, in the game's frame. Read straight off the camera
  // it would carry the player's heading twice in a session, because there it
  // is the world groups that turn.
  _getViewerInWorldFrame(target) {
    this.camera.getWorldPosition(target);
    this.worldFrame.updateWorldMatrix(true, false);
    return this.worldFrame.worldToLocal(target);
  }

  // One step for every flag in the world: the shared cloth ripples, each
  // visible flag turns to face the camera, and each visible warp re-wobbles.
  updateFlagVisuals(deltaTime) {
    if (!this.flagRecords?.size && !this._flagBanners?.length) return;
    this._stepFlagWaveSets(deltaTime);
    this._stepFlagBanners();
    if (!this.flagRecords?.size) return;

    // A flag turns to face the viewer about its own pole, and about nothing
    // else. Upstream multiplies in the inverse of the whole view rotation
    // (ViewFrustum::executeBillboard), which keeps the pole upright on a monitor
    // only because a desktop camera has no roll and little pitch: the pole is
    // vertical *on the screen*, not in the world. In a headset that reads as the
    // flag leaning over with your head, and turning about the eye rather than
    // about the pole means a flag spins in place when you merely look away from
    // it. Yaw towards the viewer does what the billboard is for -- the cloth
    // faces you -- and leaves the pole where the world put it.
    //
    // The turn is measured in the game's frame rather than the scene's,
    // because in a session the world groups carry the player's heading:
    // reading the camera's orientation straight off would apply that heading a
    // second time. The cloth faces its own -y, so it turns that toward the
    // viewer about the pole.
    const camera = this._getViewerInWorldFrame(FLAG_BILLBOARD_SCRATCH);

    const batch = this._getFlagBatch(this.flagRecords.size);
    const matrix = FLAG_INSTANCE_MATRIX;
    const color = FLAG_INSTANCE_COLOR;
    batch.cloth.forEach((mesh) => { mesh.count = 0; });
    batch.pole.count = 0;

    this.flagRecords.forEach((record) => {
      if (record.warp?.group.visible) this._perturbFlagWarp(record.warp);
      if (!record.visible) {
        this._releaseFlagFade(record);
        return;
      }

      const yaw = Math.atan2(camera.x - record.x, record.y - camera.y);
      matrix.makeRotationZ(yaw);
      matrix.setPosition(record.x, record.y, record.z);

      if (record.alpha >= 1) {
        this._releaseFlagFade(record);
        const cloth = batch.cloth[record.waveSet];
        const slot = cloth.count;
        cloth.setMatrixAt(slot, matrix);
        cloth.setColorAt(slot, color.setHex(record.color));
        cloth.count = slot + 1;
        batch.pole.setMatrixAt(batch.pole.count, matrix);
        batch.pole.count += 1;
        return;
      }

      // Fading, so it leaves the batch and is drawn on its own with blending.
      const fade = this._ensureFlagFade(record);
      fade.group.visible = true;
      fade.group.position.set(record.x, record.y, record.z);
      fade.group.rotation.set(0, 0, yaw);
      fade.clothMaterial.color.setHex(record.color);
      fade.clothMaterial.opacity = record.alpha;
      fade.poleMaterial.opacity = record.alpha;
    });

    batch.cloth.forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    batch.pole.instanceMatrix.needsUpdate = true;
  }
}
