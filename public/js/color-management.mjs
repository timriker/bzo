/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Lighting in display space, as upstream's fixed-function OpenGL does it: a
// map's colours, its lights and its textures are all the numbers the screen
// shows, multiplied and added as they are. Three's default lights in linear
// space and encodes for the screen afterwards, which lifts every shaded face
// toward the lit one -- an ambient of 0.35 reads as 0.63 -- and washes the
// world out against BZFlag's.
//
// Three's lighting also divides diffuse by pi and normalizes its Blinn-Phong
// highlight, where GL's is plain `diffuse * (ambient + light * N.L)` and
// `specular * (N.H)^shininess` (`OpenGLMaterial`, the GL 1.x lighting model).
// Both are put back to GL's below, so a light of 1 lights a face fully. GL
// also clamps the lit colour to 1 before the texture modulates it, so a sun
// over an ambient never pushes a texture past its own pixels; Lambert and
// Phong clamp the same way here, against the texel the map gave.
//
// So no colour is converted on the way in (`ColorManagement`), no texture is
// marked sRGB to be decoded, and nothing is encoded on the way out
// (`DISPLAY_OUTPUT_COLOR_SPACE`, each renderer's `outputColorSpace`).
// Imported first by client.js, ahead of any module that makes a
// `THREE.Color` at load.

import * as THREE from 'three';

THREE.ColorManagement.enabled = false;

export const DISPLAY_OUTPUT_COLOR_SPACE = THREE.LinearSRGBColorSpace;

function patchChunk(name, from, to) {
  if (!THREE.ShaderChunk[name].includes(from)) throw new Error(`three's ${name} chunk has changed`);
  THREE.ShaderChunk[name] = THREE.ShaderChunk[name].replace(from, to);
}
patchChunk('common', 'return RECIPROCAL_PI * diffuseColor;', 'return diffuseColor;');
patchChunk('bsdfs', 'return F * ( G * D );', 'return specularColor * pow( dotNH, shininess );');

// `glTexel`: what the map contributed, taken before vertex colours, which GL
// counts as the material's own colour.
const TEXEL = '#include <map_fragment>\n\tvec3 glTexel = diffuseColor.rgb / max( diffuse, vec3( 1e-4 ) );';
function patchLitShader(name, from, to) {
  const lib = THREE.ShaderLib[name];
  if (!lib.fragmentShader.includes(from) || !lib.fragmentShader.includes('#include <map_fragment>')) {
    throw new Error(`three's ${name} shader has changed`);
  }
  lib.fragmentShader = lib.fragmentShader.replace('#include <map_fragment>', TEXEL).replace(from, to);
}
patchLitShader('lambert',
  'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
  'vec3 outgoingLight = min( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance, glTexel );');
patchLitShader('phong',
  'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;',
  'vec3 outgoingLight = min( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance, glTexel ) + reflectedLight.directSpecular + reflectedLight.indirectSpecular;');
