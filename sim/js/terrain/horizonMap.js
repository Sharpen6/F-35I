// The terrain's shadows on itself: horizon maps toward the sun (hills shading valleys at
// sunrise and sunset, the Judean desert's cliffs over the Dead Sea).
//
// Two square maps of horizon elevation angles, aligned with the sun's azimuth (horizonCore.js
// explains the algorithm): "near" around the camera (51.2 km, 25 m on high) and "far"
// (204.8 km, 100 m on high), both computed in a worker (horizonWorker.js) and stored as one
// R8 texture array (one sampler unit). A point is lit when the sun stands above its horizon
// (soft over the sun's disc). Recomputed when the sun's azimuth moves by more than 0.5 deg
// (2 deg when the sun is high and shadows are short) or the camera moves 1/8 of the near map
// (6.4 km on high); the old maps stay in use meanwhile, unless the sun is more than 5 deg of
// azimuth away from them (a time jump): then there are no terrain shadows until the new maps
// arrive. The sun's elevation can change freely without recomputing.
//
// Uploads: two textures, one in use and one being filled. New maps go to the GPU in bands of
// rows over several frames (512 KB a frame: 16 frames for the 8 MB of the high maps, instead of
// one 8 MB upload that stalls a frame), then the two swap, with the maps' uniforms, at once.
// Needs the renderer (setRenderer); without it the maps are uploaded whole.
//
// For other modules (trees, buildings, roads): terrain.horizon.uniforms plus HORIZON_GLSL give
// terrainSunVisibility(worldXZ, h, localUp) at the ground and terrainSunVisibilityAbove(worldXZ,
// dh, localUp) dh metres above it, in any shader (one sampler); terrain.sunVisibilityAt(x, y, z)
// answers on the CPU at any height (a ray march, Terrain.js).

import * as THREE from 'three';
import { decodeHorizon } from './horizonCore.js';

/** n (texels per side) and spacing (m) of the near and far maps per quality. */
export const HORIZON_QUALITY = {
  low: { n: 512, near: 100, far: 400, preroll: 20000 },
  medium: { n: 1024, near: 50, far: 200, preroll: 25000 },
  high: { n: 2048, near: 25, far: 100, preroll: 30000 },
};

export const HORIZON_GLSL = /* glsl */ `
uniform highp sampler2DArray uHorizon; // R8 sqrt(horizon elevation / 90 deg) toward the sun: layer 0 near, 1 far
uniform vec4 uHorizonNear;             // centre x, z (m), 1 / extent (1 / m), on (1) / off (0)
uniform vec4 uHorizonFar;              // centre x, z (m), 1 / extent (1 / m)
uniform vec2 uHorizonAxis;             // horizontal unit vector toward the sun the maps were made for
float horizonAngle(vec2 uv, float layer) {
  float v = textureLod(uHorizon, vec3(uv, layer), 0.0).r;
  return v * v * 1.5707963;
}
// 1 = sun visible from the ground at world xz, 0 = behind the terrain; upP = local vertical.
// h: the ground's height there (not needed: the maps are made for the ground; kept so callers
// need not change)
float terrainSunVisibility(vec2 xz, float h, vec3 upP) {
  float vis = 1.0;
  if (uHorizonNear.w > 0.5 && uSunDir.y > -0.03) {
    vec2 a = uHorizonAxis, b = vec2(-a.y, a.x);
    vec2 dn = xz - uHorizonNear.xy, df = xz - uHorizonFar.xy;
    vec2 un = vec2(dot(dn, a), dot(dn, b)) * uHorizonNear.z + 0.5;
    vec2 uf = vec2(dot(df, a), dot(df, b)) * uHorizonFar.z + 0.5;
    float kn = 1.0 - smoothstep(0.42, 0.49, max(abs(un.x - 0.5), abs(un.y - 0.5)));
    float kf = 1.0 - smoothstep(0.44, 0.5, max(abs(uf.x - 0.5), abs(uf.y - 0.5)));
    float angN = kn > 0.0 ? horizonAngle(un, 0.0) : 0.0;
    float angF = kn < 1.0 && kf > 0.0 ? horizonAngle(uf, 1.0) * kf : 0.0;
    float ang = mix(angF, angN, kn);
    float el = asin(clamp(dot(upP, uSunDir), -1.0, 1.0));
    vis = smoothstep(ang - 0.0075, ang + 0.0075, el);   // +-0.43 deg: the sun's disc and the grid
  }
  return vis;
}
// the same for a point dh metres above the ground (a crown, a roof): the maps hold what the
// ground sees, so the point is looked up where the sun's ray through it meets the ground,
// dh / tan(sun elevation) away from the sun (exact where the ground between is level; at most
// 3 km away)
float terrainSunVisibilityAbove(vec2 xz, float dh, vec3 upP) {
  float sh = length(uSunDir.xz);
  vec2 back = sh > 1e-3 ? -uSunDir.xz / sh * min(max(dh, 0.0) * sh / max(uSunDir.y, 0.05), 3000.0) : vec2(0.0);
  return terrainSunVisibility(xz + back, 0.0, upP);
}
`;

