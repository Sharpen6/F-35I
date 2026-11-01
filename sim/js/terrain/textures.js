// GPU textures for the terrain: integer height and land cover grids, normal maps rendered
// from the heights, and textures generated at startup (detail, water waves, runway digits).
// Nothing here is downloaded except the data in data/terrain/.

import * as THREE from 'three';

/** R16UI height grid (n x n), exact integer samples for texelFetch in the vertex shader. */
export function makeHeightTexture(u16, n) {
  const t = new THREE.DataTexture(u16, n, n, THREE.RedIntegerFormat, THREE.UnsignedShortType);
  t.internalFormat = 'R16UI';
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 2;
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** R8UI land cover codes (w x h). */
export function makeCodeTexture(u8, w, h) {
  const t = new THREE.DataTexture(u8, w, h, THREE.RedIntegerFormat, THREE.UnsignedByteType);
  t.internalFormat = 'R8UI';
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** sRGB colour texture from an ImageBitmap (row 0 = north = v 0), mipmapped, anisotropic. */
export function makeColorTexture(bitmap, anisotropy) {
  const t = new THREE.Texture(bitmap);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------
// full-screen passes

const PASS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

let _passScene = null, _passMesh = null, _passCam = null;
function runPass(renderer, material, target) {
  if (!_passScene) {
    _passScene = new THREE.Scene();
    _passMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    _passMesh.frustumCulled = false;
    _passScene.add(_passMesh);
    _passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  _passMesh.material = material;
  const prev = renderer.getRenderTarget();
  const prevXr = renderer.xr.enabled;
  renderer.xr.enabled = false;
  renderer.setRenderTarget(target);
  renderer.render(_passScene, _passCam);
  renderer.setRenderTarget(prev);
  renderer.xr.enabled = prevXr;
}

export function floatTargetsSupported(renderer) {
  return renderer.extensions.has('EXT_color_buffer_float');
}

/**
 * Normal map (n x n) of an R16UI height texture with sample spacing in metres: RG = normal
 * x and z (RG16F, or RGBA8 encoded * 0.5 + 0.5 when float targets are unavailable).
 * Texel (i, j) is the normal at sample (i, j); mipmapped for distant shading.
 */
export function renderNormalMap(renderer, heightTex, n, spacing, anisotropy) {
  const float = floatTargetsSupported(renderer);
  const rt = new THREE.WebGLRenderTarget(n, n, {
    type: float ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: float ? THREE.RGFormat : THREE.RGBAFormat,
    depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  rt.texture.anisotropy = anisotropy;
  rt.texture.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uH: { value: heightTex }, uN: { value: n }, uSpacing: { value: spacing } },
    defines: float ? {} : { ENCODE_UNORM: 1 },
    vertexShader: PASS_VERT,
    fragmentShader: /* glsl */ `
      uniform highp usampler2D uH;
      uniform float uN;
      uniform float uSpacing;
      float h(ivec2 p) {
        int m = int(uN) - 1;
        return float(texelFetch(uH, clamp(p, ivec2(0), ivec2(m)), 0).r) * 0.05;
      }
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        int m = int(uN) - 1;
        int il = max(p.x - 1, 0), ir = min(p.x + 1, m), ju = max(p.y - 1, 0), jd = min(p.y + 1, m);
        float dhdx = (h(ivec2(ir, p.y)) - h(ivec2(il, p.y))) / (float(ir - il) * uSpacing);
        float dhdz = (h(ivec2(p.x, jd)) - h(ivec2(p.x, ju))) / (float(jd - ju) * uSpacing);
        vec3 nrm = normalize(vec3(-dhdx, 1.0, -dhdz));
        #ifdef ENCODE_UNORM
          gl_FragColor = vec4(nrm.xz * 0.5 + 0.5, 0.0, 1.0);
        #else
          gl_FragColor = vec4(nrm.x, nrm.z, 0.0, 1.0);
        #endif
      }`,
    depthTest: false, depthWrite: false,
  });
  runPass(renderer, mat, rt);
  mat.dispose();
  return rt;
}

// periodic noise used by the generated textures
const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// value noise on a lattice that wraps every 'per' cells
float pnoise(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, per));
  float b = hash12(mod(i + vec2(1.0, 0.0), per));
  float c = hash12(mod(i + vec2(0.0, 1.0), per));
  float d = hash12(mod(i + vec2(1.0, 1.0), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 uv, float f, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    s += a * pnoise(uv * f, f);
    n += a; a *= 0.5; f *= 2.0;
  }
  return s / n;
}
// cellular noise (distance to the nearest feature point), periodic
vec2 pworley(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    vec2 g = vec2(float(xx), float(y));
    vec2 o = hash22(mod(i + g, per));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return vec2(d1, d2);
}
// cellular noise with the nearest cell's random value: (F1, F2, hash), periodic
vec3 pcell(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    vec2 g = vec2(float(xx), float(y));
    vec2 c = mod(i + g, per);
    vec2 o = hash22(c);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = hash12(c + 71.3); } else if (d < d2) { d2 = d; }
  }
  return vec3(d1, d2, id);
}
`;

/**
 * Detail texture, 1024^2 tiling over DETAIL_TILE_M metres, luminance patterns:
 * R: grass / crops / shrub micro variation, G: tree canopy, B: rock and bare soil,
 * A: built-up (roofs and yards). Mipmapped and anisotropic; the terrain shader subtracts
 * each channel's mean (the 1 x 1 mip level), so the detail never shifts the imagery's tone.
 */
export const DETAIL_TILE_M = 256;
export function makeDetailTexture(renderer, anisotropy) {
  const rt = new THREE.WebGLRenderTarget(1024, 1024, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
  });
  rt.texture.anisotropy = anisotropy;
  rt.texture.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    vertexShader: PASS_VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        vec2 uv = vUv;
        // R: fine vegetation texture: 4 m and 1 m grain plus 16 m patches
        float r = 0.55 * pfbm(uv, 64.0, 5) + 0.45 * pfbm(uv + 0.37, 16.0, 3);
        // G: canopy: crowns ~5 m with dark gaps
        vec2 w = pworley(uv * 52.0, 52.0);
        float crown = smoothstep(0.75, 0.15, w.x);
        float g = 0.18 + 0.75 * crown * (0.75 + 0.25 * pnoise(uv * 200.0, 200.0));
        g = mix(g, 0.5, 0.15) + 0.1 * (pfbm(uv, 32.0, 3) - 0.5);
        // B: rock and bare soil: ridged noise, stones and pebbles
        float rn = 1.0 - abs(2.0 * pfbm(uv + 0.11, 24.0, 5) - 1.0);
        vec3 st = pcell(uv * 160.0, 160.0);
        float stone = smoothstep(0.42, 0.18, st.x) * (0.4 + 0.6 * st.z);
        float b = 0.28 + 0.38 * rn + 0.16 * pnoise(uv * 256.0, 256.0) + 0.2 * stone;
        // A: built-up: soft blotches from 8 m down to 0.5 m (roofs, yards, paving, grime) with a
        // faint patchwork of ~2.5 m cells; no street grid, no outlines
        vec3 c2 = pcell(uv * 104.0, 104.0);
        float a = 0.5 + 0.7 * (pfbm(uv + 0.53, 32.0, 5) - 0.5) + 0.12 * (c2.z - 0.5);
        gl_FragColor = vec4(r, g, b, a);
      }`,
    depthTest: false, depthWrite: false,
  });
  runPass(renderer, mat, rt);
  mat.dispose();
  return rt;
}

