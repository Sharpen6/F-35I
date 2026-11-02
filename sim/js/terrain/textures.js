// GPU textures for the terrain: integer height and land cover grids, normal maps rendered
// from the heights. The generated ground textures are in detailTextures.js. Nothing here is
// downloaded except the data in data/terrain/.
//
// Sampler budget: Direct3D 11 (ANGLE on Windows) has 16 texture units per shader stage and
// three.js counts the vertex and fragment samplers of a program together, so the terrain
// packs grids that are read with texelFetch into shared textures:
//   heights      R16UI  6146 x 4097: core 4097^2 at x 0..4096, far 2049^2 at x 4097..6145,
//                       the rift strip (optional, HeightField.setRift) 2049 x 2048 under the far
//                       grid at x 4097..6145, y 2049..4096
//   land cover   R8UI   4096 x 6144: overview 4096^2 at y 0..4095, far 2048^2 at y 4096..6143

import * as THREE from 'three';
import { CORE_N, FAR_N } from './HeightField.js';

export const HEIGHT_PACK_W = CORE_N + FAR_N;   // 6146
export const HEIGHT_PACK_H = CORE_N;           // 4097
export const FAR_HEIGHT_X = CORE_N;            // far grid's column offset
export const RIFT_HEIGHT_Y = FAR_N;            // the rift strip's row offset (same columns as the far grid)
export const RIFT_MAX_N = [HEIGHT_PACK_W - FAR_HEIGHT_X, HEIGHT_PACK_H - FAR_N];   // 2049 x 2048
export const LC_OV_N = 4096;
export const LC_FAR_N = 2048;
export const LC_FAR_Y = LC_OV_N;               // far land cover's row offset