export class HorizonMap {
  constructor() {
    this.enabled = true;
    this.quality = 'high';
    this.worker = null;
    this.ready = false;       // worker has the heights
    this.busy = false;
    this.pending = true;      // no map yet, or a recompute is wanted / running
    this.maps = null;         // {near, far, job} of the texture in use (CPU copies)
    this._id = 0;
    this._job = null;
    this._last = null;        // parameters of the maps in use: {cx, cz, ax, az}
    this.stats = { computes: 0, lastMs: 0, uploadFrames: 0 };
    this.renderer = null;     // for the uploads in bands (setRenderer)
    this._tex = [];           // [in use or being replaced, the other]
    this._front = 0;
    this._upload = null;      // {job, maps, src, row}: new maps going up in bands
    this._box = new THREE.Box3();
    this._pos = new THREE.Vector3();
    this.uniforms = {
      uHorizon: { value: null },
      uHorizonNear: { value: new THREE.Vector4(0, 0, 1 / 51200, 0) },
      uHorizonFar: { value: new THREE.Vector4(0, 0, 1 / 204800, 0) },
      uHorizonAxis: { value: new THREE.Vector2(1, 0) },
    };
    this._makeTextures(HORIZON_QUALITY.high.n);
  }

  /** The renderer, for uploading new maps in bands of rows (otherwise whole). */
  setRenderer(renderer) { this.renderer = renderer || null; }

  _makeTextures(n) {
    for (const t of this._tex) t.dispose();
    this._tex = [0, 1].map((i) => {
      const t = new THREE.DataArrayTexture(new Uint8Array(n * n * 2), n, n, 2);
      t.format = THREE.RedFormat;
      t.type = THREE.UnsignedByteType;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.unpackAlignment = 1;
      t.colorSpace = THREE.NoColorSpace;
      t.name = `TerrainHorizon${i}`;
      t.needsUpdate = true;
      // the CPU copy is only for an upload as a whole; bands come from the worker's arrays
      t.onUpdate = () => { t.image.data = null; };
      return t;
    });
    this._front = 0;
    this._upload = null;
    this.texture = this._tex[0];
    this.n = n;
    this.uniforms.uHorizon.value = this.texture;
  }

