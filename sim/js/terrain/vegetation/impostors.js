// Impostor atlas, rendered at start-up from the procedural meshes (no image files).
//
// Every model (species x variant) is drawn by an orthographic camera at ELEV_FRAMES view
// elevations, 0 (from the side) to 90 degrees (from above), into a square frame fitted to the
// model's bounding sphere about (0, 0.5, 0). Two outputs per frame: albedo + coverage, and
// normal (x, y in the frame's camera space) + depth (towards the camera, / sphere radius) +
// ambient occlusion. Frames are rendered at 2x and reduced on the CPU (antialiased coverage),
// the colour is dilated into the empty texels (no dark fringes when filtered) and the mip
// chain keeps each frame's coverage (Castano 2010), so distant trees keep their density.
//
// Result: two DataArrayTextures (layer = model * ELEV_FRAMES + frame), albedo sRGB.

import * as THREE from 'three';
import { BAKE_VERT, BAKE_FRAG, ELEV_FRAMES } from './shaders.js';

const SS = 2;   // supersampling of the bake

/**
 * models: [{geometry, info: {sphere}}] (species * VARIANTS + variant); spB: Vector4 array
 * (per species: fluff, ...); refHeights: metres per species (for the leaf noise scale).
 */
export function bakeImpostors(renderer, models, { size = 128, spB, refHeights, variants = 2 }) {
  const E = ELEV_FRAMES;
  const cell = size * SS;
  const W = cell * E, H = cell;
  const rt = new THREE.WebGLRenderTarget(W, H, {
    count: 2, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    name: 'VegetationBake',
    glslVersion: THREE.GLSL3,
    uniforms: { uRefHeight: { value: 10 }, uSphere: { value: 0.6 }, uSpB: { value: spB }, uSp: { value: 0 } },
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    side: THREE.FrontSide,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(models[0].geometry, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);

  const layers = models.length * E;
  const texels = size * size;
  const levels = Math.log2(size) + 1;
  const outA = [], outN = [];
  for (let l = 0, s = size; l < levels; l++, s >>= 1) {
    outA.push(new Uint8Array(s * s * 4 * layers));
    outN.push(new Uint8Array(s * s * 4 * layers));
  }
  const bufA = new Uint8Array(W * H * 4), bufN = new Uint8Array(W * H * 4);

  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevXr = renderer.xr.enabled;
  const prevAutoClear = renderer.autoClear;
  const prevShadow = renderer.shadowMap.autoUpdate;
  renderer.xr.enabled = false;
  renderer.autoClear = false;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);
  const C = new THREE.Vector3(0, 0.5, 0);
  try {
    for (let m = 0; m < models.length; m++) {
      const { geometry, info } = models[m];
      const sp = Math.floor(m / variants);
      mesh.geometry = geometry;
      const S = info.sphere * 1.02;
      mat.uniforms.uSphere.value = S;
      mat.uniforms.uRefHeight.value = refHeights[sp];
      mat.uniforms.uSp.value = sp;
      rt.scissorTest = false;
      rt.viewport.set(0, 0, W, H);
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
      for (let k = 0; k < E; k++) {
        const e = (k / (E - 1)) * Math.PI / 2;
        cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
        cam.near = 0.01; cam.far = 4 * S + 2;
        cam.position.set(0, 0.5 + Math.sin(e) * (2 * S + 1), Math.cos(e) * (2 * S + 1));
        cam.up.set(0, Math.cos(e), -Math.sin(e));
        cam.lookAt(C);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        rt.viewport.set(k * cell, 0, cell, cell);
        rt.scissor.set(k * cell, 0, cell, cell);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
      }
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, bufA, undefined, 0);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, bufN, undefined, 1);
      for (let k = 0; k < E; k++) reduceFrame(bufA, bufN, W, k * cell, size, outA[0], outN[0], (m * E + k) * texels * 4);
    }
  } finally {
    rt.scissorTest = false;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.xr.enabled = prevXr;
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadow;
    rt.dispose();
    mat.dispose();
  }

  for (let layer = 0; layer < layers; layer++) {
    dilate(outA[0], outN[0], size, layer * texels * 4);
    buildMips(outA, outN, size, layer, levels);
  }

  const albedo = makeArrayTexture(outA[0], size, layers, THREE.SRGBColorSpace);
  const normal = makeArrayTexture(outN[0], size, layers, THREE.NoColorSpace);
  renderer.initTexture(albedo);
  renderer.initTexture(normal);
  uploadMips(renderer, albedo, outA, size, layers);
  uploadMips(renderer, normal, outN, size, layers);
  return { albedo, normal, size, layers, frames: E, bytes: 2 * outA.reduce((s, a) => s + a.length, 0) };
}

