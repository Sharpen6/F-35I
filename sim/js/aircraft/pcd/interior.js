// The cockpit interior of the player's F-35I (Cockpit.js drives it):
//
// * Paint: the glb's cockpit greys (F35_cockpit #45484b and friends) and the light exterior skin on
//   the inner sills and canopy frame become a dark grey satin, the canopy bow a matte dark frame,
//   the two light pads on the glare shield dark. Original values are kept (setEnabled(false)).
// * The skin's inner faces: found by interiorWorker.js (flood fill of the cockpit air from the
//   eye) and drawn by a second mesh with the interior paint (same vertex buffers, the index
//   reordered so that the skin mesh and the interior mesh each draw one range of it).
// * A floor plate over the opening between the rudder pedals (the white nose gear showed through).
// * Ambient occlusion per vertex (the worker): the tub is lit by the sky through the canopy only.
// * A shader patch on the cockpit materials (and the pilot's): the occlusion on the sky light,
//   the display's glow (a small area light at the PCD: its physical light by day, lost in the
//   daylight, and glowGain x that at night, as a dark-adapted eye sees it), and a triplanar detail
//   (paint grain, smudges) on the painted parts.
// * The switch LEDs and the kneeboard tablet are emissive: they follow the exposure like the PCD
//   (white dots at night before).
//
// Everything works on the player's model only; the analysis runs once, in a worker, a fraction of
// a second after start-up, and the cockpit keeps the glb's look until it is done.

import * as THREE from 'three';
import { TRIPLANAR_GLSL } from './detail.js';

/** Repainted materials (sRGB colour, roughness, metalness, detail strength). */
export const INTERIOR_PAINT = {
  F35_cockpit: { color: 0x303336, roughness: 0.6, metalness: 0, detail: 1 },
  F35_cockpit_panel: { color: 0x26282b, roughness: 0.52, metalness: 0, detail: 0.8 },
  F35_canopy_bow: { color: 0x1d1e20, roughness: 0.86, metalness: 0, detail: 1 },
  F35_glare_pad: { color: 0x27282b, roughness: 0.95, metalness: 0, detail: 0.6 },
  F35_seat: { color: 0x35383a, roughness: 0.72, metalness: 0, detail: 0.7 },
  F35_seat_cushion: { color: 0x4d5145, roughness: 0.92, metalness: 0, detail: 0.5 },
};
/** The interior paint on the skin's inner faces and the floor plate. */
export const INTERIOR_SKIN = { name: 'F35_cockpit_interior', color: 0x313437, roughness: 0.62, detail: 1 };
/** Further cockpit materials that get the occlusion and the glow only (the pilot's P2_* too). */
const AO_ONLY = ['F35_yellow_black', 'F35_switch_guard', 'F35_switch', 'F35_gear_handle', 'F35_hose', 'F35_SwitchLED'];
/** Emissive materials that follow the exposure: [day, night] picture level of full emission. */
const EMISSIVE_LEVEL = { F35_SwitchLED: [0.55, 0.22], P2_TabletScreen: [0.9, 0.22] };

