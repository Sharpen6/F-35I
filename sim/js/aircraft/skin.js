// The jet's exterior in the light: the coating of the skin, and the jet's own sun shadow on every
// exterior part (exterior track; js/aircraft/README.md, "Exterior").
//
// Coating (F35_Skin_A, F35_Skin_B; three's MeshPhysicalMaterial, patched):
//   * two specular lobes: the satin coat's broad lobe (the atlases' roughness, ~0.54) and a weaker,
//     sharper one (SKIN.lobeRough): the "slimy" sheen of the real coating, which turns the top of the
//     jet into a dim mirror of the sky at grazing angles and keeps a soft hot spot towards the sun.
//     Both are filtered by the normal's variance across the pixel (specular anti-aliasing), so the
//     panel lines of the normal maps do not sparkle at a distance.
//   * a patchwork: each panel the caulk / tape lines enclose (skinTones.js) has its own small shift
//     of tone and sheen, one in eight clearly different (a re-coated door); a soft body-space mottle
//     (two octaves, 0.4 - 1.2 m) keeps the big uniform areas from looking like plastic;
//   * the caulk and tape lines a little lighter and duller, a faint grime halo along them;
//   * dead flat, darker leading edges (RAM): the surfaces facing forward;
//   * gun gas soot aft of the gun port and a slightly dirtier underside;
//   * metallic flakes (Have Glass): sparse sparkles in the sun's glint, only where a flake cell
//     (2.5 mm) covers more than a pixel: in the cockpit, on the nose and the wings; further away
//     they average into the lobes (nothing to shimmer).
// Jet shadow (every exterior material, the decals included): the sun's (or moon's) light on the jet
//   is multiplied by the jet's own shadow map (JetShadow.js: the aircraft alone, in its own frame,
//   ~8 mm texels, a bias of a few mm), in place of the scene's map, whose 0.8 m bias erased the
//   shadows of the canopy, the doors and every junction. The jet then casts no shadow into the
//   scene's map (Exterior.js): its shadow on the ground is drawn by JetShadow's ground pass.
//
// Everything is a uniform (no program variants by quality or state): built once at load, by the
// first frames that draw the jet. Body-space inputs come from uF35ViewToBody, made per camera in
// doubles (onBeforeRender), so no large world coordinates reach the GPU.

import * as THREE from 'three';

/** Coating constants (uniforms; Exterior.js and tests may change them at run time). */
export const SKIN = {
  lobe: 0.35,          // weight of the sharper lobe in the coat's specular
  lobeRough: 0.3,      // its roughness
  glitter: 0.6,        // flake sparkle (BRDF value of a lit flake cell, 1/sr)
  tone: 0.07,          // albedo shift of a panel at tone +-1 (replaced panels 0.65..1)
  mottle: 0.03,        // body-space mottle, albedo
  tape: 0.04,          // caulk / tape lines: extra albedo (the atlases have them +21 % already)
  ram: 0.13,           // leading edges: darker by
  grime: 0.05,         // halo along the panel lines and the underside, darker by
  soot: 0.55,          // gun soot at the port, darker by
};

/** The gun port (body frame, m; the rig's GunDoor) and the soot's extent aft, up, across. */
export const GUN = { pos: [-1.385, 0.59, -2.03], len: 1.5, h: 0.2, w: 0.22 };

/** Materials that keep their own shading: lenses and screens (lights.js, the cockpit). */
const NOT_EXTERIOR = /^(F35_(beacon|nav_red|nav_green|formation|landing_light|SwitchLED|PCD_Screen))(\.\d+)?$/;
const IS_SKIN = /^F35_Skin_[AB](\.\d+)?$/;

/** A depth texture with storage (three allocates it at first use): bound until the map exists. */
function placeholderDepth() {
  const t = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  t.compareFunction = THREE.LessEqualCompare;
  t.name = 'JetShadowPlaceholder';
  t.needsUpdate = true;
  return t;
}

