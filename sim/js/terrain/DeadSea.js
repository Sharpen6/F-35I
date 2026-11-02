// DeadSea: the Dead Sea's own water surface, owned by Terrain (Terrain.js builds it with the
// GPU data and calls update() after its LOD selection every frame).
//
//   lake pass   the terrain's selected patches over the basin (node minimum below LAKE_GATE)
//               drawn again after the terrain with LAKE_FRAG (lakeShaders.js): the terrain
//               wrote only its land part there and 1 - water into alpha (uLake), the lake adds
//               its water blended by 1 - destination alpha and restores alpha to 1.
//   mirror      on high quality, within MIRROR_KM of the lake while the lake is in view: the
//               terrain drawn from the mirror camera (the camera reflected in the lake plane)
//               into a half-resolution half-float target with mipmaps (MIRROR_FRAG: cheap
//               shading, its own coarser LOD selection, no flat lake patches), which LAKE_FRAG
//               samples where the rippled reflected ray points. Its own scene without lights:
//               one program, no light-dependent variants.
//   profile     on medium / low (and where the mirror has nothing): per azimuth the walls'
//               silhouette (height above the lake, distance) and how lit they are, from the
//               height field around the camera, 32 azimuths per frame.
//   wind        windAt(hour): the basin's daily cycle (calm mornings, lake breeze, the western
//               foehn after sunset), driving the ripples' slope variance, their drift and the
//               cat's paws (glassy water between rippled patches at calm).
//
// Data: the distance from each water point to the shore (25 m, R8), computed from the height
// field at load (the lake is flat at LAKE_LEVEL in both grids): the shallows over the white
// salt floor are turquoise, deep water dark blue-green.

import * as THREE from 'three';
import { TERRAIN_VERT } from './terrainShaders.js';
import { LAKE_FRAG, MIRROR_FRAG, LAKE_LEVEL, LAKE_GATE } from './lakeShaders.js';
import { QuadTree, RANGE0 } from './QuadTree.js';
import { FAR_HALF, FAR_N, FAR_SPACING, NODE0_M } from './HeightField.js';

const LAKE_CELL = 25;             // lake data texel (m)
const LAKE_MAX_D = 1600;          // the lake data's distance range (m)
const LAKE_CAPACITY = 512;        // lake pass patches
const MIRROR_CAPACITY = 768;
const MIRROR_KM = 40;             // the mirror is drawn within this distance of the lake
const MIRROR_RANGE = 65000;       // terrain farther than this from the camera stays out of the mirror (m)
const MIRROR_LOD = 0.5;           // the mirror's LOD ranges (share of the terrain's)
const MIRROR_FOV = 1.12;          // the mirror camera's field of view over the camera's (ripple margin)
const PROFILE_N = 256;            // azimuths of the horizon profile
const PROFILE_STEP = 32;          // azimuths updated per frame
const PROFILE_MOVE = 400;         // the profile is redone when the camera moved this far (m)

/** Per quality: mirror resolution (share of the drawing buffer; 0 = horizon profile only). */
export const LAKE_QUALITY = {
  low: { mirror: 0 },
  medium: { mirror: 0 },
  high: { mirror: 0.5 },
};

/**
 * The basin's winds by local solar hour: [hour, speed m/s, direction it comes from (deg from
 * north)]. Calm nights with a weak northerly drainage wind, the calmest hour after sunrise, a
 * lake breeze from late morning (onshore at the western shore: easterly), a southerly valley
 * wind at midday, the western foehn down the Judean slope from mid-afternoon, strongest after
 * sunset, fading by midnight (Metzger et al. 2018, ACP 18; Shafir & Alpert 2011). Moderate
 * values: the foehn's strong days (10 m/s and more) are the exception.
 */
const WIND_KEYS = [
  [0, 1.4, 340], [4, 1.0, 350], [6.0, 0.6, 10], [7.5, 0.5, 60], [9, 1.4, 95], [11, 2.3, 120],
  [13, 2.8, 170], [15, 3.2, 240], [17, 4.2, 275], [19, 5.0, 285], [21.5, 3.0, 300], [24, 1.4, 340],
];

