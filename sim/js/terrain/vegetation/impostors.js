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
// ImpostorBaker works in small steps (one model per renderModel(), a few layers per
// finishSome()) so that the start-up spreads over a few frames; bakeImpostors() does it all.
// The frames come back asynchronously where the renderer can (a pixel buffer and a fence: no
// stall of the GPU's pipeline per model, which a synchronous read would cost mid-flight);
// waiting is true while some are still on their way.
// Result: two DataArrayTextures (layer = model * ELEV_FRAMES + frame), albedo sRGB.

import * as THREE from 'three';
import { BAKE_VERT, BAKE_FRAG, ELEV_FRAMES } from './shaders.js';

const SS = 2;          // supersampling of the bake
const DILATE = 6;      // texels of colour dilation (beyond: the frame's mean colour)

export class ImpostorBaker {
  /**
   * models: [{geometry, info: {sphere}}] (species * variants + variant); spB: Vector4 array
   * (per species: fluff, ...); refHeights: metres per species (for the leaf noise scale).
   */
  constructor(renderer, models, { size = 128, spB, refHeights, variants = 2, async = true }) {
    this.renderer = renderer;
    this.models = models;
    this.size = size;
    this.refHeights = refHeights;
    this.variants = variants;
    this.E = ELEV_FRAMES;
    this.cell = size * SS;
    this.W = this.cell * this.E;
    this.H = this.cell;
    this.layers = models.length * this.E;
    this.levels = Math.log2(size) + 1;
    this.next = 0;          // next model to render
    this.nextLayer = 0;     // next layer to finish (dilate + mips)
    this.ms = 0;
    this.async = async && typeof renderer.readRenderTargetPixelsAsync === 'function';
    this.pending = 0;       // models whose frames are still being read back
    this.rt = new THREE.WebGLRenderTarget(this.W, this.H, {
      count: 2, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    for (const t of this.rt.textures) t.colorSpace = THREE.NoColorSpace;
    this.material = new THREE.ShaderMaterial({
      name: 'VegetationBake',
      glslVersion: THREE.GLSL3,
      uniforms: { uRefHeight: { value: 10 }, uSphere: { value: 0.6 }, uSpB: { value: spB }, uSp: { value: 0 } },
      vertexShader: BAKE_VERT,
      fragmentShader: BAKE_FRAG,
      side: THREE.FrontSide,
    });
    this.scene = new THREE.Scene();
    this.mesh = new THREE.Mesh(models[0].geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    this.outA = [];
    this.outN = [];
    for (let l = 0, s = size; l < this.levels; l++, s >>= 1) {
      this.outA.push(new Uint8Array(s * s * 4 * this.layers));
      this.outN.push(new Uint8Array(s * s * 4 * this.layers));
    }
    this.bufA = new Uint8Array(this.W * this.H * 4);
    this.bufN = new Uint8Array(this.W * this.H * 4);
  }

  get rendered() { return this.next >= this.models.length; }
  get finished() { return this.nextLayer >= this.layers; }
  get waiting() { return this.pending > 0; }

  /** Renders the next model's frames and reads them back. Returns false when all are done. */
  renderModel() {
    if (this.rendered) return false;
    const t0 = performance.now();
    const { renderer, rt, cam, E, cell, W, H } = this;
    const m = this.next++;
    const { geometry, info } = this.models[m];
    const sp = Math.floor(m / this.variants);
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
      this.mesh.geometry = geometry;
      const S = info.sphere * 1.02;
      const U = this.material.uniforms;
      U.uSphere.value = S;
      U.uRefHeight.value = this.refHeights[sp];
      U.uSp.value = sp;
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
        renderer.render(this.scene, cam);
      }
      if (this.async) {
        // into this model's own buffers (the next model renders into the same target meanwhile:
        // the reads are queued before it)
        const a = new Uint8Array(W * H * 4), n = new Uint8Array(W * H * 4);
        this.pending++;
        Promise.all([renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H, a, undefined, 0), renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H, n, undefined, 1)])
          .then(() => { const t1 = performance.now(); this._reduce(m, a, n); this.ms += performance.now() - t1; },
            (e) => { console.warn('vegetation: impostor read back failed', e); })
          .finally(() => { this.pending--; });
      } else {
        renderer.readRenderTargetPixels(rt, 0, 0, W, H, this.bufA, undefined, 0);
        renderer.readRenderTargetPixels(rt, 0, 0, W, H, this.bufN, undefined, 1);
      }
    } finally {
      rt.scissorTest = false;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.xr.enabled = prevXr;
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadow;
    }
    if (!this.async) this._reduce(m, this.bufA, this.bufN);
    this.ms += performance.now() - t0;
    if (this.rendered) {
      // (reads still queued keep their own pixel buffers)
      this.rt.dispose();
      this.material.dispose();
      this.bufA = this.bufN = null;
    }
    return true;
  }

  /** The 2x frames of model m reduced into the atlas's layers. */
  _reduce(m, bufA, bufN) {
    const { E, W, cell, size } = this;
    const texels = size * size;
    for (let k = 0; k < E; k++) reduceFrame(bufA, bufN, W, k * cell, size, this.outA[0], this.outN[0], (m * E + k) * texels * 4);
  }

  /** Dilates and builds the mips of up to n layers (after all models are rendered). */
  finishSome(n = Infinity) {
    if (this.pending) return false;        // frames still on their way back
    const t0 = performance.now();
    const texels = this.size * this.size;
    for (let i = 0; i < n && this.nextLayer < this.layers; i++, this.nextLayer++) {
      dilate(this.outA[0], this.outN[0], this.size, this.nextLayer * texels * 4);
      buildMips(this.outA, this.outN, this.size, this.nextLayer, this.levels);
    }
    this.ms += performance.now() - t0;
    return this.finished;
  }

  /** The textures (uploads them; call once, when finished). */
  result() {
    const t0 = performance.now();
    const { renderer, size, layers, outA, outN } = this;
    const albedo = makeArrayTexture(outA[0], size, layers, THREE.SRGBColorSpace);
    const normal = makeArrayTexture(outN[0], size, layers, THREE.NoColorSpace);
    renderer.initTexture(albedo);
    renderer.initTexture(normal);
    uploadMips(renderer, albedo, outA, size, layers);
    uploadMips(renderer, normal, outN, size, layers);
    this.ms += performance.now() - t0;
    return { albedo, normal, size, layers, frames: this.E, bytes: 2 * outA.reduce((s, a) => s + a.length, 0) };
  }

  dispose() {
    if (!this.rendered) { this.rt.dispose(); this.material.dispose(); }
  }
}