const PCD_AREA = 0.508 * 0.203;          // m2: 20 x 8 in
const FLOOR = { x: 0.36, y: 0.062, z0: 5.06, z1: 5.60 };    // glTF root frame (+X left, +Z forward)
const BOX = { min: [-0.82, -0.25, 2.85], max: [0.82, 1.62, 6.35] };
/** Where the pilot's eye goes (offsets from the design eye, glTF frame): what it sees is interior. */
const EYE_OFFSETS = [[0, 0, 0], [0.13, -0.03, 0.04], [-0.13, -0.03, 0.04], [0, -0.08, 0.12], [0, 0.05, -0.06]];
/** Points beside and above the canopy: the cockpit air must not reach them (a gap in the model). */
const OUTSIDE = [[0, 1.55, 4.4], [0.74, 1.35, 4.2], [-0.74, 1.35, 4.2], [0, 1.4, 6.2]];

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Interior {
  /**
   * @param {object} o
   * @param {object} o.visual AircraftVisual (loaded)
   * @param {THREE.Texture} o.detail detail texture (detail.js)
   * @param {number} [o.voxel] analysis voxel (m)
   * @param {number} [o.aoRays] occlusion rays per vertex
   */
  constructor({ visual, detail, voxel = 0.015, aoRays = 16 }) {
    this.visual = visual;
    this.root = visual.root;
    this.detail = detail;
    this.voxel = voxel;
    this.aoRays = aoRays;
    this.enabled = true;
    this.ready = false;           // analysis applied
    this.stats = null;
    this.glowGain = 120;          // the display's glow on the cockpit at night: x physical (an eye adapted to the dark sees it)
    this.detailAmount = 1;
    this.uniforms = {
      uCkGlow: { value: new THREE.Color(0, 0, 0) },
      uCkGlowPos: { value: new THREE.Vector3() },
      uCkGlowN: { value: new THREE.Vector3(0, 0, 1) },
      uCkDetail: { value: detail },
      uCkDetailOn: { value: 1 },
    };
    this._saved = new Map();      // material -> original values
    this._splits = [];
    this._patched = new Set();
    this._emissive = [];
    this.byName = new Map();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const n = o.material.name || '';
      if (!this.byName.has(n)) this.byName.set(n, { material: o.material, meshes: [] });
      this.byName.get(n).meshes.push(o);
    });
    this.skinMaterial = new THREE.MeshStandardMaterial({
      name: INTERIOR_SKIN.name, color: INTERIOR_SKIN.color, roughness: INTERIOR_SKIN.roughness, metalness: 0, side: THREE.DoubleSide,
    });
    this.skinMaterial.userData.ckDetail = INTERIOR_SKIN.detail;
    // the inner side of single-sided panels (canopy frame, the fairing behind the seat): back faces,
    // drawn 1.5 mm inside the skin so that they cover its back faces
    this.backMaterial = this.skinMaterial.clone();
    this.backMaterial.name = INTERIOR_SKIN.name + '_back';
    this.backMaterial.side = THREE.BackSide;
    this.backMaterial.userData.ckDetail = INTERIOR_SKIN.detail;
    this.backMaterial.userData.ckInset = 0.0015;
    this._addFloor();
    this._repaint();
    for (const [name, lv] of Object.entries(EMISSIVE_LEVEL)) {
      const e = this.byName.get(name);
      if (e && e.material.emissive) this._emissive.push({ m: e.material, base: e.material.emissiveIntensity, lv });
    }
  }

  // ------------------------------------------------------------------------------ set-up
  _addFloor() {
    const g = new THREE.PlaneGeometry(2 * FLOOR.x, FLOOR.z1 - FLOOR.z0);
    g.rotateX(-Math.PI / 2);                         // normal up (+Y), plane along X / Z
    g.translate(0, FLOOR.y, (FLOOR.z0 + FLOOR.z1) / 2);
    const m = new THREE.Mesh(g, this.skinMaterial);
    m.name = 'Cockpit_FloorPlate';
    m.castShadow = true;
    m.receiveShadow = true;
    this.root.add(m);
    this.floor = m;
  }

  _repaint() {
    for (const [name, p] of Object.entries(INTERIOR_PAINT)) {
      const e = this.byName.get(name);
      if (!e) continue;
      const m = e.material;
      this._saved.set(m, { color: m.color.clone(), roughness: m.roughness, metalness: m.metalness });
      m.color.set(p.color);
      m.roughness = p.roughness;
      m.metalness = p.metalness;
      m.userData.ckDetail = p.detail;
    }
  }

  /** The cockpit meshes for the worker, positions and normals in the glTF root frame. */
  _gather() {
    const root = this.root;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const head = root.getObjectByName('Pilot_Head');
    const inHead = (o) => { for (let x = o; x; x = x.parent) if (x === head) return true; return false; };
    const list = [];
    const M = new THREE.Matrix4(), NM = new THREE.Matrix3(), v = new THREE.Vector3();
    const box = new THREE.Box3(new THREE.Vector3(...BOX.min), new THREE.Vector3(...BOX.max));
    const wb = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material) || inHead(o)) return;
      const mat = o.material, name = mat.name || '';
      if (name.endsWith('_reflect') || name.startsWith('F35_Decal_')) return;
      const g = o.geometry;
      if (!g || !g.attributes.position) return;
      M.multiplyMatrices(inv, o.matrixWorld);
      if (!g.boundingBox) g.computeBoundingBox();
      wb.copy(g.boundingBox).applyMatrix4(M);
      if (!wb.intersectsBox(box)) return;
      const glass = mat.isShaderMaterial && name.endsWith('_tint');
      if (mat.transparent && !glass) return;
      const kind = glass ? 'glass' : name.startsWith('P2_') ? 'pilot' : 'wall';
      const P = g.attributes.position, N = g.attributes.normal;
      const pos = new Float32Array(P.count * 3), nrm = N ? new Float32Array(P.count * 3) : null;
      NM.getNormalMatrix(M);
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(M);
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        if (N) {
          v.fromBufferAttribute(N, i).applyMatrix3(NM).normalize();
          nrm[i * 3] = v.x; nrm[i * 3 + 1] = v.y; nrm[i * 3 + 2] = v.z;
        }
      }
      const index = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: P.count }, (_, i) => i);
      const morph = !!(g.morphAttributes && g.morphAttributes.position) || o.isSkinnedMesh;
      const classify = name === 'F35_Skin_A' && !morph;
      const ao = !glass && (classify || this._wantsAO(mat) || o === this.floor);
      list.push({ mesh: o, kind, classify, ao, pos, nrm, index });
    });
    return list;
  }

  _wantsAO(m) {
    const n = m.name || '';
    if (!(m.isMeshStandardMaterial) || m.transparent) return false;
    return n in INTERIOR_PAINT || AO_ONLY.includes(n) || n.startsWith('P2_') || m === this.skinMaterial;
  }

  /** Run the analysis (worker) and apply it. Resolves to the stats, or null when it failed. */
  async start() {
    const list = this._gather();
    const eye = this.root.worldToLocal(this.visual.eyeWorld(new THREE.Vector3()));
    const msg = {
      eye: eye.toArray(), eyes: EYE_OFFSETS.map((o) => [eye.x + o[0], eye.y + o[1], eye.z + o[2]]),
      box: BOX, voxel: this.voxel, aoRays: this.aoRays, aoDist: 1.2, outside: OUTSIDE,
      meshes: list.map((m, id) => ({ id, kind: m.kind, classify: m.classify, ao: m.ao, pos: m.pos, nrm: m.nrm, index: m.index })),
    };
    const transfer = [];
    for (const m of msg.meshes) { transfer.push(m.pos.buffer, m.index.buffer); if (m.nrm) transfer.push(m.nrm.buffer); }
    let res;
    try {
      res = await new Promise((resolve, reject) => {
        const w = new Worker(new URL('./interiorWorker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => { w.terminate(); resolve(e.data); };
        w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker error')); };
        w.postMessage(msg, transfer);
      });
    } catch (e) {
      console.warn('Cockpit: interior analysis failed:', e.message);
      res = { ok: false, error: e.message };
    }
    if (this.disposed) return null;
    if (!res.ok) console.warn('Cockpit: interior analysis:', res.error);
    else if (res.leak) console.warn('Cockpit: the cockpit air reaches the outside (a gap in the model): no inner skin faces repainted');
    this._apply(list, res.ok ? res : { interior: {}, ao: {} });
    this.stats = res.ok ? { ms: Math.round(res.ms), leak: res.leak, ...res.stats, interiorTris: Object.values(res.interior).reduce((a, l) => a + l.length, 0) } : null;
    return this.stats;
  }

  _apply(list, res) {
    // ambient occlusion attributes first (the interior meshes share the skin's attributes)
    const done = new Set();
    list.forEach((m, id) => {
      const a = res.ao[id];
      const g = m.mesh.geometry;
      if (!a || done.has(g)) return;
      g.setAttribute('ckAO', new THREE.BufferAttribute(a, 1, true));
      done.add(g);
    });
    // the skin's inner faces
    list.forEach((m, id) => {
      const a = res.interior[id], b = res.twoFaced && res.twoFaced[id];
      if (a || b) this._split(m.mesh, a || [], b || []);
    });
    // the patch, on every mesh of a patched material (an occlusion of 1 where none was computed)
    const mats = new Set([this.skinMaterial, this.backMaterial]);
    this.root.traverse((o) => { if (o.isMesh && o.material && !Array.isArray(o.material) && this._wantsAO(o.material)) mats.add(o.material); });
    this.root.traverse((o) => {
      if (!o.isMesh || !mats.has(o.material)) return;
      const g = o.geometry;
      if (!g.attributes.ckAO) g.setAttribute('ckAO', new THREE.BufferAttribute(new Uint8Array(g.attributes.position.count).fill(255), 1, true));
    });
    for (const m of mats) this._patch(m);
    this.ready = true;
  }

  /**
   * Repaint triangles of `mesh` (one draw range of the same buffers each, the index reordered):
   * `inner` faces entirely with the interior paint, `twoFaced` ones on their back side only.
   * Index order after: [skin ..., twoFaced ..., inner ...]; the skin mesh draws the first two.
   */
  _split(mesh, inner, twoFaced) {
    const g = mesh.geometry;
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    const idx = g.index, a = idx.array, n = a.length / 3;
    const kind = new Uint8Array(n);
    for (const t of twoFaced) kind[t] = 1;
    for (const t of inner) kind[t] = 2;
    const out = new a.constructor(a.length);
    let o = 0;
    const counts = [0, 0, 0];
    for (const k of [0, 1, 2]) {
      for (let t = 0; t < n; t++) {
        if (kind[t] !== k) continue;
        out[o++] = a[t * 3]; out[o++] = a[t * 3 + 1]; out[o++] = a[t * 3 + 2];
        counts[k]++;
      }
    }
    a.set(out);
    idx.needsUpdate = true;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingBox) g.computeBoundingBox();
    const old = { start: g.drawRange.start, count: g.drawRange.count };
    const skinCount = (counts[0] + counts[1]) * 3;
    g.setDrawRange(0, skinCount);
    const part = (start, count, material, suffix) => {
      if (!count) return null;
      const gi = new THREE.BufferGeometry();
      for (const k of Object.keys(g.attributes)) gi.setAttribute(k, g.attributes[k]);
      gi.setIndex(idx);
      gi.setDrawRange(start, count);
      gi.boundingSphere = g.boundingSphere.clone();
      gi.boundingBox = g.boundingBox.clone();
      const mi = new THREE.Mesh(gi, material);
      mi.name = mesh.name + suffix;
      mi.castShadow = mesh.castShadow;
      mi.receiveShadow = mesh.receiveShadow;
      mi.renderOrder = mesh.renderOrder;
      mesh.add(mi);
      return mi;
    };
    const back = part(counts[0] * 3, counts[1] * 3, this.backMaterial, '_interior_back');
    const mi = part(skinCount, counts[2] * 3, this.skinMaterial, '_interior');
    this._splits.push({ mesh, g, old, parts: [back, mi].filter(Boolean), skinCount, inner: counts[2], twoFaced: counts[1] });
  }

  /** The shader patch: occlusion, the displays' glow, the paint detail. */
  _patch(m) {
    if (this._patched.has(m)) return;
    this._patched.add(m);
    const U = this.uniforms;
    const detail = (m.userData.ckDetail || 0) > 0;
    const inset = m.userData.ckInset || 0;
    const amount = { value: m.userData.ckDetail || 0 };
    const prev = m.onBeforeCompile;
    const prevKey = m.customProgramCacheKey;
    m.onBeforeCompile = function (sh, r) {
      if (prev) prev.call(this, sh, r);
      sh.uniforms.uCkGlow = U.uCkGlow;
      sh.uniforms.uCkGlowPos = U.uCkGlowPos;
      sh.uniforms.uCkGlowN = U.uCkGlowN;
      if (detail) {
        sh.uniforms.uCkDetail = U.uCkDetail;
        sh.uniforms.uCkDetailOn = U.uCkDetailOn;
        sh.uniforms.uCkDetailAmt = amount;
      }
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute float ckAO;
varying float vCkAO;
varying vec3 vCkWorld;
${detail ? 'varying vec3 vCkObj;\nvarying vec3 vCkObjN;' : ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vCkAO = ckAO;
${inset ? `transformed -= objectNormal * ${inset.toFixed(5)};` : ''}
${detail ? 'vCkObj = position;\nvCkObjN = normal;' : ''}`)
        .replace('#include <project_vertex>', `#include <project_vertex>
vCkWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 uCkGlow;
uniform vec3 uCkGlowPos;
uniform vec3 uCkGlowN;
varying float vCkAO;
varying vec3 vCkWorld;
${detail ? `uniform sampler2D uCkDetail;
uniform float uCkDetailOn;
uniform float uCkDetailAmt;
varying vec3 vCkObj;
varying vec3 vCkObjN;
${TRIPLANAR_GLSL}` : ''}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
${detail ? `if ( uCkDetailOn > 0.5 ) {
  // satin paint: a fine grain, and smudges (handled, wiped) a little lighter and glossier
  vec4 ckD = ckTriplanar( uCkDetail, vCkObj, vCkObjN, 0.3 );
  float ckG = ckD.b - 0.5;
  float ckS = ckD.g;
  diffuseColor.rgb *= 1.0 + uCkDetailAmt * ( 0.08 * ckG + 0.06 * ckS );
  roughnessFactor = clamp( roughnessFactor * ( 1.0 + uCkDetailAmt * ( 0.1 * ckG - 0.15 * ckS ) ), 0.08, 1.0 );
}` : ''}`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
{
  // the tub sees the sky through the canopy only (per-vertex occlusion from interiorWorker.js)
  float ckAo = vCkAO;
  reflectedLight.indirectDiffuse *= ckAo;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( saturate( dot( geometryNormal, geometryViewDir ) ), ckAo, material.roughness );
  #endif
  // the displays' glow: the PCD as a small area light (cosine at both ends, no shadow)
  vec3 ckN = inverseTransformDirection( geometryNormal, viewMatrix );
  vec3 ckL = uCkGlowPos - vCkWorld;
  float ckD2 = dot( ckL, ckL );
  ckL *= inversesqrt( ckD2 );
  float ckK = max( dot( ckN, ckL ), 0.0 ) * max( - dot( uCkGlowN, ckL ), 0.0 ) / ( ckD2 + 0.03 );
  reflectedLight.indirectDiffuse += uCkGlow * ( ckK * ( 0.3 + 0.7 * ckAo ) ) * BRDF_Lambert( material.diffuseColor );
}`);
    };
    m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + (detail ? '|ckd' : '|ck') + (inset ? 'i' : ''); };
    m.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------ per frame
  /**
   * @param {object} s {exposure, sunY, pcdGlow (THREE.Color, mean linear colour of the screen),
   *                    pcdIntensity (its physical luminance at white, scene units), pcdCentre,
   *                    pcdNormal (world)}
   */
  update(s) {
    const U = this.uniforms;
    const day = smooth(-0.1, 0.08, s.sunY ?? 1);
    if (s.pcdCentre) U.uCkGlowPos.value.copy(s.pcdCentre);
    if (s.pcdNormal) U.uCkGlowN.value.copy(s.pcdNormal);
    // the glow is the physical light by day (lost in the daylight) and glowGain x that at night
    const gain = 1 + (this.glowGain - 1) * (1 - day);
    U.uCkGlow.value.copy(s.pcdGlow || U.uCkGlow.value).multiplyScalar((s.pcdIntensity || 0) * PCD_AREA * gain);
    U.uCkDetailOn.value = this.detailAmount > 0 ? 1 : 0;
    // emissive parts at a picture level, whatever the exposure
    for (const e of this._emissive) {
      const level = e.lv[1] + (e.lv[0] - e.lv[1]) * day;
      e.m.emissiveIntensity = (s.power ?? 1) * level / Math.max(1e-3, s.exposure || 1);
    }
  }

  /** Back to the glb's look (and on again). */
  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const [m, o] of this._saved) {
      if (on) {
        const p = INTERIOR_PAINT[m.name];
        m.color.set(p.color); m.roughness = p.roughness; m.metalness = p.metalness;
      } else {
        m.color.copy(o.color); m.roughness = o.roughness; m.metalness = o.metalness;
      }
    }
    for (const s of this._splits) {
      for (const p of s.parts) p.visible = on;
      s.g.setDrawRange(0, on ? s.skinCount : Infinity);
    }
    this.floor.visible = on;
    for (const e of this._emissive) if (!on) e.m.emissiveIntensity = e.base;
  }

  dispose() {
    this.disposed = true;
    this.setEnabled(false);
    for (const s of this._splits) for (const p of s.parts) s.mesh.remove(p);
    this.root.remove(this.floor);
    this.floor.geometry.dispose();
    this.skinMaterial.dispose();
    this.backMaterial.dispose();
  }
}