/** { speed (m/s), x, z (unit vector the wind blows to; world x east, z south) } at a solar hour. */
export function windAt(hour, out = { speed: 0, x: 0, z: 1 }) {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < WIND_KEYS.length - 2 && WIND_KEYS[i + 1][0] <= h) i++;
  const [h0, s0, d0] = WIND_KEYS[i], [h1, s1, d1] = WIND_KEYS[i + 1];
  const t = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  const k = t * t * (3 - 2 * t);
  let dd = d1 - d0;
  if (dd > 180) dd -= 360; else if (dd < -180) dd += 360;
  const from = (d0 + dd * k) * Math.PI / 180;
  out.speed = s0 + (s1 - s0) * k;
  // from the north = blowing south (+z); from the east = blowing west (-x)
  out.x = -Math.sin(from);
  out.z = Math.cos(from);
  return out;
}

/**
 * Mean square slope of the ripples at wind speed u (m/s): glassy at calm, about Cox and Munk's
 * open-sea values damped by the brine's viscosity in a breeze (0.02 at 5 m/s).
 */
export function rippleMss(u) {
  return 2e-5 + 0.0042 * u * Math.min(u, 3) / 3;
}

const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _p = new THREE.Vector3();
const _m = new THREE.Matrix4(), _box = new THREE.Box3();
const _size = new THREE.Vector2(), _clear = new THREE.Color();

