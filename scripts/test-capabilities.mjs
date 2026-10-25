#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import assert from 'node:assert/strict';
import {
  collectDeviceHints,
  detectRenderCapabilities,
  describeRenderCapabilities,
  supportsDynamicLighting,
  supportsProjectedShadows,
} from '../public/js/capabilities.mjs';

// A stand-in for the parts of a WebGL context the detection reads.
function fakeRenderer({ attributes = {}, parameters = {}, extensions = {}, webgl2 = true } = {}) {
  const names = {
    STENCIL_BITS: 'STENCIL_BITS',
    MAX_TEXTURE_SIZE: 'MAX_TEXTURE_SIZE',
    MAX_SAMPLES: 'MAX_SAMPLES',
    MAX_FRAGMENT_UNIFORM_VECTORS: 'MAX_FRAGMENT_UNIFORM_VECTORS',
  };
  const context = {
    ...names,
    getContextAttributes: () => attributes,
    getParameter: (name) => parameters[name] ?? null,
    getExtension: (name) => extensions[name] || null,
  };
  return { getContext: () => context, capabilities: { isWebGL2: webgl2 } };
}

const desktop = detectRenderCapabilities(fakeRenderer({
  attributes: { antialias: true, stencil: true },
  parameters: {
    STENCIL_BITS: 8,
    MAX_TEXTURE_SIZE: 16384,
    MAX_SAMPLES: 8,
    MAX_FRAGMENT_UNIFORM_VECTORS: 1024,
    VENDOR: 'NVIDIA Corporation',
    RENDERER: 'Tegra Orin',
  },
  extensions: {
    EXT_texture_filter_anisotropic: { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 'ANISO' },
    WEBGL_debug_renderer_info: {
      UNMASKED_VENDOR_WEBGL: 'VENDOR',
      UNMASKED_RENDERER_WEBGL: 'RENDERER',
    },
  },
}), { devicePixelRatio: 2, deviceMemory: 8, hardwareConcurrency: 16 });
assert.equal(desktop.webgl, true);
assert.equal(desktop.stencil, true);
assert.equal(desktop.maxTextureSize, 16384);
assert.equal(desktop.maxFragmentUniforms, 1024);
assert.equal(desktop.driverVendor, 'NVIDIA Corporation');
assert.equal(desktop.driverRenderer, 'Tegra Orin');
assert.equal(supportsProjectedShadows(desktop), true);
assert.equal(supportsDynamicLighting(desktop), true);

// A context asked for a stencil buffer and handed one with no bits cannot run
// the stencil shadow pass, however the attribute reads.
const noStencilBits = detectRenderCapabilities(fakeRenderer({
  attributes: { stencil: true },
  parameters: { STENCIL_BITS: 0, MAX_FRAGMENT_UNIFORM_VECTORS: 1024 },
}));
assert.equal(noStencilBits.stencil, false);
assert.equal(supportsProjectedShadows(noStencilBits), false);
assert.equal(supportsDynamicLighting(noStencilBits), true);

// Near the WebGL 1 floor, several point lights can fail to compile.
const tiny = detectRenderCapabilities(fakeRenderer({
  attributes: { stencil: true },
  parameters: { STENCIL_BITS: 8, MAX_FRAGMENT_UNIFORM_VECTORS: 224 },
  webgl2: false,
}));
assert.equal(tiny.webgl2, false);
assert.equal(supportsDynamicLighting(tiny), false);
assert.equal(supportsProjectedShadows(tiny), true);

// A driver that reports nothing must not read as a driver that reports zero.
const silent = detectRenderCapabilities(fakeRenderer({ attributes: {}, parameters: {} }));
assert.equal(silent.maxTextureSize, null);
assert.equal(silent.maxFragmentUniforms, null);
assert.equal(supportsDynamicLighting(silent), true);
assert.equal(supportsProjectedShadows(silent), false);

// No renderer at all: every feature answers no, and nothing throws.
const absent = detectRenderCapabilities(null);
assert.equal(absent.webgl, false);
assert.equal(supportsDynamicLighting(absent), false);
assert.equal(supportsProjectedShadows(absent), false);

const hints = collectDeviceHints({ devicePixelRatio: 3, navigator: { deviceMemory: 8, hardwareConcurrency: 4 } });
assert.deepEqual(hints, { devicePixelRatio: 3, deviceMemory: 8, hardwareConcurrency: 4 });
assert.deepEqual(
  collectDeviceHints({ devicePixelRatio: 0, navigator: {} }),
  { devicePixelRatio: null, deviceMemory: null, hardwareConcurrency: null },
);

assert.match(describeRenderCapabilities(desktop), /stencil=true/);
assert.match(describeRenderCapabilities(silent), /maxTextureSize=unknown/);
// A driver name has spaces, so it is quoted rather than run into the next pair.
assert.match(describeRenderCapabilities(desktop), /driverRenderer="Tegra Orin"/);
assert.match(describeRenderCapabilities(silent), /driverRenderer=unknown/);

console.log('render capability tests passed');