  /**
   * Starts the worker (browser only); it fetches the heights from baseUrl itself, and the rift
   * strip from riftUrl when Terrain loaded one (null: none).
   */
  start(baseUrl, riftUrl = null) {
    if (typeof Worker === 'undefined') { this.enabled = false; return; }
    try {
      this.worker = new Worker(new URL('./horizonWorker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      console.warn('terrain: no horizon worker', e);
      this.enabled = false;
      return;
    }
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => { console.warn('terrain: horizon worker error', e.message || e); this.enabled = false; this.busy = false; };
    this.worker.postMessage({ type: 'init', baseUrl, riftUrl });
  }

  setQuality(q) {
    const k = HORIZON_QUALITY[q] ? q : 'high';
    if (k === this.quality) return;
    this.quality = k;
    this._last = null;                  // recompute at the new size
    this.pending = true;
  }

  setEnabled(on) {
    this.enabled = !!on && !!this.worker;
    this.uniforms.uHorizonNear.value.w = this.enabled && this.maps ? 1 : 0;
  }

  /** Per frame: asks for new maps when the sun or the camera moved enough. */
  update(cam, sunDir) {
    const U = this.uniforms;
    const hx = sunDir.x, hz = sunDir.z;
    const hl = Math.hypot(hx, hz);
    const last = this._last;
    // maps made for a sun more than 5 deg of azimuth away (after a time jump) would cast the
    // wrong shadows: none until the new ones arrive
    const fresh = !!last && hl > 1e-4 && (hx * last.ax + hz * last.az) / hl > Math.cos(5 * Math.PI / 180);
    U.uHorizonNear.value.w = this.enabled && this.maps && fresh ? 1 : 0;
    if (!this.enabled || !this.ready || this.busy || this._upload) return;
    if (hl < 1e-4 || sunDir.y < -0.05) { this.pending = false; return; }       // overhead or night
    const ax = hx / hl, az = hz / hl;
    const Q = HORIZON_QUALITY[this.quality];
    const elev = Math.atan2(sunDir.y, hl);
    let want = !last || last.n !== Q.n;
    if (!want) {
      const dAz = Math.acos(Math.min(1, ax * last.ax + az * last.az));
      const lim = (elev > 0.5 ? 2 : 0.5) * Math.PI / 180;
      const moved = Math.hypot(cam.x - last.cx, cam.z - last.cz);
      want = dAz > lim || moved > Q.n * Q.near / 8;
    }
    this.pending = want;
    if (!want) return;
    const cx = Math.round(cam.x / Q.near) * Q.near, cz = Math.round(cam.z / Q.near) * Q.near;
    const fx = Math.round(cam.x / Q.far) * Q.far, fz = Math.round(cam.z / Q.far) * Q.far;
    const id = ++this._id;
    this._job = { id, n: Q.n, cx, cz, fx, fz, ax, az, near: Q.near, far: Q.far, t0: performance.now() };
    this.busy = true;
    this.worker.postMessage({
      type: 'job', id,
      layers: [
        { cx, cz, ax, az, n: Q.n, spacing: Q.near, preroll: Q.preroll },
        { cx: fx, cz: fz, ax, az, n: Q.n, spacing: Q.far, preroll: Q.preroll },
      ],
    });
  }

  _onMessage(m) {
    if (m.type === 'ready') { this.ready = true; return; }
    if (m.type === 'error') {
      console.warn('terrain: horizon worker:', m.message);
      this.busy = false;
      if (!this.ready) this.enabled = false;
      return;
    }
    if (m.type !== 'result') return;
    this.busy = false;
    const job = this._job;
    if (!job || m.id !== job.id) return;
    const n = job.n;
    if (n !== this.n) this._makeTextures(n);
    if (!this.renderer || !this.maps || this.maps.job.n !== n) {
      // nothing of this size in use yet: the whole maps at once
      const t = this._tex[this._front];
      const data = new Uint8Array(n * n * 2);
      data.set(m.maps[0], 0);
      data.set(m.maps[1], n * n);
      t.image.data = data;
      t.needsUpdate = true;
      this._apply(job, m.maps, 1);
      return;
    }
    // into the other texture, a band of rows per frame (uploadStep); swapped when complete
    const src = m.maps.map((a) => new THREE.Data3DTexture(a, n, n, 1));
    this._upload = { job, maps: m.maps, src, row: 0, frames: 0 };
  }

  /**
   * Per frame (Terrain.update): uploads the next band of rows of new maps into the texture
   * not in use (copyTextureToTexture: texSubImage3D from the worker's arrays) and swaps the
   * two, with the maps' uniforms, once both layers are complete.
   */
  uploadStep() {
    const u = this._upload;
    if (!u || !this.renderer) return;
    const n = u.job.n;
    const rows = Math.max(64, Math.floor((512 * 1024) / n));
    const back = this._tex[1 - this._front];
    const layer = u.row < n ? 0 : 1;
    const y0 = u.row - layer * n, y1 = Math.min(n, y0 + rows);
    this._box.min.set(0, y0, 0);
    this._box.max.set(n, y1, 1);
    this._pos.set(0, y0, layer);
    this.renderer.copyTextureToTexture(u.src[layer], back, this._box, this._pos);
    u.row += y1 - y0;
    u.frames++;
    if (u.row < 2 * n) return;
    this._front = 1 - this._front;
    this.texture = back;
    this.uniforms.uHorizon.value = back;
    this._upload = null;
    this._apply(u.job, u.maps, u.frames);
  }

  _apply(job, maps, frames) {
    const n = job.n;
    const U = this.uniforms;
    U.uHorizonNear.value.set(job.cx, job.cz, 1 / (n * job.near), this.enabled ? 1 : 0);
    U.uHorizonFar.value.set(job.fx, job.fz, 1 / (n * job.far), 0);
    U.uHorizonAxis.value.set(job.ax, job.az);
    this.maps = { near: maps[0], far: maps[1], job };
    this._last = { n, cx: job.cx, cz: job.cz, ax: job.ax, az: job.az };
    this.stats.computes++;
    this.stats.lastMs = Math.round(performance.now() - job.t0);
    this.stats.uploadFrames = frames;
  }

  /** Horizon elevation (radians) toward the sun at world x, z from the maps in use, or null. */
  horizonAt(x, z) {
    const M = this.maps;
    if (!M) return null;
    const { job } = M, n = job.n;
    const sample = (map, cx, cz, spacing) => {
      const dx = x - cx, dz = z - cz;
      const u = (dx * job.ax + dz * job.az) / spacing + n / 2 - 0.5;
      const v = (-dx * job.az + dz * job.ax) / spacing + n / 2 - 0.5;
      if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return null;
      const i = Math.min(n - 2, Math.floor(u)), j = Math.min(n - 2, Math.floor(v));
      const fu = u - i, fv = v - j;
      const a = decodeHorizon(map[j * n + i]), b = decodeHorizon(map[j * n + i + 1]);
      const c = decodeHorizon(map[(j + 1) * n + i]), d = decodeHorizon(map[(j + 1) * n + i + 1]);
      return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
    };
    return sample(M.near, job.cx, job.cz, job.near) ?? sample(M.far, job.fx, job.fz, job.far);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this._upload = null;
    for (const t of this._tex) t.dispose();
  }
}