export class DeadSea {
  /**
   * terrain: the Terrain after _buildGpu (shared uniforms, templates, height field, textures).
   * PatchGroup: Terrain.js's patch group class.
   */
  constructor(terrain, PatchGroup) {
    this.terrain = terrain;
    this.renderer = terrain.renderer;
    this.env = terrain.env;
    this.enabled = true;
    this.quality = 'high';
    this.mirrorScale = LAKE_QUALITY.high.mirror;
    this.wind = { speed: 0, x: 0, z: 1 };
    /** A fixed wind speed (m/s) instead of the daily cycle (?lakeWind=), null = the cycle. */
    this.windOverride = null;
    this.stats = { lakePatches: 0, mirrorPatches: 0, mirror: false, mirrorMs: 0, wind: 0, profile: 0 };
    this._drift = 0;
    this._hour = 12;
    this._visible = false;

    const hf = terrain.hf;
    this.box = this._lakeBox(hf);
    this.lakeTexture = this.box ? this._shoreDistance(hf, this.box) : null;
    this.present = !!this.lakeTexture;

    // ---- profile (fallback reflection) ----
    this._profileData = new Uint16Array(PROFILE_N * 4);
    this.profileTexture = new THREE.DataTexture(this._profileData, PROFILE_N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    this.profileTexture.wrapS = THREE.RepeatWrapping;
    this.profileTexture.magFilter = this.profileTexture.minFilter = THREE.LinearFilter;
    this.profileTexture.colorSpace = THREE.NoColorSpace;
    this.profileTexture.name = 'DeadSeaProfile';
    this._profileCentre = new THREE.Vector2(1e9, 1e9);
    this._profileNext = 0;
    this._profileReady = false;

    // ---- mirror ----
    this.mirrorCamera = new THREE.PerspectiveCamera();
    this.mirrorCamera.matrixAutoUpdate = false;
    this.mirrorTarget = null;          // made on first use (high quality)
    this._mirrorTree = new QuadTree(hf);
    this._mirrorTree.rangeScale = MIRROR_LOD;
    this._mirrorFrustum = new THREE.Frustum();
    this._mirrorCamLo = new THREE.Vector3();
    this._mirrorMatrix = new THREE.Matrix4();
    this._mirrorScene = new THREE.Scene();
    this._mirrorScene.name = 'DeadSeaMirror';
    this._mirrorScene.matrixWorldAutoUpdate = false;

    const S = terrain._shared;
    const common = {
      uHeights: S.uHeights, uCamHiU: S.uCamHiU, uMorphStart: S.uMorphStart, uMorphEnd: S.uMorphEnd, uRiftU: S.uRiftU,
    };
    this.uniforms = {
      ...this.env.uniforms,
      ...terrain.horizon.uniforms,
      ...common,
      uCamLo: S.uCamLo,
      uRange0: S.uRange0,
      uDetailArr: S.uDetailArr,
      uMirrorTex: { value: null },
      uLakeData: { value: this.lakeTexture },
      uProfile: { value: this.profileTexture },
      uMirrorMatrix: { value: this._mirrorMatrix },
      uMirrorInfo: { value: new THREE.Vector4(0, 0, 500, 0) },
      uWind: { value: new THREE.Vector4(0, 1, 0, 1) },
      uRipple: { value: new THREE.Vector4(1e-4, 2e-4, 0, 0) },
      uLakeBox: { value: new THREE.Vector4() },
      uProfileInfo: { value: new THREE.Vector4(0, 0, 0, 0) },
      uLakeDebug: { value: Number(new URLSearchParams(globalThis.location?.search || '').get('lakeDebug')) || 0 },
    };
    if (this.box) {
      const b = this.box;
      this.uniforms.uLakeBox.value.set(b.x0, b.z0, 1 / (b.nx * LAKE_CELL), 1 / (b.nz * LAKE_CELL));
    }
    // the terrain's 1x1 placeholder until the mirror exists (the sampler must hold a texture)
    this._blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this._blank.needsUpdate = true;
    this.uniforms.uMirrorTex.value = this._blank;

    this.material = new THREE.ShaderMaterial({
      name: 'DeadSeaLake',
      uniforms: this.uniforms,
      vertexShader: TERRAIN_VERT,
      fragmentShader: LAKE_FRAG,
      defines: { ...terrain._defines },
      lights: false,
      fog: false,
      transparent: false,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      // water x (1 - terrain alpha) added to the terrain's land; alpha back to 1
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneMinusDstAlphaFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.ZeroFactor,
    });
    this.mirrorUniforms = {
      ...this.env.uniforms,
      ...terrain.horizon.uniforms,
      ...common,
      uCamLo: { value: this._mirrorCamLo },
      uRange0: { value: RANGE0 * MIRROR_LOD },
      uOverview: S.uOverview,
      uFarColor: S.uFarColor,
      uNormalCore: S.uNormalCore,
      uNormalFar: S.uNormalFar,
      uRiftBox: S.uRiftBox,
      uNormalFarRows: S.uNormalFarRows,
      uAlbedoGain: S.uAlbedoGain,
      uMirrorInfo: this.uniforms.uMirrorInfo,
    };
    this.mirrorMaterial = new THREE.ShaderMaterial({
      name: 'DeadSeaMirror',
      uniforms: this.mirrorUniforms,
      vertexShader: TERRAIN_VERT,
      fragmentShader: MIRROR_FRAG,
      defines: { ...terrain._defines },
      lights: false,
      fog: false,
    });

    this.group = new PatchGroup(terrain._templates, LAKE_CAPACITY, this.material, 0.5);
    for (const m of this.group.meshes) { m.name = 'DeadSeaLake'; terrain.group.add(m); }
    this.mirrorGroup = new PatchGroup(terrain._templates, MIRROR_CAPACITY, this.mirrorMaterial, 0);
    for (const m of this.mirrorGroup.meshes) { m.name = 'DeadSeaMirror'; m.receiveShadow = false; this._mirrorScene.add(m); }
    this._visibleMirror = (x0, y0, z0, x1, y1, z1) => this._mirrorBoxVisible(x0, y0, z0, x1, y1, z1);
  }

  // -------------------------------------------------------------------------------------
  // data

  /** The lake's bounding box (m) with a 600 m margin, from the far grid's lake samples. */
  _lakeBox(hf) {
    const lim = (LAKE_LEVEL + 0.1 + 500) / 0.05;     // encoded height
    let i0 = FAR_N, i1 = -1, j0 = FAR_N, j1 = -1;
    for (let j = 0; j < FAR_N; j++) {
      const row = j * FAR_N;
      for (let i = 0; i < FAR_N; i++) {
        if (hf.far[row + i] <= lim) {
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
          if (j < j0) j0 = j;
          if (j > j1) j1 = j;
        }
      }
    }
    if (i1 < 0) return null;
    const m = 600;
    const x0 = Math.floor((-FAR_HALF + i0 * FAR_SPACING - m) / LAKE_CELL) * LAKE_CELL;
    const z0 = Math.floor((-FAR_HALF + j0 * FAR_SPACING - m) / LAKE_CELL) * LAKE_CELL;
    const x1 = -FAR_HALF + i1 * FAR_SPACING + m, z1 = -FAR_HALF + j1 * FAR_SPACING + m;
    const nx = Math.ceil((x1 - x0) / LAKE_CELL), nz = Math.ceil((z1 - z0) / LAKE_CELL);
    return { x0, z0, x1: x0 + nx * LAKE_CELL, z1: z0 + nz * LAKE_CELL, nx, nz };
  }

  /**
   * Distance from every lake texel to the nearest land (two-pass chamfer, 25 m texels: the
   * shallows' few hundred metres matter, beyond LAKE_MAX_D it is deep water), as
   * sqrt(d / LAKE_MAX_D) in R8 (finer steps near the shore). Land texels are 0.
   */
  _shoreDistance(hf, b) {
    const { nx, nz } = b;
    const d = new Float32Array(nx * nz);
    const BIG = 1e9;
    for (let j = 0; j < nz; j++) {
      const z = b.z0 + (j + 0.5) * LAKE_CELL;
      for (let i = 0; i < nx; i++) {
        const h = hf.heightAt(b.x0 + (i + 0.5) * LAKE_CELL, z);
        d[j * nx + i] = h <= LAKE_LEVEL + 0.25 ? BIG : 0;
      }
    }
    const a = LAKE_CELL, c = LAKE_CELL * Math.SQRT2;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        let v = d[k];
        if (v === 0) continue;
        if (i > 0) v = Math.min(v, d[k - 1] + a);
        if (j > 0) {
          v = Math.min(v, d[k - nx] + a);
          if (i > 0) v = Math.min(v, d[k - nx - 1] + c);
          if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + c);
        }
        d[k] = v;
      }
    }
    for (let j = nz - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i;
        let v = d[k];
        if (v === 0) continue;
        if (i < nx - 1) v = Math.min(v, d[k + 1] + a);
        if (j < nz - 1) {
          v = Math.min(v, d[k + nx] + a);
          if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + c);
          if (i > 0) v = Math.min(v, d[k + nx - 1] + c);
        }
        d[k] = v;
      }
    }
    const out = new Uint8Array(nx * nz);
    for (let k = 0; k < out.length; k++) {
      // the half texel to the shore line itself
      const v = d[k] > 0 ? Math.min(1, Math.sqrt(Math.max(d[k] - 0.5 * LAKE_CELL, 0) / LAKE_MAX_D)) : 0;
      out[k] = Math.round(v * 255);
    }
    const t = new THREE.DataTexture(out, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
    t.unpackAlignment = 1;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.name = 'DeadSeaShore';
    t.needsUpdate = true;
    return t;
  }

  // -------------------------------------------------------------------------------------
  // settings

  setQuality(q) {
    this.quality = LAKE_QUALITY[q] ? q : 'high';
    this.mirrorScale = LAKE_QUALITY[this.quality].mirror;
    if (!this.mirrorScale) this._dropMirror();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) {
      this.group.reset(); this.group.commit();
      this._dropMirror();
    }
  }

  _dropMirror() {
    this.mirrorTarget?.dispose();
    this.mirrorTarget = null;
    this.uniforms.uMirrorTex.value = this._blank;
    this.uniforms.uMirrorInfo.value.x = 0;
  }

  /** The programs: the lake's with Terrain._compile (both shadow variants), the mirror's here. */
  compile() {
    const jobs = [this.terrain._compile([this.material])];
    try {
      const cam = new THREE.PerspectiveCamera(60, 1, 1, 1000);
      if (this.renderer.compileAsync) jobs.push(this.renderer.compileAsync(this._mirrorScene, cam).catch(() => {}));
      else this.renderer.compile(this._mirrorScene, cam);
    } catch (e) {
      console.warn('dead sea: precompile', e);
    }
    return Promise.all(jobs);
  }

  // -------------------------------------------------------------------------------------
  // per frame

  /**
   * After the terrain's LOD selection (Terrain.update, every frame): the lake patches and the
   * wind. Returns whether the lake pass draws (the terrain's uLake). The mirror waits for
   * frame() (drawn frames only); until then this frame reflects the sky and the profile.
   */
  update(camera, patches, dt) {
    const U = this.uniforms;
    const on = this.enabled && this.present && !this.terrain.debug.heightProbe;
    const g = this.group;
    g.reset();
    if (on) this._selectLake(patches);
    this.stats.lakePatches = g.counts[0] + g.counts[1];
    g.commit();
    this._visible = on && this.stats.lakePatches > 0;
    this._camera = camera;
    U.uMirrorInfo.value.x = 0;
    if (!on) return false;

    // wind and ripples
    const hour = this.env?.timeOfDay ?? 12;
    const w = windAt(hour, this.wind);
    if (this.windOverride != null) w.speed = this.windOverride;
    const u = w.speed;
    U.uWind.value.set(w.x, w.z, u, Math.min(1, Math.max(0, (3.2 - u) / 2.4)));
    this._drift = (this._drift + Math.min(Math.max(dt || 0, 0), 0.25) * 1.25) % 1e5;
    const mss = rippleMss(u);
    U.uRipple.value.set(mss * 0.6, mss, this._drift, 0);
    this.stats.wind = Math.round(u * 10) / 10;
    return true;
  }

  /**
   * Module update (Terrain.module, before the frame is drawn): the mirror on high quality
   * near the lake, else the horizon profile for the fallback reflection.
   */
  frame(f) {
    if (!this._visible || f?.draw === false || !this._camera) {
      this.stats.mirror = false;
      return;
    }
    const camera = this._camera;
    camera.updateMatrixWorld();
    const cam = _p.setFromMatrixPosition(camera.matrixWorld);
    const height = cam.y - LAKE_LEVEL;
    const b = this.box;
    const dx = Math.max(b.x0 - cam.x, 0, cam.x - b.x1), dz = Math.max(b.z0 - cam.z, 0, cam.z - b.z1);
    const near = Math.hypot(dx, dz) < MIRROR_KM * 1000;
    const mirror = this.mirrorScale > 0 && near && height > 2;
    this.stats.mirror = mirror;
    this.uniforms.uProfileInfo.value.z = 0;
    if (mirror) this._renderMirror(camera, cam, height);
    else this._updateProfile(cam);
  }

  /** A cut (teleport, new time): the profile is redone at once. */
  reset() {
    this._profileCentre.set(1e9, 1e9);
    this._profileNext = 0;
    this._pending = null;
    this._profileReady = false;
  }

  _selectLake(patches) {
    const hf = this.terrain.hf, b = this.box, g = this.group;
    for (const p of patches) {
      if (p.x0 > b.x1 || p.z0 > b.z1 || p.x0 + p.size < b.x0 || p.z0 + p.size < b.z0) continue;
      const lvl = Math.round(Math.log2(p.size / NODE0_M));
      const n = 256 >> lvl;
      const I = Math.round((p.x0 + FAR_HALF) / p.size), J = Math.round((p.z0 + FAR_HALF) / p.size);
      const mn = hf.minMaxRaw ? hf.minMaxRaw[lvl][(J * n + I) * 2] : hf.minMax[lvl][(J * n + I) * 2];
      if (mn < LAKE_GATE) g.push(p);
    }
  }

  _mirrorBoxVisible(x0, y0, z0, x1, y1, z1) {
    const c = this._mirrorCamPos;
    const dx = Math.max(x0 - c.x, 0, c.x - x1), dz = Math.max(z0 - c.z, 0, c.z - z1);
    if (dx * dx + dz * dz > MIRROR_RANGE * MIRROR_RANGE) return false;
    // the flat lake (seen from below: back faces): its raw maximum, not the far grid's margin
    const size = x1 - x0;
    const lvl = Math.round(Math.log2(size / NODE0_M));
    const hf = this.terrain.hf;
    if (hf.minMaxRaw && lvl >= 0 && lvl < hf.minMaxRaw.length) {
      const n = 256 >> lvl;
      const I = Math.round((x0 + FAR_HALF) / size), J = Math.round((z0 + FAR_HALF) / size);
      if (I >= 0 && J >= 0 && I < n && J < n && hf.minMaxRaw[lvl][(J * n + I) * 2 + 1] < LAKE_LEVEL + 1) return false;
    }
    _box.min.set(x0, y0, z0); _box.max.set(x1, y1, z1);
    return this._mirrorFrustum.intersectsBox(_box);
  }

  _ensureMirrorTarget() {
    const r = this.renderer;
    r.getDrawingBufferSize(_size);
    const w = Math.max(64, Math.round(_size.x * this.mirrorScale));
    const h = Math.max(64, Math.round(_size.y * this.mirrorScale));
    let t = this.mirrorTarget;
    if (t && (t.width !== w || t.height !== h)) { t.dispose(); t = null; }
    if (!t) {
      t = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
        generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
        colorSpace: THREE.NoColorSpace,
      });
      t.texture.name = 'DeadSeaMirror';
      this.mirrorTarget = t;
      this.uniforms.uMirrorTex.value = t.texture;
    }
    return t;
  }

  /** The mirror camera (the camera reflected in the lake plane), its patches, its picture. */
  _renderMirror(camera, cam, height) {
    const t0 = performance.now();
    const U = this.uniforms, S = this.terrain._shared;
    const target = this._ensureMirrorTarget();
    const mc = this.mirrorCamera;
    // proper rotation (no mirror matrix, so the winding stays): eye, forward and up reflected
    const e = camera.matrixWorld.elements;
    _f.set(-e[8], -e[9], -e[10]).normalize();
    _u.set(e[4], e[5], e[6]).normalize();
    _v.set(cam.x, 2 * LAKE_LEVEL - cam.y, cam.z);
    _f.y = -_f.y; _u.y = -_u.y;
    mc.position.copy(_v);
    mc.up.copy(_u);
    mc.lookAt(_v.x + _f.x, _v.y + _f.y, _v.z + _f.z);
    mc.updateMatrix();
    mc.updateMatrixWorld(true);
    const fov = camera.isPerspectiveCamera ? camera.getEffectiveFOV() : 60;
    mc.fov = Math.min(150, 2 * Math.atan(Math.tan(fov * Math.PI / 360) * MIRROR_FOV) * 180 / Math.PI);
    mc.aspect = camera.aspect || target.width / target.height;
    mc.near = camera.near ?? 0.5;
    mc.far = camera.far ?? 1e6;
    mc.updateProjectionMatrix();

    // its patches: own LOD (coarser), frustum and range; never the flat lake
    _m.multiplyMatrices(mc.projectionMatrix, mc.matrixWorldInverse);
    this._mirrorFrustum.setFromProjectionMatrix(_m, mc.coordinateSystem, mc.reversedDepth === true);
    this._mirrorCamPos = _v;
    const patches = this._mirrorTree.select(_v, this._visibleMirror);
    const g = this.mirrorGroup;
    g.reset();
    for (const p of patches) g.push(p);
    g.commit();
    this.stats.mirrorPatches = g.counts[0] + g.counts[1];
    this._mirrorCamLo.copy(S.uCamLo.value);
    this._mirrorCamLo.y = _v.y;

    // the lake's lookup: mirror clip space of positions relative to the mirror camera
    _m.copy(mc.matrixWorldInverse).setPosition(0, 0, 0);
    this._mirrorMatrix.multiplyMatrices(mc.projectionMatrix, _m);
    const info = U.uMirrorInfo.value;
    info.set(1, 2 * height, target.height / (mc.fov * Math.PI / 180), Math.max(0, Math.floor(Math.log2(Math.min(target.width, target.height))) - 3));

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(_clear);
    const prevAuto = r.autoClear;
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.autoClear = true;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(target);
    r.render(this._mirrorScene, mc);
    r.setRenderTarget(prevTarget);
    r.setClearColor(_clear, prevAlpha);
    r.autoClear = prevAuto;
    r.shadowMap.autoUpdate = prevShadow;
    this.stats.mirrorMs = Math.round((performance.now() - t0) * 100) / 100;
  }

  /**
   * The walls' silhouette per azimuth from the camera's position at the lake level: the
   * point of the steepest elevation along each azimuth out to 40 km (height above the lake,
   * distance), and how much the sun lights the wall's face (its slope toward the camera
   * against the sun). PROFILE_STEP azimuths per frame; redone after PROFILE_MOVE metres.
   */
  _updateProfile(cam) {
    const U = this.uniforms;
    const c = this._profileCentre;
    if (Math.hypot(cam.x - c.x, cam.z - c.y) > PROFILE_MOVE && this._profileNext === 0) {
      this._pending = { x: cam.x, z: cam.z };
    }
    const job = this._pending;
    if (job) {
      const hf = this.terrain.hf;
      const sun = this.env?.sunDirection;
      const data = this._profileData;
      const R2 = 2 * 6371000;
      const end = Math.min(PROFILE_N, this._profileNext + PROFILE_STEP);
      for (let i = this._profileNext; i < end; i++) {
        const az = (i + 0.5) / PROFILE_N * 2 * Math.PI - Math.PI;
        const ax = Math.cos(az), az2 = Math.sin(az);
        let best = -1, bh = 0, bd = 0;
        for (let t = 150; t < 40000; t += 60 + t * 0.02) {
          const h = hf.heightAt(job.x + ax * t, job.z + az2 * t) - LAKE_LEVEL;
          const k = (h - t * t / R2) / t;
          if (k > best) { best = k; bh = h; bd = t; }
        }
        // the wall's face: from the shore (first point 20 m above the lake) up to the top
        let shore = bd;
        for (let t = 150; t < bd; t += 50 + t * 0.01) {
          if (hf.heightAt(job.x + ax * t, job.z + az2 * t) - LAKE_LEVEL > 20) { shore = t; break; }
        }
        const run = Math.max(bd - shore, 50);
        // face normal: tilted back toward the camera by the wall's mean slope
        const nx = -ax * bh, nz = -az2 * bh, ny = run;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const lit = sun ? Math.max(0, (nx * sun.x + ny * sun.y + nz * sun.z) / nl) : 0.5;
        data[i * 4] = THREE.DataUtils.toHalfFloat(Math.max(0, bh));
        data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(Math.min(bd, 60000));
        data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(lit);
        data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
      }
      this._profileNext = end;
      if (end >= PROFILE_N) {
        this._profileNext = 0;
        this._pending = null;
        c.set(job.x, job.z);
        this.profileTexture.needsUpdate = true;
        this._profileReady = true;
        U.uProfileInfo.value.x = c.x;
        U.uProfileInfo.value.y = c.y;
        this.stats.profile++;
      }
    }
    U.uProfileInfo.value.z = this._profileReady ? 1 : 0;
  }

  dispose() {
    for (const m of this.group.meshes) { m.parent?.remove(m); m.geometry.dispose(); }
    for (const m of this.mirrorGroup.meshes) { m.parent?.remove(m); m.geometry.dispose(); }
    this.material.dispose();
    this.mirrorMaterial.dispose();
    this.mirrorTarget?.dispose();
    this.lakeTexture?.dispose();
    this.profileTexture.dispose();
    this._blank.dispose();
  }
}