/** A neutral panel-tone texture (tone and sheen 0) until the real one is built. */
function neutralTone() {
  const t = new THREE.DataTexture(new Uint8Array([128, 128]), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
  t.name = 'F35ToneNeutral';
  t.needsUpdate = true;
  return t;
}

/** Shared uniforms of one aircraft's exterior materials. */
export function exteriorUniforms() {
  return {
    uF35ViewToBody: { value: new THREE.Matrix4() },
    uF35Shadow: { value: placeholderDepth() },
    uF35ShadowMat: { value: new THREE.Matrix4() },
    // on (0/1), texel (m), depth range of the map (m), filter radius (texels)
    uF35ShadowP: { value: new THREE.Vector4(0, 0.01, 40, 1.5) },
    uF35Coat: { value: new THREE.Vector4(SKIN.lobe, SKIN.lobeRough, SKIN.glitter, 1) },
    uF35Var: { value: new THREE.Vector4(SKIN.tone, SKIN.mottle, SKIN.tape, SKIN.ram) },
    uF35Dirt: { value: new THREE.Vector4(SKIN.grime, SKIN.soot, 0, 0) },
    uF35Gun: { value: new THREE.Vector4(GUN.pos[0], GUN.pos[1], GUN.pos[2], 0) },
    uF35GunSize: { value: new THREE.Vector3(GUN.len, GUN.h, GUN.w) },
  };
}

// ------------------------------------------------------------------------------------- tone maps
const toneCache = new Map();      // material name -> { uniform-shared texture holder }
let toneWorker = null, toneJobs = 0;
const toneWaiters = new Map();

function startWorker() {
  if (toneWorker !== null) return toneWorker;
  try {
    toneWorker = new Worker(new URL('./skinWorker.js', import.meta.url), { type: 'module' });
    toneWorker.onmessage = (e) => {
      const w = toneWaiters.get(e.data.id);
      toneWaiters.delete(e.data.id);
      if (w) w(e.data);
      if (!toneWaiters.size && toneWorker) { toneWorker.terminate(); toneWorker = null; }
    };
    toneWorker.onerror = (e) => {
      console.warn('skin: tone worker failed', e.message || e);
      for (const w of toneWaiters.values()) w({ error: 'worker' });
      toneWaiters.clear();
      toneWorker = false;
    };
  } catch (e) {
    toneWorker = false;
  }
  return toneWorker;
}

async function buildTone(image) {
  const bitmap = await createImageBitmap(image);
  const worker = startWorker();
  if (worker) {
    const id = ++toneJobs;
    const r = await new Promise((resolve) => {
      toneWaiters.set(id, resolve);
      worker.postMessage({ id, bitmap, scale: 2 }, [bitmap]);
    });
    if (!r.error) return r;
  }
  // no worker: on this thread (a few hundred ms, once)
  const { panelTones } = await import('./skinTones.js');
  const c = new OffscreenCanvas(image.width, image.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0);
  return panelTones(g.getImageData(0, 0, image.width, image.height).data, image.width, image.height, 2);
}

/**
 * The panel-tone texture of a skin material (RG8: tone, sheen; the ORM's uv), as a uniform whose
 * value is neutral until the worker has segmented the ORM's caulk lines. One per material name:
 * the wingmen's jets share it.
 */
export function toneUniform(mat) {
  const key = mat.name.replace(/\.\d+$/, '');
  let entry = toneCache.get(key);
  if (entry) return entry.uniform;
  entry = { uniform: { value: neutralTone() }, ready: false };
  toneCache.set(key, entry);
  const img = mat.roughnessMap && mat.roughnessMap.image;
  if (img && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
    buildTone(img).then((r) => {
      const t = new THREE.DataTexture(r.data, r.width, r.height, THREE.RGFormat, THREE.UnsignedByteType);
      t.name = `F35Tone_${key}`;
      t.flipY = false;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = mat.roughnessMap.anisotropy || 1;
      t.unpackAlignment = 1;
      t.needsUpdate = true;
      const old = entry.uniform.value;
      entry.uniform.value = t;
      entry.ready = true;
      entry.regions = r.regions;
      old.dispose();
    }).catch((e) => console.warn('skin: panel tones not built:', e && e.message ? e.message : e));
  }
  return entry.uniform;
}

/** Panel tone state, for tests: { name: {ready, regions} }. */
export function toneStatus() {
  const o = {};
  for (const [k, v] of toneCache) o[k] = { ready: v.ready, regions: v.regions || 0 };
  return o;
}

// ------------------------------------------------------------------------------------------ GLSL
const VERT_PARS = /* glsl */`
uniform mat4 uF35ViewToBody;
varying vec3 vF35Body;
varying vec3 vF35BodyN;
`;

const VERT_MAIN = /* glsl */`
  vF35Body = (uF35ViewToBody * vec4(mvPosition.xyz, 1.0)).xyz;
  vF35BodyN = mat3(uF35ViewToBody) * transformedNormal;
`;

const FRAG_PARS = /* glsl */`
uniform mat4 uF35ViewToBody;
uniform sampler2DShadow uF35Shadow;
uniform mat4 uF35ShadowMat;
uniform vec4 uF35ShadowP;
varying vec3 vF35Body;
varying vec3 vF35BodyN;
#ifdef F35_SKIN
uniform sampler2D uF35Tone;
uniform vec4 uF35Coat;
uniform vec4 uF35Var;
uniform vec4 uF35Dirt;
uniform vec4 uF35Gun;
uniform vec3 uF35GunSize;
#endif
float f35Lobe = 0.0;            // the coat's sharper lobe: weight
float f35LobeRough = 0.3;       // and roughness (after the variance filter)
vec3 f35FlakeN = vec3(0.0, 0.0, 1.0);
float f35Flake = 0.0;           // flake sparkle at this fragment (0: none)

// the jet's own shadow (JetShadow.js): hardware 2x2 comparisons at 4 rotated taps
float f35JetShadow(vec3 viewPos, vec3 viewN, vec3 viewL) {
  float vis = 1.0;
  if (uF35ShadowP.x > 0.5) {
    float NdL = dot(viewN, viewL);
    // normal offset: more where the light grazes the surface
    vec3 p = viewPos + viewN * (uF35ShadowP.y * (0.7 + 1.3 * (1.0 - abs(NdL))));
    vec4 c = uF35ShadowMat * vec4(p, 1.0);
    vec3 s = c.xyz * 0.5 + 0.5;
    if (all(greaterThan(s.xy, vec2(0.0))) && all(lessThan(s.xy, vec2(1.0))) && s.z < 1.0) {
      float ref = s.z - 1.2 * uF35ShadowP.y / uF35ShadowP.z;
      vec2 r = vec2(uF35ShadowP.w / float(textureSize(uF35Shadow, 0).x));
      float a = 0.0;
      a += texture(uF35Shadow, vec3(s.xy + vec2( 0.6,  0.8) * r, ref));
      a += texture(uF35Shadow, vec3(s.xy + vec2(-0.8,  0.6) * r, ref));
      a += texture(uF35Shadow, vec3(s.xy + vec2(-0.6, -0.8) * r, ref));
      a += texture(uF35Shadow, vec3(s.xy + vec2( 0.8, -0.6) * r, ref));
      vis = 0.25 * a;
    }
  }
  return vis;
}

#ifdef F35_SKIN
uint f35HashU(uvec3 q) {
  uint h = q.x * 1597334677u ^ q.y * 3812015801u ^ q.z * 2798796415u;
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}
float f35Hash(vec3 p) {
  return float(f35HashU(uvec3(ivec3(p) + 4096))) * (1.0 / 4294967295.0);
}
float f35Noise(vec3 x) {
  vec3 i = floor(x), f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(f35Hash(i), f35Hash(i + vec3(1, 0, 0)), f.x),
                 mix(f35Hash(i + vec3(0, 1, 0)), f35Hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(f35Hash(i + vec3(0, 0, 1)), f35Hash(i + vec3(1, 0, 1)), f.x),
                 mix(f35Hash(i + vec3(0, 1, 1)), f35Hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
#endif
`;

// after metalnessmap_fragment: albedo, roughness, the lobe (skin only)
const FRAG_COAT = /* glsl */`
#ifdef F35_SKIN
{
  float g = texelRoughness.g;
  float tape = smoothstep(0.56, 0.68, g);
  // the lines' halo: the line mask blurred (two mip levels up) less the line itself
  float gb = texture(roughnessMap, vRoughnessMapUv, 2.5).g;
  float halo = clamp(smoothstep(0.47, 0.6, gb) - tape, 0.0, 1.0);
  vec2 tn = texture2D(uF35Tone, vRoughnessMapUv).rg * 2.0 - 1.0;
  vec3 nb = normalize(vF35BodyN);
  float m = 0.65 * f35Noise(vF35Body * 0.85) + 0.35 * f35Noise(vF35Body * 2.4 + 7.1);
  m = m * 2.0 - 1.0;
  // leading edges (RAM): facing forward (-z body)
  float ram = smoothstep(0.55, 0.9, -nb.z);
  // gun gas soot: from the port aft (+z) along the side
  vec3 gd = vF35Body - uF35Gun.xyz;
  float ga = gd.z > 0.0 ? gd.z / uF35GunSize.x : -gd.z / (0.25 * uF35GunSize.x);
  float soot = exp(-(ga * ga + pow2(gd.y / uF35GunSize.y) + pow2(gd.x / uF35GunSize.z)) * 2.0);
  float under = smoothstep(-0.2, -0.8, nb.y);
  float tone = uF35Var.x * tn.x + uF35Var.y * m;
  diffuseColor.rgb *= (1.0 + tone) * vec3(1.0 + 0.3 * tone, 1.0, 1.0 - 0.3 * tone);
  diffuseColor.rgb *= (1.0 + uF35Var.z * tape) * (1.0 - uF35Var.w * ram);
  diffuseColor.rgb *= (1.0 - uF35Dirt.x * (0.4 * halo + 0.8 * under)) * (1.0 - uF35Dirt.y * soot);
  roughnessFactor = min(roughnessFactor * (1.0 + 0.06 * tn.y + 0.2 * ram + 0.25 * soot), 1.0);
  f35Lobe = uF35Coat.x * clamp(1.0 + 0.6 * tn.y + 0.4 * m, 0.25, 1.9);
  f35Lobe *= (1.0 - 0.85 * tape) * (1.0 - 0.85 * ram) * (1.0 - soot) * (1.0 - 0.3 * under);
  f35LobeRough = uF35Coat.y;
  // metallic flakes: one per 2.5 mm cell, a random tilt of up to ~11 deg, seen where a cell covers
  // more than a pixel
  const float CELL = 0.0025;
  vec3 pc = vF35Body / CELL;
  vec3 ic = floor(pc);
  uint hh = f35HashU(uvec3(ivec3(ic) + 65536));
  vec3 h3 = vec3(float(hh & 1023u), float((hh >> 10u) & 1023u), float((hh >> 20u) & 1023u)) / 1023.0;
  float inFlake = 1.0 - smoothstep(0.16, 0.28, length(pc - ic - (0.25 + 0.5 * h3)));
  float fp = length(fwidth(vF35Body));
  f35Flake = inFlake * (1.0 - smoothstep(0.5 * CELL, 1.2 * CELL, fp)) * (1.0 - tape) * (1.0 - ram) * (1.0 - soot);
  float ang = 6.2831853 * h3.x, mag = 0.19 * sqrt(h3.y);
  f35FlakeN = vec3(cos(ang) * mag, sin(ang) * mag, 1.0);     // tangent space (made view space below)
}
#endif
`;

// after normal_fragment_maps: the variance filter (specular anti-aliasing) and the flake normal
const FRAG_NORMAL = /* glsl */`
#ifdef F35_SKIN
{
  vec3 dndx = dFdx(normal), dndy = dFdy(normal);
  float k = min(0.5 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18);
  f35LobeRough = sqrt(f35LobeRough * f35LobeRough + k);
  vec3 t = normalize(cross(abs(normal.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), normal));
  vec3 b = cross(normal, t);
  f35FlakeN = normalize(t * f35FlakeN.x + b * f35FlakeN.y + normal);
}
#endif
`;

// after lights_physical_fragment: the variance filter on the broad lobe too
const FRAG_MATERIAL = /* glsl */`
#ifdef F35_SKIN
{
  vec3 dndx = dFdx(normal), dndy = dFdy(normal);
  float k = min(0.5 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18);
  material.roughness = min(sqrt(material.roughness * material.roughness + k), 1.0);
}
#endif
`;

// after lights_physical_pars_fragment: the direct light with the second lobe and the flakes
const FRAG_DIRECT = /* glsl */`
void RE_Direct_F35( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 s0 = reflectedLight.directSpecular;
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  #ifdef F35_SKIN
    float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
    vec3 irr = dotNL * directLight.color;
    PhysicalMaterial m2 = material;
    m2.roughness = f35LobeRough;
    vec3 s2 = irr * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, m2 );
    reflectedLight.directSpecular = s0 + mix( reflectedLight.directSpecular - s0, s2, f35Lobe );
    // a lit flake: its tilted normal on the half vector, within the sun's disc and a little more
    float dh = dot( f35FlakeN, normalize( directLight.direction + geometryViewDir ) );
    reflectedLight.directSpecular += irr * ( uF35Coat.z * f35Flake * exp( ( dh - 1.0 ) * 7000.0 ) );
  #endif
}
#undef RE_Direct
#define RE_Direct RE_Direct_F35
`;

// after lights_fragment_maps: the image-based light of the sharper lobe
const FRAG_IBL = /* glsl */`
#if defined( F35_SKIN ) && defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance = mix( radiance, getIBLRadiance( geometryViewDir, geometryNormal, f35LobeRough ), f35Lobe );
#endif
`;

const DIR_FROM = 'getDirectionalLightInfo( directionalLight, directLight );';
// the sun (the shadow-casting directional light comes first: three sorts it so)
const DIR_TO = `${DIR_FROM}
		directLight.color *= ( UNROLLED_LOOP_INDEX == 0 ) ? f35Sh : 1.0;`;

const SHADOW_EVAL = /* glsl */`
  float f35Sh = 1.0;
  #if NUM_DIR_LIGHTS > 0
    f35Sh = f35JetShadow( - vViewPosition, normalize( nonPerturbedNormal ), directionalLights[ 0 ].direction );
  #endif
`;

/** Is this material one of the jet's exterior surfaces (the receivers of the jet's shadow)? */
export function isExterior(mat, cockpitRe) {
  if (!mat || mat.isShaderMaterial || !(mat.isMeshStandardMaterial)) return false;
  if ((mat.transmission || 0) > 0) return false;
  if (NOT_EXTERIOR.test(mat.name)) return false;
  if (cockpitRe && cockpitRe.test(mat.name)) return false;
  return true;
}

export function isSkin(mat) { return IS_SKIN.test(mat.name); }

/**
 * Patch an exterior material (once): the jet shadow, and on the skin the coating.
 * @param {THREE.MeshStandardMaterial} mat
 * @param {object} U exteriorUniforms()
 * @param {function} addPatch materials.js's patch chain (mat, key, fn)
 */
export function patchExterior(mat, U, addPatch) {
  const skin = isSkin(mat) && !!mat.roughnessMap;
  const tone = skin ? toneUniform(mat) : null;
  if (skin) {
    mat.defines = mat.defines || {};
    mat.defines.F35_SKIN = '';
  }
  addPatch(mat, skin ? 'f35skin' : 'f35ext', (sh) => {
    for (const k of Object.keys(U)) sh.uniforms[k] = U[k];
    if (tone) sh.uniforms.uF35Tone = tone;
    const lfb = THREE.ShaderChunk.lights_fragment_begin;
    if (!lfb.includes(DIR_FROM)) console.warn('skin: three.js light chunk changed; no jet shadow');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FRAG_COAT}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${FRAG_MATERIAL}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${FRAG_DIRECT}`)
      .replace('#include <lights_fragment_begin>', `${SHADOW_EVAL}\n${lfb.replace(DIR_FROM, DIR_TO)}`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${FRAG_IBL}`);
  });
}

const _m = new THREE.Matrix4();

/**
 * Per draw: the view -> body matrix (and the shadow lookup) for the camera of this render call,
 * made once per call in doubles. Installed as the exterior materials' onBeforeRender.
 * @param {object} U exteriorUniforms()
 * @param {THREE.Object3D} body the aircraft's body-frame group
 * @param {object} state {frame, camera, shadowFromBody: Matrix4|null}
 */
export function viewHook(U, body, state) {
  return (renderer, scene, camera) => {
    const f = renderer.info.render.frame;
    if (state.frame === f && state.camera === camera) return;
    state.frame = f;
    state.camera = camera;
    // view -> world -> body
    _m.copy(body.matrixWorld).invert().multiply(camera.matrixWorld);
    U.uF35ViewToBody.value.copy(_m);
    if (state.shadowFromBody) U.uF35ShadowMat.value.multiplyMatrices(state.shadowFromBody, _m);
  };
}
