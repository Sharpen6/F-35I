// Cloud shadows for three.js's own lit materials (MeshStandard / Physical / Lambert / Phong /
// Toon: the jet, the cockpit, buildings and anything else built on them).
//
// The terrain, the roads and the vegetation shaders take the cumulus' shadow from the atmosphere
// code (atmoCloudShadow in atmosphereGLSL.js). three's materials have no such hook, so before this
// the whole directional light was dimmed by the shadow at the jet's position: the jet under a
// cloud darkened every building in the sunshine around it, and the jet in the sun lit everything
// that stood in a cloud's shadow. Here three's light loop gets one more factor: each fragment's
// directional light is multiplied by the transmittance of the cumulus field along the light's
// ray, at the fragment's own world position, with the same field (the same GLSL, from
// js/env/cloudField.js cloudFieldGLSL, and threshold) as the terrain's shadows and the CPU twin.
//
// The uniforms (csCloudLayer, csCloudWind, csCloudCov) carry their own names so no shader that
// also includes the atmosphere code can clash with them. Their values are shared Float32Arrays: three clones a
// material's uniforms from ShaderLib, but keeps typed arrays by reference, so writing the arrays
// once a frame (Environment.update) reaches every material. A ShaderMaterial that uses three's
// light chunks without these uniforms reads zeros: no shadow, never a broken shader.

import * as THREE from 'three';
import { cloudFieldGLSL, EDGE } from './cloudField.js';

/** base, top (m MSL), field threshold, optical depth (0: no clouds): Environment's uCloudLayer. */
export const CLOUD_SHADOW_LAYER = new Float32Array(4);
/** field offset x, z (m), the big cells' size (m), -: Environment's uCloudWind. */
export const CLOUD_SHADOW_WIND = new Float32Array([0, 0, 4500, 0]);
/** coverage over the land, over the sea, streets, vertical development: Environment's uCloudField. */
export const CLOUD_SHADOW_FIELD = new Float32Array([0.12, 0.12, 0, 1]);

const PARS = /* glsl */`
#if NUM_DIR_LIGHTS > 0
#define CS_CLOUD_SHADOW
uniform vec4 csCloudLayer;
uniform vec4 csCloudWind;
uniform vec4 csCloudCov;
${cloudFieldGLSL('cs', 'csCloudLayer', 'csCloudWind', 'csCloudCov')}
// transmittance of the cumulus layer towards a directional light, at a view-space position
// (one return: ANGLE's HLSL warns X4000 on an early one)
float csCloudShadow(vec3 viewPos, vec3 viewLightDir) {
  float s = 1.0;
  vec3 wp = ((vec4(viewPos, 1.0) - viewMatrix[3]) * viewMatrix).xyz;
  if (csCloudLayer.w > 0.0 && wp.y <= csCloudLayer.y) {
    vec3 L = (vec4(viewLightDir, 0.0) * viewMatrix).xyz;
    float mid = 0.5 * (csCloudLayer.x + csCloudLayer.y);
    vec2 xz = wp.xz + L.xz * ((mid - wp.y) / max(L.y, 0.06));
    float v = csCloudField((xz + csCloudWind.xy) / csCloudWind.z);
    s = exp(-csCloudLayer.w * smoothstep(csCloudLayer.z, csCloudLayer.z + ${EDGE.toFixed(4)}, v));
  }
  return s;
}
#endif
`;

const CALL_FROM = 'getDirectionalLightInfo( directionalLight, directLight );';
const CALL_TO = `${CALL_FROM}
		#ifdef CS_CLOUD_SHADOW
		directLight.color *= csCloudShadow( geometryPosition, directLight.direction );
		#endif`;

let installed = false;

/** Patches three's light chunks and the lit materials' uniforms (once, before any compile). */
export function installCloudShadowChunk() {
  if (installed) return true;
  const C = THREE.ShaderChunk;
  if (!C.lights_fragment_begin.includes(CALL_FROM)) {
    console.warn('cloudShadowChunk: three.js light chunk changed; cloud shadows on standard materials are off');
    return false;
  }
  installed = true;
  C.lights_pars_begin += PARS;
  C.lights_fragment_begin = C.lights_fragment_begin.replace(CALL_FROM, CALL_TO);
  for (const k of ['standard', 'physical', 'lambert', 'phong', 'toon']) {
    const lib = THREE.ShaderLib[k];
    if (!lib) continue;
    lib.uniforms.csCloudLayer = { value: CLOUD_SHADOW_LAYER };
    lib.uniforms.csCloudWind = { value: CLOUD_SHADOW_WIND };
    lib.uniforms.csCloudCov = { value: CLOUD_SHADOW_FIELD };
  }
  return true;
}