function makeArrayTexture(data, size, layers, colorSpace) {
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = colorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;     // allocates the chain; the levels are then replaced (uploadMips)
  t.anisotropy = 1;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** Replaces mip levels 1.. of an uploaded array texture with our own (coverage-preserving). */
function uploadMips(renderer, tex, levels, size, layers) {
  const gl = renderer.getContext();
  const props = renderer.properties.get(tex);
  if (!props.__webglTexture) return;
  renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, props.__webglTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
  for (let l = 1, s = size >> 1; l < levels.length; l++, s >>= 1) {
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, 0, s, s, layers, gl.RGBA, gl.UNSIGNED_BYTE, levels[l]);
  }
  renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, null);
}

/** SS x SS reduction of one frame: coverage = covered share, the rest averaged over covered. */
function reduceFrame(bufA, bufN, W, x0, size, A, N, off) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0, r = 0, g = 0, b = 0, nx = 0, ny = 0, dz = 0, ao = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const p = ((y * SS + j) * W + x0 + x * SS + i) * 4;
          if (bufA[p + 3] < 128) continue;
          n++;
          r += bufA[p]; g += bufA[p + 1]; b += bufA[p + 2];
          nx += bufN[p]; ny += bufN[p + 1]; dz += bufN[p + 2]; ao += bufN[p + 3];
        }
      }
      const q = off + (y * size + x) * 4;
      if (n) {
        A[q] = r / n; A[q + 1] = g / n; A[q + 2] = b / n; A[q + 3] = Math.round(255 * n / (SS * SS));
        N[q] = nx / n; N[q + 1] = ny / n; N[q + 2] = dz / n; N[q + 3] = ao / n;
      } else {
        A[q + 3] = 0;
        N[q] = 128; N[q + 1] = 128; N[q + 2] = 128; N[q + 3] = 255;
      }
    }
  }
}

/** Pushes colour, normal, depth and AO outwards into the empty texels (alpha stays 0). */
function dilate(A, N, size, off) {
  const filled = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) filled[i] = A[off + i * 4 + 3] > 0 ? 1 : 0;
  let any = true;
  for (let pass = 0; pass < size && any; pass++) {
    any = false;
    const next = filled.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (filled[i]) continue;
        let n = 0;
        const s = [0, 0, 0, 0, 0, 0, 0];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const k = yy * size + xx;
            if (!filled[k]) continue;
            const q = off + k * 4;
            s[0] += A[q]; s[1] += A[q + 1]; s[2] += A[q + 2];
            s[3] += N[q]; s[4] += N[q + 1]; s[5] += N[q + 2]; s[6] += N[q + 3];
            n++;
          }
        }
        if (!n) { any = true; continue; }
        const q = off + i * 4;
        A[q] = s[0] / n; A[q + 1] = s[1] / n; A[q + 2] = s[2] / n;
        N[q] = s[3] / n; N[q + 1] = s[4] / n; N[q + 2] = s[5] / n; N[q + 3] = s[6] / n;
        next[i] = 1;
        any = true;
      }
    }
    filled.set(next);
  }
}

/** Box-filtered mips; alpha scaled per level so the share of texels above 0.5 stays the same. */
function buildMips(outA, outN, size, layer, levels) {
  const cover = (a, s, base, scale) => {
    let c = 0;
    for (let i = 0; i < s * s; i++) if (Math.min(255, a[base + i * 4 + 3] * scale) >= 128) c++;
    return c / (s * s);
  };
  const c0 = cover(outA[0], size, layer * size * size * 4, 1);
  for (let l = 1, s = size >> 1; l < levels; l++, s >>= 1) {
    const ps = s * 2;
    const srcA = outA[l - 1], srcN = outN[l - 1], A = outA[l], N = outN[l];
    const sb = layer * ps * ps * 4, db = layer * s * s * 4;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        let w = 0, aSum = 0;
        const acc = [0, 0, 0, 0, 0, 0, 0], accU = [0, 0, 0, 0, 0, 0, 0];
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const p = sb + ((y * 2 + j) * ps + x * 2 + i) * 4;
            const a = srcA[p + 3];
            aSum += a;
            const v = [srcA[p], srcA[p + 1], srcA[p + 2], srcN[p], srcN[p + 1], srcN[p + 2], srcN[p + 3]];
            for (let k = 0; k < 7; k++) { acc[k] += v[k] * a; accU[k] += v[k]; }
            w += a;
          }
        }
        const q = db + (y * s + x) * 4;
        const src = w > 0 ? acc.map((v) => v / w) : accU.map((v) => v / 4);
        A[q] = src[0]; A[q + 1] = src[1]; A[q + 2] = src[2]; A[q + 3] = aSum / 4;
        N[q] = src[3]; N[q + 1] = src[4]; N[q + 2] = src[5]; N[q + 3] = src[6];
      }
    }
    // coverage-preserving alpha scale (binary search)
    if (c0 > 0) {
      let lo = 0.5, hi = 4;
      for (let it = 0; it < 12; it++) {
        const mid = (lo + hi) / 2;
        if (cover(A, s, db, mid) < c0) lo = mid; else hi = mid;
      }
      const k = (lo + hi) / 2;
      for (let i = 0; i < s * s; i++) A[db + i * 4 + 3] = Math.min(255, Math.round(A[db + i * 4 + 3] * k));
    }
  }
}
