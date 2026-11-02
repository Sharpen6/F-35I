// Cloud shadows for three.js's own lit materials (MeshStandard / Physical / Lambert / Phong /
// Toon: the jet, the cockpit, buildings and anything else built on them).
//
// The terrain, the roads and the vegetation shaders take the cumulus' shadow from the atmosphere
// code (atmoCloudShadow in atmosphereGLSL.js). three's materials have no such hook, so before this
// the whole directional light was dimmed by the shadow at the jet's position: the jet under a
// cloud darkened every building in the sunshine around it, and the jet in the sun lit everything
// that stood in a cloud's shadow. Here three's light loop gets one more factor: each fragment's
// directional light is multiplied by the transmittance of the cumulus field along the light's
// ray, at the fragment's own world position, with the same field (same hash, octaves and
// threshold) as the terrain's shadows and the CPU twin js/env/cloudField.js.
//
// The uniforms (csCloudLayer, csCloudWind) carry their own names so no shader that also includes
// the atmosphere code can clash with them. Their values are shared Float32Arrays: three clones a
// material's uniforms from ShaderLib, but keeps typed arrays by reference, so writing the arrays
// once a frame (Environment.update) reaches every material. A ShaderMaterial that uses three's
// light chunks without these uniforms reads zeros: no shadow, never a broken shader.

import * as THREE from 'three';

/** base, top (m MSL), field threshold, optical depth (0: no clouds): Environment's uCloudLayer. */
export const CLOUD_SHADOW_LAYER = new Float32Array(4);
/** field offset x, z (m), feature scale (m), -: Environment's uCloudWind. */
export const CLOUD_SHADOW_WIND = new Float32Array([0, 0, 3000, 0]);

const PARS = /* glsl */`
#if NUM_DIR_LIGHTS > 0
#define CS_CLOUD_SHADOW
uniform vec4 csCloudLayer;
uniform vec4 csCloudWind;
float csHash2(ivec2 p) {
  uvec2 q = uvec2(p);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return float(h) * (1.0 / 4294967295.0);
}
float csNoise(vec2 x) {
  vec2 i = floor(x), f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  return mix(mix(csHash2(c), csHash2(c + ivec2(1, 0)), u.x), mix(csHash2(c + ivec2(0, 1)), csHash2(c + ivec2(1, 1)), u.x), u.y);
}
// transmittance of the cumulus layer towards a directional light, at a view-space position
float csCloudShadow(vec3 viewPos, vec3 viewLightDir) {
  if (csCloudLayer.w <= 0.0) return 1.0;
  vec3 wp = ((vec4(viewPos, 1.0) - viewMatrix[3]) * viewMatrix).xyz;
  if (wp.y > csCloudLayer.y) return 1.0;
  vec3 L = (vec4(viewLightDir, 0.0) * viewMatrix).xyz;
  float mid = 0.5 * (csCloudLayer.x + csCloudLayer.y);
  vec2 xz = wp.xz + L.xz * ((mid - wp.y) / max(L.y, 0.06));
  vec2 p = (xz + csCloudWind.xy) / csCloudWind.z;
  float v = 0.5 * csNoise(p) + 0.25 * csNoise(p * 2.03 + 17.1) + 0.125 * csNoise(p * 4.07 + 31.7) + 0.0625 * csNoise(p * 8.13 + 7.3);
  return exp(-csCloudLayer.w * smoothstep(csCloudLayer.z, csCloudLayer.z + 0.06, v / 0.9375));
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
  }
  return true;
}
