/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// What the machine in front of us can actually do, read from the renderer's
// own WebGL context. No Three.js import and no probe canvas: a second context
// is a real cost on a phone, and some drivers hand back a lost one.
//
// This answers "is the feature possible here", never "is it fast enough here".
// Cost belongs to a render-level policy we have not measured yet; see AGENTS.md.

// Three.js spends fragment uniform vectors per light, so a context near the
// WebGL 1 floor of 224 can fail to compile a scene lit by several point lights
// at once. Well above the floor, and far below what any current GPU reports.
const DYNAMIC_LIGHTING_MIN_FRAGMENT_UNIFORMS = 256;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function collectDeviceHints(environment = globalThis) {
  const navigatorRef = environment?.navigator;
  return {
    devicePixelRatio: finitePositive(environment?.devicePixelRatio),
    deviceMemory: finitePositive(navigatorRef?.deviceMemory),
    hardwareConcurrency: finitePositive(navigatorRef?.hardwareConcurrency),
  };
}

export function detectRenderCapabilities(renderer, hints = collectDeviceHints()) {
  const context = renderer?.getContext?.();
  const attributes = context?.getContextAttributes?.() || {};
  const parameter = (name) => (
    context && context[name] !== undefined ? finitePositive(context.getParameter(context[name])) : null
  );

  const anisotropic = context?.getExtension?.('EXT_texture_filter_anisotropic')
    || context?.getExtension?.('WEBKIT_EXT_texture_filter_anisotropic');
  // Whether the frame can be timed on the GPU at all. Every experiment so far
  // has hit the same wall: `outside` covers the GPU still working and the wait
  // for the display together, and nothing in JS can tell those apart. This
  // extension can. Probing enables it, which costs nothing while nothing uses
  // it.
  const timerQuery = context?.getExtension?.('EXT_disjoint_timer_query_webgl2')
    || context?.getExtension?.('EXT_disjoint_timer_query');

  // Which driver answered. This is identity, not capability, and it is here for
  // one reason: a frame rate means something entirely different when the string
  // says llvmpipe or SwiftShader than when it names a GPU, and every launch
  // already logs this line. A browser may withhold the extension, which reads
  // as unknown rather than as software.
  const driverInfo = context?.getExtension?.('WEBGL_debug_renderer_info');
  const driverString = (name) => {
    if (!driverInfo || driverInfo[name] === undefined) return null;
    const value = context.getParameter(driverInfo[name]);
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  return {
    webgl: Boolean(context),
    webgl2: Boolean(renderer?.capabilities?.isWebGL2),
    antialias: Boolean(attributes.antialias),
    // A context can be created with a stencil buffer and still be handed one
    // with no bits, which is the case the stencil shadow pass cannot survive.
    stencil: Boolean(attributes.stencil) && (parameter('STENCIL_BITS') || 0) > 0,
    timerQuery: Boolean(timerQuery),
    maxTextureSize: parameter('MAX_TEXTURE_SIZE'),
    maxSamples: parameter('MAX_SAMPLES') || 0,
    maxFragmentUniforms: parameter('MAX_FRAGMENT_UNIFORM_VECTORS'),
    maxAnisotropy: anisotropic
      ? (finitePositive(context.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 0)
      : 0,
    driverVendor: driverString('UNMASKED_VENDOR_WEBGL'),
    driverRenderer: driverString('UNMASKED_RENDERER_WEBGL'),
    devicePixelRatio: hints.devicePixelRatio || 1,
    deviceMemory: hints.deviceMemory,
    hardwareConcurrency: hints.hardwareConcurrency,
  };
}

export function supportsProjectedShadows(capabilities) {
  return Boolean(capabilities?.stencil);
}

export function supportsDynamicLighting(capabilities) {
  if (!capabilities?.webgl) return false;
  const uniforms = capabilities.maxFragmentUniforms;
  return uniforms === null || uniforms >= DYNAMIC_LIGHTING_MIN_FRAGMENT_UNIFORMS;
}

// One line for server.log: the headsets and phones this has to run on have no
// console worth reading.
export function describeMeasurements(values) {
  return Object.entries(values)
    .map(([key, value]) => {
      if (value === null) return `${key}=unknown`;
      // A driver name has spaces in it, and the line has to stay readable as
      // pairs.
      const text = String(value);
      return `${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`;
    })
    .join(' ');
}

export function describeRenderCapabilities(capabilities) {
  return describeMeasurements(capabilities);
}