/**
 * Tiling wave normal map (512^2): RG = surface slope x / z (* 0.5 + 0.5) of a few octaves of
 * periodic noise; B = foam-friendly crest mask. Sampled at several scales and drift
 * directions by the water shader.
 */
export function makeWaterNormalTexture(renderer, anisotropy) {
  const rt = new THREE.WebGLRenderTarget(512, 512, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
  });
  rt.texture.anisotropy = anisotropy;
  rt.texture.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    vertexShader: PASS_VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      ${NOISE_GLSL}
      float waves(vec2 uv) {
        // anisotropic: stretched across x like wind-driven wavelets
        float h = 0.0, a = 0.5, f = 6.0;
        for (int o = 0; o < 6; o++) {
          h += a * pnoise(vec2(uv.x * f, uv.y * f * 1.0) + float(o) * 0.31, f);
          a *= 0.55; f *= 2.0;
        }
        return h;
      }
      void main() {
        float e = 1.0 / 512.0;
        float hx1 = waves(vUv + vec2(e, 0.0)), hx0 = waves(vUv - vec2(e, 0.0));
        float hz1 = waves(vUv + vec2(0.0, e)), hz0 = waves(vUv - vec2(0.0, e));
        vec2 slope = vec2(hx1 - hx0, hz1 - hz0) / (2.0 * e) * 0.012;
        float crest = smoothstep(0.62, 0.8, waves(vUv));
        gl_FragColor = vec4(clamp(slope * 0.5 + 0.5, 0.0, 1.0), crest, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  runPass(renderer, mat, rt);
  mat.dispose();
  return rt;
}

/**
 * Runway designation glyphs "0123456789LRC" in one row (13 cells of 96 x 160 px), white on
 * black, in a heavy condensed sans like the painted ones. CanvasTexture, mipmapped.
 */
export const GLYPHS = '0123456789LRC';
export function makeDigitTexture(anisotropy) {
  const cw = 96, ch = 160;
  const canvas = document.createElement('canvas');
  canvas.width = cw * GLYPHS.length;
  canvas.height = ch;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < GLYPHS.length; i++) {
    g.save();
    g.translate(cw * (i + 0.5), ch * 0.5);
    g.scale(0.62, 1.0); // condensed: the painted numbers are tall and narrow
    g.font = `bold ${Math.round(ch * 1.12)}px "Arial Black", "Helvetica Neue", Arial, "DejaVu Sans", sans-serif`;
    g.fillText(GLYPHS[i], 0, ch * 0.04);
    g.restore();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