/** The whole bake at once. */
export function bakeImpostors(renderer, models, opts) {
  const b = new ImpostorBaker(renderer, models, { ...opts, async: false });
  while (b.renderModel());
  b.finishSome();
  const r = b.result();
  r.ms = b.ms;
  return r;
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

/**
 * Pushes colour, normal, depth and AO outwards into the empty texels, DILATE texels deep; the
 * texels further out take the frame's mean (alpha stays 0). Filtering then never sees black.
 */
let scratch = null;    // dilation buffers, reused

function dilate(A, N, size, off) {
  const n2 = size * size;
  if (!scratch || scratch.n2 !== n2) {
    scratch = { n2, mark: new Uint8Array(n2), a: new Int32Array(n2), b: new Int32Array(n2), tmp: new Float32Array(n2 * 7) };
  }
  const mark = scratch.mark;                // 1 filled, 2 on the front
  mark.fill(0);
  const mean = new Float64Array(7);
  let cnt = 0;
  for (let i = 0; i < n2; i++) {
    const q = off + i * 4;
    if (A[q + 3] === 0) continue;
    mark[i] = 1;
    mean[0] += A[q]; mean[1] += A[q + 1]; mean[2] += A[q + 2];
    mean[3] += N[q]; mean[4] += N[q + 1]; mean[5] += N[q + 2]; mean[6] += N[q + 3];
    cnt++;
  }
  if (!cnt) return;
  let front = scratch.a, next = scratch.b;
  let nf = 0;
  const grow = (i, out, n) => {             // the empty 8-neighbours of i join the front
    const x = i % size, y = (i - x) / size;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= size) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= size) continue;
        const k = yy * size + xx;
        if (mark[k]) continue;
        mark[k] = 2;
        out[n++] = k;
      }
    }
    return n;
  };
  for (let i = 0; i < n2; i++) if (mark[i] === 1) nf = grow(i, front, nf);
  const tmp = scratch.tmp;
  for (let pass = 0; pass < DILATE && nf; pass++) {
    for (let f = 0; f < nf; f++) {           // the average of the texels filled before this pass
      const i = front[f], x = i % size, y = (i - x) / size;
      let n = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          const k = yy * size + xx;
          if (mark[k] !== 1) continue;
          const q = off + k * 4;
          s0 += A[q]; s1 += A[q + 1]; s2 += A[q + 2];
          s3 += N[q]; s4 += N[q + 1]; s5 += N[q + 2]; s6 += N[q + 3];
          n++;
        }
      }
      const t = f * 7;
      tmp[t] = s0 / n; tmp[t + 1] = s1 / n; tmp[t + 2] = s2 / n;
      tmp[t + 3] = s3 / n; tmp[t + 4] = s4 / n; tmp[t + 5] = s5 / n; tmp[t + 6] = s6 / n;
    }
    for (let f = 0; f < nf; f++) {
      const i = front[f], q = off + i * 4, t = f * 7;
      A[q] = tmp[t]; A[q + 1] = tmp[t + 1]; A[q + 2] = tmp[t + 2];
      N[q] = tmp[t + 3]; N[q + 1] = tmp[t + 4]; N[q + 2] = tmp[t + 5]; N[q + 3] = tmp[t + 6];
      mark[i] = 1;
    }
    let nn = 0;
    if (pass + 1 < DILATE) for (let f = 0; f < nf; f++) nn = grow(front[f], next, nn);
    [front, next] = [next, front];
    nf = nn;
  }
  for (let k = 0; k < 7; k++) mean[k] /= cnt;
  for (let i = 0; i < n2; i++) {
    if (mark[i] === 1) continue;
    const q = off + i * 4;
    A[q] = mean[0]; A[q + 1] = mean[1]; A[q + 2] = mean[2];
    N[q] = mean[3]; N[q + 1] = mean[4]; N[q + 2] = mean[5]; N[q + 3] = mean[6];
  }
}