function intTexture(data, w, h, format, type, internal, align) {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.internalFormat = internal;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = align;
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** R16UI height grid (n x n), exact integer samples for texelFetch. */
export function makeHeightTexture(u16, n) {
  return intTexture(u16, n, n, THREE.RedIntegerFormat, THREE.UnsignedShortType, 'R16UI', 2);
}

/**
 * Core and far heights in one R16UI texture (layout above). The packed copy is only needed
 * for the upload: call releasePacked(texture) after renderer.initTexture(texture).
 */
export function makePackedHeightTexture(core, far, rift = null, riftInfo = null) {
  const W = HEIGHT_PACK_W, H = HEIGHT_PACK_H;
  const data = new Uint16Array(W * H);
  for (let j = 0; j < CORE_N; j++) data.set(core.subarray(j * CORE_N, (j + 1) * CORE_N), j * W);
  for (let j = 0; j < FAR_N; j++) data.set(far.subarray(j * FAR_N, (j + 1) * FAR_N), j * W + FAR_HEIGHT_X);
  if (rift) {
    const { nx, nz } = riftInfo;
    if (nx > RIFT_MAX_N[0] || nz > RIFT_MAX_N[1]) throw new Error(`rift strip ${nx} x ${nz} does not fit`);
    for (let j = 0; j < nz; j++) data.set(rift.subarray(j * nx, (j + 1) * nx), (RIFT_HEIGHT_Y + j) * W + FAR_HEIGHT_X);
  }
  const t = intTexture(data, W, H, THREE.RedIntegerFormat, THREE.UnsignedShortType, 'R16UI', 2);
  t.name = 'TerrainHeights';
  return t;
}

/** Overview and far land cover codes in one R8UI texture (layout above). */
export function makePackedCodeTexture(ov, far) {
  const W = LC_OV_N, H = LC_OV_N + LC_FAR_N;
  const data = new Uint8Array(W * H);
  data.set(ov.subarray(0, LC_OV_N * LC_OV_N), 0);
  for (let j = 0; j < LC_FAR_N; j++) data.set(far.subarray(j * LC_FAR_N, (j + 1) * LC_FAR_N), (LC_FAR_Y + j) * W);
  const t = intTexture(data, W, H, THREE.RedIntegerFormat, THREE.UnsignedByteType, 'R8UI', 1);
  t.name = 'TerrainLandCover';
  return t;
}

/** R8UI land cover codes (w x h). */
export function makeCodeTexture(u8, w, h) {
  return intTexture(u8, w, h, THREE.RedIntegerFormat, THREE.UnsignedByteType, 'R8UI', 1);
}

/** R16UI tile data (class, row direction, region random; see fieldAnalysis.js), n x n. */
export function makeTileDataTexture(u16, n) {
  const t = intTexture(u16, n, n, THREE.RedIntegerFormat, THREE.UnsignedShortType, 'R16UI', 2);
  t.name = 'TerrainTileData';
  return t;
}

/**
 * Drops the CPU copy of an uploaded data texture (the GPU keeps it). Keeps width / height
 * so the memory estimate in js/test/stats.js still counts it.
 */
export function releasePacked(t) {
  const { width, height } = t.image;
  t.image = { data: null, width, height };
  t.source.data = t.image;
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
export function runPass(renderer, material, target) {
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
 * The far normal map: 2049 columns, the far grid's normals (200 m) in rows 0..2048 and, with
 * the rift strip, its normals (50 m) in the rows under them (texel (i, 2049 + j) = strip sample
 * (i, j)): the same place the strip has in the packed height texture, one sampler for both
 * (riftGLSL.js reads them). Like renderNormalMap otherwise.
 */
export function renderFarNormalMap(renderer, heightTex, anisotropy, riftRows = 0) {
  const float = floatTargetsSupported(renderer);
  const rows = FAR_N + riftRows;
  const rt = new THREE.WebGLRenderTarget(FAR_N, rows, {
    type: float ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: float ? THREE.RGFormat : THREE.RGBAFormat,
    depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  rt.texture.anisotropy = anisotropy;
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.name = 'TerrainNormalFar';
  const mat = new THREE.ShaderMaterial({
    uniforms: { uH: { value: heightTex }, uX0: { value: FAR_HEIGHT_X }, uRows: { value: riftRows } },
    defines: float ? {} : { ENCODE_UNORM: 1 },
    vertexShader: PASS_VERT,
    fragmentShader: /* glsl */ `
      uniform highp usampler2D uH;
      uniform int uX0;
      uniform int uRows;
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        // the block this texel is in: the far grid (rows 0..2048, 200 m) or the strip (50 m)
        bool strip = p.y >= ${FAR_N};
        int y0 = strip ? ${FAR_N} : 0;
        int y1 = strip ? ${FAR_N} + uRows - 1 : ${FAR_N - 1};
        float spacing = strip ? 50.0 : 200.0;
        int il = max(p.x - 1, 0), ir = min(p.x + 1, ${FAR_N - 1}), ju = max(p.y - 1, y0), jd = min(p.y + 1, y1);
        float hl = float(texelFetch(uH, ivec2(uX0 + il, p.y), 0).r) * 0.05;
        float hr = float(texelFetch(uH, ivec2(uX0 + ir, p.y), 0).r) * 0.05;
        float hu = float(texelFetch(uH, ivec2(uX0 + p.x, ju), 0).r) * 0.05;
        float hd = float(texelFetch(uH, ivec2(uX0 + p.x, jd), 0).r) * 0.05;
        float dhdx = (hr - hl) / (float(ir - il) * spacing);
        float dhdz = (hd - hu) / (float(jd - ju) * spacing);
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

/**
 * Normal map (n x n) of the n x n height grid at column offset x0 of an R16UI height
 * texture, sample spacing in metres: RG = normal x and z (RG16F, or RGBA8 encoded
 * * 0.5 + 0.5 when float targets are unavailable). Texel (i, j) is the normal at sample
 * (i, j); mipmapped for distant shading.
 */
export function renderNormalMap(renderer, heightTex, n, spacing, anisotropy, x0 = 0) {
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
    uniforms: { uH: { value: heightTex }, uN: { value: n }, uSpacing: { value: spacing }, uX0: { value: x0 } },
    defines: float ? {} : { ENCODE_UNORM: 1 },
    vertexShader: PASS_VERT,
    fragmentShader: /* glsl */ `
      uniform highp usampler2D uH;
      uniform float uN;
      uniform float uSpacing;
      uniform int uX0;
      float h(ivec2 p) {
        int m = int(uN) - 1;
        return float(texelFetch(uH, clamp(p, ivec2(0), ivec2(m)) + ivec2(uX0, 0), 0).r) * 0.05;
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
