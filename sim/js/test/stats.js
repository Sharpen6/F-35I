// Render statistics for the test API and the benchmark: renderer.info, a GPU memory estimate,
// frame-time statistics and the GPU's name.

import * as THREE from 'three';

/** Bytes per texel for a three.js format / type pair (estimate). */
function texelBytes(tex) {
  const T = tex.type, F = tex.format;
  const per = T === THREE.FloatType || T === THREE.IntType || T === THREE.UnsignedIntType ? 4
    : T === THREE.HalfFloatType || T === THREE.ShortType || T === THREE.UnsignedShortType ? 2 : 1;
  const ch = F === THREE.RedFormat || F === THREE.RedIntegerFormat || F === THREE.AlphaFormat ? 1
    : F === THREE.RGFormat || F === THREE.RGIntegerFormat ? 2 : F === THREE.RGBFormat ? 3 : 4;
  return per * ch;
}

function textureBytes(tex) {
  if (!tex || tex.isRenderTargetTexture) return 0;
  const mip = tex.generateMipmaps && tex.minFilter !== THREE.NearestFilter && tex.minFilter !== THREE.LinearFilter ? 4 / 3 : 1;
  if (tex.isCompressedTexture) {
    let b = 0;
    for (const m of tex.mipmaps || []) b += (m.data && m.data.byteLength) || 0;
    return b;
  }
  const img = tex.image || tex.source?.data;
  if (!img) return 0;
  if (tex.isCubeTexture && Array.isArray(img)) return img.reduce((a, im) => a + (im ? (im.width || 0) * (im.height || 0) * 4 : 0), 0) * mip;
  if (img.data && img.data.byteLength) return img.data.byteLength * mip;
  const w = img.width || img.videoWidth || 0, h = img.height || img.videoHeight || 0, d = img.depth || 1;
  return w * h * d * texelBytes(tex) * mip;
}

function rtBytes(rt) {
  if (!rt) return 0;
  const w = rt.width || 0, h = rt.height || 0, d = rt.depth || 1;
  const n = rt.textures ? rt.textures.length : 1;
  const t = rt.texture || (rt.textures && rt.textures[0]);
  const faces = rt.isWebGLCubeRenderTarget ? 6 : 1;
  const color = t ? w * h * d * texelBytes(t) * n * faces : 0;
  const depth = rt.depthBuffer ? w * h * 4 : 0;
  const mip = t && t.generateMipmaps ? 4 / 3 : 1;
  // MSAA (lighting fix): three draws into multisampled colour and depth renderbuffers and resolves
  // into the single-sample texture (and depth texture or renderbuffer): all of them are allocated
  const s = rt.samples || 0;
  return s > 0 ? (color + depth) * s + color * mip + depth : color * mip + depth;
}

/**
 * The render targets of the app's modules that the scene does not reach (the HDR chain, the
 * clouds, the sky LUTs: lighting fix): every module with a targets() method.
 */
export function moduleTargets(app) {
  const list = [];
  for (const m of [app.env, app.post, ...(app.modules || [])]) {
    if (m && typeof m.targets === 'function') list.push(...m.targets());
  }
  return list;
}

/**
 * GPU memory estimate (bytes): geometry buffers and textures reachable from the scene (materials
 * and shader uniforms), the environment and shadow render targets, and the drawing buffer.
 * WebGL does not report real usage; this counts what the app uploads.
 */