/** Box-filtered mips; alpha scaled per level so the share of texels above 0.5 stays the same. */
function buildMips(outA, outN, size, layer, levels) {
  const hist = new Uint32Array(257);
  // share of texels whose alpha * k reaches 128, from a histogram of the alpha values
  const coverage = (A, s, base) => {
    hist.fill(0);
    for (let i = 0; i < s * s; i++) hist[A[base + i * 4 + 3]]++;
    for (let a = 254; a >= 0; a--) hist[a] += hist[a + 1];    // suffix sums: texels with alpha >= a
    return (k) => hist[Math.min(256, Math.ceil(128 / k))] / (s * s);
  };
  const c0 = coverage(outA[0], size, layer * size * size * 4)(1);
  for (let l = 1, s = size >> 1; l < levels; l++, s >>= 1) {
    const ps = s * 2;
    const srcA = outA[l - 1], srcN = outN[l - 1], A = outA[l], N = outN[l];
    const sb = layer * ps * ps * 4, db = layer * s * s * 4;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        let w = 0, a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0;
        let u0 = 0, u1 = 0, u2 = 0, u3 = 0, u4 = 0, u5 = 0, u6 = 0;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const p = sb + ((y * 2 + j) * ps + x * 2 + i) * 4;
            const a = srcA[p + 3];
            const v0 = srcA[p], v1 = srcA[p + 1], v2 = srcA[p + 2], v3 = srcN[p], v4 = srcN[p + 1], v5 = srcN[p + 2], v6 = srcN[p + 3];
            a0 += v0 * a; a1 += v1 * a; a2 += v2 * a; a3 += v3 * a; a4 += v4 * a; a5 += v5 * a; a6 += v6 * a;
            u0 += v0; u1 += v1; u2 += v2; u3 += v3; u4 += v4; u5 += v5; u6 += v6;
            w += a;
          }
        }
        const q = db + (y * s + x) * 4;
        if (w > 0) {
          A[q] = a0 / w; A[q + 1] = a1 / w; A[q + 2] = a2 / w;
          N[q] = a3 / w; N[q + 1] = a4 / w; N[q + 2] = a5 / w; N[q + 3] = a6 / w;
        } else {
          A[q] = u0 / 4; A[q + 1] = u1 / 4; A[q + 2] = u2 / 4;
          N[q] = u3 / 4; N[q + 1] = u4 / 4; N[q + 2] = u5 / 4; N[q + 3] = u6 / 4;
        }
        A[q + 3] = w / 4;           // w: the sum of the four alphas
      }
    }
    // coverage-preserving alpha scale (binary search on the histogram)
    if (c0 > 0) {
      const cover = coverage(A, s, db);
      let lo = 0.5, hi = 4;
      for (let it = 0; it < 12; it++) {
        const mid = (lo + hi) / 2;
        if (cover(mid) < c0) lo = mid; else hi = mid;
      }
      const k = (lo + hi) / 2;
      for (let i = 0; i < s * s; i++) A[db + i * 4 + 3] = Math.min(255, Math.round(A[db + i * 4 + 3] * k));
    }
  }
}
