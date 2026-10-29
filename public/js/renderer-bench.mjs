/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// One world, built by bzo's own renderer code, drawn by three's WebGL renderer
// or its WebGPU one, along the same camera path, to see whether WebGPU would
// be worth a migration. A measurement page, not part of the game:
//
//   /renderer-bench.html?map=<file>&renderer=webgl|webgpu|webgpu-gl
//
// `map` is a file in maps/, or `live` (the default) for the match being
// played; `world=<hash>` names one by its hash instead.
// `webgpu-gl` is the WebGPU renderer forced onto its WebGL 2 fallback, which
// is what a browser without WebGPU would get. `seconds` (20) is the run.
// Objects drawn with a hand-written GLSL `ShaderMaterial` are hidden in every
// mode, since the WebGPU renderer cannot draw them. Its lighting is three's
// own, not upstream's (color-management.mjs patches WebGL's shaders only), so
// its picture is darker; the draw work is the same. The result is on the page
// and in `window.benchResult`.

import './color-management.mjs';
import { renderManager } from './render.js';

const params = new URLSearchParams(window.location.search);
const mode = params.get('renderer') || 'webgl';
const seconds = Number(params.get('seconds')) || 20;
const WARMUP_SECONDS = 3;
const report = document.getElementById('benchReport');

function show(text) {
  report.textContent = text;
}

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

function summarize(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  return { mean, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] || 0 };
}

async function main() {
  let hash = params.get('world');
  if (!hash) {
    const map = params.get('map') || 'live';
    const found = await fetch(`/api/world/file/${encodeURIComponent(map)}`);
    if (!found.ok) throw new Error(`map ${map}: HTTP ${found.status}`);
    ({ hash } = await found.json());
  }
  if (!/^[0-9a-f]{12}$/.test(hash || '')) throw new Error(`not a world hash: ${hash}`);
  const response = await fetch(`/maps/${hash}.json`);
  if (!response.ok) throw new Error(`world ${hash}: HTTP ${response.status}`);
  const world = await response.json();

  const { scene, camera, renderer: glRenderer } = renderManager.init({ container: document.body });
  const obstacles = world.obstacles || [];
  renderManager.setObstacles(obstacles.filter((obs) => obs.type !== 'mesh'));
  renderManager.setMeshes(obstacles.filter((obs) => obs.type === 'mesh' && !obs.drawnByInstance));
  renderManager.setMeshInstances(world.meshTemplates, world.meshInstances);
  const mapSize = Number.isFinite(world.mapSize) ? world.mapSize : 800;
  renderManager.buildGround(mapSize, world.groundMaterial || null);
  renderManager.createMapBoundaries(mapSize, !!world.noWalls);
  renderManager.createMountains(mapSize);
  renderManager.setCelestialTime(Date.now() / 1000);

  let renderer = glRenderer;
  if (mode !== 'webgl') {
    const { WebGPURenderer } = await import('three/webgpu');
    glRenderer.domElement.remove();
    renderer = new WebGPURenderer({ antialias: true, forceWebGL: mode === 'webgpu-gl' });
    renderer.setPixelRatio(glRenderer.getPixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    await renderer.init();
  }
  const backend = mode === 'webgl' ? 'WebGL 2'
    : renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL 2 (WebGPU renderer fallback)';

  let hidden = 0;
  scene.traverse((object) => {
    const materials = [].concat(object.material || []);
    if (materials.some((material) => material.isShaderMaterial)) {
      object.visible = false;
      hidden += 1;
    }
  });
  let meshes = 0;
  scene.traverse((object) => { if (object.isMesh && object.visible) meshes += 1; });

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  const radius = mapSize * 0.35;
  const placeCamera = (t) => {
    const angle = t * 0.15;
    // Three's frame: +Y up, the game's north along -Z.
    camera.position.set(Math.cos(angle) * radius, 12, Math.sin(angle) * radius);
    camera.lookAt(0, 4, 0);
  };

  const renderTimes = [];
  const frameTimes = [];
  const start = performance.now();
  let last = start;
  show(`${backend}: warming up...`);
  await new Promise((resolve) => {
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const elapsed = (now - start) / 1000;
      placeCamera(elapsed);
      const before = performance.now();
      renderer.render(scene, camera);
      const renderMs = performance.now() - before;
      if (elapsed > WARMUP_SECONDS) {
        renderTimes.push(renderMs);
        frameTimes.push(now - last);
      }
      last = now;
      if (elapsed > WARMUP_SECONDS + seconds) {
        renderer.setAnimationLoop(null);
        resolve();
      }
    });
  });

  const render = summarize(renderTimes);
  const frame = summarize(frameTimes);
  const result = {
    mode, backend, world: hash, frames: frameTimes.length, meshes, hidden,
    fps: 1000 / frame.mean, renderMs: render, frameMs: frame, userAgent: navigator.userAgent,
  };
  window.benchResult = result;
  const ms = (s) => `mean ${s.mean.toFixed(2)}  p50 ${s.p50.toFixed(2)}  p95 ${s.p95.toFixed(2)}  max ${s.max.toFixed(1)}`;
  show([
    `${backend}  world ${hash}  ${meshes} meshes (${hidden} GLSL-only hidden)`,
    `${result.frames} frames over ${seconds}s, ${result.fps.toFixed(1)} fps`,
    `render() CPU ms  ${ms(render)}`,
    `frame interval   ${ms(frame)}`,
  ].join('\n'));
  console.log('benchResult', JSON.stringify(result));
}

main().catch((error) => {
  show(`bench failed: ${error.message}`);
  console.error(error);
});