export function estimateGpuMemory(renderer, scene, extraTargets = []) {
  const seenGeo = new Set(), seenTex = new Set(), seenRT = new Set();
  let geometry = 0, textures = 0, targets = 0;
  const big = [];
  const addTex = (t) => {
    if (!t || !t.isTexture || seenTex.has(t.uuid)) return;
    seenTex.add(t.uuid);
    const b = textureBytes(t);
    textures += b;
    const img = t.image || {};
    big.push({ name: t.name || t.constructor.name, MB: +(b / 1048576).toFixed(1), size: [img.width || 0, img.height || 0, img.depth || 1] });
  };
  const addRT = (rt) => {
    if (!rt || seenRT.has(rt)) return;
    seenRT.add(rt);
    targets += rtBytes(rt);
  };
  scene.traverse((o) => {
    const g = o.geometry;
    if (g && !seenGeo.has(g.uuid)) {
      seenGeo.add(g.uuid);
      for (const k in g.attributes) geometry += g.attributes[k].array?.byteLength || 0;
      if (g.index) geometry += g.index.array.byteLength;
    }
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const k in m) { const v = m[k]; if (v && v.isTexture) addTex(v); }
      if (m.uniforms) {
        for (const k in m.uniforms) {
          const v = m.uniforms[k] && m.uniforms[k].value;
          if (Array.isArray(v)) v.forEach(addTex); else addTex(v);
        }
      }
    }
    if (o.isLight && o.shadow && o.shadow.map) addRT(o.shadow.map);
  });
  if (scene.environment && !seenTex.has(scene.environment.uuid)) {
    const t = scene.environment;
    seenTex.add(t.uuid);
    const img = t.image || {};
    textures += (img.width || 0) * (img.height || 0) * 8;      // PMREM: half-float RGBA
  }
  if (scene.background && scene.background.isTexture) addTex(scene.background);
  for (const rt of extraTargets) addRT(rt);
  const c = renderer.domElement;
  const ctx = renderer.getContext();
  // the canvas (lighting fix: from the context's real attributes; with the HDR chain it has no
  // MSAA and no depth): the drawing buffer and the browser's front buffer (RGBA8), plus a
  // multisampled colour buffer with antialias, plus depth (and stencil) if the context has them
  const attr = (ctx.getContextAttributes && ctx.getContextAttributes()) || {};
  const aa = attr.antialias ? 4 : 0;
  const ds = attr.depth || attr.stencil ? 4 : 0;
  const framebuffer = c.width * c.height * (8 + 4 * aa + ds * (aa || 1));
  const total = geometry + textures + targets + framebuffer;
  const mb = (b) => +(b / 1048576).toFixed(1);
  return { totalMB: mb(total), geometryMB: mb(geometry), texturesMB: mb(textures), targetsMB: mb(targets), framebufferMB: mb(framebuffer),
    geometries: seenGeo.size, textureCount: seenTex.size, largestTextures: big.sort((a, b) => b.MB - a.MB).slice(0, 6) };
}

/** renderer.info of the last frame, as plain numbers. */
export function renderInfo(renderer) {
  const i = renderer.info;
  return {
    calls: i.render.calls, triangles: i.render.triangles, points: i.render.points, lines: i.render.lines,
    geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs ? i.programs.length : null,
  };
}

/** Frame-time statistics from a list of frame times (ms). */
export function frameStats(ms) {
  if (!ms.length) return { frames: 0 };
  const sorted = ms.slice().sort((a, b) => b - a);                    // slowest first
  const sum = ms.reduce((a, b) => a + b, 0);
  const worst = sorted.slice(0, Math.max(1, Math.ceil(ms.length / 100)));
  const worstAvg = worst.reduce((a, b) => a + b, 0) / worst.length;
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((1 - p) * sorted.length))];
  return {
    frames: ms.length, measuredSeconds: +(sum / 1000).toFixed(2),
    avgFps: +(1000 * ms.length / sum).toFixed(1),
    low1Fps: +(1000 / worstAvg).toFixed(1),                           // mean of the slowest 1 % of frames
    minFps: +(1000 / sorted[0]).toFixed(1),
    avgMs: +(sum / ms.length).toFixed(2), p50Ms: +pct(0.5).toFixed(2), p99Ms: +pct(0.99).toFixed(2), maxMs: +sorted[0].toFixed(2),
  };
}

/** The GPU / driver string (WEBGL_debug_renderer_info), when the browser gives it. */
export function gpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { return 'unknown'; }
}
